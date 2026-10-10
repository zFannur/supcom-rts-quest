// Range rings (display only): attack / AA / torpedo / missile-defence / shield / build radii of the entity under the cursor,
// of the structure being placed, or (Alt) of the whole selection. Drawn on the 2D overlay: every ring is sampled on the terrain
// surface (heights cached per ring until the centre moves) and projected with Renderer.projTo, so nothing is allocated per point.
import { STRUCTS } from './specs.js';

export const RING_KINDS = {
  atk: { rgb: '255,112,64', name: 'Атака' },
  msl: { rgb: '255,150,72', name: 'Ракеты' },
  aa: { rgb: '92,204,255', name: 'ПВО' },
  tor: { rgb: '38,232,196', name: 'Торпеды' },
  tmd: { rgb: '104,255,128', name: 'ПРО' },
  smd: { rgb: '176,255,104', name: 'Антиядерка' },
  shd: { rgb: '124,255,190', name: 'Щит' },
  bld: { rgb: '255,222,96', name: 'Стройка' }
};

const cache = new WeakMap();
// Unique (kind, range, minRange) rings of a spec, biggest first. Silo nukes have no ring (unlimited range).
export function rangeRings(spec) {
  let out = cache.get(spec);
  if (out) return out;
  out = [];
  const seen = new Set();
  const add = (kind, r, min = 0) => {
    if (!(r > 0) || r > 1000) return;
    const k = kind + ':' + r + ':' + min;
    if (seen.has(k)) return;
    seen.add(k); out.push({ kind, r, min });
  };
  for (const w of spec.weapons || []) {
    const t = w.targets;
    if (t.includes('missile')) { add('tmd', w.range); continue; }
    if (t.includes('land')) add(w.silo ? 'msl' : 'atk', w.range, w.minRange || 0);
    if (t.includes('air')) add('aa', w.range);
    if (!t.includes('land') && !t.includes('air') && (t.includes('naval') || t.includes('sub'))) add('tor', w.range);
  }
  if (spec.silo && spec.silo.kind === 'anti') add('smd', spec.silo.cover);
  if (spec.shield) add('shd', spec.shield.radius);
  if (spec.pshield) add('shd', spec.pshield.r);
  if (spec.isUnit && spec.canBuild && spec.buildRange) add('bld', spec.buildRange);
  out.sort((a, b) => b.r - a.r);
  cache.set(spec, out);
  return out;
}

const MAX_ALT = 16;

export class RangeView {
  constructor() { this.slots = []; this.sig = ''; this.t0 = 0; this.items = []; this.boxes = []; }

  // Things to draw this frame: the placement ghost, the hovered entity, or the selection while Alt is held.
  collect(r, game, ui) {
    const items = this.items; items.length = 0;
    if (!ui) return items;
    const lt = r.localTeam;
    if (ui.mode === 'build' && ui.buildKey && r.ghost && r.ghost.key === ui.buildKey) {
      items.push({ id: 'g', spec: STRUCTS[ui.buildKey], x: r.ghost.x, y: r.ghost.y, own: true });
      return items;
    }
    const ok = (e) => e && e.alive && !e.carried && e.kind !== 'wreck' && !(e.kind === 'struct' && !e.built);
    const push = (e) => {
      if (items.some(i => i.id === e.id)) return;
      const p = r.entityPos(e, r.tmpP);
      items.push({ id: e.id, spec: e.spec, x: p.x, y: p.z, own: !lt || game.allied(lt, e.team) });
    };
    if (ui.hover && ok(ui.hover)) push(ui.hover);
    if (ui.keys && (ui.keys.AltLeft || ui.keys.AltRight)) {
      let n = 0;
      for (const e of ui.selection) { if (n >= MAX_ALT) break; if (ok(e) && (!lt || e.team === lt)) { push(e); n++; } }
    }
    return items;
  }

  draw(r, c, game, ui) {
    const items = this.collect(r, game, ui);
    if (!items.length) { this.sig = ''; return; }
    const now = performance.now();
    let sig = ''; for (const it of items) sig += it.id + ',';
    if (sig !== this.sig) { this.sig = sig; this.t0 = now; }
    const fade = Math.min(1, (now - this.t0) / 160), ease = fade * (2 - fade);
    const W = r.overlay.width, H = r.overlay.height, t = game.terrain;
    const labels = items.length <= 2, boxes = this.boxes; boxes.length = 0;
    // labels stay inside the playfield: above the bottom panel, below the top bar
    const bar = this.bar || (this.bar = document.getElementById('bottom'));
    const sc = H / (window.innerHeight || H);
    this.yMax = Math.min(H - 20, (bar ? bar.getBoundingClientRect().top * sc : H) - 16); this.yMin = 74 * sc;
    const pulse = 0.9 + 0.1 * Math.sin(now / 420);
    let slot = 0;
    c.save();
    c.lineJoin = 'round';
    const at = (i) => this.slots[i] || (this.slots[i] = {});
    for (const it of items) {
      it.sl = [];
      for (const ring of rangeRings(it.spec)) {
        it.sl.push(slot);
        this.ring(r, c, t, it, ring.kind, ring.r, false, at(slot++), ease * pulse, now, W, H);
        if (ring.min > 0) this.ring(r, c, t, it, ring.kind, ring.min, true, at(slot++), ease * pulse, now, W, H);
      }
    }
    if (labels) for (const it of items) rangeRings(it.spec).forEach((ring, k) => this.label(c, it, ring, this.slots[it.sl[k]], ease, W, H));
    c.restore();
  }

  // One ring on the ground; dead = the inner dead-zone ring of artillery (dim, short dashes, no fill).
  ring(r, c, t, it, kind, R, dead, s, a, now, W, H) {
    const K = RING_KINDS[kind];
    const n = R < 24 ? 48 : R < 70 ? 96 : 128;
    if (s.n !== n || s.r !== R || Math.abs(s.cx - it.x) > 0.25 || Math.abs(s.cy - it.y) > 0.25) {
      s.n = n; s.r = R; s.cx = it.x; s.cy = it.y;
      const h = s.h && s.h.length === n ? s.h : (s.h = new Float32Array(n));
      for (let i = 0; i < n; i++) { const ang = i / n * 6.2832; h[i] = t.surfaceAt(it.x + Math.cos(ang) * R, it.y + Math.sin(ang) * R) + 0.7; }
    }
    const path = new Path2D(), h = s.h;
    let pen = false, all = true, bx = 0, by = -1;
    for (let i = 0; i <= n; i++) {
      const j = i % n, ang = j / n * 6.2832;
      if (!r.projTo(it.x + Math.cos(ang) * R, h[j], it.y + Math.sin(ang) * R)) { pen = false; all = false; continue; }
      if (pen) path.lineTo(r.sx, r.sy); else { path.moveTo(r.sx, r.sy); pen = true; }
      if (i < n && r.sy > by && r.sy < this.yMax && r.sy > this.yMin && r.sx > 40 && r.sx < W - 40) { by = r.sy; bx = r.sx; }
    }
    s.lx = bx; s.ly = by;
    if (all && !dead) { c.fillStyle = `rgba(${K.rgb},${(it.own ? 0.09 : 0.06) * a})`; c.fill(path); }
    const enemy = !it.own;
    c.setLineDash(dead ? [3, 6] : enemy ? [12, 7] : []);
    c.lineDashOffset = enemy ? -now / 55 : 0;
    c.strokeStyle = `rgba(0,0,0,${0.5 * a})`; c.lineWidth = dead ? 3 : 5; c.stroke(path);
    c.strokeStyle = `rgba(${K.rgb},${(dead ? 0.6 : it.own ? 1 : 0.9) * a})`; c.lineWidth = dead ? 1.6 : 2.6; c.stroke(path);
    c.setLineDash([]);
  }

  // Text pill at the ring's lowest on-screen point ("Атака 40–300", "ПВО 62 · враг"); pills are pushed apart so they never overlap.
  label(c, it, ring, s, ease, W, H) {
    if (!s || s.ly < 0) return;
    const K = RING_KINDS[ring.kind];
    const txt = `${K.name} ${ring.min > 0 ? ring.min + '–' : ''}${ring.r}${it.own ? '' : ' · враг'}`;
    c.font = '700 12px Rajdhani, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    const w = c.measureText(txt).width + 12, hgt = 16;
    let x = Math.max(w / 2 + 2, Math.min(W - w / 2 - 2, s.lx)), y = s.ly + 2;
    const y0 = y, hit = (yy) => { for (const b of this.boxes) if (Math.abs(b.x - x) < (b.w + w) / 2 && Math.abs(b.y - yy) < hgt) return b; return null; };
    for (let tries = 0, b; tries < 8 && (b = hit(y)); tries++) y = b.y + hgt + 1;   // push down ...
    if (y > this.yMax + 6) { y = y0; for (let tries = 0, b; tries < 8 && (b = hit(y)); tries++) y = b.y - hgt - 1; }   // ... or up when there is no room
    this.boxes.push({ x, y, w });
    c.globalAlpha = ease;
    c.fillStyle = 'rgba(6,12,18,0.82)'; c.fillRect(x - w / 2, y - hgt / 2, w, hgt);
    c.strokeStyle = `rgba(${K.rgb},0.85)`; c.lineWidth = 1; c.setLineDash(it.own ? [] : [3, 2]); c.strokeRect(x - w / 2 + 0.5, y - hgt / 2 + 0.5, w - 1, hgt - 1); c.setLineDash([]);
    c.fillStyle = `rgb(${K.rgb})`; c.fillText(txt, x, y + 0.5);
    c.globalAlpha = 1;
  }
}
