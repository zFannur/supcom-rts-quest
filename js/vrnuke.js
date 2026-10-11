// VR blast-zone preview for the `launch` mode (13.2): 3 zone rings (strategic) or one (tactical) draped on the terrain under the laser,
// translucent fill of the inner zone, radius labels as sprites. One preallocated mesh, repositioned only when the aim moves; no per-frame allocation.
import * as THREE from 'three';
import { nukeZoneLabel, fmtDist } from './specs.js';

const SEG = 96, TAU = Math.PI * 2, LIFT = 0.9, TAC = [6];
const COL = [[1, 0.23, 0.14], [1, 0.54, 0.19], [1, 0.82, 0.25]];   // as on the PC overlay (AIM_COL)
const CSS = ['#ff4a34', '#ff9a40', '#ffd850'];
const FILL_A = 0.22, RING_A = 0.95, LABEL_H = 0.034;   // label height = 0.034 x view depth (about 2 deg)

export class VRNukeZone {
  constructor(scene) {
    this.scene = scene;
    // vertices: 0 = fill centre, 1..SEG fill rim; then 3 rings x (SEG inner + SEG outer)
    const nv = 1 + SEG + 3 * 2 * SEG;
    this.pos = new Float32Array(nv * 3); this.col = new Float32Array(nv * 4);
    const idx = [];
    for (let i = 0; i < SEG; i++) idx.push(0, 1 + i, 1 + (i + 1) % SEG);
    this.fillIdx = idx.length;
    for (let r = 0; r < 3; r++) {
      const b = 1 + SEG + r * 2 * SEG;
      for (let i = 0; i < SEG; i++) { const j = (i + 1) % SEG; idx.push(b + i, b + SEG + i, b + SEG + j, b + i, b + SEG + j, b + j); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    g.setIndex(idx); g.setDrawRange(0, 0);
    for (let i = 0; i <= SEG; i++) this._c(i, 0, FILL_A);
    for (let r = 0; r < 3; r++) for (let k = 0; k < 2 * SEG; k++) this._c(1 + SEG + r * 2 * SEG + k, r, RING_A);
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.mesh = new THREE.Mesh(g, m); this.mesh.frustumCulled = false; this.mesh.renderOrder = 8; this.mesh.visible = false;
    scene.add(this.mesh);
    this.sprites = []; this.n = 0; this.spec = undefined; this.x = NaN; this.z = NaN; this.shown = false;
    this.zones = [0, 0, 0];
  }
  _c(v, c, a) { const o = v * 4, k = COL[c]; this.col[o] = k[0]; this.col[o + 1] = k[1]; this.col[o + 2] = k[2]; this.col[o + 3] = a; }

  _label(i, text) {
    const cv = document.createElement('canvas'), c = cv.getContext('2d'), F = 'bold 40px Rajdhani, sans-serif'; c.font = F;
    const w = Math.ceil(c.measureText(text).width) + 36; cv.width = w; cv.height = 64;
    c.font = F; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = 'rgba(8,10,14,0.85)'; c.fillRect(0, 0, w, 64); c.strokeStyle = CSS[i]; c.lineWidth = 3; c.strokeRect(1.5, 1.5, w - 3, 61);
    c.fillStyle = CSS[i]; c.fillText(text, w / 2, 33);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, toneMapped: false, transparent: true }));
    s.renderOrder = 9; s.frustumCulled = false; s.visible = false;
    // sizeAttenuation off: scale is a fraction of the view depth (constant angle). With attenuation the sprite shader adds the scale in
    // camera space, which in VR is the dolly's physical metres: a 70-unit label became 70 m and covered the whole view.
    s.scale.set(LABEL_H * w / 64, LABEL_H, 1);
    const old = this.sprites[i]; if (old) { this.scene.remove(old); old.material.map.dispose(); old.material.dispose(); }
    this.sprites[i] = s; this.scene.add(s);
  }

  // spec: STRUCTS.sml.silo (3 zones) or null (tactical, one small ring); hit: {x, z} game coords of the laser, or null to hide;
  // Labels keep a constant angular size (sizeAttenuation off), so they read from any table scale and from the ground view.
  update(spec, hit, terrain) {
    if (!hit) { this.hide(); return; }
    const Z = spec ? spec.zones : TAC, n = Z.length;
    if (spec !== this.spec) {   // texts are static per spec: built once
      this.spec = spec;
      for (let i = 0; i < n; i++) this._label(i, spec ? nukeZoneLabel(spec, i) : 'Тактическая ракета ' + fmtDist(Z[0]));
      for (let i = 0; i < this.sprites.length; i++) this.sprites[i].visible = false;
      this.n = n; this.x = NaN;
    }
    const x = Math.round(hit.x * 4) / 4, z = Math.round(hit.z * 4) / 4;
    if (x !== this.x || z !== this.z || !this.shown) { this.x = x; this.z = z; this._geom(Z, n, terrain); }
    this.mesh.visible = true; this.shown = true;
    for (let i = 0; i < n; i++) this.sprites[i].visible = true;
  }
  hide() {
    if (!this.shown) return; this.shown = false; this.mesh.visible = false;
    for (let i = 0; i < this.sprites.length; i++) this.sprites[i].visible = false;
  }

  _geom(Z, n, T) {
    const P = this.pos, x0 = this.x, z0 = this.z, W = T.water || 0, lim = (T.size || 1e9) - 1;
    const hAt = (px, pz) => Math.max(T.surfaceAt(Math.min(lim, Math.max(1, px)), Math.min(lim, Math.max(1, pz))), W) + LIFT;
    P[0] = x0; P[1] = hAt(x0, z0); P[2] = z0;
    const R0 = Z[0];
    for (let i = 0; i < SEG; i++) {
      const a = i / SEG * TAU, px = x0 + Math.cos(a) * R0, pz = z0 + Math.sin(a) * R0, o = (1 + i) * 3;
      P[o] = px; P[o + 1] = hAt(px, pz); P[o + 2] = pz;
    }
    for (let r = 0; r < n; r++) {
      const R = Z[r], w = Math.max(0.6, R * 0.014), b = 1 + SEG + r * 2 * SEG;
      for (let i = 0; i < SEG; i++) {
        const a = i / SEG * TAU, c = Math.cos(a), s = Math.sin(a);
        let px = x0 + c * (R - w), pz = z0 + s * (R - w), o = (b + i) * 3; P[o] = px; P[o + 1] = hAt(px, pz); P[o + 2] = pz;
        px = x0 + c * R; pz = z0 + s * R; o = (b + SEG + i) * 3; P[o] = px; P[o + 1] = hAt(px, pz); P[o + 2] = pz;
      }
      const lx = x0 + Math.cos(0.7) * R, lz = z0 + Math.sin(0.7) * R;
      this.sprites[r].position.set(lx, hAt(lx, lz) + R * 0.03 + 1.5, lz);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, this.fillIdx + n * SEG * 6);
    this.zones[0] = Z[0]; this.zones[1] = Z[1] || 0; this.zones[2] = Z[2] || 0;
  }
  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); for (const s of this.sprites) { this.scene.remove(s); s.material.map.dispose(); s.material.dispose(); } }
}
