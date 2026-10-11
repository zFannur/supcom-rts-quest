// Heightfield, passability grids and cached flow-field pathfinding.
import { MAP_SIZE, mulberry32 } from './maps.js';

export const HCELL = 4;                // height cell, world units
export const HN = MAP_SIZE / HCELL;    // height cells per side (vertex grid = HN+1)
const EFF_DOM = { land: 0, naval: 1, amph: 2, hover: 3, air: 4 };
export const PCELL = 8;                // pathing cell, world units (buildings are 6-28 units: keep it independent of the map size)
export const PN = MAP_SIZE / PCELL;    // pathing cells per side
const FB = 32, FBN = MAP_SIZE / FB;    // feature buckets (32 units) per side
const DOMAINS = ['land', 'naval', 'amph', 'hover'];

// Clearance classes by unit radius: 0 tiny (<=2), 1 small (<=4), 2 large (<=7), 3 experimental. See Terrain.effGrid.
export const clearanceClass = (radius) => radius <= 2 ? 0 : radius <= 4 ? 1 : radius <= 7 ? 2 : 3;

const BUCKETS = 64;      // circular bucket count for the flow-field search (> the largest single step cost)
// 8 neighbours as index offsets (cells on the map border are never walkable, so a walkable cell has all eight in range)
const NOFF = Int32Array.from([-PN - 1, -PN, -PN + 1, -1, 1, PN - 1, PN, PN + 1]);
const NDIAG = [1, 0, 1, 0, 0, 1, 0, 1];
const NDX = Int32Array.from([-1, 0, 1, -1, 1, -1, 0, 1]), NDY = Int32Array.from([-PN, -PN, -PN, 0, 0, PN, PN, PN]);   // the two orthogonal neighbours of a diagonal step: cur + NDX[k], cur + NDY[k]
const SCR = { di: new Int32Array(PN * PN), head: new Int32Array(BUCKETS), nxt: new Int32Array(PN * PN * 9), val: new Int32Array(PN * PN * 9), stack: new Int32Array(PN * PN) };

export class Terrain {
  constructor(map) {
    this.map = map;
    this.size = MAP_SIZE;
    this.water = map.water;
    const V = HN + 1;
    this.h = new Float32Array(V * V);
    let mn = 1e9, mx = -1e9;
    // Flatten small pads under mass deposits so extractors always fit.
    const pads = map.mass;
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const x = i * HCELL, y = j * HCELL;
      let h = map.height(x, y);
      for (const p of pads) {
        if (Math.abs(x - p.x) > 18 || Math.abs(y - p.y) > 18) continue;
        const d = Math.hypot(x - p.x, y - p.y);
        if (d < 18) { const t = Math.max(0, Math.min(1, (18 - d) / 10)); h = h + (map.height(p.x, p.y) - h) * t; }
      }
      this.h[j * V + i] = h; if (h < mn) mn = h; if (h > mx) mx = h;
    }
    this.minH = mn; this.maxH = mx;
    this.mass = pads.filter(p => this.heightAt(p.x, p.y) > this.water + 1.5).map((p, i) => ({ x: p.x, y: p.y, id: i }));
    this.buildPassability();
    this.blocked = new Uint8Array(PN * PN);
    this.version = 0; this.chg = []; this.chgBase = 0;
    this.flowCache = new Map(); this._distPool = [];
    this.effCache = {}; this._effFast = [];
    this.wanted = new Map();                   // queued field requests (time budget exhausted)
    this._steer = { x: 0, y: 0, st: 'direct', d: 0, gx: 0, gy: 0, partial: false };
    this.budgetMs = 3; this.spentMs = 0; this.fieldsBuilt = 0; this.tick = 0;
    this.genFeatures();
  }

  hv(i, j) { const V = HN + 1; i = i < 0 ? 0 : i > HN ? HN : i; j = j < 0 ? 0 : j > HN ? HN : j; return this.h[j * V + i]; }

  heightAt(x, y) {
    const fx = Math.max(0, Math.min(HN - 0.001, x / HCELL)), fy = Math.max(0, Math.min(HN - 0.001, y / HCELL));
    const i = fx | 0, j = fy | 0, tx = fx - i, ty = fy - j;
    const a = this.hv(i, j), b = this.hv(i + 1, j), c = this.hv(i, j + 1), d = this.hv(i + 1, j + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }
  surfaceAt(x, y) { return Math.max(this.heightAt(x, y), this.water); }
  isWater(x, y) { return this.heightAt(x, y) < this.water; }
  depthAt(x, y) { return this.water - this.heightAt(x, y); }
  slopeAt(x, y) {
    const e = HCELL;
    const dx = (this.heightAt(x + e, y) - this.heightAt(x - e, y)) / (2 * e);
    const dy = (this.heightAt(x, y + e) - this.heightAt(x, y - e)) / (2 * e);
    return Math.sqrt(dx * dx + dy * dy);
  }
  gradAt(x, y) {
    const e = HCELL;
    return [(this.heightAt(x + e, y) - this.heightAt(x - e, y)) / (2 * e), (this.heightAt(x, y + e) - this.heightAt(x, y - e)) / (2 * e)];
  }

  buildPassability() {
    this.pass = {};
    for (const d of DOMAINS) this.pass[d] = new Uint8Array(PN * PN);
    this.cellSlope = new Float32Array(PN * PN);
    const sub = PCELL / HCELL; // height cells per path cell
    for (let cy = 0; cy < PN; cy++) for (let cx = 0; cx < PN; cx++) {
      let hmin = 1e9, hmax = -1e9, slope = 0;
      for (let j = 0; j <= sub; j++) for (let i = 0; i <= sub; i++) {
        const h = this.hv(cx * sub + i, cy * sub + j);
        hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
        if (i > 0) slope = Math.max(slope, Math.abs(h - this.hv(cx * sub + i - 1, cy * sub + j)) / HCELL);
        if (j > 0) slope = Math.max(slope, Math.abs(h - this.hv(cx * sub + i, cy * sub + j - 1)) / HCELL);
      }
      const idx = cy * PN + cx;
      const edge = cx < 1 || cy < 1 || cx >= PN - 1 || cy >= PN - 1;
      const slopeOk = slope < 0.62;
      const dry = hmin > this.water + 0.2;
      const deep = this.water - hmax > 1.6;
      this.cellSlope[idx] = slope;
      this.pass.land[idx] = !edge && slopeOk && dry ? 1 : 0;
      this.pass.naval[idx] = !edge && deep ? 1 : 0;
      this.pass.amph[idx] = !edge && (slopeOk || this.water - hmax > 1) ? 1 : 0;
      this.pass.hover[idx] = !edge && (slopeOk || hmax < this.water) ? 1 : 0;
    }
  }

  genFeatures() {
    const m = this.map, rnd = mulberry32(m.seed * 7 + 3);
    this.features = [];
    const near = (x, y, r) => m.starts.some(s => Math.hypot(s.x - x, s.y - y) < r) || this.mass.some(p => Math.hypot(p.x - x, p.y - y) < 14);
    let tries = 0;
    const want = m.trees.count;
    while (this.features.length < want && tries++ < want * 8) {
      // Cluster trees into groves.
      const cx = 20 + rnd() * (MAP_SIZE - 40), cy = 20 + rnd() * (MAP_SIZE - 40);
      const n = 3 + (rnd() * 9 | 0);
      for (let k = 0; k < n; k++) {
        const x = cx + (rnd() - 0.5) * 50, y = cy + (rnd() - 0.5) * 50;
        if (x < 10 || y < 10 || x > MAP_SIZE - 10 || y > MAP_SIZE - 10) continue;
        const h = this.heightAt(x, y);
        if (h < this.water + 1.2 || this.slopeAt(x, y) > 0.5 || near(x, y, 95)) continue;
        if (m.palette.peakH < 999 && h > m.palette.peakH - 6) continue;
        this.features.push({ x, y, type: 'tree', kind: m.trees.kind, s: 0.8 + rnd() * 0.7, r: rnd() * 6.28, mass: 0, energy: 30, alive: true, id: this.features.length });
      }
    }
    for (let k = 0; k < m.rocks; k++) {
      const x = 10 + rnd() * (MAP_SIZE - 20), y = 10 + rnd() * (MAP_SIZE - 20);
      const h = this.heightAt(x, y);
      if (h < this.water - 3 || near(x, y, 80)) continue;
      const s = 0.8 + rnd() * 1.8;
      this.features.push({ x, y, type: 'rock', s, r: rnd() * 6.28, mass: Math.round(8 + s * 14), energy: 0, alive: true, id: this.features.length });
    }
    // Spatial buckets (FB units) for reclaim searches.
    this.fb = new Map();
    for (const f of this.features) {
      const k = ((f.x / FB) | 0) + ((f.y / FB) | 0) * FBN;
      if (!this.fb.has(k)) this.fb.set(k, []);
      this.fb.get(k).push(f);
    }
  }

  featuresNear(x, y, r, out = []) {
    out.length = 0;
    const x0 = Math.max(0, ((x - r) / FB) | 0), x1 = Math.min(FBN - 1, ((x + r) / FB) | 0);
    const y0 = Math.max(0, ((y - r) / FB) | 0), y1 = Math.min(FBN - 1, ((y + r) / FB) | 0);
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const b = this.fb.get(i + j * FBN); if (!b) continue;
      for (const f of b) if (f.alive && (f.x - x) ** 2 + (f.y - y) ** 2 < r * r) out.push(f);
    }
    return out;
  }

  cell(x, y) { return [Math.max(0, Math.min(PN - 1, (x / PCELL) | 0)), Math.max(0, Math.min(PN - 1, (y / PCELL) | 0))]; }
  cellIdx(x, y) {   // hot: no [cx, cy] array
    let cx = (x / PCELL) | 0, cy = (y / PCELL) | 0;
    cx = cx < 0 ? 0 : cx > PN - 1 ? PN - 1 : cx; cy = cy < 0 ? 0 : cy > PN - 1 ? PN - 1 : cy;
    return cy * PN + cx;
  }

  passIdx(domain, idx) {
    if (domain === 'air') return true;
    return this.pass[domain][idx] === 1 && this.blocked[idx] === 0;
  }
  passableAt(domain, x, y) {
    if (domain === 'air') return x > 2 && y > 2 && x < MAP_SIZE - 2 && y < MAP_SIZE - 2;
    if (x < PCELL || y < PCELL || x > MAP_SIZE - PCELL || y > MAP_SIZE - PCELL) return false;
    return this.passIdx(domain, this.cellIdx(x, y));
  }
  // Static terrain only (ignores structures) — used for placement checks.
  terrainPass(domain, x, y) { return this.pass[domain][this.cellIdx(x, y)] === 1; }

  setBlocked(x, y, size, delta) {
    // cells whose centre lies inside the footprint (never wider than the building; exact contact is separate()'s job);
    // a footprint with no cell centre in it still blocks the cell under its own centre
    const h = size / 2, lo = (c) => Math.max(0, Math.ceil((c - h) / PCELL - 0.5)), hi = (c) => Math.min(PN - 1, Math.floor((c + h) / PCELL - 0.5));
    let x0 = lo(x), x1 = hi(x), y0 = lo(y), y1 = hi(y);
    if (x1 < x0) x0 = x1 = Math.min(PN - 1, (x / PCELL) | 0);
    if (y1 < y0) y0 = y1 = Math.min(PN - 1, (y / PCELL) | 0);
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const k = j * PN + i; this.blocked[k] = Math.max(0, this.blocked[k] + delta);
    }
    this.version++;
    // log of changed rectangles: effective grids older than the log's start are rebuilt whole, newer ones only around the changes
    this.chg.push([this.version, x0, y0, x1, y1]);
    if (this.chg.length > 24) this.chgBase = this.chg.shift()[0];
  }

  // ---------------------------------------------------------------- clearance classes
  // A cell is walkable for class c when the cell itself is passable and (for the big classes) none of its
  // neighbours is blocked: class 2 keeps clear of orthogonal neighbours, class 3 of all eight. Every class >= 1
  // also gets a soft cost near obstacles so paths prefer open ground. Grids are rebuilt lazily per version.
  effGrid(domain, cls = 0) {
    // fast path: array slot per (domain, class) instead of a string-keyed lookup with a fresh concatenated key
    const fi = (EFF_DOM[domain] ?? 5) * 4 + cls;
    const f = this._effFast[fi];
    if (f !== undefined && f.ver === this.version) return f;
    const e = this.effGridBuild(domain, cls);
    if (cls >= 0 && cls < 4 && EFF_DOM[domain] !== undefined) this._effFast[fi] = e;
    return e;
  }
  effGridBuild(domain, cls = 0) {
    const key = domain + cls;
    let e = this.effCache[key];
    if (e && e.ver === this.version) return e;
    const N = PN * PN;
    if (!e) e = this.effCache[key] = { raw: new Uint8Array(N), ok: new Uint8Array(N), pen: new Float32Array(N), qc: new Int16Array(N), lab: null, labBuf: null, sizes: null, ver: -1, part: new Map(), domain, cls };
    const pass = this.pass[domain], blk = this.blocked, raw = e.raw;
    if (e.ver >= 0 && e.ver >= this.chgBase) {
      // only the cells around the structures placed / destroyed since this grid was built (a change reaches 3 cells: erosion 2 + border cost 1)
      for (const c of this.chg) {
        if (c[0] <= e.ver) continue;
        for (let cy = c[2]; cy <= c[4]; cy++) for (let cx = c[1]; cx <= c[3]; cx++) { const i = cy * PN + cx; raw[i] = pass[i] && !blk[i] ? 1 : 0; }
        this.effRegion(e, Math.max(0, c[1] - 3), Math.max(0, c[2] - 3), Math.min(PN - 1, c[3] + 3), Math.min(PN - 1, c[4] + 3));
      }
    } else {
      for (let i = 0; i < N; i++) raw[i] = pass[i] && !blk[i] ? 1 : 0;
      this.effRegion(e, 0, 0, PN - 1, PN - 1);
    }
    e.ver = this.version; e.lab = null; e.sizes = null; e.part.clear();
    return e;
  }
  // Recompute ok / pen / qc of a cell rectangle from the raw grid. A cell is blocked when it is, and for the big classes
  // when a neighbour is (class 2: orthogonal ones, class 3: all eight); cells next to obstacles get a soft cost, so paths
  // prefer open ground. Cells at the very border never act as obstacles (they would erode the whole rim).
  effRegion(e, x0, y0, x1, y1) {
    const cls = e.cls, raw = e.raw, ok = e.ok, pen = e.pen, qc = e.qc, slope = this.cellSlope;
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const i = cy * PN + cx;
      let o = raw[i], p = 0;
      if (cls > 0) for (let dy = -2; dy <= 2; dy++) {
        const ny = cy + dy; if (ny < 1 || ny > PN - 2) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx;
          if (nx < 1 || nx > PN - 2 || (!dx && !dy) || raw[ny * PN + nx]) continue;
          if (Math.max(Math.abs(dx), Math.abs(dy)) === 1) {
            if (cls === 3 || (cls === 2 && (!dx || !dy))) o = 0;
            if (p < 1.2) p = 1.2;
          } else if (p < 0.5) p = 0.5;
        }
      }
      ok[i] = o; pen[i] = p;
    }
    if (cls >= 2) {
      // keep the big bodies in the middle of open ground: extra cost on walkable cells that touch the eroded border
      const edge = cls === 3 ? 2.5 : 1.5;
      for (let cy = Math.max(1, y0); cy <= Math.min(PN - 2, y1); cy++) for (let cx = Math.max(1, x0); cx <= Math.min(PN - 2, x1); cx++) {
        const i = cy * PN + cx;
        if (!ok[i]) continue;
        if (!ok[i - 1] || !ok[i + 1] || !ok[i - PN] || !ok[i + PN] || !ok[i - PN - 1] || !ok[i - PN + 1] || !ok[i + PN - 1] || !ok[i + PN + 1]) pen[i] = Math.max(pen[i], edge);
      }
    }
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) { const i = cy * PN + cx; qc[i] = Math.min(40, Math.round((slope[i] * 0.6 + pen[i]) * 8)); }   // capped: a step must stay below the bucket ring size
  }

  // Connected components (8-way, no corner cutting) of an effective grid. lab[i] = 0 for blocked cells.
  effComps(e) {
    if (e.lab) return e.lab;
    const ok = e.ok, N = PN * PN, stack = SCR.stack, lab = e.labBuf || (e.labBuf = new Int32Array(N));
    lab.fill(0);
    const sizes = [0];
    let n = 0;
    for (let s0 = 0; s0 < N; s0++) {
      if (!ok[s0] || lab[s0]) continue;
      n++; let sp = 0, size = 0;
      stack[sp++] = s0; lab[s0] = n;
      while (sp) {
        const cur = stack[--sp]; size++;
        for (let k = 0; k < 8; k++) {
          const ni = cur + NOFF[k];
          if (!ok[ni] || lab[ni]) continue;
          if (NDIAG[k] && (!ok[cur + NDX[k]] || !ok[cur + NDY[k]])) continue;
          lab[ni] = n; stack[sp++] = ni;
        }
      }
      sizes[n] = size;
    }
    e.sizes = sizes; e.lab = lab;
    return lab;
  }

  passableAtC(domain, x, y, cls = 0) {
    if (domain === 'air') return this.passableAt(domain, x, y);
    if (x < PCELL || y < PCELL || x > MAP_SIZE - PCELL || y > MAP_SIZE - PCELL) return false;
    return this.effGrid(domain, cls).ok[this.cellIdx(x, y)] === 1;
  }

  lineClear(domain, x0, y0, x1, y1, cls = 0) {
    if (domain === 'air') return true;
    const ok = this.effGrid(domain, cls).ok;
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.ceil(d / (PCELL * 0.5));
    for (let i = 1; i <= n; i++) {
      const t = i / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      if (x < PCELL || y < PCELL || x > MAP_SIZE - PCELL || y > MAP_SIZE - PCELL) return false;
      if (!ok[((y / PCELL) | 0) * PN + ((x / PCELL) | 0)]) return false;
    }
    return true;
  }

  // Nearest walkable cell of an effective grid (spiral search). Returns [cx, cy].
  nearestOk(e, cx, cy, maxR = 40) {
    const ok = e.ok;
    if (ok[cy * PN + cx]) return [cx, cy];
    for (let r = 1; r < maxR; r++) {
      let best = -1, bd = Infinity;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        if (Math.abs(i) !== r && Math.abs(j) !== r) continue;
        const x = cx + i, y = cy + j;
        if (x < 0 || y < 0 || x >= PN || y >= PN) continue;
        if (ok[y * PN + x]) { const d = i * i + j * j; if (d < bd) { bd = d; best = y * PN + x; } }
      }
      if (best >= 0) return [best % PN, (best / PN) | 0];
    }
    return [cx, cy];
  }
  nearestPassable(domain, cx, cy, cls = 0) { return this.nearestOk(this.effGrid(domain, cls), cx, cy); }

  // Component of the walkable grid a world position belongs to (looks a few cells around when standing on a blocked one).
  compAt(e, x, y) {
    const lab = this.effComps(e);
    const [cx, cy] = this.cell(x, y);
    if (lab[cy * PN + cx]) return lab[cy * PN + cx];
    for (let r = 1; r <= 3; r++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      const nx = cx + i, ny = cy + j; if (nx < 0 || ny < 0 || nx >= PN || ny >= PN) continue;
      if (lab[ny * PN + nx]) return lab[ny * PN + nx];
    }
    return 0;
  }

  // Goal cell to path to: the requested cell when it is reachable from component K, otherwise the reachable
  // cell closest to it (with a mild preference for cells near the asking unit, so it doesn't walk round the map
  // to stand on the far side of a mountain). Returns [gx, gy, partial].
  reachableGoal(e, K, gx, gy, ucx = gx, ucy = gy) {
    const lab = this.effComps(e);
    if (!K) return [gx, gy, false];
    const [sx, sy] = this.nearestOk(e, gx, gy);
    if (lab[sy * PN + sx] === K) return [gx, gy, false];
    const key = K + ':' + gx + ':' + gy + ':' + (ucx >> 2) + ':' + (ucy >> 2);
    let r = e.part.get(key);
    if (!r) {
      let best = -1, bd = Infinity;
      // windows of growing size around the goal: a cell outside a window of half-size R is farther than R from the goal,
      // so once the best score is <= R nothing beyond can beat it (the common case is a goal on a cliff next to open ground)
      for (let R = 24; ; R *= 3) {
        const x0 = Math.max(0, gx - R), x1 = Math.min(PN - 1, gx + R), y0 = Math.max(0, gy - R), y1 = Math.min(PN - 1, gy + R);
        best = -1; bd = Infinity;
        for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
          const i = cy * PN + cx;
          if (lab[i] !== K) continue;
          const d = Math.sqrt((cx - gx) * (cx - gx) + (cy - gy) * (cy - gy)) + 0.3 * Math.sqrt((cx - ucx) * (cx - ucx) + (cy - ucy) * (cy - ucy));
          if (d < bd) { bd = d; best = i; }
        }
        if (bd <= R || R >= PN) break;
      }
      r = best < 0 ? [gx, gy, false] : [best % PN, (best / PN) | 0, true];
      e.part.set(key, r);
    }
    return r;
  }

  // ---------------------------------------------------------------- flow fields
  // Dijkstra flow field toward a goal cell over the class-effective grid. Fields are versioned, not invalidated:
  // a stale field (new building placed) is still used and refreshed in the background within a time budget.
  // With a requester cell `req` the search stops shortly after that cell is settled (cost x1.15 + 15 cells): on a big map a
  // short order then costs a small disc, not the whole map. Cells beyond stay Infinity (see Terrain.covers); `lim` is the
  // final cost bound (>= minLim, Infinity for a complete field). Without `req` the field is complete.
  buildField(domain, cls, gx, gy, req = -1, minLim = 0) {
    const t0 = performance.now();
    const N = PN * PN, e = this.effGrid(domain, cls), ok = e.ok, qc = e.qc;
    const di = SCR.di; di.fill(0x3fffffff);
    const [sx, sy] = this.nearestOk(e, gx, gy);
    let rq = -1;
    if (req >= 0) { const [rx, ry] = this.nearestOk(e, req % PN, (req / PN) | 0, 4); rq = ry * PN + rx; }
    // Dial's algorithm: integer costs (x8), circular buckets — much cheaper than a binary heap on a 256x256 grid
    const head = SCR.head, nxt = SCR.nxt, val = SCR.val;
    head.fill(-1);
    let cnt = 0, pending = 1, cutoff = Infinity;
    const s0 = sy * PN + sx;
    di[s0] = 0; val[0] = s0; nxt[0] = -1; head[0] = 0; cnt = 1;
    for (let d = 0; pending > 0 && d <= cutoff; d++) {
      const b = d & (BUCKETS - 1);
      while (head[b] >= 0) {
        const en = head[b]; head[b] = nxt[en]; pending--;
        const cur = val[en];
        if (di[cur] !== d) continue;
        if (cur === rq) cutoff = Math.max(minLim, d * 1.15 + 120);
        for (let k = 0; k < 8; k++) {
          const ni = cur + NOFF[k];
          if (!ok[ni]) continue;
          let step = 8;
          if (NDIAG[k]) { if (!ok[cur + NDX[k]] || !ok[cur + NDY[k]]) continue; step = 11; }
          const nd = d + step + qc[ni];
          if (nd < di[ni]) {
            di[ni] = nd;
            const eb = nd & (BUCKETS - 1);
            val[cnt] = ni; nxt[cnt] = head[eb]; head[eb] = cnt++; pending++;
          }
        }
      }
    }
    const dist = this._distPool.pop() || new Float32Array(N);
    for (let i = 0; i < N; i++) { const v = di[i]; dist[i] = v >= 0x3fffffff || v > cutoff ? Infinity : v * 0.125; }
    this.spentMs += performance.now() - t0;
    this.fieldsBuilt++;
    this._lim = cutoff;
    return dist;
  }

  // True when cell `ci` (or a cell within 3 around it: a unit may stand on a blocked cell) has a distance in the field.
  covers(f, ci) {
    if (f.lim === Infinity) return true;
    const d = f.dist;
    if (isFinite(d[ci])) return true;
    const cx = ci % PN, cy = (ci / PN) | 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && ny >= 0 && nx < PN && ny < PN && isFinite(d[ny * PN + nx])) return true;
    }
    return false;
  }

  // Cached field lookup. Returns the field entry (possibly stale) or null when there is none yet and the tick's time
  // budget is spent; in that case the request is queued and served first thing next tick. `pri` marks a request from a
  // moving unit (queue order); stale fields of used goals refresh after ~1 s. `req`: requester cell (see buildField); a
  // cached partial field that does not cover it is rebuilt, and the caller must still check `covers` when the budget is spent.
  flowField(domain, cls, gx, gy, pri = 1, req = -1) {
    const key = domain + ':' + cls + ':' + gx + ':' + gy;
    const f = this.flowCache.get(key);
    if (f) {
      if (f.used !== this.tick) { this.flowCache.delete(key); this.flowCache.set(key, f); f.used = this.tick; }   // LRU, once per tick
      if ((f.ver === this.version || this.tick - f.tick < 75) && (f.lim === Infinity || (req >= 0 && this.covers(f, req)))) return f;
    }
    if (this.spentMs < this.budgetMs) return this.installField(key, domain, cls, gx, gy, req, f ? f.lim : 0);
    let q = this.wanted.get(key);
    if (!q) this.wanted.set(key, q = { key, domain, cls, gx, gy, req, lim: f ? f.lim : 0, since: this.tick, fresh: !f, pri });
    q.pri = Math.max(q.pri, pri); if (req < 0) q.req = -1; else if (q.req >= 0) q.req = req;
    return f && (f.lim === Infinity || req >= 0) ? f : null;   // a partial field is no answer to a request for a complete one
  }
  installField(key, domain, cls, gx, gy, req = -1, minLim = 0) {
    const dist = this.buildField(domain, cls, gx, gy, req, minLim);
    const f = { dist, ver: this.version, tick: this.tick, used: this.tick, key, lim: this._lim };
    this.flowCache.delete(key); this.flowCache.set(key, f);
    this.wanted.delete(key);
    if (this.flowCache.size > 320) {
      const old = this.flowCache.keys().next().value;
      const of = this.flowCache.get(old);
      this.flowCache.delete(old);
      if (of && of !== f && this._distPool.length < 16) this._distPool.push(of.dist);
    }
    return f;
  }
  // Force a rebuild on the next request (used by stuck recovery).
  dropField(domain, cls, gx, gy) { const f = this.flowCache.get(domain + ':' + cls + ':' + gx + ':' + gy); if (f) { f.ver = -1; f.tick = -1e9; } }

  // Start of a tick: reset the budget, then serve queued requests (units waiting for a first field first, oldest first).
  resetBudget(tick) {
    this.tick = tick; this.spentMs = 0;
    if (!this.wanted.size) return;
    const list = [...this.wanted.values()].sort((a, b) => (b.fresh - a.fresh) || (b.pri - a.pri) || (a.since - b.since));
    for (const q of list) {
      if (this.spentMs >= this.budgetMs) break;
      if (tick - q.since > 600) { this.wanted.delete(q.key); continue; }
      this.installField(q.key, q.domain, q.cls, q.gx, q.gy, q.req, q.lim);
    }
  }

  // Path distance between points (in world units), Infinity if unreachable, null if budget exhausted.
  pathDist(domain, x0, y0, x1, y1, cls = 0) {
    if (domain === 'air') return Math.hypot(x1 - x0, y1 - y0);
    const [gx, gy] = this.cell(x1, y1);
    const F = this.flowField(domain, cls, gx, gy, 0);
    if (!F) return null;
    const d = F.dist;
    // the start may sit on a blocked cell (a structure): use the best neighbour within 3 cells
    const [cx, cy] = this.cell(x0, y0);
    let best = d[cy * PN + cx];
    for (let r = 1; r <= 3 && !isFinite(best); r++)
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        const x = cx + i, y = cy + j; if (x < 0 || y < 0 || x >= PN || y >= PN) continue;
        if (d[y * PN + x] + r < best) best = d[y * PN + x] + r;
      }
    return best * PCELL;
  }

  // Steering toward a goal for a ground unit of clearance class `cls`. Returns a shared result object
  // { x, y, st, d, gx, gy, partial } (copy what you need; it is overwritten by the next call):
  //   st 'direct'  straight line is clear;   'field'  next waypoint along the flow field;
  //   'wait'       no field available yet (time budget) — the caller keeps its previous waypoint;
  //   'partial'    the goal is unreachable, x/y lead to the closest reachable cell;   'lost' standing in a dead pocket.
  // d = remaining path distance (world units) from the unit, Infinity when unknown. `ban` (Set of cell indices)
  // lets stuck recovery route around cells it already failed in.
  steer(domain, cls, x, y, tx, ty, ban = null) {
    const R = this._steer;
    R.x = tx; R.y = ty; R.st = 'direct'; R.d = Math.hypot(tx - x, ty - y); R.partial = false;
    if (domain === 'air') return R;
    const e = this.effGrid(domain, cls), ok = e.ok;
    if (!ban && this.lineClear(domain, x, y, tx, ty, cls)) return R;
    let [gx, gy] = this.cell(tx, ty);
    const K = this.compAt(e, x, y);
    const [ucx, ucy] = this.cell(x, y);
    if (!K) { R.st = 'lost'; R.x = x; R.y = y; R.d = Infinity; return R; }   // no walkable cell within 3 around the unit (stuck in rock / water): no field can lead out of here
    const [rx, ry, partial] = this.reachableGoal(e, K, gx, gy, ucx, ucy);
    const lab = e.lab;
    if (partial) { gx = rx; gy = ry; R.partial = true; }
    else if (Math.abs(tx - x) + Math.abs(ty - y) > 80) {
      // far goals share one field per 4x4-cell block (formation slots, nearby targets); the exact goal is
      // reached by line of sight once close. Only when the block centre lies in the goal's own component.
      const bx = Math.min(PN - 1, (gx & ~3) + 2), by = Math.min(PN - 1, (gy & ~3) + 2);
      if (ok[by * PN + bx] && lab[by * PN + bx] === K) { gx = bx; gy = by; }
    }
    R.gx = gx; R.gy = gy;
    let cx = ucx, cy = ucy, ci = cy * PN + cx;
    const F = this.flowField(domain, cls, gx, gy, 2, ci);
    if (!F || !this.covers(F, ci)) { R.st = 'wait'; R.x = x; R.y = y; R.d = Infinity; return R; }   // no field yet / the unit lies outside the searched disc: a bigger one is queued
    const f = F.dist;
    if (!isFinite(f[ci])) {
      // standing in a blocked/eroded cell: head for the best neighbour (nearest ring first, not through the building)
      let best = -1, bd = Infinity;
      for (let r = 1; r <= 3 && best < 0; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= PN || ny >= PN || Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const ni = ny * PN + nx; const v = f[ni] + Math.hypot(dx, dy) * 0.5; if (v < bd) { bd = v; best = ni; }
      }
      if (best < 0 || !isFinite(bd)) { R.st = 'lost'; R.d = Infinity; return R; }
      R.x = (best % PN + 0.5) * PCELL; R.y = (((best / PN) | 0) + 0.5) * PCELL; R.st = 'field'; R.d = bd * PCELL;
      return R;
    }
    R.d = f[ci] * PCELL;
    if (f[ci] === 0) {
      // standing on the (reachable) goal cell: finish by line of sight when the exact goal is walkable
      if (!partial && this.lineClear(domain, x, y, tx, ty, 0)) return R;
      R.x = x; R.y = y; R.st = partial ? 'partial' : 'field';
      return R;
    }
    // Walk down the field a few steps, keep the farthest cell still in line of sight.
    let lx = (cx + 0.5) * PCELL, ly = (cy + 0.5) * PCELL;
    let found = false;
    for (let step = 0; step < 10; step++) {
      let best = -1, bd = step === 0 && ban ? Infinity : f[ci];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= PN || ny >= PN) continue;
        const ni = ny * PN + nx;
        if (!ok[ni] || (ban && ban.has(ni))) continue;
        if (dx && dy && (!ok[cy * PN + nx] || !ok[ny * PN + cx])) continue;
        if (f[ni] < bd) { bd = f[ni]; best = ni; }
      }
      if (best < 0) break;
      ci = best; cx = best % PN; cy = (best / PN) | 0;
      const px = (cx + 0.5) * PCELL, py = (cy + 0.5) * PCELL;
      if (step === 0 || this.lineClear(domain, x, y, px, py, cls)) { lx = px; ly = py; found = true; } else break;
    }
    if (found) { R.x = lx; R.y = ly; R.st = partial ? 'partial' : 'field'; }
    else { R.x = x; R.y = y; R.st = 'lost'; }
    return R;
  }
}
