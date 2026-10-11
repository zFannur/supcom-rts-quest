// ИИ-командир (ml/PLAN.md, «Песочница»): нейросеть, обученная самоигрой в песочнице ml/sandbox, — вывод в игре на чистом JS.
// Повторяет ml/sandbox/policy.py: кодировщик строки каталога (ent) → среднее и максимум по каталогу → общий слой (glob) →
// 4 указателя по каталогу (ptr: суша / авиация / флот / постройка) и плоские головы (flat: бюджет, цели трёх родов войск, особое, ценность).
// Вход: общий вектор состояния g (NG) и динамические столбцы каталога dyn [NE][3] (доступно, моих, видели) — их собирает js/ai.js.
// Нет файла весов -> модели нет, ИИ играет по правилам.
import { MLP } from './nn.js';

export const MODEL_VERSION = 'commander_v1';
let M = null;

export function setCommanderNet(j) {
  if (!j || j.version !== MODEL_VERSION) { M = null; return false; }
  const mk = (layers, leakyLast) => { const m = new MLP({ layers, act: 'leaky' }); m.leakyLast = leakyLast; return m; };
  M = { j, NE: j.ent_static.length, NF: j.NF, NG: j.NG, Z: j.Z, heads: j.heads,
    ent: mk(j.net.ent, true), glob: mk(j.net.glob, true), hq: mk(j.net.hq, false), ptr: mk(j.net.ptr, false), flat: mk(j.net.flat, false),
    keys: [...j.units, ...j.structs.map(k => 's:' + k)] };
  M.ix = Object.fromEntries(M.keys.map((k, i) => [k, i]));
  return true;
}
export const hasCommanderNet = () => !!M;
export const commanderMeta = () => M && { units: M.j.units, structs: M.j.structs, budgets: M.j.budgets, special: M.j.special, heads: M.heads, Z: M.Z, NG: M.NG, ix: M.ix };

export async function loadCommanderNet(url) {
  try {
    const u = url || new URL('../ml/models/commander_v1.json', import.meta.url);
    let j;
    if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node) j = JSON.parse((await import('node:fs')).readFileSync(u, 'utf8'));
    else { const r = await fetch(u); if (!r.ok) return false; j = await r.json(); }
    return setCommanderNet(j);
  } catch (e) { return false; }
}

// MLP из nn.js оставляет последний слой линейным; у кодировщиков (ent, glob) активация и после последнего слоя — добавляем её здесь
const leaky = (a) => { for (let i = 0; i < a.length; i++) if (a[i] < 0) a[i] *= 0.01; return a; };
const run = (m, x) => { const y = Float32Array.from(m.forward(x)); return m.leakyLast ? leaky(y) : y; };

// -> { logits: [бюджет, суша, авиа, флот, постройка, цель суши, цель авиации, цель флота, особое], value }
export function commanderForward(g, dyn) {
  if (!M) return null;
  const { NE, NF, Z, heads } = M, st = M.j.ent_static;
  const ee = [], x = new Float32Array(NF), pooled = new Float32Array(128).fill(0);
  for (let k = 64; k < 128; k++) pooled[k] = -Infinity;
  for (let i = 0; i < NE; i++) {
    const s = st[i];
    for (let f = 0; f < NF - 3; f++) x[f] = s[f];
    x[NF - 3] = dyn[i][0]; x[NF - 2] = dyn[i][1]; x[NF - 1] = dyn[i][2];
    const y = run(M.ent, x); ee.push(y);
    for (let k = 0; k < 64; k++) { pooled[k] += y[k] / NE; if (y[k] > pooled[64 + k]) pooled[64 + k] = y[k]; }
  }
  const gin = new Float32Array(g.length + 128); gin.set(g, 0); gin.set(pooled, g.length);
  const h = run(M.glob, gin), q = run(M.hq, h), f = run(M.flat, h);
  const ptr = [[], [], [], []], pin = new Float32Array(128);
  for (let i = 0; i < NE; i++) {
    pin.set(ee[i], 0); pin.set(q, 64);
    const sc = run(M.ptr, pin);
    for (let k = 0; k < 4; k++) ptr[k].push(sc[k]);
  }
  const nb = heads[0], ns = heads[8], fl = Array.from(f);
  const logits = [fl.slice(0, nb), ...ptr, fl.slice(nb, nb + Z), fl.slice(nb + Z, nb + 2 * Z), fl.slice(nb + 2 * Z, nb + 3 * Z), fl.slice(nb + 3 * Z, nb + 3 * Z + ns)];
  return { logits, value: fl[fl.length - 1] };
}

// выбор по маске: argmax (temp 0) или сэмпл с температурой; mask — массив 0/1 той же длины
export function pick(logits, mask, temp = 0, rnd = Math.random) {
  let best = -1, bv = -Infinity;
  for (let i = 0; i < logits.length; i++) if (mask[i] && logits[i] > bv) { bv = logits[i]; best = i; }
  if (best < 0 || temp <= 0) return Math.max(0, best);
  let z = 0; const p = logits.map((l, i) => { const e = mask[i] ? Math.exp((l - bv) / temp) : 0; z += e; return e; });
  let u = rnd() * z;
  for (let i = 0; i < p.length; i++) { u -= p[i]; if (u <= 0) return i; }
  return best;
}

if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node && !globalThis.__NO_CMDNET) await loadCommanderNet();

// Сэмпл по маске с температурой 1 и log-вероятностью выбора (дообучение в настоящих партиях: ml/sandbox/finetune_real.mjs).
// Полностью закрытая голова — как в policy.py: все варианты равны (логит -1e4), выбор 0 с log(1/n).
export function sampleLogp(logits, mask, rnd = Math.random) {
  const n = logits.length; let mx = -Infinity, any = false;
  for (let i = 0; i < n; i++) if (mask[i]) { any = true; if (logits[i] > mx) mx = logits[i]; }
  if (!any) return [0, -Math.log(n)];
  let z = 0; const p = new Float64Array(n);
  for (let i = 0; i < n; i++) if (mask[i]) { p[i] = Math.exp(logits[i] - mx); z += p[i]; }
  let u = rnd() * z, k = -1;
  for (let i = 0; i < n; i++) if (mask[i]) { k = i; u -= p[i]; if (u <= 0) break; }
  return [k, Math.log(p[k] / z)];
}
