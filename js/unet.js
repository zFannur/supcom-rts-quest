// Универсальная модель-командир (ml/universal): вывод трансформера над объектами в браузере / node.
// Вход — объекты по типам с признаками по именам (схема из файла модели), выход — логиты по вопросам и ценность.
// Совпадение с PyTorch проверяет ml/universal/check_unet.mjs.
const ORDER = ['goal', 'me', 'foe', 'hist', 'zone', 'ent', 'budget', 'special', 'question'];
const Q_OPT = { budget: 'budget', build_land: 'ent', build_air: 'ent', build_naval: 'ent', build_struct: 'ent', target_land: 'zone', target_air: 'zone', target_naval: 'zone', special: 'special' };
let NET = null;

export function setUniversalNet(j) {
  if (!j || j.kind !== 'universal') return false;
  const S = j.state, W = (k) => S[k];
  const lin = (p) => ({ w: W(p + '.weight'), b: W(p + '.bias') });
  NET = {
    j, d: j.arch.d, H: j.arch.H,
    inp: Object.fromEntries(Object.keys(j.schema).map(t => [t, lin(`inp.${t}`)])),
    mix: Object.fromEntries(Object.keys(j.schema).map(t => [t, lin(`mix.${t}.1`)])),
    temb: Object.fromEntries(Object.keys(j.schema).map(t => [t, W(`temb.${t}`)])),
    hpos: W('hpos'), edge: W('edge.weight'),
    blocks: Array.from({ length: j.arch.L }, (_, i) => ({ n1: { w: W(`blocks.${i}.n1.weight`), b: W(`blocks.${i}.n1.bias`) }, qkv: lin(`blocks.${i}.qkv`), o: lin(`blocks.${i}.o`),
      n2: { w: W(`blocks.${i}.n2.weight`), b: W(`blocks.${i}.n2.bias`) }, f1: lin(`blocks.${i}.ff.0`), f2: lin(`blocks.${i}.ff.2`) })),
    nf: { w: W('nf.weight'), b: W('nf.bias') }, wq: lin('wq'), wk: lin('wk'), val: lin('val'),
  };
  return true;
}
export async function loadUniversalNet(url = './ml/models/universal_v1.json') {
  try { const r = await fetch(url); return r.ok ? setUniversalNet(await r.json()) : false; } catch { return false; }
}
export const hasUniversalNet = () => !!NET;
export const universalMeta = () => NET && NET.j;

const linear = (x, L) => { const o = new Float64Array(L.b.length); for (let i = 0; i < o.length; i++) { const w = L.w[i]; let s = L.b[i]; for (let k = 0; k < x.length; k++) s += w[k] * x[k]; o[i] = s; } return o; };
function erf(x) {   // Абрамовиц — Стиган 7.1.26 (погрешность 1.5e-7)
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
const gelu = (x) => x.map(v => 0.5 * v * (1 + erf(v / Math.SQRT2)));
const norm = (x, P) => { let m = 0, v = 0; for (const a of x) m += a; m /= x.length; for (const a of x) v += (a - m) ** 2; v /= x.length; const r = 1 / Math.sqrt(v + 1e-5); return x.map((a, i) => (a - m) * r * P.w[i] + P.b[i]); };
const add = (a, b) => a.map((v, i) => v + b[i]);

/** inp: { goal:[[...]], me:[[...]], foe:[[...]], hist:[[...]×4], zone:[[...]×Z], ent:[[...]×NE], et:[Z][Z] (0..3), zv?:[Z], ev?:[NE] }
 *  -> { logits: [массив на вопрос], value } */
export function universalForward(inp) {
  if (!NET) return null;
  const N = NET, j = N.j, d = N.d, H = N.H, dh = d / H;
  const stat = { budget: j.shares, special: j.special.map((_, i) => j.special.map((_, k) => +(i === k))), question: j.questions.map((_, i) => j.questions.map((_, k) => +(i === k))) };
  let h = [], span = {};
  for (const t of ORDER) {
    const rows = inp[t] || stat[t]; span[t] = [h.length, h.length + rows.length];
    rows.forEach((x, r) => { let v = add(linear(gelu(linear(x, N.inp[t])), N.mix[t]), N.temb[t]); if (t === 'hist') v = add(v, N.hpos[r]); h.push(v); });
  }
  const T = h.length, [z0, z1] = span.zone, [e0, e1] = span.ent;
  const keym = new Float64Array(T);
  if (inp.zv) inp.zv.forEach((ok, i) => { if (!ok) keym[z0 + i] = -1e4; });
  if (inp.ev) inp.ev.forEach((ok, i) => { if (!ok) keym[e0 + i] = -1e4; });
  for (const B of N.blocks) {
    const qkv = h.map(x => linear(norm(x, B.n1), B.qkv));
    const out = h.map(() => new Float64Array(d));
    for (let hd = 0; hd < H; hd++) {
      const qo = hd * dh, ko = d + hd * dh, vo = 2 * d + hd * dh, sc = 1 / Math.sqrt(dh);
      for (let i = 0; i < T; i++) {
        const s = new Float64Array(T); let mx = -Infinity;
        for (let k = 0; k < T; k++) {
          let a = 0; for (let c = 0; c < dh; c++) a += qkv[i][qo + c] * qkv[k][ko + c];
          a = a * sc + keym[k];
          if (i >= z0 && i < z1 && k >= z0 && k < z1) a += N.edge[inp.et[i - z0][k - z0]][hd];
          s[k] = a; if (a > mx) mx = a;
        }
        let sum = 0; for (let k = 0; k < T; k++) { s[k] = Math.exp(s[k] - mx); sum += s[k]; }
        for (let k = 0; k < T; k++) { const p = s[k] / sum; if (p) for (let c = 0; c < dh; c++) out[i][qo + c] += p * qkv[k][vo + c]; }
      }
    }
    h = h.map((x, i) => add(x, linear(out[i], B.o)));
    h = h.map(x => add(x, linear(gelu(linear(norm(x, B.n2), B.f1)), B.f2)));
  }
  h = h.map(x => norm(x, N.nf));
  const [q0] = span.question, K = [];
  const logits = j.questions.map((qn, i) => {
    const q = linear(h[q0 + i], N.wq), [a, b] = span[Q_OPT[qn]], out = [];
    for (let k = a; k < b; k++) { const kk = K[k] || (K[k] = linear(h[k], N.wk)); let s = 0; for (let c = 0; c < d; c++) s += q[c] * kk[c]; out.push(s / Math.sqrt(d)); }
    return out;
  });
  return { logits, value: linear(h[span.me[0]], N.val)[0] };
}
