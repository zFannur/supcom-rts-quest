// «Штаб» in VR (plan 13.1): the player's lieutenants (js/lieutenant.js, Staff) without the DOM window of js/staffui.js.
//  - screen «ШТАБ» of the VR menu (js/vrmenu.js draws it through draw(m) with its own primitives: btn / field / stepper / check):
//    roster + card of the chosen lieutenant (state, tiles, spending, budget, style, toggles, pause, show, zone, hand over, recall, log)
//    and the "new lieutenant" view (sACU, area, style, budget, hand over the selection at once);
//  - wrist panel: «ШТАБ» and «→ помощнику» (Ctrl+H on PC: the selection goes to the last used lieutenant), a line in the selection info;
//  - zone of responsibility with the right trigger on the table (press = centre, drag = radius), as the mouse on PC;
//  - on the table: a diamond in the area colour on every handed-over unit / structure (1 instanced draw call) and the zones (2 draw calls).
// All rules (what can be handed over, budgets, texts, zone radius) stay in Staff / StaffUI: this file only calls them.
import * as THREE from 'three';
import { AREAS, AREA_ORDER, STYLES, NO_SACU } from './lieutenant.js';
import { zoneR } from './staffui.js';
import { MAP_SIZE } from './maps.js';

const MARK_MAX = 1024, ZN = 64, ZR = 4, ZONE_MAX = 9;   // diamonds; zone: segments per ring, fill rings, zones (8 + the one being drawn)
const DEG = Math.PI / 180;
const COS = new Float32Array(ZN), SIN = new Float32Array(ZN); for (let i = 0; i < ZN; i++) { COS[i] = Math.cos(i / ZN * 2 * Math.PI); SIN[i] = Math.sin(i / ZN * 2 * Math.PI); }
const K = { line: 'rgba(95,208,255,.28)', line2: 'rgba(95,208,255,.55)', accent: '#5fd0ff', accent2: '#5dffb0', mass: '#46e070', energy: '#ffd23c', bad: '#ff4a3a', warn: '#ffb040', text: '#dbe7ef', dim: '#8aa0ae', field: '#0d1822' };
const STATE = { pause: ['ПАУЗА', '#ffb040'], none: ['НЕТ ЮНИТОВ', '#8aa0ae'], idle: ['ПРОСТОЙ', '#5fd0ff'], wait: ['ЗАТЫК', '#ff7a5c'], work: ['РАБОТАЕТ', '#46e070'] };
const CAT_COL = { 'ЭКОНОМИКА': '#46e070', 'ВОЙСКА': '#ffb040', 'ОБОРОНА': '#ff7a5c', 'ТЕХНОЛОГИИ': '#c59bff', 'ПРИКАЗ': '#5fd0ff' };
const LOG_ROWS = 5;
const AREA_RGB = {}; for (const a of AREA_ORDER) { const n = parseInt(AREAS[a].color.slice(1), 16); AREA_RGB[a] = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const fmtT = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const plural = (n, f) => { const a = n % 10, b = n % 100; return f[a === 1 && b !== 11 ? 0 : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 1 : 2]; };
const short = (lt) => lt.name.replace('Лейтенант ', '');

export class VRStaff {
  constructor(vr) {
    this.vr = vr;
    this.view = 'list'; this.selId = null; this.pick = null; this.logPage = 0;   // screen state
    this.zoneDrag = false; this.redrawT = 0;
    this.object3d = new THREE.Group(); this.object3d.name = 'VR_Staff';
    vr.marks.object3d.add(this.object3d);   // in the scene (game coordinates) while in VR, like the other table marks

    // diamonds over handed-over entities: angular size like the icons (vrmarks), procedural shape, outline orange = manual control
    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec4 instanceData; // xy: offset (rad), z: edge (rad), w: 1 = under manual control
        varying vec2 vUv; varying vec3 vColor; varying float vMan;
        void main() {
          vUv = uv; vMan = instanceData.w;
          #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
          #else
          vColor = vec3(1.0);
          #endif
          vec4 mv = viewMatrix * vec4(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2], 1.0);
          mv.xy += (position.xy * instanceData.z + instanceData.xy) * length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec2 vUv; varying vec3 vColor; varying float vMan;
        void main() {
          vec2 p = abs(vUv - 0.5); float d = p.x + p.y;
          if (d > 0.5) discard;
          bool edge = d > 0.34;
          vec3 dark = vec3(0.016, 0.04, 0.063), orange = vec3(1.0, 0.69, 0.25);
          vec3 c = vMan > 0.5 ? (edge ? orange : dark) : (edge ? dark : vColor);
          gl_FragColor = vec4(c, 1.0);
        }`,
      transparent: true, depthWrite: false, depthTest: false, toneMapped: false
    });
    this.marks = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, MARK_MAX);
    this.markData = new Float32Array(MARK_MAX * 4);
    this.marks.geometry.setAttribute('instanceData', new THREE.InstancedBufferAttribute(this.markData, 4).setUsage(THREE.DynamicDrawUsage));
    this.marks.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MARK_MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.marks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const im = this.marks.instanceMatrix.array; for (let i = 0; i < MARK_MAX; i++) im[i * 16] = im[i * 16 + 5] = im[i * 16 + 10] = im[i * 16 + 15] = 1;
    this.marks.frustumCulled = false; this.marks.renderOrder = 12; this.marks.count = 0; this.marks.visible = false;
    this.object3d.add(this.marks);
    this.markCount = 0;

    // zones: dashed ring (LineSegments) + translucent disc on the relief (4 rings x 64 segments, non-indexed triangles), vertex colours with alpha
    const lp = new Float32Array(ZONE_MAX * ZN * 2 * 3), lc = new Float32Array(ZONE_MAX * ZN * 2 * 4);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lp, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(lc, 4).setUsage(THREE.DynamicDrawUsage));
    this.zLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const TRI = ZN * (1 + 2 * (ZR - 1)) * 3;   // vertices per zone disc
    this.triPer = TRI;
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ZONE_MAX * TRI * 3), 3).setUsage(THREE.DynamicDrawUsage));
    fg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ZONE_MAX * TRI * 4), 4).setUsage(THREE.DynamicDrawUsage));
    this.zFill = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    for (const o of [this.zLines, this.zFill]) { o.frustumCulled = false; o.visible = false; this.object3d.add(o); }
    this.zLines.renderOrder = 9; this.zFill.renderOrder = 8;
    this.zKey = new Float64Array(ZONE_MAX * 6); this.zN = 0;   // cache: x, y, r, area index, alpha, id of each drawn zone; rebuilt only on change
    this.zH = new Float32Array(ZR * ZN + 1);                       // relief heights of one zone (scratch)
    this.zoneCount = 0;
  }

  get ui() { return this.vr.ui; }
  get staff() { return this.vr.ui.staff; }
  get sui() { return this.vr.ui.staffUI; }
  get menu() { return this.vr.menu; }
  get screenOpen() { const m = this.vr.menu; return m.visible && m.screen === 'staff'; }
  // lieutenant by id without a closure (per frame)
  lt(id) { const st = this.staff; if (!st || id === undefined) return null; const L = st.list; for (let i = 0; i < L.length; i++) if (L[i].id === id) return L[i]; return null; }
  cur() { const st = this.staff; if (!st) return null; return this.lt(this.selId) || st.last; }

  // ---------------------------------------------------------------- entry points (panel, pause menu)
  open(view) {
    if (!this.staff) { this.vr.panel.message('Штаб доступен в бою против ИИ'); return; }
    if (view === 'pick') this.startPick(this.sui.transferable().length > 0); else this.view = 'list';
    if (this.menu.visible) this.menu.go('staff'); else this.menu.open('staff');
  }
  /** «→ помощнику» on the panel = Ctrl+H: the selection goes to the last used lieutenant; none yet — the "new lieutenant" view. */
  quickGive() { if (this.staff) this.sui.quickGive(() => this.open('pick')); }
  startPick(give) { this.pick = this.sui.newPick(give); this.view = 'pick'; }
  /** B on the screen: the pick view goes back to the roster; false = let the menu close / go back. */
  back() { if (this.view === 'pick') { this.view = 'list'; this.menu.dirty = true; return true; } return false; }

  // ---------------------------------------------------------------- zone with the right trigger on the table
  zoneStart(lt) {
    this.menu.close();
    this.sui.zoneStart(lt);   // ui.mode = 'zone', StaffUI.zoneEdit
    this.vr.panel.message(`Зона «${lt.name}»: курок по столу — центр, протянуть — радиус, просто нажать — радиус 120. B — отмена`, 7000);
  }
  /** Right trigger pressed on the table (vr.js onSelectStart). True = consumed. */
  selectStart() {
    if (this.ui.mode !== 'zone') return false;
    const z = this.sui.zoneEdit, h = this.vr.laserHit;
    if (!z) { this.ui.setMode(null); return true; }
    if (h) { this.sui.zoneAt({ x: h.x, y: h.z }, 'vr'); this.zoneDrag = true; this.vr.haptic(); }
    return true;
  }
  selectEnd() {
    if (!this.zoneDrag) return false;
    this.zoneDrag = false;
    const h = this.vr.laserHit; if (h) this.sui.zoneDrag({ x: h.x, y: h.z });
    this.sui.zoneFinish(); this.vr.haptic();
    return true;
  }

  // ---------------------------------------------------------------- per frame (vr.update / vr.updateMarks), no allocations
  update(dt) {
    if (this.zoneDrag) {
      if (this.ui.mode !== 'zone' || !this.sui.zoneEdit) this.zoneDrag = false;
      else { const h = this.vr.laserHit; if (h) { const p = this._p || (this._p = { x: 0, y: 0 }); p.x = h.x; p.y = h.z; this.sui.zoneDrag(p); } }
    }
    const g = this.ui.game;   // live state while the battle time runs (the menu pause stops it: then no canvas re-upload)
    if (this.screenOpen && g) { this.redrawT += dt; if (this.redrawT > 0.5) { this.redrawT = 0; if (g.time !== this.lastT) { this.lastT = g.time; this.menu.dirty = true; } } }
  }
  updateMarks(game) {
    const ui = this.ui, st = ui.staff;
    if (!st || !game || !this.object3d.parent) { this.marks.visible = false; this.zLines.visible = this.zFill.visible = false; this.markCount = this.zoneCount = 0; return; }
    this.updateZones(game, st);
    const ren = this.vr.r, dl = ren.dl, dlN = ren.dlN, dlPos = ren.dlPos, dlIcon = ren.dlIcon, us = ren.unitScale;
    const dg = (this.vr.iconDeg || 1.3) * DEG, mk = this.vr.marks, hide = (this.vr.iconDeclutter ?? 1) !== 0 ? mk.hide : null;
    const showAll = this.screenOpen || ui.mode === 'zone', t = game.time, sel = ui.selection;
    const d = this.markData, col = this.marks.instanceColor.array, mat = this.marks.instanceMatrix.array;
    let n = 0;
    if (st.list.length) for (let i = 0; i < dlN && n < MARK_MAX; i++) {
      const e = dl[i]; if (e.lt === undefined || e.team !== ui.team) continue;
      const lt = this.lt(e.lt); if (!lt) continue;
      const icon = dlIcon[i] === 1;
      if (icon && hide && hide.length > i && hide[i] === 1) continue;   // its icon lost the declutter cell: no marker either
      if (!icon && !showAll && !sel.includes(e)) continue;               // model view: only selected / while the HQ is open (as on PC)
      const struct = e.kind === 'struct', top = struct ? (ren.metaHeight(e) || 4) : (ren.metaHeight(e) || 2) + 0.5;
      const o = n * 4, c = n * 3, m = n * 16, rgb = AREA_RGB[lt.area];
      mat[m + 12] = dlPos[i * 3]; mat[m + 13] = dlPos[i * 3 + 1] + (icon && !struct ? 1 : top * (struct ? 1 + (us - 1) * 0.3 : us)); mat[m + 14] = dlPos[i * 3 + 2];
      d[o] = icon ? dg * 0.82 : 0; d[o + 1] = icon ? dg * 1.35 : dg * 0.6; d[o + 2] = dg * 0.8; d[o + 3] = e.ltMan && e.ltMan.until > t ? 1 : 0;   // PC: icon corner (+9, −6 px of the 11 px shape)
      col[c] = rgb[0]; col[c + 1] = rgb[1]; col[c + 2] = rgb[2];
      n++;
    }
    this.markCount = n; this.marks.count = n; this.marks.visible = n > 0;
    if (n) { this.marks.geometry.attributes.instanceData.needsUpdate = true; this.marks.instanceColor.needsUpdate = true; this.marks.instanceMatrix.needsUpdate = true; }
  }
  // zones of all lieutenants + the one being drawn; buffers are rewritten only when a zone, its colour or brightness changed
  updateZones(game, st) {
    const L = st.list, z = this.sui.zoneEdit, al = this.screenOpen || this.ui.mode === 'zone' ? 1 : 0.6;
    this.zChanged = false; this.zI = 0;
    for (let i = 0; i < L.length && this.zI < ZONE_MAX; i++) { const l = L[i]; if (l.zone) this.zKeyPut(l.zone.x, l.zone.y, l.zone.r, AREA_ORDER.indexOf(l.area), al, l.id); }
    if (z && z.active && this.zI < ZONE_MAX) this.zKeyPut(z.x, z.y, zoneR(z), AREA_ORDER.indexOf(z.lt.area), 1.5, -1);
    const n = this.zI;
    if (n !== this.zN) this.zChanged = true;
    this.zN = n; this.zoneCount = n;
    this.object3d.position.y = 0.003 / this.vr.s;   // 3 mm above the relief at any table scale
    this.zLines.visible = this.zFill.visible = n > 0;
    if (!this.zChanged || !n) return;
    const t = game.terrain, H = this.zH, K6 = this.zKey, lg = this.zLines.geometry, fg = this.zFill.geometry;
    this.li = 0; this.fi = 0;
    for (let k = 0; k < n; k++) {
      const o = k * 6, cx = K6[o], cy = K6[o + 1], R = K6[o + 2], a = K6[o + 4];
      this.zc = AREA_RGB[AREA_ORDER[K6[o + 3]]]; this.zfa = Math.min(0.32, 0.1 * a); this.zla = Math.min(1, 0.6 * a + 0.1);
      this.zx = cx; this.zy = cy; this.zr = R;
      H[0] = this.hAt(t, cx, cy);
      for (let ring = 1; ring <= ZR; ring++) for (let i = 0; i < ZN; i++) H[(ring - 1) * ZN + i + 1] = this.hAt(t, cx + COS[i] * R * ring / ZR, cy + SIN[i] * R * ring / ZR);
      for (let i = 0; i < ZN; i++) {
        this.zVert(0, 0); this.zVert(1, i); this.zVert(1, i + 1);
        for (let ring = 1; ring < ZR; ring++) { this.zVert(ring, i); this.zVert(ring + 1, i); this.zVert(ring + 1, i + 1); this.zVert(ring, i); this.zVert(ring + 1, i + 1); this.zVert(ring, i + 1); }
        if ((i & 3) < 3) { this.zLineV(i); this.zLineV(i + 1); }   // dashes: 3 segments on, 1 off
      }
    }
    lg.setDrawRange(0, this.li); fg.setDrawRange(0, this.fi);
    lg.attributes.position.needsUpdate = lg.attributes.color.needsUpdate = fg.attributes.position.needsUpdate = fg.attributes.color.needsUpdate = true;
  }
  zKeyPut(x, y, r, area, a, id) {
    const K6 = this.zKey, o = this.zI++ * 6;
    if (K6[o] !== x || K6[o + 1] !== y || K6[o + 2] !== r || K6[o + 3] !== area || K6[o + 4] !== a || K6[o + 5] !== id) { K6[o] = x; K6[o + 1] = y; K6[o + 2] = r; K6[o + 3] = area; K6[o + 4] = a; K6[o + 5] = id; this.zChanged = true; }
  }
  hAt(t, x, y) { return Math.max(t.surfaceAt(Math.max(1, Math.min(MAP_SIZE - 1, x)), Math.max(1, Math.min(MAP_SIZE - 1, y))), t.water) + 0.4; }
  zVert(ring, i) {   // fill vertex: ring 0 = centre
    const fp = this.zFill.geometry.attributes.position.array, fc = this.zFill.geometry.attributes.color.array, j = i % ZN, f = this.fi++, k = ring / ZR, c = this.zc;
    fp[f * 3] = this.zx + COS[j] * this.zr * k; fp[f * 3 + 1] = ring ? this.zH[(ring - 1) * ZN + j + 1] : this.zH[0]; fp[f * 3 + 2] = this.zy + SIN[j] * this.zr * k;
    fc[f * 4] = c[0]; fc[f * 4 + 1] = c[1]; fc[f * 4 + 2] = c[2]; fc[f * 4 + 3] = this.zfa * (ring === ZR ? 1.6 : 1);
  }
  zLineV(i) {   // ring vertex of the dashed outline
    const lp = this.zLines.geometry.attributes.position.array, lc = this.zLines.geometry.attributes.color.array, j = i % ZN, v = this.li++, c = this.zc;
    lp[v * 3] = this.zx + COS[j] * this.zr; lp[v * 3 + 1] = this.zH[(ZR - 1) * ZN + j + 1] + 0.3; lp[v * 3 + 2] = this.zy + SIN[j] * this.zr;
    lc[v * 4] = c[0]; lc[v * 4 + 1] = c[1]; lc[v * 4 + 2] = c[2]; lc[v * 4 + 3] = this.zla;
  }

  // ---------------------------------------------------------------- wrist panel (vrpanel.js drawBottomRow): returns the width taken at the right
  panelRow(p, y, h) {
    const st = this.staff; if (!st || !this.ui.canCommand) return 0;
    const CWp = 1024, ents = this.sui.transferable(), last = st.last, n = st.list.length;
    const bx = CWp - 10 - 96, gx = bx - 6 - 156;
    p.button('staff', bx, y, 96, h, n ? `ШТАБ ${n}` : 'ШТАБ', () => this.open(), true, { size: 20, tip: 'Штаб: помощники-лейтенанты (H на ПК)' });
    p.button('staff-give', gx, y, 156, h, last ? '→ ' + short(last) : '→ ПОМОЩНИКУ', () => this.quickGive(), ents.length > 0,
      { size: 19, tip: ents.length ? `Передать выделенное (${ents.length}) ${last ? `помощнику «${last.name}»` : 'новому помощнику'} (Ctrl+H на ПК)` : 'Выделите юнитов или здания, чтобы передать их помощнику' });
    return CWp - gx + 6;
  }
  /** Line for the selection info of the panel: who commands this entity. */
  ltLine(e) { const lt = e && e.lt !== undefined && this.lt(e.lt); if (!lt) return null; const man = e.ltMan && this.ui.game && e.ltMan.until > this.ui.game.time; return [`Помощник «${short(lt)}» · ${lt.A.short}${man ? ' · вручную' : ''}`, lt.A.color]; }

  // ---------------------------------------------------------------- the screen (VRMenu calls draw(m) with itself; W x H = 1600 x 1000)
  draw(m) {
    const st = this.staff;
    if (!st) {
      m.frame('ШТАБ');
      m.tx('Штаб доступен в бою против ИИ', 800, 440, 30, K.dim, { align: 'center', w: 600 });
      m.btn('back', 1600 - 40 - 260, 892, 260, 82, 'НАЗАД', () => m.back(), true, { center: true, primary: true });
      return;
    }
    if (this.view === 'pick' && this.pick) this.drawPick(m, st); else { this.view = 'list'; this.drawList(m, st); }
    if (this.view === 'pick') m.footer(360, 1000 - 56, 'left', 660); else m.footer(600, 1000 - 56, 'left', 960);   // under the card / between the buttons
  }
  drawList(m, st) {
    const c = m.ctx, free = st.freeSacu().length, ents = this.sui.transferable();
    m.frame('ШТАБ — ПОМОЩНИКИ', `${st.list.length ? st.list.length + ' из 8' : 'нет помощников'} · свободных sACU: ${free}`);
    const lt = this.cur(); if (lt) this.selId = lt.id;
    // ---- roster
    const X = 40, Wd = 520;
    m.sub('ПОМОЩНИКИ', X, 104);
    st.list.forEach((l, i) => {
      const y = 124 + i * 82, h = 74, id = 'lt:' + l.id, on = l === lt, hov = m.hoverId === id, s = l.summary(), col = l.A.color;
      m.push(id, X, y, Wd, h, l.name, () => { this.selId = l.id; this.logPage = 0; }, true);
      m.rr(X, y, Wd, h, 4); c.fillStyle = on ? rgba(col, 0.16) : hov ? '#12243a' : 'rgba(255,255,255,.035)'; c.fill();
      c.lineWidth = on || hov ? 3 : 1.5; c.strokeStyle = on ? col : hov ? K.accent : K.line; c.stroke();
      c.fillStyle = col; c.fillRect(X, y, 7, h);
      m.tx(l.A.short, X + 24, y + 24, 15, col, { d: true, ls: 1 });
      m.tx(short(l), X + 24, y + 52, 24, '#fff', { maxW: 220 });
      const stt = this.state(l, s); m.tx(STATE[stt][0], X + Wd - 16, y + 24, 15, STATE[stt][1], { d: true, ls: 1, align: 'right' });
      m.tx(`${s.units} ед. · ${s.structs} зд.${l.zone ? ' · зона' : ''}`, X + Wd - 16, y + 52, 19, K.dim, { w: 600, align: 'right' });
    });
    if (!st.list.length) m.wrap('Пока никого. Нажмите «+ НОВЫЙ ПОМОЩНИК».', X, 150, Wd, 26, 20, K.dim, 2);
    m.btn('add', X, 124 + Math.max(1, st.list.length) * 82 + (st.list.length ? 0 : 40), Wd, 62, '+ НОВЫЙ ПОМОЩНИК', () => this.startPick(ents.length > 0), st.list.length < 8, { primary: !st.list.length, size: 20, sub: free ? `свободных sACU: ${free}` : 'нужен sACU (завод Т3)' });
    // ---- bottom
    const own = this.ui.selection.filter(e => e.lt !== undefined && e.alive).length;
    m.btn('back', X, 892, 250, 82, 'НАЗАД', () => m.back(), true, { center: true });
    m.btn('take', X + 262, 892, Wd - 262, 82, 'ЗАБРАТЬ СЕБЕ', () => this.sui.takeBack(this.ui.selection.filter(x => x.lt !== undefined)), own > 0, { center: true, size: 19, sub: own ? `выделено у помощников: ${own}` : 'выделите переданных юнитов' });
    // ---- card
    const cx = 600, cw = 960;
    if (!lt) { this.drawEmpty(m, st, cx, cw, ents); return; }
    this.drawCard(m, lt, cx, cw, ents);
  }
  state(l, s) { return l.paused ? 'pause' : !s.units && !s.structs ? 'none' : l.block ? 'wait' : /^Жду задач/.test(l.status) ? 'idle' : 'work'; }   // as the PC card
  drawEmpty(m, st, x, w, ents) {
    const c = m.ctx;
    m.rr(x, 96, w, 784, 6); c.fillStyle = 'rgba(10,18,26,.86)'; c.fill(); c.lineWidth = 2; c.strokeStyle = K.line; c.stroke();
    AREA_ORDER.forEach((a, i) => { const ax = x + w / 2 + (i - 2) * 110; c.fillStyle = rgba(AREAS[a].color, 0.18); m.rr(ax - 46, 140, 92, 60, 6); c.fill(); c.lineWidth = 2; c.strokeStyle = AREAS[a].color; c.stroke(); m.tx(AREAS[a].short, ax, 171, 14, AREAS[a].color, { d: true, align: 'center', ls: 1 }); });
    m.tx('Делегируйте — не микро-менеджьте', x + w / 2, 260, 30, '#fff', { d: true, align: 'center', ls: 1 });
    const lines = ['Помощника-лейтенанта воплощает робот-командир поддержки (sACU): постройте его на заводе Т3, назначьте ему область (экономика, армия, авиация, флот, оборона) и передайте инженеров или заводы: выделите их и нажмите «→ ПОМОЩНИКУ» на панели.',
      'Если sACU погибнет, помощник распускается, а его юниты и здания возвращаются к вам.',
      'Помощник тратит только свою долю дохода, не видит сквозь туман и не трогает юнитов, которым вы отдали приказ.'];
    let y = 320; for (const l of lines) { m.wrap(l, x + 60, y, w - 120, 30, 22, y === 320 ? K.text : K.dim, 4); y += l.length > 120 ? 140 : 90; }
    m.btn('empty-add', x + w / 2 - 260, 690, 520, 72, '+ НАЗНАЧИТЬ ПЕРВОГО ПОМОЩНИКА', () => this.startPick(ents.length > 0), true, { primary: true, center: true, size: 20 });
    if (!st.freeSacu().length) m.tx(NO_SACU, x + w / 2, 800, 21, K.warn, { w: 600, align: 'center' });
  }
  drawCard(m, lt, x, w, ents) {
    const c = m.ctx, s = lt.summary(), col = lt.A.color, sui = this.sui, mil = lt.area !== 'eco';
    m.rr(x, 96, w, 784, 6); c.fillStyle = 'rgba(10,18,26,.86)'; c.fill(); c.lineWidth = 2; c.strokeStyle = rgba(col, 0.7); c.stroke();
    c.fillStyle = col; c.fillRect(x, 96, 8, 784);
    // head
    const sc = lt.sacu;
    m.tx(lt.name, x + 32, 132, 28, '#fff', { d: true, ls: 1, maxW: 620 });
    m.tx(`${lt.A.name} · ${lt.st.name}${sc ? ` · sACU #${sc.id} ${Math.round(sc.hp / sc.maxHp * 100)}%` : ''}`, x + 32, 168, 20, col, { w: 600, maxW: 640 });
    const stt = this.state(lt, s); m.rr(x + w - 210, 112, 180, 40, 4); c.fillStyle = rgba(STATE[stt][1], 0.15); c.fill(); c.lineWidth = 2; c.strokeStyle = STATE[stt][1]; c.stroke();
    m.tx(STATE[stt][0], x + w - 120, 133, 17, STATE[stt][1], { d: true, ls: 1, align: 'center' });
    m.tx(lt.status, x + 32, 204, 21, K.text, { w: 600, maxW: w - 64 });
    const bk = lt.paused || (!s.units && !s.structs) ? null : lt.block;
    if (bk) m.tx('⚠ ' + bk.text, x + 32, 236, 20, K.warn, { w: 600, maxW: w - 64 });
    // tiles
    const tiles = [['ИНЖЕНЕРЫ', s.eng], ['ЗАВОДЫ', s.facs]];
    if (lt.area !== 'eco') tiles.push(['БОЕВЫЕ', s.combat]);
    tiles.push(['ЗДАНИЯ', s.structs]); if (s.held) tiles.push(['ВРУЧНУЮ', s.held]);
    const tw = (w - 64 - (tiles.length - 1) * 10) / tiles.length;
    tiles.forEach(([l, v], i) => {
      const tx = x + 32 + i * (tw + 10), ty = 260;
      c.fillStyle = 'rgba(255,255,255,.035)'; c.fillRect(tx, ty, tw, 72); c.strokeStyle = l === 'ВРУЧНУЮ' ? K.warn : 'rgba(255,255,255,.1)'; c.lineWidth = 1.5; c.strokeRect(tx, ty, tw, 72);
      m.tx(l, tx + 14, ty + 20, 13, K.dim, { d: true, ls: 1 }); m.tx(String(v), tx + 14, ty + 50, 30, v ? '#fff' : K.dim);
    });
    // meters: smoothed spending vs the allowance
    const A = lt.allow, D = lt.demAvg || { m: 0, e: 0 }, mw = (w - 74) / 2;
    [['МАССА', D.m, A.m, K.mass, `${D.m.toFixed(1)} / ${A.m.toFixed(1)} М/с`, 0.6], ['ЭНЕРГИЯ', D.e, A.e, K.energy, `${Math.round(D.e)} / ${Math.round(A.e)} Э/с`, 6]].forEach(([l, d, a, cl, t, tol], i) => {
      const mx = x + 32 + i * (mw + 10), my = 348, f = Math.min(1, d / Math.max(a, 0.5));
      m.tx(l, mx, my + 12, 13, K.dim, { d: true, ls: 1 }); m.tx(t, mx + mw, my + 12, 18, d > a + tol ? K.bad : K.text, { w: 600, align: 'right' });
      c.fillStyle = 'rgba(0,0,0,.5)'; c.fillRect(mx, my + 26, mw, 14); c.fillStyle = d > a + tol ? K.bad : cl; c.fillRect(mx, my + 26, mw * f, 14);
    });
    // controls: budget, style, toggles
    const cy = 408;
    m.stepper('bud', x + 32, cy, 250, 62, 'БЮДЖЕТ', Math.round(lt.budget * 100) + '%', (d) => sui.setBudget(lt, lt.budget * 100 + d * 5));
    if (mil) Object.entries(STYLES).forEach(([k, S], i) => m.btn('style:' + k, x + 296 + i * 214, cy, 204, 62, S.name.toUpperCase(), () => sui.cardAct('style', lt, k), true, { on: lt.style === k, center: true, size: 13, ls: 0.5 }));
    else m.tx('Экономика не воюет: стиля нет', x + 296, cy + 31, 19, K.dim, { w: 600 });
    const ty2 = cy + 76;
    if (lt.area !== 'defense') m.check('tfac', x + 32, ty2, 440, 62, 'Строить заводы самому', lt.allowFac, () => sui.cardAct('tfac', lt));
    m.check('tupg', x + (lt.area !== 'defense' ? 488 : 32), ty2, 440, 62, 'Улучшать автоматически', lt.autoUpg, () => sui.cardAct('tupg', lt));
    // buttons
    const by = ty2 + 76, fit = ents.filter(e => e.lt !== lt.id).length;
    const B = [
      ['pause', lt.paused ? '▶ ПРОДОЛЖИТЬ' : 'ПАУЗА', () => sui.cardAct('pause', lt), true, { on: lt.paused }],
      ['show', 'ПОКАЗАТЬ', () => this.show(lt), true, {}],
      ['zone', lt.zone ? 'ЗОНА ✎' : 'ЗОНА', () => this.zoneStart(lt), true, { on: !!lt.zone }],
      ['give', fit ? `ПЕРЕДАТЬ ${fit}` : 'ПЕРЕДАТЬ', () => sui.give(lt), fit > 0, { primary: fit > 0 }],
      ['recall', 'ОТОЗВАТЬ', () => m.ask(`Отозвать помощника «${lt.name}»? Его юниты и здания (${s.units} ед., ${s.structs} зд.) вернутся к вам.`, () => sui.recallNow(lt)), true, { danger: true }]
    ];
    const bw = (w - 64 - 4 * 10 - (lt.zone ? 72 : 0)) / 5;
    let bx = x + 32;
    B.forEach(([id, l, fn, en, o]) => { m.btn(id, bx, by, bw, 62, l, fn, en, { ...o, center: true, size: 16, ls: 1 }); bx += bw + 10; if (id === 'zone' && lt.zone) { m.arrow('clearzone', bx, by, 62, 0, () => sui.cardAct('clearzone', lt), true, true); bx += 72; } });
    m.tx(lt.zone ? `Зона ответственности: (${Math.round(lt.zone.x)}, ${Math.round(lt.zone.y)}) · радиус ${Math.round(lt.zone.r)}` : 'Зона не задана — помощник действует по всей карте', x + 32, by + 82, 19, lt.zone ? col : K.dim, { w: 600 });
    // log
    const ly = by + 110, pages = Math.max(1, Math.ceil(lt.logs.length / LOG_ROWS));
    if (this.logPage >= pages) this.logPage = pages - 1;
    m.sub(`ЖУРНАЛ (${lt.logs.length})`, x + 32, ly);
    if (pages > 1) { m.arrow('log-', x + w - 32 - 2 * 52 - 70, ly - 22, 44, -1, () => { this.logPage = Math.max(0, this.logPage - 1); }, this.logPage > 0); m.tx(`${this.logPage + 1}/${pages}`, x + w - 32 - 52 - 35, ly, 18, K.text, { align: 'center' }); m.arrow('log+', x + w - 32 - 44, ly - 22, 44, 1, () => { this.logPage = Math.min(pages - 1, this.logPage + 1); }, this.logPage < pages - 1); }
    const rows = lt.logs.slice(this.logPage * LOG_ROWS, this.logPage * LOG_ROWS + LOG_ROWS);
    if (!rows.length) m.tx('Пока без решений — жду задач.', x + 32, ly + 40, 19, K.dim, { w: 600 });
    rows.forEach((l, i) => {
      const ry = ly + 16 + i * 36, id = 'log:' + i, go = l.x !== undefined, hov = go && m.hoverId === id;
      if (go) m.push(id, x + 24, ry, w - 48, 34, l.text, () => this.goTo(l.x, l.y), true);
      if (hov) { c.fillStyle = 'rgba(95,208,255,.15)'; c.fillRect(x + 24, ry, w - 48, 34); }
      const tc = l.level === 'warn' || l.level === 'alert' ? K.warn : K.text;
      m.tx(fmtT(l.t), x + 32, ry + 17, 17, K.dim, { w: 600 }); m.tx(l.cat, x + 100, ry + 17, 13, CAT_COL[l.cat] || K.accent, { d: true, ls: 0.5, maxW: 130 });
      m.tx(l.text + (go ? '  ⌖' : ''), x + 240, ry + 17, 18, tc, { w: 600, maxW: w - 280 });
    });
  }
  drawPick(m, st) {
    const c = m.ctx, P = this.pick, sui = this.sui, free = sui.pickSacu(P), n = sui.transferable().length, A = P.area ? AREAS[P.area] : null;
    m.frame('ШТАБ — НОВЫЙ ПОМОЩНИК', 'выберите область ответственности');
    m.sub('КОМАНДИР ПОДДЕРЖКИ', 40, 108);
    if (free.length) free.slice(0, 6).forEach((u, i) => m.btn('sacu:' + u.id, 40 + i * 252, 126, 242, 58, `sACU #${u.id} · ${Math.round(u.hp / u.maxHp * 100)}%`, () => { P.sacu = u.id; }, true, { on: u.id === P.sacu, center: true, size: 17, ls: 1 }));
    else m.tx(NO_SACU, 40, 155, 22, K.warn, { w: 600 });
    // area tiles
    const tw = (1600 - 80 - 4 * 12) / 5, ty = 206, th = 384;
    AREA_ORDER.forEach((a, i) => {
      const Ar = AREAS[a], tx = 40 + i * (tw + 12), id = 'area:' + a, off = sui.areaOff(a), on = P.area === a, hov = !off && m.hoverId === id;
      m.push(id, tx, ty, tw, th, Ar.name, () => { sui.pickArea(P, a); }, !off);
      c.save(); if (off) c.globalAlpha = 0.4;
      m.rr(tx, ty, tw, th, 6); c.fillStyle = on ? rgba(Ar.color, 0.16) : hov ? '#12243a' : 'rgba(14,22,30,.9)'; c.fill();
      c.lineWidth = on || hov ? 3 : 1.5; c.strokeStyle = on ? Ar.color : hov ? K.accent : K.line; c.stroke();
      c.fillStyle = Ar.color; c.fillRect(tx, ty, tw, 6);
      m.tx(Ar.short, tx + 18, ty + 32, 14, Ar.color, { d: true, ls: 1 });
      m.tx(Ar.name, tx + 18, ty + 64, 24, '#fff', { maxW: tw - 30 });
      m.wrap(off ? 'На этой карте нет воды' : Ar.desc, tx + 18, ty + 100, tw - 34, 24, 17, off ? K.warn : K.dim, 4);
      Ar.does.forEach((d, k) => m.wrap('· ' + d, tx + 18, ty + 214 + k * 44, tw - 30, 20, 16, K.text, 2));
      c.restore();
    });
    // options of the chosen area
    const oy = ty + th + 24;
    if (A) {
      Object.entries(STYLES).forEach(([k, S], i) => m.btn('pst:' + k, 40 + i * 240, oy, 230, 62, S.name.toUpperCase(), () => { P.style = k; }, P.area !== 'eco', { on: P.style === k, center: true, size: 14, ls: 0.5 }));
      m.stepper('pbud', 774, oy, 330, 62, 'БЮДЖЕТ', P.budget + '%', (d) => { P.budget = Math.max(10, Math.min(100, P.budget + d * 5)); });
      m.wrap(A.give, 1130, oy + 18, 430, 26, 19, K.accent2, 2);
      m.check('pgive', 40, oy + 80, 680, 62, n ? `Сразу передать выделенное (${n})` : 'Ничего не выделено — передать можно позже', P.give && n > 0, () => { if (n) P.give = !P.give; });
    } else m.tx('Нажмите на плитку области — затем настройте стиль и бюджет.', 800, oy + 50, 22, K.dim, { w: 600, align: 'center' });
    m.btn('pk-back', 40, 892, 300, 82, '← К СПИСКУ', () => this.back(), true, { center: true, size: 20 });
    m.btn('ok', 1600 - 40 - 520, 892, 520, 82, A ? 'НАЗНАЧИТЬ: ' + A.name.toUpperCase() : 'НАЗНАЧИТЬ', () => this.confirmPick(), !!A && free.length > 0, { primary: true, center: true, size: 20, ls: 1 });
  }
  confirmPick() {
    const P = this.pick, ents = P.give ? this.sui.transferable() : [];
    const lt = this.sui.createFrom(P, ents);
    if (lt) { this.selId = lt.id; this.view = 'list'; this.logPage = 0; }
  }
  show(lt) {   // select everything of the lieutenant (StaffUI.show) and bring it to the middle of the table
    this.sui.show(lt);
    const ents = this.ui.selection.filter(e => e.lt === lt.id);
    if (ents.length) { this.menu.close(); this.vr.centerView(ents); }
    else if (lt.zone) this.goTo(lt.zone.x, lt.zone.y);
  }
  goTo(x, y) { const g = this.ui.game; if (!g) return; this.menu.close(); this.vr.tableCenterGame.set(x, g.terrain.surfaceAt(x, y), y); this.vr.updateDolly(); }

  dispose() {
    this.marks.geometry.dispose(); this.marks.material.dispose();
    this.zLines.geometry.dispose(); this.zLines.material.dispose(); this.zFill.geometry.dispose(); this.zFill.material.dispose();
  }
}
