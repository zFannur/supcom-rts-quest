// Vector unit / structure pictograms for the VR wrist panel (2D canvas, no WebGL, no fonts: Quest LITE has no model thumbnails).
// iconSprite(icon, color, struct) -> cached 96x96 canvas; `icon` is the spec.icon id from specs.js (same ids as the desktop glyph table).
const S = 96;
const DARK = 'rgba(6,12,18,.92)', LIGHT = 'rgba(255,255,255,.6)';
const cache = new Map();

function shade(hex, f) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const c = [1, 2, 3].map(i => Math.max(0, Math.min(255, Math.round(parseInt(m[i], 16) * f))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function path(x, pts, close = true) { x.beginPath(); pts.forEach(([a, b], i) => i ? x.lineTo(a, b) : x.moveTo(a, b)); if (close) x.closePath(); }
function shape(x, pts, col) { path(x, pts); x.fillStyle = col; x.fill(); x.lineWidth = 0.09; x.strokeStyle = DARK; x.stroke(); }
function disc(x, cx, cy, r, col) { x.beginPath(); x.arc(cx, cy, r, 0, 6.2832); x.fillStyle = col; x.fill(); x.lineWidth = 0.09; x.strokeStyle = DARK; x.stroke(); }
function box(x, cx, cy, w, h, col) { shape(x, [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]], col); }
function line(x, a, b, c, d, col, w = 0.12) { x.beginPath(); x.moveTo(a, b); x.lineTo(c, d); x.strokeStyle = col; x.lineWidth = w; x.stroke(); }
function arc(x, cx, cy, r, a0, a1, col, w = 0.12) { x.beginPath(); x.arc(cx, cy, r, a0, a1); x.strokeStyle = col; x.lineWidth = w; x.stroke(); }
function star(x, n, r1, r2, col) {
  const p = [];
  for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + i * Math.PI / n, r = i % 2 ? r2 : r1; p.push([Math.cos(a) * r, Math.sin(a) * r]); }
  shape(x, p, col);
}
function hull(x, c, hw, top, bot) { shape(x, [[0, top], [hw * 0.9, top + 0.55], [hw, bot - 0.2], [hw * 0.85, bot], [-hw * 0.85, bot], [-hw, bot - 0.2], [-hw * 0.9, top + 0.55]], c); }
function tankBase(x, c, w = 0.5, len = 0.95) {
  box(x, -w - 0.18, 0, 0.3, len * 2, shade(c, 0.45)); box(x, w + 0.18, 0, 0.3, len * 2, shade(c, 0.45));
  box(x, 0, 0, w * 2 + 0.1, len * 1.8, c);
}
function missile(x, cx, cy, h, col, tip) {
  shape(x, [[cx, cy - h], [cx + 0.2, cy - h * 0.55], [cx + 0.2, cy + h * 0.7], [cx + 0.42, cy + h], [cx - 0.42, cy + h], [cx - 0.2, cy + h * 0.7], [cx - 0.2, cy - h * 0.55]], col);
  if (tip) disc(x, cx, cy - h * 0.35, 0.11, tip);
}
function dome(x, c) { x.beginPath(); x.arc(0, 0.5, 0.95, Math.PI, 0); x.closePath(); x.fillStyle = c; x.fill(); x.lineWidth = 0.09; x.strokeStyle = DARK; x.stroke(); }
function ship(x, c, w, len, turrets) {
  shape(x, [[0, -len], [w * 0.8, -len * 0.45], [w, len * 0.7], [w * 0.8, len], [-w * 0.8, len], [-w, len * 0.7], [-w * 0.8, -len * 0.45]], c);
  box(x, 0, len * 0.35, w * 0.7, len * 0.4, shade(c, 0.7));
  turrets.forEach(([ty, r]) => { disc(x, 0, ty, r, shade(c, 1.25)); line(x, 0, ty, 0, ty - r * 1.9, DARK, 0.1); });
}
function factory(x, c, mark) {
  box(x, 0, 0.35, 1.8, 1.1, c);
  box(x, -0.6, -0.55, 0.3, 0.7, shade(c, 0.7)); box(x, 0.05, -0.62, 0.3, 0.9, shade(c, 0.7));
  shape(x, [[-0.9, -0.2], [-0.45, -0.5], [-0.45, -0.2], [0, -0.5], [0, -0.2], [0.45, -0.5], [0.45, -0.2], [0.9, -0.5], [0.9, -0.2]], shade(c, 1.15));
  mark(x);
}

const DRAW = {
  cmd: (x, c) => { star(x, 5, 1.05, 0.46, c); disc(x, 0, 0.05, 0.28, LIGHT); },
  scmd: (x, c) => { star(x, 5, 1.0, 0.46, c); arc(x, 0, 0.05, 0.38, 0, 6.2832, LIGHT, 0.1); },
  eng: (x, c) => {
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; line(x, Math.cos(a) * 0.55, Math.sin(a) * 0.55, Math.cos(a) * 0.93, Math.sin(a) * 0.93, c, 0.3); }
    disc(x, 0, 0, 0.68, c); disc(x, 0, 0, 0.25, DARK);
  },
  bot: (x, c) => {
    line(x, -0.35, 0.3, -0.55, 0.95, shade(c, 0.6), 0.28); line(x, 0.35, 0.3, 0.55, 0.95, shade(c, 0.6), 0.28);
    line(x, -0.55, -0.1, -0.85, 0.35, shade(c, 0.6), 0.2); line(x, 0.55, -0.1, 0.85, 0.35, shade(c, 0.6), 0.2);
    box(x, 0, 0, 1.0, 1.0, c); disc(x, 0, -0.45, 0.28, LIGHT);
  },
  tank: (x, c) => { tankBase(x, c); disc(x, 0, 0.1, 0.42, shade(c, 1.2)); line(x, 0, 0.1, 0, -1.05, DARK, 0.2); },
  arty: (x, c) => { tankBase(x, c); box(x, 0, 0.25, 0.6, 0.6, shade(c, 1.2)); line(x, 0, 0.15, 0.35, -1.0, DARK, 0.24); },
  aa: (x, c) => { tankBase(x, c); disc(x, 0, 0.15, 0.38, shade(c, 1.2)); line(x, -0.12, 0.1, -0.5, -0.95, DARK, 0.15); line(x, 0.12, 0.1, 0.5, -0.95, DARK, 0.15); },
  aa_s: (x, c) => { disc(x, 0, 0.35, 0.72, shade(c, 0.7)); disc(x, 0, 0.3, 0.45, c); line(x, -0.14, 0.2, -0.6, -0.9, DARK, 0.17); line(x, 0.14, 0.2, 0.6, -0.9, DARK, 0.17); },
  scout: (x, c) => { shape(x, [[0, -1], [0.7, 0], [0, 1], [-0.7, 0]], c); disc(x, 0, 0, 0.26, LIGHT); },
  fighter: (x, c) => { shape(x, [[0, -1], [0.22, -0.4], [0.95, 0.45], [0.92, 0.75], [0.2, 0.5], [0.12, 0.92], [-0.12, 0.92], [-0.2, 0.5], [-0.92, 0.75], [-0.95, 0.45], [-0.22, -0.4]], c); },
  bomber: (x, c) => {
    shape(x, [[0, -1], [0.3, -0.5], [1.0, 0.2], [1.0, 0.6], [0.28, 0.4], [0.18, 0.95], [-0.18, 0.95], [-0.28, 0.4], [-1.0, 0.6], [-1.0, 0.2], [-0.3, -0.5]], c);
    disc(x, -0.5, 0.2, 0.17, DARK); disc(x, 0.5, 0.2, 0.17, DARK);
  },
  gunship: (x, c) => {
    line(x, 0.1, 0.55, 0, 1.0, shade(c, 0.6), 0.14);
    shape(x, [[0, -0.7], [0.4, -0.2], [0.35, 0.5], [0, 0.75], [-0.35, 0.5], [-0.4, -0.2]], c);
    line(x, -0.95, -0.55, 0.95, 0.55, LIGHT, 0.1); line(x, 0.95, -0.55, -0.95, 0.55, LIGHT, 0.1);
  },
  transport: (x, c) => { shape(x, [[0, -1], [0.3, -0.5], [1.0, 0.1], [1.0, 0.45], [0.3, 0.35], [0.22, 0.95], [-0.22, 0.95], [-0.3, 0.35], [-1.0, 0.45], [-1.0, 0.1], [-0.3, -0.5]], c); box(x, 0, 0.1, 0.5, 0.6, shade(c, 0.6)); },
  frigate: (x, c) => ship(x, c, 0.42, 0.95, [[-0.25, 0.2]]),
  destroyer: (x, c) => ship(x, c, 0.48, 1.0, [[-0.4, 0.2], [0.3, 0.2]]),
  cruiser: (x, c) => { ship(x, c, 0.5, 1.0, [[-0.4, 0.2], [0.55, 0.2]]); box(x, 0, 0.1, 0.3, 0.3, DARK); },
  battleship: (x, c) => ship(x, c, 0.58, 1.05, [[-0.5, 0.25], [-0.05, 0.25], [0.5, 0.25]]),
  sub: (x, c) => {
    x.beginPath(); x.ellipse(0, 0, 0.42, 1.0, 0, 0, 6.2832); x.fillStyle = c; x.fill(); x.lineWidth = 0.09; x.strokeStyle = DARK; x.stroke();
    box(x, 0, -0.1, 0.22, 0.5, shade(c, 0.7)); line(x, 0, 0.8, 0, 1.05, DARK, 0.2);
  },
  exp: (x, c) => {
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + Math.PI / 6; line(x, Math.cos(a) * 0.4, Math.sin(a) * 0.4, Math.cos(a) * 1.0, Math.sin(a) * 1.0, c, 0.26); }
    shape(x, [0, 1, 2, 3, 4, 5].map(i => { const a = i * Math.PI / 3; return [Math.cos(a) * 0.72, Math.sin(a) * 0.72]; }), c); disc(x, 0, 0, 0.32, LIGHT);
  },
  mex: (x, c) => { box(x, 0, 0.7, 1.5, 0.5, shade(c, 0.7)); shape(x, [[-0.55, -0.95], [0.55, -0.95], [0.55, -0.4], [0, 0.35], [-0.55, -0.4]], c); line(x, 0, -0.9, 0, 0.3, LIGHT, 0.1); },
  mfab: (x, c) => { disc(x, 0, 0, 0.85, shade(c, 0.6)); arc(x, 0, 0, 0.6, 0.4, 5.2, c, 0.28); shape(x, [[0.5, -0.78], [0.95, -0.2], [0.2, -0.25]], c); disc(x, 0, 0, 0.2, LIGHT); },
  pgen: (x, c) => { box(x, 0, 0, 1.8, 1.8, shade(c, 0.55)); shape(x, [[0.22, -0.95], [-0.55, 0.12], [-0.06, 0.12], [-0.25, 0.95], [0.58, -0.2], [0.08, -0.2]], c); },
  store: (x, c) => { box(x, 0, 0, 1.7, 1.5, c); for (const y of [-0.4, 0, 0.4]) line(x, -0.65, y, 0.65, y, DARK, 0.1); },
  fac_land: (x, c) => factory(x, c, g => disc(g, 0, 0.5, 0.26, DARK)),
  fac_air: (x, c) => factory(x, c, g => shape(g, [[0, 0.1], [0.35, 0.8], [-0.35, 0.8]], DARK)),
  fac_naval: (x, c) => factory(x, c, g => { arc(g, -0.3, 0.55, 0.2, Math.PI, 0, DARK, 0.1); arc(g, 0.1, 0.55, 0.2, Math.PI, 0, DARK, 0.1); arc(g, 0.5, 0.55, 0.2, Math.PI, 0, DARK, 0.1); }),
  pd: (x, c) => { disc(x, 0, 0.1, 0.85, shade(c, 0.6)); box(x, 0, 0.05, 0.7, 0.7, c); line(x, -0.14, 0, -0.14, -1, DARK, 0.17); line(x, 0.14, 0, 0.14, -1, DARK, 0.17); },
  torp: (x, c) => { disc(x, 0, 0, 0.85, shade(c, 0.6)); for (const y of [-0.35, 0, 0.35]) arc(x, 0, y + 0.4, 0.45, Math.PI * 1.15, Math.PI * 1.85, c, 0.14); shape(x, [[0, -0.9], [0.18, -0.4], [-0.18, -0.4]], c); },
  radar: (x, c) => {
    box(x, 0, 0.85, 1.1, 0.3, shade(c, 0.6)); line(x, 0, 0.75, 0, 0.2, c, 0.2);
    x.beginPath(); x.arc(0, 0.1, 0.55, Math.PI * 0.05, Math.PI * 0.95); x.closePath(); x.fillStyle = c; x.fill(); x.lineWidth = 0.09; x.strokeStyle = DARK; x.stroke();
    arc(x, 0, -0.1, 0.8, -2.3, -0.85, LIGHT, 0.1); arc(x, 0, -0.1, 1.05, -2.3, -0.85, LIGHT, 0.1);
  },
  shield: (x, c) => { dome(x, c); arc(x, 0, 0.5, 0.62, Math.PI * 1.1, Math.PI * 1.8, LIGHT, 0.1); line(x, -1, 0.5, 1, 0.5, DARK, 0.14); box(x, 0, 0.75, 0.7, 0.35, shade(c, 0.6)); },
  arty_s: (x, c) => { disc(x, 0, 0.35, 0.78, shade(c, 0.6)); box(x, 0, 0.4, 0.8, 0.8, c); line(x, 0, 0.3, 0.45, -1.0, DARK, 0.3); },
  tml: (x, c) => { box(x, 0, 0.55, 1.5, 0.7, shade(c, 0.6)); missile(x, 0, -0.1, 0.8, c, 'rgba(255,208,96,1)'); },
  tmd: (x, c) => { disc(x, 0, 0, 0.8, shade(c, 0.5)); arc(x, 0, 0, 0.6, 0, 6.2832, c, 0.14); line(x, -1, 0, 1, 0, c, 0.12); line(x, 0, -1, 0, 1, c, 0.12); disc(x, 0, 0, 0.14, LIGHT); },
  nuke: (x, c) => { box(x, 0, 0.8, 1.6, 0.4, shade(c, 0.6)); missile(x, 0, -0.05, 0.85, c); disc(x, 0, -0.1, 0.2, '#ff6a3c'); },
  antinuke: (x, c) => { box(x, 0, 0.8, 1.6, 0.4, shade(c, 0.6)); missile(x, 0, 0.05, 0.75, c); arc(x, 0, -0.35, 0.85, Math.PI * 1.15, Math.PI * 1.85, '#5fe8ff', 0.16); },
  plus: (x, c) => { box(x, 0, 0, 0.5, 1.7, c); box(x, 0, 0, 1.7, 0.5, c); },
  default: (x, c) => { box(x, 0, 0, 1.4, 1.4, c); disc(x, 0, 0, 0.3, LIGHT); },
};

export function iconSprite(icon, color, struct) {
  const key = icon + '|' + color + '|' + (struct ? 1 : 0);
  let c = cache.get(key);
  if (c) return c;
  c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d');
  x.translate(S / 2, S / 2); x.scale(S / 2.45, S / 2.45); x.lineJoin = 'round'; x.lineCap = 'round';
  (DRAW[icon] || DRAW.default)(x, color || '#8fb4cc', struct);
  cache.set(key, c);
  return c;
}
