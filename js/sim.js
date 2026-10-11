// Core deterministic-ish simulation: entities, economy, construction, combat, vision.
import { UNITS, STRUCTS, ENH, TPS, DT, UNIT_CAP, chainCost, unitSpec, nukeDamage, baseKey } from './specs.js';
import { Terrain, PN, PCELL } from './terrain.js';
import { MAP_SIZE } from './maps.js';
import * as Brain from './unitai.js';
import * as Nav from './nav.js';
import { LB, LAYER_IDX, wMask, hitMask, splashMask } from './layers.js';

const G = 60; // projectile gravity
const TAU = Math.PI * 2;
export const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };
const hyp2 = (x, y) => Math.sqrt(x * x + y * y);
export const dist = (a, b) => hyp2(a.x - b.x, a.y - b.y);

// ------------------------------------------------------------ spatial hash
// Counting-sorted grid: entities are laid out cell by cell in flat arrays, so a query is one contiguous slice per
// grid row and rejects most candidates from typed arrays alone (x, y, radius, team, flags, spec speed) without
// touching the entity objects. insert()/clear()/query() keep the old API; step() rebuilds it once per tick
// (build() is implicit on the first query after an insert).
const HCS = 16, HN = MAP_SIZE / HCS, HINV = 1 / HCS;
// flags per entry (refreshed after movement): what a scan can decide without loading the entity
const F_UNIT = 1, F_STRUCT = 2, F_AIR = 4, F_MOVER = 8 /* speed > 1 and has a move target */, F_MOVING = 16 /* speed > 0.6 */, F_DEAD = 32;
class SpatialHash {
  constructor() {
    this.n = HN; this.cs = HCS;
    this.start = new Int32Array(HN * HN + 1); this.fillPos = new Int32Array(HN * HN);
    this.pend = []; this.np = 0; this.items = []; this.len = 0; this.dirty = false; this.maxR = 0; this.maxUR = 0; this.maxSR = 0;
    this.cap = 0; this.xs = this.ys = this.rs = this.sp = this.fl = this.tm = null; this.cellOf = null;
    this.rk = new Int32Array(HN * 2 + 2);                   // scratch: [k0, k1) slice per row of the last rows() call
  }
  clear() { this.np = 0; this.dirty = true; }
  insert(e) { this.pend[this.np++] = e; this.dirty = true; }
  _meta(k, e) {
    this.xs[k] = e.x; this.ys[k] = e.y;
    this.fl[k] = !e.alive ? F_DEAD : e.kind === 'struct' ? F_STRUCT
      : F_UNIT | (e.spec.move === 'air' ? F_AIR : 0) | (e.speed > 1 && e.moveTarget ? F_MOVER : 0) | (e.speed > 0.6 ? F_MOVING : 0);
  }
  build() {
    this.dirty = false;
    const P = this.pend, m = this.np, nc = HN * HN;
    if (m > this.cap) {
      this.cap = Math.max(m + 256, this.cap * 2);
      this.xs = new Float32Array(this.cap); this.ys = new Float32Array(this.cap); this.rs = new Float32Array(this.cap);
      this.sp = new Float32Array(this.cap); this.fl = new Uint8Array(this.cap); this.tm = new Uint8Array(this.cap);
      this.cellOf = new Int32Array(this.cap);
    }
    const start = this.start, fp = this.fillPos, cellOf = this.cellOf, items = this.items, rs = this.rs, sp = this.sp, tm = this.tm;
    start.fill(0);
    let maxUR = 0, maxSR = 0;
    for (let i = 0; i < m; i++) {
      const e = P[i];
      let ci = (e.x * HINV) | 0, cj = (e.y * HINV) | 0;
      ci = ci < 0 ? 0 : ci >= HN ? HN - 1 : ci; cj = cj < 0 ? 0 : cj >= HN ? HN - 1 : cj;
      const c = cj * HN + ci; cellOf[i] = c; start[c + 1]++;
    }
    for (let c = 0; c < nc; c++) start[c + 1] += start[c];
    fp.set(start.subarray(0, nc));
    while (items.length < m) items.push(null);   // never shrunk: entries past `len` are simply not read
    for (let i = 0; i < m; i++) {
      const e = P[i], k = fp[cellOf[i]]++, s = e.spec, r = s.radius || 0;
      items[k] = e; rs[k] = r; sp[k] = s.speed || 0; tm[k] = e.team;
      if (e.kind === 'struct') { if (r > maxSR) maxSR = r; } else if (r > maxUR) maxUR = r;
      this._meta(k, e);
    }
    this.len = m; this.maxUR = maxUR; this.maxSR = maxSR; this.maxR = Math.max(maxUR, maxSR);
  }
  // Re-read positions and movement flags (units moved since build(); cell membership may lag by a step, which is harmless).
  refresh() {
    if (this.dirty) this.build();
    const items = this.items;
    for (let k = 0, m = this.len; k < m; k++) this._meta(k, items[k]);
  }
  // Fill this.rk with one [k0,k1) slice per grid row covering the square (x±r, y±r); returns the row count.
  rows(x, y, r) {
    if (this.dirty) this.build();
    const start = this.start, rk = this.rk;
    let x0 = ((x - r) * HINV) | 0, x1 = ((x + r) * HINV) | 0, y0 = ((y - r) * HINV) | 0, y1 = ((y + r) * HINV) | 0;
    if (x - r < 0) x0 = 0; if (y - r < 0) y0 = 0;
    if (x1 >= HN) x1 = HN - 1; if (y1 >= HN) y1 = HN - 1;
    let q = 0;
    for (let j = y0; j <= y1; j++) { const b = j * HN; rk[q++] = start[b + x0]; rk[q++] = start[b + x1 + 1]; }
    return q >> 1;
  }
  // Entities whose circle (radius from spec) touches the disc (x, y, r).
  query(x, y, r, out) {
    out.length = 0;
    const nr = this.rows(x, y, r + this.maxR), rk = this.rk, items = this.items, xs = this.xs, ys = this.ys, rs = this.rs;
    for (let q = 0; q < nr; q++) {
      for (let k = rk[2 * q], k1 = rk[2 * q + 1]; k < k1; k++) {
        const dx = xs[k] - x, dy = ys[k] - y, rr = r + rs[k];
        if (dx * dx + dy * dy <= rr * rr) out.push(items[k]);
      }
    }
    return out;
  }
}

// ------------------------------------------------------------ economy
export class Economy {
  constructor(mult = 1) {
    this.mult = mult;
    this.mass = 650; this.energy = 4000; this.maxMass = 650; this.maxEnergy = 4000;
    this.incM = 1; this.incE = 20; this.upkeep = 0;
    this.baseM = 1; this.baseUp = 0; this.fabM = 0; this.fabE = 0; this.fabOn = true;
    this.reqM = 0; this.reqE = 0; this.prevReqM = 0; this.prevReqE = 0;
    this.effM = 1; this.effE = 1; this.eff = 1;
    this.spendM = 0; this.spendE = 0; this._sm = 0; this._se = 0;
    this.wastedM = 0; this.collectedM = 0; this.spentTotalM = 0;
  }
  begin() {
    // mass fabricators switch off below 8% energy storage and back on above 30% (like SupCom)
    if (this.fabM) { if (this.fabOn && this.energy < this.maxEnergy * 0.08) this.fabOn = false; else if (!this.fabOn && this.energy > this.maxEnergy * 0.3) this.fabOn = true; }
    this.incM = this.baseM + (this.fabOn ? this.fabM : 0);
    this.upkeep = this.baseUp + (this.fabOn ? this.fabE : 0);
    this.mass += this.incM * this.mult * DT;
    this.energy += (this.incE * this.mult - this.upkeep) * DT;
    this.energyOut = this.energy < 0;
    if (this.energy < 0) this.energy = 0;
    this.collectedM += this.incM * this.mult * DT;
    this.effM = this.prevReqM > 0 ? Math.min(1, this.mass / this.prevReqM) : 1;
    this.effE = this.prevReqE > 0 ? Math.min(1, this.energy / this.prevReqE) : 1;
    this.eff = Math.min(this.effM, this.effE);
  }
  // Request a stream of resources for one tick. Returns fraction granted (0..1).
  spend(m, e) {
    this.reqM += m; this.reqE += e;
    const f = this.eff;
    const pm = m * f, pe = e * f;
    this.mass = Math.max(0, this.mass - pm); this.energy = Math.max(0, this.energy - pe);
    this._sm += pm; this._se += pe; this.spentTotalM += pm;
    return f;
  }
  add(m, e) {
    this.mass += m; this.energy += e;
  }
  end() {
    this.prevReqM = this.reqM; this.prevReqE = this.reqE; this.reqM = 0; this.reqE = 0;
    this.spendM = this.spendM * 0.95 + this._sm * TPS * 0.05; this.spendE = this.spendE * 0.95 + this._se * TPS * 0.05;
    this._sm = 0; this._se = 0;
    if (this.mass > this.maxMass) { this.wastedM += this.mass - this.maxMass; this.mass = this.maxMass; }
    if (this.energy > this.maxEnergy) this.energy = this.maxEnergy;
  }
  get stallM() { return this.effM < 0.99; }
  get stallE() { return this.effE < 0.99 || this.energyOut; }
}

// ------------------------------------------------------------ entities
function initWeapons(spec) { return (spec.weapons || []).map((w, i) => ({ w, i, cd: Math.random() * (1 / w.rof), target: null, yaw: 0, pitch: 0, aam: w.targets.includes('missile') })); }

export class Unit {
  constructor(g, key, team, x, y) {
    const s = unitSpec(key);
    this.id = g.nextId++; this.kind = 'unit'; this.key = key; this.spec = s; this.team = team;
    if (key === 'acu' || key === 'sacu') { this.enh = {}; this.enhProg = {}; }
    this.pshield = s.pshield ? { hp: s.pshield.hp, max: s.pshield.hp, regen: s.pshield.regen, r: s.pshield.r, down: 0, flash: 0 } : null;
    this.cargo = s.cargo ? [] : null; this.carried = null; this.vet = 0; this.vetXP = 0; this.assistBP = 0;
    this.x = x; this.y = y; this.px = x; this.py = y;
    this.yaw = Math.atan2(MAP_SIZE / 2 - y, MAP_SIZE / 2 - x); this.pyaw = this.yaw;
    this.z = s.move === 'air' ? 0 : 0; this.pz = this.z; this.bank = 0; this.pitch = 0;
    this.speed = 0; this.vx = 0; this.vy = 0;
    this.hp = s.hp; this.maxHp = s.hp; this.alive = true;
    this.orders = []; this.weapons = initWeapons(s);
    this.moveTarget = null; this.focus = null; this.beam = null;
    this.vis = [1, 0, 0, 0, 0]; this.rad = [0, 0, 0, 0, 0];
    this.brain = Brain.createBrain(this, g);
    this.lastHit = -999; this.kills = 0; this.incDps = 0;
    this.ocCd = 0; this.selected = false; this.platoon = null; this.stuck = 0;
    this.born = g.time;
  }
}

// Build preset from placed structures: offsets from an anchor (an extractor if there is one, else the biggest building);
// upgraded buildings are stored as their buildable base (mex3 -> mex). name = kinds and counts, e.g. "MEX + 4×MSTO".
export function makePreset(structs) {
  const list = structs.map(s => ({ key: baseKey(s.key), x: s.x, y: s.y }));
  const a = list.find(s => STRUCTS[s.key].place === 'mex') || list.reduce((b, s) => STRUCTS[s.key].size > STRUCTS[b.key].size ? s : b);
  const items = [a, ...list.filter(s => s !== a)].map(s => ({ key: s.key, dx: s.x - a.x, dy: s.y - a.y }));
  const cnt = new Map(); for (const it of items) cnt.set(it.key, (cnt.get(it.key) || 0) + 1);
  const name = [...cnt].map(([k, n]) => (n > 1 ? n + '×' : '') + STRUCTS[k].short).join(' + ');
  return { name, items };
}

export class Structure {
  constructor(g, key, team, x, y) {
    const s = STRUCTS[key];
    this.id = g.nextId++; this.kind = 'struct'; this.key = key; this.spec = s; this.team = team;
    this.x = x; this.y = y; this.px = x; this.py = y; this.yaw = 0; this.pyaw = 0; this.z = 0;
    this.hp = 1; this.maxHp = s.hp; this.alive = true; this.built = false; this.progress = 0;
    this.queue = []; this.repeat = false; this.prog = 0; this.assistBP = 0; this.rally = null; this.upgrading = null;
    this.weapons = initWeapons(s);
    this.shield = s.shield ? { hp: 0, max: s.shield.hp, r: s.shield.radius, on: false, flash: 0 } : null;
    this.vis = [1, 0, 0, 0, 0]; this.rad = [0, 0, 0, 0, 0]; this.seen = [1, 0, 0, 0, 0];
    this.lastHit = -999; this.incDps = 0; this.selected = false; this.focus = null; this.bestT = 0; this.kills = 0;
    this.orders = [];
    this.exit = null;
    // missile silo (SML / SMD / TML): stock counter + build progress of the next missile; doors open while launching
    this.silo = s.silo ? { stock: 0, prog: 0, cd: 0 } : null;
    this.doorOpen = 0; this.openT = 0; this.launch = null;
  }
}

// ------------------------------------------------------------ game
export class Game {
  constructor(map, opts = {}) {
    this.map = map;
    this.opts = Object.assign({ fog: true, victory: 'assassination', playerTeam: 1, unitCap: UNIT_CAP }, opts);
    if (!(this.opts.unitCap > 0)) this.opts.unitCap = UNIT_CAP;
    this.unitCap = Math.min(this.opts.unitCap, 4000);   // per team; factories stop producing at the cap
    this.terrain = new Terrain(map);
    this.units = []; this.structs = []; this.wrecks = []; this.projectiles = [];
    this.fgroups = new Map(); this.fgSeq = 0;   // группы строя: id -> { set, tick, mean } (не сохраняется: после загрузки o.fg без группы = без регулировки скорости)
    this.fx = []; this.sounds = []; this.notes = []; this.impacts = []; this.events = [];
    this.nextId = 1; this.tick = 0; this.time = 0;
    this.hash = new SpatialHash();
    this._q = []; this._q2 = [];
    this.controllers = [];
    this._over = null;
    this.teams = {}; this.teamList = [];
    const teamDefs = this.opts.teams || [{ id: 1, ai: false }, { id: 2, ai: true }];
    // стартовые точки: явный start, иначе первая свободная в порядке, разводящем игроков (для двоих — старые 0 и 1)
    // стороны карты: старты 0, 2 — одна, 1, 3 — другая; союзники садятся на сторону своего союза, остальные — на более свободную
    const taken = new Set(teamDefs.map(t => t.start).filter(v => v !== undefined)), order = [0, 1, 2, 3].filter(i => i < map.starts.length);
    const side = {}, free = (s) => order.filter(k => k % 2 === s && !taken.has(k)).length;
    for (const t of teamDefs) if (t.ally && t.start !== undefined) side[t.ally] ??= t.start % 2;
    teamDefs.forEach((t, i) => {
      let si = t.start;
      if (si === undefined) {
        const pref = t.ally && side[t.ally] !== undefined ? side[t.ally] : free(1) > free(0) ? 1 : 0;
        si = order.find(k => !taken.has(k) && k % 2 === pref) ?? order.find(k => !taken.has(k)); if (si === undefined) si = i % map.starts.length; taken.add(si);
      }
      if (t.ally) side[t.ally] ??= si % 2;
      this.teams[t.id] = {
        id: t.id, ai: !!t.ai, ally: t.ally || 0, start: map.starts[si], eco: new Economy(t.resMult || 1), alive: true,
        autonomy: t.autonomy || 'full', autoOC: t.autoOC !== false, difficulty: t.difficulty || 'normal',
        vis: new Uint8Array(PN * PN), explored: new Uint8Array(PN * PN), radar: new Uint8Array(PN * PN), sonar: new Uint8Array(PN * PN),
        stats: { built: 0, lost: 0, kills: 0, massLost: 0, massKilled: 0, structs: 0 },
        acu: null, unitCount: 0, lastAlert: -99
      };
    });
    this.teamList = Object.values(this.teams);
    // матрица союзов a*8+b (общая для хэша, зрения и ИИ): сам с собой и одинаковый ненулевой ally
    this.al = new Uint8Array(64);
    for (const a of this.teamList) for (const b of this.teamList) if (a === b || (a.ally && a.ally === b.ally)) this.al[a.id * 8 + b.id] = 1;
    this.adjDirty = true;
    if (this.opts.restore) return; // Game.restore() fills the world from a save
    for (const t of Object.values(this.teams)) {
      const acu = this.spawnUnit('acu', t.id, t.start.x, t.start.y);
      t.acu = acu;
      this.fx.push({ type: 'warp', x: acu.x, y: acu.y, z: this.terrain.heightAt(acu.x, acu.y), team: t.id });
    }
    this.recalcIncome();
    this.updateVision();
  }

  // ---------------------------------------------------------- helpers
  allied(a, b) { return a === b || this.al[a * 8 + b] === 1; }
  isEnemy(a, b) { return !this.allied(a, b); }
  enemies(team) { return this.teamList.filter(t => !this.allied(team, t.id)); }
  groundZ(e) {
    const t = this.terrain;
    if (e.kind === 'struct') return e.spec.place === 'water' ? t.water : t.heightAt(e.x, e.y);
    const s = e.spec;
    if (s.move === 'air') return t.surfaceAt(e.x, e.y) + e.z;
    if (s.move === 'naval') return s.sub ? t.water - 2.2 : t.water;
    if (s.move === 'hover') return t.surfaceAt(e.x, e.y);
    return t.heightAt(e.x, e.y);
  }
  layerOf(e) {
    if (e.kind === 'struct') return e.spec.layer;
    if (e.spec.move === 'amph' && this.terrain.depthAt(e.x, e.y) > 2.5) return 'sub';
    return e.spec.layer;
  }
  layerBitOf(e) {
    const s = e.spec;
    if (s.move === 'amph' && e.kind === 'unit' && this.terrain.depthAt(e.x, e.y) > 2.5) return LB.sub;
    return LB[s.layer];
  }

  // ---------------------------------------------------------- threat fields (cheap "how much can hurt me here")
  // Rebuilt every 9 ticks on a 16-unit grid: for each viewing team the summed power of the enemies it can see, split by
  // the layer they can hit, spread over the discs they cover (range + 18), plus a splash-weapon count and each team's own
  // power. Unit brains read a cell instead of scanning hundreds of neighbours.
  updateThreat() {
    const NN = HN * HN, th = this._thr || (this._thr = {});
    this._thrT = this.tick;
    for (const T of this.teamList) {
      const t = th[T.id] || (th[T.id] = { pow: new Float32Array(NN * 4), spl: new Uint8Array(NN * 4), own: new Float32Array(NN) });
      t.pow.fill(0); t.spl.fill(0); t.own.fill(0);
    }
    const fog = this.opts.fog, teams = this.teamList, al = this.al;
    const one = (e) => {
      if (!e.alive || e.carried) return;
      const pw = Brain.powerOf(e);
      if (pw <= 0) return;
      const ci = Math.min(HN - 1, Math.max(0, (e.x * HINV) | 0)), cj = Math.min(HN - 1, Math.max(0, (e.y * HINV) | 0));
      for (let vi = 0; vi < teams.length; vi++) if (al[teams[vi].id * 8 + e.team]) th[teams[vi].id].own[cj * HN + ci] += pw;   // союзная мощь тоже «своя»
      const S = e.spec;
      if (!(S.dps > 0)) return;
      const hm = hitMask(S), sm = splashMask(S), R = S.maxRange + 18, R2 = R * R;
      const x0 = Math.max(0, ((e.x - R) * HINV) | 0), x1 = Math.min(HN - 1, ((e.x + R) * HINV) | 0);
      const y0 = Math.max(0, ((e.y - R) * HINV) | 0), y1 = Math.min(HN - 1, ((e.y + R) * HINV) | 0);
      for (let vi = 0; vi < teams.length; vi++) {
        const V = teams[vi].id;
        if (al[V * 8 + e.team] || (fog && !(e.vis[V] > 0) && !e.rad[V])) continue;
        const pow = th[V].pow, spl = th[V].spl;
        for (let j = y0; j <= y1; j++) {
          const dy = j * HCS + HCS / 2 - e.y, dy2 = dy * dy;
          if (dy2 > R2) continue;
          for (let i = x0; i <= x1; i++) {
            const dx = i * HCS + HCS / 2 - e.x;
            if (dx * dx + dy2 > R2) continue;
            const c = j * HN + i;
            for (let l = 0; l < 4; l++) if ((hm >> l) & 1) { pow[l * NN + c] += pw; if ((sm >> l) & 1) spl[l * NN + c] = 1; }
          }
        }
      }
    };
    for (let i = 0; i < this.units.length; i++) one(this.units[i]);
    for (let i = 0; i < this.structs.length; i++) one(this.structs[i]);
  }
  // Power of the enemies (visible to `team`) that can hit layer `bit` at (x, y); >0 splash flag in `.splash`.
  threatAt(team, bit, x, y) {
    if (this.tick - (this._thrT ?? -99) >= 9) this.updateThreat();
    const t = this._thr[team]; if (!t) return 0;
    const c = Math.min(HN - 1, Math.max(0, (y * HINV) | 0)) * HN + Math.min(HN - 1, Math.max(0, (x * HINV) | 0));
    const l = LAYER_IDX[bit] * HN * HN + c;
    this.splashNear = t.spl[l] > 0;
    return t.pow[l];
  }
  // Own team's summed power within ~r of (x, y).
  friendPowAt(team, x, y, r) {
    const t = this._thr && this._thr[team]; if (!t) return 0;
    const own = t.own, cx = (x * HINV) | 0, cy = (y * HINV) | 0, k = Math.ceil(r * HINV), r2 = (r + HCS * 0.5) * (r + HCS * 0.5);
    let sum = 0;
    for (let j = Math.max(0, cy - k); j <= Math.min(HN - 1, cy + k); j++) {
      const dy = j * HCS + HCS / 2 - y;
      for (let i = Math.max(0, cx - k); i <= Math.min(HN - 1, cx + k); i++) {
        const dx = i * HCS + HCS / 2 - x;
        if (dx * dx + dy * dy <= r2) sum += own[j * HN + i];
      }
    }
    return sum;
  }
  // Match end lifts the fog of war for everyone (every opts.fog check then sees the whole map).
  get over() { return this._over; }
  set over(v) { this._over = v; if (v) this.opts.fog = false; }
  visibleTo(team, e) { return !this.opts.fog || this.al[team * 8 + e.team] === 1 || e.vis[team] > 0; }
  seenBy(team, e) { return !this.opts.fog || this.al[team * 8 + e.team] === 1 || e.vis[team] > 0 || (e.kind === 'struct' && e.seen[team]); }
  queryAll(x, y, r) { return this.hash.query(x, y, r, []); }

  // Enemies of `team` near (x,y) visible to that team (fresh array unless `out` is given and reused).
  enemiesNear(team, x, y, r, radarOk = false, out = []) {
    const H = this.hash, fog = this.opts.fog, al = this.al, ab = team * 8;
    let m = 0;
    const nr = H.rows(x, y, r + H.maxR), rk = H.rk, items = H.items, xs = H.xs, ys = H.ys, rs = H.rs, tm = H.tm, fl = H.fl;
    for (let q = 0; q < nr; q++) {
      for (let k = rk[2 * q], k1 = rk[2 * q + 1]; k < k1; k++) {
        if (al[ab + tm[k]] || (fl[k] & F_DEAD)) continue;
        const dx = xs[k] - x, dy = ys[k] - y, rr = r + rs[k];
        if (dx * dx + dy * dy > rr * rr) continue;
        const e = items[k];
        if (!e.alive) continue;
        if (fog && !(e.vis[team] > 0) && !(radarOk && e.rad[team])) continue;
        out[m++] = e;
      }
    }
    if (out.length !== m) out.length = m;
    return out;
  }
  friendsNear(team, x, y, r, out = []) {
    const H = this.hash, al = this.al, ab = team * 8;
    let m = 0;
    const nr = H.rows(x, y, r + H.maxR), rk = H.rk, items = H.items, xs = H.xs, ys = H.ys, rs = H.rs, tm = H.tm, fl = H.fl;
    for (let q = 0; q < nr; q++) {
      for (let k = rk[2 * q], k1 = rk[2 * q + 1]; k < k1; k++) {
        if (!al[ab + tm[k]] || (fl[k] & F_DEAD)) continue;
        const dx = xs[k] - x, dy = ys[k] - y, rr = r + rs[k];
        if (dx * dx + dy * dy > rr * rr) continue;
        const e = items[k];
        if (e.alive) out[m++] = e;
      }
    }
    if (out.length !== m) out.length = m;
    return out;
  }
  // Brain scan for a mobile unit: widen the search ring (44 -> 88 -> scan) only while few enemies are found, then keep
  // the `cap` nearest. In a big battle this is O(neighbourhood) instead of O(everything in weapon range).
  nearEnemies(u, scan, out, cap) {
    let r = scan > 44 ? 44 : scan;
    for (;;) {
      this.enemiesNear(u.team, u.x, u.y, r, true, out);
      if (out.length >= 6 || r >= scan) break;
      r = r * 2 > scan ? scan : r * 2;
    }
    if (out.length > cap) this._keepNearest(out, u.x, u.y, cap);
    return out;
  }
  _keepNearest(out, x, y, cap) {
    const n = out.length;
    if (!this._kd || this._kd.length < n) { this._kd = new Float64Array(n * 2); this._kt = new Float64Array(n * 2); }
    const d = this._kd, t = this._kt;
    for (let i = 0; i < n; i++) { const e = out[i], dx = e.x - x, dy = e.y - y; t[i] = d[i] = dx * dx + dy * dy; }
    // quickselect the cap-th smallest squared distance
    let lo = 0, hi = n - 1; const kth = cap - 1;
    while (lo < hi) {
      const piv = t[(lo + hi) >> 1]; let i = lo, j = hi;
      while (i <= j) {
        while (t[i] < piv) i++;
        while (t[j] > piv) j--;
        if (i <= j) { const v = t[i]; t[i] = t[j]; t[j] = v; i++; j--; }
      }
      if (kth <= j) hi = j; else if (kth >= i) lo = i; else break;
    }
    const thr = t[kth];
    let m = 0;
    for (let i = 0; i < n && m < cap; i++) if (d[i] <= thr) out[m++] = out[i];
    out.length = m;
  }
  notify(team, text, x, y, kind = 'info') {
    this.notes.push({ team, text, x, y, kind, t: this.time });
    if (this.notes.length > 60) this.notes.shift();
  }
  sound(kind, x, y) { if (this.sounds.length < 40) this.sounds.push({ kind, x, y }); }

  // ---------------------------------------------------------- spawning
  spawnUnit(key, team, x, y) {
    const u = new Unit(this, key, team, x, y);
    if (u.spec.move === 'air') u.z = 2;
    this.units.push(u);
    this.teams[team].stats.built++;
    return u;
  }

  canPlace(team, key, x, y) {
    const s = STRUCTS[key];
    const t = this.terrain, h = s.size / 2;
    if (s.place === 'mex') {
      let best = null, bd = 8;
      for (const m of t.mass) { const d = Math.hypot(m.x - x, m.y - y); if (d < bd) { bd = d; best = m; } }
      if (!best) return { ok: false, why: 'Нужно месторождение массы' };
      if (this.structs.some(o => o.alive && Math.abs(o.x - best.x) < (o.spec.size / 2 + h) && Math.abs(o.y - best.y) < (o.spec.size / 2 + h)))
        return { ok: false, why: 'Месторождение занято', x: best.x, y: best.y };
      return { ok: true, x: best.x, y: best.y };
    }
    x = Math.round(x / 2) * 2; y = Math.round(y / 2) * 2;
    if (x - h < 12 || y - h < 12 || x + h > MAP_SIZE - 12 || y + h > MAP_SIZE - 12) return { ok: false, why: 'Край карты', x, y };
    const dom = s.place === 'water' ? 'naval' : 'land';
    for (let yy = y - h + 1; yy <= y + h - 1; yy += 3) for (let xx = x - h + 1; xx <= x + h - 1; xx += 3) {
      if (!t.terrainPass(dom, xx, yy)) return { ok: false, why: s.place === 'water' ? 'Нужна глубокая вода' : 'Неровная поверхность', x, y };
    }
    // buildings may touch (adjacency bonuses), never overlap
    for (const o of this.structs) {
      if (!o.alive) continue;
      const oh = o.spec.size / 2;
      if (Math.abs(o.x - x) < oh + h - 0.01 && Math.abs(o.y - y) < oh + h - 0.01) return { ok: false, why: 'Мешает другое здание', x, y };
    }
    for (const m of t.mass) {
      if (Math.abs(m.x - x) >= h + 4 || Math.abs(m.y - y) >= h + 4) continue;
      if (m === this._planMex) continue;   // orderPreset: extractor ordered here a moment ago
      if (!this.structs.some(o => o.alive && o.spec.place === 'mex' && o.x === m.x && o.y === m.y)) return { ok: false, why: 'Не блокируйте месторождение', x, y };
    }
    return { ok: true, x, y };
  }

  // ---------------------------------------------------------- adjacency (SupCom): touching buildings boost each other
  static adjacent(a, b) {
    const h = (a.spec.size + b.spec.size) / 2, dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    return (dx <= h + 2.5 && dy < h - 1) || (dy <= h + 2.5 && dx < h - 1);
  }
  // Bonus that neighbour `b` gives to structure `s` (fields multiply/add into s.adj).
  static adjBonus(s, b) {
    const S = s.spec, B = b.spec, out = {};
    if ((S.mass || S.fabM) && b.key === 'mstore') out.m = 0.125;
    if (S.energy && b.key === 'estore') out.e = 0.125;
    const usesE = S.eUse || S.fabE || S.produces || S.shield || S.silo;
    if (usesE && B.energy) out.eCost = { 1: 0.08, 2: 0.2, 3: 0.4 }[B.tier] || 0.08;
    if (S.produces && B.place === 'mex') out.mCost = { 1: 0.025, 2: 0.05, 3: 0.075 }[B.tier];
    if (S.produces && B.fabM) out.mCost = B.tier >= 3 ? 0.15 : 0.05;
    return out;
  }
  // What `key` placed at (x,y) would gain / give — for the build ghost tooltip.
  previewAdjacency(team, key, x, y) {
    const probe = { key, x, y, spec: STRUCTS[key] };
    const acc = { m: 0, e: 0, eCost: 0, mCost: 0, give: 0 };
    for (const o of this.structs) {
      if (!o.alive || o.team !== team || !Game.adjacent(probe, o)) continue;
      const b = Game.adjBonus(probe, o); for (const k in b) acc[k] += b[k];
      const g = Game.adjBonus(o, probe); if (Object.keys(g).length) acc.give++;
    }
    return acc;
  }
  updateAdjacency() {
    this.adjDirty = false;
    const list = this.structs.filter(s => s.alive && s.built);
    for (const s of list) s.adj = { m: 1, e: 1, eCost: 1, mCost: 1, n: [] };
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.team !== b.team || !Game.adjacent(a, b)) continue;
      for (const [s, o] of [[a, b], [b, a]]) {
        const bn = Game.adjBonus(s, o);
        if (!Object.keys(bn).length) continue;
        s.adj.n.push(o.id);
        s.adj.m += bn.m || 0; s.adj.e += bn.e || 0;
        s.adj.eCost -= bn.eCost || 0; s.adj.mCost -= bn.mCost || 0;
      }
    }
    for (const s of list) { s.adj.eCost = Math.max(0.4, s.adj.eCost); s.adj.mCost = Math.max(0.6, s.adj.mCost); }
  }

  placeStructure(team, key, x, y, built = false) {
    const s = new Structure(this, key, team, x, y);
    this.structs.push(s); this.adjDirty = true;
    this.terrain.setBlocked(x, y, s.spec.size, +1);
    // factory exit toward map centre / open water
    if (s.spec.produces) {
      const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      dirs.sort((a, b) => ((MAP_SIZE / 2 - x) * b[0] + (MAP_SIZE / 2 - y) * b[1]) - ((MAP_SIZE / 2 - x) * a[0] + (MAP_SIZE / 2 - y) * a[1]));
      const dom = s.spec.produces === 'naval' ? 'naval' : 'land';
      const off = s.spec.size / 2 + 5;
      s.exit = null;
      for (const d of dirs) {
        const ex = x + d[0] * off, ey = y + d[1] * off;
        if (s.spec.produces === 'air' || this.terrain.passableAt(dom, ex, ey)) { s.exit = { x: ex, y: ey }; break; }
      }
      if (!s.exit) s.exit = { x: x + dirs[0][0] * off, y: y + dirs[0][1] * off };
      s.yaw = s.pyaw = Math.atan2(s.exit.y - y, s.exit.x - x);   // модель стоит воротами (+X) к выходу
    }
    // nudge units out of the footprint
    for (const u of this.units) {
      if (u.spec.move === 'air') continue;
      const h = s.spec.size / 2 + u.spec.radius;
      if (Math.abs(u.x - x) < h && Math.abs(u.y - y) < h) {
        const ax = u.x - x, ay = u.y - y;
        if (Math.abs(ax) > Math.abs(ay)) u.x = x + Math.sign(ax || 1) * (h + 1); else u.y = y + Math.sign(ay || 1) * (h + 1);
      }
    }
    if (built) { s.built = true; s.progress = 1; s.hp = s.maxHp; this.onBuilt(s, true); }
    return s;
  }

  onBuilt(s, silent) {
    const T = this.teams[s.team];
    T.stats.structs++; this.adjDirty = true;
    if (s.spec.spawnsUnit) {
      s.alive = false; s.hp = 0; this.terrain.setBlocked(s.x, s.y, s.spec.size, -1);
      const u = this.spawnUnit(s.spec.spawnsUnit, s.team, s.x, s.y);
      if (u.spec.move === 'air') u.z = 10;
      this.fx.push({ type: 'warp', x: s.x, y: s.y, z: this.terrain.heightAt(s.x, s.y), team: s.team, big: true });
      this.notify(s.team, 'Экспериментальный юнит готов!', s.x, s.y, 'good');
      for (const e of this.enemies(s.team)) this.notify(e.id, 'ВНИМАНИЕ: противник построил экспериментальный юнит!', s.x, s.y, 'alert');
      this.events.push({ type: 'unitBuilt', unit: u, team: s.team });
      return;
    }
    if (s.shield) { s.shield.hp = s.shield.max * 0.3; s.shield.on = true; }
    this.recalcIncome();
    if (!silent) {
      this.fx.push({ type: 'built', x: s.x, y: s.y, z: this.groundZ(s), size: s.spec.size, team: s.team });
      this.sound('built', s.x, s.y);
      if (s.spec.produces || s.spec.tier >= 2) this.notify(s.team, 'Построено: ' + s.spec.name, s.x, s.y, 'good');
    }
  }

  recalcIncome() {
    if (this.adjDirty) this.updateAdjacency();
    const res = {};   // resource enhancements (ACU / sACU) per team
    for (const u of this.units) if (u.alive && u.spec.resM) { const r = res[u.team] || (res[u.team] = { m: 0, e: 0 }); r.m += u.spec.resM; r.e += u.spec.resE; }
    for (const T of Object.values(this.teams)) {
      const acu = T.acu && T.acu.alive ? T.acu : null, r = res[T.id];
      let m = (acu ? 1 : 0) + (r ? r.m : 0), e = (acu ? 20 : 0) + (r ? r.e : 0), up = 0, sm = 650, se = 4000, fm = 0, fe = 0;
      for (const s of this.structs) {
        if (s.team !== T.id || !s.alive || !s.built) continue;
        const a = s.adj || { m: 1, e: 1, eCost: 1 };
        m += (s.spec.mass || 0) * a.m; e += (s.spec.energy || 0) * a.e; up += (s.spec.eUse || 0) * a.eCost;
        fm += (s.spec.fabM || 0) * a.m; fe += (s.spec.fabE || 0) * a.eCost;
        sm += s.spec.storeM || 0; se += s.spec.storeE || 0;
      }
      const eco = T.eco;
      eco.baseM = m; eco.incE = e; eco.baseUp = up; eco.fabM = fm; eco.fabE = fe; eco.maxMass = sm; eco.maxEnergy = se;
      eco.incM = m + (eco.fabOn ? fm : 0); eco.upkeep = up + (eco.fabOn ? fe : 0);
    }
  }

  // ---------------------------------------------------------- orders API
  _assign(units, mk, queue) {
    for (const u of units) {
      if (!u.alive || u.kind !== 'unit' || u.carried) continue;
      const o = mk(u);
      if (!o) continue;
      if (!queue) { u.orders.length = 0; Brain.onNewOrder(u, this); }
      u.orders.push(o);
    }
  }
  // Formation slots. f = { type: line|wedge|column|box|none, spacing (×), facing (rad, null = from centroid), width (world units), queue }
  // Returns Map id -> {x, y, vmax}. Ground groups move at the speed of their slowest member (SupCom formation move).
  formation(units, x, y, f = {}) {
    const out = new Map();
    const groups = { ground: [], naval: [], air: [] };
    for (const u of units) groups[u.spec.move === 'air' ? 'air' : u.spec.move === 'naval' ? 'naval' : 'ground'].push(u);
    const roleOrder = { direct: 0, exp: 0, cmd: 1, naval: 0, sub: 1, aa: 2, arty: 3, eng: 4, scout: 5, transport: 5, fighter: 0, gunship: 1, bomber: 2 };
    const from = (u) => { const o = f.queue && u.orders.length ? u.orders[u.orders.length - 1] : null; return o && o.x !== undefined ? o : u; };
    const type = f.type || 'line';
    for (const [k, list] of Object.entries(groups)) {
      if (!list.length) continue;
      if (list.length === 1) { out.set(list[0].id, { x, y }); continue; }
      let cx = 0, cy = 0; for (const u of list) { const p = from(u); cx += p.x; cy += p.y; } cx /= list.length; cy /= list.length;
      const face = f.facing ?? (Math.hypot(x - cx, y - cy) > 1 ? Math.atan2(y - cy, x - cx) : 0);
      const dx = Math.cos(face), dy = Math.sin(face), px = -dy, py = dx;
      list.sort((a, b) => (roleOrder[a.spec.role] ?? 3) - (roleOrder[b.spec.role] ?? 3));
      const sp = (Math.max(...list.map(u => u.spec.radius)) * 2 + (k === 'air' ? 8 : 4)) * (f.spacing || 1);
      const slots = formationSlots(type, list.length, f.width ? Math.max(1, Math.round(f.width / sp) + 1) : 0);
      let vmax = Infinity;
      if (k === 'ground' && type !== 'none' && list.length >= 3) for (const u of list) vmax = Math.min(vmax, u.spec.speed);
      list.forEach((u, i) => {
        const [c, r] = slots[i];
        out.set(u.id, { x: x + px * c * sp - dx * r * sp, y: y + py * c * sp - dy * r * sp, vmax: isFinite(vmax) ? vmax : 0 });
      });
    }
    return out;
  }
  orderMove(units, x, y, queue = false, type = 'move', form = {}) {
    const f = this.formation(units.filter(u => u.kind === 'unit' && !u.carried), x, y, { ...form, queue });
    let fg = 0, set = null;
    for (const p of f.values()) if (p.vmax) { fg = ++this.fgSeq; set = new Set(); break; }   // регулируемая группа: наземные >= 3, строй != none
    if (fg) {
      if (this.fgroups.size > 64) for (const [k, gr] of this.fgroups) if (![...gr.set].some(u => u.alive && u.orders[0] && u.orders[0].fg === k)) this.fgroups.delete(k);
      this.fgroups.set(fg, { set, tick: -1, mean: 0 });
    }
    this._assign(units, u => { const p = f.get(u.id); if (!p) return null; if (fg && p.vmax) set.add(u); return { type, x: p.x, y: p.y, vmax: p.vmax, ...(fg && p.vmax ? { fg } : null) }; }, queue);
  }
  orderAMove(units, x, y, queue = false, form = {}) { this.orderMove(units, x, y, queue, 'amove', form); }
  // Transports ---------------------------------------------------------------
  cargoUsed(t) { return t.cargo.reduce((a, u) => a + u.spec.slots, 0); }
  canCarry(t, u) { return t.cargo && u.kind === 'unit' && !u.carried && u.team === t.team && u.spec.slots <= t.spec.cargo - this.cargoUsed(t); }
  orderBoard(units, t, queue = false) { this._assign(units.filter(u => u.spec.slots <= t.spec.cargo), () => ({ type: 'board', target: t }), queue); }
  orderPickup(transports, u, queue = false) { this._assign(transports.filter(t => t.cargo), () => ({ type: 'pickup', target: u }), queue); }
  orderUnload(transports, x, y, queue = false) {
    const f = this.formation(transports, x, y, { spacing: 1.5, queue });
    this._assign(transports.filter(t => t.cargo), t => ({ type: 'unload', x: f.get(t.id).x, y: f.get(t.id).y }), queue);
  }
  load(t, u) {
    if (!t.alive || !this.canCarry(t, u)) return false;
    u.carried = t; t.cargo.push(u);
    u.orders.length = 0; u.moveTarget = null; u.speed = 0; u.selected = false; Brain.onNewOrder(u, this);
    this.sound('ui', t.x, t.y);
    return true;
  }
  unloadAll(t, x, y) {
    // a ship drops its troops on the nearest free land within 40 units of itself (the point asked for is usually inland)
    const ship = t.spec.move === 'naval', a = ship && this.freeSpot('land', t.x, t.y, 40);
    if (ship) { if (!a) return 0; x = a.x; y = a.y; }
    const list = t.cargo.slice(), f = this.formation(list, x, y, { type: 'box', spacing: 1.1, facing: t.yaw });
    let n = 0;
    for (const u of list) {
      const p = f.get(u.id) || { x, y };
      const q = this.freeSpot(ship ? 'land' : u.spec.move, p.x, p.y, 40);
      if (!q) continue;
      u.carried = null; u.x = u.px = q.x; u.y = u.py = q.y; u.yaw = u.pyaw = t.yaw; u.brain.home = { x: q.x, y: q.y };
      t.cargo.splice(t.cargo.indexOf(u), 1); n++;
    }
    if (n) { this.fx.push({ type: 'warp', x, y, z: this.terrain.surfaceAt(x, y), team: t.team }); this.sound('ready', x, y); }
    return n;
  }
  freeSpot(domain, x, y, maxR) {
    const t = this.terrain;
    for (let r = 0; r <= maxR; r += 4) for (let a = 0; a < 6.28; a += r ? 4 / r : 7) {
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (t.passableAt(domain, px, py)) return { x: px, y: py };
    }
    return null;
  }
  // ACU enhancements -----------------------------------------------------------
  canEnhance(u, key) {
    const E = ENH[key]; if (!E || !u.enh || E.unit !== u.key) return { ok: false, why: E && E.unit === 'sacu' ? 'Только для командира поддержки' : 'Только для командира' };
    if (u.enh[E.slot] === key) return { ok: false, why: 'Уже установлено' };
    if (E.req && u.enh[E.slot] !== E.req) return { ok: false, why: 'Сначала: ' + ENH[E.req].name };
    return { ok: true };
  }
  orderEnhance(units, key, queue = false) { this._assign(units.filter(u => this.canEnhance(u, key).ok), () => ({ type: 'enhance', key }), queue); }
  applyEnh(u, key) {
    const E = ENH[key], enh = { ...u.enh, [E.slot]: key };
    const ratio = u.hp / u.maxHp, cds = u.weapons.map(w => w.cd);
    u.enh = enh; u.spec = unitSpec(u.key, enh);
    u.maxHp = u.spec.hp; u.hp = Math.max(1, u.maxHp * ratio);
    u.weapons = initWeapons(u.spec); u.weapons.forEach((w, i) => { w.cd = cds[i] ?? 0; });
    const ps = u.spec.pshield;
    u.pshield = ps ? (u.pshield || { hp: ps.hp * 0.3, max: ps.hp, regen: ps.regen, r: ps.r, down: 0, flash: 0 }) : null;
    delete u.enhProg[key];
    this.recalcIncome();
    this.fx.push({ type: 'built', x: u.x, y: u.y, z: this.groundZ(u), size: 6, team: u.team });
    this.sound('built', u.x, u.y);
    this.notify(u.team, (u.key === 'sacu' ? 'Улучшение sACU: ' : 'Улучшение командира: ') + E.name, u.x, u.y, 'good');
    this.events.push({ type: 'enhanced', unit: u, key, team: u.team });
  }
  orderPatrol(units, x, y, queue = false) {
    this._assign(units, u => {
      const last = queue && u.orders.length ? u.orders[u.orders.length - 1] : u;
      return { type: 'patrol', pts: [{ x: last.x, y: last.y }, { x: x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 10 }], idx: 1 };
    }, queue);
  }
  orderAttack(units, target, queue = false) { this._assign(units, u => u.spec.weapons.length ? { type: 'attack', target, lx: target.x, ly: target.y } : null, queue); }
  orderGuard(units, target, queue = false) { this._assign(units.filter(u => u !== target), () => ({ type: 'guard', target }), queue); }
  orderRepair(units, target, queue = false) { this._assign(units, u => u.spec.bp ? { type: 'repair', target } : null, queue); }
  orderAssist(units, target, queue = false) { this._assign(units, u => u.spec.bp ? { type: 'assist', target } : null, queue); }
  orderReclaim(units, target, queue = false) {
    const c = this.canReclaim(target);
    if (!c.ok) return c;
    this._assign(units.filter(u => u !== target), u => u.spec.bp ? { type: 'reclaim', target } : null, queue);
    return c;
  }
  // Engineers can reclaim wrecks / features and (SupCom style) any unit or structure, friendly or hostile, but never commanders.
  canReclaim(t) {
    if (!t || !t.alive) return { ok: false, why: 'Цель уничтожена' };
    if (t.kind === 'unit') {
      if (t.key === 'acu' || t.key === 'sacu') return { ok: false, why: 'Командира нельзя перерабатывать' };
      if (t.carried) return { ok: false, why: 'Юнит в транспорте' };
      if (t.cargo && t.cargo.length) return { ok: false, why: 'В транспорте есть груз' };
      if (t.spec.move === 'air' && t.z > 4) return { ok: false, why: 'Летящую технику нельзя перерабатывать' };
    }
    return { ok: true };
  }
  // Remove a unit / structure that has been fully reclaimed: no wreck, no explosion, no kill credit.
  reclaimed(e) {
    if (!e.alive) return;
    e.alive = false; e.hp = 0;
    const z = this.groundZ(e);
    this.fx.push({ type: 'warp', x: e.x, y: e.y, z, team: e.team });
    this.sound('ready', e.x, e.y);
    if (e.kind === 'unit') Brain.onDeath(e, this);
    else {
      this.adjDirty = true;
      this.terrain.setBlocked(e.x, e.y, e.spec.size, -1);
      this.recalcIncome();
    }
    this.events.push({ type: 'reclaimed', e, key: e.key, team: e.team, x: e.x, y: e.y, kind: e.kind });
  }
  orderBuild(units, key, x, y, queue = false) {
    const c = this.canPlace(units[0]?.team, key, x, y);
    if (!c.ok) return c;
    this._assign(units, u => u.spec.canBuild && u.spec.canBuild.includes(key) ? { type: 'build', key, x: c.x, y: c.y, site: null } : null, queue);
    return c;
  }
  // Build preset (see makePreset) with its anchor at (x, y). An anchor spot already taken by our own building of the same kind
  // is kept as is (storages around an existing extractor). Returns { ok, n, why, x, y }.
  orderPreset(units, preset, x, y, queue = false) {
    const team = units[0]?.team, [a, ...rest] = preset.items;
    const c = this.canPlace(team, a.key, x, y);
    if (c.x === undefined) return c;
    const ax = c.x, ay = c.y, done = [];
    const can = (k) => units.some(u => u.spec.canBuild && u.spec.canBuild.includes(k));
    const order = (k, px, py) => { const r = this.orderBuild(units, k, px, py, queue || done.length > 0); if (r.ok) done.push({ k, x: r.x, y: r.y }); return r; };
    if (c.ok) { if (!can(a.key)) return { ok: false, why: 'Строители не умеют строить ' + STRUCTS[a.key].name }; order(a.key, ax, ay); }
    else if (!this.structs.some(o => o.alive && o.team === team && baseKey(o.key) === a.key && Math.abs(o.x - ax) < 1 && Math.abs(o.y - ay) < 1)) return c;
    this._planMex = STRUCTS[a.key].place === 'mex' ? this.terrain.mass.find(m => m.x === ax && m.y === ay) : null;
    const free = (k, px, py) => done.every(d => { const h = (STRUCTS[d.k].size + STRUCTS[k].size) / 2 - 0.01; return Math.abs(d.x - px) >= h || Math.abs(d.y - py) >= h; });
    for (const it of rest) {
      if (!can(it.key)) continue;
      const sx = it.dx < 0 ? -2 : 2, sy = it.dy < 0 ? -2 : 2;
      // ponytail: anchor spots are not on the 2-unit build grid, so a slot may need a 2-unit nudge outward
      for (const [ox, oy] of [[0, 0], [sx, 0], [0, sy], [sx, sy]]) {
        const p = this.canPlace(team, it.key, ax + it.dx + ox, ay + it.dy + oy);
        if (p.ok && free(it.key, p.x, p.y)) { order(it.key, p.x, p.y); break; }
      }
    }
    this._planMex = null;
    return done.length ? { ok: true, n: done.length, x: ax, y: ay } : { ok: false, why: 'Здесь пресет не помещается', x: ax, y: ay };
  }
  orderStop(units) {
    for (const u of units) {
      if (u.kind === 'unit') { u.orders.length = 0; Brain.onNewOrder(u, this); u.brain.home = { x: u.x, y: u.y }; }
      else if (u.queue) { u.queue.length = 0; u.prog = 0; }
    }
  }
  queueUnit(s, key, n = 1) {
    if (!s.spec.produces || UNITS[key].tier > s.spec.tier) return;
    for (let i = 0; i < n; i++) s.queue.push(key);
  }
  dequeueUnit(s, key) {
    const i = s.queue.lastIndexOf(key);
    if (i >= 0) { s.queue.splice(i, 1); if (i === 0) s.prog = 0; }
  }
  upgrade(s) {
    if (!s.built || !s.spec.upgradesTo || s.upgrading) return false;
    s.upgrading = { to: s.spec.upgradesTo, prog: 0 };
    return true;
  }
  overcharge(acu, target) {
    const oc = acu.spec.overcharge; if (!oc) return false;
    const eco = this.teams[acu.team].eco;
    if (acu.ocCd > 0 || eco.energy < oc.cost) return false;
    const d = Math.hypot(target.x - acu.x, target.y - acu.y);
    if (d > oc.range + (target.spec?.radius || 0)) return false;
    eco.energy -= oc.cost; acu.ocCd = oc.cd;
    const z0 = this.groundZ(acu) + 4;
    this.projectiles.push({
      type: 'oc', team: acu.team, x: acu.x, y: acu.y, z: z0, sx: acu.x, sy: acu.y, tx: target.x, ty: target.y,
      tz: target.kind ? this.groundZ(target) + 1 : this.terrain.surfaceAt(target.x, target.y), target: target.kind ? target : null,
      speed: 90, dmg: oc.dmg, splash: oc.splash, layers: ['land', 'naval', 'sub'], life: 3, color: 0xffee88, from: acu, alive: true
    });
    this.fx.push({ type: 'muzzle', x: acu.x, y: acu.y, z: z0, color: 0xffee88, size: 3 });
    this.sound('oc', acu.x, acu.y);
    return true;
  }

  // ---------------------------------------------------------- damage
  damage(t, dmg, team, attacker) {
    if (!t.alive || t.carried) return;
    if (t.pshield && t.pshield.hp > 0) {
      const a = Math.min(t.pshield.hp, dmg);
      t.pshield.hp -= a; dmg -= a; t.pshield.flash = 1;
      if (t.pshield.hp <= 0) { t.pshield.hp = 0; this.notify(t.team, 'Щит юнита перегружен: ' + t.spec.name, t.x, t.y, 'alert'); }
      if (dmg <= 0) { t.lastHit = this.time; if (attacker && attacker.alive) t.lastAttacker = attacker; return; }
    }
    t.hp -= dmg; t.lastHit = this.time;
    if (attacker && attacker.alive) t.lastAttacker = attacker;
    if (t.kind === 'struct' && this.teams[t.team] && this.time - this.teams[t.team].lastAlert > 20) {
      this.teams[t.team].lastAlert = this.time;
      this.notify(t.team, 'База атакована: ' + t.spec.name, t.x, t.y, 'alert');
    }
    if (t.kind === 'unit' && t.key === 'acu' && t.hp < t.maxHp * 0.5 && !t._warned) {
      t._warned = true; this.notify(t.team, 'Командир серьёзно повреждён!', t.x, t.y, 'alert');
    }
    if (t.hp <= 0) this.kill(t, attacker, team);
  }

  splash(x, y, z, r, dmg, team, layers, attacker) {
    this.hash.query(x, y, r, this._q2);
    const list = this._q2.slice();
    for (const e of list) {
      if (!e.alive || (team && this.allied(team, e.team))) continue;
      if (layers && !layers.includes(this.layerOf(e))) continue;
      const d = Math.max(0, hyp2(e.x - x, e.y - y) - (e.spec.radius || 0) * 0.5);
      if (d > r) continue;
      if (layers && layers.includes('air') && !layers.includes('land') && Math.abs(this.groundZ(e) - z) > r + 6) continue;
      this.damage(e, dmg * (1 - 0.5 * d / r), team, attacker);
    }
  }

  kill(e, attacker, team) {
    if (!e.alive) return;
    e.alive = false; e.hp = 0;
    const T = this.teams[e.team];
    const cost = e.kind === 'struct' ? chainCost(e.key).m : e.spec.costM;
    T.stats.lost++; T.stats.massLost += cost;
    if (team && this.teams[team]) { this.teams[team].stats.kills++; this.teams[team].stats.massKilled += cost; }
    if (attacker && attacker.alive) {
      attacker.kills = (attacker.kills || 0) + 1;
      // veterancy: every kill worth ~2x own cost = one star (+10% HP, regeneration), max 5
      if (attacker.kind === 'unit' && attacker.vet < 5) {
        attacker.vetXP += Math.max(cost, 10);
        const need = Math.max(150, attacker.spec.costM * 2);
        while (attacker.vet < 5 && attacker.vetXP >= need * (attacker.vet + 1)) {
          attacker.vet++; attacker.maxHp *= 1.1; attacker.hp = Math.min(attacker.maxHp, attacker.hp + attacker.maxHp * 0.15);
          attacker.brain.log.unshift({ t: this.time, text: `Ветеран ${'★'.repeat(attacker.vet)}: +10% прочности` });
        }
      }
    }
    if (e.cargo) for (const c of e.cargo.splice(0)) { c.carried = null; c.x = e.x; c.y = e.y; this.kill(c, attacker, team); }
    this.events.push({ type: 'death', e, key: e.key, team: e.team, killer: team, x: e.x, y: e.y, cost, t: this.time, kind: e.kind });
    const z = this.groundZ(e);
    if (e.kind === 'unit') {
      Brain.onDeath(e, this);
      if (e.key === 'acu') {
        this.fx.push({ type: 'nuke', x: e.x, y: e.y, z });
        this.sound('nuke', e.x, e.y);
        this.splash(e.x, e.y, z, 45, 7000, 0, null, null);
        T.acuDead = true;
        this.notify(e.team, 'Командир уничтожен!', e.x, e.y, 'alert');
      } else {
        const big = e.spec.tier >= 3 || e.spec.radius > 4;
        this.fx.push({ type: 'explode', x: e.x, y: e.y, z, size: e.spec.radius * (big ? 2.2 : 1.5), air: e.spec.move === 'air' });
        this.sound(big ? 'explodeL' : 'explode', e.x, e.y);
        if (e.key === 'x_colossus') { this.fx.push({ type: 'nuke', x: e.x, y: e.y, z, small: true }); this.splash(e.x, e.y, z, 30, 3000, 0, null, null); }
      }
      if (e.spec.costM > 0 && e.spec.move !== 'air') this.addWreck(e, e.spec.costM * 0.8);
      else if (e.spec.move === 'air' && e.spec.costM > 0) this.addWreck(e, e.spec.costM * 0.5);
    } else {
      this.adjDirty = true;
      this.terrain.setBlocked(e.x, e.y, e.spec.size, -1);
      this.fx.push({ type: 'explode', x: e.x, y: e.y, z, size: e.spec.size * 0.6, struct: true });
      this.sound('collapse', e.x, e.y);
      if (e.built) this.addWreck(e, cost * 0.5);
      if ((e.key === 'pgen2' || e.key === 'pgen3' || e.key === 'mfab3') && e.built) { this.fx.push({ type: 'nuke', x: e.x, y: e.y, z, small: true }); this.splash(e.x, e.y, z, e.spec.size * 1.2, 2500, 0, null, null); }
      this.recalcIncome();
    }
  }

  addWreck(e, mass) {
    if (mass < 4) return;
    // wrecks never expire by themselves: keep the newest 350 (older ones would otherwise pile up for the whole game,
    // slowing engineer scans, saves and the renderer)
    const W = this.wrecks;
    if (W.length >= 350) for (let i = 0, k = W.length - 349; i < W.length && k > 0; i++) if (W[i].alive) { W[i].alive = false; k--; }
    const t = this.terrain;
    this.wrecks.push({
      id: this.nextId++, kind: 'wreck', key: e.key, model: e.spec.model, x: e.x, y: e.y, yaw: e.yaw || 0, team: e.team,
      z: e.kind === 'struct' ? this.groundZ(e) : (e.spec.move === 'naval' || t.isWater(e.x, e.y)) ? t.heightAt(e.x, e.y) : t.heightAt(e.x, e.y),
      mass, maxMass: mass, energy: 0, alive: true, spec: { radius: e.spec.radius || 3, name: 'Обломки: ' + e.spec.name }, struct: e.kind === 'struct', size: e.spec.size
    });
  }

  // ---------------------------------------------------------- vision
  updateVision() {
    const fog = this.opts.fog;
    const teams = Object.values(this.teams);
    const all = this.units.concat(this.structs), al = this.al;
    for (const T of teams) {
      T.vis.fill(0); T.radar.fill(0); T.sonar.fill(0);
      const powered = !this.teams[T.id].eco.energyOut;
      for (const e of all) {
        if (e.team !== T.id || !e.alive || e.carried) continue;
        const r = (e.kind === 'struct' && !e.built ? 20 : e.spec.vision);
        stamp(T.vis, e.x, e.y, r);
        if (e.kind === 'struct' && (!e.built || !powered)) continue;
        if (e.spec.radar) stamp(T.radar, e.x, e.y, e.spec.radar);
        if (e.spec.sonar) stamp(T.sonar, e.x, e.y, e.spec.sonar);
      }
    }
    // общее зрение союзников: vis/radar/sonar каждого = объединение по альянсу (один раз за обновление)
    for (const T of teams) {
      const mates = teams.filter(o => o !== T && al[T.id * 8 + o.id]);
      if (mates.length) { T._v = T.vis.slice(); T._r = T.radar.slice(); T._s = T.sonar.slice(); }
    }
    for (const T of teams) if (T._v) {
      for (const o of teams) if (o !== T && al[T.id * 8 + o.id] && o._v) for (let i = 0; i < T.vis.length; i++) { T.vis[i] |= o._v[i]; T.radar[i] |= o._r[i]; T.sonar[i] |= o._s[i]; }
    }
    for (const T of teams) { T._v = T._r = T._s = null; for (let i = 0; i < T.vis.length; i++) if (T.vis[i]) T.explored[i] = 1; }
    for (const e of all) {
      if (e.carried) continue;
      const ci = (Math.max(0, Math.min(PN - 1, (e.y / PCELL) | 0))) * PN + Math.max(0, Math.min(PN - 1, (e.x / PCELL) | 0));
      const under = fog && e.kind === 'unit' && this.layerOf(e) === 'sub';
      for (const T of teams) {
        if (al[T.id * 8 + e.team]) { e.vis[T.id] = 1; if (e.kind === 'struct') e.seen[T.id] = 1; continue; }
        let v = fog ? T.vis[ci] : 1;
        // submerged units: seen up close or under sonar; radar can't see them
        if (v && under && !T.sonar[ci]) v = this.hash.query(e.x, e.y, 28, this._q).some(o => al[T.id * 8 + o.team] && o.alive) ? 1 : 0;
        e.vis[T.id] = v; e.rad[T.id] = !fog ? 1 : under ? T.sonar[ci] : T.radar[ci];
        if (v && e.kind === 'struct') e.seen[T.id] = 1;
      }
    }
  }

  // ---------------------------------------------------------- main step
  _lap(k) { const t = this.prof.clock(); this.prof[k] = (this.prof[k] || 0) + t - this._t0; this._t0 = t; }
  step() {
    if (this.over) return;
    const P = this.prof; if (P) this._t0 = P.clock();
    this.tick++; this.time += DT;
    this.terrain.resetBudget(this.tick);
    const H = this.hash, units = this.units, structs = this.structs, teams = this.teamList;
    H.clear();
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.carried) { u.x = u.px = u.carried.x; u.y = u.py = u.carried.y; continue; }
      u.px = u.x; u.py = u.y; u.pyaw = u.yaw; u.pz = u.z; H.insert(u);
    }
    for (let i = 0; i < structs.length; i++) H.insert(structs[i]);
    if (P) this._lap('hash_ins');
    H.build();
    if (P) this._lap('hash');
    if (this.tick % 6 === 0) this.updateVision();
    for (let i = this.impacts.length - 1; i >= 0; i--) if (this.impacts[i].t < this.time) this.impacts.splice(i, 1);
    if (P) this._lap('vision');

    for (const T of teams) { T.eco.begin(); T.unitCount = 0; }
    for (let i = 0; i < units.length; i++) if (units[i].alive) this.teams[units[i].team].unitCount++;

    this.shields = structs.filter(s => s.alive && s.shield && s.shield.on && s.shield.hp > 0);
    for (let i = 0; i < structs.length; i++) if (structs[i].alive) this.updateStruct(structs[i]);
    if (P) this._lap('structs');
    for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.alive && !u.carried) this.updateUnit(u); }
    if (P) this._lap('units');
    this.separate();
    if (P) this._lap('separate');
    const pr = this.projectiles;
    for (let i = 0; i < pr.length; i++) if (pr[i].alive) this.updateProjectile(pr[i]);
    if (P) this._lap('projectiles');

    // in-place compaction: no per-tick array churn, and the arrays other modules hold stay valid
    compact(this.units); compact(this.structs); compact(this.projectiles); compact(this.wrecks);
    for (const T of teams) T.eco.end();
    if (this.tick % 15 === 0) this.recalcIncome();
    if (this.tick % 150 === 0) this.trimEvents();
    if (this.fx.length > 3000) this.fx.splice(0, this.fx.length - 1500);   // the renderer drains fx every frame; headless runs and stalled frames must not grow it forever
    if (P) this._lap('cleanup');
    for (const c of this.controllers) c.update();
    if (P) this._lap('controllers');
    this.checkVictory();
  }

  // The event log is append-only (controllers keep read cursors into it), so it can't be truncated, but entries far behind
  // every cursor must not keep dead units / structures / projectiles alive: drop their object references.
  trimEvents() {
    const ev = this.events, upto = ev.length - 300;
    for (let i = this._evTrim || 0; i < upto; i++) {
      const e = ev[i];
      if (e.e) e.e = null; if (e.unit) e.unit = null; if (e.s) e.s = null; if (e.p) e.p = null; if (e.factory) e.factory = null; if (e.from) e.from = null;
    }
    if (upto > (this._evTrim || 0)) this._evTrim = upto;
  }

  // ---------------------------------------------------------- save / load (plain JSON; entity links become ids)
  serialize() {
    const ref = (e) => !e ? null : e.kind ? { r: e.id } : e.type ? { f: e.id } : null;
    const ord = (o) => { const c = { ...o }; if (o.target) c.target = ref(o.target); if (o.site) c.site = ref(o.site); return c; };
    const bits = (a) => { let s = ''; for (let i = 0; i < a.length; i += 4) s += ((a[i] | a[i + 1] << 1 | a[i + 2] << 2 | a[i + 3] << 3)).toString(16); return s; };
    return {
      v: 1, map: this.map.id, nextId: this.nextId, tick: this.tick, time: this.time, over: this.over,
      opts: { fog: this.opts.fog, victory: this.opts.victory, playerTeam: this.opts.playerTeam, teams: this.opts.teams, unitCap: this.unitCap },
      teams: Object.values(this.teams).map(T => ({
        id: T.id, alive: T.alive, acuDead: !!T.acuDead, acu: T.acu ? T.acu.id : null, autonomy: T.autonomy, autoOC: T.autoOC, lastAlert: T.lastAlert,
        stats: T.stats, explored: bits(T.explored),
        eco: (({ mass, energy, mult, fabOn, wastedM, collectedM, spentTotalM, spendM, spendE }) => ({ mass, energy, mult, fabOn, wastedM, collectedM, spentTotalM, spendM, spendE }))(T.eco)
      })),
      units: this.units.filter(u => u.alive).map(u => ({
        id: u.id, key: u.key, team: u.team, x: u.x, y: u.y, z: u.z, yaw: u.yaw, hp: u.hp, maxHp: u.maxHp, orders: u.orders.map(ord),
        enh: u.enh, enhProg: u.enhProg, pshield: u.pshield, cargo: u.cargo && u.cargo.map(c => c.id), vet: u.vet, vetXP: u.vetXP,
        kills: u.kills, ocCd: u.ocCd, platoon: u.platoon, home: u.brain.home, born: u.born
      })),
      structs: this.structs.filter(s => s.alive).map(s => ({
        id: s.id, key: s.key, team: s.team, x: s.x, y: s.y, hp: s.hp, built: s.built, progress: s.progress, queue: s.queue, repeat: s.repeat,
        prog: s.prog, rally: s.rally, upgrading: s.upgrading, paused: s.paused, kills: s.kills, seen: s.seen, shield: s.shield && { hp: s.shield.hp, on: s.shield.on }, silo: s.silo && { stock: s.silo.stock, prog: s.silo.prog }
      })),
      wrecks: this.wrecks.filter(w => w.alive),
      feats: this.terrain.features.map(f => f.alive ? [+f.mass.toFixed(1), +f.energy.toFixed(1)] : 0)
    };
  }
  static restore(map, d) {
    const g = new Game(map, { ...d.opts, restore: true });
    g.tick = d.tick; g.time = d.time; g.over = d.over;
    const byId = new Map();
    for (const s of d.structs) {
      const st = g.placeStructure(s.team, s.key, s.x, s.y, false);
      Object.assign(st, { id: s.id, hp: s.hp, built: s.built, progress: s.progress, queue: s.queue, repeat: s.repeat, prog: s.prog, rally: s.rally, upgrading: s.upgrading, paused: s.paused, kills: s.kills || 0, seen: s.seen });
      if (st.shield && s.shield) Object.assign(st.shield, s.shield);
      if (st.silo && s.silo) Object.assign(st.silo, s.silo);
      byId.set(s.id, st);
    }
    for (const s of d.units) {
      const u = new Unit(g, s.key, s.team, s.x, s.y);
      Object.assign(u, { id: s.id, z: s.z, yaw: s.yaw, pyaw: s.yaw, hp: s.hp, maxHp: s.maxHp, vet: s.vet || 0, vetXP: s.vetXP || 0, kills: s.kills || 0, ocCd: s.ocCd || 0, platoon: s.platoon, born: s.born, pz: s.z });
      if (s.enh) { u.enh = s.enh; u.enhProg = s.enhProg || {}; u.spec = unitSpec(u.key, s.enh); u.weapons = initWeapons(u.spec); }
      if (s.pshield !== undefined) u.pshield = s.pshield;
      if (s.home) u.brain.home = s.home;
      g.units.push(u); byId.set(u.id, u);
    }
    g.wrecks = d.wrecks.map(w => ({ ...w }));
    for (const w of g.wrecks) byId.set(w.id, w);
    const F = g.terrain.features;
    d.feats.forEach((v, i) => { const f = F[i]; if (!f) return; if (!v) { f.alive = false; f.gone = true; } else { f.mass = v[0]; f.energy = v[1]; } });
    const deref = (r) => !r ? null : r.f !== undefined ? (F[r.f]?.alive ? F[r.f] : null) : byId.get(r.r) || null;
    for (const s of d.units) {
      const u = byId.get(s.id);
      u.orders = s.orders.map(o => { const c = { ...o }; if (o.target) c.target = deref(o.target); if (o.site) c.site = deref(o.site); return c; })
        .filter(o => o.target !== null);
      if (s.cargo) { u.cargo = s.cargo.map(id => byId.get(id)).filter(Boolean); for (const c of u.cargo) c.carried = u; }
    }
    for (const t of d.teams) {
      const T = g.teams[t.id]; if (!T) continue;
      Object.assign(T, { alive: t.alive, acuDead: t.acuDead, autonomy: t.autonomy, autoOC: t.autoOC, lastAlert: t.lastAlert, stats: t.stats, acu: byId.get(t.acu) || null });
      Object.assign(T.eco, t.eco);
      for (let i = 0; i < t.explored.length; i++) { const v = parseInt(t.explored[i], 16); for (let k = 0; k < 4; k++) T.explored[i * 4 + k] = (v >> k) & 1; }
    }
    g.nextId = d.nextId;
    g.adjDirty = true; g.recalcIncome();
    g.hash.clear(); for (const u of g.units) if (!u.carried) g.hash.insert(u); for (const s of g.structs) g.hash.insert(s);
    g.updateVision();
    return g;
  }

  checkVictory() {
    const out = [];
    const alive = this.teamList.filter(T => {
      if (!T.alive) return false;
      if (this.opts.victory === 'assassination') { if (T.acuDead) T.alive = false; }
      else if (!this.units.some(u => u.team === T.id) && !this.structs.some(s => s.team === T.id)) T.alive = false;
      if (!T.alive) out.push(T);
      return T.alive;
    });
    // победа: остался один альянс (ally 0 = каждый сам по себе)
    const groups = new Set(alive.map(T => T.ally || -T.id));
    if (groups.size <= 1 && !this.over) {
      this.over = { winner: alive[0]?.id || 0, winners: alive.map(T => T.id), ally: alive[0]?.ally || 0, time: this.time };
      this.events.push({ type: 'gameover', winner: this.over.winner, winners: this.over.winners });
      for (const c of this.controllers) c.finalize?.();
    } else if (!this.over) for (const T of out) this.eliminate(T);
  }
  // Игрок выбыл, а игра продолжается: всё его имущество уничтожается (иначе брошенные армии и турели остались бы на карте).
  eliminate(T) {
    this.events.push({ type: 'teamOut', team: T.id });
    this.notify(T.id, 'Вы выбыли из игры', T.start.x, T.start.y, 'alert');
    for (const e of this.units.concat(this.structs)) if (e.alive && e.team === T.id) this.kill(e, null, 0);
  }

  // ---------------------------------------------------------- structures
  updateStruct(s) {
    const T = this.teams[s.team], eco = T.eco;
    if (!s.built) return;
    if (s.shield) {
      const sh = s.shield;
      sh.flash = Math.max(0, sh.flash - DT * 3);
      if (eco.energyOut) { if (sh.on) { sh.on = false; sh.hp = 0; } }
      else if (sh.hp <= 0) { sh.down = (sh.down || 0) + DT; if (sh.down > 8) { sh.on = true; sh.hp = sh.max * 0.25; sh.down = 0; } }
      else { sh.on = true; sh.hp = Math.min(sh.max, sh.hp + s.spec.shield.regen * DT); }
    }
    const bp = (s.spec.bp || 10) + s.assistBP;
    s.assistBP = 0;
    const adj = s.adj || { mCost: 1, eCost: 1 };
    if (s.upgrading) {
      const U = STRUCTS[s.upgrading.to];
      const dp = bp * DT / U.bt;
      const f = eco.spend(U.costM * dp * adj.mCost, U.costE * dp * adj.eCost);
      s.upgrading.prog += dp * f;
      s.building = f > 0;
      if (s.upgrading.prog >= 1) {
        const ratio = s.hp / s.maxHp;
        s.key = U.key; s.spec = U; s.maxHp = U.hp; s.hp = U.hp * ratio;
        s.weapons = initWeapons(U); s.upgrading = null; s.prog = 0;
        if (s.shield && U.shield) { const f = s.shield.hp / s.shield.max; Object.assign(s.shield, { max: U.shield.hp, r: U.shield.radius, hp: U.shield.hp * f }); }
        this.adjDirty = true; this.recalcIncome();
        this.fx.push({ type: 'built', x: s.x, y: s.y, z: this.groundZ(s), size: s.spec.size, team: s.team });
        this.sound('built', s.x, s.y);
        this.notify(s.team, 'Улучшение завершено: ' + U.name, s.x, s.y, 'good');
        this.events.push({ type: 'upgraded', s, team: s.team });
      }
    } else if (s.spec.produces && s.queue.length && !s.paused) {
      const key = s.queue[0], U = UNITS[key];
      if (U.tier > s.spec.tier) { s.queue.shift(); }
      else if (T.unitCount < this.unitCap) {
        const dp = bp * DT / U.bt;
        const f = eco.spend(U.costM * dp * adj.mCost, U.costE * dp * adj.eCost);
        s.prog += dp * f; s.building = f > 0;
        if (s.prog >= 1) {
          s.prog = 0; s.queue.shift();
          if (s.repeat) s.queue.push(key);
          const ex = s.exit;
          const u = this.spawnUnit(key, s.team, U.move === 'air' ? s.x : ex.x, U.move === 'air' ? s.y : ex.y);
          u.yaw = Math.atan2(ex.y - s.y, ex.x - s.x);
          // rally orders are marked so engineers can be re-tasked immediately (AI) instead of walking to the rally point
          if (s.rally) { u.orders.push({ type: 'move', x: s.rally.x + (Math.random() - 0.5) * 16, y: s.rally.y + (Math.random() - 0.5) * 16, rally: true }); }
          else if (U.move !== 'air') u.orders.push({ type: 'move', x: ex.x + (ex.x - s.x) * 0.6 + (Math.random() - 0.5) * 12, y: ex.y + (ex.y - s.y) * 0.6 + (Math.random() - 0.5) * 12, rally: true });
          this.events.push({ type: 'unitBuilt', unit: u, team: s.team, factory: s });
          this.sound('ready', s.x, s.y);
        }
      }
    } else s.building = false;
    if (s.silo) this.updateSilo(s, bp, adj, eco);
    if (s.weapons.length) this.updateWeapons(s);
  }

  // ---------------------------------------------------------- missile silos
  // A silo builds its own missiles (spends resources as a stream, engineers can assist), keeps a stock and opens its doors on launch.
  updateSilo(s, bp, adj, eco) {
    const sp = s.spec.silo, si = s.silo;
    s.building = false;
    if (si.cd > 0) si.cd -= DT;
    if (si.stock < sp.max && !s.paused) {
      const dp = bp * DT / sp.bt;
      const f = eco.spend(sp.costM * dp * adj.mCost, sp.costE * dp * adj.eCost);
      si.prog += dp * f; s.building = f > 0;
      if (si.prog >= 1) {
        si.prog = 0; si.stock++;
        this.sound('ready', s.x, s.y);
        this.notify(s.team, sp.kind === 'nuke' ? `Ядерная ракета готова (${si.stock}/${sp.max})` : sp.kind === 'anti' ? `Антиракета готова (${si.stock}/${sp.max})` : `Тактическая ракета готова (${si.stock}/${sp.max})`, s.x, s.y, 'good');
        this.events.push({ type: 'missileBuilt', s, team: s.team, kind: sp.kind });
      }
    }
    // doors: open during a launch countdown and for a moment after it
    if (s.launch) {
      s.launch.t -= DT;
      if (s.launch.t <= 0) { this.spawnNuke(s, s.launch.x, s.launch.y); s.launch = null; s.openT = 2.2; }
    }
    s.openT = Math.max(0, s.openT - DT);
    const want = s.launch || s.openT > 0 ? 1 : 0;
    s.doorOpen += Math.max(-DT * 0.7, Math.min(DT * 0.7, want - s.doorOpen));
    if (sp.kind === 'anti' && si.stock > 0 && si.cd <= 0 && (this.tick + s.id) % 4 === 0) this.antiNukeScan(s);
  }

  // Strategic launch: the silo opens (2.4 s), then the missile climbs in a high ballistic arc to any point of the map.
  launchNuke(s, x, y) {
    if (!s.alive || !s.built || !s.silo || s.spec.silo.kind !== 'nuke') return { ok: false, why: 'Это не ядерная шахта' };
    if (s.silo.stock < 1) return { ok: false, why: 'Нет готовой ракеты' };
    if (s.launch) return { ok: false, why: 'Шахта занята запуском' };
    x = Math.max(4, Math.min(MAP_SIZE - 4, x)); y = Math.max(4, Math.min(MAP_SIZE - 4, y));
    s.silo.stock--; s.launch = { x, y, t: 2.4 };
    this.sound('ui', s.x, s.y);
    return { ok: true };
  }
  spawnNuke(s, x, y) {
    const sp = s.spec.silo, t = this.terrain;
    const z0 = this.groundZ(s) + 3, tz = t.surfaceAt(x, y), d = Math.hypot(x - s.x, y - s.y);
    const T = 12 + d * 0.02, H = 110 + d * 0.11;
    this.projectiles.push({
      type: 'nuke', id: this.nextId++, team: s.team, x: s.x, y: s.y, z: z0, sx: s.x, sy: s.y, sz: z0, tx: x, ty: y, tz,
      T, t: 0, H, vx: 0, vy: 0, vz: 0, sp, zones: sp.zones, hp: 1, icpt: 0, color: 0xffb060, from: s, alive: true, life: T + 5
    });
    this.fx.push({ type: 'launch', x: s.x, y: s.y, z: z0, size: s.spec.size });
    this.sound('nukeLaunch', s.x, s.y);
    this.notify(s.team, 'Ядерная ракета запущена', x, y, 'info');
    for (const T2 of this.enemies(s.team)) this.notify(T2.id, 'ВНИМАНИЕ: обнаружен запуск ядерной ракеты!', x, y, 'alert');
    this.events.push({ type: 'nukeLaunch', team: s.team, x, y, from: s });
  }
  // Ground zero: три зоны (silo.zones), урон по specs.nukeDamage; задевает всех, включая свои войска. Обломки и деревья/камни стираются в первой зоне.
  nukeBlast(p) {
    p.alive = false;
    const x = p.tx, y = p.ty, z = p.tz, Z = p.zones;
    this.fx.push({ type: 'nuke', x, y, z, mega: true, zones: Z });
    this.sound('nuke', x, y);
    const list = this.hash.query(x, y, Z[2] + 2, this._q2).slice();
    const by = p.from && p.from.alive ? p.from : null;
    for (const e of list) {
      if (!e.alive) continue;
      const d = Math.max(0, Math.hypot(e.x - x, e.y - y) - (e.spec.radius || 0) * 0.5);
      const dmg = nukeDamage(p.sp, e.spec, e.maxHp, d);
      if (dmg > 0) this.damage(e, dmg, this.allied(e.team, p.team) ? 0 : p.team, by);
    }
    for (const w of this.wrecks) if (w.alive && Math.hypot(w.x - x, w.y - y) < Z[0]) w.alive = false;
    for (const f of this.terrain.featuresNear(x, y, Z[0])) if (f.alive) { f.alive = false; this.fx.push({ type: 'feature', f }); }
    this.events.push({ type: 'nukeBlast', team: p.team, x, y });
  }
  // SMD: fires an anti-missile at an enemy nuke that will land inside its cover radius.
  antiNukeScan(s) {
    const sp = s.spec.silo;
    for (const p of this.projectiles) {
      if (p.type !== 'nuke' || !p.alive || this.allied(p.team, s.team) || p.icpt > 0 || p.t < 2.5) continue;
      if (Math.hypot(p.tx - s.x, p.ty - s.y) > sp.cover || Math.hypot(p.x - s.x, p.y - s.y) > 320) continue;
      s.silo.stock--; s.silo.cd = 1.6; p.icpt++; s.openT = 1.2;
      const z0 = this.groundZ(s) + 5;
      this.projectiles.push({ type: 'amissile', team: s.team, x: s.x, y: s.y, z: z0, vx: 0, vy: 0, vz: 50, speed: 200, spd: 60, target: p, from: s, alive: true, life: 25, color: 0xa8ffff, hp: 1 });
      this.fx.push({ type: 'muzzle', x: s.x, y: s.y, z: z0, color: 0xa8ffff, size: 3 });
      this.sound('aa', s.x, s.y);
      this.notify(s.team, 'Антиракета запущена', p.x, p.y, 'info');
      return;
    }
  }
  // Tactical launch (TML): homing cruise missile at a point or a unit / structure within range.
  launchTactical(s, x, y, ent) {
    if (!s.alive || !s.built || !s.silo || s.spec.silo.kind !== 'tac') return { ok: false, why: 'Это не TML' };
    const w = s.spec.weapons[0];
    if (s.silo.stock < 1) return { ok: false, why: 'Нет готовой ракеты' };
    if (s.silo.cd > 0) return { ok: false, why: 'Пусковая перезаряжается' };
    const d = Math.hypot(x - s.x, y - s.y);
    if (d > w.range) return { ok: false, why: `Цель дальше ${w.range}` };
    if (d < w.minRange) return { ok: false, why: 'Слишком близко' };
    const target = ent && ent.alive && this.isEnemy(ent.team, s.team) && ent.kind ? ent : null;
    const yaw = Math.atan2(y - s.y, x - s.x), z0 = this.groundZ(s) + s.spec.size * 0.4;
    const ws = s.weapons[0]; if (ws) ws.yaw = yaw;
    this.projectiles.push({
      type: 'missile', team: s.team, dmg: w.dmg, splash: w.splash, layers: w.targets, color: w.color, from: s, alive: true, target,
      x: s.x + Math.cos(yaw) * 3, y: s.y + Math.sin(yaw) * 3, z: z0, vx: Math.cos(yaw) * w.speed * 0.4, vy: Math.sin(yaw) * w.speed * 0.4, vz: w.speed * (0.25 + Math.min(1, d / 80) * 0.8),
      tx: x, ty: y, tz: this.terrain.surfaceAt(x, y) + 0.5, speed: w.speed, life: d / w.speed * 2.2 + 2, hp: w.mhp || 35, full: !!w.full, tac: true
    });
    s.silo.stock--; s.silo.cd = 1.2;
    this.fx.push({ type: 'muzzle', x: s.x, y: s.y, z: z0, color: w.color, size: 3 });
    this.sound('missile', s.x, s.y);
    return { ok: true };
  }
  // Player / AI command: every given silo fires one missile at (x, y). Returns { n, why }.
  orderLaunch(silos, x, y, ent) {
    let n = 0, why = 'Нет готовых ракет';
    for (const s of silos) {
      if (!s.silo) continue;
      const r = s.spec.silo.kind === 'nuke' ? this.launchNuke(s, x, y) : s.spec.silo.kind === 'tac' ? this.launchTactical(s, x, y, ent) : { ok: false, why: 'Антиракеты стреляют сами' };
      if (r.ok) n++; else why = r.why;
    }
    return { n, why };
  }
  // Silo missile counters: pause / resume the missile production of the selected silos.
  toggleSiloPause(silos) { const v = !silos.every(s => s.paused); for (const s of silos) if (s.silo) s.paused = v; return v; }

  // ---------------------------------------------------------- units
  updateUnit(u) {
    if (u.ocCd > 0) u.ocCd -= DT;
    const rg = (u.spec.regen || 0) + u.vet * u.maxHp * 0.002;
    if (rg && u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + rg * DT);
    const ps = u.pshield;
    if (ps) {
      ps.flash = Math.max(0, ps.flash - DT * 3);
      if (ps.hp <= 0) { ps.down += DT; if (ps.down > 10) { ps.hp = ps.max * 0.25; ps.down = 0; } }
      else if (!this.teams[u.team].eco.energyOut) ps.hp = Math.min(ps.max, ps.hp + ps.regen * DT);
    }
    Brain.update(u, this);
    if (u.spec.move === 'air') this.moveAir(u); else this.moveGround(u);
    if (u.weapons.length) this.updateWeapons(u);
  }

  // Point inside a building's footprint? (the pathing cells round to 8 units; this is the exact test)
  solidAt(x, y, m = 0) {
    for (const s of this.structs) { const h = s.spec.size / 2 + m; if (s.alive && Math.abs(x - s.x) < h && Math.abs(y - s.y) < h) return true; }
    return false;
  }
  // Like terrain.passableAt, but a cell blocked by a building only counts when the point itself is inside a footprint.
  walkable(domain, x, y) {
    const t = this.terrain;
    if (t.passableAt(domain, x, y)) return true;
    return x >= PCELL && y >= PCELL && x <= MAP_SIZE - PCELL && y <= MAP_SIZE - PCELL && t.terrainPass(domain, x, y) && !this.solidAt(x, y);
  }

  moveGround(u) {
    const s = u.spec, mt = u.moveTarget, t = this.terrain;
    const domain = s.move;
    const nv = u.nav || (u.nav = Nav.createNav(u));
    let want = 0, rev = false;
    if (mt) {
      const d = hyp2(mt.x - u.x, mt.y - u.y);
      if (d > (mt.arrive || 1.5)) {
        // waypoints, avoidance and stuck recovery live in nav.js; here we only turn and accelerate
        Nav.plan(this, u, mt, d);
        if (!nv.hold) {
          const tr = s.turn * DT;
          rev = nv.rev;
          if (rev) {
            u.yaw += Math.max(-tr * 0.6, Math.min(tr * 0.6, nv.turn));
            nv.turning = false;
            want = s.speed * 0.6 * nv.slow;
          } else {
            const dy = Math.atan2(nv.hy - u.y, nv.hx - u.x) + nv.delta;
            const diff = angDiff(u.yaw, dy);
            u.yaw += Math.max(-tr, Math.min(tr, diff));
            nv.turning = Math.abs(diff) > 0.9;
            const align = Math.abs(diff) < 0.9 ? 1 - Math.abs(diff) / 1.4 : 0.05;
            want = Math.min(s.speed * (mt.speedMul || 1) * nv.slow, d * 1.6 + 0.5) * align;
          }
        }
      } else Nav.idle(u);
    } else Nav.idle(u);
    const acc = s.speed * 2.2 * DT;
    u.speed += Math.max(-acc * 1.5, Math.min(acc, want - u.speed));
    if (u.speed < 0.01) { u.speed = 0; u.vx = 0; u.vy = 0; if (mt && !nv.hold) u.stuck = Math.min(3, u.stuck + DT); else u.stuck = Math.max(0, u.stuck - DT); return; }
    // slope slows ground units
    let sp = u.speed;
    if (domain === 'land') {
      if ((this.tick + u.id) % 4 === 0 || u.slope === undefined) u.slope = t.slopeAt(u.x, u.y);
      sp *= 1 - Math.min(0.45, u.slope * 0.6);
    }
    const dir = rev ? -1 : 1;
    const nx = u.x + Math.cos(u.yaw) * sp * DT * dir, ny = u.y + Math.sin(u.yaw) * sp * DT * dir;
    const ox = u.x, oy = u.y;
    // a unit caught on a structure-blocked cell (buildings placed around it) may walk out over static terrain
    const free = !this.walkable(domain, u.x, u.y) && t.terrainPass(domain, nx, ny);
    if (free || this.walkable(domain, nx, ny)) { u.x = nx; u.y = ny; }
    else if (this.walkable(domain, nx, u.y)) u.x = nx;
    else if (this.walkable(domain, u.x, ny)) u.y = ny;
    else u.speed *= 0.5;
    u.vx = (u.x - ox) * TPS; u.vy = (u.y - oy) * TPS;
    if (mt && hyp2(u.vx, u.vy) < s.speed * 0.15) u.stuck = Math.min(3, u.stuck + DT);
    else u.stuck = Math.max(0, u.stuck - DT);
  }

  moveAir(u) {
    const s = u.spec, mt = u.moveTarget;
    const surface = this.terrain.surfaceAt(u.x, u.y);
    const alt = u.landing ? 5 : s.alt;
    u.landing = false;
    u.z += (alt - u.z) * Math.min(1, DT * 1.2);
    let tx, ty;
    if (mt) { tx = mt.x; ty = mt.y; }
    else {
      const h = u.brain.home || u;
      if (s.fly === 'hover') { tx = h.x; ty = h.y; }
      else { // orbit
        const a = Math.atan2(u.y - h.y, u.x - h.x) + 0.6;
        tx = h.x + Math.cos(a) * 30; ty = h.y + Math.sin(a) * 30;
      }
    }
    const d = hyp2(tx - u.x, ty - u.y);
    if (s.quad) {
      this.moveQuad(u, tx, ty, d);
      if (surface + u.z < this.terrain.surfaceAt(u.x + u.vx * 0.5, u.y + u.vy * 0.5) + 4) u.z += 20 * DT;
      return;
    }
    const desired = Math.atan2(ty - u.y, tx - u.x);
    const diff = angDiff(u.yaw, desired);
    const tr = s.turn * DT;
    let turn = Math.max(-tr, Math.min(tr, diff));
    if (mt && s.fly !== 'hover') { // цель внутри круга разворота: не орбитить её вечно — лететь прямо, пока не отлетим на 3.5 r, и зайти заново
      const r = u.speed / s.turn, a = u.yaw + Math.sign(diff) * Math.PI / 2;
      if (Math.abs(diff) > 0.05 && hyp2(tx - (u.x + r * Math.cos(a)), ty - (u.y + r * Math.sin(a))) < r) u.ext = true;
      else if (d > r * 3.5) u.ext = false;
      if (u.ext) turn = 0;
    } else u.ext = false;
    u.yaw += turn;
    u.bank += ((turn / DT) * 0.35 - u.bank) * Math.min(1, DT * 4);
    let want;
    if (s.fly === 'hover') want = Math.min(s.speed, d * 1.2) * (Math.abs(diff) < 1.2 ? 1 : 0.3);
    else want = s.speed * (d < 20 && Math.abs(diff) > 1.5 ? 0.75 : 1);
    u.speed += Math.max(-s.speed * DT, Math.min(s.speed * DT * 0.8, want - u.speed));
    if (s.fly !== 'hover') u.speed = Math.max(s.speed * 0.55, u.speed);
    u.x += Math.cos(u.yaw) * u.speed * DT; u.y += Math.sin(u.yaw) * u.speed * DT;
    u.x = Math.max(4, Math.min(MAP_SIZE - 4, u.x)); u.y = Math.max(4, Math.min(MAP_SIZE - 4, u.y));
    u.vx = Math.cos(u.yaw) * u.speed; u.vy = Math.sin(u.yaw) * u.speed;
    // keep above terrain
    if (surface + u.z < this.terrain.surfaceAt(u.x + u.vx * 0.5, u.y + u.vy * 0.5) + 4) u.z += 20 * DT;
  }

  // Квадрокоптер: скорость ведётся прямо к точке (боком и задом тоже), курс плавно смотрит на цель огня, иначе по ходу;
  // тангаж (u.pitch, + = нос вниз) и крен (u.bank) считаются из скорости и ускорения для рендера
  moveQuad(u, tx, ty, d) {
    const s = u.spec, f = u.focus, k = d > 0.5 ? Math.min(s.speed, d * 1.2) / d : 0;
    let dx = (tx - u.x) * k - u.vx, dy = (ty - u.y) * k - u.vy;
    const dv = hyp2(dx, dy), lim = s.speed * DT * 0.9;
    if (dv > lim) { dx *= lim / dv; dy *= lim / dv; }
    u.vx += dx; u.vy += dy; u.speed = hyp2(u.vx, u.vy);
    let aim = null;
    if (f && f.alive && hyp2(f.x - u.x, f.y - u.y) < s.maxRange * 1.3) aim = Math.atan2(f.y - u.y, f.x - u.x);
    else if (u.speed > 1) aim = Math.atan2(u.vy, u.vx);
    if (aim !== null) u.yaw += Math.max(-s.turn * DT, Math.min(s.turn * DT, angDiff(u.yaw, aim)));
    u.x = Math.max(4, Math.min(MAP_SIZE - 4, u.x + u.vx * DT)); u.y = Math.max(4, Math.min(MAP_SIZE - 4, u.y + u.vy * DT));
    const c = Math.cos(u.yaw), n = Math.sin(u.yaw), m = 0.15 / s.speed, ax = dx / DT, ay = dy / DT, a = Math.min(1, DT * 4);
    const tilt = (v, acc) => Math.max(-0.15, Math.min(0.15, (v + acc * 0.5) * m));
    u.pitch += (tilt(u.vx * c + u.vy * n, ax * c + ay * n) - u.pitch) * a;
    u.bank += (tilt(-u.vx * n + u.vy * c, -ax * n + ay * c) - u.bank) * a;
  }

  // Soft collision between ground units and structures. Idle units give way to moving ones by stepping aside
  // (perpendicular to the mover's heading, not back along it), and heavy units shove light ones rather than the reverse.
  // Perf: one flat-hash slice scan per unit, rejected from typed arrays (positions, radii, flags) before any entity is
  // loaded; units that are idle, settled (no push last time) and have no active unit within ~one coarse cell are
  // skipped ("asleep") except for a periodic wake-up.
  separate() {
    const H = this.hash, T = this.terrain, units = this.units, tick = this.tick;
    H.refresh();
    const items = H.items, xs = H.xs, ys = H.ys, rs = H.rs, fl = H.fl, rk = H.rk, ur = H.maxUR, sr = H.maxSR;
    // coarse activity map (32-unit cells): any not-settled ground unit wakes the 3x3 cells around it
    const AN = MAP_SIZE / 32, act = this._act || (this._act = new Uint8Array(AN * AN));
    act.fill(0);
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.alive || u.carried || u.spec.move === 'air') continue;
      if (u.sepCalm && !u.moveTarget && u.speed < 0.3) continue;
      const ci = Math.min(AN - 1, (u.x * 0.03125) | 0), cj = Math.min(AN - 1, (u.y * 0.03125) | 0);
      const i0 = ci > 0 ? ci - 1 : 0, i1 = ci < AN - 1 ? ci + 1 : ci, j0 = cj > 0 ? cj - 1 : 0, j1 = cj < AN - 1 ? cj + 1 : cj;
      for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) act[j * AN + ii] = 1;
    }
    // outer loop in hash (spatial) order: neighbouring units are neighbours in memory access too, so their entities stay cached
    for (let a = 0, na = H.len; a < na; a++) {
      if (fl[a] !== F_UNIT && fl[a] !== (F_UNIT | F_MOVER) && fl[a] !== (F_UNIT | F_MOVING) && fl[a] !== (F_UNIT | F_MOVER | F_MOVING)) continue;   // ground units only
      const u = items[a];
      if (!u.alive || u.carried) continue;
      const us = u.spec;
      const idle = !u.moveTarget && u.speed < 0.3;
      if (idle && u.sepCalm && (tick + u.id) % 30 !== 0 && !act[Math.min(AN - 1, (u.y * 0.03125) | 0) * AN + Math.min(AN - 1, (u.x * 0.03125) | 0)]) continue;
      const r = us.radius, ux = u.x, uy = u.y;
      const ru = r * r;
      let subU = -1;
      let px = 0, py = 0;
      const nr = H.rows(ux, uy, Math.max(r + ur + 8, r + 10 + sr));
      for (let q = 0; q < nr; q++) {
        for (let k = rk[2 * q], k1 = rk[2 * q + 1]; k < k1; k++) {
          const f = fl[k];
          if (f & (F_DEAD | F_AIR)) continue;
          let dx = ux - xs[k], dy = uy - ys[k];
          const d2 = dx * dx + dy * dy;
          if (f & F_STRUCT) {
            const rr = r + 10 + rs[k];
            if (d2 > rr * rr) continue;
            const o = items[k];
            if (!o.alive) continue;
            const h = o.spec.size / 2 + r * 0.6;
            dx = ux - o.x; dy = uy - o.y;
            if (Math.abs(dx) < h && Math.abs(dy) < h) {
              if (h - Math.abs(dx) < h - Math.abs(dy)) px += Math.sign(dx || 1) * Math.min(1.5, h - Math.abs(dx)); else py += Math.sign(dy || 1) * Math.min(1.5, h - Math.abs(dy));
            }
            continue;
          }
          const minD = r + rs[k] + 0.4;
          if (d2 >= minD * minD) {
            if (!idle || !(f & F_MOVER)) continue;
            const lm = minD + 7.5;
            if (d2 >= lm * lm) continue;
          }
          const o = items[k];
          if (o === u || !o.alive) continue;
          const os = o.spec, mover = o.speed > 1 && o.moveTarget;
          dx = ux - o.x; dy = uy - o.y;
          if (subU < 0) subU = this.layerOf(u) === 'sub' ? 1 : 0;
          if (subU !== (this.layerOf(o) === 'sub' ? 1 : 0)) continue;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          // share of the correction this unit takes: light units move more than heavy ones
          const ro = os.radius * os.radius;
          const wu = Math.max(0.2, Math.min(1.8, 2 * ro / (ru + ro)));
          if (idle && mover) {
            // stand aside: perpendicular to the mover's heading, on the side we already are
            const hx = Math.cos(o.yaw), hy = Math.sin(o.yaw);
            const ahead = dx * hx + dy * hy, lat = -dx * hy + dy * hx;
            if (ahead > -minD * 0.5 && Math.abs(lat) < minD + 1.5 && d < minD + 3 + o.speed * 0.4) {
              const sg = lat >= 0 ? 1 : -1, push = Math.min(0.9, (minD + 2 - Math.abs(lat)) * 0.3 + 0.15) * wu;
              px += -hy * sg * push; py += hx * sg * push;
              continue;
            }
          }
          if (d < minD) {
            const push = (minD - d) * (u.speed < 0.2 && o.speed > 0.2 ? 0.7 : 0.4) * wu;
            px += dx / d * push; py += dy / d * push;
          }
        }
      }
      if (px || py) {
        u.sepCalm = false;
        const nx = ux + px, ny = uy + py;
        if (this.walkable(us.move, nx, ny) || !this.walkable(us.move, ux, uy)) { u.x = nx; u.y = ny; }
      } else u.sepCalm = true;
    }
  }

  // ---------------------------------------------------------- weapons
  canHit(w, t) { return (wMask(w) & this.layerBitOf(t)) !== 0; }
  // Missile-defence guns (targets: ['missile']) shoot at enemy tactical missiles in flight instead of entities.
  missileValid(e, ws, p) {
    if (!p.alive || this.allied(p.team, e.team) || p.type !== 'missile') return false;
    return hyp2(p.x - e.x, p.y - e.y) <= ws.w.range;
  }
  acquireMissile(e, ws) {
    let best = null, bd = 1e9;
    for (const p of this.projectiles) {
      if (!this.missileValid(e, ws, p)) continue;
      const d = hyp2(p.x - e.x, p.y - e.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  weaponValid(e, ws, t) {
    if (t && t.type && !t.kind) return this.missileValid(e, ws, t);
    if (!t || !t.alive || this.allied(t.team, e.team) || t.carried) return false;
    const w = ws.w;
    if (w.slowOnly && t.kind === 'unit' && t.spec.speed > 5.2 && t.speed > 0.5) return false;   // tactical missiles: buildings and slow / parked targets
    if (w.minValue && (t.spec.costM || 0) < w.minValue) return false;
    if (t.kind === 'struct' && !t.built && t.progress < 0.02) return false;
    if (!(wMask(w) & this.layerBitOf(t))) return false;
    if (!(this.visibleTo(e.team, t) || t.rad[e.team])) return false;
    const dx = t.x - e.x, dy = t.y - e.y, d = Math.sqrt(dx * dx + dy * dy) - (t.spec.radius || 0);
    if (w.proj === 'bomb') return d < 60;
    return d <= w.range && d >= w.minRange - 2;
  }
  // Score of `t` as a target for weapon `w` of `e` (NaN if it cannot be shot right now). Same rules as weaponValid + priority.
  _acqScore(e, w, wm, t) {
    if (!t.alive || this.allied(t.team, e.team) || t.carried) return NaN;
    if (w.slowOnly && t.kind === 'unit' && t.spec.speed > 5.2 && t.speed > 0.5) return NaN;   // tactical missiles: buildings and slow / parked targets
    if (w.minValue && (t.spec.costM || 0) < w.minValue) return NaN;
    if (t.kind === 'struct' && !t.built && t.progress < 0.02) return NaN;
    if (!(wm & this.layerBitOf(t))) return NaN;
    if (!(this.visibleTo(e.team, t) || t.rad[e.team])) return NaN;
    const dx = t.x - e.x, dy = t.y - e.y, d = Math.sqrt(dx * dx + dy * dy), dd = d - (t.spec.radius || 0);
    if (w.proj === 'bomb') { if (!(dd < 60)) return NaN; }
    else if (!(dd <= w.range && dd >= w.minRange - 2)) return NaN;
    let sc = -d - (t.hp / t.maxHp) * 20 + (t.spec.dps ? 25 : 0) + (t.kind === 'unit' ? 10 : 0);
    if (t.key === 'acu') sc += 15;
    return sc;
  }
  acquire(e, ws) {
    const w = ws.w, wm = wMask(w);
    let best = null, bs = -1e9;
    // mobile units reuse the candidate list their brain scanned a moment ago (already visibility-filtered and capped)
    const b = e.brain;
    if (b && b.enemies.length && this.tick - b.thinkTick <= 12) {
      const list = b.enemies;
      for (let i = 0; i < list.length; i++) {
        const sc = this._acqScore(e, w, wm, list[i]);
        if (sc > bs) { bs = sc; best = list[i]; }
      }
      return best;
    }
    const H = this.hash, ex = e.x, ey = e.y, R = w.range + 8;
    const nr = H.rows(ex, ey, R + H.maxR), rk = H.rk, items = H.items, xs = H.xs, ys = H.ys, rs = H.rs, tm = H.tm, fl = H.fl, al = this.al, mb = e.team * 8;
    for (let q = 0; q < nr; q++) {
      for (let k = rk[2 * q], k1 = rk[2 * q + 1]; k < k1; k++) {
        if (al[mb + tm[k]] || (fl[k] & F_DEAD)) continue;
        const dx = xs[k] - ex, dy = ys[k] - ey, rr = R + rs[k];
        if (dx * dx + dy * dy > rr * rr) continue;
        const t = items[k];
        const sc = this._acqScore(e, w, wm, t);
        if (sc > bs) { bs = sc; best = t; }
      }
    }
    return best;
  }

  // fall time of a bomb dropped by `e` (released 1 m below it, starts with zero vz) down to the ground under `t`
  bombFall(e, t) { return Math.sqrt(2 * Math.max(4, this.groundZ(e) - 1 - this.terrain.surfaceAt(t.x, t.y)) / G); }

  updateWeapons(e) {
    const isStruct = e.kind === 'struct';
    for (const ws of e.weapons) {
      ws.cd -= DT;
      if (ws.w.silo && !(e.silo && e.silo.stock > 0)) { ws.target = null; continue; }   // silo guns need a built missile
      const aaMissile = ws.aam;
      let t = ws.target;
      if (e.focus && e.focus !== t && this.weaponValid(e, ws, e.focus)) t = e.focus;
      if (!this.weaponValid(e, ws, t)) t = null;
      if (!t && (this.tick + e.id + ws.i) % (aaMissile ? 2 : 6) === 0) t = aaMissile ? this.acquireMissile(e, ws) : this.acquire(e, ws);
      ws.target = t;
      const baseYaw = isStruct ? 0 : e.yaw;
      if (!t) { ws.yaw += angDiff(ws.yaw, 0) * Math.min(1, DT * 2); ws.pitch *= 0.95; continue; }
      const desired = Math.atan2(t.y - e.y, t.x - e.x);
      let aligned;
      if (ws.w.proj === 'bomb') {
        // release on the tick the predicted impact point reaches the (led) target along the flight line, if not too far off to the side
        const T = this.bombFall(e, t), v = hyp2(e.vx, e.vy) || 1;
        const rx = t.x + (t.vx || 0) * T - e.x - e.vx * T, ry = t.y + (t.vy || 0) * T - e.y - e.vy * T;
        const along = (rx * e.vx + ry * e.vy) / v, cross = Math.abs(rx * e.vy - ry * e.vx) / v;
        aligned = along <= v * DT * 0.5 && along > -ws.w.splash && cross < ws.w.splash * 0.6 + (t.spec.radius || 0);
      } else if (ws.w.turret < 0 && !isStruct && e.spec.move === 'air') {
        aligned = Math.abs(angDiff(e.yaw, desired)) < 0.45;
      } else {
        const rel = angDiff(baseYaw, desired);
        const d = angDiff(ws.yaw, rel);
        // missile-defence mounts are fast-tracking: a slow slew let one missile of a volley slip through
        const rate = (aaMissile ? 12 : isStruct ? 3 : 4) * DT;
        ws.yaw += Math.max(-rate, Math.min(rate, d));
        aligned = Math.abs(d) < 0.2 || ws.w.turret < 0;
        const dd = hyp2(t.x - e.x, t.y - e.y);
        ws.pitch = ws.w.proj === 'shell' ? Math.min(0.9, 0.2 + dd / ws.w.range * 0.6) : 0;
      }
      if (aligned && ws.cd <= 0) {
        ws.cd = 1 / ws.w.rof * (0.9 + Math.random() * 0.2);
        this.fire(e, ws, t);
      }
    }
  }

  // Missile-defence shot: a hitscan beam that chips a tactical missile's hit points.
  fireAtMissile(e, ws, p) {
    const w = ws.w, z0 = this.groundZ(e) + e.spec.size * 0.5 + 1.5, yaw = ws.yaw;
    this.fx.push({ type: 'beam', x: e.x + Math.cos(yaw) * 2, y: e.y + Math.sin(yaw) * 2, z: z0, tx: p.x, ty: p.y, tz: p.z, color: w.color, w: 0.6 });
    this.sound('laser', e.x, e.y);
    p.hp -= w.dmg;
    if (p.hp <= 0) this.shootDown(p);
  }
  shootDown(p) {
    p.alive = false;
    this.fx.push({ type: 'explode', x: p.x, y: p.y, z: p.z, size: p.tac ? 4 : 3, air: true });
    this.sound('explode', p.x, p.y);
    this.events.push({ type: 'missileDown', p });
  }

  fire(e, ws, t) {
    if (t.type && !t.kind) { this.fireAtMissile(e, ws, t); return; }
    const w = ws.w;
    if (w.silo) { if (!(e.silo && e.silo.stock > 0)) return; e.silo.stock--; }
    const z0 = this.groundZ(e) + (e.kind === 'struct' ? e.spec.size * 0.35 + 1 : e.spec.move === 'air' ? -0.5 : Math.max(1, e.spec.radius * 0.6));
    const tz = this.groundZ(t) + (t.kind === 'struct' ? t.spec.size * 0.25 : 0.8);
    const base = { team: e.team, dmg: w.dmg, splash: w.splash, layers: w.targets, color: w.color, from: e, alive: true, target: t };
    if (t && t.hp !== undefined && w.proj !== 'laser' && w.proj !== 'kami') t.inFlightDmg = (t.inFlightDmg || 0) + w.dmg * (w.salvo || 1);
    const d = hyp2(t.x - e.x, t.y - e.y);
    for (let k = 0; k < w.salvo; k++) {
      const off = w.salvo > 1 ? (k - (w.salvo - 1) / 2) * 1.2 : 0;
      const yaw = (e.kind === 'struct' ? 0 : e.yaw) + ws.yaw;
      const mx = e.x + Math.cos(yaw) * (e.spec.radius || 2) * 0.8 - Math.sin(yaw) * off, my = e.y + Math.sin(yaw) * (e.spec.radius || 2) * 0.8 + Math.cos(yaw) * off;
      switch (w.proj) {
        case 'laser': {
          this.damage(t, w.dmg, e.team, e);
          if (w.splash) { this.splash(t.x, t.y, tz, w.splash, w.dmg * 0.5, e.team, w.targets, e); this.fx.push({ type: 'explode', x: t.x, y: t.y, z: tz, size: w.splash * 0.6 }); }
          this.fx.push({ type: 'beam', x: mx, y: my, z: e.spec.move === 'air' ? z0 - 3 : z0 + 2, tx: t.x, ty: t.y, tz, color: w.color, w: e.spec.radius > 5 ? 1.4 : 0.6 });
          this.sound('laser', e.x, e.y);
          break;
        }
        case 'bullet': case 'flak': {
          const tv = t.kind === 'unit' ? [t.vx || 0, t.vy || 0] : [0, 0];
          const tt = d / w.speed;
          const spread = w.proj === 'flak' ? 2 : 0.6;
          const ax = t.x + tv[0] * tt + (Math.random() - 0.5) * spread, ay = t.y + tv[1] * tt + (Math.random() - 0.5) * spread;
          this.projectiles.push({ ...base, type: w.proj, x: mx, y: my, z: z0, sx: mx, sy: my, sz: z0, tx: ax, ty: ay, tz, speed: w.speed, life: tt + 0.5, t: 0, T: Math.max(0.05, Math.hypot(ax - mx, ay - my) / w.speed) });
          this.sound(w.proj === 'flak' ? 'flak' : (w.dmg > 100 ? 'cannonL' : 'cannon'), e.x, e.y);
          break;
        }
        case 'shell': {
          const tv = t.kind === 'unit' ? [t.vx || 0, t.vy || 0] : [0, 0];
          const T = Math.max(0.7, d / w.speed);
          const acc = w.splash > 0 ? 0.035 : 0.02;
          const ax = t.x + tv[0] * T * 0.8 + (Math.random() - 0.5) * d * acc * 2, ay = t.y + tv[1] * T * 0.8 + (Math.random() - 0.5) * d * acc * 2;
          const tzz = this.terrain.surfaceAt(ax, ay);
          const vz = (tzz - z0 + 0.5 * G * T * T) / T;
          this.projectiles.push({ ...base, type: 'shell', x: mx, y: my, z: z0, vx: (ax - mx) / T, vy: (ay - my) / T, vz, tx: ax, ty: ay, life: T + 1, wh: T < 2 });
          this.impacts.push({ x: ax, y: ay, r: Math.max(w.splash, 2), t: this.time + T, team: e.team });
          this.sound('arty', e.x, e.y);
          break;
        }
        case 'missile': case 'aamissile': {
          const up = w.proj === 'missile' ? Math.min(1, d / 80) : 0.1;
          this.projectiles.push({ ...base, type: w.proj, x: mx, y: my, z: z0, vx: Math.cos(yaw) * w.speed * 0.4, vy: Math.sin(yaw) * w.speed * 0.4, vz: w.speed * (0.25 + up * 0.8), speed: w.speed, life: d / w.speed * 2.2 + 2, hp: w.mhp || 35, full: !!w.full, tac: !!w.silo });
          this.sound(w.proj === 'aamissile' ? 'aa' : 'missile', e.x, e.y);
          break;
        }
        case 'torpedo': {
          const zz = this.terrain.water - 1.5;
          this.projectiles.push({ ...base, type: 'torpedo', x: mx, y: my, z: zz, vx: Math.cos(yaw) * w.speed, vy: Math.sin(yaw) * w.speed, vz: 0, speed: w.speed, life: d / w.speed * 1.8 + 1 });
          this.sound('torpedo', e.x, e.y);
          break;
        }
        case 'kami': {   // дрон-камикадзе: подрыв над целью, сам гибнет
          this.damage(t, w.dmg, e.team, e);
          this.splash(e.x, e.y, tz, w.splash, w.dmg * 0.5, e.team, w.targets, e);
          this.fx.push({ type: 'explode', x: e.x, y: e.y, z: tz + 1, size: w.splash });
          this.sound('explode', e.x, e.y);
          this.kill(e, null, 0);
          return;
        }
        case 'bomb': {
          const zb = this.groundZ(e) - 1;
          const T = this.bombFall(e, t);
          this.projectiles.push({ ...base, type: 'bomb', x: e.x + (Math.random() - 0.5), y: e.y + (Math.random() - 0.5), z: zb, vx: e.vx, vy: e.vy, vz: 0, life: 6 });
          this.impacts.push({ x: e.x + e.vx * T, y: e.y + e.vy * T, r: w.splash, t: this.time + T, team: e.team });
          this.sound('bomb', e.x, e.y);
          break;
        }
      }
    }
    if (w.proj !== 'bomb' && w.proj !== 'torpedo') this.fx.push({ type: 'muzzle', x: e.x + Math.cos((e.kind === 'struct' ? 0 : e.yaw) + ws.yaw) * (e.spec.radius || 2), y: e.y + Math.sin((e.kind === 'struct' ? 0 : e.yaw) + ws.yaw) * (e.spec.radius || 2), z: z0, color: w.color, size: Math.min(3, 0.6 + w.dmg / 150), src: e.id, wi: ws.i });
  }

  // ---------------------------------------------------------- projectiles
  shieldCheck(p, ox, oy, oz) {
    if (p.type === 'torpedo' || p.type === 'laser') return false;
    for (const s of this.shields) {
      if (this.allied(s.team, p.team) || !s.shield.on) continue;
      const sz = this.groundZ(s);
      const r2 = s.shield.r * s.shield.r;
      const dNow = (p.x - s.x) ** 2 + (p.y - s.y) ** 2 + (p.z - sz) ** 2;
      const dOld = (ox - s.x) ** 2 + (oy - s.y) ** 2 + (oz - sz) ** 2;
      if (dNow < r2 && dOld >= r2) {
        if (p.target && p.target.inFlightDmg) p.target.inFlightDmg = Math.max(0, p.target.inFlightDmg - p.dmg);
        s.shield.hp -= p.dmg; s.shield.flash = 1;
        this.fx.push({ type: 'shieldhit', x: p.x, y: p.y, z: p.z, sid: s.id });
        if (s.shield.hp <= 0) { s.shield.hp = 0; s.shield.on = false; this.notify(s.team, 'Щит перегружен!', s.x, s.y, 'alert'); }
        p.alive = false;
        return true;
      }
    }
    return false;
  }

  impact(p, x, y, z) {
    p.alive = false;
    const t = p.target;
    if (t && t.inFlightDmg) t.inFlightDmg = Math.max(0, t.inFlightDmg - p.dmg);
    if (p.splash > 0) {
      if (t && t.alive && !p.full && p.type !== 'shell' && p.type !== 'bomb' && (p.fused || hyp2(t.x - x, t.y - y) < (t.spec.radius || 1) + 1.5)) this.damage(t, p.dmg * 0.5, p.team, p.from);
      this.splash(x, y, z, p.splash, p.type === 'shell' || p.type === 'bomb' || p.full ? p.dmg : p.dmg * 0.5, p.team, p.layers, p.from);
      this.fx.push({ type: 'explode', x, y, z, size: p.splash * 0.7, air: p.type === 'flak', water: this.terrain.isWater(x, y) });
      this.sound(p.type === 'flak' ? 'burst' : p.splash > 5 ? 'explodeL' : 'explode', x, y);
    } else if (t && t.alive && (p.fused || hyp2(t.x - x, t.y - y) < (t.spec.radius || 1) + 1.6)) {
      this.damage(t, p.dmg, p.team, p.from);
      this.fx.push({ type: 'hit', x, y, z, color: p.color });
    } else {
      this.fx.push({ type: 'miss', x, y, z: this.terrain.surfaceAt(x, y), water: this.terrain.isWater(x, y) });
    }
  }

  // Anti-missile met a nuke: both vanish in an airburst, no damage on the ground.
  interceptNuke(a, n) {
    a.alive = false; n.alive = false;
    this.fx.push({ type: 'explode', x: n.x, y: n.y, z: n.z, size: 14, air: true, burst: true });
    this.sound('explodeL', n.x, n.y);
    const at = n.from ? n.from.team : n.team;
    this.notify(a.team, 'Ядерная ракета перехвачена!', n.x, n.y, 'good');
    this.notify(at, 'Ядерная ракета перехвачена противником', n.x, n.y, 'alert');
    this.events.push({ type: 'nukeIntercepted', team: a.team, x: n.x, y: n.y, z: n.z });
  }

  updateProjectile(p) {
    const ox = p.x, oy = p.y, oz = p.z;
    p.life -= DT;
    if (p.life <= 0 && p.alive) {
      p.alive = false;
      if (p.target && p.target.inFlightDmg) p.target.inFlightDmg = Math.max(0, p.target.inFlightDmg - p.dmg);
      return;
    }
    switch (p.type) {
      case 'bullet': case 'flak': case 'oc': {
        if (p.type === 'oc') {
          const t = p.target;
          if (t && t.alive) { p.tx = t.x; p.ty = t.y; p.tz = this.groundZ(t) + 1; }
          const d = Math.hypot(p.tx - p.x, p.ty - p.y, p.tz - p.z);
          const st = p.speed * DT;
          if (d <= st) {
            p.alive = false;
            if (t && t.alive) this.damage(t, p.dmg, p.team, p.from);
            this.splash(p.tx, p.ty, p.tz, p.splash, p.dmg * 0.6, p.team, p.layers, p.from);
            this.fx.push({ type: 'explode', x: p.tx, y: p.ty, z: p.tz, size: 5, oc: true });
            this.sound('explodeL', p.tx, p.ty);
            return;
          }
          p.x += (p.tx - p.x) / d * st; p.y += (p.ty - p.y) / d * st; p.z += (p.tz - p.z) / d * st;
          break;
        }
        p.t += DT;
        const k = Math.min(1, p.t / p.T);
        p.x = p.sx + (p.tx - p.sx) * k; p.y = p.sy + (p.ty - p.sy) * k; p.z = p.sz + (p.tz - p.sz) * k;
        if (k >= 1) { this.impact(p, p.x, p.y, p.z); return; }
        break;
      }
      case 'shell': case 'bomb': {
        if (p.type === 'shell' && !p.wh && p.life < 2.6) { p.wh = true; this.sound('whistle', p.tx, p.ty); }   // incoming rush ~1.5 s before impact (long flights only)
        p.vz -= G * DT;
        p.x += p.vx * DT; p.y += p.vy * DT; p.z += p.vz * DT;
        if (p.vz < 0 && p.z <= this.terrain.surfaceAt(p.x, p.y)) { this.impact(p, p.x, p.y, this.terrain.surfaceAt(p.x, p.y)); return; }
        break;
      }
      case 'nuke': {
        // ballistic arc: vertical climb, apex H, steep dive; horizontal progress eased with smoothstep
        p.t += DT;
        const u = Math.min(1, p.t / p.T), h = u * u * (3 - 2 * u);
        const nx = p.sx + (p.tx - p.sx) * h, ny = p.sy + (p.ty - p.sy) * h, nz = p.sz + (p.tz - p.sz) * h + 4 * p.H * u * (1 - u);
        p.vx = (nx - p.x) * TPS; p.vy = (ny - p.y) * TPS; p.vz = (nz - p.z) * TPS;
        p.x = nx; p.y = ny; p.z = nz; p.u = u;
        if (u >= 1) this.nukeBlast(p);
        return;
      }
      case 'amissile': {
        const t = p.target;
        if (!t || !t.alive) {   // the nuke already hit the ground or was shot down: self-destruct
          p.alive = false; this.fx.push({ type: 'explode', x: p.x, y: p.y, z: p.z, size: 3, air: true }); return;
        }
        p.spd = Math.min(p.speed, p.spd + p.speed * 0.8 * DT);
        const d = Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z);
        const tgo = Math.min(4, d / p.spd);
        const dx = t.x + t.vx * tgo - p.x, dy = t.y + t.vy * tgo - p.y, dz = t.z + t.vz * tgo - p.z, dd = Math.hypot(dx, dy, dz) || 1;
        const k = Math.min(1, 5 * DT);
        p.vx += (dx / dd * p.spd - p.vx) * k; p.vy += (dy / dd * p.spd - p.vy) * k; p.vz += (dz / dd * p.spd - p.vz) * k;
        const v = Math.hypot(p.vx, p.vy, p.vz) || 1;
        p.vx = p.vx / v * p.spd; p.vy = p.vy / v * p.spd; p.vz = p.vz / v * p.spd;
        p.x += p.vx * DT; p.y += p.vy * DT; p.z += p.vz * DT;
        if (Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z) < 8) this.interceptNuke(p, t);
        else if (p.life <= 0) { p.alive = false; this.fx.push({ type: 'explode', x: p.x, y: p.y, z: p.z, size: 3, air: true }); }
        return;
      }
      case 'missile': case 'aamissile': case 'torpedo': {
        const t = p.target, live = t && t.alive;
        // target velocity: unit vx / vy, vertical speed from the change of the aim height (aircraft climb / dive to their altitude)
        let tvx = 0, tvy = 0, tvz = 0;
        if (live) {
          const z = this.groundZ(t) + (t.kind === 'struct' ? 2 : 0.5);
          if (t.kind === 'unit') { tvx = t.vx || 0; tvy = t.vy || 0; }
          if (p.ltz !== undefined) tvz = (z - p.ltz) * TPS;
          p.ltz = z; p.tx = t.x; p.ty = t.y; p.tz = z;
        }
        if (p.tx === undefined) { p.alive = false; return; }
        if (p.type === 'torpedo') p.tz = Math.min(p.tz, this.terrain.water - 1);
        const dx = p.tx - p.x, dy = p.ty - p.y, dz = p.tz - p.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        const hd = hyp2(dx, dy);
        // lead pursuit: fly to the point where a missile of this speed meets the target moving at a constant velocity
        let ax = dx, ay = dy, az = dz;
        if (live && (tvx || tvy || tvz)) {
          const s = p.speed, A = tvx * tvx + tvy * tvy + tvz * tvz - s * s, B = 2 * (dx * tvx + dy * tvy + dz * tvz), C = dx * dx + dy * dy + dz * dz;
          let tau = d / s;
          if (Math.abs(A) > 1e-6) { const D = B * B - 4 * A * C; if (D >= 0) { const q = Math.sqrt(D), r1 = (-B - q) / (2 * A), r2 = (-B + q) / (2 * A); const m = Math.min(r1, r2), M = Math.max(r1, r2); tau = m > 0 ? m : M > 0 ? M : tau; } }
          tau = Math.min(tau, 3);
          ax = dx + tvx * tau; ay = dy + tvy * tau; az = dz + tvz * tau;
        }
        const ad = Math.hypot(ax, ay, az) || 1;
        // turn rate grows as the missile closes in (its turn radius speed / turn must shrink below the distance to the target)
        const base = p.type === 'aamissile' ? 7 : p.type === 'missile' ? (hd > 25 ? 1.6 : 6) : 3;
        const turn = base + (p.type === 'missile' && hd > 25 ? 0 : 12 * Math.max(0, 1 - d / 35));
        let wantZ = az / ad;
        if (p.type === 'missile' && hd > 30) wantZ = Math.max(wantZ, 0.15);
        const wx = ax / ad * p.speed, wy = ay / ad * p.speed, wz = wantZ * p.speed;
        const k = Math.min(1, turn * DT);
        p.vx += (wx - p.vx) * k; p.vy += (wy - p.vy) * k; p.vz += (wz - p.vz) * k;
        const v = Math.hypot(p.vx, p.vy, p.vz) || 1;
        p.vx = p.vx / v * p.speed; p.vy = p.vy / v * p.speed; p.vz = p.vz / v * p.speed;
        p.x += p.vx * DT; p.y += p.vy * DT; p.z += p.vz * DT;
        if (p.type === 'torpedo') { p.z = Math.min(this.terrain.water - 1.2, Math.max(this.terrain.heightAt(p.x, p.y) + 0.5, p.z)); if (!this.terrain.isWater(p.x, p.y)) { this.impact(p, p.x, p.y, p.z); return; } }
        const rad = live ? t.spec.radius : 1, hitR = rad + 1.5;
        const d2 = Math.hypot(p.tx - p.x, p.ty - p.y, p.tz - p.z);
        if (d2 < hitR) { this.impact(p, p.x, p.y, p.z); return; }
        // proximity fuse: the missile is passing the target (distance started to grow) close enough to hurt it
        if (live && p.pd !== undefined && d2 > p.pd && p.pd < Math.max(4, rad + 2)) { p.fused = true; this.impact(p, p.x, p.y, p.z); return; }
        p.pd = d2;
        if (p.type !== 'aamissile' && p.z < this.terrain.heightAt(p.x, p.y) - 0.5 && p.type !== 'torpedo') { this.impact(p, p.x, p.y, p.z); return; }
        break;
      }
    }
    if (this.shields.length && this.shieldCheck(p, ox, oy, oz)) return;
    if (p.life <= 0) this.impact(p, p.x, p.y, p.z);
  }
}

// Formation slots as [lateral, depth] in slot units, centred on the order point; first slots = front / outer ring.
export function formationSlots(type, n, width = 0) {
  const out = [];
  if (type === 'none') {
    for (let i = 0; i < n; i++) { const r = Math.sqrt(i) * 0.62, a = i * 2.39996; out.push([Math.cos(a) * r, Math.sin(a) * r]); }
    return out;
  }
  if (type === 'box') {
    const w = width || Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / w);
    for (let r = 0; r < rows; r++) for (let c = 0; c < w; c++) out.push([c - (w - 1) / 2, r - (rows - 1) / 2]);
    const ring = (s) => Math.max(Math.abs(s[0]) / Math.max(1, w - 1), Math.abs(s[1]) / Math.max(1, rows - 1));
    return out.sort((a, b) => ring(b) - ring(a)).slice(0, n);
  }
  if (type === 'wedge') {
    for (let r = 0; out.length < n; r++) for (let c = -r; c <= r && out.length < n; c++) out.push([c * 0.9, r * 0.8]);
  } else {
    const w = width || (type === 'column' ? (n > 16 ? 3 : 2) : Math.max(2, Math.ceil(Math.sqrt(n * 2.5))));
    for (let i = 0; i < n; i++) { const r = Math.floor(i / w), cnt = Math.min(w, n - r * w); out.push([(i % w) - (cnt - 1) / 2, r]); }
  }
  const depth = Math.max(...out.map(s => s[1]));
  return out.map(([c, r]) => [c, r - depth / 2]);
}

function stamp(grid, x, y, r) {
  const cr = Math.ceil(r / PCELL);
  const cx = (x / PCELL) | 0, cy = (y / PCELL) | 0;
  const r2 = (r / PCELL) ** 2;
  for (let j = -cr; j <= cr; j++) {
    const yy = cy + j; if (yy < 0 || yy >= PN) continue;
    for (let i = -cr; i <= cr; i++) {
      const xx = cx + i; if (xx < 0 || xx >= PN) continue;
      if (i * i + j * j <= r2) grid[yy * PN + xx] = 1;
    }
  }
}

// Drop dead entries in place (keeps order).
function compact(arr) {
  let j = 0;
  for (let i = 0, n = arr.length; i < n; i++) { const e = arr[i]; if (e.alive) arr[j++] = e; }
  arr.length = j;
}
