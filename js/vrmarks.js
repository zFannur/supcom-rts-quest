import * as THREE from 'three';
import { RangeView, rangeRings, RING_KINDS } from './ranges.js';

const ICON_MAX = 2000;
const BAR_MAX = 2000;
const LINE_MAX = 4000;
const PING_MAX = 32;
const RING_MAX = 8000, RN = 64, NUKE_MAX = 3;   // ring line segments / points per ring / nuke label sprites
const COS = new Float32Array(RN + 1), SIN = new Float32Array(RN + 1);
for (let i = 0; i <= RN; i++) { COS[i] = Math.cos(i / RN * 6.2832); SIN[i] = Math.sin(i / RN * 6.2832); }
const RGB = {}; for (const k in RING_KINDS) RGB[k] = RING_KINDS[k].rgb.split(',').map(v => v / 255);
RGB.nukeOwn = [0.49, 1, 0.69]; RGB.nukeEnemy = [1, 0.23, 0.17];

// Icon atlas: 2048x2048 canvas of 120x120 cells (a 40x40 logical cell x ICON_K), painted by the PC renderer.paintIcon scaled x3 (same look, 3x sharper),
// cells allocated lazily. Mipmaps + trilinear + anisotropy 4. Cell 0 = generic square (overflow), cell 1 = radar blip.
const ICON_K = 3, CELL = 40, PCELL = CELL * ICON_K, ATLAS = 2048, COLS = Math.floor(ATLAS / PCELL), DEG = Math.PI / 180, SHAPE = 11;   // CELL/SHAPE are logical (PC) px: PC unit shape is ~11 px of the 40 px cell
const FIRST_CELL = 7;   // cells 0 generic, 1 radar blip, 2..6 veterancy stars x1..x5
const AZ_MAX = 110 * DEG, EL_MAX = 80 * DEG;   // declutter grid extent (head-centred angles)
export const ICON_DEG = 1.3;   // angular size of a unit's shape, degrees (vr.iconDeg overrides)

function paintStars(ctx) {   // cells 2..6: 1..5 gold stars, centred
  for (let n = 1; n <= 5; n++) {
    const c = n + 1, x = (c % COLS) * PCELL, y = Math.floor(c / COLS) * PCELL;
    ctx.save(); ctx.translate(x, y); ctx.beginPath(); ctx.rect(0, 0, PCELL, PCELL); ctx.clip(); ctx.clearRect(0, 0, PCELL, PCELL); ctx.scale(ICON_K, ICON_K);
    ctx.font = 'bold 8px Rajdhani, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.fillStyle = '#ffd040';
    ctx.strokeText('★'.repeat(n), 20, 20); ctx.fillText('★'.repeat(n), 20, 20); ctx.restore();
  }
}

function createIconAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ATLAS;
  const ctx = canvas.getContext('2d');
  ctx.save(); ctx.scale(ICON_K, ICON_K);
  ctx.fillStyle = '#c8d0d8'; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 1.3;
  ctx.fillRect(10, 10, 20, 20); ctx.strokeRect(10, 10, 20, 20);
  ctx.fillStyle = 'rgba(255,90,60,0.9)'; ctx.strokeStyle = 'rgba(255,200,180,0.8)';
  ctx.beginPath(); ctx.arc(CELL + 20, 20, 6, 0, 6.28); ctx.fill(); ctx.stroke(); ctx.restore();   // (logical coords, ctx is scaled)
  paintStars(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.anisotropy = 4;   // (clamped to the GPU maximum by three.js)
  return tex;
}

export class VRMarks {
  constructor(renderer) {
    this.renderer = renderer;
    this.object3d = new THREE.Group();

    this.iconTex = createIconAtlas(); this.atlasCtx = this.iconTex.image.getContext('2d');
    this.cells = new WeakMap(); this.nCells = FIRST_CELL; this.atlasDirty = false;
    document.fonts?.ready.then(() => { this.cells = new WeakMap(); this.nCells = FIRST_CELL; paintStars(this.atlasCtx); this.atlasDirty = true; });   // repaint with the HUD font
    const iconGeo = new THREE.PlaneGeometry(1, 1);
    this.iconMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.iconTex } },
      vertexShader: `
        attribute vec4 instanceData; // xy: uv offset of the cell, z: size in radians, w: lift in radians
        varying vec2 vUv;
        varying vec3 vColor;
        void main() {
          vUv = uv * ${(PCELL / ATLAS).toFixed(6)} + instanceData.xy;
          #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;   // declared by three.js when the mesh has instance colours
          #else
          vColor = vec3(1.0);
          #endif
          
          vec4 mvPos = viewMatrix * vec4(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2], 1.0);
          // view space is physical metres (the dolly scale is inside viewMatrix): size in radians * distance = constant angular size
          mvPos.xy += (position.xy * instanceData.z + vec2(0.0, instanceData.w)) * length(mvPos.xyz);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        varying vec2 vUv;
        varying vec3 vColor;
        void main() {
          vec4 tex = texture2D(map, vUv);
          gl_FragColor = vec4(tex.rgb * vColor, tex.a);
        }
      `,
      transparent: true,
      depthWrite: false,
      toneMapped: false
    });

    this.icons = new THREE.InstancedMesh(iconGeo, this.iconMat, ICON_MAX);
    this.icons.frustumCulled = false;
    this.icons.renderOrder = 10;
    this.iconData = new Float32Array(ICON_MAX * 4);
    this.icons.geometry.setAttribute('instanceData', new THREE.InstancedBufferAttribute(this.iconData, 4));
    this.icons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < ICON_MAX; i++) this.icons.setMatrixAt(i, new THREE.Matrix4());
    this.object3d.add(this.icons);

    const barGeo = new THREE.PlaneGeometry(1, 1);
    this.barMat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec4 instanceData; // xy: size in radians, z: fill, w: lift in radians
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vFill;
        void main() {
          vUv = uv;
          #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;   // declared by three.js when the mesh has instance colours
          #else
          vColor = vec3(1.0);
          #endif
          vFill = instanceData.z;
          
          vec4 mvPos = viewMatrix * vec4(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2], 1.0);
          mvPos.xy += (position.xy * instanceData.xy + vec2(0.0, instanceData.w)) * length(mvPos.xyz);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vFill;
        void main() {
          vec3 col = vec3(0.1);
          if (vUv.x <= vFill) col = vColor;
          gl_FragColor = vec4(col, 0.9);
        }
      `,
      transparent: true,
      depthWrite: false,
      toneMapped: false
    });

    this.bars = new THREE.InstancedMesh(barGeo, this.barMat, BAR_MAX);
    this.bars.frustumCulled = false;
    this.bars.renderOrder = 11;
    this.barData = new Float32Array(BAR_MAX * 4);
    this.bars.geometry.setAttribute('instanceData', new THREE.InstancedBufferAttribute(this.barData, 4));
    this.bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < BAR_MAX; i++) this.bars.setMatrixAt(i, new THREE.Matrix4());
    this.object3d.add(this.bars);

    const lineGeo = new THREE.BufferGeometry();
    this.linePos = new Float32Array(LINE_MAX * 2 * 3);
    this.lineCol = new Float32Array(LINE_MAX * 2 * 3);
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    lineGeo.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, depthWrite: false, toneMapped: false, transparent: true, opacity: 0.8 }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 10;
    this.object3d.add(this.lines);

    const pingGeo = new THREE.RingGeometry(0.8, 1, 32).rotateX(-Math.PI / 2);
    this.pingMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.pings = new THREE.InstancedMesh(pingGeo, this.pingMat, PING_MAX);
    this.pings.frustumCulled = false;
    this.pings.renderOrder = 12;
    for (let i = 0; i < PING_MAX; i++) this.pings.setMatrixAt(i, new THREE.Matrix4());
    this.object3d.add(this.pings);
    
    // range rings / nuke impact zones: line loops on the terrain (own buffer, only the used part is uploaded)
    const rgeo = new THREE.BufferGeometry();
    this.ringPos = new Float32Array(RING_MAX * 6); this.ringCol = new Float32Array(RING_MAX * 6); this.rN = 0; this.slots = [];
    rgeo.setAttribute('position', new THREE.BufferAttribute(this.ringPos, 3).setUsage(THREE.DynamicDrawUsage));
    rgeo.setAttribute('color', new THREE.BufferAttribute(this.ringCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.rings = new THREE.LineSegments(rgeo, new THREE.LineBasicMaterial({ vertexColors: true, depthWrite: false, toneMapped: false, transparent: true, opacity: 0.95 }));
    this.rings.frustumCulled = false; this.rings.renderOrder = 9; this.rings.visible = false;
    this.object3d.add(this.rings);
    this.rv = new RangeView(); this.rfake = { mode: null, buildKey: null, hover: null, keys: { AltLeft: false }, selection: null };
    this.nukeSeen = new Set(); this.nukeSprites = [];
    for (let i = 0; i < NUKE_MAX; i++) {
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 40;
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
      sp.visible = false; sp.renderOrder = 13; sp.frustumCulled = false; sp.userData.txt = ''; this.object3d.add(sp); this.nukeSprites.push(sp);
    }

    this.tmpC = new THREE.Color();
    this.tmpM = new THREE.Matrix4();
    this.tmpV = new THREE.Vector3();
    this.tmpQ = new THREE.Quaternion();
    this.tmpS = new THREE.Vector3();
    // declutter scratch (reused, grown on demand)
    this.occ = new Int32Array(0); this.occCols = 0; this.occRows = 0; this.occCell = 0;   // occ: per-cell list head of shown icons (valid if occFr = this frame), nxt: next in the list
    this.pri = new Uint8Array(0); this.hide = new Uint8Array(0); this.hy = new Float32Array(0); this.cix = new Int32Array(0); this.iconShown = 0; this.iconHidden = 0;
    this.nxt = new Int32Array(0); this.ord = new Int32Array(0); this.dir = new Float32Array(0); this.bp = new Float32Array(0); this.occFr = new Int32Array(0); this.rowK = new Uint8Array(0); this.cnt = new Int32Array(16);
    this.holdId = new Int32Array(8192).fill(-1); this.holdFr = new Int32Array(8192); this.dlFrame = 0; this.dlMs = 0;   // shown last frame (slot = entity id & 8191): hysteresis
  }

  setBar(n, px, py, pz, w, lift, fill, hex, dg) {
    const o4 = n * 4;
    this.barData[o4] = dg * w / 16; this.barData[o4 + 1] = dg * 0.25; this.barData[o4 + 2] = fill; this.barData[o4 + 3] = lift;
    this.tmpC.setHex(hex); this.bars.setColorAt(n, this.tmpC);
    const arr = this.bars.instanceMatrix.array, o = n * 16;
    arr[o + 12] = px; arr[o + 13] = py; arr[o + 14] = pz;
  }

  // angular grid cell of a world point seen from the head camera, stores its direction for item i; -1 = outside the grid / behind (never culled)
  pointCell(i, x, y, z) {
    const m = this.renderer.camera.matrixWorldInverse.elements, w = this.renderer.camera.matrixWorld.elements;
    const mx = m[0] * x + m[4] * y + m[8] * z + m[12], my = m[1] * x + m[5] * y + m[9] * z + m[13], mz = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (mz > -0.01) return -1;
    const az = Math.atan2(mx, -mz), el = Math.atan2(my, Math.sqrt(mx * mx + mz * mz));
    if (az < -AZ_MAX || az > AZ_MAX || el < -EL_MAX || el > EL_MAX) return -1;
    const dx = x - w[12], dy = y - w[13], dz = z - w[14], l = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz), o = i * 3;
    this.dir[o] = dx * l; this.dir[o + 1] = dy * l; this.dir[o + 2] = dz * l;   // world direction from the eye: angular separations do not depend on head rotation
    return ((el + EL_MAX) / this.occCell | 0) * this.occCols + ((az + AZ_MAX) / this.occCell | 0);
  }

  // 13.3 icon declutter, stable under head jitter. An icon is hidden when an already shown icon (higher priority or earlier) is closer
  // than `sep` icon sizes in angle (great-circle from the eye: does not depend on head rotation, so the always-trembling head no longer
  // flips the winners as the old fixed head-centred cells did). Hysteresis: an icon shown last frame goes first within its priority and
  // keeps its place until a neighbour is closer than sep * hold. The head-centred grid (cell = sep) is only a neighbour index.
  // Priority: selected > ACU/exp > structures > units by size > radar blips. Knobs (window.__dbg.vr): iconDeclutter (0 off), iconSep, iconHold.
  declutter(ren, selSet, dg, us, dlN, dl, dlIcon, dlPos, blips, sepK, holdK) {
    const t0 = performance.now(), N = dlN + blips.length;
    if (this.pri.length < N) { const n = N + 256; this.pri = new Uint8Array(n); this.hide = new Uint8Array(n); this.hy = new Float32Array(n); this.cix = new Int32Array(n); this.nxt = new Int32Array(n); this.ord = new Int32Array(n); this.dir = new Float32Array(n * 3); this.bp = new Float32Array(n * 3); }
    const cell = dg * sepK, cols = Math.ceil(2 * AZ_MAX / cell) + 1, rows = Math.ceil(2 * EL_MAX / cell) + 1;
    if (this.occ.length < cols * rows) { this.occ = new Int32Array(cols * rows); this.occFr = new Int32Array(cols * rows); }
    if (cell !== this.occCell) {   // per grid row: columns to scan each side (az cells shrink by cos(el) towards the poles)
      if (this.rowK.length < rows) this.rowK = new Uint8Array(rows);
      for (let r = 0; r < rows; r++) this.rowK[r] = Math.min(8, Math.ceil(1 / Math.cos(Math.min(Math.abs((r + 0.5) * cell - EL_MAX) + cell * 1.5, 1.48))));
    }
    this.occCell = cell; this.occCols = cols; this.occRows = rows;
    const pri = this.pri, hide = this.hide, cix = this.cix, nxt = this.nxt, ord = this.ord, dir = this.dir, occ = this.occ, ofr = this.occFr, rowK = this.rowK, bp = this.bp, cnt = this.cnt;
    const hid = this.holdId, hfr = this.holdFr, fr = ++this.dlFrame;
    cnt.fill(0);
    for (let i = 0; i < N; i++) {
      hide[i] = 0; cix[i] = -1;
      let id;
      if (i >= dlN) {   // radar blips: lowest priority
        const b = blips[i - dlN], p = ren.entityPos(b, this.tmpV), o = (i - dlN) * 3;
        bp[o] = p.x; bp[o + 1] = p.y + 0.5; bp[o + 2] = p.z; pri[i] = 6; id = b.id;
        cix[i] = this.pointCell(i, bp[o], bp[o + 1], bp[o + 2]);
      } else {
        const e = dl[i], struct = e.kind === 'struct';
        const top = struct ? (ren.metaHeight(e) || 4) : (ren.metaHeight(e) || 2) + 0.5;
        const inZone = dlIcon[i] === 1;
        this.hy[i] = dlPos[i * 3 + 1] + (inZone && !struct ? 1 : top * (struct ? 1 + (us - 1) * 0.3 : us));
        if (!inZone) { pri[i] = 255; continue; }
        const r = e.spec.radius || 1.5;
        pri[i] = selSet.has(e) ? 0 : (e.spec.role === 'exp' || e.spec.model === 'acu') ? 1 : struct ? 2 : r >= 2.2 ? 3 : r >= 1.6 ? 4 : 5;
        cix[i] = this.pointCell(i, dlPos[i * 3], this.hy[i], dlPos[i * 3 + 2]);
        id = e.id;
      }
      const h = id & 8191, k = pri[i] * 2 + (hid[h] === id && hfr[h] === fr - 1 ? 0 : 1);   // sort key: priority, then shown last frame first
      nxt[i] = k; cnt[k + 1]++;   // (nxt holds the key until the item is placed)
    }
    for (let k = 1; k < 15; k++) cnt[k] += cnt[k - 1];
    for (let i = 0; i < N; i++) if (pri[i] !== 255) ord[cnt[nxt[i]]++] = i;   // counting sort, stable (dl order within a key)
    const cosShow = Math.cos(cell), cosHold = Math.cos(cell * holdK), M = cnt[13];
    for (let q = 0; q < M; q++) {
      const i = ord[q], c = cix[i];
      if (c >= 0) {
        const held = (nxt[i] & 1) === 0, cosT = held ? cosHold : cosShow, o = i * 3, x = dir[o], y = dir[o + 1], z = dir[o + 2];
        const row = c / cols | 0, col = c - row * cols, k = rowK[row], c0 = Math.max(0, col - k), c1 = Math.min(cols - 1, col + k);
        let hit = false;
        for (let rr = Math.max(0, row - 1), r1 = Math.min(rows - 1, row + 1); rr <= r1 && !hit; rr++) {
          for (let cc = rr * cols + c0, ce = rr * cols + c1; cc <= ce && !hit; cc++) {
            if (ofr[cc] !== fr) continue;
            for (let j = occ[cc]; j >= 0; j = nxt[j]) if (x * dir[j * 3] + y * dir[j * 3 + 1] + z * dir[j * 3 + 2] > cosT) { hit = true; break; }
          }
        }
        if (hit) { hide[i] = 1; continue; }
        nxt[i] = ofr[c] === fr ? occ[c] : -1; occ[c] = i; ofr[c] = fr;
      }
      const id = i < dlN ? dl[i].id : blips[i - dlN].id, h = id & 8191; hid[h] = id; hfr[h] = fr;
    }
    this.dlMs += (performance.now() - t0 - this.dlMs) * 0.1;   // smoothed ms per frame
  }

  setVisible(on) {
    this.object3d.visible = on;
  }

  dispose() {
    this.iconTex.dispose();
    this.iconMat.dispose();
    this.icons.geometry.dispose();
    this.barMat.dispose();
    this.bars.geometry.dispose();
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    this.pingMat.dispose();
    this.pings.geometry.dispose();
    this.rings.geometry.dispose(); this.rings.material.dispose();
    for (const sp of this.nukeSprites) { sp.material.map.dispose(); sp.material.dispose(); }
  }

  // One ring of RN segments on the terrain. mode: 0 solid, 1 dashed (enemy, marching), 2 short dashes (artillery dead zone).
  // Heights are cached per slot until the centre moves (no per-frame surfaceAt for static rings).
  ring(t, slot, cx, cy, R, rgb, mode, ph, lift) {
    if (this.rN + RN > RING_MAX) return;
    const s = this.slots[slot] || (this.slots[slot] = { h: new Float32Array(RN), cx: 1e9, cy: 0, r: 0 }), h = s.h;
    if (s.r !== R || Math.abs(s.cx - cx) > 0.25 || Math.abs(s.cy - cy) > 0.25) {
      s.cx = cx; s.cy = cy; s.r = R;
      for (let i = 0; i < RN; i++) h[i] = Math.max(t.surfaceAt(cx + COS[i] * R, cy + SIN[i] * R), t.water) + 0.7;
    }
    const lp = this.ringPos, lc = this.ringCol, r = rgb[0], g = rgb[1], b = rgb[2];
    for (let i = 0; i < RN; i++) {
      if (mode === 1 && ((i + ph) & 3) > 1) continue;
      if (mode === 2 && (i & 1)) continue;
      const o = this.rN++ * 6, j = i + 1;
      lp[o] = cx + COS[i] * R; lp[o + 1] = h[i] + lift; lp[o + 2] = cy + SIN[i] * R;
      lp[o + 3] = cx + COS[j] * R; lp[o + 4] = h[j % RN] + lift; lp[o + 5] = cy + SIN[j] * R;
      lc[o] = lc[o + 3] = r; lc[o + 1] = lc[o + 4] = g; lc[o + 2] = lc[o + 5] = b;
    }
  }

  // 8.4 range rings (laser hover / build ghost / Shift = whole selection) + 8.6 nuke impact zones and countdown
  updateRings(game, ui, vr) {
    const ren = this.renderer, t = game.terrain, lift = 0.003 / vr.s, ph = (performance.now() / 90) | 0;
    this.rN = 0; let slot = 0;
    if (ui) {
      const f = this.rfake, lt0 = ren.localTeam;
      f.mode = ui.mode; f.buildKey = ui.buildKey; f.hover = vr.laserEnt; f.keys.AltLeft = vr.shift; f.selection = ui.selection;
      ren.localTeam = ui.team;   // "own" = the player's team, also when the renderer has no local team (single player)
      const items = this.rv.collect(ren, game, f);
      ren.localTeam = lt0;
      for (const it of items) for (const R of rangeRings(it.spec)) {
        this.ring(t, slot++, it.x, it.y, R.r, RGB[R.kind], it.own ? 0 : 1, ph, lift);
        if (R.min > 0) this.ring(t, slot++, it.x, it.y, R.min, RGB[R.kind], 2, ph, lift);
      }
    }
    let ns = 0; const cam = ren.camera.matrixWorld.elements, lp = this.ringPos, lc = this.ringCol;
    for (const p of game.projectiles) {
      if (p.type !== 'nuke' || !p.zones) continue;
      const own = !ui || game.allied(ui.team, p.team), rgb = own ? RGB.nukeOwn : RGB.nukeEnemy, Z = p.zones, gz = Math.max(p.tz, t.water);
      if (!this.nukeSeen.has(p.id)) {
        if (this.nukeSeen.size > 64) this.nukeSeen.clear();
        this.nukeSeen.add(p.id);
        if (ui && ui.flashHook) ui.flashHook(own ? 'Пуск ядерной ракеты' : 'ВНИМАНИЕ: ядерный пуск!', 3500);   // text for the wrist panel (the game alert is DOM-only)
      }
      this.ring(t, slot++, p.tx, p.ty, Z[2], rgb, 0, ph, lift); this.ring(t, slot++, p.tx, p.ty, Z[1], rgb, 2, ph, lift); this.ring(t, slot++, p.tx, p.ty, Z[0], rgb, 0, ph, lift);
      for (let i = 0; i < 24 && this.rN < RING_MAX; i++) {   // flight path: 24 dashes from the missile to the target
        const a = i / 24, b = (i + 0.5) / 24, o = this.rN++ * 6;
        lp[o] = p.x + (p.tx - p.x) * a; lp[o + 1] = p.z + (gz - p.z) * a; lp[o + 2] = p.y + (p.ty - p.y) * a;
        lp[o + 3] = p.x + (p.tx - p.x) * b; lp[o + 4] = p.z + (gz - p.z) * b; lp[o + 5] = p.y + (p.ty - p.y) * b;
        lc[o] = lc[o + 3] = rgb[0]; lc[o + 1] = lc[o + 4] = rgb[1]; lc[o + 2] = lc[o + 5] = rgb[2];
      }
      if (ns < NUKE_MAX) {
        const sp = this.nukeSprites[ns++], txt = (own ? 'НАШ УДАР' : 'ЯДЕРНЫЙ УДАР') + ' · ' + Math.max(0, Math.ceil(p.T - p.t)) + ' с';
        if (sp.userData.txt !== txt) {
          sp.userData.txt = txt; const c = sp.material.map.image.getContext('2d'), col = own ? '#7dffb0' : '#ff3a2a';
          c.clearRect(0, 0, 256, 40); c.fillStyle = 'rgba(8,10,14,0.85)'; c.fillRect(0, 0, 256, 40); c.strokeStyle = col; c.lineWidth = 3; c.strokeRect(1.5, 1.5, 253, 37);
          c.font = '700 24px Rajdhani, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = col; c.fillText(txt, 128, 21);
          sp.material.map.needsUpdate = true;
        }
        const wy = gz + 1, d = Math.hypot(p.tx - cam[12], wy - cam[13], p.ty - cam[14]), h = d * 0.035;   // constant angular size (~2 deg tall)
        sp.position.set(p.tx, wy, p.ty); sp.scale.set(h * 6.4, h, 1); sp.center.set(0.5, -0.3); sp.visible = true;
      }
    }
    for (let i = ns; i < NUKE_MAX; i++) this.nukeSprites[i].visible = false;
    const g = this.rings.geometry; g.setDrawRange(0, this.rN * 2);
    this.rings.visible = this.rN > 0;
    if (this.rN) for (const k of ['position', 'color']) { const a = g.attributes[k]; a.clearUpdateRanges(); a.addUpdateRange(0, this.rN * 6); a.needsUpdate = true; }
  }

  // atlas cell of (spec, team, selected): painted on first use by the PC paintIcon; returns the cell index
  cellFor(e, selected) {
    let per = this.cells.get(e.spec);
    if (!per) this.cells.set(e.spec, per = []);
    const k = (e.team << 1) | (selected ? 1 : 0);
    let c = per[k];
    if (c === undefined) {
      if (this.nCells >= COLS * COLS) return 0;
      c = per[k] = this.nCells++;
      const ctx = this.atlasCtx, x = (c % COLS) * PCELL, y = Math.floor(c / COLS) * PCELL;
      ctx.save(); ctx.translate(x, y); ctx.beginPath(); ctx.rect(0, 0, PCELL, PCELL); ctx.clip();
      ctx.clearRect(0, 0, PCELL, PCELL); ctx.scale(ICON_K, ICON_K);
      this.renderer.paintIcon(ctx, e, 20, 22, selected);
      ctx.restore(); this.atlasDirty = true;
    }
    return c;
  }

  setIcon(n, cell, size, lift) {
    const d = this.iconData, o = n * 4;
    d[o] = (cell % COLS) * PCELL / ATLAS; d[o + 1] = 1 - (Math.floor(cell / COLS) + 1) * PCELL / ATLAS; d[o + 2] = size; d[o + 3] = lift;
  }

  update(game, ui, vr) {
    if (!this.object3d.visible || !game) return;
    const ren = this.renderer;
    this.updateRings(game, ui, vr);
    const dl = ren.dl, dlIcon = ren.dlIcon, dlN = ren.dlN, dlPos = ren.dlPos;
    const s = vr.s, dg = (vr.iconDeg || ICON_DEG) * DEG, us = ren.unitScale;
    const edge = dg * CELL / SHAPE;   // quad edge (rad): the unit shape is SHAPE px of the cell
    let icCount = 0, barCount = 0, shown = 0, hidden = 0;
    const selSet = new Set(ui ? ui.selection : []);
    const declutter = (vr.iconDeclutter ?? 1) !== 0;
    const blips = ren.blips || [];
    if (declutter) this.declutter(ren, selSet, dg, us, dlN, dl, dlIcon, dlPos, blips, vr.iconSep || 1.25, vr.iconHold ?? 0.75);
    const hbSetting = ren.settings.healthBars ?? 1;

    for (let i = 0; i < dlN; i++) {
      const e = dl[i];
      const selected = selSet.has(e);
      const struct = e.kind === 'struct';
      const px = dlPos[i * 3], py = dlPos[i * 3 + 1], pz = dlPos[i * 3 + 2];
      const inZone = dlIcon[i] === 1;
      let headY;
      if (declutter) headY = this.hy[i];
      else { const top = struct ? (ren.metaHeight(e) || 4) : (ren.metaHeight(e) || 2) + 0.5; headY = py + (inZone && !struct ? 1 : top * (struct ? 1 + (us - 1) * 0.3 : us)); }
      const covered = declutter && inZone && this.hide[i] === 1;   // icon lost its angular cell to a higher-priority neighbour: no icon, no bar

      if (inZone && !covered && icCount < ICON_MAX) {
        this.setIcon(icCount, this.cellFor(e, selected), selected ? edge * 1.2 : edge, dg * 0.8);
        this.tmpC.setHex(0xffffff);
        this.icons.setColorAt(icCount, this.tmpC);
        const arr = this.icons.instanceMatrix.array, o = icCount * 16;
        arr[o + 12] = px; arr[o + 13] = headY; arr[o + 14] = pz;
        icCount++; shown++;
      } else if (covered) hidden++;
      if (covered) continue;

      const damaged = e.hp < e.maxHp - 0.5;
      const o0 = !struct && e.orders && e.orders[0], enhKey = o0 && o0.type === 'enhance' && e.enhProg ? o0.key : null;
      const showBar = selected || hbSetting === 2 || (hbSetting === 1 && damaged) || (struct && !e.built) || !!enhKey;
      if (showBar && !(inZone && !selected && !damaged && !(struct && !e.built) && !enhKey) && barCount < BAR_MAX - 4) {
        const w = struct ? 34 : e.spec.role === 'exp' ? 60 : e.spec.model === 'acu' ? 40 : 22;   // PC bar widths (px), scaled to the icon size
        const L = inZone ? dg * 2.2 : dg * 0.4, row = dg * 0.3, f = Math.max(0, Math.min(1, e.hp / e.maxHp));
        this.setBar(barCount++, px, headY, pz, w, L, f, e.hp > e.maxHp * 0.6 ? 0x40ff40 : e.hp > e.maxHp * 0.3 ? 0xffff40 : 0xff4040, dg);
        if (struct) {
          if (!e.built) this.setBar(barCount++, px, headY, pz, w, L - row, Math.max(0, Math.min(1, e.progress)), 0x5dffb0, dg);
          if (e.shield && e.shield.on) this.setBar(barCount++, px, headY, pz, w, L + row, Math.max(0, Math.min(1, e.shield.hp / e.shield.max)), 0x7fcfff, dg);
          if (e.upgrading || (e.queue && e.queue.length)) this.setBar(barCount++, px, headY, pz, w, L - row, Math.max(0, Math.min(1, e.upgrading ? e.upgrading.prog : e.prog)), 0xffb040, dg);
        } else if (enhKey) this.setBar(barCount++, px, headY, pz, w, L - row, Math.max(0, Math.min(1, e.enhProg[enhKey] || 0)), 0xffb040, dg);
        if (e.vet && (selected || damaged || hbSetting === 2) && icCount < ICON_MAX) {   // veterancy stars above the bars (icon atlas cells 2..6)
          this.setIcon(icCount, 1 + Math.min(5, e.vet), edge * 0.8, L + row * 2 + dg * 0.5);
          this.tmpC.setHex(0xffffff); this.icons.setColorAt(icCount, this.tmpC);
          const arr = this.icons.instanceMatrix.array, o = icCount * 16;
          arr[o + 12] = px; arr[o + 13] = headY; arr[o + 14] = pz;
          icCount++;
        }
      }
    }

    for (let j = 0; j < blips.length; j++) {
      if (icCount >= ICON_MAX) break;
      if (declutter && this.hide[dlN + j] === 1) { hidden++; continue; }
      let bx, by, bz;
      if (declutter) { bx = this.bp[j * 3]; by = this.bp[j * 3 + 1]; bz = this.bp[j * 3 + 2]; }
      else { const p = ren.entityPos(blips[j], this.tmpV); bx = p.x; by = p.y + 0.5; bz = p.z; }
      shown++;
      this.setIcon(icCount, 1, edge * 0.8, dg * 0.5);
      this.tmpC.setHex(0xffffff);
      this.icons.setColorAt(icCount, this.tmpC);
      const arr = this.icons.instanceMatrix.array, o = icCount * 16;
      arr[o + 12] = bx; arr[o + 13] = by; arr[o + 14] = bz;
      icCount++;
    }
    this.iconShown = shown; this.iconHidden = hidden;
    if (this.atlasDirty) { this.iconTex.needsUpdate = true; this.atlasDirty = false; }

    this.icons.count = icCount;
    this.icons.visible = icCount > 0;
    if (icCount > 0) {
      this.icons.geometry.attributes.instanceData.needsUpdate = true;
      if (this.icons.instanceColor) this.icons.instanceColor.needsUpdate = true;
      this.icons.instanceMatrix.needsUpdate = true;
    }
    
    this.bars.count = barCount;
    this.bars.visible = barCount > 0;
    if (barCount > 0) {
      this.bars.geometry.attributes.instanceData.needsUpdate = true;
      if (this.bars.instanceColor) this.bars.instanceColor.needsUpdate = true;
      this.bars.instanceMatrix.needsUpdate = true;
    }
    
    let lCount = 0;
    // Shift (left trigger): order lines of ALL own units/buildings, like Shift on PC
    const lineSrc = vr.shift && game ? [...game.units, ...game.structs].filter(e => e.alive && e.team === ui.team) : ui && ui.selection;
    if (lineSrc && lineSrc.length > 0) {
      const orderColors = { move: 0x5dffb0, attack: 0xff3a24, build: 0xffb040, patrol: 0x7fcfff, reclaim: 0xffb040, default: 0xffffff };
      const lp = this.linePos;
      const lc = this.lineCol;
      const t = game.terrain;
      
      for (const e of lineSrc) {
        if (!e.alive || e.carried) continue;
        let p1x = e.x, p1y = e.y;
        const ords = (e.orders || []).slice();
        if (e.kind === 'struct' && e.rally) {
          ords.unshift({ type: 'move', x: e.rally.x, y: e.rally.y });
        }
        
        for (const o of ords) {
          if (lCount >= LINE_MAX) break;
          const p2x = o.target ? o.target.x : o.x;
          const p2y = o.target ? o.target.y : o.y;
          if (p2x === undefined || p2y === undefined) continue;
          
          const z1 = Math.max(t.surfaceAt(p1x, p1y), t.water) + 0.5 + 0.001 / s;
          const z2 = Math.max(t.surfaceAt(p2x, p2y), t.water) + 0.5 + 0.001 / s;
          
          const cHex = orderColors[o.type] || orderColors.default;
          this.tmpC.setHex(cHex);
          
          const idx = lCount * 6;
          lp[idx] = p1x; lp[idx+1] = z1; lp[idx+2] = p1y;
          lp[idx+3] = p2x; lp[idx+4] = z2; lp[idx+5] = p2y;
          
          lc[idx] = this.tmpC.r; lc[idx+1] = this.tmpC.g; lc[idx+2] = this.tmpC.b;
          lc[idx+3] = this.tmpC.r; lc[idx+4] = this.tmpC.g; lc[idx+5] = this.tmpC.b;
          
          p1x = p2x; p1y = p2y;
          lCount++;
        }
      }
    }
    
    this.lines.geometry.setDrawRange(0, lCount * 2);
    this.lines.visible = lCount > 0;
    if (lCount > 0) {
      this.lines.geometry.attributes.position.needsUpdate = true;
      this.lines.geometry.attributes.color.needsUpdate = true;
    }
    
    let pingCount = 0;
    if (ui && ui.pings) {
      const now = performance.now();
      for (const p of ui.pings) {
        if (pingCount >= PING_MAX) break;
        const age = now - p.t;
        if (age > 600) continue;
        
        const f = age / 600;
        const sz = 1 + f * 10;
        
        this.tmpC.setHex(p.color || 0xffffff);
        this.tmpC.multiplyScalar(1 - f * 0.8);
        this.pings.setColorAt(pingCount, this.tmpC);
        
        const z = Math.max(game.terrain.surfaceAt(p.x, p.y), game.terrain.water) + 0.5;
        this.tmpM.compose(this.tmpV.set(p.x, z, p.y), this.tmpQ.identity(), this.tmpS.setScalar(sz));
        this.pings.setMatrixAt(pingCount, this.tmpM);
        pingCount++;
      }
    }
    this.pings.count = pingCount;
    this.pings.visible = pingCount > 0;
    if (pingCount > 0) {
      if (this.pings.instanceColor) this.pings.instanceColor.needsUpdate = true;
      this.pings.instanceMatrix.needsUpdate = true;
    }
  }
}
