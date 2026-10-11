// Tiny dependency-free MLP forward pass for models exported by ml/train_*.py (JSON: layers[{in,out,W,b}], act).
// Weights live in Float32Arrays; forward() allocates nothing (ping-pong buffers, the result is a view valid until the next call).
// Input standardisation (norm.mean/std) is folded into the first layer at load time.
export class MLP {
  constructor(j) {
    this.meta = j;
    const L = j.layers;
    this.nIn = L[0].in; this.nOut = L[L.length - 1].out;
    this.layers = L.map((l) => ({ n: l.in, m: l.out, W: Float32Array.from(l.W), b: Float32Array.from(l.b) }));
    if (j.norm) {
      const { mean, std } = j.norm, l0 = this.layers[0];
      for (let o = 0; o < l0.m; o++) {
        let s = 0;
        for (let i = 0; i < l0.n; i++) { const w = l0.W[o * l0.n + i] / std[i]; l0.W[o * l0.n + i] = w; s += w * mean[i]; }
        l0.b[o] -= s;
      }
    }
    this.leak = j.act === 'leaky' ? 0.01 : 0;
    const w = Math.max(...this.layers.map((l) => l.m));
    this.a = new Float32Array(w); this.b = new Float32Array(w);
    this.out = new Float32Array(this.nOut);
  }
  forward(x) {
    const Ls = this.layers, last = Ls.length - 1, leak = this.leak;
    let src = x, dst = this.a;
    for (let k = 0; k <= last; k++) {
      const { n, m, W, b } = Ls[k];
      if (k === last) dst = this.out;
      for (let o = 0, r = 0; o < m; o++, r += n) {
        let s = b[o];
        for (let i = 0; i < n; i++) s += W[r + i] * src[i];
        dst[o] = k === last || s > 0 ? s : s * leak;
      }
      src = dst; dst = dst === this.a ? this.b : this.a;
    }
    return this.out;
  }
}
