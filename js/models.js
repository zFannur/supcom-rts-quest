// Procedural low-poly 3D models for every unit & structure.
// Each model = merged "body" geometry (vertex colours, team-tinted) + optional glow geometry
// + turret sub-meshes (pivot per weapon) + animated parts (legs, rotors, dishes).
// Model space: +X forward, +Y up, sizes in world units.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { LITE } from './quest.js';

export const GLB = {};
// Blender-модели: tools/blender/defs/*.py → assets/models/<ключ>.glb. Нет файла — остаётся процедурная модель ниже
// (она же всегда даёт meta: высоту, плавучесть и т.п.).
// В LITE (Quest) каталог зависит от пресета качества VR (settings.vrQuality): low = models_q (256 px WebP), med/high = models_ktx (512 px KTX2/Basis,
// tools/quest_ktx.py; ~1 Б/пиксель в видеопамяти, то есть как 256 px RGBA). Нет каталога или KTX2 — берётся другой (в dist при наличии KTX остаётся только он:
// тогда low грузит те же KTX2 и отбрасывает верхний мип, получая 256 px).
export const VR_QUALITY = ['low', 'med', 'high'];
let quality = 'med';
try { const q = JSON.parse(localStorage.getItem('supcom3d_settings') || '{}').vrQuality; if (VR_QUALITY.includes(q)) quality = q; } catch (e) { /* ignore */ }
export const modelQuality = () => quality;
let ktx2Loader = null;
const getKTX2 = () => ktx2Loader || (ktx2Loader = makeKTX2());
async function makeKTX2() {   // KTX2Loader.detectSupport wants a renderer, but the game renderer does not exist yet: probe extensions on a throwaway context
  const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');   // only in LITE: the PC build never loads it
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = { has: (n) => !!gl?.getExtension(n) };
  const l = new KTX2Loader().setTranscoderPath('vendor/three/examples/jsm/libs/basis/').setWorkerLimit(2);
  l.detectSupport({ extensions: ext, capabilities: {} });
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return l;
}
function dropTopMip(g) {   // KTX2 512 px -> 256 px for the Low preset: drop mip level 0 (the transcoded levels are uploaded as-is)
  g.scene.traverse(o => {
    for (const m of [].concat(o.material || [])) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
      const t = m[k]; if (!t?.isCompressedTexture || t.userData.mipDropped || t.mipmaps.length < 2) continue;
      t.mipmaps = t.mipmaps.slice(1); t.image = { width: t.mipmaps[0].width, height: t.mipmaps[0].height }; t.userData.mipDropped = true;
    }
  });
}
function disposeTextures(g) {
  g.scene.traverse(o => { for (const m of [].concat(o.material || [])) for (const k in m) if (m[k]?.isTexture) m[k].dispose(); });
}
// Texture memory estimate (bytes) of every loaded GLB: KTX2 ~1 B/px (ASTC/ETC2), other textures RGBA8; each with the full mip chain (x4/3).
export function glbTextureBytes() {
  const seen = new Set(); let b = 0, n = 0;
  for (const k in GLB) GLB[k].scene.traverse(o => { for (const m of [].concat(o.material || [])) for (const t of Object.values(m)) {
    if (!t?.isTexture || seen.has(t)) continue; seen.add(t); n++;
    const w = t.mipmaps?.[0]?.width || t.image?.width || 0, h = t.mipmaps?.[0]?.height || t.image?.height || 0;
    b += w * h * (t.isCompressedTexture ? 1 : 4) * 4 / 3;
  } });
  return { textures: n, bytes: b };
}
export async function loadGLB() {
  const dirs = !LITE ? ['models'] : quality === 'low' ? ['models_q', 'models_ktx'] : ['models_ktx', 'models_q'];
  const old = Object.values(GLB).slice();
  const one = async (k) => {
    let err;
    for (const d of dirs) {
      try {
        const loader = new GLTFLoader();
        if (d === 'models_ktx') loader.setKTX2Loader(await getKTX2());
        const g = await loader.loadAsync(`assets/${d}/${k}.glb`);
        if (d === 'models_ktx' && quality === 'low') dropTopMip(g);
        // экспортёр пишет все кости в каждый клип — оставляем только реально анимированные треки,
        // иначе клипы гасят друг друга при смешивании, а кость 'aim' (поворот торса игрой) перезаписывается
        for (const c of g.animations) c.tracks = c.tracks.filter(t => {
          const v = t.values, n = v.length / t.times.length;
          for (let i = n; i < v.length; i++) if (Math.abs(v[i] - v[i % n]) > 1e-4) return true;
          return false;
        });
        GLB[k] = g; return;
      } catch (e) { err = e; }
    }
    console.warn('GLB model', k, err?.message);
  };
  await Promise.all(MODEL_KEYS.filter(k => k !== 'factory' && !PROC_ONLY.has(k)).map(one));
  for (const g of old) disposeTextures(g);   // старый набор текстур уходит из видеопамяти (живые виды перезальют свои при следующей отрисовке)
}
// VR-меню: смена пресета качества, модели перезагружаются сразу.
export async function setModelQuality(q) {
  if (!VR_QUALITY.includes(q) || q === quality) return;
  quality = q;
  if (LITE) await loadGLB();
}

const C = {
  dark: 0x2a2f36, metal: 0x7d8792, steel: 0x9aa3ad, light: 0xc9d0d8, tread: 0x1c1e22, glass: 0x9fd8ff,
  black: 0x121417, hazard: 0xe0a020, concrete: 0x6b6f72, pad: 0x4a4f55, water: 0x2a5a7a, rust: 0x6a4a3a
};

class Builder {
  constructor(team) { this.team = new THREE.Color(team); this.teamDark = this.team.clone().multiplyScalar(0.55); this.groups = {}; }
  col(c) {
    if (c === 'team') return this.team;
    if (c === 'teamDark') return this.teamDark;
    return new THREE.Color(typeof c === 'string' ? C[c] : c);
  }
  add(group, geom, color, pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1]) {
    const g = geom.index ? geom.toNonIndexed() : geom.clone();
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...scl));
    g.applyMatrix4(m);
    const c = this.col(color);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    // subtle per-face shading variation for a "panelled" look
    for (let i = 0; i < n; i++) { const k = 0.92 + ((i / 3 | 0) % 3) * 0.04; arr[i * 3] = c.r * k; arr[i * 3 + 1] = c.g * k; arr[i * 3 + 2] = c.b * k; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    if (g.attributes.uv) g.deleteAttribute('uv');
    (this.groups[group] = this.groups[group] || []).push(g);
    return this;
  }
  box(group, w, h, d, color, pos, rot) { return this.add(group, new THREE.BoxGeometry(w, h, d), color, pos, rot); }
  cyl(group, rt, rb, h, color, pos, rot, seg = 10) { return this.add(group, new THREE.CylinderGeometry(rt, rb, h, seg), color, pos, rot); }
  sph(group, r, color, pos, scl, seg = 10) { return this.add(group, new THREE.SphereGeometry(r, seg, Math.max(6, seg * 0.7 | 0)), color, pos, [0, 0, 0], scl); }
  cone(group, r, h, color, pos, rot, seg = 8) { return this.add(group, new THREE.ConeGeometry(r, h, seg), color, pos, rot); }
  // barrel along +X starting at x0
  barrel(group, r, len, color, pos, pitch = 0) {
    const [x, y, z] = pos;
    return this.add(group, new THREE.CylinderGeometry(r, r, len, 8), color, [x + Math.cos(pitch) * len / 2, y + Math.sin(pitch) * len / 2, z], [0, 0, -Math.PI / 2 + pitch]);
  }
  build() {
    const out = {};
    for (const [k, list] of Object.entries(this.groups)) out[k] = mergeGeometries(list, false);
    return out;
  }
}

// ---------------------------------------------------------------- helpers for common parts
function tracks(b, len, w, h, gap, y = h / 2) {
  for (const s of [-1, 1]) {
    b.box('body', len, h, w, 'tread', [0, y, s * gap]);
    for (let i = 0; i < 4; i++) b.cyl('body', h * 0.42, h * 0.42, w * 1.05, 'dark', [-len / 2 + len * (i + 0.5) / 4, y - h * 0.1, s * gap], [Math.PI / 2, 0, 0], 8);
  }
}
function legs(b, key, hipY, len, spread, w, col = 'dark') {
  for (const s of [-1, 1]) {
    b.box(key + (s < 0 ? 'L' : 'R'), w, len, w * 1.2, col, [0, -len / 2, 0]);
    b.box(key + (s < 0 ? 'L' : 'R'), w * 1.8, w * 0.5, w * 1.6, 'metal', [w * 0.3, -len + w * 0.25, 0]);
  }
  return { hipY, spread };
}
function hull(b, len, w, h, color, y) {
  // tapered ship hull made of a box + bow wedge
  b.box('body', len * 0.72, h, w, color, [-len * 0.14, y, 0]);
  b.add('body', new THREE.CylinderGeometry(0, w / 2, len * 0.3, 4, 1), color, [len * 0.36, y, 0], [0, 0, -Math.PI / 2], [h / w * 1.4, 1, 1]);
  b.box('body', len * 0.8, h * 0.15, w * 1.02, 'dark', [-len * 0.1, y - h * 0.45, 0]);
}

// ---------------------------------------------------------------- model definitions
// Returned "meta": { turrets: [{pos:[x,y,z]}], legs: {...}, rotors: [...], spin: [...], height }
const DEFS = {
  acu(b) {
    b.box('body', 2.2, 1.6, 3, 'team', [0, 5.4, 0]);            // torso
    b.box('body', 1.6, 1.0, 2.2, 'dark', [-0.2, 4.2, 0]);        // waist
    b.box('body', 1.4, 1.1, 2.2, 'metal', [-1.3, 5.6, 0]);       // backpack
    b.cyl('body', 0.35, 0.35, 1.2, 'dark', [-1.9, 6.3, 0.6], [0, 0, 0]);
    b.cyl('body', 0.35, 0.35, 1.2, 'dark', [-1.9, 6.3, -0.6]);
    b.box('body', 1.0, 0.8, 1.0, 'steel', [0.4, 6.5, 0]);        // head
    b.box('glow', 0.2, 0.18, 0.8, 0x7fe7ff, [0.92, 6.55, 0]);    // visor
    b.box('body', 0.9, 0.9, 0.9, 'teamDark', [0, 5.8, 1.9]);     // shoulders
    b.box('body', 0.9, 0.9, 0.9, 'teamDark', [0, 5.8, -1.9]);
    b.box('body', 1.8, 0.6, 0.6, 'dark', [0.8, 4.9, -2.0]);       // left arm (builder)
    b.cyl('glow', 0.18, 0.28, 0.4, 0x6cff9a, [1.8, 4.9, -2.0], [0, 0, -Math.PI / 2]);
    b.box('t0', 1.2, 0.8, 0.8, 'dark', [0.3, 0, 0]);             // gun arm (turret 0)
    b.barrel('t0', 0.25, 2.2, 'black', [0.8, 0, 0]);
    b.cyl('glowt0', 0.28, 0.28, 0.12, 0x8fe0ff, [3.0, 0, 0], [0, 0, Math.PI / 2]);
    const L = legs(b, 'leg', 3.9, 3.8, 1.0, 0.7);
    return { turrets: [{ pos: [0.5, 4.9, 2.0] }], legs: { hipY: 3.9, spread: 1.0, stride: 0.45 }, height: 7 };
  },
  // Support commander (Blender model assets/models/sacu.glb, ~0.85x the ACU): the procedural ACU is only the fallback.
  sacu(b) { return { ...DEFS.acu(b), height: 6.1 }; },
  eng1(b, tier = 1) {
    const s = 1 + (tier - 1) * 0.2;
    tracks(b, 2.4 * s, 0.5 * s, 0.6 * s, 0.75 * s);
    b.box('body', 1.9 * s, 0.7 * s, 1.3 * s, 'team', [0, 0.85 * s, 0]);
    b.box('body', 0.8 * s, 0.6 * s, 1.0 * s, 'hazard', [-0.4 * s, 1.45 * s, 0]);
    b.box('body', 1.6 * s, 0.25 * s, 0.25 * s, 'steel', [0.6 * s, 1.55 * s, 0], [0, 0, 0.4]);
    b.cyl('glow', 0.12 * s, 0.22 * s, 0.35 * s, 0x6cff9a, [1.35 * s, 1.85 * s, 0], [0, 0, -Math.PI / 2]);
    if (tier >= 2) b.box('body', 0.5, 0.5, 0.5, 'teamDark', [-0.9 * s, 1.3 * s, 0.5 * s]);
    if (tier >= 3) b.box('glow', 0.2, 0.2, 1.2 * s, 0x6cff9a, [-0.9 * s, 1.1 * s, 0]);
    return { height: 2 * s };
  },
  eng2(b) { return DEFS.eng1(b, 2); },
  eng3(b) { return DEFS.eng1(b, 3); },
  lab(b) {
    b.box('body', 1.1, 0.9, 1.2, 'team', [0, 2.0, 0]);
    b.box('body', 0.6, 0.4, 0.7, 'steel', [0.35, 2.55, 0]);
    b.box('glow', 0.1, 0.12, 0.45, 0xffe070, [0.66, 2.58, 0]);
    b.barrel('body', 0.12, 1.0, 'black', [0.4, 1.9, 0.62]);
    legs(b, 'leg', 1.5, 1.5, 0.4, 0.32);
    return { legs: { hipY: 1.5, spread: 0.4, stride: 0.6 }, height: 2.6 };
  },
  tank1(b) {
    tracks(b, 3.4, 0.6, 0.8, 0.95);
    b.box('body', 3.0, 0.7, 1.7, 'team', [0, 1.05, 0]);
    b.box('body', 0.8, 0.5, 1.5, 'teamDark', [1.3, 0.95, 0], [0, 0, -0.35]);
    b.box('t0', 1.3, 0.55, 1.1, 'teamDark', [0, 0, 0]);
    b.box('t0', 0.5, 0.3, 0.6, 'steel', [-0.35, 0.4, 0]);
    b.barrel('t0', 0.13, 1.9, 'black', [0.55, 0.05, 0]);
    return { turrets: [{ pos: [-0.1, 1.65, 0] }], height: 2 };
  },
  tank2(b) {
    tracks(b, 4.4, 0.8, 1.0, 1.25);
    b.box('body', 3.9, 0.9, 2.2, 'team', [0, 1.3, 0]);
    b.box('body', 1.0, 0.6, 2.0, 'teamDark', [1.8, 1.2, 0], [0, 0, -0.35]);
    b.box('body', 1.2, 0.5, 1.6, 'metal', [-1.4, 1.9, 0]);
    b.box('t0', 1.8, 0.75, 1.6, 'teamDark', [0, 0, 0]);
    b.barrel('t0', 0.14, 2.4, 'black', [0.7, 0.05, 0.32]);
    b.barrel('t0', 0.14, 2.4, 'black', [0.7, 0.05, -0.32]);
    b.box('glowt0', 0.1, 0.15, 0.6, 0xffc060, [-0.9, 0.2, 0]);
    return { turrets: [{ pos: [0.1, 2.1, 0] }], height: 2.6 };
  },
  arty1(b) {
    tracks(b, 3.0, 0.55, 0.7, 0.85);
    b.box('body', 2.7, 0.6, 1.5, 'team', [0, 0.95, 0]);
    b.box('t0', 1.2, 0.6, 1.0, 'teamDark', [-0.2, 0, 0]);
    b.barrel('t0', 0.16, 3.0, 'black', [0.2, 0.1, 0], 0.45);
    return { turrets: [{ pos: [-0.3, 1.5, 0] }], height: 2 };
  },
  aa1(b) {
    tracks(b, 2.8, 0.55, 0.7, 0.85);
    b.box('body', 2.5, 0.6, 1.5, 'team', [0, 0.95, 0]);
    b.box('t0', 0.8, 0.4, 0.8, 'dark', [0, 0, 0]);
    for (const z of [-0.45, 0.45]) {
      b.box('t0', 1.2, 0.5, 0.35, 'teamDark', [0.1, 0.45, z], [0, 0, 0.6]);
      b.cone('t0', 0.1, 0.35, 'light', [0.62, 0.8, z], [0, 0, -Math.PI / 2 + 0.6]);
    }
    return { turrets: [{ pos: [0, 1.4, 0] }], height: 2.2 };
  },
  mml(b) {
    for (const z of [-0.9, 0.9]) for (const x of [-1.2, 0, 1.2]) b.cyl('body', 0.45, 0.45, 0.35, 'tread', [x, 0.45, z], [Math.PI / 2, 0, 0]);
    b.box('body', 3.6, 0.7, 1.7, 'team', [0, 1.05, 0]);
    b.box('body', 1.0, 0.8, 1.6, 'teamDark', [1.3, 1.6, 0]);
    b.box('glow', 0.08, 0.3, 1.2, 0x9fd8ff, [1.82, 1.7, 0]);
    b.box('t0', 2.0, 0.9, 1.4, 'metal', [-0.3, 0.2, 0], [0, 0, 0.3]);
    for (const z of [-0.35, 0.35]) for (const y of [0.05, 0.4]) b.cyl('t0', 0.15, 0.15, 0.1, 'hazard', [0.66, 0.55 + y, z], [0, 0, Math.PI / 2 - 0.3]);
    return { turrets: [{ pos: [-0.8, 1.6, 0] }], height: 2.6 };
  },
  flak2(b) {
    tracks(b, 3.6, 0.7, 0.9, 1.1);
    b.box('body', 3.3, 0.8, 1.9, 'team', [0, 1.15, 0]);
    b.cyl('t0', 0.9, 1.0, 0.7, 'teamDark', [0, 0.1, 0]);
    b.barrel('t0', 0.12, 2.0, 'black', [0.2, 0.3, 0.3], 0.8);
    b.barrel('t0', 0.12, 2.0, 'black', [0.2, 0.3, -0.3], 0.8);
    b.cyl('t0', 0.6, 0.6, 0.08, 'light', [-0.6, 0.9, 0], [0, 0, 0.4]);
    return { turrets: [{ pos: [0, 1.9, 0] }], height: 2.8 };
  },
  siege(b) {
    b.box('body', 3.2, 2.4, 4.2, 'team', [0, 7.0, 0]);
    b.box('body', 2.4, 1.2, 3.2, 'dark', [-0.2, 5.4, 0]);
    b.box('body', 1.4, 1.2, 1.4, 'steel', [0.9, 8.6, 0]);
    b.box('glow', 0.15, 0.3, 1.0, 0x7fe7ff, [1.62, 8.7, 0]);
    b.box('body', 1.4, 1.4, 1.4, 'teamDark', [0, 7.6, 2.8]);
    b.box('body', 1.4, 1.4, 1.4, 'teamDark', [0, 7.6, -2.8]);
    b.box('body', 2.0, 1.6, 2.0, 'metal', [-2.0, 7.6, 0]);
    b.box('t0', 2.4, 1.4, 1.4, 'dark', [0.3, 0, 0]);
    b.barrel('t0', 0.4, 4.2, 'black', [1.2, 0, 0]);
    b.cyl('glowt0', 0.42, 0.42, 0.2, 0x9fdcff, [5.4, 0, 0], [0, 0, Math.PI / 2]);
    legs(b, 'leg', 5.0, 5.0, 1.5, 1.1);
    return { turrets: [{ pos: [0.4, 6.8, -3.0] }], legs: { hipY: 5.0, spread: 1.5, stride: 0.4 }, height: 9.5 };
  },
  arty3(b) {
    for (const z of [-1.3, 1.3]) for (const x of [-1.8, -0.4, 1.0]) b.cyl('body', 0.65, 0.65, 0.5, 'tread', [x, 0.65, z], [Math.PI / 2, 0, 0]);
    b.box('body', 5.2, 1.0, 2.4, 'team', [0, 1.5, 0]);
    b.box('body', 1.2, 1.0, 2.2, 'teamDark', [2.0, 2.3, 0]);
    b.box('t0', 2.4, 1.3, 2.0, 'teamDark', [-0.4, 0, 0]);
    b.barrel('t0', 0.32, 5.2, 'black', [0.4, 0.2, 0], 0.4);
    b.cyl('t0', 0.45, 0.45, 0.8, 'dark', [0.7, 0.35, 0], [0, 0, Math.PI / 2 - 0.4]);
    return { turrets: [{ pos: [-0.8, 2.6, 0] }], height: 3.6 };
  },
  scout_air(b) {
    b.cone('body', 0.35, 2.4, 'team', [0.3, 0, 0], [0, 0, -Math.PI / 2]);
    b.box('body', 0.9, 0.08, 2.6, 'teamDark', [-0.4, 0, 0]);
    b.box('body', 0.5, 0.5, 0.06, 'dark', [-0.8, 0.25, 0]);
    b.sph('glow', 0.14, 0x9fd8ff, [-0.95, 0, 0]);
    return { height: 0.6, air: true };
  },
  int1(b) {
    b.cone('body', 0.45, 3.2, 'team', [0.5, 0, 0], [0, 0, -Math.PI / 2]);
    b.add('body', new THREE.CylinderGeometry(0, 1.7, 2.2, 4), 'teamDark', [-0.4, 0, 0], [Math.PI / 2, 0, -Math.PI / 2], [1, 1, 0.06]);
    b.box('body', 0.6, 0.7, 0.06, 'dark', [-1.1, 0.35, 0.35], [0.3, 0, 0]);
    b.box('body', 0.6, 0.7, 0.06, 'dark', [-1.1, 0.35, -0.35], [-0.3, 0, 0]);
    b.sph('body', 0.22, 'glass', [0.6, 0.25, 0], [1.6, 0.8, 0.8]);
    b.sph('glow', 0.2, 0xffa050, [-1.25, 0, 0]);
    return { height: 0.8, air: true };
  },
  bomb1(b) {
    b.cyl('body', 0.5, 0.45, 3.6, 'team', [0, 0, 0], [0, 0, -Math.PI / 2]);
    b.cone('body', 0.5, 0.8, 'teamDark', [2.2, 0, 0], [0, 0, -Math.PI / 2]);
    b.box('body', 1.3, 0.1, 5.2, 'teamDark', [0, 0, 0]);
    b.box('body', 0.7, 0.1, 2.0, 'dark', [-1.6, 0.1, 0]);
    b.box('body', 0.7, 0.8, 0.08, 'dark', [-1.6, 0.45, 0]);
    for (const z of [-1.5, 1.5]) { b.cyl('body', 0.24, 0.24, 1.0, 'dark', [0.2, -0.15, z], [0, 0, Math.PI / 2]); b.sph('glow', 0.18, 0xffa050, [-0.35, -0.15, z]); }
    return { height: 1, air: true };
  },
  gunship(b) {
    b.box('body', 3.2, 1.0, 1.4, 'team', [0, 0, 0]);
    b.cone('body', 0.7, 1.1, 'teamDark', [2.1, -0.1, 0], [0, 0, -Math.PI / 2]);
    b.box('body', 0.5, 0.25, 4.2, 'dark', [0, 0.2, 0]);
    b.box('body', 1.8, 0.3, 0.3, 'dark', [-2.2, 0.1, 0]);
    b.sph('body', 0.4, 'glass', [1.4, 0.35, 0], [1.4, 0.8, 1]);
    b.barrel('t0', 0.1, 1.2, 'black', [0, 0, 0.18]);
    b.barrel('t0', 0.1, 1.2, 'black', [0, 0, -0.18]);
    for (const z of [-2.1, 2.1]) b.cyl('body', 0.35, 0.35, 0.5, 'metal', [0, 0.3, z]);
    b.add('rotor0', new THREE.CylinderGeometry(1.6, 1.6, 0.03, 18), 0xb8c4cc, [0, 0, 0]);
    b.add('rotor1', new THREE.CylinderGeometry(1.6, 1.6, 0.03, 18), 0xb8c4cc, [0, 0, 0]);
    return { turrets: [{ pos: [1.6, -0.55, 0] }], rotors: [[0, 0.6, 2.1], [0, 0.6, -2.1]], height: 1.2, air: true };
  },
  asf(b) {
    b.cone('body', 0.55, 4.0, 'team', [0.6, 0, 0], [0, 0, -Math.PI / 2]);
    b.add('body', new THREE.CylinderGeometry(0, 2.2, 2.8, 4), 'teamDark', [-0.6, 0, 0], [Math.PI / 2, 0, -Math.PI / 2], [1, 1, 0.05]);
    b.box('body', 0.8, 0.12, 1.4, 'dark', [1.4, 0, 0]);
    for (const z of [-0.4, 0.4]) { b.box('body', 0.8, 0.9, 0.06, 'dark', [-1.5, 0.45, z], [z * 0.8, 0, 0]); b.sph('glow', 0.22, 0x7fc8ff, [-1.65, 0, z * 0.8]); }
    b.sph('body', 0.25, 'glass', [0.9, 0.3, 0], [1.8, 0.8, 0.8]);
    return { height: 0.9, air: true };
  },
  strat(b) {
    b.add('body', new THREE.CylinderGeometry(0, 4.8, 5.2, 4), 'team', [0, 0, 0], [Math.PI / 2, 0, -Math.PI / 2], [1, 1, 0.12]);
    b.add('body', new THREE.CylinderGeometry(0, 3.6, 3.6, 4), 'dark', [-0.8, 0.2, 0], [Math.PI / 2, 0, -Math.PI / 2], [1, 1, 0.08]);
    b.sph('body', 0.6, 'glass', [1.4, 0.4, 0], [2, 0.6, 1]);
    for (const z of [-1.4, -0.5, 0.5, 1.4]) b.sph('glow', 0.25, 0xffa050, [-2.3, 0, z]);
    return { height: 1.2, air: true };
  },
  trans1(b, big = false) {
    const k = big ? 1.4 : 1;
    b.box('body', 5.4 * k, 1.3 * k, 1.8 * k, 'team', [0, 0, 0]);
    b.cone('body', 0.9 * k, 1.4 * k, 'teamDark', [3.4 * k, -0.1, 0], [0, 0, -Math.PI / 2]);
    b.sph('body', 0.55 * k, 'glass', [2.4 * k, 0.45 * k, 0], [1.4, 0.7, 1]);
    b.box('body', 3.6 * k, 0.5 * k, 2.4 * k, 'dark', [-0.3 * k, -0.85 * k, 0]);          // cargo bay
    b.box('body', 1.6 * k, 0.9 * k, 0.12, 'dark', [-3.0 * k, 0.6 * k, 0]);
    const rot = big ? [[2.2, 0.9, 2.6], [2.2, 0.9, -2.6], [-2.2, 0.9, 2.6], [-2.2, 0.9, -2.6]] : [[1.6, 0.8, 1.9], [-1.6, 0.8, -1.9]];
    rot.forEach((p, i) => { b.cyl('body', 0.35, 0.35, 0.6, 'metal', [p[0], p[1] - 0.3, p[2]]); b.box('body', 0.3, 0.2, Math.abs(p[2]), 'dark', [p[0], p[1] - 0.4, p[2] / 2]); b.add('rotor' + i, new THREE.CylinderGeometry(1.8 * k, 1.8 * k, 0.03, 18), 0xb8c4cc, [0, 0, 0]); });
    b.sph('glow', 0.2, 0xff4040, [-3.2 * k, 1.1 * k, 0]);
    return { rotors: rot, height: 1.6 * k, air: true };
  },
  trans2(b) { return DEFS.trans1(b, true); },
  frigate(b) {
    hull(b, 7.5, 2.0, 1.2, 'team', 0.2);
    b.box('body', 2.2, 1.2, 1.4, 'light', [-1.0, 1.3, 0]);
    b.box('body', 1.0, 0.8, 1.0, 'steel', [-1.3, 2.3, 0]);
    b.cyl('body', 0.08, 0.08, 2.2, 'dark', [-1.3, 3.6, 0]);
    b.box('body', 0.1, 0.4, 1.2, 'metal', [-1.3, 4.3, 0]);
    b.box('glow', 0.3, 0.15, 0.3, 0xff4040, [-1.3, 4.7, 0]);
    b.cyl('t0', 0.55, 0.65, 0.5, 'teamDark', [0, 0, 0]);
    b.barrel('t0', 0.12, 1.6, 'black', [0.3, 0.1, 0]);
    b.box('body', 0.8, 0.5, 0.8, 'dark', [-2.8, 1.0, 0]);
    return { turrets: [{ pos: [1.6, 1.05, 0] }], height: 2, naval: true };
  },
  sub(b) {
    b.cyl('body', 0.7, 0.7, 5.2, 'dark', [0, 0, 0], [0, 0, Math.PI / 2], 12);
    b.sph('body', 0.7, 'dark', [2.6, 0, 0], [1.4, 1, 1], 12);
    b.sph('body', 0.7, 'dark', [-2.6, 0, 0], [1.2, 1, 1], 12);
    b.box('body', 1.1, 1.0, 0.45, 'team', [0.6, 0.9, 0]);
    b.box('body', 0.2, 0.9, 1.6, 'dark', [-3.1, 0, 0]);
    b.box('glow', 0.1, 0.1, 0.3, 0x70f0ff, [1.16, 1.2, 0]);
    return { height: 1.4, naval: true };
  },
  destroyer(b) {
    hull(b, 11, 2.8, 1.6, 'team', 0.3);
    b.box('body', 3.2, 1.6, 2.0, 'light', [-1.2, 1.8, 0]);
    b.box('body', 1.6, 1.2, 1.6, 'steel', [-1.0, 3.1, 0]);
    b.cyl('body', 0.1, 0.1, 3.0, 'dark', [-1.4, 4.8, 0]);
    b.cyl('body', 0.5, 0.5, 0.1, 'metal', [-1.4, 6.0, 0], [0.3, 0, 0]);
    b.cyl('body', 0.45, 0.5, 1.2, 'dark', [-3.5, 2.0, 0]);
    b.cyl('t0', 0.8, 0.9, 0.6, 'teamDark', [0, 0, 0]);
    b.barrel('t0', 0.15, 2.2, 'black', [0.4, 0.1, 0.22]);
    b.barrel('t0', 0.15, 2.2, 'black', [0.4, 0.1, -0.22]);
    b.box('glow', 0.3, 0.12, 0.3, 0xff4040, [-1.4, 6.3, 0]);
    return { turrets: [{ pos: [2.8, 1.35, 0] }], height: 3, naval: true };
  },
  cruiser(b) {
    hull(b, 10, 2.6, 1.5, 'team', 0.3);
    b.box('body', 3.6, 1.5, 1.9, 'light', [-0.8, 1.7, 0]);
    b.box('body', 1.4, 1.4, 1.4, 'steel', [-0.5, 3.1, 0]);
    b.cyl('body', 0.9, 0.9, 0.1, 'metal', [-0.5, 4.3, 0], [0.4, 0, 0], 16);
    for (const x of [2.4, -3.3]) b.box('body', 1.3, 0.6, 1.6, 'teamDark', [x, 1.25, 0]);
    for (const x of [2.1, 2.7, -3.6, -3.0]) for (const z of [-0.4, 0.4]) b.cyl('body', 0.14, 0.14, 0.1, 'hazard', [x, 1.6, z]);
    b.box('glow', 0.3, 0.12, 0.3, 0x40ff80, [-0.5, 4.6, 0]);
    return { height: 3, naval: true };
  },
  battleship(b) {
    hull(b, 20, 4.6, 2.4, 'team', 0.5);
    b.box('body', 5, 2.0, 3.2, 'light', [-1.0, 2.6, 0]);
    b.box('body', 3, 2.2, 2.6, 'steel', [-0.6, 4.6, 0]);
    b.box('body', 1.6, 1.2, 1.8, 'steel', [-0.4, 6.2, 0]);
    b.cyl('body', 0.14, 0.14, 4, 'dark', [-0.6, 8.6, 0]);
    b.cyl('body', 0.8, 0.9, 2.4, 'dark', [-4.2, 3.2, 0]);
    b.box('glow', 0.4, 0.15, 0.4, 0xff4040, [-0.6, 10.6, 0]);
    for (let i = 0; i < 3; i++) {
      const k = 't' + i;
      b.cyl(k, 1.3, 1.5, 0.9, 'teamDark', [0, 0, 0], [0, 0, 0], 12);
      b.box(k, 1.2, 0.8, 2.0, 'teamDark', [0.6, 0.1, 0]);
      for (const z of [-0.55, 0, 0.55]) b.barrel(k, 0.18, 3.6, 'black', [1.0, 0.2, z], 0.08);
    }
    return { turrets: [{ pos: [5.2, 1.9, 0] }, { pos: [2.4, 2.4, 0] }, { pos: [-6.2, 1.9, 0] }], height: 5, naval: true };
  },
  seadragon(b) {
    hull(b, 22, 3.6, 2.6, 'team', 0.5);
    b.box('body', 4.2, 2.2, 2.8, 'steel', [2.6, 3.4, 0]);
    b.box('body', 7.2, 1.3, 0.4, 'teamDark', [-6.7, 3.2, 1.6]); b.box('body', 7.2, 1.3, 0.4, 'teamDark', [-6.7, 3.2, -1.6]);
    for (const z of [-4.6, 4.6]) { b.box('body', 13, 1.8, 1.5, 'steel', [-1.0, 0.5, z]); b.box('body', 3.5, 0.5, 3.2, 'dark', [-5.8, 1.4, z * 0.5]); b.box('body', 3.5, 0.5, 3.2, 'dark', [2.0, 1.4, z * 0.5]); b.cyl('body', 1.9, 1.9, 0.5, 'dark', [-8.0, 2.7, z], [0, 0, Math.PI / 2], 16); }
    b.box('glow', 0.4, 0.15, 0.4, 0xff4040, [2.6, 5.6, 0]);
    for (let i = 0; i < 3; i++) { const k = 't' + i; b.box(k, 2.6, 0.5, 2.3, 'teamDark', [0, 0, 0]); for (const z of [-0.6, 0.6]) b.box(k, 2.4, 1.2, 1.0, 'dark', [0.1, 0.9, z], [0, 0, 0.55]); }
    return { turrets: [{ pos: [7.0, 3.4, 0] }, { pos: [0.4, 2.7, 3.3] }, { pos: [0.4, 2.7, -3.3] }], height: 6, naval: true };
  },
  colossus(b) {
    b.box('body', 5, 5, 7, 'team', [0, 17, 0]);
    b.box('body', 4, 3, 5, 'dark', [-0.3, 13.5, 0]);
    b.box('body', 3.4, 3, 3.4, 'steel', [0.6, 21, 0]);
    b.box('glow', 0.3, 0.8, 2.4, 0x7fe7ff, [2.35, 21.3, 0]);
    b.box('body', 3.0, 3.0, 3.0, 'teamDark', [0, 18, 5]);
    b.box('body', 3.0, 3.0, 3.0, 'teamDark', [0, 18, -5]);
    b.box('body', 3.6, 1.6, 1.6, 'dark', [1.0, 15.5, -5.2]);
    b.box('body', 3.6, 1.6, 1.6, 'dark', [1.0, 15.5, 5.2]);
    b.box('body', 3, 4, 5, 'metal', [-3.5, 18, 0]);
    for (const z of [-1.4, 1.4]) b.cyl('glow', 0.5, 0.5, 1, 0x7fe7ff, [-5.1, 18, z], [0, 0, Math.PI / 2]);
    b.box('t0', 0.6, 0.6, 0.6, 'dark', [0, 0, 0]);
    b.box('t1', 1.6, 1.2, 1.2, 'dark', [0, 0, 0]);
    b.barrel('t1', 0.25, 2.2, 'black', [0.5, 0, 0.3]);
    b.barrel('t1', 0.25, 2.2, 'black', [0.5, 0, -0.3]);
    legs(b, 'leg', 12, 12, 2.4, 2.2);
    return { turrets: [{ pos: [2.4, 21.3, 0] }, { pos: [0, 20.2, 5] }], legs: { hipY: 12, spread: 2.4, stride: 0.35 }, height: 24 };
  },
  spider(b) {
    b.sph('body', 4.2, 'team', [0, 7.5, 0], [1.5, 0.55, 1.1], 14);          // abdomen
    b.sph('body', 2.6, 'dark', [4.2, 7.2, 0], [1.1, 0.7, 1], 12);            // head
    b.sph('body', 3.0, 'teamDark', [-4.5, 8.2, 0], [1.2, 0.8, 1], 12);
    for (const z of [-0.8, 0.8]) b.sph('glow', 0.45, 0xff5a3c, [6.6, 7.6, z]);
    // six static legs (bent) — the body bobs as it walks
    for (const x of [-3.2, 0, 3.2]) for (const s of [-1, 1]) {
      b.box('body', 1.0, 1.0, 6.5, 'dark', [x, 9.2, s * 5.2], [s * 0.55, 0, 0]);
      b.box('body', 0.9, 8.5, 0.9, 'metal', [x + (x > 0 ? 1 : x < 0 ? -1 : 0), 4.6, s * 8.6], [s * -0.2, 0, 0]);
    }
    b.box('t0', 1.8, 1.4, 1.4, 'dark', [0, 0, 0]);
    b.barrel('t0', 0.5, 3.2, 'black', [0.8, 0, 0]);
    b.cyl('glowt0', 0.55, 0.55, 0.2, 0xff5a3c, [4.1, 0, 0], [0, 0, Math.PI / 2]);
    return { turrets: [{ pos: [5.6, 6.2, 0] }], height: 11, bob: 0.5 };
  },
  fortress(b) {
    for (const s of [-1, 1]) {
      b.box('body', 18, 3.4, 3.6, 'tread', [0, 1.7, s * 6.6]);
      for (let i = 0; i < 6; i++) b.cyl('body', 1.5, 1.5, 3.8, 'dark', [-7.5 + i * 3, 1.5, s * 6.6], [Math.PI / 2, 0, 0], 10);
    }
    b.box('body', 17, 3.2, 10, 'team', [0, 4.8, 0]);
    b.box('body', 12, 2.4, 8, 'teamDark', [-1, 7.6, 0]);
    b.box('body', 4, 3, 4, 'steel', [4.5, 10, 0]);
    b.box('glow', 0.2, 0.6, 3, 0x7fe7ff, [6.55, 10.4, 0]);
    b.cyl('body', 1.6, 2.2, 3, 'metal', [-5, 10, 0], [0, 0, 0], 12);
    b.sph('glow', 1.2, 0x9fdfff, [-5, 12, 0]);
    for (let i = 0; i < 4; i++) {
      const k = 't' + i;
      b.cyl(k, 1.5, 1.7, 1.1, 'teamDark', [0, 0, 0], [0, 0, 0], 12);
      b.barrel(k, 0.26, 4.2, 'black', [0.7, 0.3, 0.45], 0.12); b.barrel(k, 0.26, 4.2, 'black', [0.7, 0.3, -0.45], 0.12);
    }
    return { turrets: [{ pos: [6, 7.1, 3.4] }, { pos: [6, 7.1, -3.4] }, { pos: [-6.5, 7.1, 3.4] }, { pos: [-6.5, 7.1, -3.4] }], height: 12 };
  },
  czar(b) {
    b.add('body', new THREE.CylinderGeometry(12, 13, 2.2, 32), 'team', [0, 0, 0]);
    b.add('body', new THREE.CylinderGeometry(6, 12, 2.4, 32), 'teamDark', [0, 2.2, 0]);
    b.add('body', new THREE.CylinderGeometry(9, 6, 2.0, 32), 'dark', [0, -2.0, 0]);
    b.sph('body', 3.6, 'glass', [0, 3.6, 0], [1, 0.5, 1], 16);
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; b.box('glow', 1.2, 0.3, 0.4, 0x9fe8ff, [Math.cos(a) * 12.6, 0, Math.sin(a) * 12.6], [0, -a, 0]); }
    b.cyl('glow', 2.2, 1.4, 0.5, 0x9fe8ff, [0, -3.1, 0], [0, 0, 0], 20);
    return { height: 5, air: true };
  },

  // ------------------------------------------------------------ structures
  mex(b, tier = 1) {
    const s = 1 + (tier - 1) * 0.25;
    b.cyl('body', 3.0, 3.3, 0.8, 'concrete', [0, 0.4, 0], [0, 0, 0], 8);
    b.cyl('body', 1.8 * s, 2.2 * s, 2.2 * s, 'team', [0, 1.9 * s, 0], [0, 0, 0], 8);
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.4; b.box('body', 0.5, 2.6 * s, 0.5, 'metal', [Math.cos(a) * 2.1, 1.4 * s, Math.sin(a) * 2.1]); }
    b.cyl('glow', 0.9, 0.9, 0.2, 0x40ff80, [0, 3.1 * s, 0], [0, 0, 0], 12);
    b.cyl('spin', 0.3, 0.3, 3.5 * s, 'steel', [0, 0, 0]);
    b.box('spin', 2.6 * s, 0.3, 0.4, 'dark', [0, 1.2 * s, 0]);
    if (tier >= 2) b.cyl('body', 2.4, 2.4, 0.4, 'teamDark', [0, 2.6, 0], [0, 0, 0], 8);
    if (tier >= 3) b.cyl('glow', 1.5, 1.5, 0.3, 0x40ff80, [0, 1.4, 0], [0, 0, 0], 12);
    return { spin: [[0, 3.0 * s, 0]], height: 4 * s };
  },
  mex2(b) { return DEFS.mex(b, 2); },
  mex3(b) { return DEFS.mex(b, 3); },
  pgen(b, tier = 1) {
    const s = tier === 1 ? 1 : tier === 2 ? 1.8 : 2.6;
    b.box('body', 7.6 * s, 0.6, 7.6 * s, 'concrete', [0, 0.3, 0]);
    b.cyl('body', 1.9 * s, 2.6 * s, 3.8 * s, 'light', [-1.0 * s, 2.2 * s, -1.0 * s], [0, 0, 0], 14);
    b.cyl('body', 1.0 * s, 1.0 * s, 1.8 * s, 'team', [2.0 * s, 1.2 * s, 1.8 * s], [0, 0, 0], 10);
    b.box('body', 2.2 * s, 1.6 * s, 2.0 * s, 'metal', [1.8 * s, 1.1 * s, -1.6 * s]);
    b.sph('glow', 0.75 * s, 0xffe060, [2.0 * s, 2.4 * s, 1.8 * s]);
    b.cyl('glow', 1.5 * s, 1.5 * s, 0.15, 0xffd040, [-1.0 * s, 4.15 * s, -1.0 * s], [0, 0, 0], 14);
    if (tier >= 2) b.cyl('body', 1.5 * s, 2.0 * s, 3.0 * s, 'light', [-1.2 * s, 1.8 * s, 2.2 * s], [0, 0, 0], 14);
    if (tier >= 3) b.sph('glow', 1.2 * s, 0xfff0a0, [2.4 * s, 3.0 * s, -1.2 * s]);
    return { height: 4 * s };
  },
  pgen2(b) { return DEFS.pgen(b, 2); },
  pgen3(b) { return DEFS.pgen(b, 3); },
  mstore(b) {
    b.box('body', 5.6, 0.5, 5.6, 'concrete', [0, 0.25, 0]);
    b.cyl('body', 2.2, 2.2, 2.4, 'team', [0, 1.7, 0], [0, 0, 0], 12);
    b.cyl('glow', 1.6, 1.6, 0.3, 0x40ff80, [0, 3.0, 0], [0, 0, 0], 12);
    return { height: 3.2 };
  },
  estore(b) {
    b.box('body', 5.6, 0.5, 5.6, 'concrete', [0, 0.25, 0]);
    b.box('body', 3.8, 2.2, 3.8, 'team', [0, 1.6, 0]);
    b.sph('glow', 1.0, 0xffe060, [0, 3.1, 0]);
    return { height: 3.5 };
  },
  factory(b, type, tier) {
    const S = 22;
    b.box('body', S, 0.8, S, 'concrete', [0, 0.4, 0]);
    b.box('body', S - 1, 0.1, 1.0, 'hazard', [0, 0.85, S / 2 - 1.5]);
    b.box('body', S - 1, 0.1, 1.0, 'hazard', [0, 0.85, -S / 2 + 1.5]);
    if (type === 'air') {
      b.box('body', S * 0.8, 0.15, S * 0.8, 'pad', [0, 0.9, 0]);
      b.box('body', S * 0.5, 0.05, 0.4, 'light', [0, 1.0, 0]);
      b.box('body', 0.4, 0.05, S * 0.5, 'light', [0, 1.0, 0]);
      b.box('body', 3, 7 + tier, 3, 'metal', [-S / 2 + 3, 4 + tier / 2, -S / 2 + 3]);
      b.box('body', 4, 2, 4, 'team', [-S / 2 + 3, 8.5 + tier, -S / 2 + 3]);
      b.box('glow', 4.1, 0.4, 4.1, 0x9fe8ff, [-S / 2 + 3, 8.2 + tier, -S / 2 + 3]);
      for (const z of [-5, 5]) b.box('body', 1, 4, 1, 'dark', [S / 2 - 2, 2.5, z]);
      b.box('body', 1, 1, 12, 'team', [S / 2 - 2, 4.5, 0]);
      for (const [x, z] of [[-7, 7], [7, 7], [7, -7], [-7, -7]]) b.sph('glow', 0.35, 0x40ff80, [x, 1.1, z]);
    } else if (type === 'naval') {
      b.box('body', S, 3, 3, 'metal', [0, 1.5, S / 2 - 1.5]);
      b.box('body', S, 3, 3, 'metal', [0, 1.5, -S / 2 + 1.5]);
      for (const x of [-7, 0, 7]) {
        b.box('body', 1.2, 10 + tier * 1.5, 1.2, 'hazard', [x, 5 + tier, S / 2 - 1.5]);
        b.box('body', 1.2, 1.2, S - 3, 'team', [x, 10.5 + tier * 1.5, 0]);
      }
      b.box('body', 4, 4, S, 'teamDark', [-S / 2 + 2, 2, 0]);
      b.box('glow', 0.2, 0.6, S - 4, 0x9fe8ff, [-S / 2 + 4.1, 3.4, 0]);
    } else {
      b.box('body', S * 0.72, 6 + tier, S * 0.62, 'team', [-1.5, 3.5 + tier / 2, 0]);
      b.box('body', S * 0.74, 0.8, S * 0.64, 'teamDark', [-1.5, 7 + tier, 0]);
      b.box('body', 1, 4, S * 0.5, 'black', [S * 0.36 - 1.4, 2.6, 0]);
      b.box('glow', 0.2, 0.5, S * 0.5, 0xffc060, [S * 0.36 - 0.8, 4.9, 0]);
      for (const z of [-7, 7]) { b.cyl('body', 1.1, 1.3, 9 + tier * 2, 'metal', [-7.5, 4.5 + tier, z], [0, 0, 0], 10); b.cyl('glow', 0.9, 0.9, 0.2, 0xff8040, [-7.5, 9 + tier * 2, z]); }
      b.box('body', 4, 2.4, 4, 'metal', [4, 8.5 + tier, -5]);
    }
    if (tier >= 2) b.box('body', 5, 3, 5, 'teamDark', [S / 2 - 4, 2.3, S / 2 - 4]);
    if (tier >= 3) b.box('body', 5, 5, 5, 'metal', [S / 2 - 4, 3.3, -S / 2 + 4]);
    return { height: 10 };
  },
  land_fac(b) { return DEFS.factory(b, 'land', 1); }, land_fac2(b) { return DEFS.factory(b, 'land', 2); }, land_fac3(b) { return DEFS.factory(b, 'land', 3); },
  air_fac(b) { return DEFS.factory(b, 'air', 1); }, air_fac2(b) { return DEFS.factory(b, 'air', 2); }, air_fac3(b) { return DEFS.factory(b, 'air', 3); },
  naval_fac(b) { return DEFS.factory(b, 'naval', 1); }, naval_fac2(b) { return DEFS.factory(b, 'naval', 2); }, naval_fac3(b) { return DEFS.factory(b, 'naval', 3); },
  pd(b, big = false) {
    const s = big ? 1.35 : 1;
    b.cyl('body', 2.6 * s, 3.0 * s, 1.4 * s, 'concrete', [0, 0.7 * s, 0], [0, 0, 0], 8);
    b.cyl('body', 1.8 * s, 2.0 * s, 1.0 * s, 'team', [0, 1.8 * s, 0], [0, 0, 0], 8);
    b.box('t0', 2.2 * s, 1.2 * s, 1.8 * s, 'teamDark', [0, 0, 0]);
    if (big) { b.barrel('t0', 0.2, 3.4, 'black', [0.8, 0.1, 0.4]); b.barrel('t0', 0.2, 3.4, 'black', [0.8, 0.1, -0.4]); }
    else b.barrel('t0', 0.2, 2.8, 'black', [0.8, 0.1, 0]);
    b.box('glowt0', 0.15, 0.2, 0.9, 0xffc060, [-1.1 * s, 0.3, 0]);
    return { turrets: [{ pos: [0, 2.9 * s, 0] }], height: 3.6 * s };
  },
  pd2(b) { return DEFS.pd(b, true); },
  aa_turret(b) {
    b.cyl('body', 2.4, 2.8, 1.2, 'concrete', [0, 0.6, 0], [0, 0, 0], 8);
    b.cyl('body', 0.6, 0.8, 1.6, 'metal', [0, 2.0, 0]);
    b.box('t0', 1.0, 0.8, 1.0, 'teamDark', [0, 0, 0]);
    for (const z of [-0.7, 0.7]) { b.box('t0', 1.8, 0.8, 0.5, 'team', [0.2, 0.5, z], [0, 0, 0.55]); b.cone('t0', 0.14, 0.4, 'light', [1.05, 1.05, z], [0, 0, -Math.PI / 2 + 0.55]); }
    return { turrets: [{ pos: [0, 3.0, 0] }], height: 4 };
  },
  flak2s(b) {
    b.cyl('body', 3.2, 3.6, 1.4, 'concrete', [0, 0.7, 0], [0, 0, 0], 8);
    b.cyl('t0', 1.8, 2.0, 1.2, 'team', [0, 0, 0], [0, 0, 0], 10);
    for (const z of [-0.5, 0.5]) b.barrel('t0', 0.18, 3.2, 'black', [0.3, 0.3, z], 0.8);
    b.cyl('t0', 0.8, 0.8, 0.1, 'light', [-1.0, 1.1, 0], [0, 0, 0.4], 12);
    return { turrets: [{ pos: [0, 2.0, 0] }], height: 4.5 };
  },
  torp(b) {
    b.cyl('body', 2.6, 2.6, 1.4, 'metal', [0, 0.2, 0], [0, 0, 0], 8);
    b.box('body', 3.2, 0.3, 3.2, 'hazard', [0, 0.95, 0]);
    b.box('t0', 2.0, 0.9, 1.6, 'team', [0, 0, 0]);
    for (const z of [-0.4, 0.4]) b.cyl('t0', 0.25, 0.25, 1.0, 'dark', [1.2, 0, z], [0, 0, Math.PI / 2]);
    return { turrets: [{ pos: [0, 1.6, 0] }], height: 2.2, floats: true };
  },
  radar(b, tier = 1) {
    const s = tier === 1 ? 1 : tier === 2 ? 1.35 : 1.7;
    b.box('body', 5.6, 0.5, 5.6, 'concrete', [0, 0.25, 0]);
    b.cyl('body', 0.35 * s, 0.6 * s, 7 * s, 'metal', [0, 3.5 * s, 0]);
    b.box('body', 1.4 * s, 1.2 * s, 1.4 * s, 'team', [0, 1.1, 0]);
    if (tier >= 2) for (let i = 0; i < 3; i++) { const a = i * 2.1; b.box('body', 0.3, 5 * s, 0.3, 'dark', [Math.cos(a) * 2, 2.5 * s, Math.sin(a) * 2], [Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25]); }
    if (tier >= 3) { b.sph('glow', 0.9, 0x9fe8ff, [0, 4.2 * s, 0]); b.cyl('body', 2.4, 2.4, 0.2, 'teamDark', [0, 3.4 * s, 0], [0, 0, 0], 16); }
    b.add('spin', new THREE.CylinderGeometry(2.4 * s, 2.4 * s, 0.15, 16, 1, false, 0, Math.PI), 'light', [0, 0, 0], [Math.PI / 2 - 0.4, 0, 0]);
    b.box('spin', 0.2, 0.2, 1.4 * s, 'dark', [0, 0, 0]);
    b.sph('glow', 0.25, 0xff4040, [0, 7.3 * s, 0]);
    return { spin: [[0, 7.0 * s, 0]], height: 8 * s };
  },
  radar2(b) { return DEFS.radar(b, 2); },
  radar3(b) { return DEFS.radar(b, 3); },
  sonar(b) {
    b.cyl('body', 2.6, 2.8, 1.4, 'metal', [0, 0.2, 0], [0, 0, 0], 10);
    b.box('body', 3.4, 0.3, 3.4, 'hazard', [0, 0.95, 0]);
    b.cyl('body', 0.3, 0.3, 3, 'dark', [0, 2.4, 0]);
    b.sph('body', 1.1, 'team', [0, 4.1, 0], [1, 0.6, 1]);
    b.add('spin', new THREE.TorusGeometry(1.4, 0.12, 6, 20), 'light', [0, 0, 0], [Math.PI / 2, 0, 0]);
    b.sph('glow', 0.25, 0x70f0ff, [0, 4.8, 0]);
    return { spin: [[0, 3.2, 0]], height: 5, floats: true };
  },
  mfab(b, tier = 2) {
    const s = tier === 3 ? 2 : 1;
    b.box('body', 5.6 * s, 0.6, 5.6 * s, 'concrete', [0, 0.3, 0]);
    b.box('body', 3.6 * s, 2.2 * s, 3.6 * s, 'team', [0, 1.6 * s, 0]);
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.cyl('body', 0.35 * s, 0.35 * s, 3.4 * s, 'metal', [x * 1.9 * s, 1.8 * s, z * 1.9 * s]);
    b.add('spin', new THREE.TorusGeometry(1.6 * s, 0.25 * s, 8, 24), 'steel', [0, 0, 0], [Math.PI / 2, 0, 0]);
    b.sph('glow', 0.9 * s, 0x40ff80, [0, 3.2 * s, 0]);
    return { spin: [[0, 3.2 * s, 0]], height: 4 * s };
  },
  mfab3(b) { return DEFS.mfab(b, 3); },
  shield(b) {
    b.box('body', 7.6, 0.6, 7.6, 'concrete', [0, 0.3, 0]);
    b.cyl('body', 2.2, 2.8, 1.6, 'team', [0, 1.4, 0], [0, 0, 0], 12);
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; b.box('body', 0.5, 5, 0.5, 'metal', [Math.cos(a) * 2.8, 3, Math.sin(a) * 2.8]); b.sph('glow', 0.35, 0x80c8ff, [Math.cos(a) * 2.8, 5.6, Math.sin(a) * 2.8]); }
    b.sph('glow', 1.2, 0x9fdfff, [0, 4.2, 0]);
    return { height: 6 };
  },
  arty2(b) {
    b.box('body', 9.6, 1.0, 9.6, 'concrete', [0, 0.5, 0]);
    b.cyl('body', 3.6, 4.2, 1.6, 'metal', [0, 1.6, 0], [0, 0, 0], 12);
    b.box('t0', 4.0, 2.4, 3.2, 'team', [-0.5, 0.2, 0]);
    b.barrel('t0', 0.45, 9, 'black', [1, 0.6, 0], 0.5);
    b.cyl('t0', 0.6, 0.6, 1.4, 'dark', [1.7, 1.0, 0], [0, 0, Math.PI / 2 - 0.5]);
    return { turrets: [{ pos: [0, 3.2, 0] }], height: 7 };
  },
  // ------------------------------------------------------------ missile systems (Blender GLB when present, see PROC_ONLY; this is the fallback)
  // meta.hatches: pivots animated by the game from Structure.doorOpen — { pos, axis, open (rad at doorOpen = 1), lift (rise at doorOpen = 1), stockVis }
  sml(b) {
    const S = 14;
    b.box('body', S, 0.8, S, 'concrete', [0, 0.4, 0]);
    b.box('body', S - 1, 0.1, 0.9, 'hazard', [0, 0.85, S / 2 - 1]); b.box('body', S - 1, 0.1, 0.9, 'hazard', [0, 0.85, -S / 2 + 1]);
    b.cyl('body', 5.9, 6.3, 0.9, 'dark', [0, 1.25, 0], [0, 0, 0], 20);                 // foundation ring
    b.cyl('body', 5.2, 5.5, 1.5, 'metal', [0, 2.0, 0], [0, 0, 0], 20);                // silo collar
    b.cyl('body', 5.35, 5.35, 0.25, 'teamDark', [0, 2.65, 0], [0, 0, 0], 20);
    for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; b.box('body', 0.5, 0.5, 1.2, i % 2 ? 'hazard' : 'black', [Math.cos(a) * 5.4, 2.85, Math.sin(a) * 5.4], [0, -a, 0]); }
    b.cyl('glow', 4.4, 4.4, 0.05, 0xff5a20, [0, 1.0, 0], [0, 0, 0], 20);              // fire pit glow far below the doors
    // launch gantry towers
    for (const [x, z] of [[-5.6, -5.4], [5.6, -5.4]]) {
      b.box('body', 0.9, 11, 0.9, 'steel', [x, 6.3, z]);
      for (let k = 0; k < 4; k++) b.box('body', 0.25, 0.25, 1.3, 'dark', [x, 2.6 + k * 2.6, z], [0, 0, 0.6 * (k % 2 ? 1 : -1)]);
      b.box('body', 1.4, 0.8, 1.4, 'team', [x, 12.0, z]);
      b.sph('glow', 0.32, 0xff3020, [x, 12.7, z]);
    }
    b.box('body', 12.6, 0.5, 0.5, 'steel', [0, 11.2, -5.4]);
    // fuel tanks + control bunker
    for (const z of [-2.2, 0.2]) { b.cyl('body', 1.0, 1.0, 3.6, 'light', [-6.2, 2.6, z], [0, 0, 0], 12); b.cyl('body', 1.04, 1.04, 0.5, 'team', [-6.2, 3.4, z], [0, 0, 0], 12); }
    b.box('body', 3.2, 2.6, 2.4, 'team', [5.0, 2.1, 4.6]); b.box('body', 3.3, 0.4, 2.5, 'teamDark', [5.0, 3.5, 4.6]);
    b.box('glow', 2.2, 0.35, 0.05, 0x9fe8ff, [5.0, 2.6, 5.85]);
    b.cyl('body', 0.08, 0.08, 3, 'steel', [6.2, 5.3, 4.0]); b.sph('glow', 0.18, 0xff3020, [6.2, 6.85, 4.0]);
    // doors (half discs hinged on the collar edge), and the missile that rises between them
    const half = (from) => new THREE.CylinderGeometry(5.05, 5.05, 0.45, 20, 1, false, from, Math.PI);
    b.add('h0', half(0), 'teamDark', [-5.05, 0, 0]); b.box('h0', 0.8, 0.12, 8.4, 'hazard', [-4.4, 0.27, 0]); b.box('h0', 3, 0.12, 0.5, 'black', [-2.4, 0.27, 0]);
    b.add('h1', half(Math.PI), 'teamDark', [5.05, 0, 0]); b.box('h1', 0.8, 0.12, 8.4, 'hazard', [4.4, 0.27, 0]); b.box('h1', 3, 0.12, 0.5, 'black', [2.4, 0.27, 0]);
    b.cyl('h2', 0.85, 0.85, 8.6, 'light', [0, 4.3, 0], [0, 0, 0], 12); b.cyl('h2', 0.88, 0.88, 0.9, 'teamDark', [0, 2.4, 0], [0, 0, 0], 12);
    b.cyl('h2', 0.88, 0.88, 0.5, 'hazard', [0, 6.6, 0], [0, 0, 0], 12);
    b.cone('h2', 0.85, 2.6, 0xc8382a, [0, 9.9, 0], [0, 0, 0], 12);
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; b.box('h2', 0.14, 1.6, 1.0, 'steel', [Math.cos(a) * 1.1, 0.8, Math.sin(a) * 1.1], [0, -a, 0]); }
    return { height: 12.5, hatches: [
      { pos: [5.05, 2.95, 0], axis: 'z', open: -1.5 },
      { pos: [-5.05, 2.95, 0], axis: 'z', open: 1.5 },
      { pos: [0, -8.7, 0], axis: 'z', open: 0, lift: 7.4, stockVis: true }
    ] };
  },
  smd(b) {
    b.box('body', 12, 0.7, 12, 'concrete', [0, 0.35, 0]);
    b.box('body', 11, 0.1, 0.8, 'hazard', [0, 0.75, 5.2]); b.box('body', 11, 0.1, 0.8, 'hazard', [0, 0.75, -5.2]);
    b.cyl('body', 4.6, 5.0, 1.3, 'metal', [0, 1.35, 0], [0, 0, 0], 20);
    b.cyl('body', 4.7, 4.7, 0.3, 'teamDark', [0, 2.1, 0], [0, 0, 0], 20);
    b.cyl('glow', 4.75, 4.75, 0.08, 0x60e8ff, [0, 2.0, 0], [0, 0, 0], 20);              // cyan light ring around the collar
    // phased array panels on the corners
    for (const [x, z, a] of [[4.6, 4.6, 0.785], [-4.6, 4.6, 2.36], [-4.6, -4.6, 3.93], [4.6, -4.6, 5.5]]) {
      b.box('body', 0.4, 4.2, 2.6, 'team', [x, 2.8, z], [0, -a, 0]); b.box('glow', 0.06, 3.4, 2.0, 0x60e8ff, [x + Math.cos(a) * 0.23, 2.9, z - Math.sin(a) * 0.23 * -1], [0, -a, 0]);
      b.box('body', 0.7, 0.7, 0.7, 'dark', [x, 0.9, z]);
    }
    b.cyl('body', 0.12, 0.12, 4, 'steel', [0, 5.0, -3.6]); b.sph('glow', 0.24, 0x60e8ff, [0, 7.1, -3.6]);
    // shutters: two hemisphere halves, split along X
    const dome = (phi) => new THREE.SphereGeometry(4.5, 18, 8, phi, Math.PI, 0, Math.PI / 2), seam = new THREE.TorusGeometry(4.5, 0.14, 5, 18, Math.PI);
    b.add('h0', dome(0), 'teamDark', [0, 0, -4.5]); b.add('h0', seam, 'hazard', [0, 0, -4.5]);
    b.add('h1', dome(Math.PI), 'teamDark', [0, 0, 4.5]); b.add('h1', seam, 'hazard', [0, 0, 4.5]);
    // interceptors standing in the silo
    for (const [x, z] of [[-1.3, 0], [1.3, 0]]) {
      b.cyl('h2', 0.5, 0.5, 5.2, 'light', [x, 2.6, z], [0, 0, 0], 10); b.cone('h2', 0.5, 1.6, 0x4fe8ff, [x, 6.0, z], [0, 0, 0], 10);
      b.cyl('h2', 0.52, 0.52, 0.5, 'teamDark', [x, 1.5, z], [0, 0, 0], 10);
    }
    return { height: 8, hatches: [
      { pos: [0, 2.2, 4.5], axis: 'x', open: 1.65 },
      { pos: [0, 2.2, -4.5], axis: 'x', open: -1.65 },
      { pos: [0, -3.2, 0], axis: 'x', open: 0, lift: 4.6, stockVis: true }
    ] };
  },
  tml(b) {
    b.box('body', 8, 0.7, 8, 'concrete', [0, 0.35, 0]);
    b.box('body', 7, 0.1, 0.7, 'hazard', [0, 0.75, 3.4]); b.box('body', 7, 0.1, 0.7, 'hazard', [0, 0.75, -3.4]);
    b.cyl('body', 2.5, 2.9, 1.2, 'metal', [0, 1.3, 0], [0, 0, 0], 14);
    b.cyl('body', 1.6, 1.6, 0.8, 'teamDark', [0, 2.2, 0], [0, 0, 0], 12);
    // ammo cassette & ready-light next to the pad
    b.box('body', 2, 1.6, 1.6, 'team', [-2.4, 1.5, 2.6]); b.box('glow', 1.2, 0.15, 0.05, 0xffb040, [-2.4, 1.9, 3.42]);
    b.cyl('body', 0.1, 0.1, 2.6, 'steel', [2.6, 2.0, -2.6]); b.sph('glow', 0.2, 0xff3020, [2.6, 3.4, -2.6]);
    // launcher: turret 0, an inclined rack with two tubes and missile noses
    b.box('t0', 3.4, 1.0, 3.0, 'team', [-0.4, 0.5, 0]);
    b.box('t0', 2.2, 0.7, 2.6, 'teamDark', [-1.2, 1.2, 0]);
    for (const z of [-0.9, 0.9]) {
      b.box('t0', 5.6, 1.1, 1.3, 'dark', [1.2, 2.3, z], [0, 0, 0.62]);
      b.cyl('t0', 0.42, 0.42, 2.4, 'light', [3.7, 4.05, z], [0, 0, -Math.PI / 2 + 0.62], 10);
      b.cone('t0', 0.42, 1.2, 0xd8b040, [4.85, 4.7, z], [0, 0, -Math.PI / 2 + 0.62], 10);
    }
    b.box('t0', 0.5, 2.4, 0.5, 'steel', [-0.6, 1.9, 0], [0, 0, 0.3]);
    b.box('glowt0', 0.05, 0.3, 2.6, 0xff8030, [2.2, 3.3, 0], [0, 0, 0.62]);
    return { turrets: [{ pos: [0, 2.6, 0] }], height: 6 };
  },
  tmd(b) {
    b.cyl('body', 3.1, 3.4, 0.7, 'concrete', [0, 0.35, 0], [0, 0, 0], 8);
    b.cyl('body', 1.9, 2.2, 1.3, 'metal', [0, 1.35, 0], [0, 0, 0], 10);
    b.box('body', 1.4, 0.4, 1.4, 'hazard', [-1.9, 0.9, 1.8]);
    // radar mast with a rotating dish
    b.cyl('body', 0.18, 0.28, 5, 'steel', [-1.2, 3.4, -1.2]);
    b.box('body', 0.9, 0.9, 0.9, 'team', [-1.2, 0.9, -1.2]);
    b.sph('glow', 0.22, 0x60ffd0, [-1.2, 6.1, -1.2]);
    b.add('spin', new THREE.CylinderGeometry(1.5, 1.5, 0.12, 14, 1, false, 0, Math.PI), 'light', [0, 0, 0], [Math.PI / 2 - 0.35, 0, 0]);
    b.box('spin', 0.14, 0.14, 1.0, 'dark', [0, 0, 0]);
    // rapid-fire turret 0: two slim barrels and an emitter
    b.box('t0', 1.7, 0.9, 1.5, 'team', [0, 0.45, 0]);
    b.box('t0', 0.9, 0.5, 1.1, 'teamDark', [-0.3, 1.05, 0]);
    for (const z of [-0.35, 0.35]) b.barrel('t0', 0.11, 2.4, 'black', [0.6, 0.55, z], 0.3);
    b.cyl('glowt0', 0.16, 0.16, 0.16, 0x60ffd0, [3.0, 1.3, 0], [0, 0, Math.PI / 2 + 0.3]);
    return { turrets: [{ pos: [0.5, 2.0, 0.6] }], spin: [[-1.2, 5.6, -1.2]], height: 6.5 };
  },
  xframe(b) {
    b.box('body', 22, 0.8, 22, 'concrete', [0, 0.4, 0]);
    for (const [x, z] of [[-9, -9], [9, -9], [9, 9], [-9, 9]]) b.box('body', 1.4, 24, 1.4, 'hazard', [x, 12, z]);
    for (const y of [8, 16, 24]) { b.box('body', 19, 0.8, 0.8, 'metal', [0, y, 9]); b.box('body', 19, 0.8, 0.8, 'metal', [0, y, -9]); b.box('body', 0.8, 0.8, 19, 'metal', [9, y, 0]); b.box('body', 0.8, 0.8, 19, 'metal', [-9, y, 0]); }
    b.box('body', 6, 10, 8, 'team', [0, 7, 0]);
    return { height: 25 };
  }
};

const cache = new Map();
export function getModel(key, teamColor) {
  const ck = key + ':' + teamColor;
  if (cache.has(ck)) return cache.get(ck);
  const b = new Builder(teamColor);
  const def = DEFS[key] || DEFS.tank1;
  const meta = def(b) || {};
  const g = b.build();
  const m = { geoms: g, meta };
  cache.set(ck, m);
  return m;
}

// Blender-only models (stage 14): the procedural fallback / meta is borrowed from a similar model.
Object.assign(DEFS, { aa3: DEFS.flak2, kami: DEFS.scout_air, sam3: DEFS.aa_turret, arty3s: DEFS.arty2, shield2: DEFS.shield, shield3: DEFS.shield, shield4: DEFS.shield });
export const MODEL_KEYS = Object.keys(DEFS);
// Procedural-only models: there is no Blender GLB for them (do not even try to fetch one). Empty now: the missile systems
// (sml, smd, tml, tmd) have Blender models too; their procedural versions below are only the fallback and the source of meta.
export const PROC_ONLY = new Set();

// Missile bodies for flying projectiles (nose along +Y): 'nuke' (strategic, ~15 long), 'tac' (cruise), 'anti' (interceptor).
const missileCache = {};
export function missileGeom(kind) {
  if (missileCache[kind]) return missileCache[kind];
  const b = new Builder(0xffffff);
  if (kind === 'nuke') {
    b.cyl('m', 0.9, 0.9, 10, 'light', [0, 5, 0], [0, 0, 0], 10); b.cone('m', 0.9, 3.2, 0xc8382a, [0, 11.6, 0], [0, 0, 0], 10);
    b.cyl('m', 0.94, 0.94, 0.9, 0x222428, [0, 7.6, 0], [0, 0, 0], 10); b.cyl('m', 0.94, 0.94, 0.5, 'hazard', [0, 3.0, 0], [0, 0, 0], 10);
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; b.box('m', 0.12, 2.2, 1.6, 'steel', [Math.cos(a) * 1.2, 1.3, Math.sin(a) * 1.2], [0, -a, 0]); }
  } else if (kind === 'anti') {
    b.cyl('m', 0.4, 0.4, 3.4, 'light', [0, 1.7, 0], [0, 0, 0], 8); b.cone('m', 0.4, 1.2, 0x4fe8ff, [0, 4.0, 0], [0, 0, 0], 8);
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; b.box('m', 0.08, 1.0, 0.9, 'steel', [Math.cos(a) * 0.6, 0.6, Math.sin(a) * 0.6], [0, -a, 0]); }
  } else {
    b.cyl('m', 0.34, 0.34, 3.0, 'light', [0, 1.5, 0], [0, 0, 0], 8); b.cone('m', 0.34, 1.0, 0xd8b040, [0, 3.5, 0], [0, 0, 0], 8);
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; b.box('m', 0.08, 0.9, 0.8, 'steel', [Math.cos(a) * 0.5, 0.5, Math.sin(a) * 0.5], [0, -a, 0]); }
  }
  return missileCache[kind] = b.build().m.translate(0, kind === 'nuke' ? -6.5 : -2, 0);   // centred on the projectile position
}
