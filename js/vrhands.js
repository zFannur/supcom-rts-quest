// VR hands (11.13): the official Meta Quest Touch Plus controller model and a skinned hand that holds it (WebXR Input Profiles assets, MIT, assets/vr/).
// Controller: assets/vr/meta-quest-touch-plus/{left,right}.glb, posed in gripSpace by the asset itself; trigger, grip, stick and buttons move by
// profile.json visualResponses exactly like three's XRControllerModelFactory / @webxr-input-profiles/motion-controllers (no network, no library).
// Hand: assets/vr/generic-hand/{left,right}.glb (the XRHandModelFactory 'mesh' hand, 25 XRHand joints, flat bones in hand space).
//   With a controller: finger poses from the gamepad (trigger curls the index, grip curls middle/ring/pinky, thumb rests on what it touches, else lifted;
//   index rests on the trigger when touched, else points). The poses are fitted to the real controller geometry at load (Side.solve: middle / ring / pinky
//   close until they touch the body, thumb and index tips reach the stick, buttons and trigger), hand placement = HAND (tools/hands_view.mjs to check).
//   With hand tracking (inputSource.hand): the same mesh follows the XRHand joints (frame.fillPoses), the controller is hidden.
// Each controller = 1 skinned mesh (its 6 parts merged, the parts' nodes are the bones), each hand = 1 skinned mesh: 2 draw calls per hand.
// Per frame: no allocations. Team colour = a band at the wrist, dark sleeve at the cut (vertex colours). vr.js uses: new VRHands(vr), update(dt), laserZ.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TEAM_COLORS } from './specs.js';

const BASE = new URL('../assets/vr/', import.meta.url).href;
const D2R = Math.PI / 180;
// Whole model (controller + hand) relative to the grip pose: only if the headset's grip differs from the asset (window.__dbg.vr.hands.tune(pitchDeg, x, y, z)).
export const TUNE = { pitch: 0, x: 0, y: 0, z: 0 };
// Hand placement in the controller's grip space (right hand; the left one is mirrored): middle-finger knuckle position (m) and wrist rotation (deg, XYZ Euler).
// Live: window.__dbg.vr.hands.tuneHand(x, y, z, rxDeg, ryDeg, rzDeg) (re-solves the thumb and index targets).
export const HAND = { x: 0.0439, y: -0.0019, z: 0.0116, rx: -62, ry: -5.9, rz: -80.9 };

export const JOINTS = ['wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'];
const NJ = 25;
const PARENT = [-1, 0, 1, 2, 3, 0, 5, 6, 7, 8, 0, 10, 11, 12, 13, 0, 15, 16, 17, 18, 0, 20, 21, 22, 23];
const THUMB = [1, 4], INDEX = [5, 9], GRIP3 = [10, 24];   // joint ranges [from, to]
// Joint angles per pose: [flex (curl towards the palm), abduction, twist] in radians about the joint's own X / Y / Z (WebXR joint frame: -Z to the tip,
// +Y out of the back of the hand). Same values for both hands (abduction and twist are mirrored in fk()).
const P = (o) => { const a = new Float32Array(NJ * 3); for (const k in o) a.set(o[k], +k * 3); return a; };
export const POSES = {
  // starting poses; the ones marked * are fitted to the controller in Side.solve() (fingers closed until they touch it, thumb tip on its target)
  flat: P({ 11: [0.15, 0.03, 0], 12: [0.15, 0, 0], 13: [0.1, 0, 0], 16: [0.15, -0.02, 0], 17: [0.15, 0, 0], 18: [0.1, 0, 0], 21: [0.15, -0.08, 0], 22: [0.15, 0, 0], 23: [0.1, 0, 0] }),
  open: null, closed: null,   // * middle / ring / pinky around the handle: grip released (6 mm gap) / grip pressed (touching)
  point: P({ 6: [0.05, -0.4, 0], 7: [0.1, 0, 0], 8: [0.06, 0, 0] }),   // index pointing (trigger not touched)
  trig: null, pull: null,     // * index resting on the trigger / pulling it
  up: P({ 1: [0.1, 0.35, 0], 2: [0.0, 0, 0], 3: [0.05, 0, 0] }),     // thumb lifted (nothing touched)
  stick: P({ 1: [0.4, 0.2, 0], 2: [0.3, 0, 0], 3: [0.3, 0, 0] }),     // * thumb on the stick (also the start for a, b, rest)
  a: null, b: null, rest: null,                                        // * thumb on A/X, B/Y, thumb rest
};
const RATE = 20;                            // input smoothing, 1/s
const MS = { default: 1, touched: 2, pressed: 4 };

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _v = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color();
const _m = new THREE.Matrix4(), _s = new THREE.Vector3();

// ------------------------------------------------------------------ controller
export class Controller {
  constructor(gltf, layout, left) {
    this.left = left;
    this.root = gltf.scene;
    this.root.updateMatrixWorld(true);
    // visualResponses (motion-controllers semantics)
    this.comps = {};
    for (const [id, c] of Object.entries(layout.components)) {
      const vrs = [];
      for (const v of Object.values(c.visualResponses || {})) {
        const value = this.root.getObjectByName(v.valueNodeName), min = v.minNodeName && this.root.getObjectByName(v.minNodeName), max = v.maxNodeName && this.root.getObjectByName(v.maxNodeName);
        if (!value || (v.valueNodeProperty === 'transform' && !(min && max))) continue;
        vrs.push({ prop: v.componentProperty, vis: v.valueNodeProperty === 'visibility', mask: v.states.reduce((m, s) => m | MS[s], 0), value, min, max });
      }
      const gi = c.gamepadIndices || {};
      this.comps[id] = { b: gi.button, x: gi.xAxis, y: gi.yAxis, vrs, state: 1, button: 0, xAxis: 0, yAxis: 0, touched: false };
    }
    const C = this.comps;
    this.trigger = C['xr-standard-trigger']; this.squeeze = C['xr-standard-squeeze']; this.stick = C['xr-standard-thumbstick'];
    this.btnA = C[left ? 'x-button' : 'a-button']; this.btnB = C[left ? 'y-button' : 'b-button']; this.rest = C.thumbrest;
    // merge the parts into one skinned mesh (1 draw call): each part's node becomes the bone of its vertices
    const parts = [], geos = [], inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    this.root.traverse(o => { if (o.isMesh) parts.push(o); });
    parts.forEach((o, i) => {
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      const n = g.attributes.position.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      for (let k = 0; k < n; k++) { si[k * 4] = i; sw[k * 4] = 1; }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      geos.push(g);
    });
    const geo = mergeGeometries(geos);
    this.geo = geo;
    const mat = parts[0].material;
    mat.side = THREE.FrontSide;
    for (const o of parts) o.visible = false;
    this.mesh = new THREE.SkinnedMesh(geo, mat);
    this.mesh.name = 'controller';
    this.root.add(this.mesh); this.root.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(parts));
    this.parts = parts;
    this.root.traverse(o => { o.frustumCulled = false; o.castShadow = o.receiveShadow = false; });
    // ray start: the front of the controller head (most -Z point of the body, grip space)
    const pos = geo.attributes.position; let zMin = Infinity, ti = 0;
    for (let k = 0; k < pos.count; k++) if (pos.getZ(k) < zMin) { zMin = pos.getZ(k); ti = k; }
    this.tip = new THREE.Object3D(); this.tip.name = 'tip'; this.tip.position.fromBufferAttribute(pos, ti); this.root.add(this.tip);
  }
  // gamepad -> component values (clamped, states as in motion-controllers) -> node transforms
  update(gp) {
    if (!gp) return;
    const bt = gp.buttons, ax = gp.axes;
    for (const id in this.comps) {
      const c = this.comps[id];
      let st = 1;
      if (c.b !== undefined && c.b < bt.length) {
        const b = bt[c.b]; let v = b.value; v = v < 0 ? 0 : v > 1 ? 1 : v; c.button = v;
        if (b.pressed || v === 1) st = 4; else if (b.touched || v > 0.05) st = 2;
        c.touched = b.touched || v > 0.05 || b.pressed;
      }
      if (c.x !== undefined && c.x < ax.length) { c.xAxis = ax[c.x] < -1 ? -1 : ax[c.x] > 1 ? 1 : ax[c.x]; if (st === 1 && Math.abs(c.xAxis) > 0.1) st = 2; }
      if (c.y !== undefined && c.y < ax.length) { c.yAxis = ax[c.y] < -1 ? -1 : ax[c.y] > 1 ? 1 : ax[c.y]; if (st === 1 && Math.abs(c.yAxis) > 0.1) st = 2; }
      c.state = st;
      let nx = c.xAxis, ny = c.yAxis; const h = Math.hypot(nx, ny);
      if (h > 1) { nx /= h; ny /= h; }
      nx = nx * 0.5 + 0.5; ny = ny * 0.5 + 0.5;
      for (const r of c.vrs) {
        const on = (r.mask & st) !== 0;
        const val = r.prop === 'xAxis' ? (on ? nx : 0.5) : r.prop === 'yAxis' ? (on ? ny : 0.5) : r.prop === 'button' ? (on ? c.button : 0) : (on ? 1 : 0);
        if (r.vis) r.value.visible = !!val;
        else { r.value.quaternion.slerpQuaternions(r.min.quaternion, r.max.quaternion, val); r.value.position.lerpVectors(r.min.position, r.max.position, val); }
      }
    }
  }
}

// ------------------------------------------------------------------ hand
export class Hand {
  constructor(gltf, left) {
    this.left = left; this.sgn = left ? -1 : 1;
    this.scene = gltf.scene;
    this.bones = JOINTS.map(n => this.scene.getObjectByName(n));
    this.mesh = null; this.scene.traverse(o => { if (o.isSkinnedMesh) this.mesh = o; o.frustumCulled = false; o.castShadow = o.receiveShadow = false; });
    // rest pose (hand space) and local offsets along the chains
    this.rp = this.bones.map(b => b.position.clone()); this.rq = this.bones.map(b => b.quaternion.clone());
    this.lp = []; this.lq = [];
    for (let j = 0; j < NJ; j++) {
      const p = PARENT[j];
      if (p < 0) { this.lp.push(new THREE.Vector3()); this.lq.push(new THREE.Quaternion()); continue; }
      const iq = this.rq[p].clone().invert();
      this.lp.push(this.rp[j].clone().sub(this.rp[p]).applyQuaternion(iq)); this.lq.push(iq.multiply(this.rq[j]));
    }
    this.P = this.bones.map(() => new THREE.Vector3()); this.Q = this.bones.map(() => new THREE.Quaternion());
    this.ang = new Float32Array(NJ * 3);
    this.poses = {}; for (const k in POSES) this.poses[k] = new Float32Array(NJ * 3);
    // skin, a team-coloured band just behind the wrist joint and a dark sleeve at the cut (vertex colours x skin material colour)
    const w = this.rp[0], dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rq[0]);   // wrist joint -Z: along the hand, the cut is across it
    const g = this.mesh.geometry, pos = g.attributes.position, n = pos.count, col = new Float32Array(n * 3);
    this.cuff = [];
    // the wrist is closed by a flat slanted cap (own vertices, normals out of the cut): bands are measured from its plane
    const nor = g.attributes.normal, isCap = (k) => -(nor.getX(k) * dir.x + nor.getY(k) * dir.y + nor.getZ(k) * dir.z) > 0.6 && _v.fromBufferAttribute(pos, k).sub(w).dot(dir) < 0;
    const cc = new THREE.Vector3(), cn = new THREE.Vector3(); let nc = 0;
    for (let k = 0; k < n; k++) if (isCap(k)) { cc.add(_v.fromBufferAttribute(pos, k)); cn.x += nor.getX(k); cn.y += nor.getY(k); cn.z += nor.getZ(k); nc++; }
    if (nc) { cc.multiplyScalar(1 / nc); cn.normalize(); } else { cc.copy(w); cn.copy(dir).negate(); }
    for (let k = 0; k < n; k++) {
      const h = _v.fromBufferAttribute(pos, k).sub(cc).dot(cn);   // 0 on the cap plane, negative towards the fingers
      if (isCap(k) || h > -0.004) { col[k * 3] = 0.13; col[k * 3 + 1] = 0.14; col[k * 3 + 2] = 0.17; continue; }   // cap and sleeve edge (dark)
      if (h > -0.011) this.cuff.push(k);                                                                            // team band
      col[k * 3] = 1; col[k * 3 + 1] = 1; col[k * 3 + 2] = 1;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.mesh.material = new THREE.MeshStandardMaterial({ color: 0xd9a38a, roughness: 0.62, metalness: 0, vertexColors: true });
    this.teamHex = -1;
    this.t = { trig: 0, it: 0, sq: 0, tt: 0, ws: 1, wa: 0, wb: 0, wr: 0, sx: 0, sy: 0 };   // smoothed inputs (thumb weights: stick / A / B / rest)
  }
  setTeam(hex) {
    if (hex === this.teamHex) return; this.teamHex = hex;
    _c.setHex(hex); const a = this.mesh.geometry.attributes.color, skin = _c2.setHex(0xd9a38a);
    // the material colour multiplies the vertex colour: cuff = team / skin
    for (const k of this.cuff) a.setXYZ(k, _c.r / skin.r * 0.8, _c.g / skin.g * 0.8, _c.b / skin.b * 0.8);
    a.needsUpdate = true;
  }
  // forward kinematics: this.ang -> joint poses (hand space) -> bones
  fk(ang = this.ang, apply = true) {
    const P = this.P, Q = this.Q, s = this.sgn;
    P[0].copy(this.rp[0]); Q[0].copy(this.rq[0]);
    for (let j = 1; j < NJ; j++) {
      const p = PARENT[j];
      P[j].copy(this.lp[j]).applyQuaternion(Q[p]).add(P[p]);
      _e.set(-ang[j * 3], s * ang[j * 3 + 1], s * ang[j * 3 + 2]);
      Q[j].copy(Q[p]).multiply(this.lq[j]).multiply(_q.setFromEuler(_e));
    }
    if (apply) for (let j = 0; j < NJ; j++) { this.bones[j].position.copy(P[j]); this.bones[j].quaternion.copy(Q[j]); }
  }
  sm(key, v) { const T = this.t; T[key] += (v - T[key]) * this.k; return T[key]; }   // exponential smoothing of one input
  // controller-held pose from the controller's component states
  animate(ctrl, dt) {
    const T = this.t, k = 1 - Math.exp(-RATE * dt), A = this.ang, PS = this.poses;
    const tr = ctrl.trigger, sq = ctrl.squeeze, st = ctrl.stick, ba = ctrl.btnA, bb = ctrl.btnB, re = ctrl.rest;
    this.k = k;
    const trig = this.sm('trig', tr ? tr.button : 0), it = this.sm('it', tr && tr.touched ? 1 : 0), g = this.sm('sq', sq ? sq.button : 0);
    const onS = st && (st.touched || st.state > 1) ? 1 : 0, onA = ba && ba.touched ? 1 : 0, onB = bb && bb.touched ? 1 : 0, onR = re && re.touched ? 1 : 0;
    const tt = this.sm('tt', onS || onA || onB || onR ? 1 : 0);
    // where the thumb rests: last thing touched wins (stick if several), weights stay when released so it lifts from the same place
    if (onS || onA || onB || onR) {
      const ws = onS ? 1 : 0, wa = !onS && onA ? 1 : 0, wb = !onS && !onA && onB ? 1 : 0, wr = !onS && !onA && !onB && onR ? 1 : 0;
      this.sm('ws', ws); this.sm('wa', wa); this.sm('wb', wb); this.sm('wr', wr);
    }
    const sx = this.sm('sx', st ? st.xAxis : 0), sy = this.sm('sy', st ? st.yAxis : 0);
    // index
    for (let j = INDEX[0]; j <= INDEX[1]; j++) for (let a = 0; a < 3; a++) {
      const i = j * 3 + a; A[i] = PS.point[i] + (PS.trig[i] - PS.point[i]) * it + (PS.pull[i] - PS.trig[i]) * trig;
    }
    // middle, ring, pinky
    for (let i = GRIP3[0] * 3; i < GRIP3[1] * 3 + 3; i++) A[i] = PS.open[i] + (PS.closed[i] - PS.open[i]) * g;
    // thumb: blend of the touch poses, lifted by (1 - tt); on the stick it follows the deflection
    const wsum = T.ws + T.wa + T.wb + T.wr || 1;
    for (let j = THUMB[0]; j <= THUMB[1]; j++) for (let a = 0; a < 3; a++) {
      const i = j * 3 + a, on = (PS.stick[i] * T.ws + PS.a[i] * T.wa + PS.b[i] * T.wb + PS.rest[i] * T.wr) / wsum;
      A[i] = PS.up[i] + (on - PS.up[i]) * tt;
    }
    const sw = T.ws / wsum * tt;
    A[3 * 1 + 1] += sx * 0.12 * sw; A[3 * 1] += -sy * 0.1 * sw;
    this.fk();
  }
  // tracked hand: joint matrices (dolly space, 16 floats each) straight to the bones
  fromJoints(mats) {
    for (let j = 0; j < NJ; j++) { _m.fromArray(mats, j * 16); _m.decompose(this.bones[j].position, this.bones[j].quaternion, _s); }
  }
}
const _c2 = new THREE.Color();

// ------------------------------------------------------------------ fitting the hand to the controller (load / tuneHand only; allocates)
// Signed distance to the controller surface (grip space), nearest vertex + its normal, on a 1 cm hash grid. Built for the current button state.
class Sdf {
  constructor(ctrl) {
    const m = ctrl.mesh, g = m.geometry, pos = g.attributes.position, nor = g.attributes.normal, v = new THREE.Vector3();
    ctrl.root.updateMatrixWorld(true); m.skeleton.update();
    const C = 0.015, cells = new Map(), seen = new Set(), P = [], N = [];
    for (let k = 0; k < pos.count; k++) {
      m.getVertexPosition(k, v);
      const key = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)},${nor.getX(k).toFixed(2)}`;
      if (seen.has(key)) continue; seen.add(key);
      const i = P.length / 3; P.push(v.x, v.y, v.z); N.push(nor.getX(k), nor.getY(k), nor.getZ(k));
      const ck = `${Math.floor(v.x / C)},${Math.floor(v.y / C)},${Math.floor(v.z / C)}`;
      (cells.get(ck) || cells.set(ck, []).get(ck)).push(i);
    }
    Object.assign(this, { C, cells, P, N });
  }
  dist(p) {   // > 0 outside; 0.02 = far from everything
    const { C, cells, P, N } = this, cx = Math.floor(p.x / C), cy = Math.floor(p.y / C), cz = Math.floor(p.z / C);
    let best = Infinity, bi = -1;
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const l = cells.get(`${cx + x},${cy + y},${cz + z}`); if (!l) continue;
      for (const i of l) { const dx = p.x - P[i * 3], dy = p.y - P[i * 3 + 1], dz = p.z - P[i * 3 + 2], d = dx * dx + dy * dy + dz * dz; if (d < best) { best = d; bi = i; } }
    }
    if (bi < 0) return 0.03;
    return (p.x - P[bi * 3]) * N[bi * 3] + (p.y - P[bi * 3 + 1]) * N[bi * 3 + 1] + (p.z - P[bi * 3 + 2]) * N[bi * 3 + 2];
  }
}
const FING_R = [0.0085, 0.0078, 0.007];   // finger radius: proximal, intermediate, distal phalanx (m)
// Close a finger from its current angles until its phalanges touch the controller (grasp closing: a link that touches stops the joints that move it,
// the distal joints keep curling). chain = [mcp, pip, dip, tip] joint indices; ratio = curl speed per joint; max = flex limits; slack = gap kept (m).
function closeFinger(hand, ang, chain, sdf, toGrip, slack, ratio = [1, 1.1, 0.75], max = [1.55, 1.75, 1.2]) {
  const p = new THREE.Vector3(), prev = [0, 0, 0];
  let locked = -1;
  const hits = (s) => {
    const a = hand.P[chain[s]], b = hand.P[chain[s + 1]];
    for (const t of [0.35, 0.7, 1]) { p.lerpVectors(a, b, t).applyMatrix4(toGrip); if (sdf.dist(p) < FING_R[s] + slack) return true; }
    return false;
  };
  for (let it = 0; it < 160 && locked < 2; it++) {
    let moved = false;
    for (let k = locked + 1; k < 3; k++) { const i = chain[k] * 3; prev[k] = ang[i]; const nv = Math.min(max[k], ang[i] + 0.015 * ratio[k]); if (nv > ang[i]) { ang[i] = nv; moved = true; } }
    if (!moved) break;
    hand.fk(ang, false);
    for (let s = 2; s > locked; s--) if (hits(s)) { for (let k = locked + 1; k <= s; k++) ang[chain[k] * 3] = prev[k]; locked = s; hand.fk(ang, false); break; }
  }
  return locked;
}
// Coordinate descent on a few joint angles so that a fingertip joint reaches a target point (hand space).
function reach(hand, a, tipJ, target, params, iters = 150) {
  let step = 0.2;
  const err = () => { hand.fk(a, false); return hand.P[tipJ].distanceToSquared(target); };
  let e = err();
  for (let it = 0; it < iters && step > 0.002; it++) {
    let improved = false;
    for (const [i, lo, hi] of params) for (const d of [step, -step]) {
      const old = a[i], nv = Math.min(hi, Math.max(lo, old + d));
      if (nv === old) continue;
      a[i] = nv; const e2 = err();
      if (e2 < e) { e = e2; improved = true; break; } else a[i] = old;
    }
    if (!improved) step *= 0.5;
  }
  return Math.sqrt(e);
}
const fakePad = (b) => ({ buttons: Array.from({ length: 7 }, (_, i) => ({ value: b[i] || 0, pressed: (b[i] || 0) > 0.9, touched: (b[i] || 0) > 0 })), axes: [0, 0, 0, 0] });

// ------------------------------------------------------------------ loading
let assets = null;
export function loadVRAssets() {
  if (assets) return assets;
  const L = new GLTFLoader(), gl = (p) => L.loadAsync(BASE + p);
  assets = Promise.all([fetch(BASE + 'meta-quest-touch-plus/profile.json').then(r => r.json()),
    gl('meta-quest-touch-plus/left.glb'), gl('meta-quest-touch-plus/right.glb'), gl('generic-hand/left.glb'), gl('generic-hand/right.glb')])
    .then(([prof, cl, cr, hl, hr]) => ({ prof, cl, cr, hl, hr }));
  return assets;
}

// One side: grip -> rig (TUNE) -> [controller, hand placement -> hand]
export class Side {
  constructor(a, left) {
    this.left = left;
    this.ctrl = new Controller(left ? a.cl : a.cr, a.prof.layouts[left ? 'left' : 'right'], left);
    this.hand = new Hand(left ? a.hl : a.hr, left);
    this.rig = new THREE.Group(); this.rig.name = left ? 'hand_rig_l' : 'hand_rig_r'; this.rig.visible = false;
    this.place = new THREE.Group(); this.rig.add(this.ctrl.root, this.place); this.place.add(this.hand.scene);
    this.track = new THREE.Group(); this.track.name = 'tracked_hand'; this.track.visible = false;   // tracked hand: identity in dolly space
    // over the VR menu: it is transparent, without depth test (renderOrder 30) so the table never cuts it, and was drawn over the hands.
    // Hands go to the transparent pass after it (opacity 1, depth test and write on: the table still hides them, fingers sort right).
    for (const o of [this.ctrl.root, this.hand.scene]) o.traverse(m => { if (m.isMesh) { m.renderOrder = 40; m.material.transparent = true; } });
    this.solve();
  }
  // hand placement (HAND, mirrored for the left) and the finger poses fitted to this controller
  solve() {
    const s = this.left ? -1 : 1, h = this.hand, c = this.ctrl, PS = h.poses;
    this.place.position.set(s * HAND.x, HAND.y, HAND.z);
    this.place.quaternion.setFromEuler(new THREE.Euler(HAND.rx * D2R, s * HAND.ry * D2R, s * HAND.rz * D2R));
    // HAND rotates the wrist joint frame; the armature (bones in hand space) is placed so that the middle knuckle lands on HAND.x/y/z
    this.place.quaternion.multiply(_q2.copy(h.rq[0]).invert());
    this.place.position.sub(_v.copy(h.rp[11]).applyQuaternion(this.place.quaternion));
    this.place.updateMatrix();
    const toGrip = this.place.matrix.clone(), toHand = toGrip.clone().invert(), gripPt = (n) => c.root.getObjectByName(n)?.position.clone();
    // face normal of the controller head = opposite of the A/X press direction
    const bmin = gripPt(this.left ? 'x_button_pressed_min' : 'a_button_pressed_min'), bmax = gripPt(this.left ? 'x_button_pressed_max' : 'a_button_pressed_max');
    const nUp = this.nUp = bmin && bmax ? bmin.clone().sub(bmax).normalize() : new THREE.Vector3(0, 0.83, -0.55);
    const sdf0 = this.sdf0 || (this.sdf0 = new Sdf(c));
    // thumb targets: the top of the stick / buttons / thumb rest, thumb tip joint one finger radius above
    const top = (name, d, dir = nUp) => {
      const o = c.root.getObjectByName(name); if (!o) return null;
      const g = o.geometry, m = new THREE.Matrix4().copy(c.root.matrixWorld).invert().multiply(o.matrixWorld), v = new THREE.Vector3(), sum = new THREE.Vector3();
      let best = -Infinity, n = 0;
      for (let k = 0; k < g.attributes.position.count; k++) best = Math.max(best, v.fromBufferAttribute(g.attributes.position, k).applyMatrix4(m).dot(dir));
      for (let k = 0; k < g.attributes.position.count; k++) if (v.fromBufferAttribute(g.attributes.position, k).applyMatrix4(m).dot(dir) > best - 0.0015) { sum.add(v); n++; }
      return sum.multiplyScalar(1 / n).addScaledVector(dir, d);
    };
    const T = { stick: top('thumbstick', 0.0085), a: top(this.left ? 'x_button' : 'a_button', 0.0075), b: top(this.left ? 'y_button' : 'b_button', 0.0075) };
    const rn = gripPt('thumbrest_pressed_value'); if (rn) T.rest = rn.addScaledVector(nUp, 0.0075);
    const nTr = new THREE.Vector3(0, -0.6, -0.8).normalize(); T.trig = top('trigger', 0, nTr); T.sq = top('squeeze', 0, new THREE.Vector3(-s, 0, 0)); this.targets = T;
    const th = [[3, -0.6, 1.4], [4, -0.8, 0.9], [5, -0.6, 0.6], [6, -0.3, 1.2], [9, -0.3, 1.2]];
    this.err = {};
    for (const k of ['stick', 'a', 'b', 'rest']) {
      PS[k].set(POSES.stick);
      if (T[k]) this.err[k] = +reach(h, PS[k], 4, T[k].clone().applyMatrix4(toHand), th).toFixed(4);
    }
    PS.up.set(POSES.up);
    // index: points (no touch), rests on the trigger, pulls it (trigger pressed); middle / ring / pinky: around the handle, released / squeezed
    const FINGERS = [[11, 12, 13, 14], [16, 17, 18, 19], [21, 22, 23, 24]], IDX = [6, 7, 8, 9];
    const fit = (pose, from, chains, sdf, slack, key) => { pose.set(from); this.lock[key] = chains.map(ch => closeFinger(h, pose, ch, sdf, toGrip, slack)); };
    this.lock = {};
    fit(PS.open, POSES.flat, FINGERS, sdf0, 0.006, 'open');
    if (!this.sdf1) { c.update(fakePad({ 0: 1, 1: 1 })); this.sdf1 = new Sdf(c); this.trigPressed = top('trigger', 0, nTr); c.update(fakePad({})); c.root.updateMatrixWorld(true); } const sdf1 = this.sdf1;
    // index pad on the front of the trigger (tip joint one finger radius in front of it), released and pulled
    const ip = [[15, -0.15, 0.3], [16, -0.3, 0.3], [18, -0.1, 1.5], [19, -0.5, 0.5], [21, 0, 1.6], [24, 0, 1.2]];
    PS.trig.set(POSES.point); this.err.trig = +reach(h, PS.trig, 9, T.trig.clone().addScaledVector(nTr, 0.0075).applyMatrix4(toHand), ip).toFixed(4);
    PS.pull.set(PS.trig); this.err.pull = +reach(h, PS.pull, 9, this.trigPressed.clone().addScaledVector(nTr, 0.0075).applyMatrix4(toHand), ip).toFixed(4);
    fit(PS.closed, PS.open, FINGERS, sdf1, 0.0005, 'closed');
    // contact report for tuning: palm and knuckles vs the controller (negative = inside)
    h.fk(PS.closed, false);
    const pv = new THREE.Vector3();
    this.palm = [6, 11, 16, 21, 5, 10, 15, 20, 2, 1].map(j => +sdf1.dist(pv.copy(h.P[j]).applyMatrix4(toGrip)).toFixed(4)); this.err.palm = Math.min(...this.palm.slice(0, 8));
    h.fk(h.ang);
  }
  update(src, dt, team) {
    const gp = src.gamepad;
    this.ctrl.update(gp);
    this.hand.setTeam(team);
    this.hand.animate(this.ctrl, dt);
  }
}

export class VRHands {
  constructor(vr) {
    this.vr = vr; this.l = null; this.r = null; this.laserZ = 0;
    this.mats = new Float32Array(NJ * 16); this.jsrc = [null, null]; this.jsp = [[], []];
    loadVRAssets().then(a => { this.l = new Side(a, true); this.r = new Side(a, false); }).catch(e => console.warn('vr hands', e?.message || e));
  }
  tune(pitchDeg = 0, x = 0, y = 0, z = 0) { TUNE.pitch = pitchDeg * D2R; TUNE.x = x; TUNE.y = y; TUNE.z = z; }
  tuneHand(x = HAND.x, y = HAND.y, z = HAND.z, rx = HAND.rx, ry = HAND.ry, rz = HAND.rz) {
    Object.assign(HAND, { x, y, z, rx, ry, rz }); for (const s of [this.l, this.r]) s?.solve(); return { ...HAND, err: this.r?.err };
  }
  update(dt) {
    const vr = this.vr, hex = TEAM_COLORS[vr.ui?.team || 1] ?? 0x2f86e0, L = this.l, R = this.r;
    if (!L || !R) return;
    L.seen = R.seen = false;
    let rightTracked = false;
    for (let i = 0; i < 2; i++) {
      const c = i ? vr.controller1 : vr.controller0, g = i ? vr.grip1 : vr.grip0, src = c.inputSource;
      const s = src ? (src.handedness === 'left' ? L : src.handedness === 'right' ? R : null) : null;
      if (!s) continue;
      s.seen = true;
      if (src.hand) {   // hand tracking: the hand follows the XRHand joints, no controller
        s.rig.visible = false;
        if (this.trackHand(i, s, src)) { if (!s.left) rightTracked = true; } else s.track.visible = false;
        continue;
      }
      s.track.visible = false;
      if (s.hand.scene.parent !== s.place) s.place.add(s.hand.scene);
      if (s.rig.parent !== g) g.add(s.rig);
      s.rig.visible = true;
      s.rig.position.set(TUNE.x, TUNE.y, TUNE.z); s.rig.rotation.x = TUNE.pitch;
      s.update(src, dt, hex);
      if (c === vr.rightController) {   // ray starts at the controller tip: its distance along the aim -Z axis
        s.ctrl.tip.updateWorldMatrix(true, false); s.ctrl.tip.getWorldPosition(_p); c.worldToLocal(_p);
        this.laserZ = _p.z < -0.3 ? -0.3 : _p.z > 0 ? 0 : _p.z;
      }
    }
    if (!L.seen) L.rig.visible = L.track.visible = false;   // no input source for this hand (disconnected / not tracked)
    if (!R.seen) R.rig.visible = R.track.visible = false;
    if (rightTracked) this.laserZ = 0;
  }
  trackHand(i, s, src) {
    const gl = this.vr.r.gl, frame = gl.xr.getFrame(), ref = gl.xr.getReferenceSpace();
    if (!frame || !ref) return false;
    if (this.jsrc[i] !== src.hand) { this.jsrc[i] = src.hand; this.jsp[i] = JOINTS.map(n => src.hand.get(n)); }   // once per new XRHand
    if (frame.fillPoses) { if (!frame.fillPoses(this.jsp[i], ref, this.mats)) return false; }
    else for (let j = 0; j < NJ; j++) { const p = frame.getJointPose(this.jsp[i][j], ref); if (!p) return false; this.mats.set(p.transform.matrix, j * 16); }   // no fillPoses: per joint
    if (s.track.parent !== this.vr.dolly) this.vr.dolly.add(s.track);
    if (s.hand.scene.parent !== s.track) s.track.add(s.hand.scene);
    s.hand.scene.position.set(0, 0, 0); s.hand.scene.quaternion.identity();
    s.hand.setTeam(TEAM_COLORS[this.vr.ui?.team || 1] ?? 0x2f86e0);
    s.hand.fromJoints(this.mats);
    s.track.visible = true;
    return true;
  }
}
