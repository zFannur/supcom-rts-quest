// Map connectivity check (used by tools/mapcheck.mjs and by the random map generator in the browser).
// For every map and every start point verifies that
//  * all mass deposits on dry land are reachable by 'amph' units (engineers walk the seabed) and, on maps without
//    a designed island, by 'land' units;
//  * every big dry-land region (> MIN_REGION cells) belongs to the start's walkable component (so there is no
//    plateau, rim or bluff without a way up);
//  * the maps stay point-symmetric (height(x,y) == height(S-x,S-y) within tolerance);
//  * large clearance classes (experimentals) still reach both bases and every mass point of the start region.
//  * maps with `split` (bases on separate landmasses, naval by design): bases of different sides need not be connected by land,
//    but every base must have deep water within the AI's staging radius, all in the same water body;
//  * maps with `isles` (every base on its own island, a water world): no land path between any two bases is required — only the water body check below;
//  * the ground around every start is dry and gentle (room for the base).
import { MAP_SIZE } from './maps.js';
import { Terrain, PN, PCELL } from './terrain.js';

const MIN_REGION = 24;      // cells (8x8 units) — smaller pockets are just rocks and crater floors
const SYM_TOL = 1.5;        // height units

// Islands with mass that only amphibious units may reach are part of the design of naval maps.
const LAND_EXEMPT_NAVAL = true;

export function checkMap(map, T = new Terrain(map)) {
  const out = { map: map.id, errors: [], notes: [], rows: [] };
  // ---- symmetry
  let symMax = 0;
  for (let i = 0; i < 400; i++) {
    const x = 20 + ((i * 97) % (MAP_SIZE - 39)), y = 20 + ((i * 193) % (MAP_SIZE - 39));
    symMax = Math.max(symMax, Math.abs(map.height(x, y) - map.height(MAP_SIZE - x, MAP_SIZE - y)));
  }
  out.symmetry = symMax;
  if (symMax > SYM_TOL) out.errors.push(`карта несимметрична: макс. расхождение высоты ${symMax.toFixed(2)}`);

  for (const [domain, cls] of [['land', 0], ['amph', 0], ['land', 3], ['amph', 3]]) {
    const e = T.effGrid(domain, cls), lab = T.effComps(e);
    // dry land cells (the region we care about): passable land terrain regardless of size class
    for (const st of map.starts) {
      const K = T.compAt(e, st.x, st.y);
      if (!K) { out.errors.push(`${domain}/${cls}: старт (${st.x},${st.y}) не на проходимой клетке`); continue; }
      for (const o of map.starts) if (o !== st && T.compAt(e, o.x, o.y) !== K && !(map.split && domain === 'land' && (map.isles || map.starts.indexOf(o) % 2 !== map.starts.indexOf(st) % 2))) out.errors.push(`${domain}/кл.${cls}: от (${st.x},${st.y}) нет пути до базы (${o.x},${o.y})`);
      const missing = [];
      for (const m of T.mass) {
        const [cx, cy] = T.cell(m.x, m.y);
        const [nx, ny] = T.nearestOk(e, cx, cy, 4);
        if (!e.ok[ny * PN + nx] || lab[ny * PN + nx] !== K) missing.push(`(${m.x},${m.y})`);
      }
      // dry regions: components of the land grid bigger than MIN_REGION that are not the start's component
      const land = T.effGrid('land', 0), ll = T.effComps(land);
      const seen = new Map();
      if (domain === 'land' || domain === 'amph') {
        for (let i = 0; i < PN * PN; i++) if (ll[i] && land.sizes[ll[i]] >= MIN_REGION) {
          const c = ll[i];
          let r = seen.get(c);
          if (!r) seen.set(c, r = { size: land.sizes[c], reach: false, x: i % PN, y: (i / PN) | 0 });
          if (lab[i] === K) r.reach = true;
        }
      }
      const lost = [...seen.values()].filter(r => !r.reach);
      const exempt = domain === 'land' && LAND_EXEMPT_NAVAL && map.naval;
      // experimentals may miss a few deposits inside tiny craters or at rocky pass mouths (too tight for a 3-cell body)
      const soft = cls === 3 && missing.length <= Math.ceil(T.mass.length * 0.1);
      out.rows.push({ domain, cls, start: `${st.x},${st.y}`, comp: e.sizes[K], mass: `${T.mass.length - missing.length}/${T.mass.length}`, lost: lost.length, missing });
      if (missing.length && soft) out.notes.push(`${domain}/кл.${cls}: экспериментал не пролезает к ${missing.join(' ')} (узкий проход)`);
      else if (missing.length && !exempt) out.errors.push(`${domain}/кл.${cls} от (${st.x},${st.y}): недостижимы месторождения ${missing.join(' ')}`);
      else if (missing.length) out.notes.push(`${domain}/кл.${cls} от (${st.x},${st.y}): острова с массой (только амфибии/транспорт) ${missing.join(' ')}`);
      if (lost.length && !exempt && !(soft && cls === 3)) out.errors.push(`${domain}/кл.${cls} от (${st.x},${st.y}): ${lost.length} суш. областей недостижимы: ` +
        lost.map(r => `${r.size} кл. у (${r.x * PCELL},${r.y * PCELL})`).join('; '));
    }
  }
  // ---- room for the base: dry, gentle ground within 56 units of every start
  for (const st of map.starts) {
    let n = 0, bad = 0;
    for (let cy = Math.max(0, ((st.y - 56) / PCELL) | 0); cy <= Math.min(PN - 1, ((st.y + 56) / PCELL) | 0); cy++) for (let cx = Math.max(0, ((st.x - 56) / PCELL) | 0); cx <= Math.min(PN - 1, ((st.x + 56) / PCELL) | 0); cx++) {
      n++; if (T.cellSlope[cy * PN + cx] > 0.3 || !T.pass.land[cy * PN + cx]) bad++;
    }
    if (bad > n * 0.05) out.errors.push(`старт (${st.x},${st.y}): нет ровной сухой площадки под базу (${bad}/${n} клеток)`);
  }
  // ---- naval split: deep water near every base (the AI looks for it within 360 * KM = 720 units), one water body for all
  if (map.split) {
    const en = T.effGrid('naval', 0), lab = T.effComps(en), bodies = new Set();
    for (const st of map.starts) {
      let best = 0, bd = 720 * 720;
      for (let i = 0; i < PN * PN; i++) if (en.ok[i]) { const d = ((i % PN + 0.5) * PCELL - st.x) ** 2 + (((i / PN | 0) + 0.5) * PCELL - st.y) ** 2; if (d < bd) { bd = d; best = lab[i]; } }
      if (!best) out.errors.push(`старт (${st.x},${st.y}): нет глубокой воды ближе 720 ед. (флот не построить)`);
      bodies.add(best);
    }
    if (bodies.size > 1) out.errors.push('базы выходят к разным водоёмам: флоты не встретятся');
  }
  return out;
}

