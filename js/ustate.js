// Универсальный ИИ-командир в настоящей игре (модель ml/universal, вывод js/unet.js).
// Собирает объекты так же, как песочница (ml/universal/world.py: obs / masks): карта — 5 зон линии «моя база -> база врага»
// (вид карты «линия», на нём модель проверяется как «якорь»), каталог — профиль supcom (48 сущностей).
// Исполнители решений — общие с командиром v2 (js/cmdstate.js: заводы, постройки, цели родов войск, особые действия).
import { UNITS, STRUCTS, chainCost, UPGRADE_FROM } from './specs.js';
import { Commander } from './cmdstate.js';
import { universalForward, universalMeta } from './unet.js';
import { pick, sampleLogp } from './cmdnet.js';

const Z = 5, l1 = Math.log1p, cl = (v, a, b) => v < a ? a : v > b ? b : v;
const CAT = { land: 0, amph: 0, air: 1, naval: 2 };
const LAYER = (s) => s.layer === 'sub' ? 2 : CAT[s.move] ?? 0;
const RADAR = { radar: 1, radar2: 2, radar3: 3 };
const TRANSPORT = { trans1: 6, trans2: 14 };

export class UCommander extends Commander {
  constructor(ai) {
    const j = universalMeta(), ix = {};
    j.units.forEach((k, i) => { ix[k] = i; }); j.structs.forEach((k, i) => { ix['s:' + k] = j.units.length + i; });
    super(ai, { units: j.units, structs: j.structs, budgets: j.budgets, special: j.special, ix });
    this.j = j; this.hist = []; this.dec = { adv: 0, k: 0, l: 0 };
  }

  // истинная стоимость сил команды (как value() песочницы — она тоже знает обе стороны; только для истории решений)
  teamValue(team) {
    const g = this.ai.g; let v = 0;
    for (const u of g.units) if (u.alive && u.team === team) v += (u.spec.costM || 0) * u.hp / u.maxHp;
    for (const s of g.structs) if (s.alive && s.team === team && s.built) v += chainCost(s.key).m;
    return v;
  }

  // ---------------------------------------------------------------- объекты (как World.obs) и маски (как World.masks)
  state() {
    const a = this.ai, g = a.g, eco = a.T.eco, t = g.time, m = this.meta, j = this.j, R = j.rules, NE = m.units.length + m.structs.length;
    const costOf = (k) => k.startsWith('s:') ? chainCost(k.slice(2)).m : UNITS[k].costM || 0;
    const specOf = (k) => k.startsWith('s:') ? STRUCTS[k.slice(2)] : UNITS[k];
    const own = Array.from({ length: Z }, () => [0, 0, 0, 0]), present = new Array(Z).fill(false), mine = new Float32Array(NE), shield = new Float32Array(Z);
    let engBp = 0, trans = 0, radar = 0, missiles = 0, anti = 0;
    for (const u of a.myUnits) {
      const s = u.spec, z = this.zoneOf(u.x, u.y); present[z] = true;
      if ((s.role === 'eng' && u.key !== 'sacu') || s.role === 'cmd') { engBp += s.bp || 0; continue; }
      const k = this.keyOf(u); if (!k) continue;
      const f = u.hp / u.maxHp; mine[m.ix[k]] += f; own[z][LAYER(s)] += (s.costM || 0) * f;
      if (TRANSPORT[u.key]) trans += TRANSPORT[u.key];
    }
    for (const s of a.myStructs) {
      const z = this.zoneOf(s.x, s.y); present[z] = true;
      if (!s.built) continue;
      if (RADAR[s.key]) radar = Math.max(radar, RADAR[s.key]);
      if (s.silo) { if (s.spec.silo.kind === 'nuke') missiles += s.silo.stock; else if (s.spec.silo.kind === 'anti') anti += s.silo.stock; }
      if (s.shield && s.shield.on) shield[z] += s.shield.hp;
      const k = this.keyOf(s); if (!k) continue;
      mine[m.ix[k]] += 1; own[z][3] += costOf(k);
    }
    // видимость (свои там есть, база и соседняя зона, радар по переходам от базы) и память о враге
    const vis = present.map((p, z) => p || z <= Math.max(1, radar));
    const cur = Array.from({ length: Z }, () => new Map()), mexSeen = new Float32Array(Z);
    for (const r of a.intel.units.values()) if (t - r.t < 2 && !r.radar) { const k = this.keyOf(r); if (k) { const z = this.zoneOf(r.x, r.y); cur[z].set(k, (cur[z].get(k) || 0) + r.hp / (r.maxHp || r.spec.hp)); } }
    for (const r of a.intel.structs.values()) if (r.built !== false) {
      const z = this.zoneOf(r.x, r.y);
      if (r.spec?.place === 'mex') mexSeen[z]++;
      const k = this.keyOf(r); if (k) cur[z].set(k, (cur[z].get(k) || 0) + 1);
    }
    this.mexSeen = this.mexSeen || new Float32Array(Z);
    for (let z = 0; z < Z; z++) if (vis[z]) { this.seen[z] = cur[z]; this.seenT[z] = t; this.mexSeen[z] = mexSeen[z]; }
    const seenCnt = new Float32Array(NE), seenLv = Array.from({ length: Z }, () => [0, 0, 0, 0]);
    let seenTier = 0;
    for (let z = 0; z < Z; z++) for (const [k, n] of this.seen[z]) {
      seenCnt[m.ix[k]] += n;
      seenLv[z][k.startsWith('s:') ? 3 : LAYER(specOf(k))] += costOf(k) * n;
    }
    seenCnt.forEach((n, i) => { if (n > 0.3) seenTier = Math.max(seenTier, j.ent_static[i].slice(8, 12).indexOf(1) + 1); });
    // экстракторы и точки по зонам
    const mexZT = Array.from({ length: Z }, () => [0, 0, 0]), mexT = [0, 0, 0], occ = new Set(), freeZ = new Float32Array(Z), slots = new Float32Array(Z);
    for (const s of g.structs) if (s.alive && s.spec.place === 'mex') {
      occ.add(s.x + ',' + s.y); const z = this.zoneOf(s.x, s.y); slots[z]++;
      if (s.team === a.team) { const ti = Math.min(3, s.spec.tier) - 1; mexZT[z][ti]++; mexT[ti]++; }
    }
    for (const p of g.terrain.mass) if (!occ.has(p.x + ',' + p.y)) { const z = this.zoneOf(p.x, p.y); freeZ[z]++; slots[z]++; }
    const fac = [0, 0, 0], ftier = [1, 1, 1], fi = { land: 0, air: 1, naval: 2 };
    for (const s of a.myStructs) if (s.built && s.spec.produces) { const i = fi[s.spec.produces]; fac[i]++; ftier[i] = Math.max(ftier[i], Math.min(3, s.spec.tier)); }
    const tier = Math.max(1, ...ftier.map((v, i) => fac[i] ? v : 1));
    const water = a.navalOk ? 1 : 0, landPath = isFinite(a.landReach) ? 1 : 0;
    const L = j.lines[`${landPath}${water}`] || j.lines['10'];
    const st = g.teams[a.team].stats, vme = this.teamValue(a.team);
    const sum4 = (A) => [0, 1, 2, 3].map(i => A.reduce((s, r) => s + r[i], 0));
    // признаки — по именам (порядок и набор берутся из схемы модели: старые и новые модели читают одно и то же)
    const SP = ['none', 'scout', 'nuke', 'drop', 'snipe'], ev = this.ev || [0, 0, 0, 0];
    const [ag, aa, an, as] = sum4(own).map(v => l1(v) / 10), [sg, sa, sn, ss] = sum4(seenLv).map(v => l1(v) / 10);
    const me = { time: t / 1800, time_left: Math.max(0, R.max_t - t) / 2400, inc_m: l1(eco.incM) / 6, inc_e: l1(eco.incE) / 9, mass: eco.mass / R.mass_cap,
      energy: eco.energy / R.energy_cap, stall: eco.stallE ? 1 : 0, tier: tier / 3, eng_bp: l1(engBp) / 6, mex1: mexT[0] / 30, mex2: mexT[1] / 30, mex3: mexT[2] / 30,
      fac_land: l1(fac[0]) / 2, fac_air: l1(fac[1]) / 2, fac_naval: l1(fac[2]) / 2, ftier_land: ftier[0] / 3, ftier_air: ftier[1] / 3, ftier_naval: ftier[2] / 3,
      tprog_land: 0, tprog_air: 0, tprog_naval: 0,   // прогресс улучшения завода в игре не копится (в песочнице — копится)
      acu: (a.acuU ? a.acuU.hp : 0) / R.acu_hp, missiles: missiles / 3, anti: anti / 2, water, land_path: landPath, zones: Z / 9,
      army_ground: ag, army_air: aa, army_naval: an, army_struct: as, value: l1(vme) / 11, kills: l1(st.massKilled) / 11, losses: l1(st.massLost) / 11,
      ev_base: ev[0], ev_nuke: ev[1], ev_loss: ev[2], ev_acu: ev[3] };
    const foe = { seen_ground: sg, seen_air: sa, seen_naval: sn, seen_struct: ss, seen_nuke: Math.min(1, seenCnt[m.ix['s:sml']]), seen_antinuke: Math.min(1, seenCnt[m.ix['s:smd']]),
      seen_count: l1(seenCnt.reduce((s, v) => s + v, 0)) / 6, seen_tier: seenTier / 4 };
    const zone = [];
    for (let z = 0; z < Z; z++) {
      const enemyPw = seenLv[z].reduce((s, v) => s + v, 0), myPw = own[z].reduce((s, v) => s + v, 0);
      zone.push({ valid: 1, my_base: +(z === 0), foe_base: +(z === Z - 1), my_exp: +(z === 1), land: 1, water: L.zw[z], slots: l1(slots[z]) / 3,
        my_mex1: l1(mexZT[z][0]) / 3, my_mex2: l1(mexZT[z][1]) / 3, my_mex3: l1(mexZT[z][2]) / 3, free: l1(freeZ[z]) / 3,
        my_ground: l1(own[z][0]) / 10, my_air: l1(own[z][1]) / 10, my_naval: l1(own[z][2]) / 10, my_struct: l1(own[z][3]) / 10,
        seen_ground: l1(seenLv[z][0]) / 10, seen_air: l1(seenLv[z][1]) / 10, seen_naval: l1(seenLv[z][2]) / 10, seen_struct: l1(seenLv[z][3]) / 10,
        seen_age: Math.min(2, (t - this.seenT[z]) / 600), dist_my: L.de[z] / 6, dist_foe: L.de[Z - 1 - z] / 6, reach_land: L.reach_l[z], reach_naval: L.reach_w[z],
        front: Math.min(1, L.frac[z]), tgt_land: +(this.act[5] === z), tgt_air: +(this.act[6] === z), tgt_naval: +(this.act[7] === z), shield: l1(shield[z]) / 10,
        x: L.xy[z][0], y: L.xy[z][1], hops_my: Math.min(9, L.hc[z]) / 6, control: +(myPw >= 0.8 * enemyPw), seen_mex: l1(this.mexSeen[z]) / 3 });
    }
    const vec = (o, names) => names.map(n => o[n] ?? 0);
    // доступность каталога (как World.available) и строки каталога: статичные признаки профиля + доступно / моих / видели
    const landT = fac[0] ? ftier[0] : 0, avail = new Uint8Array(NE);
    m.units.forEach((k, i) => {
      const s = UNITS[k], c = CAT[s.move];
      let ok = (s.role === 'exp' || k === 'sacu') ? landT >= 3 : fac[c] > 0 && ftier[c] >= s.tier;
      if (c === 2 && !water) ok = false;
      avail[i] = ok ? 1 : 0;
    });
    m.structs.forEach((k, jx) => {
      const s = STRUCTS[k], pre = UPGRADE_FROM[k];
      avail[m.units.length + jx] = landT >= Math.min(3, s.tier) && !(k === 'torp' && !water) && (!pre || mine[m.ix['s:' + pre]] >= 1) ? 1 : 0;
    });
    const ent = j.ent_static.map((row, i) => [...row, avail[i], l1(mine[i]) / 4, l1(seenCnt[i]) / 4]);
    const goal = { goal_win: 1, goal_hold: 0, hold_time: 0.6, v_assassination: +(g.opts.victory !== 'annihilation'), v_annihilation: +(g.opts.victory === 'annihilation') };
    const hist = Array.from({ length: j.arch.hist }, (_, i) => vec(this.hist[i] || {}, j.schema.hist));
    const nu = m.units.length, cat = (i) => i < nu ? CAT[UNITS[m.units[i]].move] : -1;
    const masks = [j.shares.map(sh => sh[5] > 0.3 && !water ? 0 : 1)];
    for (let c = 0; c < 3; c++) masks.push(Array.from({ length: NE }, (_, i) => avail[i] && cat(i) === c ? 1 : 0));
    masks.push(Array.from({ length: NE }, (_, i) => i >= nu && avail[i] ? 1 : 0));
    masks.push(new Array(Z).fill(1), new Array(Z).fill(1), Array.from({ length: Z }, (_, z) => water ? L.zw[z] : +(z === 0)));
    masks.push(m.special.map((_, i) => i === 2 ? (missiles >= 1 ? 1 : 0) : i === 3 ? (trans >= 1 ? 1 : 0) : 1));
    const S = j.schema;
    return { inp: { goal: [vec(goal, S.goal)], me: [vec(me, S.me)], foe: [vec(foe, S.foe)], hist, zone: zone.map(o => vec(o, S.zone)), ent, et: L.et }, masks, L, vme, st };
  }

  // история решений (как World._push_hist): что было выбрано в прошлый раз и что из этого вышло
  pushHist(s) {
    const a = this.ai, j = this.j, foeT = a.enemyTeam || (a.team === 1 ? 2 : 1), vf = this.teamValue(foeT);
    const adv = (s.vme - vf) / (s.vme + vf + 1), k = s.st.massKilled, l = s.st.massLost, act = this.act;
    const e = { h_valid: 1, h_gap: (a.g.time - (this.lastT ?? a.g.time)) / 30, h_adv: (adv - this.dec.adv) * 5, h_kills: l1(Math.max(0, k - this.dec.k)) / 8,
      h_losses: l1(Math.max(0, l - this.dec.l)) / 8, h_inc: l1(a.T.eco.incM) / 6, h_tland: Math.min(1, s.L.frac[act[5]]), h_tair: Math.min(1, s.L.frac[act[6]]) };
    j.shares[act[0]].forEach((v, i) => { e['h_share' + i] = v; });
    ['none', 'scout', 'nuke', 'drop', 'snipe'].forEach((n, i) => { e['h_sp_' + n] = +(act[8] === i); });
    this.hist.unshift(e); this.hist.length = Math.min(this.hist.length, j.arch.hist);
    this.dec = { adv, k, l };
  }

  decide(temp = 0) {
    const s = this.state(), r = universalForward(s.inp);
    if (!r) return null;
    let act, lp = 0;
    if (this.record) act = r.logits.map((l, h) => { const [k, l1_] = sampleLogp(l, s.masks[h]); lp += l1_; return k; });
    else act = r.logits.map((l, h) => pick(l, s.masks[h], temp));
    if (this.record) this.record({ t: Math.round(this.ai.g.time), inp: s.inp, m: s.masks.map(mm => mm.join('')), a: act.slice(), lp: +lp.toFixed(5), v: +r.value.toFixed(5) });
    this.pushHist(s);
    this.act = act;
    this.lastV = r.value;
    // опорные значения для событий (как World.step при решении)
    const a = this.ai;
    this.ref = { base: this.foeAtBase() > 300, nuke: this.foeNuke(), acu: a.acuU ? a.acuU.hp : 0, lost: s.st.massLost, val: s.vme };
    this.ev = [0, 0, 0, 0];
    return this.apply();
  }

  // ---------------------------------------------------------------- события -> внеочередное решение (как World.events)
  foeAtBase() {
    const a = this.ai, t = a.g.time; let m = 0;
    for (const r of a.intel.units.values()) if (t - r.t < 2 && this.zoneOf(r.x, r.y) === 0) m += (r.spec.costM || 0) * r.hp / (r.maxHp || r.spec.hp);
    return m;
  }
  foeNuke() { for (const r of this.ai.intel.structs.values()) if (r.key === 'sml') return true; return false; }
  mineAtBase() { let m = 0; for (const u of this.ai.myUnits) if (this.zoneOf(u.x, u.y) === 0) m += (u.spec.costM || 0) * u.hp / u.maxHp; return m; }
  urgent() {
    const a = this.ai, R = this.ref; if (!R) return false;
    const fb = this.foeAtBase();
    const ev = [+(fb > Math.max(300, 0.2 * this.mineAtBase()) && !R.base), +(this.foeNuke() && !R.nuke),
      +(a.g.teams[a.team].stats.massLost - R.lost > 0.15 * (R.val + 500)), +((a.acuU ? a.acuU.hp : 0) < 0.9 * R.acu)];
    if (!ev.some(Boolean)) return false;
    this.ev = ev; return true;
  }
  // пора решать: плановое раз в 30 с или внеочередное по событию (не чаще раза в 10 с)
  due(t) { const dt = t - (this.lastT ?? -1e9); return dt >= 30 || (dt >= 10 && this.urgent()); }
}
