// Strategic AI commander.
//  Short-term memory (Intel): remembered enemy units/structures, decaying threat maps per layer,
//    loss/kill heat maps, enemy composition & tech, enemy ACU sightings.
//  Long-term memory (localStorage): per-map strategy win statistics (UCB1 bandit) and an opponent
//    profile (air/naval/land ratios, rush timing) that biases the next game.
//  Decision layer: heuristic utility "intents", economy/engineer/factory managers, platoon-based military planner and ACU survival logic.
import { UNITS, STRUCTS, PRODUCES, ENH, nukeDamage } from './specs.js';
import { Game } from './sim.js';
import { powerOf } from './unitai.js';
import { PN, PCELL } from './terrain.js';
import { MAP_SIZE } from './maps.js';
import { predictFight, hasCombatNet } from './combatnet.js';
import { MACROS, macroOf, stateVector, evalState, macroMask, pickMacro, hasStrategyNet } from './stratnet.js';
import { hasUniversalNet } from './unet.js';
import { UCommander } from './ustate.js';

const GS = 32, GC = MAP_SIZE / GS;      // intel grid: cells of 32 units
const KM = MAP_SIZE / 1024;             // distances tuned on the old 1024 map (staging, search radii, wave reach) scale with the map
const hyp = Math.hypot;
const dist = (a, b) => hyp(a.x - b.x, a.y - b.y);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const AIP = globalThis.__AIP || {};      // benchmark hooks (tools/aivs.mjs --params)
const fmtT = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export const STRATEGIES = {
  land_rush: { name: 'Танковый натиск', desc: 'Много наземных заводов, ранняя атака', fac: { land: 3, air: 1, naval: 0 }, eco: 0.75, tech2: 420, tech3: 1100, aggr: 1.35, def: 0.2, firstAttack: 170 },
  air_dom: { name: 'Господство в воздухе', desc: 'Авиация, бомбардировщики, ганшипы', fac: { land: 1, air: 3, naval: 0 }, eco: 0.9, tech2: 390, tech3: 950, aggr: 1.1, def: 0.3, firstAttack: 240 },
  naval: { name: 'Контроль моря', desc: 'Флот давит побережье', fac: { land: 1, air: 1, naval: 3 }, eco: 1.0, tech2: 420, tech3: 1000, aggr: 1.0, def: 0.35, firstAttack: 300, needsNaval: true },
  eco_tech: { name: 'Экономика и технологии', desc: 'Быстрый Т2/Т3, экспериментал', fac: { land: 2, air: 1, naval: 1 }, eco: 1.35, tech2: 270, tech3: 720, aggr: 0.85, def: 0.35, firstAttack: 360, exp: true },
  turtle: { name: 'Крепость и артиллерия', desc: 'Оборона, щиты, дальнобойная артиллерия', fac: { land: 2, air: 1, naval: 1 }, eco: 1.15, tech2: 330, tech3: 850, aggr: 0.65, def: 0.6, firstAttack: 480, arty: true, exp: true },
  balanced: { name: 'Комбинированные силы', desc: 'Сбалансированная армия всех родов войск', fac: { land: 2, air: 2, naval: 1 }, eco: 1.0, tech2: 360, tech3: 900, aggr: 1.0, def: 0.3, firstAttack: 260, exp: true }
};

export const INTENTS = [
  { key: 'ECO', ru: 'Расширение экономики', en: 'The commander should expand the economy by capturing more mass deposits and building power generators.' },
  { key: 'TECH', ru: 'Технологический рывок', en: 'The commander should upgrade factories and extractors to a higher tech level.' },
  { key: 'ARMY', ru: 'Наращивание армии', en: 'The commander should build a larger army before attacking.' },
  { key: 'ATTACK', ru: 'Наступление', en: 'The commander should launch an attack on enemy positions now.' },
  { key: 'RAID', ru: 'Рейды по экономике врага', en: 'The commander should raid enemy mass extractors with fast units.' },
  { key: 'DEFEND', ru: 'Оборона базы', en: 'The commander should defend the home base against incoming enemy forces.' },
  { key: 'ANTIAIR', ru: 'Противовоздушная оборона', en: 'The commander should build anti-air defenses because the enemy air force is strong.' },
  { key: 'SNIPE', ru: 'Охота на командира врага', en: 'The commander should send all forces to kill the enemy commander.' },
  { key: 'EXPERIMENTAL', ru: 'Экспериментальное оружие', en: 'The commander should build an experimental super weapon.' }
];

// ------------------------------------------------------------------ combat net glue (module level: lieutenants borrow runAttack / pickTarget without our helper methods)
// ponytail: боевая сеть выключена по умолчанию — в партиях 50% против ИИ без неё (ml/PLAN.md); включить: aivs --params={"combat":1}
// Predict the fight of our units against what we KNOW around (x, y): Intel records (fog respected), their structures; model: js/combatnet.js.
// plan: A is virtually placed PLAN_D units from the target on its own side (the net was trained on contact-range fights), no own structures.
const PLAN_D = 150, FIGHT = { pWin: 0.5, ta: 0, tr: 0, empty: true };
function fightAt(ai, units, x, y, plan) {
  if (!AIP.combat || !units.length || !hasCombatNet()) return null;
  const I = ai.intel, now = ai.g.time, B = [], sb = [], A = [];
  for (const u of I.units.values()) {
    if (now - u.t > 20 || Math.abs(u.x - x) > 130 || Math.abs(u.y - y) > 130 || !(u.spec.dps > 0)) continue;
    B.push({ spec: u.spec, hp: u.hp, maxHp: u.maxHp || u.spec.hp, x: u.x, y: u.y, alive: true });
  }
  for (const r of I.structs.values()) {
    if (r.built === false || Math.abs(r.x - x) > 170 || Math.abs(r.y - y) > 170 || !(r.spec.dps > 0 || r.spec.shield)) continue;
    sb.push({ spec: r.spec, hp: r.hp, maxHp: r.maxHp || r.spec.hp, x: r.x, y: r.y, alive: true, built: true });
  }
  if (!B.length && !sb.length) return null;
  let cx = 0, cy = 0;
  for (const u of units) { cx += u.x; cy += u.y; }
  cx /= units.length; cy /= units.length;
  let ox = 0, oy = 0, sa = null;
  if (plan) {
    const dx = cx - x, dy = cy - y, l = hyp(dx, dy) || 1;
    ox = x + dx / l * PLAN_D - cx; oy = y + dy / l * PLAN_D - cy;
  } else {
    sa = [];
    for (const s of ai.myStructs || ai.ownStructs || []) if (s.built && (s.spec.dps > 0 || s.spec.shield) && Math.abs(s.x - cx) < 150 && Math.abs(s.y - cy) < 150) sa.push(s);
  }
  for (const u of units) A.push({ spec: u.spec, hp: u.hp, maxHp: u.maxHp, x: u.x + ox, y: u.y + oy, alive: true, pshield: u.pshield });
  const r = predictFight(A, B, { terrain: ai.g.terrain, sa, sb });
  if (!r) return null;
  FIGHT.pWin = r.pWin; FIGHT.ta = r.tradeAttack; FIGHT.tr = r.tradeRetreat;
  return { pWin: r.pWin, ta: r.tradeAttack, tr: r.tradeRetreat, nB: B.length, nS: sb.length };
}
// attack verdict at a target (planning)
const fightOk = (f, relax = 0) => f.ta > (AIP.okTa ?? 0.06) - relax && f.pWin > (AIP.okP ?? 0.55) - relax * 2;   // relax: macro ATTACK takes fights a bit closer to even

// ------------------------------------------------------------------ long-term memory
const LTM_KEY = 'supcom3d_ai_memory_v1';
const freshLTM = () => ({ v: 1, games: 0, wins: 0, losses: 0, maps: {}, profile: { n: 0, air: 0.25, naval: 0.1, land: 0.65, rushT: 300, t2T: 600 }, history: [] });
export function loadLTM() {
  try { const m = JSON.parse(globalThis.localStorage?.getItem(LTM_KEY)); if (m && m.v === 1) return m; } catch (e) { /* no storage */ }
  return freshLTM();
}
export function saveLTM(m) { try { globalThis.localStorage?.setItem(LTM_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ } }
export function resetLTM() { saveLTM(freshLTM()); }

// ------------------------------------------------------------------ INTEL (short-term memory)
export class Intel {
  constructor(ai) {
    this.ai = ai; this.g = ai.g; this.team = ai.team;
    this.units = new Map(); this.structs = new Map();
    this.thrLand = new Float32Array(GC * GC); this.thrAir = new Float32Array(GC * GC); this.thrNaval = new Float32Array(GC * GC);
    this.value = new Float32Array(GC * GC); this.loss = new Float32Array(GC * GC); this.kill = new Float32Array(GC * GC);
    this.seenIds = new Set(); this.comp = { land: 0, air: 0, naval: 0, aa: 0, arty: 0, eng: 0, exp: 0 };
    this.enemyTier = 1; this.enemyAcu = null; this.firstRushT = null; this.firstT2T = null;
    this.evSeen = 0;
  }
  update() {
    const g = this.g, team = this.team, now = g.time, omni = this.ai.omni;
    const T = g.teams[team];
    for (const e of g.units) {
      if (g.allied(e.team, team) || !e.alive) continue;
      const vis = omni || !g.opts.fog || e.vis[team];
      if (!vis && !e.rad[team]) continue;
      let r = this.units.get(e.id);
      if (!r) { r = { id: e.id, e }; this.units.set(e.id, r); }
      Object.assign(r, { key: e.key, spec: e.spec, x: e.x, y: e.y, t: now, hp: e.hp, maxHp: e.maxHp, radar: !vis, layer: g.layerOf(e) });
      if (vis && !this.seenIds.has(e.id)) {
        this.seenIds.add(e.id);
        const s = e.spec, c = this.comp;
        if (s.cat === 'air') c.air++; else if (s.cat === 'naval') c.naval++; else if (s.role !== 'cmd') c.land++;
        if (s.role === 'aa' || s.role === 'fighter') c.aa++;
        if (s.role === 'arty') c.arty++;
        if (s.role === 'eng') c.eng++;
        if (s.role === 'exp') { c.exp++; this.ai.say('РАЗВЕДКА', `Обнаружен ЭКСПЕРИМЕНТАЛ противника: ${s.name}!`, 'alert'); }
        if (s.tier > this.enemyTier && s.tier < 4) {
          this.enemyTier = s.tier; if (s.tier === 2 && !this.firstT2T) this.firstT2T = now;
          this.ai.say('РАЗВЕДКА', `Противник вышел на уровень ${s.tier === 2 ? 'Т2' : 'Т3'} (замечен ${s.name})`);
        }
      }
      if (e.key === 'acu' && vis) this.enemyAcu = { x: e.x, y: e.y, hp: e.hp / e.maxHp, t: now, e };
      if (s_isCombat(e) && !this.firstRushT && dist(e, this.ai.base) < 260) {
        this.firstRushT = now;
        this.ai.say('РАЗВЕДКА', `Первый контакт у нашей базы на ${fmtT(now)}`, 'alert');
      }
    }
    for (const s of g.structs) {
      if (g.allied(s.team, team) || !s.alive) continue;
      if (!(omni || !g.opts.fog || s.vis[team] || s.seen[team])) continue;
      let r = this.structs.get(s.id);
      if (!r) {
        r = { id: s.id, e: s, key: s.key, spec: s.spec, x: s.x, y: s.y, t: now, hp: s.hp, maxHp: s.maxHp, built: s.built }; this.structs.set(s.id, r);
        if (s.spec.tier > this.enemyTier && s.spec.tier < 4) this.enemyTier = s.spec.tier;
      }
      if (s.vis[team] || omni || !g.opts.fog) Object.assign(r, { key: s.key, spec: s.spec, x: s.x, y: s.y, t: now, hp: s.hp, maxHp: s.maxHp, built: s.built });
    }
    // Forget what we can now see is gone.
    const visGrid = T.vis;
    const cellVis = (x, y) => omni || !g.opts.fog || visGrid[Math.min(PN - 1, (y / PCELL) | 0) * PN + Math.min(PN - 1, (x / PCELL) | 0)];
    for (const [id, r] of this.units) {
      if (now - r.t > 60 || !r.e.alive && cellVis(r.x, r.y) || (now - r.t > 1 && cellVis(r.x, r.y))) this.units.delete(id);
    }
    for (const [id, r] of this.structs) if (!r.e.alive && cellVis(r.x, r.y)) this.structs.delete(id);
    if (this.enemyAcu && (!this.enemyAcu.e.alive || now - this.enemyAcu.t > 90)) this.enemyAcu = null;

    // Loss / kill heat from events.
    const ev = g.events;
    for (; this.evSeen < ev.length; this.evSeen++) {
      const e = ev[this.evSeen];
      if (e.type !== 'death') continue;
      const ci = this.ci(e.x, e.y);
      if (e.team === team) this.loss[ci] += e.cost || 20; else if (e.killer === team) this.kill[ci] += e.cost || 20;
    }
    for (let i = 0; i < this.loss.length; i++) { this.loss[i] *= 0.994; this.kill[i] *= 0.994; }

    // Threat maps.
    this.thrLand.fill(0); this.thrAir.fill(0); this.thrNaval.fill(0); this.value.fill(0);
    for (const r of this.units.values()) {
      const w = Math.exp(-(now - r.t) / 40);
      this.stampThreat(r, w, 40);
    }
    for (const r of this.structs.values()) {
      if (r.built === false) continue;
      this.stampThreat(r, 1, 6);
      this.value[this.ci(r.x, r.y)] += (r.spec.costM || 50);
    }
  }
  ci(x, y) { return clamp((y / GS) | 0, 0, GC - 1) * GC + clamp((x / GS) | 0, 0, GC - 1); }
  stampThreat(r, w, extra) {
    const s = r.spec, hp = Math.max(1, r.hp || s.hp);
    const pl = Math.sqrt(s.dpsGround * hp) * w, pa = Math.sqrt(s.dpsAir * hp) * w, pn = Math.sqrt(Math.max(s.dpsNaval, s.dpsGround * 0.7) * hp) * w;
    if (pl + pa + pn < 0.5) return;
    const R = (s.maxRange || 0) + extra;
    const cr = Math.ceil(R / GS), cx = (r.x / GS) | 0, cy = (r.y / GS) | 0;
    for (let j = -cr; j <= cr; j++) for (let i = -cr; i <= cr; i++) {
      const x = cx + i, y = cy + j; if (x < 0 || y < 0 || x >= GC || y >= GC) continue;
      if (hyp((x + 0.5) * GS - r.x, (y + 0.5) * GS - r.y) > R + GS * 0.7) continue;
      const k = y * GC + x;
      this.thrLand[k] += pl; this.thrAir[k] += pa; this.thrNaval[k] += pn;
    }
  }
  threatAt(layer, x, y, r = 0) {
    const grid = layer === 'air' ? this.thrAir : layer === 'naval' || layer === 'sub' ? this.thrNaval : this.thrLand;
    const cr = Math.ceil(r / GS), cx = (x / GS) | 0, cy = (y / GS) | 0;
    let m = 0;
    for (let j = -cr; j <= cr; j++) for (let i = -cr; i <= cr; i++) {
      const xx = cx + i, yy = cy + j; if (xx < 0 || yy < 0 || xx >= GC || yy >= GC) continue;
      m = Math.max(m, grid[yy * GC + xx]);
    }
    return m;
  }
  // Sum of fresh enemy unit power near a point (optionally only those that can hit `layer`).
  powerNear(x, y, r, layer, maxAge = 15) {
    let p = 0; const now = this.g.time;
    for (const u of this.units.values()) {
      if (now - u.t > maxAge || hyp(u.x - x, u.y - y) > r) continue;
      const s = u.spec;
      const d = layer === 'air' ? s.dpsAir : layer === 'naval' ? Math.max(s.dpsNaval, s.dpsGround) : layer === 'land' ? s.dpsGround : s.dps;
      p += Math.sqrt(d * Math.max(1, u.hp));
    }
    for (const st of this.structs.values()) {
      if (hyp(st.x - x, st.y - y) > r + (st.spec.maxRange || 0) * 0.5 || !st.spec.dps) continue;
      const s = st.spec;
      const d = layer === 'air' ? s.dpsAir : layer === 'naval' ? Math.max(s.dpsNaval, s.dpsGround) : layer === 'land' ? s.dpsGround : s.dps;
      p += Math.sqrt(d * Math.max(1, st.hp || s.hp));
    }
    return p;
  }
  totalPower(filter) {
    let p = 0; const now = this.g.time;
    for (const u of this.units.values()) if (now - u.t < 120 && (!filter || filter(u.spec))) p += Math.sqrt(u.spec.dps * Math.max(1, u.hp)) * Math.exp(-(now - u.t) / 120);
    return p;
  }
  clusters(maxAge, near, rad) {
    const now = this.g.time, list = [];
    for (const u of this.units.values()) if (now - u.t <= maxAge && u.spec.dps > 0 && (!near || near(u))) list.push(u);
    const out = [];
    for (const u of list) {
      if (u._c === now) continue;
      const c = { x: 0, y: 0, n: 0, pow: 0, air: 0, members: [] };
      for (const v of list) if (v._c !== now && hyp(v.x - u.x, v.y - u.y) < rad) {
        v._c = now; c.x += v.x; c.y += v.y; c.n++; c.pow += Math.sqrt(v.spec.dps * Math.max(1, v.hp)); if (v.spec.move === 'air') c.air++; c.members.push(v);
      }
      c.x /= c.n; c.y /= c.n; out.push(c);
    }
    return out.sort((a, b) => b.pow - a.pow);
  }
}
const s_isCombat = (e) => e.spec.dps > 0 && e.spec.role !== 'cmd';

// ------------------------------------------------------------------ COMMANDER
export class AICommander {
  constructor(g, team, opts = {}) {
    this.g = g; this.team = team; this.T = g.teams[team];
    this.diff = opts.difficulty || 'normal';
    this.doctrine = opts.doctrine || 'adaptive';
    this.name = opts.name || `ИИ-${team}`;
    this.omni = this.diff === 'nightmare';
    this.logs = [];
    this.base = { ...this.T.start };
    this.enemyTeam = 0; this.pickEnemy();
    this.intel = new Intel(this);
    this.ltm = loadLTM();
    this.platoons = []; this.pid = 1;
    this.reserved = [];
    this.intents = {}; for (const it of INTENTS) this.intents[it.key] = { h: 0, f: 0 };
    this.mod = { aa: 0, def: 0 };
    this.enemyNukes = 0; this.evI = 0; this.salvo = null;
    this.lastBaseAttackT = -999; this.baseThreat = 0; this.acuState = 'Строительство';
    this.stratHistory = [];
    this.macroIdx = 0; this.macro = macroOf(0); this.macroT = 0; this.nextMacroT = 120; this.macroInfo = null;   // strategic model: js/stratnet.js
    this.useStrat = !AIP.nostrat && (opts.strategy === true || !!AIP.strat);   // strategic model OFF by default (round-1 eval 48% < 55%): enable with opts.strategy=true or aivs --params={"strat":1}
    this.macroHook = opts.macroHook || null;   // hook: self-play data generator (ml/gen_selfplay.mjs)
    // сложность «Нейросеть»: универсальный командир (js/unet.js + js/ustate.js, модель ml/models/universal_v1.json) раз в 30 с выбирает
    // бюджет, юниты, постройку, цели родов войск и особое действие; исполняет обычный ИИ. Нет файла модели — ИИ играет сам.
    this.cmd = opts.neural && hasUniversalNet() ? new UCommander(this) : null;
    this.finalized = false;
    this.phase = 'Ранняя игра';
    this.reaim();
    this.navalOk = !!g.map.naval;
    this.navalStaging = this.navalOk ? this.findWaterNear(this.base, 360 * KM) : null;
    this.initialStrategy = this.chooseStrategy();
    this.strategyKey = this.initialStrategy;
    this.applyProfile();
    this.say('СТРАТЕГИЯ', `Командование принято. Стратегия: «${this.S.name}» — ${this.S.desc}.`);
    if (!isFinite(this.landReach)) this.say('РАЗВЕДКА', 'Нет сухопутного пути к противнику — ставка на авиацию и флот.');
  }
  get S() { return STRATEGIES[this.strategyKey]; }
  // Главный противник — ближайший по стартовой точке из живых не-союзников; когда он выбывает, берём следующего (dir, сборные пункты и путь пересчитываются).
  pickEnemy() {
    const g = this.g; let best = null, bd = 1e9;
    for (const e of g.enemies(this.team)) {
      if (!e.alive) continue;
      const d = hyp(e.start.x - this.base.x, e.start.y - this.base.y);
      if (d < bd) { bd = d; best = e; }
    }
    if (!best && this.enemyTeam) return false;
    const was = this.enemyTeam;
    this.enemyTeam = best ? best.id : 0;
    this.enemyStart = best ? { ...best.start } : { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
    const dx = this.enemyStart.x - this.base.x, dy = this.enemyStart.y - this.base.y, l = hyp(dx, dy) || 1;
    this.dir = { x: dx / l, y: dy / l };
    return this.enemyTeam !== was;
  }
  reaim() {
    const t = this.g.terrain;
    this.landReach = t.pathDist('land', this.base.x, this.base.y, this.enemyStart.x, this.enemyStart.y);
    if (this.landReach === null) this.landReach = 1000 * KM;
    this.staging = this.findPassableNear('land', this.base.x + this.dir.x * 130, this.base.y + this.dir.y * 130);
    this.airStaging = { x: this.base.x + this.dir.x * 70, y: this.base.y + this.dir.y * 70 };
  }
  // Unit limit reached (or nearly): production is frozen by the sim, so waiting for a bigger army is pointless.
  get capFull() { return this.T.unitCount >= this.g.unitCap * 0.92; }

  say(cat, text, level = 'info') {
    const last = this.logs[0];
    if (last && last.text === text && this.g.time - last.t < 20) return;
    this.logs.unshift({ t: this.g.time, cat, text, level });
    if (this.logs.length > 120) this.logs.pop();

  }

  // ---------------------------------------------------------------- strategy selection (LTM bandit)
  chooseStrategy() {
    const mapId = this.g.map.id, mem = this.ltm.maps[mapId] || { strats: {} };
    const cands = Object.keys(STRATEGIES).filter(k => !STRATEGIES[k].needsNaval || this.g.map.naval);
    if (this.doctrine !== 'adaptive' && STRATEGIES[this.doctrine]) {
      this.say('ПАМЯТЬ', `Доктрина задана вручную: «${STRATEGIES[this.doctrine].name}».`);
      return this.doctrine;
    }
    if (!isFinite(this.landReach)) { cands.splice(cands.indexOf('land_rush'), 1); }
    const N = cands.reduce((a, k) => a + (mem.strats[k]?.n || 0), 0);
    const ocean = { naval: 0.4, air_dom: 0.15, balanced: 0.05 }, prior = { archipelago: ocean, gen_ocean: ocean, dualgap: { land_rush: 0.15, balanced: 0.1, turtle: 0.05 }, seton: { naval: 0.2, air_dom: 0.1, balanced: 0.05 }, astro: { air_dom: 0.1, eco_tech: 0.1, land_rush: 0.05 } }[mapId] || {};
    const p = this.ltm.profile;
    let best = null, bs = -1e9; const lines = [];
    for (const k of cands) {
      const st = mem.strats[k] || { n: 0, w: 0 };
      let sc = st.n ? st.w / st.n + Math.sqrt(2 * Math.log(N + 1) / st.n) : 1.4 + Math.random() * 0.3;
      sc += prior[k] || 0;
      if (p.n > 0) {
        if (p.air > 0.35 && k === 'air_dom') sc += 0.12;
        if (p.rushT < 240 && k === 'turtle') sc += 0.15;
        if (p.rushT < 240 && k === 'eco_tech') sc -= 0.1;
        if (p.naval > 0.3 && k === 'naval') sc += 0.1;
      }
      if (this.diff === 'easy') sc = Math.random();
      if (st.n) lines.push(`${STRATEGIES[k].name}: ${st.w}/${st.n} побед`);
      if (sc > bs) { bs = sc; best = k; }
    }
    if (N > 0) this.say('ПАМЯТЬ', `Опыт на карте «${this.g.map.name}» (${N} матчей): ${lines.join('; ')}. Выбор UCB1 → «${STRATEGIES[best].name}».`);
    else this.say('ПАМЯТЬ', `На карте «${this.g.map.name}» опыта нет — исследую стратегию «${STRATEGIES[best].name}».`);
    return best;
  }
  applyProfile() {
    const p = this.ltm.profile;
    if (p.n < 1) return;
    if (p.air > 0.33) { this.mod.aa = 0.35; this.say('ПАМЯТЬ', `Профиль противника: авиация ${Math.round(p.air * 100)}% армии — заранее усиливаю ПВО.`); }
    if (p.rushT < 260) { this.mod.def = 0.3; this.say('ПАМЯТЬ', `Противник обычно атакует рано (~${fmtT(p.rushT)}) — держу гарнизон и ставлю турели.`); }
    if (p.naval > 0.3 && this.g.map.naval) this.say('ПАМЯТЬ', 'Противник любит флот — готовлю торпедную оборону.');
  }

  // ---------------------------------------------------------------- main update
  update() {
    const g = this.g;
    if (g.over) { this.finalize(); return; }
    if (!this.T.alive) return;
    if (!this.myUnits) this.snapshot();   // после загрузки сохранения review/military могут прийти раньше первого снимка
    if (this.enemyTeam && !g.teams[this.enemyTeam].alive && this.pickEnemy()) this.reaim();
    const period = this.diff === 'easy' ? 45 : this.diff === 'normal' ? 30 : 20;
    const k = g.tick + this.team * 7;
    if (k % 15 === 0) this.intel.update();
    if (k % period === 0) { this.snapshot(); this.economy(); this.engineers(); this.factories(); this.silos(); }
    if ((k + (period >> 1)) % period === 0) { this.snapshot(); this.military(); this.acu(); }
    if (k % 150 === 3) { this.review(); this.decideMacro(); }
    if (this.cmd && k % 30 === 11 && this.cmd.due(this.g.time)) { this.snapshot(); this.cmd.decide(0); }   // раз в 30 с или по событию
  }

  snapshot() {
    const g = this.g, team = this.team;
    this.myUnits = g.units.filter(u => u.team === team && u.alive);
    this.myStructs = g.structs.filter(s => s.team === team && s.alive);
    this.byId = new Map(this.myUnits.map(u => [u.id, u]));
    this.acuU = this.T.acu && this.T.acu.alive ? this.T.acu : null;
    const facs = this.myStructs.filter(s => s.spec.produces && s.built);
    if (facs.length) { let x = 0, y = 0; for (const f of facs) { x += f.x; y += f.y; } this.base = { x: x / facs.length, y: y / facs.length }; }
    this.tier = Math.max(1, ...this.myStructs.filter(s => s.spec.produces && s.built).map(s => s.spec.tier));
    this.reserved = this.reserved.filter(r => r.until > g.time);
  }

  // ---------------------------------------------------------------- helpers
  findPassableNear(domain, x, y) {
    const t = this.g.terrain;
    for (let r = 0; r < 200; r += 8) for (let a = 0; a < 6.28; a += r ? 8 / r : 7) {
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (t.passableAt(domain, px, py)) return { x: px, y: py };
    }
    return { x, y };
  }
  findWaterNear(p, maxR) {
    const t = this.g.terrain; let best = null, bd = 1e9;
    for (let y = 16; y < MAP_SIZE; y += 16) for (let x = 16; x < MAP_SIZE; x += 16) {
      if (!t.passableAt('naval', x, y)) continue;
      const d = hyp(x - p.x, y - p.y); if (d < bd && d < maxR) { bd = d; best = { x, y }; }
    }
    return best;
  }
  findFlankWaypoint(from, to, layer = 'land', maxThreat = 40) {
    const I = this.intel, g = this.g, T = g.terrain;
    const dx = to.x - from.x, dy = to.y - from.y, d = hyp(dx, dy);
    if (d < 130 * KM) return null;
    let maxT = 0, worstK = 0;
    for (let k = 1; k < 5; k++) {
      const sx = from.x + dx * (k / 5), sy = from.y + dy * (k / 5);
      const thr = I.threatAt(layer, sx, sy, 35);
      if (thr > maxT) { maxT = thr; worstK = k; }
    }
    if (maxT <= maxThreat) return null;
    const nx = -dy / d, ny = dx / d;
    const hx = from.x + dx * (worstK / 5), hy = from.y + dy * (worstK / 5);
    const offsets = [70 * KM, -70 * KM, 120 * KM, -120 * KM];
    let bestWp = null, minWpThreat = maxT;
    for (const off of offsets) {
      const wx = hx + nx * off, wy = hy + ny * off;
      if (wx < 25 || wy < 25 || wx >= MAP_SIZE - 25 || wy >= MAP_SIZE - 25) continue;
      if (layer === 'land' && !T.passableAt('land', wx, wy)) continue;
      if (layer === 'naval' && !T.passableAt('naval', wx, wy)) continue;
      const wpThr = I.threatAt(layer, wx, wy, 35);
      if (wpThr < minWpThreat) {
        minWpThreat = wpThr;
        bestWp = { x: wx, y: wy };
      }
    }
    return minWpThreat < maxT * 0.7 ? bestWp : null;
  }
  isReserved(x, y, size) { return this.reserved.some(r => Math.abs(r.x - x) < (r.size + size) / 2 + 2 && Math.abs(r.y - y) < (r.size + size) / 2 + 2); }
  findSpot(key, near, maxR = 220) {
    const g = this.g, S = STRUCTS[key];
    if (S.place === 'water') {
      const t = g.terrain; let best = null, bd = 1e9;
      const R = maxR * 1.6, ya = 20 + Math.max(0, Math.ceil((near.y - R - 20) / 10)) * 10, xa = 20 + Math.max(0, Math.ceil((near.x - R - 20) / 10)) * 10;   // the same 10-unit lattice, only the part within reach of `near`
      for (let y = ya; y < Math.min(MAP_SIZE - 20, near.y + R + 1); y += 10) for (let x = xa; x < Math.min(MAP_SIZE - 20, near.x + R + 1); x += 10) {
        const d = hyp(x - near.x, y - near.y); if (d > R || d > bd) continue;
        if (!t.terrainPass('naval', x, y)) continue;
        const c = g.canPlace(this.team, key, x, y);
        if (c.ok && !this.isReserved(c.x, c.y, S.size)) { bd = d; best = c; }
      }
      return best;
    }
    const step = Math.max(6, S.size + 2);
    for (let r = 0; r <= maxR; r += step) {
      const n = r === 0 ? 1 : Math.max(6, Math.floor(2 * Math.PI * r / step));
      const off = Math.random() * 6.28;
      for (let i = 0; i < n; i++) {
        const a = off + i / n * Math.PI * 2;
        const x = near.x + Math.cos(a) * r, y = near.y + Math.sin(a) * r;
        const c = g.canPlace(this.team, key, x, y);
        if (!c.ok || this.isReserved(c.x, c.y, S.size)) continue;
        // keep factory exits clear and leave walkable lanes between buildings (touching only on purpose, see findAdjSpot)
        if (this.myStructs.some(f => f.exit && hyp(f.exit.x - c.x, f.exit.y - c.y) < S.size / 2 + 12)) continue;
        if (this.myStructs.some(o => Math.abs(o.x - c.x) < (o.spec.size + S.size) / 2 + 9 && Math.abs(o.y - c.y) < (o.spec.size + S.size) / 2 + 9)) continue;
        return c;
      }
    }
    return null;
  }
  reserve(x, y, size) { this.reserved.push({ x, y, size, until: this.g.time + 25 }); }
  // A free spot for `key` touching structure `s` (adjacency bonus).
  findAdjSpot(key, s) {
    const g = this.g, S = STRUCTS[key], h = S.size / 2, H = s.spec.size / 2;
    for (const [nx, ny] of [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => Math.random() - 0.5)) {
      const tx = -ny, ty = nx, span = Math.max(0, H - h);
      for (let a = -span; a <= span + 0.01; a += Math.max(2, S.size)) for (const push of [0, 1, 2]) {
        const x = s.x + nx * (H + h + push) + tx * a, y = s.y + ny * (H + h + push) + ty * a;
        const c = g.canPlace(this.team, key, x, y);
        if (!c.ok || this.isReserved(c.x, c.y, S.size) || !Game.adjacent({ spec: S, x: c.x, y: c.y }, s)) continue;
        if (this.myStructs.some(f => f.exit && hyp(f.exit.x - c.x, f.exit.y - c.y) < h + 12)) continue;
        return c;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- ECONOMY
  economy() {
    const g = this.g, eco = this.T.eco, t = g.time, S = this.S;
    const facs = this.myStructs.filter(s => s.spec.produces);
    // Demand estimate (per second) from factories and engineers.
    let dM = 0, dE = 0;
    for (const f of facs) if (f.built && f.queue.length) { const U = UNITS[f.queue[0]]; dM += U.costM / U.bt * f.spec.bp; dE += U.costE / U.bt * f.spec.bp; }
    const facM = dM;
    for (const u of this.myUnits) {
      const o = u.orders[0]; if (!u.spec.bp || !o || o.type !== 'build') continue;
      const B = STRUCTS[o.key]; dM += B.costM / B.bt * u.spec.bp; dE += B.costE / B.bt * u.spec.bp;
    }
    for (const s of this.myStructs) if (s.upgrading) { const U = STRUCTS[s.upgrading.to]; dM += U.costM / U.bt * (s.spec.bp || 10); dE += U.costE / U.bt * (s.spec.bp || 10); }
    this.demand = { m: dM, e: dE, eco: dM - facM };
    const airShare = facs.length ? facs.filter(f => f.spec.produces === 'air').length / facs.length : 0;
    // when mass is the bottleneck the factories and builders only run at income/demand of their nominal rate, so do their energy needs
    const afford = clamp((eco.incM + Math.max(0, eco.mass - eco.maxMass * 0.2) / 40) / Math.max(dM, 1), 0.2, 1);
    this.needE = Math.max(45 + t / 6, dE * afford * 1.1 + eco.upkeep, eco.incM * (5 + airShare * 16) + eco.upkeep) * 1.15;
    this.powerCrisis = eco.stallE && eco.energy < eco.maxEnergy * 0.1 && t > 40;
    this.phase = t < 240 ? 'Ранняя игра' : this.tier < 3 ? 'Средняя игра' : 'Поздняя игра';

    // Upgrades: mex T1->T2->T3, factories to next tech.
    const eOk = (eco.incE > this.needE * 0.9 || eco.energy > eco.maxEnergy * 0.8) && eco.energy > eco.maxEnergy * 0.3;
    // army first when we are behind: a fat economy is worthless if the base falls
    this.behind = t > 240 && this.features && this.features.ratio < 0.8;
    // mass budget for extractor upgrades: each one draws costM/bt*bp per second (T2: ~7, T3: ~10); the rest of the income is for the army
    const drawOf = (st, U) => U.costM / U.bt * (st.spec.bp || 10);
    const upDraw = this.myStructs.reduce((a, st) => a + (st.upgrading && st.spec.place === 'mex' ? drawOf(st, STRUCTS[st.upgrading.to]) : 0), 0);
    const upBudget = Math.max(7, eco.incM * (this.behind ? 0.2 : t < 900 ? 0.5 : 0.4) * this.macro.eco);
    const mexUpOk = eco.energy > eco.maxEnergy * 0.2 || eOk;
    if (upDraw < upBudget && mexUpOk && t > 100 && (eco.effM > 0.5 || !upDraw)) {
      // best payback first (T2: 540 M for +4 M/s = 135 s, T3: 2400 M for +12 M/s = 200 s), closer to the base breaks ties
      const mexes = this.myStructs.filter(s => s.built && s.spec.place === 'mex' && s.spec.upgradesTo && !s.upgrading)
        .filter(s => (s.spec.tier === 1 && eco.incM >= 6) || (s.spec.tier === 2 && eco.incM >= 26 && this.tier >= 2))
        .filter(s => this.intel.threatAt('land', s.x, s.y) < 30)
        .map(s => { const U = STRUCTS[s.spec.upgradesTo]; return { s, U, sc: U.costM / (U.mass - s.spec.mass) + dist(s, this.base) / 10 / KM }; })
        .sort((a, b) => a.sc - b.sc);
      const pick = mexes.find(m => upDraw + drawOf(m.s, m.U) < upBudget * 1.3 || !upDraw);
      if (pick) { g.upgrade(pick.s); this.say('ЭКОНОМИКА', `Улучшаю экстрактор до ${pick.U.short} (окупаемость ~${Math.round(pick.U.costM / (pick.U.mass - pick.s.spec.mass))} с)`); }
    }
    // radar grows with tech: vision wins fights
    const radar = this.myStructs.find(s => s.built && s.spec.radar && s.spec.upgradesTo && !s.upgrading);
    if (radar && this.tier > radar.spec.tier && eco.incE > this.needE && eco.energy > eco.maxEnergy * 0.5) { g.upgrade(radar); this.say('РАЗВЕДКА', `Улучшаю радар → ${STRUCTS[radar.spec.upgradesTo].name}`); }
    // floating mass: storage full for a while -> more factories / assist (see planBuilds, engineers)
    this.floatT = eco.mass > eco.maxMass * 0.7 ? (this.floatT || 0) + 1 : 0;
    const techPush = this.intents.TECH.f;
    for (const [tierNeed, when, minInc] of [[1, S.tech2 * (0.95 - techPush * 0.3), 8], [2, S.tech3 * (0.95 - techPush * 0.3), 22]]) {
      if (t < when || eco.incM < minInc) continue;
      const cands = facs.filter(f => f.built && f.spec.tier === tierNeed && !f.upgrading && f.spec.upgradesTo);
      const anyUp = facs.some(f => f.upgrading && f.spec.tier === tierNeed);
      const haveNext = facs.some(f => f.spec.tier > tierNeed);
      if (cands.length && !anyUp && (!haveNext || eco.incM > (tierNeed === 1 ? 20 : 50) * (facs.filter(f => f.spec.tier > tierNeed).length))) {
        const pref = this.preferredFactoryType();
        const f = cands.find(c => c.spec.produces === pref) || cands[0];
        g.upgrade(f);
        this.say('ТЕХНОЛОГИИ', `Улучшаю ${f.spec.name} → ${STRUCTS[f.spec.upgradesTo].name}. Доход ${eco.incM.toFixed(0)} М/с.`);
      }
    }
    this.buildTasks = this.planBuilds();
  }

  preferredFactoryType() {
    const w = this.facWeights();
    return Object.entries(w).sort((a, b) => b[1] - a[1])[0][0];
  }
  facWeights() {
    const f = { ...this.S.fac };
    if (!this.navalOk || !this.navalStaging) f.naval = 0;
    if (!isFinite(this.landReach)) { f.air += f.land * 0.6; f.land = Math.min(f.land, 1); }
    const aa = this.intents.ANTIAIR.f; f.air += aa * 1.2;
    const M = this.macro; if (M.air) f.air = Math.max(0, f.air + M.air); if (M.land) f.land = Math.max(0, f.land + M.land);   // macro AIR / LAND shift the factory mix
    if (M.naval && f.naval !== undefined && this.navalOk && this.navalStaging) f.naval = Math.max(0, f.naval + M.naval);   // командир: бюджет «Флот»
    return f;
  }

  planBuilds() {
    const g = this.g, eco = this.T.eco, t = g.time, S = this.S;
    const tasks = [];
    const facs = this.myStructs.filter(s => s.spec.produces);
    const inProg = (key) => this.myUnits.filter(u => u.orders[0]?.type === 'build' && u.orders[0].key === key).length + this.myStructs.filter(s => !s.built && s.key === key).length;
    const count = (pred) => this.myStructs.filter(pred).length;
    // factories
    const w = this.facWeights(), sw = Object.values(w).reduce((a, b) => a + b, 0) || 1;
    // factory count follows the income: an army factory eats ~0.2 M/s per build-power point, we give the army ~45% of the income
    const avgBP = facs.length ? facs.reduce((a, f) => a + f.spec.bp, 0) / facs.length : 20;
    const totalFac = clamp(Math.round(eco.incM * (this.behind ? 2.8 : 2.2) / avgBP * (S.eco > 1.2 ? 0.8 : 1)) + Math.floor(this.floatT / 8), 1, 20);
    for (const type of ['land', 'air', 'naval']) {
      if (!w[type]) continue;
      let want = Math.round(totalFac * w[type] / sw);
      if (type === 'land' && isFinite(this.landReach)) want = Math.max(1, want);
      if (type === 'air' && t > 140) want = Math.max(1, want);
      if (type === 'naval' && t > 100 && w.naval >= 1) want = Math.max(1, want);
      const have = facs.filter(f => f.spec.produces === type).length + inProg(type + '_fac');
      if (have < want && (eco.mass > 120 || have === 0)) {
        const near = type === 'naval' ? this.navalStaging : { x: this.base.x + this.dir.x * 30, y: this.base.y + this.dir.y * 30 };
        if (near) tasks.push({ key: type + '_fac', prio: facs.length === 0 ? 100 : have === 0 ? 80 : 50, near, max: Math.min(2, want - have) });
      }
    }
    // energy
    const eShort = eco.stallE || (eco.energy < eco.maxEnergy * 0.3 && t > 60) || (eco.incE < this.needE * 0.95 && !(eco.energy > eco.maxEnergy * 0.85 && eco.incE > this.needE * 0.75));
    // In a hard energy stall a T2/T3 generator (12k-57k energy) would never finish: spam cheap T1 plants instead.
    const hardStall = eco.stallE && eco.energy < eco.maxEnergy * 0.25;
    const genKey = hardStall ? 'pgen' : this.tier >= 3 && this.hasEng(3) && this.needE - eco.incE > 700 ? 'pgen3' : this.tier >= 2 && this.hasEng(2) && this.needE - eco.incE > 150 ? 'pgen2' : 'pgen';
    if (eShort) {
      const gap = this.needE - eco.incE;
      const n = genKey === 'pgen' ? clamp(Math.ceil(gap / 20), 1, hardStall ? 8 : 5) : 1;
      // generators go next to factories (adjacency: cheaper energy for everything they build)
      const fac = facs.filter(f => f.built && f.spec.produces !== 'naval').sort((a, b) => b.spec.tier - a.spec.tier || dist(a, this.base) - dist(b, this.base))[0];
      if (inProg(genKey) < n) tasks.push({ key: genKey, prio: eco.stallE || eco.energy < eco.maxEnergy * 0.6 && eco.incE < this.needE ? 97 : eco.incE < this.needE * 0.8 ? 90 : 72, near: { x: this.base.x - this.dir.x * 40, y: this.base.y - this.dir.y * 40 }, adj: genKey !== 'pgen3' ? fac : null, max: n - inProg(genKey) + (genKey !== 'pgen' ? 2 : 0) });
    }
    // mass fabricators when energy is plentiful (T2/T3)
    const eSurplus = eco.incE - eco.upkeep - this.needE;
    const fabKey = this.tier >= 3 && this.hasEng(3) && eSurplus > 1700 ? 'mfab3' : this.hasEng(2) && eSurplus > 200 ? 'mfab' : null;
    if (fabKey && !this.behind && !eco.stallE && eco.energy > eco.maxEnergy * 0.6 && inProg(fabKey) < 1) {
      const gen = this.myStructs.filter(s => s.built && s.spec.energy >= 500)[0];
      tasks.push({ key: fabKey, prio: 48, near: gen || this.base, max: 1 });
    }
    // mass storages hugging T3 extractors (+12.5% each = +2.25 M/s for 200 M; next to a T2 one it pays back in 4+ minutes, a T1 one never)
    if (!this.behind && !eco.stallM && count(s => s.key === 'mstore') + inProg('mstore') < 40) {
      const mx = this.myStructs.filter(s => s.built && s.spec.place === 'mex' && s.spec.tier >= 3 && (s.adj?.n.length || 0) < 4 && this.intel.threatAt('land', s.x, s.y) < 20)
        .sort((a, b) => b.spec.tier - a.spec.tier || dist(a, this.base) - dist(b, this.base))[0];
      if (mx) tasks.push({ key: 'mstore', prio: 44, near: mx, adj: mx, max: 1 });
    }
    // mass extractors
    const claimed = new Set(this.myUnits.filter(u => u.orders[0]?.type === 'build' && u.orders[0].key === 'mex').map(u => u.orders[0].x + ',' + u.orders[0].y));
    for (const m of g.terrain.mass) {
      if (g.structs.some(s => s.alive && s.spec.place === 'mex' && s.x === m.x && s.y === m.y)) continue;
      if (claimed.has(m.x + ',' + m.y)) continue;
      const thr = this.intel.threatAt('land', m.x, m.y, 30);
      if (thr > 25 + this.intents.ECO.f * 20) continue;
      const dB = dist(m, this.base), dE = dist(m, this.enemyStart);
      if (dE < 170 || (dE < dB * 0.7 && t < 480)) continue; // contest the middle, not the enemy's backyard
      if (!isFinite(g.terrain.pathDist('land', m.x, m.y, this.base.x, this.base.y) ?? 0)) continue;
      tasks.push({ key: 'mex', prio: 92 - dB / (60 * KM) + (dE > dB ? 4 : -4) + this.intents.ECO.f * 4, pos: { x: m.x, y: m.y }, max: 1 });
    }
    // defenses
    const recentAttack = t - this.lastBaseAttackT < 120;
    const pdKey = this.tier >= 2 && this.hasEng(2) ? 'pd2' : 'pd';
    const pdCount = count(s => s.key === 'pd' || s.key === 'pd2');
    const wantPd = Math.floor((S.def + this.mod.def + this.intents.DEFEND.f) * 3 + (recentAttack ? 2 : 0) + (S.arty && t > 400 ? 2 : 0));
    if (pdCount + inProg(pdKey) < wantPd && t > 150 && eco.mass > 100) {
      const toward = this.lastAttackPos || { x: this.base.x + this.dir.x * 80, y: this.base.y + this.dir.y * 80 };
      tasks.push({ key: pdKey, prio: recentAttack ? 60 : 38, near: { x: (this.base.x + toward.x) / 2, y: (this.base.y + toward.y) / 2 }, max: 1 });
    }
    const enemyAir = this.intel.totalPower(s => s.move === 'air' && s.role !== 'scout');
    const aaKey = this.tier >= 2 && this.hasEng(2) ? 'flak2' : 'aa_turret';
    const aaCount = count(s => s.key === 'aa_turret' || s.key === 'flak2');
    const strikeAir = this.intel.comp.air > 0 && [...this.intel.units.values()].some(u => u.spec.role === 'gunship' || u.spec.role === 'bomber');
    const wantAA = Math.floor(this.intents.ANTIAIR.f * 4 + this.mod.aa * 3 + (enemyAir > 200 ? 2 : 0) + (strikeAir ? 2 : 0));
    if (aaCount + inProg(aaKey) < wantAA && eco.mass > 80) tasks.push({ key: aaKey, prio: 58, near: { x: this.base.x + (Math.random() - 0.5) * 80, y: this.base.y + (Math.random() - 0.5) * 80 }, max: 1 });
    if (this.navalOk && this.intel.comp.naval > 2 && count(s => s.key === 'torp') + inProg('torp') < 3 && this.navalStaging) tasks.push({ key: 'torp', prio: 45, near: this.navalStaging, max: 1 });
    // radar (upgraded in economy()), sonar on water maps
    if (t > 150 && count(s => s.spec.radar && s.spec.place === 'land') + inProg('radar') < 1) tasks.push({ key: 'radar', prio: 32, near: { x: this.base.x + this.dir.x * 50, y: this.base.y + this.dir.y * 50 }, max: 1 });
    if (this.navalOk && this.navalStaging && t > 300 && count(s => s.key === 'sonar') + inProg('sonar') < 1 && (this.intel.comp.naval > 0 || this.S.fac.naval)) tasks.push({ key: 'sonar', prio: 30, near: this.navalStaging, max: 1 });
    // T2 extras: shields, artillery
    if (this.hasEng(2)) {
      const threatArty = this.intel.comp.arty + (this.intel.comp.air > 5 ? 3 : 0);
      const wantSh = clamp(Math.floor((threatArty > 3 ? 1 : 0) + (S.def > 0.5 ? 1 : 0) + eco.incM / 40), 0, 4);
      if (eco.incE > 700 && count(s => s.spec.shield) + inProg('shield') < wantSh) tasks.push({ key: 'shield', prio: 46, near: this.base, max: 1 });
      if ((S.arty || t > 900) && eco.incM > 22 && count(s => s.key === 'arty2') + inProg('arty2') < (S.arty ? 3 : 1)) tasks.push({ key: 'arty2', prio: 40, near: { x: this.base.x + this.dir.x * 60, y: this.base.y + this.dir.y * 60 }, max: 2 });
    }
    this.planMissiles(tasks, inProg, count);
    // storages for overflow
    if (eco.mass > eco.maxMass * 0.95 && !eco.stallE && eco.incM > 12 && count(s => s.key === 'mstore') < 3) tasks.push({ key: 'mstore', prio: 22, near: this.base, max: 1 });
    // battlefield salvage: reclaim rich wreck clusters when mass is needed
    if (eco.mass < eco.maxMass * 0.9 && g.wrecks.length > 0) {
      const rich = g.wrecks.filter(w => w.alive && (w.mass || 0) >= 50 && this.intel.threatAt('land', w.x, w.y, 40) < 15 && dist(w, this.base) < 450 * KM);
      if (rich.length) {
        const bw = rich.sort((a, b) => (b.mass || 0) - (a.mass || 0) || dist(a, this.base) - dist(b, this.base))[0];
        tasks.push({ key: 'salvage', prio: eco.stallM ? 76 : 53, isReclaim: true, site: bw, near: bw, max: 2 });
      }
    }
    // experimental: pick the one that counters what we know about the enemy
    const cmdExp = this.cmd && this.cmd.expKey();
    if (cmdExp && !this.myStructs.some(s => !s.built && s.spec.role === 'exp')) this.expKey = cmdExp;   // командир выбрал экспериментал
    if (this.hasEng(3) && (cmdExp || eco.incM > this.macro.expInc && this.intents.EXPERIMENTAL.f > 0.35) && this.myUnits.filter(u => u.spec.role === 'exp').length < 3 + Math.floor(eco.incM / 250)) {
      const building = this.myStructs.find(s => !s.built && s.spec.spawnsUnit);
      if (building) { this.expKey = null; tasks.push({ key: building.key, prio: 64, site: building, near: building, max: 8 }); }
      else tasks.push({ key: this.expKey || (this.expKey = this.pickExperimental()), prio: 62, near: STRUCTS[this.expKey].place === 'water' ? this.navalStaging : { x: this.base.x + this.dir.x * 60, y: this.base.y + this.dir.y * 60 }, max: 1 });
    } else this.expKey = null;
    // unfinished constructions (abandoned or big) get helpers
    for (const s of this.myStructs) {
      if (s.built || tasks.some(tk => tk.site === s)) continue;
      const big = s.spec.bt >= 1400;
      if (!big && this.myUnits.some(u => u.orders[0] && (u.orders[0].site === s || u.orders[0].target === s))) continue;
      tasks.push({ key: s.key, prio: big ? 55 : 70, site: s, near: s, max: big ? 4 : 1 });
    }
    // ИИ-командир: выбранная моделью постройка (оборона, щиты, ПРО, ядерка, TML, арта, радары) — по одной за раз, если есть на что
    const ct = this.cmd && this.cmd.structTask();
    if (ct && STRUCTS[ct.key] && inProg(ct.key) < 1 && (eco.mass > Math.min(400, STRUCTS[ct.key].costM * 0.25) || this.macro.army < 1)) tasks.push({ key: ct.key, prio: 66, near: ct.near, max: 2 });
    return tasks.sort((a, b) => b.prio - a.prio);
  }
  // ---------------------------------------------------------------- MISSILE SYSTEMS (SML / SMD / TML / TMD)
  // Centre of our valuable buildings: where interceptors and missile defence should stand.
  valueCenter() {
    const v = this.myStructs.filter(s => s.built && (s.spec.costM >= 1200 || s.silo));
    if (!v.length) return this.base;
    let x = 0, y = 0; for (const s of v) { x += s.x; y += s.y; }
    return { x: x / v.length, y: y / v.length };
  }
  planMissiles(tasks, inProg, count) {
    const g = this.g, eco = this.T.eco, t = g.time, I = this.intel;
    const seen = (pred) => [...I.structs.values()].filter(pred);
    const enemySml = seen(r => r.key === 'sml').length;
    const enemyTml = seen(r => r.key === 'tml').length;
    const enemyMml = [...I.units.values()].filter(r => r.key === 'mml').length;
    const healthy = !eco.stallE && !eco.stallM && !this.behind && !this.powerCrisis;
    // TMD next to what a missile strike would hurt: when the enemy has TML or a herd of MML
    if (this.hasEng(2) && (enemyTml > 0 || enemyMml >= 5) && eco.mass > 150) {
      const want = clamp(1 + (enemyTml > 1 || enemyMml >= 10 ? 1 : 0) + (eco.incM > 40 ? 1 : 0), 1, 3);
      if (count(s => s.key === 'tmd') + inProg('tmd') < want) tasks.push({ key: 'tmd', prio: enemyTml ? 57 : 43, near: this.valueCenter(), max: 1 });
    }
    if (!this.hasEng(3)) {
      // tactical missiles against the enemy's guns, from a site inside range of the nearest defence
      this.planTML(tasks, inProg, count, healthy);
      return;
    }
    // anti-nuke: as soon as the enemy has a silo (or fired), and as insurance late in a rich game
    const nukeThreat = enemySml > 0 || this.enemyNukes > 0;
    const insurance = t > 1000 && I.enemyTier >= 3 && eco.incM > 55 && healthy;
    if (nukeThreat || insurance) {
      const want = nukeThreat ? clamp(1 + (enemySml > 1 || this.enemyNukes > 1 ? 1 : 0), 1, 2) : 1;
      if (count(s => s.key === 'smd') + inProg('smd') < want && eco.mass > 250) tasks.push({ key: 'smd', prio: nukeThreat ? 69 : 41, near: this.valueCenter(), max: 1 });
    }
    // our own nuclear silo: late game, strong economy, not under pressure
    const M = this.macro, wantSml = clamp(1 + Math.floor(eco.incM / 150) + M.silo, 1, 5);   // a nuke wipes a 100-unit disk of a 2048 map: floating mass belongs in silos
    if (t > (M.silo ? 500 : 780) && this.tier >= 3 && !eco.stallE && !this.behind && !this.powerCrisis && eco.incM > (M.silo ? 30 : 45) && eco.incE > (M.silo ? 1800 : 2600) && count(s => s.key === 'sml') + inProg('sml') < wantSml
        && this.baseThreat < 250 && (this.intents.EXPERIMENTAL.f < 0.8 || M.silo)) {
      tasks.push({ key: 'sml', prio: 47, near: { x: this.base.x - this.dir.x * 55, y: this.base.y - this.dir.y * 55 }, max: 1 });
    }
    this.planTML(tasks, inProg, count, healthy);
  }
  planTML(tasks, inProg, count, healthy) {
    const eco = this.T.eco, t = this.g.time;
    if (!this.hasEng(2) || t < 420 || !healthy || eco.incM < 16) return;
    const have = count(s => s.key === 'tml') + inProg('tml');
    if (have >= (eco.incM > 40 ? 3 : 2)) return;
    // nearest known enemy gun we could reach from a spot close to our base
    let tg = null, td = 1e9;
    for (const r of this.intel.structs.values()) {
      if (r.built === false || !(r.spec.dps > 0) || r.spec.place === 'water') continue;
      const d = dist(r, this.base);
      if (d < td) { td = d; tg = r; }
    }
    if (!tg || td > 470) return;
    const site = { x: tg.x + (this.base.x - tg.x) / (td || 1) * Math.min(215, td - 60), y: tg.y + (this.base.y - tg.y) / (td || 1) * Math.min(215, td - 60) };
    if (dist(site, this.base) > 230 || this.intel.threatAt('land', site.x, site.y, 40) > 25) return;
    tasks.push({ key: 'tml', prio: 42, near: site, maxR: 55, max: 1 });
  }
  scanEvents() {
    const ev = this.g.events;
    for (; (this.evI || 0) < ev.length; this.evI = (this.evI || 0) + 1) {
      const e = ev[this.evI || 0];
      if (e.type === 'nukeLaunch' && this.g.isEnemy(e.team, this.team)) {
        this.enemyNukes = (this.enemyNukes || 0) + 1;
        this.say('РАЗВЕДКА', `Обнаружен запуск ядерной ракеты противника, цель (${Math.round(e.x)}, ${Math.round(e.y)})!`, 'alert');
      }
    }
  }
  // Runs every AI tick: keeps silos fed, fires our missiles.
  silos() {
    const g = this.g, eco = this.T.eco;
    this.scanEvents();
    const mine = this.myStructs.filter(s => s.silo && s.built);
    if (!mine.length) return;
    const enemyNuke = this.enemyNukes > 0 || [...this.intel.structs.values()].some(r => r.key === 'sml');
    // a starving economy comes first; interceptors are the exception once the enemy has a silo
    const starving = this.powerCrisis || eco.effM < 0.6;
    for (const s of mine) s.paused = starving && !(s.spec.silo.kind === 'anti' && enemyNuke);
    const now = g.time;
    // ---- strategic strike
    const nukes = mine.filter(s => s.spec.silo.kind === 'nuke');
    const ready = nukes.filter(s => s.silo.stock > 0 && !s.launch);
    const total = nukes.reduce((a, s) => a + s.silo.stock, 0);
    if (this.salvo && (this.salvo.left <= 0 || now - this.salvo.t > 90)) this.salvo = null;
    if (ready.length && (this.salvo || now - (this.lastNukeT || -99) > 20)) {
      const full = nukes.every(s => s.silo.stock >= s.spec.silo.max);
      const tgt = this.salvo || this.acuNukeTarget(total) || this.pickNukeTarget(total, full);
      if (tgt) {
        const r = g.orderLaunch(ready, tgt.x, tgt.y);
        if (r.n) {
          if (!this.salvo) {
            const need = tgt.defended ? Math.min(total, tgt.defended * 2 + 1) : 1;
            this.salvo = { x: tgt.x, y: tgt.y, left: need, t: now };
            this.say('ВОЙСКА', `ЯДЕРНЫЙ УДАР по (${Math.round(tgt.x)}, ${Math.round(tgt.y)}): ценность ~${Math.round(tgt.value)} М${tgt.defended ? `, цель прикрыта ${tgt.defended} SMD — залп ${need} ракет` : ''}.`, 'alert');
          }
          this.salvo.left -= r.n; this.lastNukeT = now;
        }
      }
    }
    // ---- tactical strikes on remembered guns (visible ones are engaged by the launcher itself)
    for (const s of mine) {
      if (s.spec.silo.kind !== 'tac' || s.silo.stock < 1 || s.silo.cd > 0) continue;
      const w = s.spec.weapons[0];
      let best = null, bs = 0;
      for (const r of this.intel.structs.values()) {
        if (r.built === false) continue;
        const d = dist(r, s);
        if (d > w.range - 6 || d < w.minRange + 4) continue;
        let sc = (r.spec.dps > 0 ? 1000 : 0) + r.spec.costM;
        if (r.spec.place === 'water') sc *= 0.4;
        if (sc > bs) { bs = sc; best = r; }
      }
      if (!best) { s._salvo = false; continue; }
      const tmd = [...this.intel.structs.values()].filter(r => r.key === 'tmd' && dist(r, best) < 55).length;
      if (tmd && !s._salvo && s.silo.stock < s.spec.silo.max) continue;   // wait for a full magazine against missile defence
      s._salvo = tmd > 0 && s.silo.stock > 1;
      const vis = best.e && best.e.alive && best.e.vis[this.team];
      if (g.orderLaunch([s], best.x, best.y, vis ? best.e : null).n) this.say('ВОЙСКА', `TML: ракета по ${best.spec.name} (${Math.round(best.x)}, ${Math.round(best.y)})${tmd ? `, прикрыто ${tmd} TMD` : ''}`);
    }
  }
  // The enemy commander (seen or on radar in the last 40 s): a nuke within 200 units takes 75% of its HP, within 100 it is dead — and that ends the game.
  acuNukeTarget(total) {
    const g = this.g, sp = STRUCTS.sml.silo, r = [...this.intel.units.values()].find(u => u.key === 'acu' && g.time - u.t < 40);
    if (!r) return null;
    const defended = [...this.intel.structs.values()].filter(s => s.key === 'smd' && s.built !== false && dist(s, r) < STRUCTS.smd.silo.cover).length;
    if (defended && total < defended * 2 + 1) return null;
    let own = 0;
    for (const s of this.myStructs) if (dist(s, r) <= sp.zones[0]) own += s.spec.costM;
    for (const u of this.myUnits) if (dist(u, r) <= sp.zones[0]) own += u.spec.costM + (u.key === 'acu' ? 4000 : 0);
    return own > 600 ? null : { x: r.x, y: r.y, value: 9999, defended };
  }
  // Best ground zero among the enemy buildings we know about: mass the blast would destroy (zones and damage as in specs.nukeDamage),
  // never on our own stuff — the blast is huge, so our base counts as collateral too.
  pickNukeTarget(total, full) {
    const g = this.g, I = this.intel, sp = STRUCTS.sml.silo, R = sp.zones[2], cover = STRUCTS.smd.silo.cover;
    const list = [...I.structs.values()].filter(r => r.spec.place !== 'water' || r.spec.costM > 800);
    if (!list.length) return null;
    const share = (spec, d) => Math.min(1, nukeDamage(sp, spec, spec.hp, d) / spec.hp);   // share of the entity destroyed at distance d
    const smds = list.filter(r => r.key === 'smd' && r.built !== false);
    const units = [...I.units.values()].filter(r => g.time - r.t < 6 && !r.radar && r.e.alive && r.e.speed < 1);
    let best = null;
    for (const c of list) {
      let value = 0;
      for (const r of list) { const d = dist(r, c); if (d <= R) value += (r.built === false ? 0.6 : 1) * (r.spec.costM || 50) * share(r.spec, d); }
      for (const r of units) { const d = dist(r, c); if (d <= R) value += r.spec.costM * 0.7 * share(r.spec, d); }
      if (value < 2600) continue;
      // friendly fire check: the nuke does not care about colours
      let own = 0;
      for (const s of this.myStructs) { const d = dist(s, c); if (d <= R) own += s.spec.costM * share(s.spec, d); }
      for (const u of this.myUnits) { const d = dist(u, c); if (d <= R) own += (u.spec.costM + (u.key === 'acu' ? 4000 : 0)) * share(u.spec, d); }
      if (own > 250 || own > value * 0.1) continue;
      const defended = smds.filter(r => dist(r, c) < cover).length;
      if (defended && total < defended * 2 + 1) continue;      // not enough missiles to saturate the interceptors: keep building
      if (value < 5200 && !full) continue;                      // small fish: only when the magazines are full
      if (!best || value / (1 + defended * 2) > best.value / (1 + best.defended * 2)) best = { x: c.x, y: c.y, value, defended };
    }
    return best;
  }
  hasEng(tier) { return this.myUnits.some(u => (u.spec.role === 'eng' && u.spec.tier >= tier) || (u.enh && u.spec.buildTier >= tier)); }
  pickExperimental() {
    const I = this.intel, c = I.comp, tot = Math.max(1, c.land + c.air + c.naval);
    const defs = [...I.structs.values()].filter(r => r.spec.dps > 0).length;
    const aaShare = c.aa / tot;
    const sc = {
      exp_czar: 1 + (aaShare < 0.1 ? 1 : aaShare < 0.2 ? 0.4 : -0.5) + (!isFinite(this.landReach) ? 1 : 0),
      exp_fortress: 1 + Math.min(1.5, defs / 10) + (this.baseThreat > 300 ? 0.6 : 0),
      exp_spider: 1 + c.land / tot * 0.8 + (this.navalOk ? 0.3 : 0),
      exp_colossus: 1.2 + c.naval / tot
    };
    if (!isFinite(this.landReach)) { sc.exp_fortress -= 3; }
    // sea transport with rocket batteries: only with a shipyard on a naval map
    if (this.navalOk && this.navalStaging && this.myStructs.some(s => s.built && s.spec.produces === 'naval')) sc.exp_seadragon = 1 + c.naval / tot + (isFinite(this.landReach) ? 0 : 1);
    const recent = (this.expHistory = this.expHistory || []).slice(-3);
    for (const k in sc) { sc[k] -= recent.filter(x => x === k).length * 0.8; sc[k] += Math.random() * 0.6; }
    let key = Object.entries(sc).sort((a, b) => b[1] - a[1])[0][0];
    this.expHistory.push(key);
    this.say('ТЕХНОЛОГИИ', `Экспериментал: выбираю «${STRUCTS[key].name}» (ПВО врага ${Math.round(aaShare * 100)}%, оборона ${defs}, армия ${c.land})`);
    return key;
  }

  // ---------------------------------------------------------------- ENGINEERS
  engineers() {
    const g = this.g;
    const tasks = this.buildTasks || [];
    const acu = this.acuU;
    const engs = this.myUnits.filter(u => u.spec.role === 'eng');
    if (acu && this.acuState === 'Строительство' && dist(acu, this.base) < 280) engs.push(acu);
    const multiSites = new Map();
    for (const e of engs) {
      const o = e.orders[0];
      // power crisis: everyone not building power / extractors drops what they're doing (SupCom players pause everything but power)
      const drop = this.powerCrisis && o && o.type === 'build' && !STRUCTS[o.key].energy && o.key !== 'mex' && e !== acu;
      if (o && !o.auto && !o.aiHelp && !o.rally && !drop) continue;
      if (e.brain.flee) continue;
      let best = null, bs = -1e9;
      for (const tk of tasks) {
        if ((tk.assigned || 0) >= tk.max) continue;
        const S = STRUCTS[tk.key];
        if (!tk.site && !e.spec.canBuild.includes(tk.key)) continue;
        const p = tk.pos || tk.near || tk.site;
        if (!p) continue;
        const d = dist(e, p);
        if (e === acu && (d > 200 || dist(p, this.base) > 140 || this.intel.threatAt('land', p.x, p.y, 30) > 15)) continue;
        const sc = tk.prio - d / 12 - (e === acu && (S?.tier || 1) > 1 ? 50 : 0);
        if (sc > bs) { bs = sc; best = tk; }
      }
      if (best && best.isReclaim && best.site) {
        if (!(o && o.type === 'reclaim' && o.target === best.site)) g.orderReclaim([e], best.site);
        best.assigned = (best.assigned || 0) + 1;
        continue;
      }
      if (best && best.site) {
        if (!(o && o.type === 'assist' && o.target === best.site)) g.orderAssist([e], best.site);
        best.assigned = (best.assigned || 0) + 1;
        continue;
      }
      if (best) {
        let spot = best.pos ? { x: best.pos.x, y: best.pos.y, ok: true } : (best.multi && multiSites.get(best.key)) || (best.adj && this.findAdjSpot(best.key, best.adj)) || this.findSpot(best.key, best.near, best.maxR);
        if (!spot) { best.assigned = best.max; continue; }
        if (best.multi) multiSites.set(best.key, spot);
        const c = g.orderBuild([e], best.key, spot.x, spot.y);
        if (c && c.ok) {
          best.assigned = (best.assigned || 0) + 1;
          this.reserve(c.x, c.y, STRUCTS[best.key].size);
          if (best.key !== 'mex' || Math.random() < 0.3) this.say('ЭКОНОМИКА', `${e === acu ? 'ACU' : e.spec.short + ' #' + e.id}: строю ${STRUCTS[best.key].name} (приоритет ${Math.round(best.prio)})`);
        } else best.assigned = best.max;
        continue;
      }
      // No task: assist the ACU's enhancement / upgrades / big constructions / factories
      if (acu && e !== acu && acu.orders[0]?.type === 'enhance' && dist(acu, e) < 200) {
        if (!(o && o.target === acu)) { g.orderAssist([e], acu); e.orders[0].aiHelp = true; }
        continue;
      }
      const help = this.myStructs.filter(s => (!s.built && s.spec.bt > 900) || s.upgrading || (s.spec.produces && s.queue.length && s.built) || (s.silo && s.built && !s.paused && s.spec.silo.kind !== 'tac' && s.silo.stock < s.spec.silo.max))
        .sort((a, b) => (b.upgrading || !b.built ? 1 : 0) - (a.upgrading || !a.built ? 1 : 0) || dist(a, e) - dist(b, e))[0];
      if (help && dist(help, e) < (e === acu ? 150 : 300) && (e !== acu || (dist(help, this.base) < 100 && this.intel.threatAt('land', help.x, help.y, 30) < 15)) && (this.T.eco.mass > 60 || !help.built || this.T.eco.effM > 0.9) && !(o && o.aiHelp && o.target === help)) {
        g.orderAssist([e], help);
        if (e.orders[0]) e.orders[0].aiHelp = true;
        continue;
      }
      // Idle engineer battlefield salvage
      if (e !== acu && (this.T.eco.mass < this.T.eco.maxMass * 0.85 || this.T.eco.stallM) && (!o || o.aiHelp || o.auto)) {
        let bestW = null, bsW = 0;
        for (const w of g.wrecks) {
          if (!w.alive || !w.mass || w.mass < 25) continue;
          const dW = dist(w, e);
          if (dW > 320 * KM || this.intel.threatAt('land', w.x, w.y, 40) > 15) continue;
          const sc = w.mass / (1 + dW / 20);
          if (sc > bsW) { bsW = sc; bestW = w; }
        }
        if (bestW && !(o && o.type === 'reclaim' && o.target === bestW)) {
          g.orderReclaim([e], bestW);
          if (e.orders[0]) e.orders[0].aiHelp = true;
        }
      }
    }
  }

  // ---------------------------------------------------------------- FACTORIES
  factories() {
    const g = this.g, eco = this.T.eco;
    const facs = this.myStructs.filter(s => s.spec.produces && s.built && !s.upgrading);
    // Throttle: mass is shared proportionally, so extractor upgrades / power / expansion finish only if the army factories leave them
    // their share. Army factories run in preference order until their nominal draw (0.2 M/s per build-power point) fills what is left of the income.
    const threatened = this.behind || g.time - this.lastBaseAttackT < 40;
    const bank = Math.max(0, eco.mass - eco.maxMass * 0.3) / 30;
    let allowed = Math.max(eco.incM * (threatened ? 0.9 : (g.time < 600 ? 0.3 : 0.4) * this.macro.army), eco.incM + bank - (this.demand ? this.demand.eco : 0));
    if (this.macro.cap && !threatened) allowed = Math.min(allowed, eco.incM * this.macro.cap);   // macro ECON: the army gets at most this share of the income
    const w = this.facWeights(), isEng = (f) => f.queue[0] && UNITS[f.queue[0]].role === 'eng';
    const order = facs.slice().sort((a, b) => isEng(b) - isEng(a) || (w[b.spec.produces] || 0) - (w[a.spec.produces] || 0) || b.spec.tier - a.spec.tier || a.id - b.id);
    let used = 0, nPause = 0;
    for (const f of order) {
      const d = 0.2 * f.spec.bp;
      f.investPause = used > 0 && used + d * 0.5 > allowed && !isEng(f);
      if (f.investPause) nPause++; else used += d;
    }
    if (nPause && (!this._pauseLog || g.time - this._pauseLog > 60)) { this._pauseLog = g.time; this.say('ЭКОНОМИКА', `Бюджет массы: армии отведено ~${Math.round(allowed)} М/с — на паузе ${nPause} из ${facs.length} заводов ради экономики`); }
    for (const f of facs) {
      // Pause military production during a hard energy stall so power plants can finish.
      f.paused = (this.powerCrisis || f.investPause) && f.queue.length > 0 && UNITS[f.queue[0]].role !== 'eng';
      if (f.queue.length >= 2) continue;
      if (this.T.unitCount >= this.g.unitCap - 1) continue;      // at the cap the queue would only sit there: keep the mass for the economy
      if (eco.stallM && eco.mass < 20 && f.queue.length >= 1) continue;
      const key = this.pickUnit(f);
      if (key) g.queueUnit(f, key);
      const type = f.spec.produces;
      f.rally = type === 'air' ? this.airStaging : type === 'naval' ? (this.navalStaging || null) : this.staging;
    }
  }
  pickUnit(f) {
    const type = f.spec.produces, tier = f.spec.tier, eco = this.T.eco, t = this.g.time;
    const avail = PRODUCES[type].filter(k => UNITS[k].tier <= tier);
    const byRole = {};
    for (const k of avail) (byRole[UNITS[k].role] = byRole[UNITS[k].role] || []).push(k);
    const cnt = (pred) => this.myUnits.filter(u => pred(u.spec)).length;
    if (type === 'land') {
      const engs = cnt(s => s.role === 'eng');
      const wantEng = clamp(Math.round((t < 150 ? 4 : 5 + eco.incM / 4) * (this.S.eco > 1.2 ? 1.2 : 1)), 3, 20);
      const eng2 = cnt(s => s.role === 'eng' && s.tier === 2), eng3 = cnt(s => s.role === 'eng' && s.tier === 3);
      if (tier >= 3 && eng3 < 2 + Math.floor(eco.incM / 45)) return 'eng3';
      if (tier >= 2 && eng2 < 2 + Math.floor(eco.incM / 25)) return 'eng2';
      if (engs < wantEng && (this.myStructs.filter(s => s.spec.produces === 'land').indexOf(f) === 0 || engs < 3)) return 'eng1';
    }
    if (type === 'air' && cnt(s => s.role === 'scout') < (t < 400 ? 1 : 2)) return 'scout_air';
    if (this.cmd) { const ck = this.cmd.unitFor(f); if (ck) return ck; }   // ИИ-командир выбрал юнит для заводов этого рода войск
    if (type === 'air' && t > 360 && isFinite(this.landReach) && cnt(s => s.role === 'transport') < (tier >= 2 ? 2 : 1) && (this.intents.RAID.f > 0.25 || Math.random() < 0.08)) return tier >= 2 ? 'trans2' : 'trans1';
    const enemyAir = this.intel.totalPower(s => s.move === 'air' && s.role !== 'scout');
    const ourAA = this.myUnits.reduce((a, u) => a + Math.sqrt(u.spec.dpsAir * u.hp), 0);
    const aaNeed = clamp(enemyAir / (ourAA + 60) + this.mod.aa + this.intents.ANTIAIR.f * 0.5 + this.macro.aa, 0, 2);
    const w = {};
    if (type === 'land') {
      w.direct = 1.0; w.arty = 0.25 + (this.S.arty ? 0.35 : 0) + (this.intel.structs.size > 12 ? 0.25 : 0); w.aa = 0.1 + aaNeed * 0.7;
      if (t < 240 && byRole.direct) w.direct += 0.2;
    } else if (type === 'air') {
      w.fighter = 0.2 + aaNeed; w.bomber = t < 600 ? 0.6 : 0.4; w.gunship = 0.9;
    } else {
      w.naval = 1.0; w.sub = 0.35 + (this.intel.comp.naval > 3 ? 0.4 : 0);
    }
    const roles = Object.keys(w).filter(r => byRole[r]);
    if (!roles.length) return null;
    let sum = roles.reduce((a, r) => a + w[r], 0), roll = Math.random() * sum, role = roles[0];
    for (const r of roles) { roll -= w[r]; if (roll <= 0) { role = r; break; } }
    let list = byRole[role];
    if (type === 'land' && role === 'direct' && t < 200 && list.includes('lab') && Math.random() < 0.3) return 'lab';
    list = list.filter(k => k !== 'lab' || t < 300);
    if (!list.length) list = byRole[role];
    // naval special: cruisers when air threat, battleships at T3
    if (type === 'naval' && role === 'naval') {
      if (tier >= 3 && Math.random() < 0.5) return 'battleship';
      if (tier >= 2) return aaNeed > 0.6 && Math.random() < 0.6 ? 'cruiser' : 'destroyer';
    }
    list.sort((a, b) => UNITS[b].tier - UNITS[a].tier);
    return Math.random() < 0.8 ? list[0] : list[(Math.random() * list.length) | 0];
  }

  // ---------------------------------------------------------------- MILITARY
  platoonOf(type, mission) { return this.platoons.find(p => p.type === type && p.mission === mission); }
  newPlatoon(type, mission, name) {
    const p = { id: this.pid++, type, mission, name, units: [], t0: this.g.time, target: null, status: '', pow: 0, lastOrder: -99 };
    this.platoons.push(p); return p;
  }
  pUnits(p) { return p.units.map(id => this.byId.get(id)).filter(u => u && u.alive); }
  pPower(units) { return units.reduce((a, u) => a + powerOf(u), 0); }
  centroid(units) { let x = 0, y = 0; for (const u of units) { x += u.x; y += u.y; } return { x: x / units.length, y: y / units.length }; }
  movePl(p, units, from, to) { for (const u of units) u.platoon = to.id; to.units.push(...units.map(u => u.id)); from.units = from.units.filter(id => !units.some(u => u.id === id)); }

  military() {
    const g = this.g, t = g.time;
    // prune & assign newcomers
    for (const p of this.platoons) p.units = p.units.filter(id => this.byId.get(id)?.alive);
    this.platoons = this.platoons.filter(p => p.units.length || p.mission === 'reserve');
    const reserveOf = (type) => this.platoonOf(type, 'reserve') || this.newPlatoon(type, 'reserve', type === 'land' ? 'Резерв (суша)' : type === 'air' ? 'Резерв (авиаудар)' : 'Резерв (флот)');
    for (const u of this.myUnits) {
      if (u.platoon && this.platoons.some(p => p.id === u.platoon)) continue;
      const s = u.spec;
      if (s.role === 'eng' || s.role === 'cmd') continue;
      let p;
      if (s.role === 'transport') p = this.platoonOf('air', 'drop') || this.newPlatoon('air', 'drop', 'Десант');
      else if (s.role === 'scout') p = this.platoonOf('air', 'scout') || this.newPlatoon('air', 'scout', 'Воздушная разведка');
      else if (s.role === 'fighter') p = this.platoonOf('air', 'aircap') || this.newPlatoon('air', 'aircap', 'Истребительное прикрытие');
      else if (s.role === 'exp') p = this.newPlatoon('land', 'exp', `Экспериментал «${s.name}»`);
      else if (s.move === 'air') p = reserveOf('air');
      else if (s.move === 'naval') p = reserveOf('naval');
      else p = reserveOf('land');
      p.units.push(u.id); u.platoon = p.id;
      if (p.mission === 'reserve' && !u.orders.length) g.orderMove([u], (p.type === 'naval' ? this.navalStaging : p.type === 'air' ? this.airStaging : this.staging).x + (Math.random() - 0.5) * 40, (p.type === 'naval' ? this.navalStaging : p.type === 'air' ? this.airStaging : this.staging).y + (Math.random() - 0.5) * 40);
    }
    this.defend();
    this.snipe();
    for (const p of [...this.platoons]) {
      const units = this.pUnits(p);
      p.pow = this.pPower(units);
      if (!units.length && p.mission !== 'reserve') continue;
      switch (p.mission) {
        case 'reserve': this.runReserve(p, units); break;
        case 'attack': case 'raid': case 'exp': this.runAttack(p, units); break;
        case 'defend': this.runDefend(p, units); break;
        case 'airstrike': this.runAirStrike(p, units); break;
        case 'aircap': this.runAirCap(p, units); break;
        case 'scout': this.runScout(p, units); break;
        case 'retreat': this.runRetreat(p, units); break;
        case 'drop': this.runDrop(p, units); break;
      }
    }
  }

  defend() {
    const g = this.g, t = g.time;
    const near = (u) => dist(u, this.base) < 280 || this.myStructs.some(s => hyp(s.x - u.x, s.y - u.y) < 120) || (this.acuU && dist(u, this.acuU) < 110);
    const threats = this.intel.clusters(8, near, 90);
    this.baseThreat = threats.reduce((a, c) => a + c.pow, 0);
    if (!threats.length) return;
    const c = threats[0];
    if (t - this.lastBaseAttackT > 30) this.say('ВОЙСКА', `Тревога! Враг у базы: ${c.n} ед. (сила ${Math.round(c.pow)}), направление ${this.bearing(c)}`, 'alert');
    this.lastBaseAttackT = t; this.lastAttackPos = { x: c.x, y: c.y };
    let def = this.platoonOf('land', 'defend');
    const res = this.platoonOf('land', 'reserve');
    const groundThreat = c.members.some(m => m.spec.move !== 'air');
    const staticDef = this.myStructs.reduce((a, s) => a + (dist(s, c) < 120 ? powerOf(s) : 0), 0);
    if (groundThreat && res) {
      const have = (def ? this.pPower(this.pUnits(def)) : 0) + staticDef;
      const ru = this.pUnits(res).sort((a, b) => dist(a, c) - dist(b, c));
      const pull = []; let acc = have;
      for (const u of ru) { if (acc > c.pow * 1.6 + 100) break; pull.push(u); acc += powerOf(u); }
      if (pull.length) {
        if (!def) def = this.newPlatoon('land', 'defend', 'Оборона базы');
        this.movePl(pull, pull, res, def);
      }
    }
    if (def) def.target = { x: c.x, y: c.y, label: 'угроза у базы' };
    // recall attackers if the base is in real danger
    const defPow = def ? this.pPower(this.pUnits(def)) : 0;
    if (c.pow > (defPow + staticDef) * 1.3 + 300) {
      for (const p of this.platoons.filter(p => p.mission === 'attack' && p.type === 'land')) {
        const us = this.pUnits(p); if (!us.length) continue;
        const ce = this.centroid(us);
        if (dist(ce, this.base) < 450 * KM && dist(ce, p.target) > 200) { p.mission = 'defend'; p.name = 'Оборона базы (отозваны)'; p.target = { x: c.x, y: c.y, label: 'угроза у базы' }; this.say('ВОЙСКА', `Отзываю ударную группу #${p.id} на защиту базы`, 'alert'); }
      }
    }
    // air reserve helps against ground threats with gunships
    const air = this.platoonOf('air', 'reserve');
    if (air && groundThreat) {
      const gs = this.pUnits(air).filter(u => u.spec.role === 'gunship' || u.spec.role === 'bomber');
      if (gs.length) g.orderAMove(gs, c.x, c.y);
    }
  }

  bearing(p) {
    const a = Math.atan2(p.y - this.base.y, p.x - this.base.x) * 180 / Math.PI;
    const dirs = ['восток', 'юго-восток', 'юг', 'юго-запад', 'запад', 'северо-запад', 'север', 'северо-восток'];
    return dirs[((Math.round(a / 45) % 8) + 8) % 8];
  }

  runDefend(p, units) {
    const g = this.g;
    const c = p.target;
    const live = c && this.intel.powerNear(c.x, c.y, 140, 'land', 6) > 0;
    if (!live) {
      const res = this.platoonOf('land', 'reserve') || this.newPlatoon('land', 'reserve', 'Резерв (суша)');
      this.movePl(units, units, p, res);
      g.orderAMove(units, this.staging.x, this.staging.y);
      if (units.length) this.say('ВОЙСКА', `Угроза у базы устранена — ${units.length} ед. возвращаются в резерв`);
      return;
    }
    if (g.time - p.lastOrder > 3) { g.orderAMove(units, c.x, c.y); p.lastOrder = g.time; }
    p.status = `Отражаю атаку (${Math.round(p.pow)} против ${Math.round(this.baseThreat)})`;
  }

  runReserve(p, units) {
    const g = this.g, t = g.time, S = this.S;
    const stage = p.type === 'naval' ? this.navalStaging : p.type === 'air' ? this.airStaging : this.staging;
    p.status = `На сборе: ${units.length} ед., сила ${Math.round(p.pow)}`;
    if (!units.length || !stage) return;
    for (const u of units) if (!u.orders.length && dist(u, stage) > 60) g.orderMove([u], stage.x + (Math.random() - 0.5) * 40, stage.y + (Math.random() - 0.5) * 40);
    if (p.type === 'air') {
      const strikers = units.filter(u => u.spec.role === 'bomber' || u.spec.role === 'gunship');
      const need = t < 500 ? 3 : 5;
      const az = this.cmd ? this.cmd.zoneFor('air') : 4;   // командир: авиация держится дома (0–1) или бьёт по выбранной зоне
      if (az >= 2 && (strikers.length >= need || strikers.some(u => u.key === 'strat') && strikers.length >= 2)) {
        const tgt = this.pickTarget('air', this.pPower(strikers), strikers, this.cmd ? (r) => { const rz = this.cmd.zoneOf(r.x, r.y); return az >= 4 ? rz >= 3 : rz === az; } : undefined);
        if (tgt && tgt.risk < this.pPower(strikers) * 1.1) {
          const np = this.newPlatoon('air', 'airstrike', `Авиаудар #${this.pid}`);
          this.movePl(strikers, strikers, p, np); np.target = tgt;
          this.say('ВОЙСКА', `Авиаудар: ${strikers.length} машин → ${tgt.label} (ценность ${Math.round(tgt.value)}, ПВО ${Math.round(tgt.risk)})`);
        }
      }
      return;
    }
    // land / naval: decide to attack
    if (this.cmd) { this.cmdAttack(p, units); return; }   // ИИ-командир задаёт зону атаки
    const firstT = S.firstAttack / (0.7 + this.intents.ATTACK.f * 0.6);
    if (t < firstT && p.pow < 1500) { p.status += ` · атака не раньше ${fmtT(firstT)}`; return; }
    if (p.type === 'land' && !isFinite(this.landReach)) return;
    if (this.macro.hold && !this.capFull) { p.status += ' · макро «Оборона»: держим позиции'; return; }
    // overwhelming superiority (known enemy power vs ours): everything goes, the base is not worth guarding against a beaten enemy
    const allIn = this.features && this.features.ratio > 2.5 && t > 600;
    const keep = allIn ? 0.05 : clamp(S.def * 0.4 + this.mod.def * 0.3 + this.intents.DEFEND.f * 0.2, 0.05, 0.5);
    const attackers = units.filter(u => u.spec.role !== 'aa' || Math.random() < 0.7);
    const nKeep = Math.floor(units.length * keep);
    const go = attackers.slice(0, attackers.length - nKeep);
    const pow = this.pPower(go);
    // raids with fast units
    if (p.type === 'land' && this.intents.RAID.f > 0.35) {
      const fast = go.filter(u => u.spec.speed >= 7.5 && u.spec.role === 'direct' && u.spec.tier === 1).slice(0, 6);
      if (fast.length >= 4) {
        const tgt = this.pickTarget('land', this.pPower(fast), fast, (r) => r.spec.place === 'mex' || r.spec.role === 'eng');
        if (tgt && tgt.risk < this.pPower(fast) * 0.6) {
          const np = this.newPlatoon('land', 'raid', `Рейд #${this.pid}`);
          this.movePl(fast, fast, p, np); np.target = tgt;
          this.say('ВОЙСКА', `Рейд ${fast.length} быстрыми юнитами на ${tgt.label} — слабая охрана (${Math.round(tgt.risk)})`);
          return;
        }
      }
    }
    const useNet = AIP.combat && !AIP.noAtk && hasCombatNet();
    const minN = p.type === 'naval' ? 3 : Math.max(Math.round(16 * Math.min(1, this.macro.minN)), Math.round(16 / S.aggr * this.macro.minN));
    const minNet = p.type === 'naval' ? 3 : AIP.minNet ?? 16;   // groups between this and the heuristic minimum need a clearly winning verdict
    // stream reinforcements into a winning attack, or form a flanking column if front is already solid
    const front = this.platoons.find(q => q.type === p.type && q.mission === 'attack' && q.units.length >= 3 && q.pow > (q.startPow || 0) * 0.45);
    const canFlank = front && front.units.length >= 8 && go.length >= minN && this.platoons.filter(q => q.mission === 'attack').length < 2;
    if (front && go.length >= 3 && go.length < minN * 2 && !canFlank) {
      const fc = this.centroid(this.pUnits(front));
      if (dist(fc, this.staging) < 700 * KM) {
        this.movePl(go, go, p, front);
        g.orderAMove(go, fc.x, fc.y);
        this.say('ВОЙСКА', `Подкрепление: ${go.length} ед. → группа #${front.id} (${front.target?.label || 'фронт'})`);
        return;
      }
    }
    if (go.length < (useNet ? minNet : minN)) { p.status += ` · нужно ≥${useNet ? minNet : minN} для атаки`; return; }
    if (useNet) { if (t - (p.decT || -99) < 3) return; p.decT = t; }   // the net verdict is rate-limited: ~0.2 ms per target
    let tgt = this.pickTarget(p.type, pow, go, canFlank ? (r) => dist(r, front.target || this.enemyStart) > 130 * KM : undefined);
    if (!tgt) tgt = this.pickTarget(p.type, pow, go);
    if (!tgt) { p.status += ' · нет достижимых целей'; return; }
    const f = useNet ? tgt.fight : null;
    if (f) {
      const ok = go.length >= minN ? fightOk(f, this.macro.atk) : f.ta > (AIP.strongTa ?? 0.2) && f.pWin > 0.7;
      if (!ok && !allIn && !this.capFull) { p.status += ` · бой у «${tgt.label}» невыгоден: P(победа) ${Math.round(f.pWin * 100)}%, размен ${f.ta.toFixed(2)}`; return; }
    } else {
      if (go.length < minN) { p.status += ` · нужно ≥${minN} для атаки`; return; }
      const safety = allIn ? 0.7 : 3 / (S.aggr * (0.75 + this.intents.ATTACK.f * 0.5));
      if (tgt.risk * safety > pow && go.length < 35 && !this.capFull) { p.status += ` · цель «${tgt.label}» слишком сильна (${Math.round(tgt.risk)} > ${Math.round(pow / safety)})`; return; }
    }
    const np = this.newPlatoon(p.type, 'attack', `${p.type === 'naval' ? 'Флотилия' : canFlank ? 'Фланговый кулак' : 'Ударная группа'} #${this.pid}`);
    this.movePl(go, go, p, np); np.target = tgt; np.startPow = pow;
    if (canFlank) np.isFlank = true;
    this.say('ВОЙСКА', `${canFlank ? 'ФЛАНГОВЫЙ УДАР' : 'Наступление'}: ${go.length} ед. (сила ${Math.round(pow)}) → ${tgt.label}. Риск ${Math.round(tgt.risk)}, ценность ${Math.round(tgt.value)}.`);
  }

  // ИИ-командир: наземная / морская группа идёт в выбранную моделью зону (0 своя база ... 4 база врага); 0–1 — держим позиции.
  cmdAttack(p, units) {
    const g = this.g, t = g.time, z = this.cmd.zoneFor(p.type);
    if (z <= 1) { p.status += ` · командир: держим ${z ? 'расширение' : 'базу'}`; return; }
    const go = units.filter(u => u.spec.role !== 'aa' || Math.random() < 0.7);
    const minN = p.type === 'naval' ? 3 : 6;
    if (go.length < minN) { p.status += ` · командир: ждём ≥${minN} для атаки`; return; }
    if (t - (p.decT || -99) < 5) return; p.decT = t;
    const pow = this.pPower(go);
    const inZone = (r) => { const rz = this.cmd.zoneOf(r.x, r.y); return z >= 4 ? rz >= 3 : rz === z; };
    let tgt = this.pickTarget(p.type, pow, go, inZone);
    if (!tgt) { const c = this.cmd.zonePoint(z); tgt = { x: c.x, y: c.y, value: 30, risk: this.intel.threatAt(p.type === 'naval' ? 'naval' : 'land', c.x, c.y, 50), label: ['', '', 'центр', 'расширение врага', 'база врага'][z] }; }
    const np = this.newPlatoon(p.type, 'attack', `${p.type === 'naval' ? 'Флотилия' : 'Ударная группа'} #${this.pid} (командир)`);
    this.movePl(go, go, p, np); np.target = tgt; np.startPow = pow;
    this.say('ВОЙСКА', `Командир: ${go.length} ед. (сила ${Math.round(pow)}) → ${tgt.label}`);
  }

  // Target selection with value / risk / distance trade-off using the threat & loss maps.
  pickTarget(type, power, units, filter) {
    const g = this.g, I = this.intel;
    const layer = type === 'air' ? 'air' : type === 'naval' ? 'naval' : 'land';
    const from = units && units.length ? this.centroid(units) : this.staging;
    const cands = [];
    const val = (s) => {
      if (s.key === 'acu') return 500;
      if (s.role === 'exp') return 300;
      if (s.place === 'mex') return 60 * s.tier;
      if (s.produces) return 80 + 30 * s.tier;
      if (s.energy) return 40 * s.tier;
      if (s.shield) return 90; if (s.key === 'arty2') return 140; if (s.role === 'eng') return 45 + 15 * s.tier;
      if (s.isStruct) return 25;
      return 15 + (s.costM || 0) / 12;
    };
    for (const r of I.structs.values()) if (!filter || filter(r)) cands.push({ x: r.x, y: r.y, e: r.e, value: val(r.spec), label: r.spec.name, spec: r.spec });
    for (const r of I.units.values()) {
      if (g.time - r.t > 20) continue;
      if (filter ? !filter(r) : !(r.key === 'acu' || r.spec.role === 'eng' || r.spec.role === 'arty' || r.spec.role === 'exp')) continue;
      cands.push({ x: r.x, y: r.y, e: r.e, value: val(r.spec), label: r.spec.name + (r.key === 'acu' ? ' (КОМАНДИР!)' : ''), spec: r.spec });
    }
    if (!cands.length && !filter) cands.push({ x: this.enemyStart.x, y: this.enemyStart.y, value: 50, label: 'предполагаемая база врага' });
    let best = null, bs = -1e9;
    const scored = [];
    for (const c of cands) {
      if (type === 'naval') {
        const near = g.terrain.passableAt('naval', c.x, c.y) || this.nearWater(c, (units?.[0]?.spec.maxRange || 60) * 0.9);
        if (!near) continue;
      }
      if (type === 'land' && c.spec && c.spec.layer === 'naval' && !g.terrain.passableAt('land', c.x, c.y)) { /* coastal reachable targets only */ }
      let risk = I.threatAt(layer, c.x, c.y, 50);
      const dd = dist(from, c);
      risk += I.loss[I.ci(c.x, c.y)] * 0.15;
      if (type === 'land') {
        const pd = g.terrain.pathDist('land', c.x, c.y, from.x, from.y);
        if (pd === Infinity) continue;
        // path risk sampled along the straight line
        for (let k = 1; k < 4; k++) risk = Math.max(risk, I.threatAt('land', from.x + (c.x - from.x) * k / 4, from.y + (c.y - from.y) * k / 4) * 0.7);
      }
      const sc = c.value / (1 + 2 * risk / Math.max(power, 30)) - dd / (25 * KM);
      c._sc = sc; c._risk = risk; c._dd = dd;
      scored.push(c);
      if (sc > bs) { bs = sc; best = { ...c, risk, score: sc }; }
    }
    // the combat net re-ranks the best few: value x expected outcome of the fight against what we know stands there
    if (best && units && units.length && type !== 'air' && AIP.combat && !AIP.noPick && hasCombatNet()) {
      scored.sort((a, b) => b._sc - a._sc);
      let bs2 = -1e9;
      for (let i = 0; i < Math.min(scored.length, AIP.topK ?? 4); i++) {
        const c = scored[i], f = fightAt(this, units, c.x, c.y, true);
        const sc = f ? c.value * clamp(0.35 + 0.9 * f.pWin + 0.9 * f.ta, 0.05, 1.3) - c._dd / (25 * KM) : c._sc;
        if (sc > bs2) { bs2 = sc; best = { ...c, risk: c._risk, score: sc, fight: f }; }
      }
    }
    if (!best && !filter && type !== 'naval') best = { x: this.enemyStart.x, y: this.enemyStart.y, value: 50, label: 'база противника', risk: I.threatAt(layer, this.enemyStart.x, this.enemyStart.y, 50), score: 0 };
    return best;
  }
  nearWater(c, r) {
    const t = this.g.terrain;
    for (let a = 0; a < 6.28; a += 0.5) if (t.passableAt('naval', c.x + Math.cos(a) * r, c.y + Math.sin(a) * r)) return true;
    return false;
  }

  runAttack(p, units) {
    const g = this.g;
    if (!units.length) return;
    const c = this.centroid(units);
    const tgt = p.target;
    if (p.mission === 'exp' && !tgt) p.target = this.pickTarget('land', p.pow * 3, units) || { x: this.enemyStart.x, y: this.enemyStart.y, label: 'база врага' };
    if (!p.target) return;
    const layer = p.type === 'naval' ? 'naval' : 'land';
    const local = this.intel.powerNear(c.x, c.y, 130, layer, 10);
    // retreat if losing badly: the combat net compares fighting on with falling back, else the power ratio
    let bad = local > p.pow * (this.retreatK || 1.0) && local > 100;   // retreatK: lieutenants tune it by style
    if (AIP.netRet && AIP.combat && hasCombatNet()) {   // measured: no better than the power ratio (see ml/PLAN.md), off by default
      if (g.time - (p.fT ?? -99) >= 2) { p.fT = g.time; p.fv = fightAt(this, units, c.x, c.y, false); }
      const f = p.fv;
      bad = !!f && f.ta - f.tr < -(AIP.retM ?? 0.02) - ((this.retreatK || 1) - 1) * 0.04 && f.pWin < (AIP.retP ?? 0.45);
    }
    if (p.mission !== 'exp' && bad) {
      p.mission = 'retreat'; p.name += ' (отход)';
      g.orderMove(units, this.staging.x, this.staging.y);
      this.say('ВОЙСКА', `Группа #${p.id}: противник сильнее (${Math.round(local)} vs ${Math.round(p.pow)}) — отступаю и перегруппировываюсь`, 'alert');
      return;
    }
    const targetGone = p.target.e ? !p.target.e.alive || (this.g.isEnemy(p.target.e.team, this.team) && !this.intel.structs.has(p.target.e.id) && !this.intel.units.has(p.target.e.id) && dist(c, p.target) < 60) : dist(c, p.target) < 50 && local < 5;
    if (targetGone) {
      const next = this.pickTarget(p.type, p.pow, units, p.mission === 'raid' ? (r) => r.spec.place === 'mex' || r.spec.role === 'eng' : undefined);
      if (next && (next.fight ? fightOk(next.fight) : next.risk < p.pow * 1.1) && dist(next, c) < 600 * KM) {
        this.say('ВОЙСКА', `Группа #${p.id}: цель «${p.target.label}» уничтожена → следующая: ${next.label}`);
        p.target = next; p.lastOrder = -99;
      } else {
        this.say('ВОЙСКА', `Группа #${p.id} выполнила задачу, возвращается в резерв`);
        const res = this.platoonOf(p.type, 'reserve') || this.newPlatoon(p.type, 'reserve', 'Резерв');
        this.movePl(units, units, p, res);
        g.orderAMove(units, this.staging.x, this.staging.y);
        return;
      }
    }
    // cohesion: regroup stragglers before contact
    const spread = units.filter(u => dist(u, c) > 60 + units.length * 2).length;
    const toT = dist(c, p.target);
    if (spread > units.length * 0.35 && local < 5 && toT > 150 && g.time - p.lastOrder > 2 && g.terrain.passableAt(p.type === 'naval' ? 'naval' : 'land', c.x, c.y)) { // the centroid of a group split around an obstacle may be unwalkable
      g.orderMove(units, c.x, c.y); p.lastOrder = g.time - 3;
      p.status = `Перегруппировка (${spread} отставших) · ${Math.round(toT)} м до цели`;
      return;
    }
    if (g.time - p.lastOrder > 6 || units.some(u => !u.orders.length)) {
      const tx = p.target.e && p.target.e.alive ? p.target.e.x : p.target.x, ty = p.target.e && p.target.e.alive ? p.target.e.y : p.target.y;
      const detour = p.mission !== 'exp' ? this.findFlankWaypoint(c, { x: tx, y: ty }, p.type === 'naval' ? 'naval' : 'land', p.pow * 0.75) : null;
      if (detour && dist(c, detour) > 50 * KM) {
        g.orderMove(units, detour.x, detour.y);
        p.status = `Обход зоны огня (${Math.round(dist(c, detour))} м) → ${p.target.label}`;
      } else {
        g.orderAMove(units, tx, ty);
      }
      p.lastOrder = g.time;
    }
    p.status = `${p.mission === 'raid' ? 'Рейд' : p.isFlank ? 'Фланговый удар' : 'Атака'} → ${p.target.label}: ${Math.round(toT)} м, сила ${Math.round(p.pow)} / враг рядом ${Math.round(local)}`;
  }

  // Air drop: load fast ground units into transports, fly around air defence, drop them on enemy extractors.
  runDrop(p, allUnits) {
    const g = this.g, t = g.time;
    const tr = allUnits.filter(u => u.cargo);
    p.phase = p.phase || 'load';
    if (!tr.length) { p.status = 'Нет транспортов'; return; }
    const home = this.airStaging;
    if (p.phase === 'load') {
      const cmdDrop = this.cmd?.special() === 'Десант';   // приказ ИИ-командира: десант сейчас, в зону цели суши
      if (t < (p.cool || 0) || (!cmdDrop && (t < 420 || this.intents.RAID.f < 0.2 && this.intents.ATTACK.f < 0.5))) { p.status = 'Транспорты ждут на аэродроме'; for (const u of tr) if (!u.orders.length && dist(u, home) > 40) g.orderMove([u], home.x, home.y); return; }
      if (!p.t0) {
        const res = this.platoonOf('land', 'reserve');
        const cap = tr.reduce((a, u) => a + u.spec.cargo, 0);
        const cand = res ? this.pUnits(res).filter(u => u.spec.role === 'direct' && !u.carried).sort((a, b) => b.spec.speed - a.spec.speed) : [];
        const riders = []; let used = 0;
        for (const u of cand) if (used + u.spec.slots <= cap) { riders.push(u); used += u.spec.slots; }
        if (riders.length < 4) { p.status = 'Жду десантников в резерве'; return; }
        this.movePl(riders, riders, res, p);
        let k = 0;
        const pad = g.freeSpot('land', this.staging.x, this.staging.y, 60) || this.staging; // hover over open ground the riders can reach
        for (const u of tr) { const c = g.formation(tr, pad.x, pad.y, { spacing: 1.5 }).get(u.id); g.orderMove([u], c.x, c.y); }
        for (const r of riders) g.orderBoard([r], tr[k++ % tr.length]);
        p.t0 = t;
        this.say('ВОЙСКА', `Десант: ${riders.length} ед. садятся в ${tr.length} транспорт(а)`);
      }
      const riders = allUnits.filter(u => !u.cargo);
      const loaded = riders.filter(u => u.carried).length;
      p.status = `Посадка: ${loaded}/${riders.length}`;
      if (!loaded && t - p.t0 > 60) {
        const res = this.platoonOf('land', 'reserve') || this.newPlatoon('land', 'reserve', 'Резерв (суша)');
        this.movePl(riders, riders, p, res); p.t0 = 0; p.cool = t + 30;
        return;
      }
      if (loaded && (loaded === riders.length || t - p.t0 > 40)) {
        const pow = this.pPower(riders);
        const cz = this.cmd?.special() === 'Десант' ? this.cmd.zoneFor('land') : -1;
        const tgt = this.dropTarget(pow, home, cz);
        if (!tgt) { p.status = 'Нет безопасной цели для десанта'; if (t - p.t0 > 90) p.cool = t + 20; return; }
        // land a bit short of the target, on the side away from the enemy base
        const a = Math.atan2(tgt.y - this.enemyStart.y, tgt.x - this.enemyStart.x);
        const lz = g.freeSpot('land', tgt.x + Math.cos(a) * 25, tgt.y + Math.sin(a) * 25, 40) || tgt;
        g.orderUnload(tr.filter(u => u.cargo.length), lz.x, lz.y);
        p.phase = 'fly'; p.target = tgt; p.t1 = t;
        this.say('ВОЙСКА', `Десант летит на «${tgt.label}» (ПВО ${Math.round(this.intel.threatAt('air', tgt.x, tgt.y, 40))})`, 'alert');
      }
      return;
    }
    // fly / drop
    const riders = allUnits.filter(u => !u.cargo), down = riders.filter(u => !u.carried);
    p.status = `Десант → ${p.target?.label}: высажено ${down.length}/${riders.length}`;
    if (tr.every(u => !u.cargo.length) || t - p.t1 > 90) {
      if (riders.length) {
        const np = this.newPlatoon('land', 'raid', `Десант-рейд #${this.pid}`);
        this.movePl(riders, riders, p, np); np.target = p.target; np.startPow = this.pPower(riders); np.lastOrder = -99;
      }
      g.orderMove(tr, home.x, home.y);
      p.phase = 'load'; p.t0 = 0; p.cool = t + 60;
      this.say('ВОЙСКА', `Десант высажен (${down.length} ед.), транспорты возвращаются`);
    }
  }

  // Drop zone: enemy economy that is weakly defended on the ground and reachable without flying over anti-air.
  // zone >= 0 (приказ ИИ-командира): цели только в этой зоне; нет известных целей — высадка в саму зону, если туда можно
  dropTarget(pow, from, zone = -1) {
    const I = this.intel; let best = null, bs = -1e9;
    for (const r of I.structs.values()) {
      const s = r.spec;
      if (zone >= 0 && this.cmd.zoneOf(r.x, r.y) !== zone) continue;
      if (!(s.place === 'mex' || s.energy || s.fabM || s.produces)) continue;
      if (!this.g.terrain.passableAt('land', r.x, r.y) && !this.g.freeSpot('land', r.x, r.y, 30)) continue;
      const ground = I.threatAt('land', r.x, r.y, 40);
      let air = 0;
      for (let k = 1; k <= 6; k++) air = Math.max(air, I.threatAt('air', from.x + (r.x - from.x) * k / 6, from.y + (r.y - from.y) * k / 6, 20));
      if (ground > pow * 0.8 || air > 70) continue;
      const value = s.place === 'mex' ? 60 * s.tier : s.produces ? 70 : s.fabM ? 90 : 40 * s.tier;
      const sc = value / (1 + 2 * ground / Math.max(pow, 30)) - air * 0.5 - dist(from, r) / 40;
      if (sc > bs) { bs = sc; best = { x: r.x, y: r.y, e: r.e, value, risk: ground, label: s.name }; }
    }
    if (!best && zone >= 0) {
      const zp = this.cmd.zonePoint(zone), q = this.g.freeSpot('land', zp.x, zp.y, 60);
      if (q && I.threatAt('land', q.x, q.y, 40) < pow * 0.8) best = { x: q.x, y: q.y, value: 30, risk: 0, label: 'зона командира' };
    }
    return best;
  }

  runRetreat(p, units) {
    const c = units.length ? this.centroid(units) : this.staging;
    p.status = 'Отход к точке сбора';
    if (dist(c, this.staging) < 90 || !units.length) {
      const res = this.platoonOf(p.type, 'reserve') || this.newPlatoon(p.type, 'reserve', 'Резерв');
      this.movePl(units, units, p, res);
    }
  }

  runAirStrike(p, units) {
    const g = this.g;
    if (!units.length) return;
    let tgt = p.target;
    const alive = tgt && (!tgt.e || tgt.e.alive);
    if (!alive) {
      tgt = this.pickTarget('air', p.pow, units);
      if (!tgt || tgt.risk > p.pow * 1.5) {
        const res = this.platoonOf('air', 'reserve') || this.newPlatoon('air', 'reserve', 'Резерв (авиаудар)');
        this.movePl(units, units, p, res); g.orderMove(units, this.airStaging.x, this.airStaging.y);
        this.say('ВОЙСКА', `Авиаудар #${p.id} завершён — возврат на аэродром`);
        return;
      }
      p.target = tgt; p.lastOrder = -99;
    }
    const c = this.centroid(units);
    const tx = tgt.e && tgt.e.alive ? tgt.e.x : tgt.x, ty = tgt.e && tgt.e.alive ? tgt.e.y : tgt.y;
    const dToT = dist(c, { x: tx, y: ty });
    if (g.time - p.lastOrder > 5 || units.some(u => !u.orders.length)) {
      const detour = dToT > 80 * KM ? this.findFlankWaypoint(c, { x: tx, y: ty }, 'air', 50) : null;
      if (detour && dist(c, detour) > 40 * KM) {
        g.orderMove(units, detour.x, detour.y);
        p.status = `Облёт зон ПВО (${Math.round(dist(c, detour))} м) → ${tgt.label}`;
      } else {
        if (tgt.e && tgt.e.alive) g.orderAttack(units, tgt.e); else g.orderAMove(units, tx, ty);
        p.status = `Удар по: ${tgt.label} (ПВО ${Math.round(tgt.risk)})`;
      }
      p.lastOrder = g.time;
    }
  }

  runAirCap(p, units) {
    const g = this.g;
    if (!units.length) return;
    const airC = this.intel.clusters(6, u => u.spec.move === 'air' && (dist(u, this.base) < 450 || this.myUnits.some(m => m.spec.move !== 'air' && dist(m, u) < 120)), 100)
      .filter(c => c.air > 0);
    if (airC.length && p.pow > airC[0].pow * 0.6) {
      if (g.time - p.lastOrder > 3) { g.orderAMove(units, airC[0].x, airC[0].y); p.lastOrder = g.time; }
      p.status = `Перехват ${airC[0].n} воздушных целей`;
      if (!p.intercepting) this.say('ВОЙСКА', `Истребители перехватывают ${airC[0].n} самолётов противника`);
      p.intercepting = true;
      return;
    }
    p.intercepting = false;
    const strike = this.platoons.find(q => q.mission === 'airstrike' && q.units.length);
    if (strike) {
      const lead = this.pUnits(strike)[0];
      if (lead && g.time - p.lastOrder > 5) { g.orderGuard(units, lead); p.lastOrder = g.time; }
      p.status = 'Сопровождаю бомбардировщики';
      return;
    }
    if (g.time - p.lastOrder > 15) { g.orderPatrol(units, this.airStaging.x + this.dir.x * 120, this.airStaging.y + this.dir.y * 120); p.lastOrder = g.time; }
    p.status = 'Патруль воздушного пространства';
  }

  runScout(p, units) {
    const g = this.g;
    if (!units.length) return;
    if (g.time - p.lastOrder < 18) return;
    p.lastOrder = g.time;

    // Check if we have long-range fire support needing spotting (arty2, tml, or mobile arty tier >= 2)
    const arty = this.myStructs.find(s => s.built && (s.key === 'arty2' || s.key === 'tml')) ||
                 this.myUnits.find(u => u.spec.role === 'arty' && u.spec.tier >= 2);

    if (arty) {
      const maxR = arty.spec.weapons?.[0]?.range || 250;
      const candidates = [...this.intel.structs.values(), ...this.intel.units.values()]
        .filter(e => dist(arty, e) <= maxR && dist(arty, e) >= 40)
        .sort((a, b) => (b.spec?.costM || 0) - (a.spec?.costM || 0));

      const spotTarget = candidates[0] || (dist(arty, this.enemyStart) <= maxR ? this.enemyStart : null);
      if (spotTarget) {
        p.status = `Корректировка огня артиллерии (${Math.round(dist(arty, spotTarget))} м)`;
        for (const u of units) {
          u.orders.length = 0;
          const a = Math.atan2(spotTarget.y - arty.y, spotTarget.x - arty.x);
          const p1 = { x: clamp(spotTarget.x - Math.cos(a) * 35 + Math.sin(a) * 45, 30, MAP_SIZE - 30), y: clamp(spotTarget.y - Math.sin(a) * 35 - Math.cos(a) * 45, 30, MAP_SIZE - 30) };
          const p2 = { x: clamp(spotTarget.x - Math.cos(a) * 20, 30, MAP_SIZE - 30), y: clamp(spotTarget.y - Math.sin(a) * 20, 30, MAP_SIZE - 30) };
          const p3 = { x: clamp(spotTarget.x - Math.cos(a) * 35 - Math.sin(a) * 45, 30, MAP_SIZE - 30), y: clamp(spotTarget.y - Math.sin(a) * 35 + Math.cos(a) * 45, 30, MAP_SIZE - 30) };
          u.orders.push({ type: 'move', x: p1.x, y: p1.y });
          u.orders.push({ type: 'move', x: p2.x, y: p2.y });
          u.orders.push({ type: 'move', x: p3.x, y: p3.y });
        }
        return;
      }
    }

    for (const u of units) {
      const pts = [];
      const m = g.terrain.mass;
      pts.push(this.enemyStart);
      for (let i = 0; i < 3; i++) pts.push(m[(Math.random() * m.length) | 0]);
      pts.push({ x: MAP_SIZE / 2, y: MAP_SIZE / 2 });
      u.orders.length = 0;
      for (const pt of pts) u.orders.push({ type: 'move', x: pt.x, y: pt.y });
    }
    p.status = 'Облёт вражеской базы и месторождений';
  }

  snipe() {
    const ea = this.intel.enemyAcu;
    if (!ea || this.g.time - ea.t > 12) return;
    const thr = this.intel.threatAt('air', ea.x, ea.y, 40);
    const air = this.platoons.filter(p => p.type === 'air' && (p.mission === 'reserve' || p.mission === 'airstrike'));
    const strikers = air.flatMap(p => this.pUnits(p)).filter(u => u.spec.role === 'bomber' || u.spec.role === 'gunship');
    const pow = this.pPower(strikers);
    const want = this.intents.SNIPE.f > 0.45 || (ea.hp < 0.35 && pow > thr) || pow > thr * 2.5 + 200 || this.cmd?.special() === 'Охота на командира';
    if (!want || strikers.length < 2) return;
    if (this.g.time - (this.lastSnipe || -99) < 20) return;
    this.lastSnipe = this.g.time;
    let np = this.platoons.find(p => p.mission === 'airstrike' && p.target?.e === ea.e);
    if (!np) np = this.newPlatoon('air', 'airstrike', 'СНАЙП КОМАНДИРА');
    for (const p of air) if (p !== np) this.movePl(this.pUnits(p).filter(u => strikers.includes(u)), this.pUnits(p).filter(u => strikers.includes(u)), p, np);
    np.target = { x: ea.x, y: ea.y, e: ea.e, value: 500, risk: thr, label: 'ВРАЖЕСКИЙ КОМАНДИР' };
    np.lastOrder = -99;
    this.say('ВОЙСКА', `ОХОТА НА КОМАНДИРА: ${strikers.length} ударных машин, HP цели ${Math.round(ea.hp * 100)}%, ПВО ${Math.round(thr)}`, 'alert');
  }

  // ---------------------------------------------------------------- ACU
  // Safest reachable spot near home: low known threat, away from the attackers, under a shield if we have one.
  acuSafeSpot(a, threat) {
    const t = this.g.terrain, I = this.intel;
    const shield = this.myStructs.find(s => s.shield && s.built && s.shield.on && (!threat || dist(s, threat) > 70));
    const cands = shield ? [{ x: shield.x, y: shield.y }] : [];
    // behind the base (away from the enemy start), never out in the field
    const back = { x: this.base.x - this.dir.x * 30, y: this.base.y - this.dir.y * 30 };
    if (t.passableAt('amph', back.x, back.y)) cands.push(back);
    for (let r = 30; r <= 90; r += 30) for (let k = 0; k < 12; k++) {
      const p = { x: back.x + Math.cos(k * 0.5236) * r, y: back.y + Math.sin(k * 0.5236) * r };
      if (t.passableAt('amph', p.x, p.y)) cands.push(p);
    }
    // against aircraft running is pointless: go where our anti-air is
    const air = I.powerNear(a.x, a.y, 140, 'land', 8) > 0 && [...I.units.values()].some(u => u.spec.move === 'air' && u.spec.dpsGround > 0 && hyp(u.x - a.x, u.y - a.y) < 140);
    const aaAt = (p) => { let s = 0; for (const f of this.myStructs) if (f.spec.dpsAir && hyp(f.x - p.x, f.y - p.y) < f.spec.maxRange) s += f.spec.dpsAir; for (const u of this.myUnits) if (u.spec.dpsAir && u.spec.move !== 'air' && hyp(u.x - p.x, u.y - p.y) < 50) s += u.spec.dpsAir; return s; };
    let best = null, bs = 1e9;
    for (const p of cands) {
      const sc = I.threatAt('land', p.x, p.y, 30) * 3 - (threat ? dist(p, threat) : 0) * 0.8 + dist(p, a) * 0.35 + dist(p, this.base) * 0.2 - (p === cands[0] && shield ? 60 : 0) - (air ? aaAt(p) * 1.5 : 0);
      if (sc < bs) { bs = sc; best = p; }
    }
    return best || this.base;
  }
  acu() {
    const g = this.g, a = this.acuU;
    if (!a) return;
    const hpf = a.hp / a.maxHp;
    const enemyPow = this.intel.powerNear(a.x, a.y, 110, 'land', 6);
    const friends = this.myUnits.filter(u => u !== a && u.spec.dps > 0 && dist(u, a) < 90);
    const myPow = powerOf(a) + this.pPower(friends);
    const prev = this.acuState;
    const threatC = enemyPow > 0 ? this.intel.clusters(8, u => dist(u, a) < 160, 60)[0] : null;
    // strike aircraft over the commander vs anti-air around it: the ACU can't shoot back at them
    let airPow = 0, aaPow = 0;
    for (const u of this.intel.units.values()) if (u.spec.move === 'air' && u.spec.dpsGround > 0 && g.time - u.t < 6 && hyp(u.x - a.x, u.y - a.y) < 130) airPow += Math.sqrt(u.spec.dpsGround * u.hp);
    if (airPow) for (const f of [...this.myUnits, ...this.myStructs]) if (f.spec.dpsAir > 0 && dist(f, a) < 70) aaPow += Math.sqrt(f.spec.dpsAir * f.hp);
    const airDanger = airPow > aaPow * 0.7 && hpf < 0.9;
    if ((hpf < 0.5 && enemyPow > 0) || airDanger || enemyPow > myPow * 0.8 && enemyPow > powerOf(a) * 0.4) {
      this.acuState = 'Отступление'; this.acuRetreatT = g.time;
      if (!this.acuSafe || g.time - this.acuSafeT > 4) { this.acuSafe = this.acuSafeSpot(a, threatC); this.acuSafeT = g.time; }
      const away = this.acuSafe;
      if (!a.orders[0] || a.orders[0].type !== 'move' || hyp(a.orders[0].x - away.x, a.orders[0].y - away.y) > 20) g.orderMove([a], away.x, away.y);
      // escort + repairs; fighters and mobile AA converge on the commander if aircraft hunt it
      const res = this.platoonOf('land', 'reserve'); if (res) g.orderAMove(this.pUnits(res), threatC ? threatC.x : a.x, threatC ? threatC.y : a.y);
      if (threatC && threatC.air || airDanger) {
        const home = this.platoons.filter(p => p.mission === 'reserve' || p.mission === 'aircap' || p.mission === 'defend').flatMap(p => this.pUnits(p));
        const aa = home.filter(u => u.spec.dpsAir > 0 && dist(u, a) < 400);
        if (aa.length) g.orderAMove(aa, a.x, a.y);
        if (prev !== 'Отступление') this.say('ACU', `Командира атакует авиация (сила ${Math.round(airPow)}, наша ПВО рядом ${Math.round(aaPow)}) — отход под зенитки, ${aa.length} ед. ПВО на прикрытие`, 'alert');
      }
      const engs = this.myUnits.filter(u => u.spec.role === 'eng' && dist(u, a) < 200 && !u.brain.flee).slice(0, 3);
      if (engs.length) g.orderRepair(engs, a);
      if (prev !== this.acuState) this.say('ACU', `Командир под угрозой (HP ${Math.round(hpf * 100)}%, враг ${Math.round(enemyPow)} vs наши ${Math.round(myPow)}) — отход в безопасную точку, ${engs.length} инж. на ремонт`, 'alert');
    } else if (enemyPow > 0 && hpf > (prev === 'Отступление' ? 0.8 : 0.65) && dist(a, this.base) < 160 && myPow > enemyPow * 1.6 && g.time - (this.acuRetreatT || -99) > 20) {
      this.acuState = 'Бой';
      if (threatC && dist(threatC, this.base) < 170 && (!a.orders[0] || a.orders[0].type !== 'amove')) g.orderAMove([a], threatC.x, threatC.y);
      if (prev !== this.acuState) this.say('ACU', `Командир вступает в бой: у нас перевес ${Math.round(myPow)} vs ${Math.round(enemyPow)}`);
    } else if (enemyPow > 0 || g.time - (this.acuRetreatT || -99) < 20) {
      // cautious: enemies around or just retreated — hold a safe spot, keep building only close to it
      this.acuState = 'Осторожно';
      if (!this.acuSafe || g.time - this.acuSafeT > 6) { this.acuSafe = this.acuSafeSpot(a, threatC); this.acuSafeT = g.time; }
      const o = a.orders[0];
      if (dist(a, this.acuSafe) > 40 && !(o && o.type === 'move' && hyp(o.x - this.acuSafe.x, o.y - this.acuSafe.y) < 20)) g.orderMove([a], this.acuSafe.x, this.acuSafe.y);
    } else {
      if (this.acuState !== 'Строительство' && (!a.orders.length || a.orders[0].type === 'amove' || a.orders[0].type === 'move')) { a.orders.length = 0; }
      this.acuState = 'Строительство';
      this.enhanceACU(a);
      if (hpf < 0.8) {
        const eng = this.myUnits.find(u => u.spec.role === 'eng' && dist(u, a) < 150 && (!u.orders.length || u.orders[0].auto));
        if (eng) g.orderRepair([eng], a);
      }
      if (dist(a, this.base) > 300 && !a.orders.length) g.orderMove([a], this.base.x, this.base.y);
    }
  }

  // ACU enhancement path: engineering first (T2 buildings at home), then the gun, then shield / resources, then T3 engineering.
  enhanceACU(a) {
    if (a.orders[0]?.type === 'enhance') return;
    const g = this.g, eco = this.T.eco, t = g.time, e = a.enh;
    if (this.baseThreat > 150 || dist(a, this.base) > 160) return;
    const want = [], netE = eco.incE - eco.upkeep;
    if (!e.larm && t > 330 && eco.incM > 12 && netE > 220) want.push('eng2');
    if (!e.rarm && t > 420 && eco.incM > 16 && netE > 320) want.push('gun');
    if (!e.back && t > 600 && eco.incM > 24 && netE > 600) want.push(this.S.aggr >= 1.1 || this.intel.enemyAcu ? 'shield' : eco.incM < 45 ? 'res' : 'regen');
    if (e.larm === 'eng2' && this.tier >= 3 && eco.incM > 40 && netE > 1200) want.push('eng3');
    if (this.behind || this.powerCrisis) return;
    const k = want[0];
    if (!k || eco.mass < ENH[k].costM * 0.25 || eco.energy < eco.maxEnergy * 0.35 || eco.stallE) return;
    a.orders.length = 0;
    g.orderEnhance([a], k);
    this.say('ACU', `Командир устанавливает улучшение «${ENH[k].name}» (${ENH[k].costM} М / ${ENH[k].costE} Э)`);
  }

  // ---------------------------------------------------------------- REVIEW: intents + adaptation
  review() {
    const g = this.g, eco = this.T.eco, t = g.time, I = this.intel, S = this.S;
    const ourLand = this.myUnits.filter(u => u.spec.move !== 'air' && u.spec.role !== 'cmd').reduce((a, u) => a + powerOf(u), 0);
    const ourAir = this.myUnits.filter(u => u.spec.move === 'air').reduce((a, u) => a + powerOf(u), 0);
    const ourAA = this.myUnits.reduce((a, u) => a + Math.sqrt(u.spec.dpsAir * u.hp), 0) + this.myStructs.reduce((a, s) => a + Math.sqrt(s.spec.dpsAir * s.hp), 0);
    const enemyPow = I.totalPower();
    const enemyAir = I.totalPower(s => s.move === 'air' && s.role !== 'scout');
    const ourPow = ourLand + ourAir;
    const ratio = ourPow / (enemyPow + 50);
    const freeMex = g.terrain.mass.filter(m => !g.structs.some(s => s.alive && s.spec.place === 'mex' && s.x === m.x && s.y === m.y) && I.threatAt('land', m.x, m.y) < 30).length;
    const enemyMex = [...I.structs.values()].filter(r => r.spec.place === 'mex').length;
    const fast = this.myUnits.filter(u => u.spec.speed >= 7.5 && u.spec.role === 'direct').length;
    const ea = I.enemyAcu && t - I.enemyAcu.t < 30 ? I.enemyAcu : null;
    const recent = (arr) => arr.filter(e => t - e.t < 180);
    const deaths = recent(g.events.filter(e => e.type === 'death' && e.t > t - 180));
    const lost = deaths.filter(e => e.team === this.team).reduce((a, e) => a + e.cost, 0);
    const killed = deaths.filter(e => e.killer === this.team).reduce((a, e) => a + e.cost, 0);
    this.trade = { lost, killed };
    const h = {
      ECO: clamp(freeMex / (11 * KM) + (eco.stallE ? 0.25 : 0) + (t < 300 ? 0.3 : 0)) * clamp(S.eco, 0.5, 1.4),
      TECH: clamp((t - S.tech2 * 0.8) / 300) * 0.6 + (I.enemyTier > this.tier ? 0.4 : 0) + (eco.incM > 20 && this.tier < 2 ? 0.3 : 0),
      ARMY: clamp(1 - ratio) * 0.7 + 0.15,
      ATTACK: clamp((ratio - 0.8) * 0.7) * S.aggr + (t > S.firstAttack ? 0.15 : 0),
      RAID: enemyMex > 3 && fast >= 4 ? 0.3 + clamp(enemyMex / 20) * S.aggr : 0.05,
      DEFEND: clamp(this.baseThreat / (ourLand * 0.5 + 60), 0, 1.2) + (t - this.lastBaseAttackT < 60 ? 0.2 : 0),
      ANTIAIR: clamp(enemyAir / (ourAA + 40) - 0.2),
      SNIPE: ea ? clamp((1 - ea.hp) * 1.1 + (ourAir > I.threatAt('air', ea.x, ea.y) * 1.5 ? 0.3 : 0)) : 0,
      EXPERIMENTAL: this.tier >= 3 && eco.incM > 30 ? (S.exp ? 0.65 : 0.4) : 0
    };
    for (const k in h) { this.intents[k].h = clamp(h[k], 0, 1.2); }
    const mb = this.macro.bias;
    for (const k in h) this.intents[k].f = mb[k] ? clamp(this.intents[k].h + mb[k], 0, 1.2) : this.intents[k].h;
    this.features = { t, incM: eco.incM, incE: eco.incE, ourPow, ourLand, ourAir, ourAA, enemyPow, enemyAir, ratio, freeMex, enemyMex, tier: this.tier, enemyTier: I.enemyTier, ea, lost, killed };
    // Adaptive doctrine shift.
    if (this.doctrine === 'adaptive' && t > 300 && t - (this.lastShift || 0) > 180) {
      let to = null, why = '';
      if (lost > killed * 2.2 && lost > 800 && S.aggr > 0.9) { to = this.S.exp ? 'turtle' : 'eco_tech'; why = `потери ${Math.round(lost)} против ${Math.round(killed)} — перехожу к обороне и экономике`; }
      else if (enemyAir > ourAA * 2 && enemyAir > 400 && this.strategyKey !== 'air_dom') { to = 'air_dom'; why = 'у противника господство в воздухе — отвоёвываю небо'; }
      else if (killed > lost * 2 && ratio > 1.5 && S.aggr < 1) { to = isFinite(this.landReach) ? 'land_rush' : 'air_dom'; why = 'выигрываем размены — усиливаю давление'; }
      if (to && to !== this.strategyKey) {
        this.stratHistory.push({ t, from: this.strategyKey, to });
        this.strategyKey = to; this.lastShift = t;
        this.say('СТРАТЕГИЯ', `Смена доктрины → «${STRATEGIES[to].name}»: ${why}.`, 'alert');
      }
    }
    const top = INTENTS.map(i => ({ ...i, ...this.intents[i.key] })).sort((a, b) => b.f - a.f)[0];
    if (top.key !== this.lastTop) { this.lastTop = top.key; this.say('СТРАТЕГИЯ', `Главный приоритет: ${top.ru} (${Math.round(top.f * 100)}%)`); }
  }

  // ---------------------------------------------------------------- STRATEGIC MODEL: macro action every 60-90 s (js/stratnet.js)
  decideMacro() {
    const t = this.g.time;
    if (t < this.nextMacroT || !this.features) return;
    this.nextMacroT = t + 60 + 3 * ((t | 0) % 10);
    const net = this.useStrat && hasStrategyNet();
    if (!net && !this.macroHook) return;
    const s = stateVector(this), r = evalState(s), mask = macroMask(this);
    let a = this.macroIdx;
    if (net) a = pickMacro(r, mask, this.macroIdx, AIP.tau ?? 0.015);
    if (this.macroHook) { const h = this.macroHook(this, s, net ? r : null, mask, a); if (h != null) a = h; }
    this.macroInfo = r ? { v: r.v, q: r.q[a] } : null;
    if (a !== this.macroIdx) {
      this.say('МАКРО', `${MACROS[a].ru}${r ? ` · оценка победы ${Math.round(r.v * 100)}%` : ''}`);
      this.macroIdx = a; this.macro = macroOf(a); this.macroT = t;
    }
  }

  // ---------------------------------------------------------------- save / load
  serialize() {
    const I = this.intel, tref = (tg) => tg ? { ...tg, e: tg.e ? tg.e.id : null, spec: undefined } : null;
    return {
      team: this.team, name: this.name, diff: this.diff, doctrine: this.doctrine, strategyKey: this.strategyKey, initialStrategy: this.initialStrategy,
      logs: this.logs.slice(0, 80), pid: this.pid, mod: this.mod, lastBaseAttackT: this.lastBaseAttackT, acuState: this.acuState, stratHistory: this.stratHistory,
      macro: this.macroIdx, macroT: this.macroT, nextMacroT: this.nextMacroT, phase: this.phase, lastShift: this.lastShift || 0, intents: this.intents, expKey: this.expKey || null, expHistory: this.expHistory || [],
      platoons: this.platoons.map(p => ({ ...p, target: tref(p.target) })),
      intel: {
        structs: [...I.structs.values()].map(r => ({ id: r.id, key: r.key, x: r.x, y: r.y, t: r.t, hp: r.hp, built: r.built })),
        comp: I.comp, enemyTier: I.enemyTier, firstRushT: I.firstRushT, firstT2T: I.firstT2T,
        loss: Array.from(I.loss, v => Math.round(v)), kill: Array.from(I.kill, v => Math.round(v)), seen: [...I.seenIds]
      }
    };
  }
  restore(d) {
    const g = this.g, ent = new Map([...g.units, ...g.structs].map(e => [e.id, e]));
    Object.assign(this, { strategyKey: d.strategyKey, initialStrategy: d.initialStrategy, logs: d.logs, pid: d.pid, mod: d.mod, lastBaseAttackT: d.lastBaseAttackT,
      acuState: d.acuState, stratHistory: d.stratHistory, phase: d.phase, lastShift: d.lastShift, expKey: d.expKey, expHistory: d.expHistory || [] });
    this.macroIdx = d.macro || 0; this.macro = macroOf(this.macroIdx); this.macroT = d.macroT || 0; this.nextMacroT = d.nextMacroT ?? 120;
    for (const k in d.intents) if (this.intents[k]) Object.assign(this.intents[k], d.intents[k]);
    this.platoons = d.platoons.map(p => ({ ...p, target: p.target ? { ...p.target, e: p.target.e ? ent.get(p.target.e) || null : undefined } : null }));
    for (const p of this.platoons) if (p.target && p.target.e === null) delete p.target.e;
    const I = this.intel, s = d.intel;
    for (const r of s.structs) { const e = ent.get(r.id); if (e) I.structs.set(r.id, { ...r, e, spec: e.spec }); }
    Object.assign(I, { comp: s.comp, enemyTier: s.enemyTier, firstRushT: s.firstRushT, firstT2T: s.firstT2T, seenIds: new Set(s.seen), evSeen: 0 });
    I.loss.set(s.loss); I.kill.set(s.kill);
    this.say('ПАМЯТЬ', 'Игра загружена: восстанавливаю стратегию, взводы и разведданные.');
  }

  // ---------------------------------------------------------------- end of match: long-term learning
  finalize() {
    if (this.finalized) return;
    this.finalized = true;
    const g = this.g, won = (g.over.winners || [g.over.winner]).includes(this.team);
    const m = this.ltm = loadLTM();
    m.games++; if (won) m.wins++; else m.losses++;
    const mp = m.maps[g.map.id] = m.maps[g.map.id] || { strats: {} };
    const st = mp.strats[this.initialStrategy] = mp.strats[this.initialStrategy] || { n: 0, w: 0 };
    st.n++; if (won) st.w++;
    const c = this.intel.comp, tot = c.land + c.air + c.naval;
    const p = m.profile, a = p.n ? 0.3 : 1;
    if (tot > 5) { p.air = p.air * (1 - a) + c.air / tot * a; p.naval = p.naval * (1 - a) + c.naval / tot * a; p.land = p.land * (1 - a) + c.land / tot * a; }
    if (this.intel.firstRushT) p.rushT = p.rushT * (1 - a) + this.intel.firstRushT * a;
    if (this.intel.firstT2T) p.t2T = p.t2T * (1 - a) + this.intel.firstT2T * a;
    p.n++;
    m.history.unshift({ date: Date.now(), map: g.map.id, strat: this.initialStrategy, result: won ? 'win' : 'loss', dur: Math.round(g.time), team: this.team });
    m.history = m.history.slice(0, 15);
    saveLTM(m);
    this.say('ПАМЯТЬ', `Итог матча записан в долговременную память: «${STRATEGIES[this.initialStrategy].name}» — ${won ? 'ПОБЕДА' : 'поражение'}. Профиль противника обновлён.`);
  }
}
