// Procedural recreations of three classic Supreme Commander maps (1v1 layouts).
// Every map is point-symmetric around the centre so both starts are fair.

// Maps are 2048x2048 units (1 unit = 2.5 m, ~5.12 x 5.12 km). Sizes of features (ridge widths, passes, ramps, base pads) stay in
// absolute units: the extra space is filled with more terrain and expansions, not with stretched shapes.
export const MAP_SIZE = 2048;
const S = MAP_SIZE;

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function vnoise(x, y, seed = 1) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy) * 2 - 1;
}

export function fbm(x, y, seed = 1, oct = 4) {
  let a = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { a += vnoise(x * f, y * f, seed + i * 17) * amp; f *= 2.03; amp *= 0.5; }
  return a;
}

// Ridged noise for sharp mountain crests.
function ridged(x, y, seed, oct = 4) {
  let a = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { a += (1 - Math.abs(vnoise(x * f, y * f, seed + i * 31))) * amp; f *= 2.1; amp *= 0.5; }
  return a;
}

// Symmetric noise: identical value at (x,y) and at the mirrored start.
const symN = (fn) => (x, y) => 0.5 * (fn(x, y) + fn(S - x, S - y));
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const gauss = (d, w) => Math.exp(-(d * d) / (2 * w * w));
const lerp = (a, b, t) => a + (b - a) * t;

function mirror(points) {
  const out = [];
  for (const p of points) { out.push({ x: p[0], y: p[1] }); out.push({ x: S - p[0], y: S - p[1] }); }
  return out;
}

function flattenStarts(h, starts, x, y, level, r = 150) {
  for (const s of starts) {
    const d = Math.hypot(x - s.x, y - s.y);
    const w = smooth(r, r * 0.45, d);
    h = lerp(h, level, w);
  }
  return h;
}

// Raised flat-topped plateau with steep sides (a cliff wherever no ramp cuts through): radius r at the top, `edge` = half width of the flank.
const mesa = (x, y, cx, cy, r, h, edge = 12) => h * smooth(r + edge, Math.max(0, r - edge), Math.hypot(x - cx, y - cy));

// Ramp: a corridor of half width w whose surface climbs linearly from height ha at a=[x,y] to hb at b=[x,y] and blends
// into the terrain at its sides and ends (`pad`: also levels a disc of that radius around the top end, a lookout). The flat middle is ~1.1*w wide, so keep w >= 30 for the experimentals (they
// need three free path cells). ha/hb default to the base height at the ends. A ramp list is mirrored through the map
// centre by `mirrorRamps`, so a symmetric map stays symmetric.
export function withRamps(base, list) {
  const rs = list.map(r => {
    let dx = r.b[0] - r.a[0], dy = r.b[1] - r.a[1], len = Math.hypot(dx, dy);
    const pad = r.pad || 0;
    const hb = r.hb ?? base(r.b[0], r.b[1]);
    // with a pad the slope has to reach the top level at the pad's edge, not at its centre
    if (pad) { const k = (len - pad * 0.8) / len; dx *= k; dy *= k; len *= k; }
    return { ax: r.a[0], ay: r.a[1], bx: r.b[0], by: r.b[1], dx, dy, len, w: r.w ?? 32, pad, ha: r.ha ?? base(r.a[0], r.a[1]), hb };
  });
  return (x, y) => {
    let h = base(x, y);
    for (const r of rs) {
      if (r.pad) { const d = Math.hypot(x - r.bx, y - r.by); if (d < r.pad + 14) h = lerp(h, r.hb, smooth(r.pad + 14, r.pad, d)); }
      const px = x - r.ax, py = y - r.ay;
      const along = (px * r.dx + py * r.dy) / r.len, perp = Math.abs(px * r.dy - py * r.dx) / r.len;
      if (perp > r.w || along < -r.w * 0.7 || along > r.len + r.w * 0.7) continue;
      const wl = smooth(r.w, r.w * 0.55, perp);
      const we = smooth(-r.w * 0.7, 0, along) * smooth(r.len + r.w * 0.7, r.len, along);
      const t = Math.max(0, Math.min(1, along / r.len));
      h = lerp(h, lerp(r.ha, r.hb, t), wl * we);
    }
    return h;
  };
}
// ramp descriptor from a plateau: climbs from the ground at distance r+run to the top edge at r-6, in direction `ang`.
function plateauRamp(cx, cy, r, ang, run, w = 32) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { a: [cx + c * (r + run), cy + s * (r + run)], b: [cx + c * (r - 6), cy + s * (r - 6)], w };
}
const mirrorRamps = (list) => list.flatMap(r => [r, { ...r, a: [S - r.a[0], S - r.a[1]], b: [S - r.b[0], S - r.b[1]] }]);
const deg = (a) => a * Math.PI / 180;

// Distance from a point to a segment; wall-like ridges ("spurs") are segments [ax, ay, bx, by, halfWidth, height].
const segD = (x, y, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - ax - dx * t, y - ay - dy * t); };
const spursAt = (list, x, y) => { let h = 0; for (const s of list) { const d = segD(x, y, s[0], s[1], s[2], s[3]); if (d < s[4] * 4) h += gauss(d, s[4]) * s[5]; } return h; };
// Smooth round hills [x, y, width, height].
const bumpsAt = (list, x, y) => { let h = 0; for (const b of list) { const d = Math.hypot(x - b[0], y - b[1]); if (d < b[2] * 3.5) h += gauss(d, b[2]) * b[3]; } return h; };
// A layout is written for one half of the map and mirrored through the centre.
const mirrorP = (list) => list.flatMap(b => [b, { ...b, x: S - b.x, y: S - b.y }]);
const mirrorSegs = (list) => list.flatMap(s => [s, [S - s[0], S - s[1], S - s[2], S - s[3], s[4], s[5]]]);
const mirrorBumps = (list) => list.flatMap(b => [b, [S - b[0], S - b[1], b[2], b[3]]]);
// Mesas {x, y, r, h, a: [ramp directions in degrees], run}: ramps climb from the ground to the top in each given direction.
const mesaRamps = (list, w = 34) => list.flatMap(b => b.a.map(a => plateauRamp(b.x, b.y, b.r, deg(a), b.run || 90, w)));
// n points on a ring every `step` degrees (for expansions around a landmark); `mirror` then doubles them, so a full ring is n = 360 / step / 2.
const ringPts = (cx, cy, r, n, a0 = 0, step = 360 / n) => Array.from({ length: n }, (_, i) => [Math.round(cx + Math.cos(deg(a0 + i * step)) * r), Math.round(cy + Math.sin(deg(a0 + i * step)) * r)]);

// ------------------------------------------------------------------ DUAL GAP
// Старты 0 и 1 — база для игры 1 на 1; 2 и 3 (центрально-симметричная пара) добавлены для игр на 3-4 игроков.
const dualGapStarts = [{ x: 1024, y: 256 }, { x: 1024, y: 1792 }, { x: 1672, y: 392 }, { x: S - 1672, y: S - 392 }];
const dgNoise = symN((x, y) => fbm(x / 190, y / 190, 11, 5));
// averaging two noise samples halves the variance; stretch it back so crests stay jagged
const contrast = (fn, m, k) => (x, y) => Math.max(0, m + (fn(x, y) - m) * k);
const dgRidge = contrast(symN((x, y) => ridged(x / 60, y / 60, 23, 4)), 0.55, 2.2);
const DG_PASS = 560;   // the two passes through the main ridge: x = DG_PASS and S - DG_PASS
// Bluffs of the northern half (the southern one is the mirror image); ramps lead towards the base / the road to the passes.
const dgHalf = [
  { x: 692, y: 428, r: 50, h: 26, a: [-28, 62] }, { x: 1366, y: 420, r: 42, h: 20, a: [-154, 138] },
  { x: 330, y: 580, r: 56, h: 24, a: [15, 100] }, { x: 1740, y: 620, r: 52, h: 22, a: [165, 80] },
  { x: 1024, y: 660, r: 46, h: 20, a: [-90, 90] }, { x: 430, y: 200, r: 40, h: 18, a: [0, 100] }, { x: 1650, y: 190, r: 40, h: 18, a: [180, 100] }
];
const dgMesas = mirrorP(dgHalf);
// Rock spurs funnelling the approach to each pass (throat ~150 wide).
const dgSpurs = mirrorSegs([[400, 760, 462, 950, 20, 46], [720, 760, 658, 950, 20, 46], [1328, 760, 1390, 950, 20, 46], [1648, 760, 1586, 950, 20, 46]]);
const dgBumps = mirrorBumps([[250, 420, 70, 14], [800, 640, 80, 12], [1250, 560, 70, 14], [1560, 420, 80, 12], [1900, 300, 70, 14], [1900, 800, 60, 12], [140, 800, 60, 12], [1030, 880, 70, 10]]);
const dualGap = {
  id: 'dualgap', name: 'Двойной перевал', en: 'Dual Gap', players: 2, seed: 101, size: S,
  desc: 'Две горные базы разделены непроходимым хребтом с двумя узкими перевалами. Классика сухопутного боя: контроль ущелий решает всё.',
  water: -100, naval: false,
  starts: dualGapStarts,
  height(x, y) {
    let h = 24 + dgNoise(x, y) * 10;
    const d = Math.abs(y - S / 2);
    let ridge = gauss(d, 60) * (10 + dgRidge(x, y) * 62) + gauss(d, 130) * 12;
    const gap = Math.max(gauss(x - DG_PASS, 42), gauss(x - (S - DG_PASS), 42));
    ridge *= 1 - 0.97 * gap;
    // Rocky walls along the side edges, flanking the gaps' mouths.
    const edge = smooth(130, 10, Math.min(x, S - x)) * (14 + dgRidge(y, x) * 40);
    h += ridge + edge + spursAt(dgSpurs, x, y) * (1 - 0.7 * gap) + bumpsAt(dgBumps, x, y);
    // Side bluffs in each base half: flat-topped mesas with steep flanks, reached by the ramps below.
    for (const b of dgMesas) h += mesa(x, y, b.x, b.y, b.r, b.h, 14);
    return flattenStarts(h, dualGapStarts, x, y, 26, 170);
  },
  mass: mirror([
    [980, 232], [1068, 232], [982, 324], [1066, 324],            // main base
    [692, 428], [1366, 420], [662, 308], [1392, 278], [1132, 458], // bluffs and the first expansions
    [330, 580], [1740, 620], [1024, 660], [430, 200], [1650, 190],  // tops of the flank bluffs
    [250, 330], [320, 300], [240, 430], [150, 160], [200, 700],     // west flank
    [1800, 330], [1730, 250], [1850, 450], [1900, 150], [1890, 760], // east flank
    [900, 560], [1150, 560], [1024, 820], [820, 700], [1230, 700],    // centre of the half
    [520, 780], [600, 780], [560, 880], [560, 1024],                  // western pass funnel
    [1448, 780], [1528, 780], [1488, 880],                            // eastern pass funnel
    [1628, 368], [1716, 368], [1630, 460], [1714, 460]                // base of the extra start (4 players)
  ]),
  palette: {
    low: [0.28, 0.36, 0.20], mid: [0.36, 0.40, 0.24], high: [0.46, 0.44, 0.40], rock: [0.40, 0.38, 0.36], peak: [0.90, 0.92, 0.95],
    sand: [0.55, 0.50, 0.38], seabed: [0.3, 0.3, 0.25], peakH: 94, rockSlope: 0.6
  },
  sky: { top: 0x3e6fb3, horizon: 0xbdd4e6, fog: 0xaec3d4, sun: 0xfff1d8, sunDir: [-0.55, 0.6, 0.5], ambient: 0.9 },
  trees: { kind: 'pine', count: 3600 }, rocks: 640,
  waterColor: null
};

// Ramps up the side mesas (mirrored for the other half).
dualGap.height = withRamps(dualGap.height, mirrorRamps(mesaRamps(dgHalf)));

// ------------------------------------------------------------ SETON'S CLUTCH
const setonStarts = [{ x: 600, y: 280 }, { x: 1448, y: 1768 }, { x: 1704, y: 232 }, { x: S - 1704, y: S - 232 }];
const stNoise = symN((x, y) => fbm(x / 150, y / 150, 41, 5));
const stCoast = symN((x, y) => fbm(x / 90, y / 90, 57, 3));
const stBay = symN((x, y) => fbm(x / 380, y / 380, 63, 3));
const stHills = symN((x, y) => fbm(y * 1.3 / 150, x * 1.3 / 150, 41, 5));
const stIslands = mirrorP([{ x: 330, y: 1000, r: 110 }, { x: 1560, y: 860, r: 80 }, { x: 780, y: 1190, r: 70 }]);
const stBridgeX = (y) => S / 2 - Math.sin((y - S / 2) / 90) * 30;   // the land bridge meanders
const stHalf = [
  { x: 450, y: 270, r: 44, h: 22, a: [0, 55] }, { x: 860, y: 400, r: 38, h: 20, a: [180, -90, 120] },
  { x: 1300, y: 300, r: 44, h: 20, a: [180, 60] }, { x: 200, y: 560, r: 40, h: 18, a: [0, 70] },
  { x: 1700, y: 480, r: 40, h: 20, a: [150, 90] }, { x: 1020, y: 600, r: 40, h: 20, a: [-110, 70, 0] }
];
const stMesas = mirrorP(stHalf);
const seton = {
  id: 'seton', name: 'Хватка Сетона', en: "Seton's Clutch", players: 2, seed: 202, size: S,
  desc: 'Два побережья разделены проливом. Узкий сухопутный мост в центре и острова с массой. Флот, авиация и штурм через «хватку».',
  water: 14, naval: true,
  starts: setonStarts,
  height(x, y) {
    const c = stCoast(x, y) * 45 + stBay(x, y) * 70;
    let land = Math.max(smooth(840, 770, y + c), smooth(S - 840, S - 770, y - c));
    // central land bridge ("the clutch")
    const bridgeW = 70 + stCoast(y, x) * 25;
    land = Math.max(land, smooth(bridgeW + 30, bridgeW - 10, Math.abs(x - stBridgeX(y))));
    // islands
    for (const i of stIslands) land = Math.max(land, smooth(i.r * 1.23, i.r * 0.77, Math.hypot(x - i.x, y - i.y) + c * 0.6));
    const seabed = 3 + stNoise(x, y) * 4;
    const ground = 22 + stNoise(x, y) * 9 + Math.max(0, stHills(x, y)) * 22;
    let h = lerp(seabed, ground, land);
    // cliffs near map edges on land
    h += smooth(90, 10, Math.min(x, S - x)) * 18 * land;
    // highland mesas inland (ramps below)
    for (const b of stMesas) h += mesa(x, y, b.x, b.y, b.r, b.h, 12);
    return flattenStarts(h, setonStarts, x, y, 24, 140);
  },
  mass: mirror([
    [556, 240], [644, 240], [550, 326], [650, 330],               // main base
    [450, 270], [860, 400], [1300, 300], [200, 560], [1700, 480], [1020, 600], // mesa tops
    [330, 140], [900, 150], [1200, 130], [1600, 180], [1900, 250],  // north shore of the base land
    [250, 420], [700, 520], [1100, 480], [1450, 560], [1850, 640],  // inland
    [400, 700], [800, 720], [1250, 720], [1650, 740], [150, 760],   // coast
    [Math.round(stBridgeX(880)), 880], [Math.round(stBridgeX(1070)), 1070],                 // the bridge
    [300, 980], [380, 1040], [300, 1070],                           // big island
    [1540, 840], [1600, 890], [770, 1170], [810, 1220],             // small islands
    [130, 400], [1000, 260], [1500, 300], [560, 620],               // more inland
    [1660, 192], [1748, 192], [1654, 278], [1754, 282]              // base of the extra start (4 players)
  ]),
  palette: {
    low: [0.24, 0.40, 0.18], mid: [0.30, 0.44, 0.20], high: [0.42, 0.44, 0.30], rock: [0.42, 0.40, 0.36], peak: [0.6, 0.6, 0.55],
    sand: [0.76, 0.68, 0.48], seabed: [0.42, 0.40, 0.30], peakH: 999, rockSlope: 0.6
  },
  sky: { top: 0x2f65b0, horizon: 0xcfe2ee, fog: 0xb9d0df, sun: 0xfff6e0, sunDir: [0.55, 0.62, 0.45], ambient: 0.9 },
  trees: { kind: 'broadleaf', count: 4400 }, rocks: 480,
  waterColor: { deep: 0x0b3a5e, shallow: 0x2a8a9a }
};

// Ramps: up the highland mesas, and gentle beaches on the east/west shores of the islands (amphibious units and
// transports only — the islands stay cut off from the mainland by design).
seton.height = withRamps(seton.height, mirrorRamps([
  ...mesaRamps(stHalf),
  ...stIslands.filter((_, i) => i % 2 === 0).flatMap(i => [{ a: [i.x + i.r + 70, i.y], b: [i.x + i.r - 17, i.y], w: 34 }, { a: [i.x - i.r - 70, i.y], b: [i.x - i.r + 17, i.y], w: 34 }])
]));

// ------------------------------------------------------------------ ARCHIPELAGO
// Четыре базы на своих островах посреди океана, между ними россыпь малых островов с массой; суши между базами нет — только флот, авиация и десант.
const arStarts = [{ x: 480, y: 420 }, { x: S - 480, y: S - 420 }, { x: 1480, y: 600 }, { x: S - 1480, y: S - 600 }];
const arSmall = [{ x: 1000, y: 330, r: 95 }, { x: 240, y: 900, r: 100 }, { x: 1880, y: 230, r: 80 }, { x: 760, y: 760, r: 90 }, { x: 1150, y: 860, r: 80 }, { x: 1800, y: 880, r: 100 }];
const arIsles = [...mirrorP([{ x: 480, y: 420, r: 250 }, { x: 1480, y: 600, r: 250 }, ...arSmall]), { x: S / 2, y: S / 2, r: 70 }];
const arPads = arIsles.filter(i => i.r < 200);   // ровные площадки под массу в центре малых островов
const arNoise = symN((x, y) => fbm(x / 150, y / 150, 91, 5));
const arCoast = symN((x, y) => fbm(x / 90, y / 90, 97, 3));
const arHills = symN((x, y) => fbm(y * 1.3 / 150, x * 1.3 / 150, 91, 5));
const archipelago = {
  id: 'archipelago', name: 'Архипелаг', en: 'Archipelago', players: 2, seed: 303, size: S,
  desc: 'Тропический океан: каждая база на своём острове, между ними малые острова с массой. Суши между базами нет — решают флот, авиация и десант.',
  water: 14, naval: true, split: true, isles: true,
  starts: arStarts,
  height(x, y) {
    const c = arCoast(x, y) * 60;
    let land = 0;
    for (const i of arIsles) land = Math.max(land, smooth(i.r * 1.5, i.r * 0.7, Math.hypot(x - i.x, y - i.y) + c * 0.6));
    const h = lerp(3 + arNoise(x, y) * 4, 22 + arNoise(x, y) * 9 + Math.max(0, arHills(x, y)) * 20, land);
    return flattenStarts(flattenStarts(h, arStarts, x, y, 24, 140), arPads, x, y, 22, 55);
  },
  mass: [
    ...mirror([[436, 396], [524, 396], [438, 488], [522, 488], [1436, 576], [1524, 576], [1438, 668], [1522, 668]]),   // базы
    ...mirror([[330, 340], [620, 520], [1360, 470], [1640, 700], [400, 560], [1560, 470]]),                             // острова баз
    ...mirror(arSmall.flatMap(i => [[i.x, i.y], [i.x - Math.round(i.r * 0.4), i.y + 6], [i.x + Math.round(i.r * 0.4), i.y - 6]])),
    { x: S / 2, y: S / 2 }
  ],
  palette: {
    low: [0.20, 0.46, 0.20], mid: [0.28, 0.52, 0.24], high: [0.46, 0.50, 0.30], rock: [0.44, 0.42, 0.38], peak: [0.6, 0.6, 0.55],
    sand: [0.86, 0.78, 0.56], seabed: [0.62, 0.58, 0.42], peakH: 999, rockSlope: 0.6
  },
  sky: { top: 0x1f8fd6, horizon: 0xd9f0f2, fog: 0xbfe4ea, sun: 0xfff4d0, sunDir: [0.4, 0.7, 0.5], ambient: 0.95 },
  trees: { kind: 'broadleaf', count: 1500 }, rocks: 200,
  waterColor: { deep: 0x0a4d7a, shallow: 0x35c2c0 }
};

// --------------------------------------------------------------- ASTRO CRATER
const AC = S / 2, AC_R = 500;   // centre and rim radius of the great crater
const astroStarts = [{ x: 210, y: 210 }, { x: S - 210, y: S - 210 }, { x: S - 210, y: 210 }, { x: 210, y: S - 210 }];
const acNoise = symN((x, y) => fbm(x / 160, y / 160, 71, 5));
const acRim = contrast(symN((x, y) => ridged(x / 60, y / 60, 83, 4)), 0.55, 2.0);
// Radial ejecta ridges outside the rim, between the passes and the lookouts: they channel traffic into lanes.
const acSpurs = (() => {
  const l = [];
  for (let k = 0; k < 8; k++) { const a = deg(22.5 + 45 * k), c = Math.cos(a), s = Math.sin(a); l.push([AC + c * (AC_R + 110), AC + s * (AC_R + 110), AC + c * (AC_R + 300), AC + s * (AC_R + 300), 20, 40]); }
  return l;
})();
const acMass = mirror([
  [168, 180], [252, 168], [170, 265], [260, 260],                  // main base
  [360, 210], [210, 380], [420, 420], [560, 150], [140, 560],      // first expansions
  [640, 390], [330, 640], [820, 180], [160, 800], [470, 560], [60, 330],  // outer ring
  ...ringPts(AC, AC, 150, 3, 75), ...ringPts(AC, AC, 300, 4, 22.5, 45), ...ringPts(AC, AC, 400, 4, 0, 45),   // crater floor
  [AC + AC_R - 4, AC], [AC, AC + AC_R - 4],                         // lookout terraces
  [1700, 250], [1810, 190], [1880, 330], [1760, 380], [1600, 150], // north-east corner
  [1150, 140], [1430, 370], [1500, 480], [1900, 520], [1780, 640], [1000, 80], [1900, 80], [1650, 560], [1170, 360]
]);
// Small impact craters (rock rings, breached towards the great crater so their floors can be reached), kept clear of deposits, bases and ridges.
const craters = (() => {
  const rnd = mulberry32(777);
  const list = [];
  for (let i = 0; i < 400 && list.length < 48; i++) {
    const r = (rnd() < 0.1 ? 80 : 25) + rnd() * 45, R = r * 1.8 + 25;
    const x = R + rnd() * (S - 2 * R), y = R + rnd() * (S - 2 * R);
    if (Math.hypot(x - AC, y - AC) < AC_R + 60 + r) continue;
    if (astroStarts.slice(0, 2).some(s => Math.hypot(s.x - x, s.y - y) < 190 + r) || astroStarts.slice(0, 2).some(s => Math.hypot(S - s.x - x, S - s.y - y) < 190 + r)) continue;   // (кратеры считаются по базовой паре стартов, чтобы карта 1 на 1 не менялась)
    if (acMass.some(m => Math.hypot(m.x - x, m.y - y) < r * 1.8 + 10)) continue;
    if (acSpurs.some(sg => segD(x, y, sg[0], sg[1], sg[2], sg[3]) < r * 1.8 + 25)) continue;
    if ((Math.abs(x - AC) < R + 40 && Math.abs(y - AC) > AC_R - 60) || (Math.abs(y - AC) < R + 40 && Math.abs(x - AC) > AC_R - 60)) continue;   // lookout ramps
    const gap = Math.atan2(AC - y, AC - x);
    list.push({ x, y, r, gap }, { x: S - x, y: S - y, r, gap: gap + Math.PI });
  }
  return list.filter(c => !astroStarts.slice(2).some(s => Math.hypot(s.x - c.x, s.y - c.y) < 190 + c.r));   // убрать кратеры у дополнительных стартов
})();
const acHills = mirrorBumps([...ringPts(AC, AC, 210, 3, 15).map(p => [...p, 34, 16]), [600, 300, 60, 14], [1000, 220, 70, 12], [320, 800, 60, 14], [800, 1010, 60, 12]]);
const astro = {
  id: 'astro', name: 'Астрократер', en: 'Astro Crater', players: 2, seed: 303, size: S,
  desc: 'Гигантский ударный кратер на чужой планете. Кольцевой вал с четырьмя проходами, богатое массой дно и центральная вершина.',
  water: -100, naval: false,
  starts: astroStarts,
  height(x, y) {
    const r = Math.hypot(x - AC, y - AC);
    const ang = Math.atan2(y - AC, x - AC);
    let h = 26 + acNoise(x, y) * 8;
    // crater bowl
    const bowl = smooth(AC_R, AC_R - 120, r);
    h = lerp(h, 8 + (r / AC_R) * (r / AC_R) * 12, bowl);
    // central peak
    h += gauss(r, 56) * 30 + acRim(x * 2, y * 2) * gauss(r, 80) * 6;
    // rim with 4 passes (diagonals face the starts)
    let rim = gauss(r - AC_R, 32) * (48 + acRim(x, y) * 26);
    let pass = 0;
    for (const a of [Math.PI / 4, 3 * Math.PI / 4, -Math.PI / 4, -3 * Math.PI / 4]) {
      let da = Math.abs(ang - a); da = Math.min(da, Math.PI * 2 - da);
      pass = Math.max(pass, gauss(da * AC_R, 58));
    }
    rim *= 1 - 0.97 * smooth(0.12, 0.85, pass);
    h += rim + spursAt(acSpurs, x, y) + bumpsAt(acHills, x, y);
    // small impact craters
    for (const c of craters) {
      const dx = x - c.x, dy = y - c.y;
      if (Math.abs(dx) > c.r * 1.8 || Math.abs(dy) > c.r * 1.8) continue;
      const d = Math.hypot(dx, dy);
      if (d < c.r * 1.8) {
        // the rim is breached on the side facing the big crater (and opposite), so the floor is reachable
        const da = Math.acos(Math.max(-1, Math.min(1, Math.cos(Math.atan2(dy, dx) - c.gap)))), da2 = Math.PI - da;
        const breach = Math.max(gauss(da * c.r, c.r * 0.42), gauss(da2 * c.r, c.r * 0.42));
        h += -smooth(c.r, 0, d) * c.r * 0.35 + gauss(d - c.r, c.r * 0.18) * c.r * 0.28 * (1 - 0.95 * smooth(0.1, 0.8, breach));
      }
    }
    return flattenStarts(h, astroStarts, x, y, 28, 150);
  },
  mass: [...acMass, ...mirror([[1880, 180], [1878, 265], [1788, 260], [1830, 128]])],   // + база дополнительного старта (4 игрока)
  palette: {
    low: [0.50, 0.30, 0.20], mid: [0.58, 0.38, 0.24], high: [0.50, 0.40, 0.36], rock: [0.36, 0.28, 0.26], peak: [0.75, 0.66, 0.60],
    sand: [0.62, 0.45, 0.30], seabed: [0.3, 0.2, 0.2], peakH: 78, rockSlope: 0.5
  },
  sky: { top: 0x2a1f4a, horizon: 0xd88a5a, fog: 0xb07a60, sun: 0xffd6b0, sunDir: [-0.6, 0.5, 0.5], ambient: 0.8 },
  trees: { kind: 'crystal', count: 1520 }, rocks: 1680,
  waterColor: null
};

// Ramps up onto the crater rim: lookout terraces (with a mass deposit) on the four flat sides between the passes.
astro.height = withRamps(astro.height, mirrorRamps([
  { a: [AC + AC_R + 178, AC], b: [AC + AC_R - 4, AC], w: 36, pad: 26 }, { a: [AC, AC + AC_R + 178], b: [AC, AC + AC_R - 4], w: 36, pad: 26 }
]));

// Mass deposits on dry land (those under water are dropped), the same filter Terrain applies: lets the menu count them without building a terrain.
export const massCount = (map) => map.mass.filter(p => map.height(p.x, p.y) > map.water + 1.5).length;

// примитивы рельефа — для генератора случайных карт (mapgen.js)
export { ridged, symN, smooth, gauss, lerp, mirror, mirrorP, mirrorSegs, mirrorBumps, mirrorRamps, mesa, mesaRamps, spursAt, bumpsAt, flattenStarts, contrast, segD, deg };
export const MAPS = { dualgap: dualGap, seton, astro, archipelago };
export const MAP_LIST = [dualGap, seton, astro, archipelago];
