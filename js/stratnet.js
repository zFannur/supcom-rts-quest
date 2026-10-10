// Стратегическая модель v1.0 (ml/PLAN.md): раз в 60–90 с ИИ выбирает макро-действие — набор смещений «намерений» и рычагов экономики/армии
// (INTENTS в ai.js). Q(состояние, действие) + V(состояние) = вероятность победы; веса — ml/models/strategy_v1.json (ml/train_strategy.py).
// Нет файла весов -> политики нет, ИИ играет как раньше (действие BASE).
import { MLP } from './nn.js';

export const MODEL_VERSION = 'strategy_v1';
// cap — потолок доли дохода на армию; atk — насколько брать более равные бои; hold — не начинать атаки; aa — добавка к потребности в ПВО; air/land — сдвиг веса заводов;
// bias — добавка к весу намерения (0..1.2); army / eco — множители доли дохода армии / экономики (заводы, апгрейд экстракторов);
// minN — множитель минимального размера ударной группы; expInc — доход, с которого строим экспериментал; silo — ядерные шахты раньше и больше.
export const MACROS = [
  { key: 'BASE', ru: 'Обычный ход' },
  { key: 'ECON', ru: 'Экономика', bias: { ECO: 0.5, TECH: 0.2, ATTACK: -0.35, ARMY: -0.2 }, army: 0.6, cap: 0.25, eco: 1.8, minN: 1.4 },
  { key: 'TECH', ru: 'Техно-рывок', bias: { TECH: 0.8, ATTACK: -0.2 }, eco: 1.4, army: 0.85, cap: 0.4 },
  { key: 'ARMY', ru: 'Наращивание армии', bias: { ARMY: 0.5, ATTACK: -0.25 }, army: 1.7, eco: 0.5, minN: 1.3 },
  { key: 'ATTACK', ru: 'Наступление', bias: { ATTACK: 0.6, ARMY: 0.2 }, army: 1.3, minN: 0.6, atk: 0.06 },
  { key: 'RAID', ru: 'Рейды', bias: { RAID: 0.8, ATTACK: 0.1 } },
  { key: 'DEFEND', ru: 'Оборона', bias: { DEFEND: 0.7, ATTACK: -0.3 }, hold: 1, army: 1.3 },
  { key: 'AA', ru: 'ПВО', bias: { ANTIAIR: 0.8 }, aa: 0.6 },
  { key: 'EXP', ru: 'Экспериментал', bias: { EXPERIMENTAL: 0.7, TECH: 0.2 }, expInc: 22, army: 0.8 },
  { key: 'SILO', ru: 'Ядерные шахты', bias: { EXPERIMENTAL: -0.2 }, silo: 1, eco: 0.9 },
  { key: 'AIR', ru: 'Упор на авиацию', bias: { ANTIAIR: 0.2 }, air: 2.5, land: -1 },
  { key: 'LAND', ru: 'Упор на сушу', bias: {}, land: 2.5, air: -0.8 }
];
export const NM = MACROS.length;
export const BASE_MACRO = { army: 1, eco: 1, minN: 1, expInc: 32, silo: 0, cap: 0, atk: 0, hold: 0, aa: 0, air: 0, land: 0, bias: {} };
const FULL = MACROS.map(m => ({ ...BASE_MACRO, ...m }));
export const macroOf = (i) => FULL[i] || FULL[0];

const STRATS = ['land_rush', 'air_dom', 'naval', 'eco_tech', 'turtle', 'balanced'];
const l1 = Math.log1p, cl = (v, a, b) => v < a ? a : v > b ? b : v;
export const N_STATE = 52 + NM;
const SV = new Float32Array(N_STATE);

// Вектор состояния из того, что ИИ и так считает (ai.features, Intel) + запасы, заводы, эксперименталы, шахты. Нормировка — логарифмы и доли.
export function stateVector(ai, out = SV) {
  const g = ai.g, T = ai.T, eco = T.eco, I = ai.intel, f = ai.features || {}, t = g.time;
  let k = 0; const put = (v) => { out[k++] = v; };
  put(t / 1800); put(l1(eco.incM) / 5.5); put(l1(eco.incE) / 9); put(eco.mass / Math.max(1, eco.maxMass)); put(eco.energy / Math.max(1, eco.maxEnergy));
  put(eco.stallM ? 1 : 0); put(eco.stallE ? 1 : 0); put(ai.tier / 3); put((I.enemyTier || 1) / 3); put(cl(eco.effM ?? 1, 0, 1.5));
  const fc = { land: 0, air: 0, naval: 0 }; let ft = 0, nf = 0, engs = 0, mex = 0, mex2 = 0, silos = 0, stock = 0, defs = 0, up = 0;
  for (const s of ai.myStructs) {
    if (s.spec.produces) { if (s.built) { fc[s.spec.produces]++; ft += s.spec.tier; nf++; } }
    else if (s.spec.place === 'mex' && s.built) { mex++; if (s.spec.tier >= 2) mex2++; }
    else if (s.silo && s.built) { silos++; stock += s.silo.stock; }
    else if (s.spec.dps > 0 && s.built) defs++;
    if (s.upgrading) up++;
  }
  put(l1(fc.land) / 3); put(l1(fc.air) / 3); put(l1(fc.naval) / 3); put(nf ? ft / nf / 3 : 0);
  let vL = 0, vA = 0, vN = 0, exps = 0;
  for (const u of ai.myUnits) {
    const s = u.spec;
    if (s.role === 'eng') { engs++; continue; }
    if (s.role === 'cmd') continue;
    const v = (s.costM || 50) * u.hp / u.maxHp;
    if (s.move === 'air') vA += v; else if (s.cat === 'naval' || s.move === 'naval') vN += v; else vL += v;
    if (s.role === 'exp') exps++;
  }
  put(l1(engs) / 3.5); put(T.unitCount / g.unitCap); put(l1(vL) / 11); put(l1(vA) / 11); put(l1(vN) / 11);
  put(l1(f.ourAA || 0) / 8); put(l1(f.enemyPow || 0) / 9); put(l1(f.ourPow || 0) / 9); put(cl(Math.log(f.ratio || 1), -2, 2) / 2); put(l1(f.enemyAir || 0) / 8);
  put(cl((f.freeMex || 0) / 10, 0, 2)); put(cl((f.enemyMex || 0) / 10, 0, 2)); put(mex / 20); put(mex ? mex2 / mex : 0);
  put(l1(ai.baseThreat) / 7); put(Math.min(300, t - ai.lastBaseAttackT) / 300); put(l1(f.lost || 0) / 9); put(l1(f.killed || 0) / 9);
  const a = ai.acuU; put(a ? a.hp / a.maxHp : 0); put(a ? 1 : 0);
  put(exps / 3); put(I.comp.exp > 0 ? 1 : 0); put(silos / 3); put(l1(stock) / 2); put((ai.enemyNukes > 0 || [...I.structs.values()].some(r => r.key === 'sml')) ? 1 : 0);
  put(Math.min(30, ai.floatT || 0) / 30); put(defs / 10); put(up / 4); put(ai.hasEng(3) ? 1 : 0); put(isFinite(ai.landReach) ? 1 : 0); put(ai.navalOk ? 1 : 0);
  put(l1(I.comp.air + I.comp.land + I.comp.naval) / 5);
  for (const s of STRATS) put(ai.strategyKey === s ? 1 : 0);
  put(Math.min(300, t - (ai.macroT || 0)) / 300);
  for (let i = 0; i < NM; i++) put(ai.macroIdx === i ? 1 : 0);
  return out;
}

// ---------------------------------------------------------------- inference
let net = null;
export function setStrategyNet(j) {
  if (!j || j.version !== MODEL_VERSION || j.layers[0].in !== N_STATE || j.layers[j.layers.length - 1].out !== NM + 1) { net = null; return false; }
  net = new MLP(j); return true;
}
export const hasStrategyNet = () => !!net;
export async function loadStrategyNet(url) {
  try {
    const u = url || new URL('../ml/models/strategy_v1.json', import.meta.url);
    let j;
    if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node) j = JSON.parse((await import('node:fs')).readFileSync(u, 'utf8'));
    else { const r = await fetch(u); if (!r.ok) return false; j = await r.json(); }
    return setStrategyNet(j);
  } catch (e) { return false; }
}
const R = { q: new Float32Array(NM), v: 0.5 };
// -> { q[NM], v } или null без модели (общий объект)
export function evalState(s) {
  if (!net) return null;
  const y = net.forward(s);
  for (let i = 0; i < NM; i++) R.q[i] = y[i];
  R.v = 1 / (1 + Math.exp(-y[NM]));
  return R;
}

// Какие действия допустимы сейчас (страховочные правила поверх сети): под атакой на базу — только армия/оборона/ПВО; эксперименталы и шахты — только с инженерами Т3.
export function macroMask(ai, out = new Uint8Array(NM).fill(1)) {
  out.fill(1);
  const g = ai.g, hot = g.time - ai.lastBaseAttackT < 30 && ai.baseThreat > 120;
  if (hot) for (const k of ['ECON', 'TECH', 'EXP', 'SILO', 'RAID', 'AIR']) out[MACROS.findIndex(m => m.key === k)] = 0;
  if (!ai.hasEng(3)) { out[MACROS.findIndex(m => m.key === 'EXP')] = 0; out[MACROS.findIndex(m => m.key === 'SILO')] = 0; }
  if (!isFinite(ai.landReach)) out[MACROS.findIndex(m => m.key === 'RAID')] = 0;
  return out;
}

// Политика v1: argmax Q с малой температурой, переключение только при заметном выигрыше (гистерезис).
export function pickMacro(r, mask, cur, tau = 0.015, margin = 0.01, rnd = Math.random) {
  let best = -1, bq = -1e9;
  for (let i = 0; i < NM; i++) if (mask[i] && r.q[i] > bq) { bq = r.q[i]; best = i; }
  if (best < 0) return 0;
  if (mask[cur] && r.q[cur] > bq - margin) return cur;
  if (tau <= 0) return best;
  let z = 0; const p = [];
  for (let i = 0; i < NM; i++) { const e = mask[i] ? Math.exp((r.q[i] - bq) / tau) : 0; p.push(e); z += e; }
  let u = rnd() * z;
  for (let i = 0; i < NM; i++) { u -= p[i]; if (u <= 0) return i; }
  return best;
}

if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node && !globalThis.__NO_STRATNET) await loadStrategyNet();
