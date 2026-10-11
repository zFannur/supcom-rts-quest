// ИИ-командир в настоящей игре: сбор состояния для нейросети (js/cmdnet.js) из того, что знает AICommander (туман войны соблюдается),
// и перевод её решений в рычаги js/ai.js. Раскладка входа — ровно как в песочнице (ml/sandbox/env.py: obs / masks / available).
// Карта делится на 5 зон по линии «моя база -> база главного врага»: 0 база · 1 расширение · 2 центр · 3 расширение врага · 4 база врага.
import { UNITS, STRUCTS, chainCost, UPGRADE_FROM } from './specs.js';
import { commanderForward, commanderMeta, pick, sampleLogp } from './cmdnet.js';
import { BASE_MACRO } from './stratnet.js';

const Z = 5, l1 = Math.log1p, cl = (v, a, b) => v < a ? a : v > b ? b : v;
const CAT = { land: 0, amph: 0, air: 1, naval: 2 };
const LAYER = (s) => s.layer === 'sub' ? 2 : CAT[s.move] ?? 0;
const RADAR = { radar: 1, radar2: 2, radar3: 3 };
const TRANSPORT = { trans1: 6, trans2: 14 };
const UNIT_OF_EXP = { x_colossus: 'exp_colossus', x_spider: 'exp_spider', x_fortress: 'exp_fortress', x_czar: 'exp_czar', x_seadragon: 'exp_seadragon' };
// бюджет модели -> рычаги AICommander (как макро-действия stratnet.js): доля армии/экономики, сдвиг заводов, ПВО, экспериментал
export const BUDGET_MACRO = [
  { army: 0.6, eco: 1.8, cap: 0.3, minN: 1.3 },                        // Экономика
  {},                                                                   // Сбалансированно
  { army: 1.7, eco: 0.5 },                                              // Армия
  { army: 0.85, eco: 1.4, bias: { TECH: 0.8 } },                        // Техника
  { army: 0.8, eco: 1.0, bias: { DEFEND: 0.4 } },                       // Постройки
  { air: 2.5, land: -1 },                                               // Авиация
  { land: -0.8, naval: 2 },                                             // Флот
  { army: 0.8, expInc: 20, bias: { EXPERIMENTAL: 0.7 } },               // Тяжёлое
];

export class Commander {
  constructor(ai, meta = commanderMeta()) {
    this.ai = ai; this.meta = meta;
    this.act = [1, 1, 15, 23, 29, 1, 1, 1, 0];       // как стартовые действия песочницы (env.reset)
    this.seen = Array.from({ length: Z }, () => new Map());   // память о враге по зонам: ключ каталога -> число (как env.seen)
    this.seenT = new Float32Array(Z);
    this.lastV = null; this.decisions = 0;
    const m = this.meta; this.act[1] = m.ix.tank1; this.act[2] = m.ix.int1; this.act[3] = m.ix.frigate; this.act[4] = m.ix['s:pd'];
  }

  // зона точки в координатах «моя база -> враг»
  zoneOf(x, y) {
    const a = this.ai, b = a.T.start, e = a.enemyStart || b;
    const dx = e.x - b.x, dy = e.y - b.y, L2 = dx * dx + dy * dy || 1;
    return cl(Math.floor(((x - b.x) * dx + (y - b.y) * dy) / L2 * Z), 0, Z - 1);
  }
  zonePoint(z) { const a = this.ai, b = a.T.start, e = a.enemyStart || b, k = (z + 0.5) / Z; return { x: b.x + (e.x - b.x) * k, y: b.y + (e.y - b.y) * k }; }
  keyOf(e) { const k = e.kind === 'struct' || e.spec?.isStruct ? 's:' + e.key : e.key; return this.meta.ix[k] !== undefined ? k : null; }

  // ---------------------------------------------------------------- state (как env.obs + env.masks)
  state() {
    const a = this.ai, g = a.g, eco = a.T.eco, t = g.time, m = this.meta, NE = m.units.length + m.structs.length;
    const costOf = (k) => k.startsWith('s:') ? chainCost(k.slice(2)).m : UNITS[k].costM || 0;
    const specOf = (k) => k.startsWith('s:') ? STRUCTS[k.slice(2)] : UNITS[k];
    // свои силы по зонам и слоям; присутствие (для видимости); счёт по каталогу
    const own = Array.from({ length: Z }, () => [0, 0, 0, 0]), present = new Array(Z).fill(false), mine = new Float32Array(NE);
    let engBp = 0, trans = 0, radar = 0, missiles = 0, anti = 0;
    for (const u of a.myUnits) {
      const s = u.spec, z = this.zoneOf(u.x, u.y); present[z] = true;
      if ((s.role === 'eng' && u.key !== 'sacu') || s.role === 'cmd') { engBp += s.bp || 0; continue; }   // SACU — в каталоге (строит и воюет)
      const k = this.keyOf(u); if (!k) continue;
      const f = u.hp / u.maxHp; mine[m.ix[k]] += f; own[z][LAYER(s)] += (s.costM || 0) * f;
      if (TRANSPORT[u.key]) trans += TRANSPORT[u.key];
    }
    for (const s of a.myStructs) {
      const z = this.zoneOf(s.x, s.y); present[z] = true;
      if (!s.built) continue;
      if (RADAR[s.key]) radar = Math.max(radar, RADAR[s.key]);
      if (s.silo) { if (s.spec.silo.kind === 'nuke') missiles += s.silo.stock; else if (s.spec.silo.kind === 'anti') anti += s.silo.stock; }
      const k = this.keyOf(s); if (!k) continue;
      mine[m.ix[k]] += 1; own[z][3] += costOf(k);
    }
    // видимость зон: свои там есть, свои база и расширение, радар; обновляем память о враге в видимых зонах
    const vis = present.map((p, z) => p || z <= 1 || radar >= z);
    const cur = Array.from({ length: Z }, () => new Map());
    for (const r of a.intel.units.values()) if (t - r.t < 2 && !r.radar) { const k = this.keyOf(r); if (k) { const z = this.zoneOf(r.x, r.y); cur[z].set(k, (cur[z].get(k) || 0) + r.hp / (r.maxHp || r.spec.hp)); } }
    for (const r of a.intel.structs.values()) if (r.built !== false) { const k = this.keyOf(r); if (k) { const z = this.zoneOf(r.x, r.y); cur[z].set(k, (cur[z].get(k) || 0) + 1); } }
    for (let z = 0; z < Z; z++) if (vis[z]) { this.seen[z] = cur[z]; this.seenT[z] = t; }
    const seenCnt = new Float32Array(NE), seenLv = Array.from({ length: Z }, () => [0, 0, 0, 0]);
    let enemySml = false;
    for (let z = 0; z < Z; z++) for (const [k, n] of this.seen[z]) {
      seenCnt[m.ix[k]] += n;
      seenLv[z][k.startsWith('s:') ? 3 : LAYER(specOf(k))] += costOf(k) * n;
      if (k === 's:sml') enemySml = true;
    }
    // экстракторы по зонам и тирам, свободные точки
    const mexZ = new Float32Array(Z), mexT = [0, 0, 0], occ = new Set(), freeZ = new Float32Array(Z);
    for (const s of g.structs) if (s.alive && s.spec.place === 'mex') {
      occ.add(s.x + ',' + s.y);
      if (s.team === a.team) { mexZ[this.zoneOf(s.x, s.y)]++; mexT[Math.min(3, s.spec.tier) - 1]++; }
    }
    for (const p of g.terrain.mass) if (!occ.has(p.x + ',' + p.y)) freeZ[this.zoneOf(p.x, p.y)]++;
    // заводы по родам войск: число, лучший тир (как в песочнице: 1 по умолчанию)
    const fac = [0, 0, 0], ftier = [1, 1, 1], fi = { land: 0, air: 1, naval: 2 };
    for (const s of a.myStructs) if (s.built && s.spec.produces) { const i = fi[s.spec.produces]; fac[i]++; ftier[i] = Math.max(ftier[i], Math.min(3, s.spec.tier)); }
    const tier = Math.max(1, ...ftier.map((v, i) => fac[i] ? v : 1));
    const water = a.navalOk ? 1 : 0, landPath = isFinite(a.landReach) ? 1 : 0;
    const gv = [t / 1800, l1(eco.incM) / 6, l1(eco.incE) / 9, eco.mass / 2150, eco.energy / 4000, eco.stallE ? 1 : 0, tier / 3, l1(engBp) / 6];
    for (let z = 0; z < Z; z++) gv.push(l1(mexZ[z]) / 3);
    for (let i = 0; i < 3; i++) gv.push(mexT[i] / 30);
    for (let z = 0; z < Z; z++) gv.push(l1(freeZ[z]) / 3);
    for (let i = 0; i < 3; i++) gv.push(l1(fac[i]) / 2);
    for (let i = 0; i < 3; i++) gv.push(ftier[i] / 3);
    for (let i = 0; i < 3; i++) gv.push(0);                                         // прогресс апгрейда завода (в игре не копим)
    for (let z = 0; z < Z; z++) for (let i = 0; i < 4; i++) gv.push(l1(own[z][i]) / 10);
    for (let z = 0; z < Z; z++) for (let i = 0; i < 4; i++) gv.push(l1(seenLv[z][i]) / 10);
    for (let z = 0; z < Z; z++) gv.push(cl((t - this.seenT[z]) / 600, 0, 2));
    gv.push((a.acuU ? a.acuU.hp : 0) / 11000, enemySml ? 1 : 0, missiles / 3, anti / 2, landPath, water);
    for (let i = 0; i < m.budgets.length; i++) gv.push(this.act[0] === i ? 1 : 0);
    for (let h = 5; h < 8; h++) for (let z = 0; z < Z; z++) gv.push(this.act[h] === z ? 1 : 0);
    if (gv.length !== m.NG) throw new Error(`cmdstate: ${gv.length} != ${m.NG}`);
    // каталог: доступность (как env.available), моих, видели
    const avail = new Uint8Array(NE), dyn = [];
    const landT = fac[0] ? ftier[0] : 0;   // инженеры Т2/Т3 — только с наземного завода Т2/Т3
    m.units.forEach((k, i) => {
      const s = UNITS[k], c = CAT[s.move];
      let ok = (s.role === 'exp' || k === 'sacu') ? landT >= 3 : fac[c] > 0 && ftier[c] >= s.tier;
      if (c === 2 && !water) ok = false;
      avail[i] = ok ? 1 : 0;
    });
    m.structs.forEach((k, j) => {
      const s = STRUCTS[k], pre = UPGRADE_FROM[k];
      avail[m.units.length + j] = landT >= Math.min(3, s.tier) && !(k === 'torp' && !water) && (!pre || mine[m.ix['s:' + pre]] >= 1) ? 1 : 0;
    });
    for (let i = 0; i < NE; i++) dyn.push([avail[i], l1(mine[i]) / 4, l1(seenCnt[i]) / 4]);
    // маски по головам (как env.masks)
    const nu = m.units.length, cat = (i) => i < nu ? CAT[UNITS[m.units[i]].move] : -1;
    const masks = [m.budgets.map((_, i) => i === 6 ? water : 1)];
    for (let c = 0; c < 3; c++) masks.push(Array.from({ length: NE }, (_, i) => avail[i] && cat(i) === c ? 1 : 0));
    masks[3][m.ix.frigate] = 1;
    masks.push(Array.from({ length: NE }, (_, i) => i >= nu && avail[i] ? 1 : 0));
    for (let h = 0; h < 3; h++) masks.push(new Array(Z).fill(1));
    masks.push(m.special.map((_, i) => i === 2 ? (missiles >= 1 ? 1 : 0) : i === 3 ? (trans >= 1 ? 1 : 0) : 1));
    return { g: Float32Array.from(gv), dyn, masks };
  }

  // ---------------------------------------------------------------- decision (раз в 30 с)
  decide(temp = 0) {
    const s = this.state(), r = commanderForward(s.g, s.dyn);
    if (!r) return null;
    if (this.record) {   // дообучение: сэмпл по вероятностям модели + запись шага (состояние, маски, действия, log p, ценность)
      let lp = 0;
      this.act = r.logits.map((l, h) => { const [k, l1] = sampleLogp(l, s.masks[h]); lp += l1; return k; });
      this.record({ t: Math.round(this.ai.g.time), g: Array.from(s.g, v => +v.toFixed(5)), dyn: s.dyn.map(d => d.map(v => +v.toFixed(5))),
        m: s.masks.map(mm => mm.map(v => v ? 1 : 0).join('')), a: this.act.slice(), lp: +lp.toFixed(5), v: +r.value.toFixed(5) });
    } else this.act = r.logits.map((l, h) => pick(l, s.masks[h], temp));
    this.lastV = 1 / (1 + Math.exp(-r.value));
    return this.apply();
  }

  // решение -> рычаги AICommander и сообщение в чат
  apply() {
    this.decisions++; this.lastT = this.ai.g.time;
    (this.trace = this.trace || []).push([Math.round(this.ai.g.time), ...this.act, +this.lastV.toFixed(2)]);   // журнал решений (проверка в настоящих партиях)
    const m = this.meta, ai = this.ai, a = this.act;
    {
      ai.macro = { ...BASE_MACRO, ...BUDGET_MACRO[a[0]] };
      ai.macro.bias = ai.macro.bias || {};
    }
    const name = (i) => i < m.units.length ? UNITS[m.units[i]].name : STRUCTS[m.structs[i - m.units.length]].name;
    const zn = ['своя база', 'своё расширение', 'центр', 'расширение врага', 'база врага'];   // зоны линии: 0 моя база .. 4 база врага
    ai.say('КОМАНДИР', `${m.budgets[a[0]]} · суша: ${name(a[1])}, авиация: ${name(a[2])}${ai.navalOk ? `, флот: ${name(a[3])}` : ''} · стройка: ${name(a[4])} · `
      + `суша → ${zn[a[5]]}, авиация → ${zn[a[6]]}${ai.navalOk ? `, флот → ${zn[a[7]]}` : ''}${a[8] ? ' · ' + m.special[a[8]] : ''}`);
    return this.act;
  }

  // ---------------------------------------------------------------- исполнители (вызываются из js/ai.js)
  // завод: что строить (null — решает обычная логика: инженеры, разведчики)
  unitFor(f) {
    const m = this.meta, type = f.spec.produces, h = { land: 1, air: 2, naval: 3 }[type];
    const k = m.units[this.act[h]];
    if (!k || !UNITS[k] || UNITS[k].role === 'exp') return null;
    if (UNITS[k].tier > f.spec.tier) return null;
    if ((CAT[UNITS[k].move] ?? -1) !== h - 1) return null;   // юнит не того рода войск (голова без вариантов отдаёт строку 0) — решает завод
    return k;
  }
  // экспериментал, выбранный для суши / авиации / флота (строят инженеры)
  expKey() {
    const m = this.meta;
    for (const h of [1, 2, 3]) { const k = m.units[this.act[h]]; if (k && UNIT_OF_EXP[k]) return UNIT_OF_EXP[k]; }
    return null;
  }
  // постройка для инженеров: ключ и где ставить
  structTask() {
    const m = this.meta, i = this.act[4] - m.units.length;
    if (i < 0) return null;
    const key = m.structs[i], ai = this.ai;
    if (STRUCTS[key].upgradeOnly) {   // щиты и радары Т2/Т3 только улучшаются из предшественника
      const from = UPGRADE_FROM[key], s = ai.myStructs.find(x => x.key === from && x.built && !x.upgrading);
      if (s && ai.T.eco.mass > 100) ai.g.upgrade(s);
      return null;
    }
    const spread = !['sml', 'smd', 'tml', 'tmd', 'arty2', 'arty3s', 'radar', 'radar2', 'radar3'].includes(key);
    const near = STRUCTS[key].place === 'water' ? ai.navalStaging : spread && Math.random() < 0.5 ? this.zonePoint(1) : { x: ai.base.x + ai.dir.x * 40, y: ai.base.y + ai.dir.y * 40 };
    return near ? { key, near } : null;
  }
  // цель рода войск: зона (0..4) в координатах игрока
  due(t) { return t - (this.lastT ?? -1e9) >= 30; }   // плановое решение раз в 30 с (универсальный командир добавляет внеочередные)
  zoneFor(type) { return this.act[type === 'air' ? 6 : type === 'naval' ? 7 : 5]; }
  special() { return this.meta.special[this.act[8]]; }
}
