// Visual effects: sprite-atlas particles (4 THREE.Points systems), pooled shockwave rings, ground decals, streaks (tracers and beams).
// No VR / game dependencies: only three. Budget: 4 (Points) + 1 (rings) + 1 (decals) + 1 (streaks) = 7 draw calls for everything.
// Atlases (assets/fx, see assets/CREDITS.md): fx_add (CC0 Kenney, additive: explosion x9, muzzle x3, spark, star, soft circle, flare),
// fx_smoke (CC0 Kenney, alpha: black smoke x8, white puff x8), fx_decal (CC0 Kenney, scorch x3, dirt), fx_boom (CC0 Unity Labs flipbooks,
// tools/build_fx_boom.py: 3 explosions fire -> smoke, 5x5 frames, and a looping fireball 8x8). Without a loaded atlas particles fall back
// to the procedural soft sprites, so the effects never depend on a successful download.
import * as THREE from 'three';

export const BOOK = { EXP: 0, EXPN: 3, FIRE: 3 };   // fx_boom quadrants: 0..2 explosions, 3 looping fireball
export const CELL = { EXP: 0, EXPN: 9, MUZ: 9, MUZN: 3, SPARK: 12, STAR: 13, SOFT: 14, FLARE: 15, DARK: 0, DARKN: 8, PUFF: 8, PUFFN: 8 };
const R = Math.random, TAU = Math.PI * 2;
const rr = (a, b) => a + R() * (b - a);

const PART_VS = `
attribute float size; attribute vec3 color; attribute float alpha; attribute vec4 spr;
varying vec3 vColor; varying float vAlpha; varying vec2 vS; uniform float scale;
void main(){ vColor=color; vAlpha=alpha; vS=vec2(spr.x<0.?-1.:spr.x+floor(min(spr.w,0.999)*max(spr.y,1.)), spr.z);
  vec4 mv=modelViewMatrix*vec4(position,1.0);
  gl_PointSize = clamp(size*scale/-mv.z, 1.0, 512.0); gl_Position=projectionMatrix*mv; }`;
const PART_FS = `uniform sampler2D map; uniform float useTex; uniform float add;
varying vec3 vColor; varying float vAlpha; varying vec2 vS;
void main(){
  if (vS.x >= 0.0 && useTex > 0.5) {
    vec2 q = gl_PointCoord - 0.5; float c = cos(vS.y), s = sin(vS.y); q = vec2(c*q.x - s*q.y, s*q.x + c*q.y) + 0.5;
    if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) discard;
    vec2 cell = vec2(mod(vS.x, 4.0), floor(vS.x / 4.0));
    vec4 t = texture2D(map, (cell + q * 0.96 + 0.02) / 4.0);
    if (add > 0.5) gl_FragColor = vec4(vColor * t.rgb * vAlpha, t.a * vAlpha);
    else gl_FragColor = vec4(vColor * (0.55 + 0.9 * t.r), t.a * vAlpha);
    return;
  }
  float d = length(gl_PointCoord - 0.5);
  if (add > 0.5) { float a = smoothstep(0.5, 0.0, d); a *= a; gl_FragColor = vec4(vColor * a * vAlpha * 1.6, a * vAlpha); }
  else gl_FragColor = vec4(vColor, smoothstep(0.5, 0.1, d) * vAlpha);
}`;

// fx_boom: spr = (book, loops over the life, rotation, age). Frames are cross-faded; books 0..2 straight alpha (drawn premultiplied),
// book 3 (fireball on black) adds light (alpha 0 under premultiplied blending = additive).
const BOOM_VS = `
attribute float size; attribute vec3 color; attribute float alpha; attribute vec4 spr;
varying vec3 vColor; varying float vAlpha; varying vec4 vB; uniform float scale;
void main(){ vColor=color; vAlpha=alpha; vB=spr; vec4 mv=modelViewMatrix*vec4(position,1.0);
  gl_PointSize = clamp(size*scale/-mv.z, 1.0, 1024.0); gl_Position=projectionMatrix*mv; }`;
const BOOM_FS = `uniform sampler2D map; uniform float useTex;
varying vec3 vColor; varying float vAlpha; varying vec4 vB;
void main(){
  vec2 q = gl_PointCoord - 0.5; float c = cos(vB.z), s = sin(vB.z); q = vec2(c*q.x - s*q.y, s*q.x + c*q.y) + 0.5;
  if (useTex < 0.5) { float a = smoothstep(0.5, 0.0, length(q - 0.5)); a *= a * vAlpha; gl_FragColor = vec4(vColor * vec3(1.0, 0.6, 0.25) * a, a * 0.5); return; }
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) discard;
  bool fire = vB.x > 2.5; float g = fire ? 8.0 : 5.0, N = g * g;
  float f = fract(min(vB.w, 0.999) * max(vB.y, 0.001)) * N, f0 = floor(f), k = f - f0;
  float f1 = fire ? mod(f0 + 1.0, N) : min(f0 + 1.0, N - 1.0);
  vec2 o = vec2(mod(vB.x, 2.0), floor(vB.x / 2.0)) * 0.5, qq = q * 0.98 + 0.01;
  vec4 t = mix(texture2D(map, o + (vec2(mod(f0, g), floor(f0 / g)) + qq) / g * 0.5), texture2D(map, o + (vec2(mod(f1, g), floor(f1 / g)) + qq) / g * 0.5), k);
  if (fire) gl_FragColor = vec4(t.rgb * vColor * vAlpha, 0.0);
  else { float a = t.a * vAlpha; gl_FragColor = vec4(t.rgb * vColor * a, a); }
}`;

// Streaks: camera-facing quads between a head and a tail point (one instanced draw). Tracer = bright head, fading tail;
// beam (negative width in icw.w) = even along the length. Width never drops under ~1.5 px, so far tracers still read.
const STREAK_VS = `
attribute vec2 corner; attribute vec3 ia; attribute vec3 ib; attribute vec4 icw;
varying vec3 vCol; varying vec2 vUv; varying float vStyle;
void main(){
  vec3 a = (modelMatrix * vec4(ia, 1.0)).xyz, b = (modelMatrix * vec4(ib, 1.0)).xyz;
  vec3 p = mix(a, b, corner.y), toCam = cameraPosition - p;
  vec3 side = cross(b - a, toCam); float sl = length(side); side = sl > 1e-6 ? side / sl : vec3(1.0, 0.0, 0.0);
  p += side * corner.x * max(abs(icw.w), length(toCam) * 0.0016);
  vCol = icw.rgb; vUv = corner; vStyle = icw.w < 0.0 ? 1.0 : 0.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const STREAK_FS = `varying vec3 vCol; varying vec2 vUv; varying float vStyle;
void main(){
  float x = abs(vUv.x), edge = 1.0 - x * x;
  float along = vStyle > 0.5 ? 1.0 : pow(1.0 - vUv.y, 1.6);
  float core = smoothstep(0.55, 0.0, x) * (vStyle > 0.5 ? 0.7 : along);
  gl_FragColor = vec4(mix(vCol, vec3(1.0), core * 0.65) * edge * along, 1.0);
}`;

export class Streaks {
  constructor(scene, cap, order = 6) {
    this.cap = cap; this.n = 0;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-1, 0, 1, 0, -1, 1, 1, 1], 2));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    this.a = new Float32Array(cap * 3); this.b = new Float32Array(cap * 3); this.cw = new Float32Array(cap * 4);
    for (const [k, arr, s] of [['ia', this.a, 3], ['ib', this.b, 3], ['icw', this.cw, 4]]) g.setAttribute(k, new THREE.InstancedBufferAttribute(arr, s).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0; this.geo = g;
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: STREAK_VS, fragmentShader: STREAK_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = order; this.mesh.visible = false; scene.add(this.mesh);
  }
  // head (x,y,z) -> tail (tx,ty,tz); w = half width in world units; beam = even brightness along the length
  put(x, y, z, tx, ty, tz, r, g, b, w, beam) {
    if (this.n >= this.cap) return;
    const i = this.n++, k = i * 3, c = i * 4, A = this.a, B = this.b, C = this.cw;
    A[k] = x; A[k + 1] = y; A[k + 2] = z; B[k] = tx; B[k + 1] = ty; B[k + 2] = tz;
    C[c] = r; C[c + 1] = g; C[c + 2] = b; C[c + 3] = beam ? -w : w;
  }
  flush() {
    const g = this.geo; g.instanceCount = this.n; this.mesh.visible = this.n > 0;
    if (this.n) for (const k of ['ia', 'ib', 'icw']) { const at = g.attributes[k]; at.clearUpdateRanges(); at.addUpdateRange(0, this.n * at.itemSize); at.needsUpdate = true; }
    this.n = 0;   // refilled every frame (nothing lingers once the game stops feeding it)
  }
}

export class Particles {
  constructor(n, additive, order, tex, boom) {
    this.n = n; this.count = 0;
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3); this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n); this.alpha = new Float32Array(n); this.life = new Float32Array(n); this.max = new Float32Array(n);
    this.grow = new Float32Array(n); this.grav = new Float32Array(n); this.drag = new Float32Array(n); this.a0 = new Float32Array(n);
    this.spr = new Float32Array(n * 4); this.spin = new Float32Array(n);   // spr: first cell, frames, rotation, age 0..1
    const g = new THREE.BufferGeometry();
    for (const [k, a, s] of [['position', this.pos, 3], ['color', this.col, 3], ['size', this.size, 1], ['alpha', this.alpha, 1], ['spr', this.spr, 4]])
      g.setAttribute(k, new THREE.BufferAttribute(a, s).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 800 }, map: { value: tex || null }, useTex: { value: 0 }, add: { value: additive ? 1 : 0 } },
      vertexShader: boom ? BOOM_VS : PART_VS, fragmentShader: boom ? BOOM_FS : PART_FS,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    if (boom) Object.assign(this.mat, { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false; this.points.renderOrder = order ?? (additive ? 5 : 4);
  }
  // opts: alpha, grow (size/s), grav, drag, cell (atlas cell, -1 = procedural sprite), frames (flipbook length), rot, spin (rad/s)
  emit(x, y, z, vx, vy, vz, size, life, r, g, b, opts = {}) {
    if (this.count >= this.n) return;
    const i = this.count++, k = i * 3, s = i * 4;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z; this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
    this.col[k] = r; this.col[k + 1] = g; this.col[k + 2] = b;
    this.size[i] = size; this.life[i] = life; this.max[i] = life; this.a0[i] = opts.alpha ?? 1; this.alpha[i] = this.a0[i];
    this.grow[i] = opts.grow ?? 0; this.grav[i] = opts.grav ?? 0; this.drag[i] = opts.drag ?? 0.98;
    this.spr[s] = opts.cell ?? -1; this.spr[s + 1] = opts.frames ?? 1; this.spr[s + 2] = opts.rot ?? 0; this.spr[s + 3] = 0; this.spin[i] = opts.spin ?? 0;
  }
  update(dt) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.kill(i); continue; }
      const k = i * 3, d = Math.pow(this.drag[i], dt * 60);
      this.vel[k] *= d; this.vel[k + 1] = this.vel[k + 1] * d - this.grav[i] * dt; this.vel[k + 2] *= d;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const f = this.life[i] / this.max[i];
      this.alpha[i] = this.a0[i] * Math.min(1, f * 2.5);
      this.spr[i * 4 + 3] = 1 - f; this.spr[i * 4 + 2] += this.spin[i] * dt;
      i++;
    }
    for (const a of ['position', 'color', 'size', 'alpha', 'spr']) { const at = this.geo.attributes[a]; at.clearUpdateRanges(); at.addUpdateRange(0, Math.max(1, this.count) * at.itemSize); at.needsUpdate = true; }
    this.geo.setDrawRange(0, this.count);
    this.points.visible = this.count > 0;
  }
  kill(i) {
    const j = --this.count;
    if (i === j) return;
    for (let c = 0; c < 3; c++) { this.pos[i * 3 + c] = this.pos[j * 3 + c]; this.vel[i * 3 + c] = this.vel[j * 3 + c]; this.col[i * 3 + c] = this.col[j * 3 + c]; }
    for (let c = 0; c < 4; c++) this.spr[i * 4 + c] = this.spr[j * 4 + c];
    this.size[i] = this.size[j]; this.alpha[i] = this.alpha[j]; this.life[i] = this.life[j]; this.max[i] = this.max[j]; this.spin[i] = this.spin[j];
    this.grow[i] = this.grow[j]; this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j]; this.a0[i] = this.a0[j];
  }
  clear() { this.count = 0; }
}

const DECAL_VS = `attribute float dcell; attribute float dalpha; varying vec2 vUv; varying float vA; varying float vC;
void main(){ vUv = uv; vA = dalpha; vC = dcell; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`;
const DECAL_FS = `uniform sampler2D map; varying vec2 vUv; varying float vA; varying float vC;
void main(){ vec2 cell = vec2(mod(vC, 2.0), floor(vC / 2.0)); vec4 t = texture2D(map, (cell + vec2(vUv.x, 1.0 - vUv.y) * 0.96 + 0.02) / 2.0);
  gl_FragColor = vec4(vec3(0.02, 0.018, 0.015), t.a * vA * 0.85); }`;

export class Fx {
  // opt: { lite, glowN, smokeN, projN, ringN, decalN, tracerN }, caps default to PC values
  constructor(scene, opt = {}) {
    const lite = this.lite = !!opt.lite;
    this.scene = scene; this.exN = 0; this.maxEx = lite ? 6 : 24; this.loaded = 0;
    const tl = new THREE.TextureLoader(), base = new URL('../assets/fx/', import.meta.url).href;
    const load = (f, cb) => { const t = tl.load(base + f, () => cb(t), undefined, () => {}); t.flipY = false; t.anisotropy = 1; return t; };
    const addT = load('fx_add.png', () => { this.glow.mat.uniforms.useTex.value = 1; this.loaded++; });
    const smkT = load('fx_smoke.png', () => { this.smoke.mat.uniforms.useTex.value = 1; this.loaded++; });
    const decT = load('fx_decal.png', () => { this.decalMat.uniforms.map.value = decT; this.decalMesh.visible = this.decalN > 0; this.loaded++; });
    this.glow = new Particles(opt.glowN ?? (lite ? 1400 : 7000), true, 5, addT);
    this.smoke = new Particles(opt.smokeN ?? (lite ? 900 : 5000), false, 4, smkT);
    this.proj = new Particles(opt.projN ?? (lite ? 800 : 3000), true, 5);   // projectile heads / trails: procedural sprites only
    const boomT = load(lite ? 'fx_boom_lite.webp' : 'fx_boom.webp', () => { this.boom.mat.uniforms.useTex.value = 1; this.loaded++; });
    this.boom = new Particles(opt.boomN ?? (lite ? 400 : 1600), false, 4.5, boomT, true);   // flipbook explosions and fire (premultiplied)
    scene.add(this.glow.points, this.smoke.points, this.proj.points, this.boom.points);
    this.timers = [];   // delayed recipe steps (nuke phases): [seconds left, fn]
    // shockwave rings: one InstancedMesh, fading through instance colour (additive)
    const RN = this.ringCap = opt.ringN ?? (lite ? 12 : 32);
    this.rings = new THREE.InstancedMesh(new THREE.RingGeometry(0.8, 1, lite ? 32 : 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }), RN);
    this.rings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(RN * 3), 3);
    this.rings.frustumCulled = false; this.rings.renderOrder = 3; this.rings.count = 0; this.rings.visible = false;
    this.ringList = []; scene.add(this.rings);
    // ground decals (scorch marks), ring buffer pool
    const DN = this.decalN = opt.decalN ?? 64;
    this.decalMat = new THREE.ShaderMaterial({ uniforms: { map: { value: null } }, vertexShader: DECAL_VS, fragmentShader: DECAL_FS, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const dg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.dCell = new THREE.InstancedBufferAttribute(new Float32Array(DN), 1); this.dAlpha = new THREE.InstancedBufferAttribute(new Float32Array(DN), 1);
    dg.setAttribute('dcell', this.dCell); dg.setAttribute('dalpha', this.dAlpha);
    this.decalMesh = new THREE.InstancedMesh(dg, this.decalMat, DN);
    this.decalMesh.frustumCulled = false; this.decalMesh.renderOrder = 2; this.decalMesh.count = 0; this.decalMesh.visible = false;
    this.decals = []; this.decalHead = 0; this.decalT = 0; this.decalDirty = false; this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3(); this._e = new THREE.Euler();
    scene.add(this.decalMesh);
    // tracers and beams: one instanced quad mesh, refilled every frame by the renderer
    this.streaks = new Streaks(scene, opt.streakN ?? (lite ? 600 : 2400));
  }
  get systems() { return [this.glow, this.smoke, this.proj, this.boom]; }
  setScale(sc) { for (const p of this.systems) p.mat.uniforms.scale.value = sc; }
  // number of draw calls the effects can add (for the budget check)
  get drawCalls() { return this.systems.reduce((n, p) => n + (p.points.visible ? 1 : 0), 0) + (this.rings.visible ? 1 : 0) + (this.decalMesh.visible ? 1 : 0) + (this.streaks.mesh.visible ? 1 : 0); }
  beginProj() { this.proj.clear(); this.streaks.n = 0; }
  clear() { for (const p of this.systems) p.clear(); this.ringList.length = 0; this.decals.length = 0; this.decalHead = 0; this.decalMesh.count = 0; this.rings.count = 0; this.streaks.n = 0; this.timers.length = 0; }

  tracer(x, y, z, dx, dy, dz, len, r, g, b, w = 0.12) {   // (dx,dy,dz) = unit direction of flight, tail trails behind the head
    this.streaks.put(x, y, z, x - dx * len, y - dy * len, z - dz * len, r, g, b, w, false);
  }
  beam(x, y, z, tx, ty, tz, r, g, b, w) { this.streaks.put(x, y, z, tx, ty, tz, r, g, b, w, true); }
  after(t, fn) { this.timers.push([t, fn]); }
  ring(x, y, z, radius, life, hex, mul = 0.9) {
    if (this.ringList.length >= this.ringCap) this.ringList.shift();
    const c = new THREE.Color(hex);
    this.ringList.push({ x, y: y + 0.8, z, r: radius, t: 0, life, cr: c.r * mul, cg: c.g * mul, cb: c.b * mul });
  }
  decal(x, y, z, size, life = 45) {
    const DN = this.decalN; if (!DN) return;
    const i = this.decalHead; this.decalHead = (i + 1) % DN;
    const d = { x, y: y + 0.45, z, size, rot: R() * TAU, t: 0, life, cell: (R() * 3) | 0 };
    this.decals[i] = d; this.decalMesh.count = Math.max(this.decalMesh.count, i + 1); this.decalDirty = true;
    this.dCell.array[i] = d.cell; this.dAlpha.array[i] = 1; this.dCell.needsUpdate = this.dAlpha.needsUpdate = true;
    this._p.set(x, d.y, z); this._e.set(0, d.rot, 0); this._q.setFromEuler(this._e); this._s.set(size, 1, size);
    this.decalMesh.setMatrixAt(i, this._m.compose(this._p, this._q, this._s)); this.decalMesh.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    for (let i = this.timers.length - 1; i >= 0; i--) { const tm = this.timers[i]; if ((tm[0] -= dt) <= 0) { this.timers.splice(i, 1); tm[1](); } }
    this.glow.update(dt); this.smoke.update(dt); this.boom.update(dt);   // proj is refilled and updated by the renderer every frame
    // rings
    const L = this.ringList, m = this._m, mesh = this.rings;
    let n = 0;
    for (let i = 0; i < L.length; i++) {
      const f = L[i]; f.t += dt; const k = f.t / f.life;
      if (k >= 1) { L.splice(i--, 1); continue; }
      const s = f.r * (1 - Math.pow(1 - k, 3)) + 0.1, fade = (1 - k) * (1 - k);
      m.makeScale(s, 1, s).setPosition(f.x, f.y, f.z); mesh.setMatrixAt(n, m); mesh.instanceColor.setXYZ(n, f.cr * fade, f.cg * fade, f.cb * fade); n++;
    }
    mesh.count = n; mesh.visible = n > 0;
    if (n) { mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; }
    // decals fade out over their last 20% (alpha buffer refreshed 2x/s)
    this.decalT += dt;
    if (this.decalDirty && this.decalT > 0.5) {
      this.decalT = 0; let any = false, A = this.dAlpha.array;
      for (let i = 0; i < this.decals.length; i++) { const d = this.decals[i]; if (!d) continue; d.t += 0.5; const a = d.t >= d.life ? 0 : Math.min(1, (d.life - d.t) / (d.life * 0.2)); A[i] = a; if (a > 0) any = true; }
      this.dAlpha.needsUpdate = true; this.decalDirty = any;
    }
    this.streaks.flush();
  }

  // ---- effect recipes (positions in three coordinates: x, up, z). mul = particle quality 0.35 / 0.7 / 1.
  muzzle(x, y, z, size, c, mul = 1) {
    const s = size * 3, rot = R() * TAU;
    this.glow.emit(x, y, z, 0, 0, 0, s, 0.09, c.r, c.g, c.b, { cell: CELL.MUZ + ((R() * CELL.MUZN) | 0), rot, alpha: 0.95 });
    this.glow.emit(x, y, z, 0, 0, 0, s * 0.8, 0.07, 1, 0.95, 0.8, { cell: CELL.FLARE, alpha: 0.6 });
    if (size > 1.2 && R() < mul) this.smoke.emit(x, y, z, rr(-1, 1), rr(0.6, 1.6), rr(-1, 1), size * 1.1, 0.8, 0.5, 0.5, 0.5, { cell: CELL.PUFF + ((R() * CELL.PUFFN) | 0), rot: R() * TAU, grow: 2.2, alpha: 0.28 });
  }
  hit(x, y, z, c, mul = 1) {
    const n = Math.max(1, Math.round(5 * mul));
    for (let i = 0; i < n; i++) this.glow.emit(x, y, z, rr(-8, 8), rr(1, 10), rr(-8, 8), 0.45, rr(0.2, 0.4), c.r, c.g * 0.9, c.b * 0.6, { grav: 20 });
    this.glow.emit(x, y, z, 0, 0, 0, 3, 0.1, 1, 0.8, 0.5, { cell: CELL.STAR, rot: R() * TAU });
    if (R() < 0.5 * mul) this.smoke.emit(x, y, z, rr(-1, 1), rr(0.5, 1.5), rr(-1, 1), 1.2, 0.7, 0.45, 0.42, 0.4, { cell: CELL.PUFF + ((R() * 8) | 0), grow: 1.5, alpha: 0.35 });
  }
  miss(x, y, z, water, mul = 1) {
    if (water) { for (let i = 0; i < Math.max(2, Math.round(5 * mul)); i++) this.smoke.emit(x, y, z, rr(-2, 2), rr(6, 14), rr(-2, 2), rr(1, 1.6), 0.9, 0.85, 0.92, 1, { cell: CELL.PUFF + ((R() * 8) | 0), grav: 22, alpha: 0.8, rot: R() * TAU }); }
    else for (let i = 0; i < Math.max(1, Math.round(2 * mul)); i++) this.smoke.emit(x, y, z, rr(-2, 2), rr(2, 5), rr(-2, 2), rr(1.4, 2), 1, 0.48, 0.4, 0.32, { cell: CELL.PUFF + ((R() * 8) | 0), grow: 2.2, alpha: 0.55, rot: R() * TAU });
  }
  // sz = blast size (~1.5 small unit .. 6+ building); o: { air, water, struct, oc, ground (can scorch), waterY }
  explosion(x, y, z, sz, o = {}, mul = 1) {
    const big = !!o.struct || sz > 6, cheap = ++this.exN > this.maxEx;
    const tint = o.oc ? [0.75, 0.9, 1.3] : [1, 1, 1];
    // fireball flipbook (fire -> black smoke); life grows with the blast, sprite ~2x the visible cloud
    const fb = (px, py, pz, s, life, a = 1) => this.boom.emit(px, py, pz, rr(-0.3, 0.3), rr(0.8, 2.4), rr(-0.3, 0.3), s, life, tint[0], tint[1], tint[2], { cell: (R() * BOOK.EXPN) | 0, rot: R() * TAU, spin: rr(-0.25, 0.25), grow: s * 0.15, alpha: a, drag: 0.97 });
    this.glow.emit(x, y + sz * 0.3, z, 0, 0, 0, sz * (big ? 2.6 : 4), 0.12, 1, o.oc ? 0.95 : 0.75, o.oc ? 0.9 : 0.45, { cell: CELL.SOFT, alpha: 0.55 });   // flash (fake light)
    const life = Math.min(2.4, 0.8 + sz * 0.13);
    fb(x, y + sz * 0.45, z, sz * (big ? 3.6 : 4.6), life);
    if (big && !cheap) { for (let i = 0; i < (this.lite ? 2 : 4); i++) { const a = R() * TAU, r = sz * rr(0.3, 0.9); fb(x + Math.cos(a) * r, y + sz * rr(0.3, 1.1), z + Math.sin(a) * r, sz * rr(1.8, 2.8), life * rr(0.7, 1.1), 0.9); } }
    else if (sz > 3 && !cheap) fb(x + rr(-1, 1) * sz * 0.4, y + sz * 0.8, z + rr(-1, 1) * sz * 0.4, sz * 3, life * 0.8, 0.85);
    const ns = Math.max(2, Math.round((6 + sz * 2.5) * mul * (cheap ? 0.4 : 1)));
    for (let i = 0; i < ns; i++) {   // sparks
      const a = R() * TAU, sp = rr(4, 14) * Math.sqrt(sz);
      this.glow.emit(x, y + 0.5, z, Math.cos(a) * sp, rr(4, 4 + sp * 1.2), Math.sin(a) * sp, rr(0.4, 0.9), rr(0.5, 1.1), 1, rr(0.55, 0.85), 0.2, { grav: 25, drag: 0.97 });
    }
    const nd = cheap ? 0 : Math.max(2, Math.round((3 + sz * 1.5) * mul));
    for (let i = 0; i < nd; i++) {   // debris chunks
      const a = R() * TAU, sp = rr(3, 9) * Math.sqrt(sz), g = rr(0.1, 0.22);
      this.smoke.emit(x, y + 0.6, z, Math.cos(a) * sp, rr(5, 5 + sp), Math.sin(a) * sp, rr(0.5, 1), rr(0.9, 1.5), g, g * 0.95, g * 0.9, { grav: 30, drag: 0.995 });
    }
    if (!cheap && (big || o.air || sz > 3)) {   // lingering smoke (small blasts: the flipbook smoke is enough)
      const nsm = Math.max(1, Math.round((big ? 4 : 1 + (sz > 3 ? 1 : 0)) * (0.5 + 0.5 * mul)));
      for (let i = 0; i < nsm; i++) {
        const a = R() * TAU, r = R() * sz, g = rr(0.22, 0.34);
        if (o.air) this.smoke.emit(x, y, z, rr(-2, 2), rr(-1, 1.5), rr(-2, 2), sz * 2.2, rr(1.2, 2), 0.14, 0.14, 0.14, { cell: CELL.DARK + ((R() * 8) | 0), rot: R() * TAU, grow: sz * 1.4, alpha: 0.7 });
        else this.smoke.emit(x + Math.cos(a) * r, y + rr(0, sz), z + Math.sin(a) * r, Math.cos(a) * 1.2, rr(2, 5), Math.sin(a) * 1.2, sz * 2.4, rr(2, big ? 5.5 : 3.5), g * 0.6, g * 0.58, g * 0.56, { cell: CELL.DARK + ((R() * 8) | 0), rot: R() * TAU, grow: sz * 1.3, alpha: 0.78, drag: 0.97 });
      }
    }
    if (o.water) for (let i = 0; i < Math.max(3, Math.round(8 * mul)); i++) this.smoke.emit(x, o.waterY ?? y, z, rr(-3, 3), rr(10, 22), rr(-3, 3), rr(1.5, 2.5), 1.2, 0.9, 0.95, 1, { cell: CELL.PUFF + ((R() * 8) | 0), grav: 25, alpha: 0.85, rot: R() * TAU });
    if (big || sz > 4) this.ring(x, y, z, sz * (big ? 3.4 : 3), big ? 0.65 : 0.45, 0xffb070, 0.55);
    if (!o.air && !o.water && o.ground !== false && sz >= 2.2) this.decal(x, o.groundY ?? y, z, sz * (big ? 4.2 : 3.2));
  }
  // looping fireball flipbook (additive): burning wrecks, ground fires, the nuke core
  fire(x, y, z, size, life, vy = 1, a = 0.9, r = 1, g = 0.85, b = 0.7) {
    this.boom.emit(x, y, z, 0, vy, 0, size, life, r, g, b, { cell: BOOK.FIRE, frames: life / rr(1.6, 2.4), rot: R() * TAU, spin: rr(-0.2, 0.2), grow: size * 0.1, alpha: a, drag: 0.99 });
  }
  // Strategic nuke (the renderer adds the flash, shock rings, scorch and camera shake). Zn = zone radii [total, heavy, light];
  // K = 1 for a 30-unit core. Phases: fireball -> condensation ring -> rising stem and a burning cap -> dust wave -> ground fires.
  // h(x, z) = ground height (three coordinates).
  nuke(x, y, z, Zn, mul = 1, h = () => y) {
    const K = Zn[0] / 30, n = (k) => Math.max(1, Math.round(k * mul * (this.lite ? 0.5 : 1))), Rn = () => R() * TAU;
    // 1. fireball: white-hot core, then flipbook explosions that roll into smoke
    for (let i = 0; i < n(3); i++) this.fire(x + rr(-3, 3) * K, y + rr(4, 10) * K, z + rr(-3, 3) * K, rr(28, 36) * K, rr(2.2, 3), 5 * K, 0.7, 1, 0.85, 0.6);
    for (let i = 0; i < n(5); i++) { const a = Rn(), r = rr(0, 10) * K; this.boom.emit(x + Math.cos(a) * r, y + rr(8, 20) * K, z + Math.sin(a) * r, Math.cos(a) * 4 * K, rr(4, 9) * K, Math.sin(a) * 4 * K, rr(44, 58) * K, rr(3.6, 4.8), 0.85, 0.8, 0.75, { cell: (R() * BOOK.EXPN) | 0, rot: R() * TAU, spin: rr(-0.1, 0.1), grow: 6 * K, alpha: 0.95, drag: 0.985 }); }
    for (let i = 0; i < n(200); i++) {   // burning debris thrown out
      const a = Rn(), sp = (10 + R() * 50) * K;
      this.glow.emit(x, y + 4 * K, z, Math.cos(a) * sp, R() * 40 * K, Math.sin(a) * sp, (1.5 + R() * 2) * K, 1.4 + R() * 2, 1, 0.55 + R() * 0.3, 0.15, { grav: 9 * K, drag: 0.96 });
    }
    // 2. condensation ring: a thin white shell racing out at cap height, gone in ~1.5 s
    this.after(0.25, () => { for (let i = 0; i < n(70); i++) { const a = i / n(70) * TAU + rr(-0.05, 0.05), sp = rr(55, 70) * K; this.smoke.emit(x + Math.cos(a) * 14 * K, y + rr(26, 34) * K, z + Math.sin(a) * 14 * K, Math.cos(a) * sp, rr(-1, 3) * K, Math.sin(a) * sp, rr(9, 13) * K, rr(1.2, 1.7), 0.95, 0.97, 1, { cell: CELL.PUFF + ((R() * CELL.PUFFN) | 0), rot: R() * TAU, grow: 8 * K, alpha: 0.45, drag: 0.94 }); } });
    // 3. stem rising for ~3 s (smoke column with fire at its foot) and a cap that keeps burning inside while it climbs
    for (let st = 0; st < 6; st++) this.after(0.3 + st * 0.5, () => {
      for (let i = 0; i < n(22); i++) { const hgt = R() * (20 + st * 9) * K, r = R() * 5 * K, a = Rn(), g = rr(0.24, 0.36);
        this.smoke.emit(x + Math.cos(a) * r, y + hgt, z + Math.sin(a) * r, Math.cos(a) * 1.2 * K, (8 + R() * 6) * K, Math.sin(a) * 1.2 * K, 9 * K, 12 + R() * 8, g * 1.15, g, g * 0.85, { cell: CELL.DARK + ((R() * CELL.DARKN) | 0), rot: R() * TAU, grow: 3 * K, alpha: 0.85, drag: 0.985 }); }
      this.fire(x + rr(-3, 3) * K, y + rr(2, 8) * K, z + rr(-3, 3) * K, rr(14, 20) * K, rr(2, 3), 6 * K, 0.45, 1, 0.6, 0.3);
    });
    for (let i = 0; i < n(200); i++) {   // cap: torus of rolling smoke
      const a = Rn(), rr2 = (14 + R() * 13) * K, b = Rn(), hh = (58 + Math.sin(b) * 8) * K, g = 0.15 + R() * 0.12;
      this.smoke.emit(x + Math.cos(a) * rr2, y + hh + R() * 6 * K, z + Math.sin(a) * rr2, Math.cos(a) * 3.5 * K, (4 + R() * 4) * K, Math.sin(a) * 3.5 * K, 15 * K, 14 + R() * 8, g * 1.2, g, g * 0.85, { cell: CELL.DARK + ((R() * CELL.DARKN) | 0), rot: R() * TAU, grow: 5 * K, alpha: 0.85, drag: 0.985 });
    }
    for (let i = 0; i < n(12); i++) {   // dull glow inside the cap while it climbs
      const a = Rn(), rr2 = rr(4, 18) * K;
      this.after(rr(0.6, 2.5), () => this.fire(x + Math.cos(a) * rr2, y + rr(45, 62) * K, z + Math.sin(a) * rr2, rr(18, 26) * K, rr(4, 6), rr(5, 8) * K, 0.35, 1, rr(0.35, 0.5), 0.18));
    }
    // 4. ground dust wave out to the heavy-damage zone
    for (let i = 0; i < n(220); i++) {
      const a = Rn(), sp = Zn[1] * (0.3 + R() * 0.7) * 2.14, g = 0.4 + R() * 0.15;
      this.smoke.emit(x, y + 1.5, z, Math.cos(a) * sp, (1 + R() * 5) * K * 0.5, Math.sin(a) * sp, 8 * K, 7 + R() * 6, g, g * 0.92, g * 0.8, { grow: 7 * K, alpha: 0.7, drag: 0.965 });   // soft procedural sprite: no hard edges at this size
    }
    // 5. scattered ground fires in the total / heavy zones for ~12 s
    for (let i = 0; i < n(70); i++) this.after(rr(1, 10), () => { const a = Rn(), r = Math.sqrt(R()) * Zn[1], fx = x + Math.cos(a) * r, fz = z + Math.sin(a) * r; this.fire(fx, h(fx, fz) + 0.8 * K, fz, rr(2.2, 3.8) * K, rr(2.5, 4), 1.2 * K, 0.7); });
  }
  // foam left behind a moving ship (r = hull radius), spreading on the water
  wake(x, y, z, r) {
    this.smoke.emit(x + rr(-0.3, 0.3) * r, y + 0.25, z + rr(-0.3, 0.3) * r, rr(-0.4, 0.4), 0, rr(-0.4, 0.4), r * 0.45, rr(1.4, 2.2), 0.92, 0.96, 1, { cell: CELL.PUFF + ((R() * CELL.PUFFN) | 0), rot: R() * TAU, grow: r * 0.35, alpha: 0.22, drag: 0.96 });
  }
  // smoke / fire from a damaged unit or structure; ratio = hp / maxHp (< 0.5), rate gates how often the caller invokes
  damaged(x, y, z, size, ratio, big = false) {
    const g = rr(0.1, 0.2), k = 1 - ratio / 0.5;   // 0 at 50% hp .. 1 at 0
    this.smoke.emit(x + rr(-0.4, 0.4) * size, y, z + rr(-0.4, 0.4) * size, rr(-0.3, 0.3), rr(2, 4), rr(-0.3, 0.3), size * (0.7 + k * 0.5), rr(1.6, 2.6), g * 0.7, g * 0.7, g * 0.7, { cell: CELL.DARK + ((R() * 8) | 0), rot: R() * TAU, grow: size * 0.9, alpha: 0.35 + k * 0.35, drag: 0.98 });
    if (ratio < 0.25 && R() < 0.7) this.fire(x + rr(-0.3, 0.3) * size, y - size * 0.15, z + rr(-0.3, 0.3) * size, size * (big ? 1.5 : 1.2), rr(0.5, 0.8));
  }
}
