// WebXR Tabletop & Mixed Reality system for Meta Quest 3 and standard WebXR headsets.
// Map is projected as a miniature interactive tabletop in front of the player (passthrough MR or VR).
// Full 6DOF motion, two-handed scaling/rotation/pan, laser pointing, selection circle, 3D wrist HUD and 3D markers.

import * as THREE from 'three';
import { VRPanel } from './vrpanel.js';
import { VRMarks } from './vrmarks.js';
import { VRMenu } from './vrmenu.js';
import { VRHands } from './vrhands.js';
import { VRNukeZone } from './vrnuke.js';
import { VRStaff } from './vrstaff.js';
import { MAP_SIZE } from './maps.js';
import { LITE, VR_PRESETS } from './quest.js';
import { STRUCTS } from './specs.js';

const _UP = new THREE.Vector3(0, 1, 0);
const PAN_SPEED = 0.6;   // m/s of table at S <= 1 m, grows as sqrt(S)
const SNAP_DEG = 30;
const MAX_SCALE = 200;   // physical map width limit (m); the old limit was 80, view presets "ground" go to 120
const evOut = (v, sg) => (sg > 0 ? Math.ceil(v / 2) : Math.floor(v / 2)) * 2;
const DX = [1, 0, -1, 0], DZ = [0, 1, 0, -1];
const ADJ_MAX = 192;   // adjacency cable segments (a link = 1 line + 4 diamond segments at the neighbour end)

export class VRSystem {
  constructor(renderer, ui, hooks = {}) {
    this.r = renderer;
    this.ui = ui;
    this.hooks = hooks;

    this.supported = false;
    this.preferredMode = 'immersive-ar';
    this.inVR = false;
    this.session = null;
    this.passthrough = true;

    // Scale & table geometry
    // In real physical space (meters relative to player origin):
    this.tablePhysicalPos = new THREE.Vector3(0, 0.75, -0.85); // 75cm high, 85cm forward
    this.tablePhysicalScale = 1.25; // 1.25 meters wide in physical space
    this.tableRotation = 0; // horizontal yaw rotation
    this.tableCenterGame = new THREE.Vector3(MAP_SIZE / 2, 0, MAP_SIZE / 2); // focal game point

    this.s = this.tablePhysicalScale / MAP_SIZE; // meters per game unit
    this.iconDeg = 1.3; this.iconAng = 0.006; this.icOn = new Map();   // icon size (deg) / model angular radius (rad) below which an entity is drawn as an icon
    this.iconDeclutter = 1; this.iconSep = 1.25; this.iconHold = 0.75;   // icon declutter (vrmarks): on/off, min angular separation (icon sizes), hysteresis (a shown icon keeps its place down to sep * hold)

    // Dolly rig: holds camera and controllers in game world coordinates
    this.dolly = new THREE.Group();
    this.dolly.name = 'VR_Dolly';

    // 3D Wrist Panel & 3D World Markers
    this.panel = new VRPanel({
      system: this,
      ui: this.ui,
      renderer: this.r,
      hooks: {
        exitVR: () => this.menu.exitPressed(),
        pauseMenu: () => { if (this.hooks.pauseMenu) this.hooks.pauseMenu(); },
        togglePassthrough: () => this.togglePassthrough(),
        help: () => this.menu.open('help')   // «?» на панели: схема управления
      }
    });

    this.marks = new VRMarks(this.r);
    this.staff = new VRStaff(this);   // «Штаб» (13.1): screen of the menu, panel buttons, zone by trigger, marks on the table
    this.menu = new VRMenu(this);   // 3D menu (6.1/6.2); main.js binds its hooks
    this.dolly.add(this.menu.object3d);
    this.isTWA = false; this.quitting = false;

    // WebXR Controllers & Grips
    const gl = this.r.gl;
    this.controller0 = gl.xr.getController(0);
    this.controller1 = gl.xr.getController(1);
    this.grip0 = gl.xr.getControllerGrip(0);
    this.grip1 = gl.xr.getControllerGrip(1);

    this.rightController = null;
    this.leftController = null;
    this.rightGrip = null;
    this.leftGrip = null;

    // Controller visual rays and interaction helpers
    this.setupVisuals();
    this.setupEvents();
    this.hands = new VRHands(this);   // hands holding Quest Touch Plus controllers on the grips, tracked hands (11.13)

    // Interaction state
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 4000;
    this.laserHit = null;
    this.laserEntity = null;

    this.dragStart = null;
    this.dragCurrent = null;
    this.isDragging = false;

    // Precise aiming (10.2): One Euro filter on the ray direction, grid snap with hysteresis, pre-press ghost cell, 5x5 grid under the ghost
    this.aim = { minCutoff: 1.0, beta: 0.5, dCutoff: 4.0, resetDeg: 5, hyst: 0.6, minCellM: 0.005, lagMs: 120, dwellMs: 60, mexRadius: 16, gridN: 5, hystM: 0.007, magnetMin: 6, magnetBonus: 1.8, originRange: 80 };
    this._ax = new THREE.Vector3(); this._ad = new THREE.Vector3(); this._ao = new THREE.Vector3();   // filtered dir, raw dir, origin
    this._aOn = false; this._aT = 0; this._dx = new Float32Array(3);
    this.snapKey = null; this.snapStep = 2; this._out0 = 0; this.snapX = 0; this.snapZ = 0; this.snapOk = false; this.snapHave = false;
    this._hT = new Float64Array(32); this._hX = new Float32Array(32); this._hZ = new Float32Array(32); this._hN = 0; this._hI = 0;
    this._pre = { x: 0, y: 0 };
    this._cand = Array.from({ length: 8 }, () => ({ x: 0, z: 0, d: 0 })); this._probe = { key: '', spec: null, x: 0, y: 0 }; this._bonusMap = new Map(); this.snapMagnet = false; this.ghostX = 0; this.ghostZ = 0; this.ghostKey = null;
    // adjacency cables (11.9.3): ghost -> neighbours with a bonus, selected structure -> e.adj.n; one LineSegments, `count` = live segments
    this.adjLines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(ADJ_MAX * 2 * 3), 3)),
      new THREE.LineBasicMaterial({ color: 0x9fffd0, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }));
    this.adjLines.frustumCulled = false; this.adjLines.renderOrder = 21; this.adjLines.visible = false; this.adjLines.count = 0; this.adjLines.geometry.setDrawRange(0, 0);
    // GL lines are 1 px in XR: a flat ribbon (~3 mm on the table) per cable segment makes them readable
    this.adjRib = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(ADJ_MAX * 18), 3)),
      new THREE.MeshBasicMaterial({ color: 0x9fffd0, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    this.adjRib.frustumCulled = false; this.adjRib.renderOrder = 21; this.adjRib.visible = false; this.adjRib.geometry.setDrawRange(0, 0);
    this._alT = 0; this._alSig = ''; this.ghostBonus = '';
    const G = this.aim.gridN;
    this.snapGrid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array((G + 1) * G * 4 * 4 * 3), 3)),
      new THREE.LineBasicMaterial({ color: 0x5dff8a, transparent: true, opacity: 0.75, depthWrite: false }));
    this.nukeZone = null; this._nzHit = { x: 0, z: 0 };
    this.snapGrid.frustumCulled = false; this.snapGrid.renderOrder = 20; this.snapGrid.visible = false; this._gOk = null; this._gX = NaN; this._gZ = NaN; this._gS = 0;

    this.smoothTurn = false;   // right stick X: false = 30 deg snap turn about the head, true = smooth
    this._snapArmed = true;

    // Check support on creation
    this.checkSupport();
  }

  async checkSupport() {
    if (!navigator.xr) {
      this.supported = false;
      return false;
    }
    try {
      const ar = await navigator.xr.isSessionSupported('immersive-ar');
      if (ar) {
        this.supported = true;
        this.preferredMode = 'immersive-ar';
        return true;
      }
      const vr = await navigator.xr.isSessionSupported('immersive-vr');
      if (vr) {
        this.supported = true;
        this.preferredMode = 'immersive-vr';
        this.passthrough = false;
        return true;
      }
    } catch (e) {
      console.warn('WebXR check error:', e);
    }
    this.supported = false;
    return false;
  }

  setupVisuals() {
    // Laser beam (line segments)
    const rayGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1)
    ]);
    const rayMat = new THREE.LineBasicMaterial({
      color: 0x5fd0ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      toneMapped: false
    });
    this.laserRay = new THREE.Line(rayGeo, rayMat);
    this.laserRay.frustumCulled = false;
    this.laserRay.renderOrder = 20;

    // Reticle cursor at laser hit point
    const retGeo = new THREE.RingGeometry(0.015, 0.022, 24);
    const retMat = new THREE.MeshBasicMaterial({
      color: 0x5fd0ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false
    });
    this.reticle = new THREE.Mesh(retGeo, retMat);
    this.reticle.visible = false;
    this.reticle.renderOrder = 21;
    this.reticle2 = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.036, 24), retMat);   // 2nd ring = Shift (order queue)
    this.reticle2.visible = false;
    this.reticle.add(this.reticle2);

    // Drag selection ring on the terrain surface
    const selRingGeo = new THREE.RingGeometry(0.96, 1.0, 48).rotateX(-Math.PI / 2);
    const selRingMat = new THREE.MeshBasicMaterial({
      color: 0x5dff8a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      toneMapped: false
    });
    this.selCircle = new THREE.Mesh(selRingGeo, selRingMat);
    this.selCircle.visible = false;
    this.selCircle.renderOrder = 15;

    // A-drag formation preview: slots (points) + facing arrow, game-world coordinates
    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 256), 3)); fg.setDrawRange(0, 0);
    const ag = new THREE.BufferGeometry(); ag.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 5), 3));
    this.fPrev = new THREE.Group(); this.fPrev.visible = false;
    this.fPts = new THREE.Points(fg, new THREE.PointsMaterial({ color: 0x5dff8a, size: 7, sizeAttenuation: false, depthTest: false, toneMapped: false }));
    this.fArrow = new THREE.Line(ag, new THREE.LineBasicMaterial({ color: 0x5dff8a, depthTest: false, toneMapped: false }));
    for (const o of [this.fPts, this.fArrow]) { o.frustumCulled = false; o.renderOrder = 16; this.fPrev.add(o); }
  }

  setupEvents() {
    const onConnected = (idx, c, g) => (e) => {
      const data = e.data;
      c.inputSource = data;
      if (data.handedness === 'right') {
        this.rightController = c;
        this.rightGrip = g;
        c.add(this.laserRay);
      } else if (data.handedness === 'left') {
        this.leftController = c;
        this.leftGrip = g;
        g.add(this.panel.object3d);
      } else {
        // Fallback default
        if (!this.rightController) {
          this.rightController = c;
          this.rightGrip = g;
          c.add(this.laserRay);
        } else if (!this.leftController) {
          this.leftController = c;
          this.leftGrip = g;
          g.add(this.panel.object3d);
        }
      }
    };

    const onDisconnected = (c, g) => () => {
      c.inputSource = null;
      if (this.rightController === c) this.rightController = null;
      if (this.leftController === c) this.leftController = null;
      if (this.rightGrip === g) this.rightGrip = null;
      if (this.leftGrip === g) this.leftGrip = null;
    };

    this.controller0.addEventListener('connected', onConnected(0, this.controller0, this.grip0));
    this.controller0.addEventListener('disconnected', onDisconnected(this.controller0, this.grip0));
    this.controller1.addEventListener('connected', onConnected(1, this.controller1, this.grip1));
    this.controller1.addEventListener('disconnected', onDisconnected(this.controller1, this.grip1));

    // Controller input events
    this.controller0.addEventListener('selectstart', (e) => this.onSelectStart(0, e));
    this.controller0.addEventListener('selectend', (e) => this.onSelectEnd(0, e));
    this.controller0.addEventListener('squeezestart', (e) => this.onSqueezeStart(0, e));
    this.controller0.addEventListener('squeezeend', (e) => this.onSqueezeEnd(0, e));

    this.controller1.addEventListener('selectstart', (e) => this.onSelectStart(1, e));
    this.controller1.addEventListener('selectend', (e) => this.onSelectEnd(1, e));
    this.controller1.addEventListener('squeezestart', (e) => this.onSqueezeStart(1, e));
    this.controller1.addEventListener('squeezeend', (e) => this.onSqueezeEnd(1, e));
  }

  // ---------------------------------------------------------------- WebXR Session
  async startSession() {
    if (!navigator.xr) return false;
    const ok = await this.checkSupport();
    if (!ok) {
      console.warn('WebXR не поддерживается в этом браузере или шлем не найден.'); this.ui.flash('WebXR не поддерживается в этом браузере или шлем не найден.');
      return false;
    }

    try {
      const mode = this.preferredMode;
      const sessionInit = {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hand-tracking', 'hit-test']
      };

      const session = await navigator.xr.requestSession(mode, sessionInit);
      this.session = session;
      this.inVR = true;

      const gl = this.r.gl;
      // WebXR depthNear/depthFar are physical meters, not game-world units.
      this.savedCamera = { near: this.r.camera.near, far: this.r.camera.far, fov: this.r.camera.fov };
      this.r.camera.near = 0.02;
      this.r.camera.far = 100;
      this.r.camera.updateProjectionMatrix();
      gl.xr.enabled = true;
      const qp = VR_PRESETS[this.menu?.hooks?.settings?.vrQuality] || VR_PRESETS.med;   // пресет качества из меню VR
      if (LITE) gl.xr.setFramebufferScaleFactor(qp.scale);   // low 0.8: ~35% fewer pixels per eye; med 1.0; high 1.2
      await gl.xr.setSession(session);
      if (LITE && session.updateTargetFrameRate && session.supportedFrameRates?.includes(72)) session.updateTargetFrameRate(72).catch(() => {});   // Quest: ровные 72 Гц вместо 90 с пропусками

      // Quest 3 optimization: maximum foveated rendering
      if (gl.xr.setFoveation) gl.xr.setFoveation(LITE ? qp.fov : 1.0);

      // Add dolly to scene, add camera and controllers into dolly
      this.r.scene.add(this.dolly);
      this.dolly.add(this.r.camera);
      this.dolly.add(this.controller0);
      this.dolly.add(this.controller1);
      this.dolly.add(this.grip0);
      this.dolly.add(this.grip1);

      this.r.scene.add(this.reticle);
      this.r.scene.add(this.snapGrid);
      this.r.scene.add(this.adjLines); this.r.scene.add(this.adjRib);
      this.r.scene.add(this.selCircle);
      this.r.scene.add(this.fPrev);
      this.r.scene.add(this.marks.object3d);
      this.marks.setVisible(true);

      // Save graphics state
      this.savedBackground = this.r.scene.background;
      this.savedFog = this.r.scene.fog;
      this.vrSky = this.r.sky;
      this.savedShadowType = gl.shadowMap.type;

      // Quest 3 performance: basic shadow map in VR
      gl.shadowMap.type = THREE.BasicShadowMap;

      this.hasCenteredOnACU = false;
      // Center table around player's ACU or map center
      const game = this.ui.game;
      const acu = game && this.ui.team && game.teams[this.ui.team]?.acu;
      if (acu && acu.alive) {
        this.tableCenterGame.set(acu.x, game.terrain.surfaceAt(acu.x, acu.y), acu.y);
        this.hasCenteredOnACU = true;
      } else {
        this.tableCenterGame.set(MAP_SIZE / 2, 0, MAP_SIZE / 2);
      }

      this.quitting = false;
      this.menu.applySettings();
      this.applyPassthrough(this.passthrough);
      this.updateDolly();

      session.addEventListener('end', () => this.onSessionEnd());

      // Update UI button state
      this.updateVRButtons(true);
      return true;
    } catch (e) {
      console.error('Failed to start WebXR session:', e);
      this.ui.flash('Ошибка запуска WebXR: ' + e.message);
      return false;
    }
  }

  async endSession() {
    if (this.session) {
      await this.session.end();
    }
  }

  onSessionEnd() {
    this.inVR = false;
    this.session = null;
    this.menu.hide();

    const gl = this.r.gl;
    // Restore scene & camera
    this.dolly.remove(this.r.camera);
    this.r.scene.remove(this.reticle);
    this.r.scene.remove(this.adjLines); this.r.scene.remove(this.adjRib); this.adjLines.visible = false; this.adjRib.visible = false; this.adjLines.count = 0;
    if (this.nukeZone) { this.nukeZone.dispose(); this.nukeZone = null; }
    this.r.scene.remove(this.snapGrid); this.snapGrid.visible = false; this.snapReset(); this._aOn = false;
    this.r.scene.remove(this.selCircle);
    this.r.scene.remove(this.fPrev);
    this.r.scene.remove(this.marks.object3d);
    this.r.scene.remove(this.dolly);
    this.marks.setVisible(false);
    if (this.savedCamera) {
      Object.assign(this.r.camera, this.savedCamera);
      this.r.camera.updateProjectionMatrix();
    }

    // Restore background & shadows
    this.r.scene.background = this.savedBackground;
    this.r.scene.fog = this.savedFog;
    if (this.r.sky) this.r.sky.visible = true;
    if (this.r.skirt) this.r.skirt.visible = true;
    this.restoreLook();
    if (this.r.water) this.r.water.scale.setScalar(1);
    this.r.unitScale = 1;
    gl.shadowMap.type = this.savedShadowType || THREE.PCFSoftShadowMap;
    setTimeout(() => this.r.resize(), 0);   // desktop particle scale / canvas size (resize is a no-op while presenting)

    this.updateVRButtons(false);
    if (this.hooks.sessionEnd) this.hooks.sessionEnd();
  }

  togglePassthrough() {
    this.passthrough = !this.passthrough;
    this.applyPassthrough(this.passthrough);
    this.panel.message(this.passthrough ? 'Смешанная реальность (пасстру)' : 'Виртуальный мир (небо)');
  }

  applyPassthrough(on) {
    // MR: only the map itself on the real table (no 12 km ground skirt, water clipped to the map)
    if (this.r.skirt) this.r.skirt.visible = !on;
    if (this.r.water) this.r.water.scale.setScalar(on ? 0.2 : 1);
    if (on) {
      this.r.scene.background = null;
      this.r.scene.fog = null;
      if (this.r.sky) this.r.sky.visible = false;
    } else {
      this.r.scene.background = this.savedBackground;
      this.r.scene.fog = this.savedFog;
      if (this.r.sky) this.r.sky.visible = true;
    }
  }

  updateVRButtons(inVR) {
    const btns = document.querySelectorAll('.vr-btn');
    btns.forEach(b => {
      b.textContent = inVR ? 'ВЫЙТИ ИЗ VR' : '🥽 ВОЙТИ В VR';
      b.classList.toggle('active', inVR);
    });
  }

  // ---------------------------------------------------------------- Table placement & look (6.3 / 6.4)
  // Once per session, and after the headset's recenter ('reset'): table in front of the head, at a standing/seated height
  // that follows the head, map north pointing away from the player.
  updatePlacement(xf) {
    const rs = this.r.gl.xr.getReferenceSpace?.();
    if (rs && rs !== this._rsHooked) { this._rsHooked = rs; rs.addEventListener?.('reset', () => { this.needPlace = true; }); }
    if (this.session && this._placedFor !== this.session) { this._placedFor = this.session; this.needPlace = true; }
    const gpL = this.leftController?.inputSource?.gamepad, gpR = this.rightController?.inputSource?.gamepad;
    const stickR = !!gpR?.buttons[3]?.pressed, xBtn = !!gpL?.buttons[4]?.pressed;
    if (stickR && !this._stickR) this.needPlace = true;                       // right stick click: table in front of me
    if (xBtn && !this._xBtn) this.panelHidden = !this.panelHidden;            // X: hide / show the wrist panel
    this._stickR = stickR; this._xBtn = xBtn;
    if (!this.needPlace || !xf || !rs) return;
    const pose = xf.getViewerPose(rs);
    if (!pose) return;
    const p = pose.transform.position, o = pose.transform.orientation;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w)); fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    this.placeTable(new THREE.Vector3(p.x, p.y, p.z), fwd);
    this.needPlace = false;
  }

  placeTable(head, fwd) {
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    this.tableRotation = -yaw;
    const floor = this.tablePhysicalScale > 3;   // map spread over the floor: keep it on the floor
    this.tablePhysicalPos.set(head.x + fwd.x * (floor ? 0.3 : 0.85), floor ? 0.02 : THREE.MathUtils.clamp(head.y - 0.6, 0.45, 1.1), head.z + fwd.z * (floor ? 0.3 : 0.85));
    this.updateDolly();
  }

  // Per-frame look of the world on the table: no 12 km skirt / 5x water around the table, a physical floor in VR,
  // sky as a 50 m dome around the head, sub-pixel trees hidden on a small table, map border only while it is a table.
  updateLook() {
    const r = this.r;
    if (r.skirt) r.skirt.visible = false;
    if (r.water) r.water.scale.setScalar(0.2);
    if (r.border) r.border.visible = this.tablePhysicalScale < 6;
    const small = this.s < 0.002;
    for (const m of Object.values(r.featureMeshes || {})) m.visible = !small;
    if (r.sky?.visible) { r.camera.getWorldPosition(r.sky.position); r.sky.scale.setScalar(50 / this.s / 6000); }
    if (r.scene.fog) { r.scene.fog.near = 30 / this.s; r.scene.fog.far = 90 / this.s; }   // fog in metres around the player, not PC camera distance
    if (!this.floor) {
      const g = new THREE.CircleGeometry(12, 48).rotateX(-Math.PI / 2);
      this.floor = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x1b2229, toneMapped: false }));
      this.floor.renderOrder = -0.5;
    }
    if (this.floor.parent !== this.dolly) this.dolly.add(this.floor);
    this.floor.visible = !this.passthrough && this.tablePhysicalScale < 6;
    // wrist panel: stays on the left hand, turned to the eyes, a bit above the controller
    const P = this.panel.object3d;
    P.visible = !this.panelHidden && !!this.ui.game;   // no battle: the VR menu replaces the wrist panel
    if (P.parent && P.visible) {
      P.position.set(0.03, 0.11, -0.02);
      const eye = new THREE.Vector3(); r.camera.getWorldPosition(eye);
      P.lookAt(eye);
    }
  }

  restoreLook() {
    const r = this.r;
    if (r.border) r.border.visible = true;
    for (const m of Object.values(r.featureMeshes || {})) m.visible = true;
    if (r.sky) r.sky.scale.setScalar(1);
    this.floor?.removeFromParent();
  }

  // ---------------------------------------------------------------- Transformation
  // Maps tableCenterGame to appear at tablePhysicalPos with tablePhysicalScale and tableRotation
  updateDolly() {
    this.s = this.tablePhysicalScale / MAP_SIZE;
    const dollyScale = 1 / this.s;

    this.dolly.scale.setScalar(dollyScale);
    this.dolly.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.tableRotation);

    // Pos_world = DollyPos + R_dolly * (DollyScale * Pos_phys)
    // DollyPos = Table_game - R_dolly * (DollyScale * Table_phys)
    const scaledPhys = this.tablePhysicalPos.clone().multiplyScalar(dollyScale);
    scaledPhys.applyQuaternion(this.dolly.quaternion);

    this.dolly.position.copy(this.tableCenterGame).sub(scaledPhys);
    this.dolly.updateMatrixWorld(true);

    // units keep their real size at any table scale (r.unitScale stays 1); far ones are shown by icons
  }

  // ---------------------------------------------------------------- Input Handling
  onSelectStart(idx, e) {
    if (!this.inVR) return;

    const c = idx === 0 ? this.controller0 : this.controller1;
    if (c !== this.rightController && this.rightController) return;

    // the menu is on top of everything: while it is open the trigger only presses its buttons
    if (this.menu.visible) { if (this.menu.hoverId) { this.menu.press(); this.r.audio?.play('ui'); } return; }

    // Check hit on wrist panel first
    if (this.panel.hoverBtn) {
      this.panel.press();
      this.r.audio?.play('ui');
      return;
    }

    if (!this.laserHit) return;

    const game = this.ui.game;
    if (!game) return;
    if (this.staff.selectStart()) return;   // zone of a lieutenant: press = centre, drag = radius

    // If currently in a target mode (build, amove, patrol, reclaim, oc, launch)
    if (this.ui.mode && this.ui.canCommand) {
      let p = this.ground(this.laserHit);
      if (this.ui.mode === 'build' && this.snapHave && this.snapKey === this.ui.buildKey) p = this.preCell() || p;   // the cell the ghost stood in ~120 ms ago, not the trigger jerk
      this.ui.modeClick(p, this.laserEntity, this.shift);
      this.haptic();
      return;
    }

    // Start point or drag selection
    this.dragShift = this.shift;
    this.dragStart = this.laserHit.clone();
    this.dragEnt = this.laserEntity;
    this.dragCurrent = this.laserHit.clone();
    this.isDragging = false;
  }

  onSelectEnd(idx, e) {
    if (!this.inVR) return;
    const c = idx === 0 ? this.controller0 : this.controller1;
    if (c !== this.rightController && this.rightController) return;
    if (this.staff.selectEnd()) return;

    if (!this.dragStart) return;

    const game = this.ui.game, sh = this.shift || this.dragShift;
    if (game) {
      if (this.isDragging && this.dragCurrent) {
        // Multi-unit radius selection
        const radius = Math.hypot(this.dragCurrent.x - this.dragStart.x, this.dragCurrent.z - this.dragStart.z);
        const myTeam = this.ui.team || 1;
        const inside = [];

        for (const u of game.units) {
          if (!u.alive || u.carried || u.team !== myTeam) continue;
          if (Math.hypot(u.x - this.dragStart.x, u.y - this.dragStart.z) <= radius) {
            inside.push(u);
          }
        }
        if (inside.length > 0) {
          this.ui.selection = sh ? [...new Set([...this.ui.selection, ...inside])] : inside;
          this.r.audio?.play('ui');
        } else {
          // Check structures
          const sInside = game.structs.filter(s => s.alive && s.team === myTeam && Math.hypot(s.x - this.dragStart.x, s.y - this.dragStart.z) <= radius);
          this.ui.selection = sh ? [...new Set([...this.ui.selection, ...sInside])] : sInside;
          if (sInside.length) this.r.audio?.play('ui');
        }
        this.ui.refreshPanels(true);
      } else {
        // Single click: own unit/building -> select it; otherwise with own units selected -> order (like right click)
        const myTeam = this.ui.team || 1;
        let ent = this.dragEnt;
        if (!ent) ent = game.units.find(u => u.alive && !u.carried && u.team === myTeam && Math.hypot(u.x - this.dragStart.x, u.y - this.dragStart.z) < 12)
          || game.structs.find(s => s.alive && s.team === myTeam && Math.hypot(s.x - this.dragStart.x, s.y - this.dragStart.z) < s.spec.size * 0.8 + 6);
        const haveOwn = this.ui.canCommand && this.ui.selection.some(s => s.alive && this.ui.mine(s));
        const now = performance.now(), dbl = !!ent && ent.team === myTeam && this._lt && this._lt.id === ent.id && now - this._lt.t < 350;
        this._lt = ent ? { t: now, id: ent.id } : null;
        if (dbl) {   // double trigger: all own of the same type on the visible part of the table (this frame's draw list)
          const r = this.r, all = new Set([ent]);
          for (let k = 0; k < r.dlN; k++) { const e = r.dl[k]; if (e.alive && !e.carried && e.team === myTeam && e.key === ent.key) all.add(e); }
          this.ui.selection = sh ? [...new Set([...this.ui.selection, ...all])] : [...all];
          this.r.audio?.play('ui');
        } else if (ent && (ent.team === myTeam || !haveOwn)) {
          const sel = this.ui.selection;
          this.ui.selection = sh && ent.team === myTeam ? (sel.includes(ent) ? sel.filter(x => x !== ent) : [...sel, ent]) : [ent];   // Shift: toggle
          this.r.audio?.play('ui');
        } else if (haveOwn) {
          this.command(this.dragStart, this.dragEnt);   // Shift: queued
        } else {
          this.ui.selection = [];
        }
        this.ui.refreshPanels(true);
      }
    }

    this.dragStart = null;
    this.dragCurrent = null;
    this.isDragging = false;
    this.selCircle.visible = false;
  }

  // Grip = grab the table. One hand: move / lift it with the hand. Two hands: scale, rotate and move around the hands' midpoint
  // (a point of the map under the hands stays under them). Grip poses are dolly-local = physical meters.
  onSqueezeStart() { this.grab = null; }
  onSqueezeEnd() { this.grab = null; }

  gripPos(g) { return new THREE.Vector3().setFromMatrixPosition(g.matrix); }

  updateGrab() {
    const held = (c) => !!c?.inputSource?.gamepad?.buttons?.[1]?.pressed;
    const hands = [];
    if (held(this.controller0)) hands.push(this.grip0);
    if (held(this.controller1)) hands.push(this.grip1);
    if (!hands.length) { this.grab = null; return; }
    this.viewAnim = null;   // the user took the table: a running view preset gives way
    const ps = hands.map(g => this.gripPos(g));
    const mid = ps.length === 2 ? ps[0].clone().add(ps[1]).multiplyScalar(0.5) : ps[0];
    const yaw = ps.length === 2 ? Math.atan2(-(ps[1].z - ps[0].z), ps[1].x - ps[0].x) : 0;   // rotation about +Y
    const dist = ps.length === 2 ? Math.max(0.05, ps[0].distanceTo(ps[1])) : 1;
    if (!this.grab || this.grab.n !== ps.length) {   // (re)start when a hand is added or released
      this.grab = { n: ps.length, mid0: mid.clone(), yaw0: yaw, dist0: dist, pos0: this.tablePhysicalPos.clone(), scale0: this.tablePhysicalScale, rot0: this.tableRotation };
      return;
    }
    const G = this.grab;
    if (ps.length === 1) {
      this.tablePhysicalPos.copy(G.pos0).add(mid).sub(G.mid0);
    } else {
      const scale = THREE.MathUtils.clamp(G.scale0 * dist / G.dist0, 0.3, MAX_SCALE);
      const f = scale / G.scale0, dYaw = yaw - G.yaw0;
      this.tablePhysicalScale = scale;
      this.tableRotation = G.rot0 - dYaw;
      this.tablePhysicalPos.copy(G.pos0).sub(G.mid0).multiplyScalar(f).applyAxisAngle(_UP, dYaw).add(mid);
    }
    this.updateDolly();
  }

  // ---------------------------------------------------------------- Per-frame update
  update(game, ui, dt) {
    if (!this.inVR) return;
    const xf = this.r.gl.xr.getFrame?.();
    if (xf && window.__xrrec?.rec) window.__xrrec.frame(xf, this.r.gl.xr.getReferenceSpace());
    this.updatePlacement(xf);

    // A generated match can create its terrain after session entry.
    if (this.r.sky && this.r.sky !== this.vrSky) {
      this.vrSky = this.r.sky;
      this.savedBackground = this.r.scene.background;
      this.savedFog = this.r.scene.fog;
      this.applyPassthrough(this.passthrough);
    }

    if (!this.hasCenteredOnACU && game && this.ui.team) {
      const acu = game.teams[this.ui.team]?.acu;
      if (acu && acu.alive) {
        this.hasCenteredOnACU = true;
        this.tableCenterGame.set(acu.x, game.terrain.surfaceAt(acu.x, acu.y), acu.y);
        this.updateDolly();
      }
    }

    // Handle table grab (one hand: move/lift, two hands: scale/rotate)
    this.updateGrab();

    // Handle thumbstick navigation
    this.updateThumbsticks(dt);
    this.updateButtons();

    this.hands.update(dt);
    // Update raycasting and pointer visuals
    this.updateRaycast(game);
    this.updateNukeZone(game);
    this.staff.update(dt);
    this.updateAdjLines(game, dt);

    // Update drag selection circle visual
    this.updateDragVisual();

    // Update 3D Wrist Panel
    this.updateLook();
    this.panel.update(dt);
    this.menu.update(dt);
  }

  // XR per-entity icon choice: angular radius of the (enlarged) model seen from the eye < iconAng, hysteresis x1.25.
  // (physical radius r*us*s over physical distance d*s: s cancels, so world units are enough)
  iconFor(e, x, h, z) {
    const m = this.r.camera.matrixWorld.elements, dx = x - m[12], dy = h - m[13], dz = z - m[14], us = this.r.unitScale, k = e.kind;
    const sp = e.spec, rad = (k === 'struct' ? sp.size / 2 * (1 + (us - 1) * 0.3) : (sp.radius || 3) * (k === 'unit' ? us : 1));
    const on = this.icOn.get(e.id) || false, v = rad < (on ? 1.25 : 1) * this.iconAng * Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (v !== on) { if (this.icOn.size > 4000) this.icOn.clear(); this.icOn.set(e.id, v); }
    return v;
  }

  // after Renderer.syncViews (needs this frame's draw list)
  updateMarks(game, ui) {
    if (!this.inVR) return;
    this.marks.update(game, ui, {
      s: this.s,
      camPos: this.r.camera.position,
      camQuat: this.r.camera.quaternion,
      iconDeg: this.iconDeg,
      iconDeclutter: this.iconDeclutter,
      iconSep: this.iconSep,
      iconHold: this.iconHold,
      shift: this.shift,
      laserEnt: this.laserEntity
    });
    this.staff.updateMarks(game);
  }

  // Quest Touch (xr-standard): 0 trigger, 1 squeeze, 3 stick press, 4 A/X, 5 B/Y. Edge-detected per frame.
  updateButtons() {
    const gp = this.rightController?.inputSource?.gamepad;
    const prev = this.prevBtns || (this.prevBtns = []);
    if (!gp) return;
    const sh = this.shift; if (sh !== this._shiftPrev) { this._shiftPrev = sh; this.panel.needsRedraw = true; }
    const down = (i) => !!gp.buttons[i]?.pressed && !prev[i], menuOn = this.menu.visible;
    if (this.menu.visible) { if (down(5)) this.menu.back(); }   // menu open: B = back, A / B do not reach the map
    else if (down(4) && this.laserHit && this.ui.canCommand) this.aDrag = { p: this.laserHit.clone(), ent: this.laserEntity, shift: this.shift };   // A: order (right click), on release
    if (this.aDrag && !gp.buttons[4]?.pressed) this.aRelease();
    if (!menuOn && down(5)) {                                                                            // B: cancel mode / deselect
      if (this.ui.mode) this.ui.setMode(null);
      else if (this.ui.selection.length) { this.ui.selection = []; this.ui.refreshPanels(true); }
    }
    for (let i = 0; i < gp.buttons.length; i++) prev[i] = !!gp.buttons[i]?.pressed;
  }

  // A released: dragged > 12 units = formation move facing the drag (PC right-drag), else the plain context order
  aRelease() {
    const a = this.aDrag, ui = this.ui, g = ui.game; this.aDrag = null; this.fPrev.visible = false;
    if (!a || !g || !ui.canCommand) return;
    const units = ui.commandUnits(), sh = this.shift || a.shift;
    if (a.facing !== undefined && units.length) { g.orderMove(units, a.p.x, a.p.z, sh, 'move', ui.formOpts({ facing: a.facing })); ui.ping({ x: a.p.x, y: a.p.z }, '#5dff8a'); this.r.audio?.play('ui'); this.haptic(); }
    else this.command(a.p, a.ent);
  }
  groupTap(n) {
    const ui = this.ui, now = performance.now();
    if (this.shift) { ui.groups[n] = ui.selection.filter(x => ui.mine(x)); ui.flash(`Группа ${n}: ${ui.groups[n].length} ед.`); this.panel.needsRedraw = true; return; }
    const grp = (ui.groups[n] || []).filter(x => x.alive); if (!grp.length) return;
    if (this._lg && this._lg.k === n && now - this._lg.t < 350) this.centerView(grp);
    this._lg = { k: n, t: now };
    ui.selection = grp; ui.refreshPanels(true);
  }

  // ui.* take ground points as {x, y} (y = map Z); the laser hit is a Vector3 (y = height)
  ground(p) { return { x: p.x, y: p.z }; }
  command(p, ent) { this.ui.commandAt(this.ground(p), ent || null, this.shift); this.haptic(); }
  // left trigger held = Shift (order queue / add to selection)
  get shift() { return (this.leftController?.inputSource?.gamepad?.buttons?.[0]?.value || 0) > 0.5; }
  haptic() { try { this.rightController?.inputSource?.gamepad?.hapticActuators?.[0]?.pulse?.(0.3, 30)?.catch?.(() => {}); } catch {} }

  // Map point under the head gaze (game coords): terrain hit of the camera ray, else the plane at table height, else the point under the head.
  gazePivot() {
    const cam = this.r.camera, o = new THREE.Vector3(), d = new THREE.Vector3(0, 0, -1), T = this.r.terrain;
    cam.updateMatrixWorld(true);
    cam.getWorldPosition(o); d.transformDirection(cam.matrixWorld).normalize();
    let G = this.gazeHit();
    if (!G && d.y < -0.01) { const t = (this.tableCenterGame.y - o.y) / d.y; if (t > 0 && t < 4000) G = o.clone().addScaledVector(d, t); }
    if (!G) G = o.clone();
    G.x = THREE.MathUtils.clamp(G.x, 0, MAP_SIZE); G.z = THREE.MathUtils.clamp(G.z, 0, MAP_SIZE);
    if (T) G.y = T.surfaceAt(G.x, G.z);
    return G;
  }

  // Terrain point hit by the head gaze (game coords) or null
  gazeHit() {
    const cam = this.r.camera, T = this.r.terrain; if (!T) return null;
    const o = new THREE.Vector3(), d = new THREE.Vector3(0, 0, -1);
    cam.updateMatrixWorld(true);
    cam.getWorldPosition(o); d.transformDirection(cam.matrixWorld).normalize();
    const G = this.rayTerrain(o, d, T);
    return G && G.x >= 0 && G.x <= MAP_SIZE && G.z >= 0 && G.z <= MAP_SIZE ? G : null;
  }

  // Map point straight below the head (game coords, may lie off the map): zooming about it only moves the view up / down
  headPivot() {
    const G = this.r.camera.getWorldPosition(new THREE.Vector3()), T = this.r.terrain;
    const on = G.x >= 0 && G.x <= MAP_SIZE && G.z >= 0 && G.z <= MAP_SIZE;
    G.y = T && on ? T.surfaceAt(G.x, G.z) : this.tableCenterGame.y;
    return G;
  }

  // Scale the table by f about game point G: G stays physically where it is; the table center (game) is kept
  zoomAbout(G, f) {
    const Q = this.dolly.worldToLocal(G.clone()), s0 = this.tablePhysicalScale;
    this.tablePhysicalScale = THREE.MathUtils.clamp(s0 * f, 0.3, MAX_SCALE);
    this.tablePhysicalPos.sub(Q).multiplyScalar(this.tablePhysicalScale / s0).add(Q);
    this.updateDolly();
    // head inside a mountain: lower the world until the surface under the head is 15 cm below it
    const T = this.r.terrain, h = this.r.camera.position;
    this.viewAnim = null;
    if (!T) return;
    const hw = this.r.camera.getWorldPosition(new THREE.Vector3());
    const surf = (T.surfaceAt(hw.x, hw.z) - this.dolly.position.y) / this.dolly.scale.y;   // physical height of the surface under the head
    if (surf > h.y - 0.15) { this.tablePhysicalPos.y -= surf - (h.y - 0.15); this.updateDolly(); }
  }

  // Turn the world by dYaw (rad, + = view turns right) about the vertical axis through the head
  turnAbout(dYaw) {
    this.viewAnim = null;
    const h = this.r.camera.position;
    this.tablePhysicalPos.sub(h).applyAxisAngle(_UP, dYaw).add(h);
    this.tableRotation -= dYaw;
    this.updateDolly();
  }

  // Left stick click (PC: Home / Space): table to the selection centroid, else to the ACU; physical position kept
  centerView(list) {
    const g = this.ui.game; if (!g) return;
    let l = (list || this.ui.selection).filter(e => e.alive);
    if (!l.length) { const a = g.teams[this.ui.team]?.acu; l = a && a.alive ? [a] : []; }
    if (!l.length) return;
    const x = l.reduce((a, e) => a + e.x, 0) / l.length, z = l.reduce((a, e) => a + e.y, 0) / l.length;
    this.tableCenterGame.set(x, g.terrain.surfaceAt(x, z), z);
    this.updateDolly();
  }

  // ---- view presets (11.5): the table moves to a new state in 0.4 s, the head never does.
  // Focus: selection centroid, else the terrain point under the gaze, else the ACU. The heading (tableRotation) is kept.
  viewFocus() {
    const g = this.ui.game, T = this.r.terrain; if (!g) return null;
    const l = this.ui.selection.filter(e => e.alive);
    let x, z, spread = 0;
    if (l.length) {
      x = l.reduce((a, e) => a + e.x, 0) / l.length; z = l.reduce((a, e) => a + e.y, 0) / l.length;
      spread = Math.max(...l.map(e => Math.hypot(e.x - x, e.y - z)));
    } else {
      const h = this.gazeHit(), a = g.teams[this.ui.team]?.acu;
      if (h) { x = h.x; z = h.z; } else if (a && a.alive) { x = a.x; z = a.y; } else { x = MAP_SIZE / 2; z = MAP_SIZE / 2; }
    }
    return { F: new THREE.Vector3(x, T ? T.surfaceAt(x, z) : g.terrain.surfaceAt(x, z), z), spread };
  }

  // Target table state for a preset: { C: game point shown at P, P: physical position, S: physical map width (m), R: rotation }
  viewTarget(name) {
    const foc = this.viewFocus(); if (!foc) return null;
    const { F, spread } = foc, T = this.r.terrain || this.ui.game.terrain, Rc = this.tableRotation;
    const head = this.r.camera.position.clone();   // dolly-local = physical
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.r.camera.quaternion); fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    if (name === 'overview') {
      return { C: F, S: 1.2, R: Rc, P: new THREE.Vector3(head.x + fwd.x * 0.85, THREE.MathUtils.clamp(head.y - 0.6, 0.45, 1.1), head.z + fwd.z * 0.85) };
    }
    if (name === 'rot90') {
      return { C: F, S: this.tablePhysicalScale, R: Rc + Math.PI / 2, P: this.dolly.worldToLocal(F.clone()) };
    }
    // eye-based views: choose the eye point E in game space, then P = head - Rq^-1 (E - F) * s
    let S, d, up, down = 0;
    if (name === 'top') { S = 1.6; d = 0; up = 0; down = 0.9; }
    else if (name === 'side') { S = 48; d = Math.max(40, spread + 25); up = 25; }
    else if (name === 'ground') { S = 120; d = Math.max(14, spread + 8); up = 4; }
    else return null;
    const s = S / MAP_SIZE, Rq = new THREE.Quaternion().setFromAxisAngle(_UP, Rc);
    const D = fwd.clone().applyQuaternion(Rq);   // current heading in game space
    const E = F.clone().addScaledVector(D, -d);
    E.x = THREE.MathUtils.clamp(E.x, 0, MAP_SIZE); E.z = THREE.MathUtils.clamp(E.z, 0, MAP_SIZE);
    E.y = down ? F.y + down / s : T.surfaceAt(E.x, E.z) + up;
    const P = E.clone().sub(F).applyQuaternion(Rq.clone().invert()).multiplyScalar(s).multiplyScalar(-1).add(head);
    return { C: F, S, R: Rc, P };
  }

  viewPreset(name) {
    const t = this.viewTarget(name); if (!t) return false;
    this.needPlace = false;
    this.viewName = name;
    this.viewAnim = { t: 0, dur: 0.4, from: { C: this.tableCenterGame.clone(), P: this.tablePhysicalPos.clone(), S: this.tablePhysicalScale, R: this.tableRotation }, to: t };
    this.panel.needsRedraw = true;
    return true;
  }

  stepView(dt) {
    const a = this.viewAnim; if (!a) return;
    a.t = Math.min(a.dur, a.t + dt);
    const k = a.t / a.dur, e = k * k * (3 - 2 * k), f = a.from, o = a.to;
    this.tableCenterGame.lerpVectors(f.C, o.C, e);
    this.tablePhysicalPos.lerpVectors(f.P, o.P, e);
    this.tablePhysicalScale = f.S * Math.pow(o.S / f.S, e);
    this.tableRotation = f.R + (o.R - f.R) * e;
    this.updateDolly();
    if (a.t >= a.dur) this.viewAnim = null;
  }

  // left stick click: Overview -> Top -> Side -> Overview ...
  cycleView() {
    const order = ['overview', 'top', 'side'], i = order.indexOf(this.viewName);
    this.viewPreset(order[(i + 1) % order.length]);
  }

  updateThumbsticks(dt) {
    this.stepView(dt);
    const gpLeft = this.leftController?.inputSource?.gamepad;
    const gpRight = this.rightController?.inputSource?.gamepad;

    let modified = false;

    // Left stick: walk over the map relative to the head (stick forward = forward); speed grows with the table size
    if (gpLeft && gpLeft.axes.length >= 4) {
      const ax = gpLeft.axes[2], ay = gpLeft.axes[3];
      if (Math.hypot(ax, ay) > 0.15) {
        const cq = this.r.camera.quaternion;   // dolly-local = physical
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cq); fwd.y = 0;
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
        fwd.normalize();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        const spd = PAN_SPEED * Math.max(1, Math.sqrt(this.tablePhysicalScale));
        const move = fwd.multiplyScalar(-ay).addScaledVector(right, ax).multiplyScalar(spd * dt / this.s).applyQuaternion(this.dolly.quaternion);
        this.viewAnim = null;
        // keep the point under the head on the map (the head moves with the center); a head already off the map may only come back
        const H = this.r.camera.getWorldPosition(new THREE.Vector3()), cl = (h, d) => THREE.MathUtils.clamp(h + d, Math.min(0, h), Math.max(MAP_SIZE, h)) - h;
        this.tableCenterGame.x += cl(H.x, move.x);
        this.tableCenterGame.z += cl(H.z, move.z);
        modified = true;
      }
    }
    const sl = !!gpLeft?.buttons[3]?.pressed;
    if (sl && !this._stickL) { this.cycleView(); modified = false; }
    this._stickL = sl;

    if (gpRight && gpRight.axes.length >= 4) {
      const rx = gpRight.axes[2], ry = gpRight.axes[3];
      if (modified) { this.updateDolly(); modified = false; }
      // X: snap turn about the head (edge: > 0.7, re-arm < 0.3) or smooth
      if (this.smoothTurn) { if (Math.abs(rx) > 0.15) this.turnAbout(rx * dt * 1.5); }
      else if (Math.abs(rx) > 0.7 && this._snapArmed) { this._snapArmed = false; this.turnAbout(Math.sign(rx) * (this.snapDeg || SNAP_DEG) * Math.PI / 180); }
      else if (Math.abs(rx) < 0.3) this._snapArmed = true;
      // Y: rise / descend straight above the map point under the head (x2 per ~0.5 s at full deflection, dead zone 0.2)
      if (Math.abs(ry) > 0.2) {
        const a = Math.sign(ry) * (Math.abs(ry) - 0.2) / 0.8;
        this.zoomAbout(this.headPivot(), Math.exp(a * dt * Math.LN2 / 0.5));   // stick up = rise (table shrinks)
      }
    }

    if (modified) this.updateDolly();
  }

  // Ray vs heightfield (game units): march in steps of ~2 height cells, then bisect.
  // Raycasting the terrain mesh (130-260k triangles, no BVH) cost ~25 ms per frame on Quest.
  rayTerrain(origin, dir, T) {
    const top = T.maxH + 1, bot = T.minH - 1;
    let t0 = 0, t1 = 4000;
    if (Math.abs(dir.y) > 1e-6) {   // clip to the height slab
      const a = (top - origin.y) / dir.y, b = (bot - origin.y) / dir.y;
      t0 = Math.max(0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
    } else if (origin.y > top || origin.y < bot) return null;
    if (t0 >= t1) return null;
    const above = (t) => { const x = origin.x + dir.x * t, z = origin.z + dir.z * t; return origin.y + dir.y * t > T.surfaceAt(x, z); };
    const step = 8;
    let prev = t0;
    if (!above(prev)) return null;
    for (let t = t0 + step; ; t += step) {
      const tc = Math.min(t, t1);
      if (!above(tc)) {
        let lo = prev, hi = tc;
        for (let k = 0; k < 10; k++) { const m = (lo + hi) / 2; if (above(m)) lo = m; else hi = m; }
        return origin.clone().addScaledVector(dir, hi);
      }
      if (tc >= t1) return null;
      prev = tc;
    }
  }

  updateRaycast(game) {
    if (!this.rightController) {
      this.laserRay.visible = false;
      this.reticle.visible = false;
      return;
    }

    this.laserRay.visible = true;
    this.snapGrid.visible = false;

    // Ray origin and direction from right controller in world space (raw: the panel and menu lasers use it as is)
    const origin = this._ao, dir = this._ad;
    dir.set(0, 0, -1);
    this.rightController.getWorldPosition(origin);
    dir.transformDirection(this.rightController.matrixWorld).normalize();

    this.raycaster.set(origin, dir);

    // 0. Open menu: the laser sees only the menu
    if (this.menu.visible) {
      const md = this.menu.hit(this.raycaster);
      this.laserHit = null; this.laserEntity = null; this.reticle.visible = false;
      this.updateLaserVisual(md !== null ? md : 3.0 / this.s, md !== null ? 0xffe060 : 0x5fd0ff);
      return;
    }

    // 1. Test wrist panel hit first
    const panelDist = this.panel.hit(this.raycaster);
    if (panelDist !== null) {
      this.laserHit = null;
      this.laserEntity = null;
      this.updateLaserVisual(panelDist, 0xffe060);
      this.reticle.visible = false;
      return;
    }

    // 2. Test terrain mesh hit
    let hitPoint = null;
    let hitEntity = null;

    const T = this.r.terrain;
    // smoothed direction for aiming, only while placing a building (the filter lag would shift ordinary selection/orders, see replay smoke_order_scale)
    let aimDir = dir; if (this.ui.mode === 'build') aimDir = this.filterAim(dir); else this._aOn = false;
    if (T) hitPoint = this.rayTerrain(origin, aimDir, T);

    // Fallback: math ground plane if ray missed mesh
    if (!hitPoint && aimDir.y < -0.01) {
      const planeY = game?.terrain?.minH || 0;
      const t = (planeY - origin.y) / aimDir.y;
      if (t > 0 && t < 3000) {
        hitPoint = origin.clone().addScaledVector(aimDir, t);
      }
    }

    if (hitPoint) {
      hitPoint.x = THREE.MathUtils.clamp(hitPoint.x, 0, MAP_SIZE);
      hitPoint.z = THREE.MathUtils.clamp(hitPoint.z, 0, MAP_SIZE);
      if (game?.terrain) {
        hitPoint.y = game.terrain.surfaceAt(hitPoint.x, hitPoint.z);
      }

      this.laserHit = hitPoint;

      // Check unit near laser hit
      if (game) {
        hitEntity = game.units.find(u => u.alive && !u.carried && Math.hypot(u.x - hitPoint.x, u.y - hitPoint.z) < (u.spec.radius || 2) * 2 + 3);
        if (!hitEntity) {
          hitEntity = game.structs.find(s => s.alive && Math.hypot(s.x - hitPoint.x, s.y - hitPoint.z) < s.spec.size * 0.8 + 4);
        }
      }
      this.laserEntity = hitEntity;

      const dist = origin.distanceTo(hitPoint);
      const hitColor = hitEntity ? (this.ui.isEnemy?.(hitEntity) ? 0xff4a3a : 0x5dff8a) : (this.ui.mode ? 0xffe060 : 0x5fd0ff);

      this.updateLaserVisual(dist, hitColor);

      // Position reticle on terrain
      this.reticle.visible = true;
      this.reticle.position.copy(hitPoint).add(new THREE.Vector3(0, 0.4, 0));
      this.reticle.rotation.x = -Math.PI / 2;
      this.reticle.scale.setScalar(1 / this.s);
      this.reticle2.visible = this.shift;

      // If in build mode, update build ghost at laser hit
      if (this.ui.mode === 'build' && this.ui.buildKey && game) this.updateBuildSnap(game, hitPoint);
      else this.snapReset();
    } else {
      this.laserHit = null;
      this.laserEntity = null;
      this.updateLaserVisual(3.0 / this.s, 0x5fd0ff);
      this.reticle.visible = false;
      if (this.ui.mode === 'build') this.r.setGhost(null);
      this.snapReset();
    }
  }

  // 13.2: blast zones under the laser while ui.mode === 'launch' (nuke silo selected: 3 zones of STRUCTS.sml.silo; otherwise the tactical radius)
  updateNukeZone(game) {
    const on = this.ui.mode === 'launch' && this.laserHit && game;
    if (!on) { if (this.nukeZone) this.nukeZone.hide(); return; }
    const nz = this.nukeZone || (this.nukeZone = new VRNukeZone(this.r.scene)), hit = this.laserHit;
    this._nzHit.x = hit.x; this._nzHit.z = hit.z;
    const nuke = this.ui.launchSilos().some(s => s.spec.silo.kind === 'nuke');
    nz.update(nuke ? this.ui.nukeSpec() : null, this._nzHit, game.terrain);
  }

  // One Euro filter (Casiez 2012) on the unit ray direction, per component; a large deliberate move (> resetDeg) skips the lag.
  filterAim(raw) {
    const a = this.aim, now = performance.now(), f = this._ax, d = this._dx;
    const dt = Math.min(0.1, Math.max(1 / 240, (now - this._aT) / 1000));
    if (!this._aOn || now - this._aT > 250 || f.dot(raw) < Math.cos(a.resetDeg * Math.PI / 180)) { f.copy(raw); d[0] = d[1] = d[2] = 0; this._aOn = true; this._aT = now; return f; }
    this._aT = now;
    const al = (fc) => 1 / (1 + 1 / (2 * Math.PI * fc) / dt), ad = al(a.dCutoff);
    const vx = (raw.x - f.x) / dt, vy = (raw.y - f.y) / dt, vz = (raw.z - f.z) / dt;
    d[0] += ad * (vx - d[0]); d[1] += ad * (vy - d[1]); d[2] += ad * (vz - d[2]);
    const k = al(a.minCutoff + a.beta * Math.hypot(d[0], d[1], d[2]));
    f.x += k * (raw.x - f.x); f.y += k * (raw.y - f.y); f.z += k * (raw.z - f.z);
    return f.normalize();
  }

  snapReset() { this.snapHave = false; this.snapKey = null; this._hN = 0; this._hI = 0; this._out0 = 0; this.snapGrid.visible = false; }

  // Build ghost on a cell grid, hysteresis, mex attraction x2, adjacency magnet (11.9).
  // Step: 2 game units (as canPlace) when a cell is >= minCellM on the table, else the smallest even step that is; the grid origin is the touching edge of the nearest
  // own structure, not 0. Magnet: touching positions around own structures (Game.adjacent true, canPlace ok) within ~1 cell pull the ghost, magnetBonus x stronger with a bonus.
  updateBuildSnap(game, hit) {
    const key = this.ui.buildKey, S = STRUCTS[key], a = this.aim, team = this.ui.team || 1;
    let step = Math.max(2, a.minCellM / this.s); step = Math.ceil(step / 2 - 1e-6) * 2;
    if (this.snapKey !== key || this.snapStep !== step) { this.snapKey = key; this.snapStep = step; this.snapHave = false; this._hN = 0; this._hI = 0; this._out0 = 0; }
    let cx, cz;
    this.snapMagnet = false;
    if (S.place === 'mex') {   // attraction radius x2 in VR; the deposit itself is the cell
      let bd = a.mexRadius, bx = 0, bz = 0, f = false;
      for (const m of game.terrain.mass) { const d = Math.hypot(m.x - hit.x, m.y - hit.z); if (d < bd) { bd = d; bx = m.x; bz = m.y; f = true; } }
      if (f) { cx = bx; cz = bz; } else { cx = hit.x; cz = hit.z; }
    } else {
      const h = S.size / 2, sts = game.structs, cand = this._cand, mb = a.magnetBonus, R = Math.max(step, a.magnetMin), ctor = game.constructor, probe = this._probe;
      let nc = 0, near = null, nd = a.originRange;
      probe.key = key; probe.spec = S;
      for (let i = 0; i < sts.length; i++) {
        const o = sts[i]; if (!o.alive || o.team !== team) continue;
        const oh = o.spec.size / 2, tt = oh + h, ex = Math.abs(hit.x - o.x), ez = Math.abs(hit.z - o.y);
        const ed = Math.max(ex, ez) - oh; if (ed < nd) { nd = ed; near = o; }
        if (ex > tt + R * mb + 2 || ez > tt + R * mb + 2) continue;
        const bonus = this.adjHasBonus(game, key, o);
        for (let sd = 0; sd < 4; sd++) {   // sides +x -x +z -z: the perpendicular coordinate is the touching one, along the side the aim is projected on a flush-aligned lattice
          const sg = (sd & 1) ? -1 : 1, lim = Math.floor((tt - 2) / 2) * 2;
          let qx, qz;
          // sizes may be odd-half (8 + 22): round outward to the even grid of canPlace, the gap stays within adjacent()'s 2.5
          if (sd < 2) { qx = evOut(o.x + sg * tt, sg); const b0 = o.y + oh - h; qz = Math.min(o.y + lim, Math.max(o.y - lim, Math.round((b0 + Math.round((hit.z - b0) / step) * step) / 2) * 2)); }
          else { qz = evOut(o.y + sg * tt, sg); const b0 = o.x + oh - h; qx = Math.min(o.x + lim, Math.max(o.x - lim, Math.round((b0 + Math.round((hit.x - b0) / step) * step) / 2) * 2)); }
          const de = Math.hypot(qx - hit.x, qz - hit.z) / (bonus ? mb : 1);
          if (de > R) continue;
          let k;
          if (nc < cand.length) k = nc++; else if (de < cand[nc - 1].d) k = nc - 1; else continue;
          while (k > 0 && cand[k - 1].d > de) { const t = cand[k]; cand[k] = cand[k - 1]; cand[k - 1] = t; k--; }
          const c = cand[k]; c.x = qx; c.z = qz; c.d = de;
        }
      }
      let mx = NaN, mz = NaN;
      for (let i = 0; i < nc; i++) {   // nearest candidate that canPlace accepts and Game.adjacent confirms
        const c = cand[i], r = game.canPlace(team, key, c.x, c.z);
        if (!r.ok) continue;
        probe.x = r.x; probe.y = r.y;
        let adj = false; for (let j = 0; j < sts.length; j++) { const o = sts[j]; if (o.alive && o.team === team && ctor.adjacent(probe, o)) { adj = true; break; } }
        if (adj) { mx = r.x; mz = r.y; break; }
      }
      if (mx === mx) { cx = mx; cz = mz; this.snapMagnet = true; }
      else {   // lattice anchored at the touching edge of the nearest own structure
        let ox = 0, oz = 0;
        if (near) { ox = Math.ceil((near.x + near.spec.size / 2 + h) / 2) * 2; oz = Math.round((near.y + near.spec.size / 2 - h) / 2) * 2; }
        cx = ox + Math.round((hit.x - ox) / step) * step; cz = oz + Math.round((hit.z - oz) / step) * step;
      }
      if (this.snapHave) {   // stay unless past 0.6 cell for dwellMs (tremor spikes are shorter than that)
        if (Math.max(Math.abs(hit.x - this.snapX), Math.abs(hit.z - this.snapZ)) <= Math.max(a.hyst * step, a.hystM / this.s)) { this._out0 = 0; cx = this.snapX; cz = this.snapZ; }
        else { const now = performance.now(); if (!this._out0) this._out0 = now; if (now - this._out0 < a.dwellMs) { cx = this.snapX; cz = this.snapZ; } else this._out0 = 0; }
      }
    }
    this.snapX = cx; this.snapZ = cz; this.snapHave = true;
    const i = this._hI;
    this._hT[i] = performance.now(); this._hX[i] = cx; this._hZ[i] = cz; this._hI = (i + 1) & 31; if (this._hN < 32) this._hN++;
    const can = game.canPlace(team, key, cx, cz);
    this.snapOk = can.ok;
    const gx = can.x ?? cx, gz = can.y ?? cz;
    this.ghostX = gx; this.ghostZ = gz; this.ghostKey = key;
    this.r.setGhost(key, gx, gz, can.ok, team, game.terrain.surfaceAt(gx, gz));
    this.updateSnapGrid(game.terrain, gx, gz, step, can.ok);
  }

  // Cell the ghost occupied lagMs before now (oldest if the history is shorter): ground-style {x, y} for ui.modeClick, no allocation.
  preCell() {
    if (!this._hN) return null;
    const lim = performance.now() - this.aim.lagMs;
    let j = (this._hI - 1) & 31, pick = j;
    for (let n = 0; n < this._hN; n++, j = (j - 1) & 31) { pick = j; if (this._hT[j] <= lim) break; }
    this._pre.x = this._hX[pick]; this._pre.y = this._hZ[pick];
    return this._pre;
  }

  // does placing `key` next to `o` give or receive any adjacency bonus (spec-only, cached)
  adjHasBonus(game, key, o) {
    const k = key + '|' + o.key; let v = this._bonusMap.get(k);
    if (v === undefined) {
      const p = { key, spec: STRUCTS[key], x: 0, y: 0 }, c = game.constructor;
      v = Object.keys(c.adjBonus(p, o)).length > 0 || Object.keys(c.adjBonus(o, p)).length > 0; this._bonusMap.set(k, v);
    }
    return v;
  }

  // Adjacency cables (11.9.3): ghost -> every neighbour that gives/receives a bonus; selected structures -> e.adj.n. One LineSegments, preallocated, `count` segments.
  // Rebuilt when the ghost cell changes and 4x/s for selections; also fills `ghostBonus` (panel line).
  updateAdjLines(game, dt) {
    const L = this.adjLines, ui = this.ui;
    if (!game || !this.inVR) { L.visible = false; L.count = 0; this.adjRib.visible = false; return; }
    const ghost = ui.mode === 'build' && this.snapHave && this.ghostKey === ui.buildKey && !!STRUCTS[this.ghostKey];
    const gk = ghost ? this.ghostKey : null, gx = ghost ? this.ghostX : 0, gz = ghost ? this.ghostZ : 0;
    this._alT += dt;
    if (gk === this._agK && gx === this._agX && gz === this._agZ && this._alT < 0.25) return;
    this._alT = 0; this._agK = gk; this._agX = gx; this._agZ = gz;
    const P = L.geometry.attributes.position.array, T = game.terrain, sts = game.structs, ctor = game.constructor, team = ui.team || 1, mk = Math.max(3, 0.004 / this.s);
    let n = 0;
    const link = (ax, az, bx, bz) => {   // 1 cable + a diamond at the far end
      if (n + 5 > ADJ_MAX) return;
      const ay = T.surfaceAt(ax, az) + 3, by = T.surfaceAt(bx, bz) + 3, o = n * 6; n += 5;
      P[o] = ax; P[o + 1] = ay; P[o + 2] = az; P[o + 3] = bx; P[o + 4] = by; P[o + 5] = bz;
      for (let k = 0; k < 4; k++) { const j = o + 6 + k * 6, k1 = (k + 1) & 3; P[j] = bx + DX[k] * mk; P[j + 1] = by; P[j + 2] = bz + DZ[k] * mk; P[j + 3] = bx + DX[k1] * mk; P[j + 4] = by; P[j + 5] = bz + DZ[k1] * mk; }
    };
    let text = '';
    if (ghost) {
      const probe = this._probe; probe.key = gk; probe.spec = STRUCTS[gk]; probe.x = gx; probe.y = gz;
      for (let i = 0; i < sts.length; i++) { const o = sts[i]; if (o.alive && o.team === team && ctor.adjacent(probe, o) && this.adjHasBonus(game, gk, o)) link(gx, gz, o.x, o.y); }
      const a = game.previewAdjacency(team, gk, gx, gz), f = (v) => String(Math.round(v * 1000) / 10).replace('.', ','), pr = [];
      if (a.m) pr.push(`+${f(a.m)}% массы`);
      if (a.e) pr.push(`+${f(a.e)}% энергии`);
      if (a.eCost) pr.push(`−${f(Math.min(0.6, a.eCost))}% энергии`);
      if (a.mCost) pr.push(`−${f(Math.min(0.4, a.mCost))}% массы`);
      if (a.give) pr.push(`усиливает соседей: ${a.give}`);
      if (pr.length) text = '⬡ Соседство: ' + pr.join(', ');
    }
    for (const e of ui.selection) {
      if (e.kind !== 'struct' || !e.alive || !e.adj || !e.adj.n.length) continue;
      for (const id of e.adj.n) for (let i = 0; i < sts.length; i++) if (sts[i].id === id) { if (sts[i].alive) link(e.x, e.y, sts[i].x, sts[i].y); break; }
    }
    L.count = n; L.visible = n > 0; L.geometry.setDrawRange(0, n * 2); L.geometry.attributes.position.needsUpdate = true;
    const RB = this.adjRib, R = RB.geometry.attributes.position.array, w = 0.0015 / this.s;   // half width: 1.5 mm on the table
    for (let i = 0; i < n; i++) {   // horizontal quad (2 triangles) around each segment
      const o = i * 6, r = i * 18, ax = P[o], ay = P[o + 1], az = P[o + 2], bx = P[o + 3], by = P[o + 4], bz = P[o + 5];
      let px = bz - az, pz = ax - bx; const l = Math.hypot(px, pz) || 1; px = px / l * w; pz = pz / l * w;
      R[r] = ax - px; R[r + 1] = ay; R[r + 2] = az - pz; R[r + 3] = ax + px; R[r + 4] = ay; R[r + 5] = az + pz; R[r + 6] = bx + px; R[r + 7] = by; R[r + 8] = bz + pz;
      R[r + 9] = ax - px; R[r + 10] = ay; R[r + 11] = az - pz; R[r + 12] = bx + px; R[r + 13] = by; R[r + 14] = bz + pz; R[r + 15] = bx - px; R[r + 16] = by; R[r + 17] = bz - pz;
    }
    RB.visible = n > 0; RB.geometry.setDrawRange(0, n * 6); RB.geometry.attributes.position.needsUpdate = true;
    if (text !== this.ghostBonus) { this.ghostBonus = text; this.panel.needsRedraw = true; }
  }

  // gridN x gridN cell lines around the ghost, draped on the terrain, green/red by canPlace
  updateSnapGrid(T, x, z, step, ok) {
    const g = this.snapGrid; g.visible = true;
    if (this._gX === x && this._gZ === z && this._gS === step && this._gOk === ok) return;
    this._gX = x; this._gZ = z; this._gS = step; this._gOk = ok;
    g.material.color.setHex(ok ? 0x5dff8a : 0xff4a3a);
    const N = this.aim.gridN, P = g.geometry.attributes.position.array, x0 = x - N * step / 2, z0 = z - N * step / 2, sub = 4, ds = step / sub;
    const clamp = (v) => Math.min(MAP_SIZE, Math.max(0, v));
    let o = 0;
    for (let l = 0; l <= N; l++) for (let c = 0; c < N * sub; c++) for (let ax = 0; ax < 2; ax++) for (let e = 0; e < 2; e++) {
      const u = (c + e) * ds, px = ax ? x0 + l * step : x0 + u, pz = ax ? z0 + u : z0 + l * step;
      P[o++] = px; P[o++] = T.surfaceAt(clamp(px), clamp(pz)) + 0.4; P[o++] = pz;
    }
    g.geometry.attributes.position.needsUpdate = true;
  }

  updateLaserVisual(dist, colorHex) {
    // Laser points along local -Z axis in controller space
    const localDist = dist * this.s; // convert to controller meter units
    const pts = [new THREE.Vector3(0, 0, this.hands.laserZ), new THREE.Vector3(0, 0, -localDist)];   // starts at the controller tip (hands.laserZ <= 0)
    this.laserRay.geometry.setFromPoints(pts);
    this.laserRay.material.color.setHex(colorHex);
  }

  updateAFormation() {
    const a = this.aDrag, ui = this.ui, g = ui.game, hit = this.laserHit;
    if (!a || !g || !hit) return;
    if (Math.hypot(hit.x - a.p.x, hit.z - a.p.z) <= 12) { a.facing = undefined; this.fPrev.visible = false; return; }
    const units = ui.commandUnits(); if (!units.length) return;
    a.facing = Math.atan2(hit.z - a.p.z, hit.x - a.p.x);
    const f = g.formation(units, a.p.x, a.p.z, ui.formOpts({ facing: a.facing, queue: a.shift })), T = g.terrain, P = this.fPts.geometry.attributes.position;
    let n = 0; for (const p of f.values()) { if (n >= 256) break; P.setXYZ(n++, p.x, T.surfaceAt(p.x, p.y) + 0.3, p.y); }
    P.needsUpdate = true; this.fPts.geometry.setDrawRange(0, n);
    const L = 30, c = Math.cos(a.facing), s = Math.sin(a.facing), y = a.p.y + 0.3, A = this.fArrow.geometry.attributes.position, bx = a.p.x + c * L, bz = a.p.z + s * L;
    A.setXYZ(0, a.p.x, y, a.p.z); A.setXYZ(1, bx, y, bz); A.setXYZ(2, bx - Math.cos(a.facing - 0.5) * 8, y, bz - Math.sin(a.facing - 0.5) * 8); A.setXYZ(3, bx, y, bz); A.setXYZ(4, bx - Math.cos(a.facing + 0.5) * 8, y, bz - Math.sin(a.facing + 0.5) * 8);
    A.needsUpdate = true; this.fPrev.visible = true;
  }

  updateDragVisual() {
    this.updateAFormation();
    if (!this.dragStart || !this.laserHit) {
      this.selCircle.visible = false;
      return;
    }

    const rad = Math.hypot(this.laserHit.x - this.dragStart.x, this.laserHit.z - this.dragStart.z);
    if (rad > 12) {
      this.isDragging = true;
      this.dragCurrent.copy(this.laserHit);

      this.selCircle.visible = true;
      this.selCircle.position.set(this.dragStart.x, this.dragStart.y + 0.3, this.dragStart.z);
      this.selCircle.scale.set(rad, 1, rad);
    } else {
      this.selCircle.visible = false;
    }
  }

  dispose() {
    this.endSession();
    this.panel.dispose();
    this.marks.dispose();
    this.staff.dispose();
  }
}
