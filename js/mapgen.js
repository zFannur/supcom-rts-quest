// Генератор случайных карт: целиком определяется параметрами (сид + ползунки), точечно-симметричен, как и встроенные карты.
// Из параметров собирается рельеф (суша / острова / кратер / смесь / водный мир — база на каждом острове), старты (0, 2 — верхняя половина, 1, 3 — зеркальные им),
// месторождения; generateMap проверяет карту (js/mapcheck.js) и при неудаче пробует сид+1, сид+2, ...
import { MAP_SIZE as S, MAPS, mulberry32, fbm, ridged, symN, contrast, smooth, gauss, lerp, mirror, mirrorP, mirrorSegs, mirrorBumps, mirrorRamps, mesa, mesaRamps, spursAt, bumpsAt, flattenStarts, withRamps, segD, deg } from './maps.js';
import { Terrain, PN } from './terrain.js';
import { checkMap } from './mapcheck.js';

export const GEN_TYPES = [['land', 'Суша'], ['islands', 'Острова'], ['crater', 'Кратер'], ['mixed', 'Смесь'], ['ocean', 'Водный мир']];
export const GEN_DEFAULT = { seed: 1, type: 'land', mountains: 0.5, water: 0.4, mass: 0.5, forest: 0.5, players: 2 };
const TRIES = 10, SEEDS = 1e8;

/** Параметры к допустимому виду (ползунки 0..1 с шагом 0.01, сид — целое). */
export function genNorm(p = {}) {
  const d = GEN_DEFAULT, u = (v, def) => Math.round(Math.max(0, Math.min(1, Number.isFinite(+v) && v !== null && v !== '' ? +v : def)) * 100) / 100;
  return {
    seed: Math.abs(Math.floor(+p.seed) || 0) % SEEDS, type: GEN_TYPES.some(t => t[0] === p.type) ? p.type : d.type,
    mountains: u(p.mountains, d.mountains), water: u(p.water, d.water), mass: u(p.mass, d.mass), forest: u(p.forest, d.forest), players: +p.players === 4 ? 4 : 2
  };
}
export const genKey = (p) => [p.type, p.seed, p.mountains, p.water, p.mass, p.forest, p.players].join('/');
export const genRandomSeed = () => 1 + Math.floor(Math.random() * 99999);

// рельеф (сухая часть): `L` — какая встроенная карта даёт палитру/небо/деревья
function buildMap(q) {
  const sd = q.seed, rnd = mulberry32(sd * 2 + 1), rr = (a, b) => a + rnd() * (b - a), C = S / 2;
  const { type, mountains: M, water: W, mass: MS, forest: F, players: P } = q;
  const ocean = type === 'ocean', sea = type === 'islands' || ocean, hole = type === 'crater' || type === 'mixed', ridge = type === 'land' || type === 'mixed';
  const sym = (p) => [{ x: p[0], y: p[1] }, { x: S - p[0], y: S - p[1] }];
  // --- старты: углы (кратер) или верхняя половина; 4 игрока — две пары (одна сторона у 0 и 2, другая у 1 и 3)
  // водный мир: остров базы радиусом Rs (шире при малом ползунке «Вода»); базы (верхняя половина + зеркальные копии) не ближе 2.2 Rs + 180 друг к другу
  const Rs = Math.round(lerp(300, 215, W)), em = Math.round(Rs * 1.2 + 30);
  let ob = null;
  if (ocean) {
    for (let t = 0; t < 80 && !ob; t++) {
      const c = Array.from({ length: P / 2 }, () => [Math.round(rr(em, S - em)), Math.round(rr(em, C - em / 2))]).sort((u, v) => u[0] - v[0]);
      const all = c.flatMap(b => [b, [S - b[0], S - b[1]]]);
      if (all.every((u, i) => all.every((v, j) => i === j || Math.hypot(u[0] - v[0], u[1] - v[1]) > 2.2 * Rs + 180))) ob = c;
    }
    ob ??= P === 4 ? [[em + Math.round(rr(0, 150)), em + Math.round(rr(0, 150))], [S - em - Math.round(rr(0, 150)), em + Math.round(rr(0, 150))]] : [[C, em]];
  }
  const a = Math.round(rr(170, 260)), corner = type === 'crater';
  const s0 = ob ? ob[0] : corner ? [a, a] : [Math.round(P === 4 ? rr(380, 800) : rr(420, 1630)), Math.round(rr(220, 290))];
  const s2 = ob ? ob[1] : corner ? [S - a, a] : [Math.round(rr(1350, 1700)), Math.round(rr(230, 330))];
  const bases = P === 4 ? [s0, s2] : [s0], starts = bases.flatMap(sym);
  // --- места под крупные объекты: не ближе 250 к стартам, не друг к другу (и к зеркальным копиям)
  const placed = [];
  const clear = (x, y, rad) => starts.every(s => Math.hypot(s.x - x, s.y - y) > 250 + rad) && Math.hypot(C - x, C - y) > rad + 45
    && placed.every(p => Math.hypot(p.x - x, p.y - y) > p.r + rad + 80 && Math.hypot(S - p.x - x, S - p.y - y) > p.r + rad + 80);
  const spot = (rad, gen) => { for (let t = 0; t < 40; t++) { const [x, y] = gen().map(Math.round); if (clear(x, y, rad)) { placed.push({ x, y, r: rad }); return { x, y, r: rad }; } } };
  // --- хребет через центр (извилистый) с 2-3 перевалами и воронками из скал у перевалов
  const w1 = rr(20, 90), l1 = rr(120, 260), w2 = rr(0, 40), l2 = rr(60, 130), pa = rr(330, 700), cp = type === 'land' && rnd() < 0.5;
  const wob = (x) => w1 * Math.sin((x - C) / l1) + w2 * Math.sin((x - C) / l2);
  const passes = [pa, S - pa, ...(cp ? [C] : [])];
  const spurs = ridge ? mirrorSegs(passes.flatMap(px => { const y = C + wob(px), h = 40 + 12 * M; placed.push({ x: px, y: y - 160, r: 190 }); return [[px - 160, y - 264, px - 98, y - 74, 20, h], [px + 160, y - 264, px + 98, y - 74, 20, h]]; })) : [];
  // --- кратер: большой в центре (кратер) / поменьше (смесь), по краям — вал с 4 проходами по диагоналям
  const R = type === 'crater' ? rr(400, 560) : rr(240, 330), rimH = 22 + 36 * M, passW = 70 - 20 * M;
  if (hole) placed.push({ x: C, y: C, r: R + 40 });
  if (type === 'crater') for (let k = 0; k < 8; k++) { const t = deg(22.5 + 45 * k), c = Math.cos(t), s = Math.sin(t); spurs.push([C + c * (R + 110), C + s * (R + 110), C + c * (R + 300), C + s * (R + 300), 20, 40 + 12 * M]); }
  const small = [], kc = Math.round(6 + 18 * M);
  if (type === 'crater') for (let i = 0; i < 400 && small.length < 2 * kc; i++) {   // малые кратеры с пробоем в сторону центра
    const r = (rnd() < 0.1 ? 80 : 25) + rnd() * 45, e = r * 1.8 + 25, x = e + rnd() * (S - 2 * e), y = e + rnd() * (S - 2 * e);
    if (Math.hypot(x - C, y - C) < R + 60 + r || starts.some(s => Math.hypot(s.x - x, s.y - y) < 190 + r) || spurs.some(g => segD(x, y, g[0], g[1], g[2], g[3]) < e)) continue;
    if ((Math.abs(x - C) < e + 40 && Math.abs(y - C) > R - 60) || (Math.abs(y - C) < e + 40 && Math.abs(x - C) > R - 60)) continue;
    const gap = Math.atan2(C - y, C - x); small.push({ x, y, r, gap }, { x: S - x, y: S - y, r, gap: gap + Math.PI });
  }
  // --- острова: два материка, пролив шириной 240-800, сухопутный мост (если воды не слишком много) и острова в проливе
  const gapW = 120 + W * 280, coastY = C - gapW, bridge = W < 0.75 && !ocean, bw = 40 + (1 - W) * 60, bx = (y) => C - Math.sin((y - C) / 90) * 30;
  const isl = [];
  if (ocean) {   // острова баз (центр чуть в стороне от старта) и россыпь малых островов с массой
    for (const b of bases) { const s = { x: b[0] + Math.round(rr(-40, 40)), y: b[1] + Math.round(rr(-40, 40)), r: Rs }; placed.push({ ...s, r: Rs * 1.6 }); isl.push(s); }
    for (let k = 0, n = Math.round(3 + 4 * (1 - W)); k < 14 && n > 0; k++) { const r = Math.round(rr(75, 125)), s = spot(r * 1.6, () => [rr(200, S - 200), rr(200, S - 200)]); if (s) { isl.push({ x: s.x, y: s.y, r }); n--; } }
  } else if (sea) for (let k = 0; k < 5; k++) { const r = rr(70, 110), s = spot(r, () => { const o = rr(bridge ? bw + r + 60 : 0, C - 200); return [C + (rnd() < 0.5 ? -o : o), rr(coastY - 80, C - 50)]; }); if (s && k < Math.round(1 + 4 * W)) isl.push(s); }
  const islands = mirrorP(isl);
  // --- уступы-плато с пандусами, озёра (не в море), холмы
  const mesaPool = [];
  for (let k = 0; k < (ocean ? 0 : 7); k++) {
    const r = rr(36, 56), h = rr(16, 26), a1 = rr(0, 360), a2 = a1 + rr(100, 220), s = spot(r, () => [rr(140, S - 140), rr(140, (sea ? coastY : C) - (sea ? 140 : 260))]);
    if (s && (!hole || type === 'mixed')) mesaPool.push({ ...s, h, a: [a1, a2], run: 90 });
  }
  const half = mesaPool.slice(0, Math.round(1 + M * 5)), mesas = mirrorP(half);
  const lakePool = [];
  for (let k = 0; k < 6; k++) { const r = rr(60, 110), s = spot(r, () => [rr(150, S - 150), rr(150, C - 280)]); if (s && !sea) lakePool.push(s); }
  const lakes = mirrorP(lakePool.slice(0, Math.max(0, Math.min(6, Math.round((W - 0.15) * 7)))));
  const bumpPool = [];
  for (let k = 0; k < (ocean ? isl.length : 24); k++) {   // водный мир: по одному холму на остров, ниже на малых
    const o = ocean && isl[k % isl.length], [x, y] = o ? [o.x + rr(-0.6, 0.6) * o.r, o.y + rr(-0.6, 0.6) * o.r] : [rr(60, S - 60), rr(60, C)], w = rr(50, 80), h = rr(10, 16) * (0.6 + 0.8 * M) * (o ? Math.min(1, o.r / 200) : 1);
    if (!starts.some(s => Math.hypot(s.x - x, s.y - y) < 200)) bumpPool.push([x, y, w, h]); }
  const bumps = mirrorBumps(bumpPool.slice(0, Math.round(6 + 18 * M)));
  const water = sea || lakes.length ? 14 : -100;
  // --- высота
  const nz = symN((x, y) => fbm(x / 190, y / 190, sd + 11, 5)), rn = contrast(symN((x, y) => ridged(x / 60, y / 60, sd + 23, 4)), 0.55, 2.2);
  const cn = symN((x, y) => fbm(x / 90, y / 90, sd + 57, 3) * 45 + fbm(x / 380, y / 380, sd + 63, 3) * 70), hl = symN((x, y) => fbm(y * 1.3 / 150, x * 1.3 / 150, sd + 41, 5));
  const base = (x, y) => {
    let h = 24 + nz(x, y) * (7 + 7 * M), land = 1, rel = 1;   // rel: рельеф малых островов положе, чтобы пляж оставался проходимым
    if (sea) {
      const c = cn(x, y);
      land = ocean ? 0 : Math.max(smooth(coastY, coastY - 70, y + c), smooth(S - coastY, S - coastY + 70, y - c));
      if (bridge) land = Math.max(land, smooth(bw + 30, bw - 10, Math.abs(x - bx(y))));
      for (const i of islands) { const l = smooth(i.r * (ocean ? 1.6 : 1.5), i.r * (ocean ? 0.6 : 0.7), Math.hypot(x - i.x, y - i.y) + c * 0.6); if (ocean && l > land) rel = Math.min(1, i.r / 200); land = Math.max(land, l); }
      h = lerp(3 + nz(x, y) * 4, h + Math.max(0, hl(x, y)) * (8 + 24 * M) * rel, land);
    }
    if (ridge) {
      const d = Math.abs(y - C - wob(x));
      if (d < 420) {
        let ps = 0; for (const px of passes) ps = Math.max(ps, gauss(x - px, 42));
        h += (gauss(d, 60) * (6 + rn(x, y) * (6 + 60 * M)) + gauss(d, 130) * (4 + 10 * M)) * (1 - 0.97 * ps);
      }
    }
    if (hole) {
      const dx = x - C, dy = y - C, r = Math.hypot(dx, dy);
      h = lerp(h, (water > 0 ? 18 : 8) + (r / R) * (r / R) * 12, smooth(R, R - 120, r));   // дно выше уровня озёр: кратер не затопляет
      h += gauss(r, 56) * 30 + rn(x * 2, y * 2) * gauss(r, 80) * 6;
      let t = (Math.atan2(dy, dx) + 4 * Math.PI) % (Math.PI / 2); t = Math.abs(t - Math.PI / 4);   // угол до ближайшей диагонали
      h += gauss(r - R, 32) * (rimH + rn(x, y) * 26) * (1 - 0.97 * smooth(0.12, 0.85, gauss(t * R, passW)));
    }
    const add = spursAt(spurs, x, y) + bumpsAt(bumps, x, y);
    h += sea ? add * land : add;
    for (const c of small) {
      const dx = x - c.x, dy = y - c.y;
      if (Math.abs(dx) > c.r * 1.8 || Math.abs(dy) > c.r * 1.8) continue;
      const d = Math.hypot(dx, dy);
      if (d < c.r * 1.8) {
        const da = Math.acos(Math.max(-1, Math.min(1, Math.cos(Math.atan2(dy, dx) - c.gap)))), da2 = Math.PI - da, breach = Math.max(gauss(da * c.r, c.r * 0.7), gauss(da2 * c.r, c.r * 0.7));
        h += -smooth(c.r, 0, d) * c.r * 0.35 + gauss(d - c.r, c.r * 0.18) * c.r * 0.28 * (1 - 0.95 * smooth(0.1, 0.8, breach));
      }
    }
    for (const b of mesas) h += mesa(x, y, b.x, b.y, b.r, b.h, 14);
    for (const l of lakes) { const d = Math.hypot(x - l.x, y - l.y); if (d < l.r * 1.7) h = lerp(h, 4 + nz(x, y) * 2, smooth(l.r * 1.7, l.r * 0.7, d)); }
    return flattenStarts(h, starts, x, y, 26, 150);
  };
  const height = half.length ? withRamps(base, mirrorRamps(mesaRamps(half))) : base;
  // --- месторождения: по 4 у каждой базы, затем площадки на плато/островах и случайные сухие ровные точки (парами через центр)
  const mass = mirror(bases.flatMap(s => [[-44, -24], [44, -24], [-42, 68], [42, 68]].map(o => [s[0] + o[0], s[1] + o[1]])));
  const okPt = (x, y) => { const h = height(x, y); return h > water + 5 && [[12, 0], [-12, 0], [0, 12], [0, -12]].every(d => Math.abs(height(x + d[0], y + d[1]) - h) < 3); };
  const free = (x, y) => [[x, y], [S - x, S - y]].every(p => mass.every(m => Math.hypot(m.x - p[0], m.y - p[1]) > 75) && starts.every(s => Math.hypot(s.x - p[0], s.y - p[1]) > 110)) && Math.hypot(C - x, C - y) > 38;
  const fixed = [...half.map(m => [m.x, m.y]), ...isl.flatMap(i => [[i.x, i.y], [i.x - i.r * 0.45, i.y + 8], [i.x + i.r * 0.45, i.y - 8]])];
  let want = Math.round(8 + 42 * MS);
  for (let t = 0; t < 40 * want + fixed.length && want > 0; t++) {
    const f = fixed[t], x = Math.round(f ? f[0] : rr(60, S - 60)), y = Math.round(f ? f[1] : rr(60, S - 60));
    if (!free(x, y) || !okPt(x, y) || !okPt(S - x, S - y)) continue;
    mass.push({ x, y }, { x: S - x, y: S - y }); want--;
  }
  // --- вид: палитра/небо/деревья берутся у встроенной карты
  const L = ocean ? MAPS.archipelago : sea ? MAPS.seton : corner ? MAPS.astro : sd % 2 ? MAPS.seton : MAPS.dualgap, crystal = L.trees.kind === 'crystal', pc = (v) => Math.round(v * 100) + '%';
  const tn = GEN_TYPES.find(t => t[0] === type)[1];
  return {
    id: 'gen_' + type, name: `Случайная: ${tn} #${sd}`, en: 'Random: ' + type, players: P, seed: sd, size: S,
    desc: `Сид ${sd} · горы ${pc(M)} · вода ${pc(W)} · масса ${pc(MS)} · лес ${pc(F)} · ${P} игрока`,
    water, naval: sea, split: sea && !bridge, isles: ocean, starts, height, mass, palette: L.palette, sky: L.sky, waterColor: L.waterColor,
    trees: { kind: L.trees.kind, count: Math.round((crystal ? 200 + 2600 * F : 400 + 6000 * F) * (ocean ? 0.3 : 1)) }, rocks: Math.round((300 + 900 * F) * (crystal ? 2 : 1) * (ocean ? 0.3 : 1)),   // на океане суши мало: леса и скалы там гуще, поэтому меньше
    gen: { params: q, nBase: starts.length * 4 }
  };
}

// Недостижимые запасные месторождения убираются (базовые — по 4 у старта — остаются: недостижимые базовые = карта не годится).
// Возвращает Terrain карты (годится и для проверки, и для фона меню).
function pruneMass(m) {
  const T = new Terrain(m), e = T.effGrid(m.naval ? 'amph' : 'land', 3), lab = T.effComps(e), K = T.compAt(e, m.starts[0].x, m.starts[0].y);
  const key = (p) => p.x + ',' + p.y, bad = new Set(m.mass.slice(m.gen.nBase).filter(p => { const [nx, ny] = T.nearestOk(e, ...T.cell(p.x, p.y), 4); return !(e.ok[ny * PN + nx] && lab[ny * PN + nx] === K); }).map(key));
  m.mass = m.mass.filter(p => !bad.has(key(p)));
  T.mass = T.mass.filter(p => !bad.has(key(p))); T.mass.forEach((p, i) => { p.id = i; });
  m._T = T;
}

const cache = new Map();   // ключ параметров -> карта (с проверкой); при смене сида после проверки лежит и под ключом итогового сида
const draft = new Map();   // черновики для превью
const remember = (c, k, m, max = 12) => { c.delete(k); c.set(k, m); if (c.size > max) c.delete(c.keys().next().value); };   // LRU
/** Одна попытка с точно этим сидом: рельеф + отсев недостижимой массы, без кэша и проверки (в тестах — проверка детерминизма). */
export function genAttempt(p) { const m = buildMap(genNorm(p)); pruneMass(m); return m; }
/** Быстрая «черновая» карта для превью в лобби: без отсева недостижимой массы и без проверки (~10 мс, высоты по требованию). */
export function genPreview(params) {
  const p = genNorm(params), k = genKey(p), full = cache.get(k);
  if (full) return full;
  if (!draft.has(k)) remember(draft, k, buildMap(p), 48);
  return draft.get(k);
}
/**
 * Готовая карта по параметрам: рельеф + отсев массы + проверка связности. retry = true: при неудаче сид+1 ... (до 10 попыток);
 * итоговые параметры (с реальным сидом) — в map.gen.params, map.gen.errors — что не прошло (пусто = карта годна).
 * retry = false (загрузка сохранения, повтор партии): ровно одна попытка с этим сидом, без проверки — карта та же, что получилась при проверке.
 */
export function generateMap(params, retry = true) {
  const p = genNorm(params), k = genKey(p), c = cache.get(k);
  if (c && (!retry || c.gen.checked)) return c;
  let m;
  for (let i = 0; i < (retry ? TRIES : 1); i++) {
    m = genAttempt({ ...p, seed: (p.seed + i) % SEEDS });
    m.gen.requested = p.seed; m.gen.tries = i + 1; m.gen.checked = retry;
    if (!retry) break;
    m.gen.errors = checkMap(m, m._T).errors;
    if (!m.gen.errors.length) break;
  }
  remember(cache, k, m); remember(cache, genKey(m.gen.params), m);
  return m;
}
/** Карта матча из конфига лобби / сохранения: встроенная по id или сгенерированная по cfg.gen. */
export const mapOf = (cfg) => cfg.map === 'gen' ? generateMap(cfg.gen, false) : MAPS[cfg.map];
