// Target layers as bit masks + cached per-spec combat lookups (hot paths in sim.js / unitai.js).
// Specs are shared static objects, except the ACU whose spec is rebuilt on every enhancement: caches are
// keyed by the weapons array they were computed from, so a rebuilt spec never sees stale numbers.
export const LB = { land: 1, air: 2, naval: 4, sub: 8 };
export const LAYER_IDX = { 1: 0, 2: 1, 4: 2, 8: 3 };

export function wMask(w) { return w._m !== undefined ? w._m : (w._m = w.targets.reduce((a, t) => a | LB[t], 0)); }

function fill(spec) {
  const ws = spec.weapons || [];
  let hm = 0, sm = 0; const rv = [0, 0, 0, 0];
  for (const w of ws) {
    const m = wMask(w); hm |= m; if (w.splash >= 3) sm |= m;
    for (let i = 0; i < 4; i++) if ((m >> i) & 1 && w.range > rv[i]) rv[i] = w.range;
  }
  spec._hw = spec.weapons; spec._hm = hm; spec._sm = sm; spec._rv = rv;
}
// Union of layers the spec's weapons can hit.
export function hitMask(spec) { if (spec._hw !== spec.weapons) fill(spec); return spec._hm; }
// Layers hit by splash weapons (splash >= 3, the "don't clump" trigger of the unit brain).
export function splashMask(spec) { if (spec._hw !== spec.weapons) fill(spec); return spec._sm; }
// Longest weapon range against a layer bit (0 if it cannot hit it).
export function rangeVsBit(spec, bit) { if (spec._hw !== spec.weapons) fill(spec); return spec._rv[LAYER_IDX[bit]]; }
// Layer bit of a spec (static part; amphibians on deep water are handled by Game.layerBitOf).
export function specBit(spec) { return LB[spec.layer]; }
