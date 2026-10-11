// «Бой или отход»: нейросеть-предсказатель исхода стычки (модель юнитов v1.0, см. ml/PLAN.md).
// buildFeatures() превращает два списка юнитов (+ укрепления рядом + рельеф) в вектор фиксированного размера;
// им пользуются и генератор данных (ml/gen_skirmish.mjs), и игра. predictFight() считает MLP из ml/models/combat_v1.json.
// Нет файла весов -> predictFight/shouldEngage возвращают null, вызывающий остаётся на эвристике (powerOf).
import { chainCost } from './specs.js';
import { MLP } from './nn.js';

export const MODEL_VERSION = 'combat_v1';
const LI = { land: 0, air: 1, naval: 2, sub: 3 };
const NC = 8;   // классы: 0 прямой огонь, 1 артиллерия, 2 ПВО, 3 истребители, 4 штурмовая авиация, 5 флот, 6 эксперименталы, 7 командиры
export const valueOf = (spec) => spec.costM || (spec.role === 'cmd' ? 3000 : 50);
export const structValue = (key) => chainCost(key).m;

function unitClass(s) {
  if (s.role === 'cmd' || s.key === 'sacu') return 7;
  if (s.role === 'exp') return 6;
  if (s.role === 'naval' || s.role === 'sub') return 5;
  if (s.move === 'air') return s.role === 'bomber' || s.role === 'gunship' ? 4 : 3;
  return s.role === 'arty' ? 1 : s.role === 'aa' ? 2 : 0;
}

// Per-spec constants (WeakMap: ACU gets a fresh spec object per enhancement set).
const CACHE = new WeakMap();
function info(s) {
  let c = CACHE.get(s); if (c) return c;
  const dps = [0, 0, 0, 0]; let all = 0, rw = 0, mr = 0;
  for (const w of s.weapons || []) {
    if (w.targets.every(t => t === 'missile')) continue;
    const d = w.dmg * w.rof * w.salvo;
    all += d; rw += d * w.range; if (w.range > mr) mr = w.range;
    for (const t of w.targets) { const i = LI[t]; if (i !== undefined) dps[i] += d; }
  }
  const st = !!s.isStruct;
  c = { cls: st ? -1 : unitClass(s), dps, all, rw, mr, speed: s.speed || 0, air: s.move === 'air', armed: all > 0,
    hl: st ? (s.layer === 'naval' ? 2 : 0) : (LI[s.layer] ?? 0), value: st ? structValue(s.key) : valueOf(s), shield: st ? (s.shield ? s.shield.hp : 0) : 0 };
  CACHE.set(s, c);
  return c;
}

const mkSide = () => ({
  cnt: new Float64Array(NC), hpC: new Float64Array(NC), dpsC: new Float64Array(NC), dps: new Float64Array(4), hpL: new Float64Array(4),
  sDps: new Float64Array(4)
});
const SA = mkSide(), SB = mkSide();

function accum(S, units, structs) {
  S.cnt.fill(0); S.hpC.fill(0); S.dpsC.fill(0); S.dps.fill(0); S.hpL.fill(0); S.sDps.fill(0);
  let n = 0, hp = 0, hpMax = 0, rw = 0, dpsSum = 0, maxR = 0, longD = 0, spd = 0, spdW = 0, minSpd = 99, ps = 0, pow = 0, val = 0, cx = 0, cy = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i]; if (u.alive === false) continue;
    const f = info(u.spec); if (!f.armed) continue;
    const h = u.hp;
    n++; hp += h; hpMax += u.maxHp; S.cnt[f.cls]++; S.hpC[f.cls] += h; S.dpsC[f.cls] += f.all;
    for (let l = 0; l < 4; l++) S.dps[l] += f.dps[l];
    S.hpL[f.hl] += h; rw += f.rw; dpsSum += f.all; if (f.mr > maxR) maxR = f.mr;
    if (f.rw / f.all > 90) longD += f.all;
    if (!f.air) { spd += f.speed * f.all; spdW += f.all; if (f.speed < minSpd) minSpd = f.speed; }
    if (u.pshield) ps += u.pshield.hp;
    pow += Math.sqrt(f.all * Math.max(1, h)); val += f.value * h / u.maxHp; cx += u.x; cy += u.y;
  }
  let sn = 0, sHp = 0, sMr = 0, sShield = 0, sVal = 0, sx = 0, sy = 0;
  if (structs) for (let i = 0; i < structs.length; i++) {
    const s = structs[i]; if (s.alive === false || s.built === false) continue;
    const f = info(s.spec); if (!f.armed && !f.shield) continue;
    sn++; sHp += s.hp; S.hpL[f.hl] += s.hp; sShield += f.shield; sVal += f.value * s.hp / s.maxHp; sx += s.x; sy += s.y;
    if (f.armed) { for (let l = 0; l < 4; l++) S.sDps[l] += f.dps[l]; if (f.mr > sMr) sMr = f.mr; pow += Math.sqrt(f.all * Math.max(1, s.hp)); }
  }
  if (n) { cx /= n; cy /= n; } else if (sn) { cx = sx / sn; cy = sy / sn; }
  let sp = 0;
  for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.alive === false || !info(u.spec).armed) continue; sp += (u.x - cx) ** 2 + (u.y - cy) ** 2; }
  S.n = n; S.hp = hp; S.hpMax = hpMax; S.rw = rw; S.dpsSum = dpsSum; S.maxR = maxR; S.longD = longD; S.spd = spdW ? spd / spdW : 0; S.minSpd = minSpd === 99 ? 0 : minSpd;
  S.ps = ps; S.pow = pow; S.val = val; S.cx = cx; S.cy = cy; S.spread = n ? Math.sqrt(sp / n) : 0;
  S.sn = sn; S.sHp = sHp; S.sMr = sMr; S.sShield = sShield; S.sVal = sVal; S.sDist = sn ? Math.hypot(sx / sn - cx, sy / sn - cy) : 0;
  S.hpTot = hp + sHp;
}

let O = null, K = 0, NM = null;
const put = (v, nm) => { O[K++] = v; if (NM) NM.push(nm); };
const l1 = Math.log1p, clamp = (v, a, b) => v < a ? a : v > b ? b : v;

function emitSide(S, p) {
  const nm = !!NM;
  for (let c = 0; c < NC; c++) {
    put(l1(S.cnt[c]) / 3.7, nm && p + 'cnt' + c);
    put(l1(S.hpC[c]) / 14, nm && p + 'hp' + c);
    put(l1(S.dpsC[c]) / 10, nm && p + 'dps' + c);
  }
  put(l1(S.n) / 3.7, nm && p + 'n');
  put(S.hpMax ? S.hp / S.hpMax : 1, nm && p + 'hpfrac');
  for (let l = 0; l < 4; l++) put(l1(S.dps[l]) / 10, nm && p + 'dpsL' + l);
  for (let l = 0; l < 4; l++) put(l1(S.hpL[l]) / 14, nm && p + 'hpL' + l);
  put(S.dpsSum ? S.rw / S.dpsSum / 150 : 0, nm && p + 'rangeAvg');
  put(S.maxR / 300, nm && p + 'rangeMax');
  put(S.dpsSum ? S.longD / S.dpsSum : 0, nm && p + 'longShare');
  put(S.spd / 12, nm && p + 'speed');
  put(S.minSpd / 12, nm && p + 'speedMin');
  put(S.hp ? S.hpL[1] / S.hp : 0, nm && p + 'airShare');
  put(l1(S.ps) / 9, nm && p + 'pshield');
  put(l1(S.pow) / 9, nm && p + 'power');
  put(l1(S.val) / 11, nm && p + 'value');
  put(S.spread / 60, nm && p + 'spread');
  put(l1(S.sn) / 3, nm && p + 'sn');
  for (let l = 0; l < 4; l++) put(l1(S.sDps[l]) / 10, nm && p + 'sDpsL' + l);
  put(l1(S.sHp) / 14, nm && p + 'sHp');
  put(S.sMr / 300, nm && p + 'sRange');
  put(l1(S.sShield) / 10, nm && p + 'sShield');
  put(S.sDist / 100, nm && p + 'sDist');
}

// effective DPS of side X against the layer mix of side Y's hit points (units + structures)
function effDps(X, Y) {
  const hp = Y.hpTot; if (hp <= 0) return 0;
  let e = 0;
  for (let l = 0; l < 4; l++) e += (X.dps[l] + X.sDps[l]) * Y.hpL[l] / hp;
  return e;
}

function terrainFeats(T, ax, ay, bx, by) {
  const nm = !!NM;
  if (!T) { for (let i = 0; i < 12; i++) put(i < 3 ? 0 : 1, nm && 'terr' + i); return; }
  const hA = T.heightAt(ax, ay), hB = T.heightAt(bx, by), mx = (ax + bx) / 2, my = (ay + by) / 2;
  let land = 0, nav = 0, slope = 0, hmax = -1e9, ph = hA;
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const x = ax + (bx - ax) * i / N, y = ay + (by - ay) * i / N, h = T.heightAt(x, y);
    if (T.terrainPass('land', x, y)) land++;
    if (T.terrainPass('naval', x, y)) nav++;
    slope += Math.abs(h - ph); ph = h; if (h > hmax) hmax = h;
  }
  const ring = (cx, cy, r) => { let o = 0; for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; if (T.terrainPass('land', cx + Math.cos(a) * r, cy + Math.sin(a) * r)) o++; } return o / 12; };
  let wet = 0;
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; if (T.isWater(mx + Math.cos(a) * 30, my + Math.sin(a) * 30)) wet++; }
  put(clamp((hA - hB) / 25, -2, 2), nm && 'dH');
  put(hA / 50, nm && 'hA'); put(hB / 50, nm && 'hB');
  put(clamp((hmax - Math.max(hA, hB)) / 20, 0, 3), nm && 'ridge');
  put(land / (N + 1), nm && 'lineLand'); put(nav / (N + 1), nm && 'lineNaval');
  put(slope / Math.max(1, Math.hypot(bx - ax, by - ay)) * 4, nm && 'lineSlope');
  put(ring(mx, my, 35), nm && 'openMid'); put(ring(ax, ay, 22), nm && 'openA'); put(ring(bx, by, 22), nm && 'openB');
  put(wet / 8, nm && 'wetMid');
  put(T.isWater(ax, ay) ? 1 : 0, nm && 'wetA');
}

// A, B: списки юнитов (spec, hp, maxHp, x, y, pshield); ctx: { terrain, sa, sb } — укрепления рядом со сторонами.
export function buildFeatures(A, B, ctx, out) {
  O = out; K = 0;
  accum(SA, A, ctx && ctx.sa); accum(SB, B, ctx && ctx.sb);
  emitSide(SA, 'a_'); emitSide(SB, 'b_');
  const nm = !!NM;
  const eAB = effDps(SA, SB), eBA = effDps(SB, SA);
  const ttkB = SB.hpTot / Math.max(1, eAB), ttkA = SA.hpTot / Math.max(1, eBA);
  put(clamp(Math.log((SA.hpTot + 1) / (SB.hpTot + 1)), -4, 4) / 4, nm && 'rHp');
  put(l1(eAB) / 10, nm && 'eDpsAB'); put(l1(eBA) / 10, nm && 'eDpsBA');
  put(clamp(Math.log((ttkB + 1) / (ttkA + 1)), -5, 5) / 5, nm && 'rTtk');
  put(clamp(Math.log((SA.pow + 1) / (SB.pow + 1)), -4, 4) / 4, nm && 'rPow');
  put(clamp(Math.log((SA.val + 1) / (SB.val + 1)), -4, 4) / 4, nm && 'rVal');
  put(clamp(Math.log((SA.n + 1) / (SB.n + 1)), -3, 3) / 3, nm && 'rN');
  const dc = Math.hypot(SA.cx - SB.cx, SA.cy - SB.cy);
  let dm = 1e9;
  for (let i = 0; i < A.length; i++) { const u = A[i]; if (u.alive === false) continue; for (let j = 0; j < B.length; j++) { const v = B[j]; if (v.alive === false) continue; const d = Math.hypot(u.x - v.x, u.y - v.y); if (d < dm) dm = d; } }
  put(dc / 300, nm && 'dist'); put(Math.min(dm, 600) / 300, nm && 'distMin');
  put(clamp((SA.rw / Math.max(1, SA.dpsSum) - SB.rw / Math.max(1, SB.dpsSum)) / 100, -2, 2), nm && 'rRange');
  put(clamp(Math.log((SA.spd + 1) / (SB.spd + 1)), -2, 2), nm && 'rSpeed');
  terrainFeats(ctx && ctx.terrain, SA.cx, SA.cy, SB.cx, SB.cy);
  O = null;
  return out;
}

export const FEAT_NAMES = (() => {
  NM = []; buildFeatures([], [], null, new Float32Array(512)); const n = NM; NM = null; return n;
})();
export const N_FEAT = FEAT_NAMES.length;

// ---------------------------------------------------------------- inference
let net = null;
const X = new Float32Array(N_FEAT);
const R = { pWin: 0.5, tradeAttack: 0, tradeRetreat: 0, keepA: 1, keepB: 1 };

export function setCombatNet(json) {
  if (!json || json.version !== MODEL_VERSION || json.layers[0].in !== N_FEAT || json.features?.join() !== FEAT_NAMES.join()) { net = null; return false; }
  net = new MLP(json); return true;
}
export const hasCombatNet = () => !!net;

// Node: читает файл; браузер: fetch. Нет файла / не та версия признаков -> false, игра остаётся на эвристике.
export async function loadCombatNet(url) {
  try {
    const u = url || new URL('../ml/models/combat_v1.json', import.meta.url);
    let j;
    if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node) {
      const fs = await import('node:fs');
      j = JSON.parse(fs.readFileSync(u, 'utf8'));   // URL или путь к файлу
    } else {
      const r = await fetch(u); if (!r.ok) return false;
      j = await r.json();
    }
    return setCombatNet(j);
  } catch (e) { return false; }
}

// Исход стычки A против B. Возвращает общий объект (скопируйте, если нужно хранить) или null без модели.
// pWin — вероятность, что A выйдет из боя «в плюсе» при атаке; trade* — ожидаемый размен массы (в долях суммарной массы сторон)
// при атаке и при отходе; keepA/keepB — доля стоимости, которую сохранят стороны при атаке.
export function predictFight(A, B, ctx) {
  if (!net) return null;
  buildFeatures(A, B, ctx, X);
  const y = net.forward(X);
  R.pWin = 1 / (1 + Math.exp(-y[0])); R.tradeAttack = y[1]; R.tradeRetreat = y[2];
  R.keepA = clamp(y[3], 0, 1); R.keepB = clamp(y[4], 0, 1);
  return R;
}

// 'engage' — атаковать, 'wait' — сейчас невыгодно, но с подкреплением (ctx.reinf) выгодно, 'retreat' — отходить; null — нет модели.
export function shouldEngage(A, B, ctx, margin = 0.02) {
  const r = predictFight(A, B, ctx); if (!r) return null;
  if (r.tradeAttack - r.tradeRetreat > margin) return 'engage';
  if (ctx && ctx.reinf && ctx.reinf.length) {
    const r2 = predictFight(A.concat(ctx.reinf), B, ctx);
    if (r2 && r2.tradeAttack - r2.tradeRetreat > margin) return 'wait';
  }
  return 'retreat';
}

// В node (selftest, бенчмарки, генераторы) веса грузятся сразу при импорте; в браузере — main.js вызывает loadCombatNet() в фоне.
if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node && !globalThis.__NO_COMBATNET) await loadCombatNet();
