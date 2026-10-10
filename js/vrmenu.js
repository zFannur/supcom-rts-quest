// VR menu (plan 6.1 / 6.2 / 7.4 / 11.14): a canvas plane 1.4 m in front of the head (yaw only, does not follow), laser + right trigger, B = back, Y = pause menu.
// Look of the PC menus (style.css: .ng-box, .mbtn, select, .ls-row, .map-card, .modal-card): dark panels, cyan lines, Orbitron headings, left accent bar on buttons.
// Screens: main | help | setup (lobby, one screen as on PC) | memory | load | save | settings | pause | over | loading | confirm; drop-down lists of the PC lobby are
// pop-up lists over the screen (this.pop). All game logic lives in main.js and arrives through `hooks` (launch, loadGame, saveGame, listSaves, lobby, gen, memory, settings...).
// The canvas is redrawn only when something changed (`dirty`): hover, press, screen, data; nothing is allocated per frame.
import * as THREE from 'three';
import { VR_QUALITY, setModelQuality } from './models.js';
import { VR_PRESETS } from './quest.js';
import { BUILD_TIME } from './build.js';

const W = 1600, H = 1000, PW = 1.6, PH = PW * H / W, DIST = 1.4;   // 1000 px/m: a 62 px control is 6.2 cm, the panel is ~60° wide at 1.4 m
const CW = 1024, CH = 768;   // кадр рисунков экрана «УПРАВЛЕНИЕ» (helpPad / helpTips рисуют в нём, s_help вписывает его в холст)
const FONT = 'Rajdhani, Arial, sans-serif', FONT_D = 'Orbitron, Arial, sans-serif';   // как --font / --font-d в style.css (кириллица — запасной шрифт, как на ПК)
const K = { line: 'rgba(95,208,255,.28)', line2: 'rgba(95,208,255,.55)', accent: '#5fd0ff', accent2: '#5dffb0', mass: '#46e070', bad: '#ff4a3a', warn: '#ffb040', text: '#dbe7ef', dim: '#8aa0ae', field: '#0d1822' };
const RGB = { accent: '95,208,255', accent2: '93,255,176', bad: '255,74,58' };
const FULL = { x: 0, y: 0, w: W, h: H };
const BARS = ['Только выделенные', 'Повреждённые', 'Всегда'], ICONS = [[1.0, 'S (мелкие)'], [1.3, 'M (средние)'], [1.7, 'L (крупные)']];
const QUALITY = { low: 'НИЗКОЕ (256 px)', med: 'СРЕДНЕЕ (512 px)', high: 'ВЫСОКОЕ (512 px, чётче кадр)' };
const TURNS = [['snap30', 'Рывок 30°'], ['snap45', 'Рывок 45°'], ['smooth', 'Плавный']];
// 2D-позиции органов управления на ctrl_l.png / ctrl_r.png (доли картинки 512x512), см. assets/ui/ctrl_pts.json, tools/render_ctrl_ui.mjs
const CTRL_PTS = {"l":{"trigger":[0.5737,0.38],"squeeze":[0.4778,0.5175],"stick":[0.4386,0.2872],"a":[0.4451,0.3435],"b":[0.5162,0.3105]},"r":{"trigger":[0.3832,0.3807],"squeeze":[0.4782,0.5163],"stick":[0.5176,0.2878],"a":[0.5114,0.3441],"b":[0.4405,0.3114]}};
// колонки строки слота (как .ls-row на ПК): подпись, ширина
const COLS = [['ИГРОК', 150], ['ЦВЕТ', 60], ['КОМАНДА', 70], ['СТАРТ', 80], ['КАМУФЛЯЖ', 160], ['ЦВЕТ КАМУФЛЯЖА', 190], ['СЛОЖНОСТЬ', 140], ['ДОКТРИНА', 150], ['', 60]];
const LX = 32, LW = 1132, RX = 1188, RW = 380;   // лобби: левая колонка (слоты, карты, генератор) и правая (превью, опции, «В БОЙ»)

export class VRMenu {
  constructor(vr) {
    this.vr = vr;
    this.hooks = null;                 // set by main.js
    this.visible = false; this.screen = 'main'; this.ret = 'main';
    this.canvas = document.createElement('canvas'); this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.minFilter = THREE.LinearFilter; this.tex.generateMipmaps = false;
    this.tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, toneMapped: false, depthTest: false, side: THREE.DoubleSide });
    this.object3d = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), mat);
    this.object3d.renderOrder = 30; this.object3d.visible = false; this.object3d.frustumCulled = false;
    this.btns = []; this.hoverId = null; this.pressId = null; this.pressT = 0; this.area = FULL;
    this.dirty = true; this.needPlace = false; this.saves = null; this.savesTok = 0;
    this.noteText = ''; this.noteT = 0; this.loadGen = 0; this.overData = null; this.confirmText = ''; this.yes = null; this.noScreen = 'main';
    this.pop = null; this.psel = 0; this.mapPage = 0;   // всплывающий список; выбранный слот лобби (старт кликом по карте); страница карточек карт
    this._fwd = new THREE.Vector3(); this._q = new THREE.Quaternion();
    // шрифты ПК (index.html грузит Orbitron/Rajdhani): перерисовать, когда загрузятся
    if (document.fonts?.load) for (const f of ['700 20px Orbitron', '900 20px Orbitron', '500 20px Orbitron', '600 20px Rajdhani', '700 20px Rajdhani']) document.fonts.load(f).then(() => { this.dirty = true; this.logoCv = null; }, () => {});
  }

  // ---------------------------------------------------------------- test contract
  get buttons() { this.refresh(); return this.btns.map(b => ({ id: b.id, label: b.label, enabled: b.enabled })); }
  click(id) { this.refresh(); const b = this.btns.find(x => x.id === id); if (!b || !b.enabled) return false; this.act(b); return true; }
  buttonWorldPos(id) {
    this.refresh(); const b = this.btns.find(x => x.id === id); if (!b) return null;
    this.object3d.updateMatrixWorld(true);
    return this.object3d.localToWorld(new THREE.Vector3(((b.x + b.w / 2) / W - 0.5) * PW, (0.5 - (b.y + b.h / 2) / H) * PH, 0));
  }
  get inBattle() { const g = this.hooks?.game(); return !!g && !g.over; }

  // ---------------------------------------------------------------- navigation
  open(screen) {
    if (!screen) screen = this.hooks.game() ? 'pause' : 'main';
    this.visible = true; this.needPlace = true; this.ret = screen; this.helpDirect = false;
    if (screen === 'help') { this.ret = this.hooks.game() ? 'pause' : 'main'; this.helpDirect = true; this.helpPage = 0; }   // «?» на панели / первый запуск: назад = закрыть (или в главное меню без боя)
    this.go(screen);
    if (screen === 'staff') this.staffDirect = true;   // «ШТАБ» на панели: назад = закрыть
    this.hooks.pause(this.inBattle);
  }
  close() { this.visible = false; this.pop = null; this.object3d.visible = false; this.hooks?.pause(false); }
  hide() { this.close(); this.screen = 'main'; }   // session ended
  toggle() {   // Y / panel "МЕНЮ": battle: pause menu on/off; no game: put the menu in front of the head again
    if (this.visible && this.screen === 'loading') return;
    if (this.visible && this.hooks.game()) this.close();
    else if (this.visible) this.needPlace = true;
    else this.open();
  }
  go(screen) {
    if (['setup', 'load', 'settings', 'save', 'memory', 'help', 'staff'].includes(screen) && ['main', 'pause'].includes(this.screen)) { this.ret = this.screen; if (screen === 'help') { this.helpDirect = false; this.helpPage = 0; } if (screen === 'staff') this.staffDirect = false; }
    if (screen === 'help') this.loadHelpImages();
    if (screen === 'setup' && this.screen !== 'setup') { this.mapPage = 0; this.hooks.lobby.refreshMaps?.(() => { this.dirty = true; }); }   // сохранённые случайные карты (как на ПК)
    this.screen = screen; this.pop = null; this.dirty = true;
    if (screen === 'load' || screen === 'save' || screen === 'main') this.loadSaves();
    if (screen === 'memory') this.mem = this.hooks.memory.info();
  }
  back() {   // B
    const s = this.screen;
    if (this.pop) { this.pop = null; this.dirty = true; }
    else if (s === 'staff' && this.vr.staff.back()) { /* «новый помощник» -> список */ }
    else if (s === 'staff' && this.staffDirect) this.close();
    else if (s === 'help' && this.helpDirect) { this.helpDirect = false; if (this.hooks.game()) this.close(); else this.go(this.ret); }
    else if (['setup', 'load', 'save', 'settings', 'memory', 'help', 'staff'].includes(s)) this.go(this.ret);
    else if (s === 'confirm') this.go(this.noScreen);
    else if (s === 'pause') this.close();
  }
  note(text, ms = 3500) { this.noteText = text; this.noteT = ms / 1000; this.dirty = true; }
  showOver(d) { this.overData = d; this.visible = true; this.needPlace = true; this.go('over'); }
  fail(msg) { if (this.screen !== 'loading') return; this.go(this.from || 'main'); if (msg) this.note(msg, 6000); }
  ask(text, yes) { this.confirmText = text; this.yes = yes; this.noScreen = this.screen; this.go('confirm'); }
  begin(fn) {   // launch / load: "loading" until main.js has built the new game
    this.loadGen = this.hooks.gameId(); this.from = this.screen; this.go('loading');
    try { Promise.resolve(fn()).then(ok => { if (ok === false) this.fail(); }).catch(e => { console.warn('vr menu', e); this.fail(String(e.message || e)); }); } catch (e) { console.warn('vr menu', e); this.fail(String(e.message || e)); }
  }
  /** Первый запуск в VR: один раз показать схему управления (settings.vrHelpSeen хранится через commit()). */
  firstRunHelp() {
    const s = this.hooks?.settings; if (!s || s.vrHelpSeen) return false;
    s.vrHelpSeen = true; this.hooks.commit(); this.open('help'); return true;
  }
  loadHelpImages() {
    if (this.helpImgs) return;
    this.helpImgs = {};
    for (const k of ['l', 'r']) { const im = new Image(); im.onload = () => { this.dirty = true; }; im.src = `assets/ui/ctrl_${k}.png`; this.helpImgs[k] = im; }
  }
  get helpImagesLoaded() { return !!this.helpImgs && ['l', 'r'].every(k => this.helpImgs[k].complete && this.helpImgs[k].naturalWidth > 0); }
  quit() { this.vr.quitting = true; this.vr.endSession(); }
  exitPressed() {   // panel "ВЫХОД": browser = leave VR as before; TWA = the session stays, go to the menu
    if (!this.vr.isTWA) return this.vr.endSession();
    this.open(this.inBattle ? 'pause' : 'main');
  }
  loadSaves() {
    const tok = ++this.savesTok; this.saves = null;
    this.hooks.listSaves().then(by => { if (tok === this.savesTok) { this.saves = by; this.dirty = true; } }).catch(() => { if (tok === this.savesTok) { this.saves = false; this.dirty = true; } });
  }

  // ---------------------------------------------------------------- settings (persisted by main.js in the shared settings object)
  applySettings() {
    const s = this.hooks.settings, vr = this.vr;
    if (s.vrIconDeg && 'iconDeg' in vr) vr.iconDeg = s.vrIconDeg;
    const t = s.vrTurn || 'snap30'; vr.smoothTurn = t === 'smooth'; vr.snapDeg = t === 'snap45' ? 45 : 30;
    if (typeof s.vrPassthrough === 'boolean' && vr.preferredMode === 'immersive-ar') vr.passthrough = s.vrPassthrough;
  }
  setting(key, v) { this.hooks.settings[key] = v; this.hooks.commit(); this.applySettings(); this.dirty = true; }
  step(id, d) {
    const s = this.hooks.settings;
    if (id === 'vol') { s.volume = Math.round(Math.max(0, Math.min(1, (s.volume ?? 0.6) + d * 0.1)) * 10) / 10; this.hooks.commit(); }
    else if (id === 'mus') {   // music: 0 % = off; stepping up from off turns it back on
      const cur = s.music === false ? 0 : s.musicVolume ?? 0.5, v = Math.round(Math.max(0, Math.min(1, cur + d * 0.1)) * 10) / 10;
      s.music = v > 0; if (v > 0) s.musicVolume = v; this.hooks.commit();
    }
  }
  quality(q) {   // пресет: модели перезагружаются сразу, масштаб кадра и фовеация (VR_PRESETS) — при следующем входе в VR
    const s = this.hooks.settings;
    if (this.loadingModels || !VR_QUALITY.includes(q) || q === (s.vrQuality || 'med')) return;
    s.vrQuality = q; this.hooks.commit(); this.dirty = true;
    this.loadingModels = true; this.note('Загрузка моделей...', 60000);
    setModelQuality(q).catch(() => {}).finally(() => { this.loadingModels = false; this.note(`Модели загружены. Кадр ${VR_PRESETS[q].scale}×, фовеация ${VR_PRESETS[q].fov}: при следующем входе в VR`, 6000); });
  }

  // ---------------------------------------------------------------- per frame (no allocations)
  update(dt) {
    const h = this.hooks, vr = this.vr;
    if (!h || !vr.inVR) return;
    const y = !!vr.leftController?.inputSource?.gamepad?.buttons[5]?.pressed;
    if (y && !this._y) this.toggle();
    this._y = y;
    if (this.needPlace && this.visible) this.place();
    if (this.screen === 'loading' && h.gameId() !== this.loadGen) { this.close(); this.screen = 'pause'; vr.hasCenteredOnACU = false; }
    if (this.noteT > 0 && (this.noteT -= dt) <= 0) { this.noteText = ''; this.dirty = true; }
    if (this.pressT > 0 && (this.pressT -= dt) <= 0) { this.pressId = null; this.dirty = true; }
    if (this.visible && this.dirty) this.draw();
    this.object3d.visible = this.visible && !this.needPlace;
  }
  place() {   // 1.4 m in front of the head at eye height, yaw only, facing the head (dolly-local = physical metres)
    const xr = this.vr.r.gl.xr, rs = xr.getReferenceSpace?.(), f = xr.getFrame?.(), pose = rs && f && f.getViewerPose(rs);
    if (!pose) return;
    const p = pose.transform.position, o = pose.transform.orientation, fwd = this._fwd;
    fwd.set(0, 0, -1).applyQuaternion(this._q.set(o.x, o.y, o.z, o.w)); fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    this.object3d.position.set(p.x + fwd.x * DIST, p.y, p.z + fwd.z * DIST);
    this.object3d.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0);
    this.needPlace = false; this.dirty = true;
  }

  // ---------------------------------------------------------------- laser
  hit(raycaster) {
    if (!this.visible || this.needPlace) { if (this.hoverId) { this.hoverId = null; this.dirty = true; } return null; }
    const ins = raycaster.intersectObject(this.object3d, false);
    let hov = null, on = false;
    if (ins.length) {
      const x = ins[0].uv.x * W, y = (1 - ins[0].uv.y) * H, a = this.area;
      on = x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h;   // окна (пауза, вопрос) меньше холста: мимо окна лазер не останавливается
      if (on) for (const b of this.btns) if (b.enabled && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { hov = b.id; break; }
    }
    if (hov !== this.hoverId) { this.hoverId = hov; this.dirty = true; }
    return on ? ins[0].distance : null;
  }
  press() { const b = this.btns.find(x => x.id === this.hoverId && x.enabled); if (b) this.act(b); }
  act(b) { this.pressId = b.id; this.pressT = 0.18; try { b.action(); } catch (e) { console.warn('vr menu', e); } this.dirty = true; }

  // ---------------------------------------------------------------- drawing primitives
  refresh() { if (this.dirty) this.draw(); }
  rr(x, y, w, h, r = 10) { const c = this.ctx; c.beginPath(); if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); }
  /** Старый текст (экран «УПРАВЛЕНИЕ»): подпись сжимается по maxW. */
  t(s, x, y, size = 28, color = K.text, align = 'left', bold = true, maxW) {
    const c = this.ctx; c.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`; c.fillStyle = color; c.textAlign = align; c.textBaseline = 'middle';
    if ('letterSpacing' in c) c.letterSpacing = '0px';
    if (maxW) c.fillText(s, x, y, maxW); else c.fillText(s, x, y);
  }
  /** Текст: o.d — шрифт заголовков (Orbitron), o.w — насыщенность, o.ls — разрядка, o.maxW — обрезать с «…», o.align. */
  tx(s, x, y, size, color, o = {}) {
    const c = this.ctx; c.font = `${o.w || 700} ${size}px ${o.d ? FONT_D : FONT}`; c.fillStyle = color; c.textAlign = o.align || 'left'; c.textBaseline = 'middle';
    if ('letterSpacing' in c) c.letterSpacing = (o.ls || 0) + 'px';
    s = String(s); if (o.maxW) s = this.fit(s, o.maxW);
    c.fillText(s, x, y);
  }
  fit(s, maxW) {   // обрезка с многоточием (вызывается только при перерисовке)
    const c = this.ctx; if (c.measureText(s).width <= maxW) return s;
    let n = s.length; while (n > 1 && c.measureText(s.slice(0, n) + '…').width > maxW) n--;
    return s.slice(0, n).trimEnd() + '…';
  }
  wrap(s, x, y, maxW, lh, size, color, maxLines = 3) {   // перенос по словам
    const c = this.ctx; c.font = `600 ${size}px ${FONT}`; if ('letterSpacing' in c) c.letterSpacing = '0px';
    let line = '', n = 0;
    for (const w of String(s).split(' ')) {
      const tst = line ? line + ' ' + w : w;
      if (c.measureText(tst).width > maxW && line) { if (n === maxLines - 1) { this.tx(line + ' ' + w, x, y + n * lh, size, color, { w: 600, maxW }); return; } this.tx(line, x, y + n * lh, size, color, { w: 600 }); n++; line = w; }
      else line = tst;
    }
    if (line) this.tx(line, x, y + n * lh, size, color, { w: 600 });
  }
  sub(s, x, y, color = K.dim) { this.tx(s, x, y, 15, color, { d: true, ls: 3 }); }   // .ng-sub
  push(id, x, y, w, h, label, action, enabled = true) { const b = { id, x, y, w, h, label, action, enabled }; this.btns.push(b); return b; }
  /** Кнопка .mbtn: тёмный фон с голубым градиентом, полоса акцента слева. o: primary | danger | on | center | size | sub | ls. */
  btn(id, x, y, w, h, label, action, enabled = true, o = {}) {
    const c = this.ctx, hov = enabled && this.hoverId === id, prs = enabled && this.pressId === id;
    this.push(id, x, y, w, h, label, action, enabled);
    const kind = o.danger ? 'bad' : o.primary ? 'accent2' : 'accent', acc = K[kind], rgb = RGB[kind];
    c.save(); if (!enabled) c.globalAlpha = 0.4;
    c.fillStyle = 'rgba(6,12,18,.9)'; c.fillRect(x, y, w, h);
    const g = c.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, `rgba(${rgb},${prs ? 0.7 : hov ? 0.48 : o.on ? 0.3 : o.primary ? 0.22 : 0.12})`); g.addColorStop(1, `rgba(${rgb},${prs ? 0.25 : hov ? 0.12 : 0.02})`);
    c.fillStyle = g; c.fillRect(x, y, w, h);
    c.lineWidth = hov || prs ? 3 : 2; c.strokeStyle = hov || prs || o.on ? acc : K.line; c.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
    c.fillStyle = acc; c.fillRect(x, y, hov ? 8 : 5, h);
    const size = o.size || 22, col = hov || prs ? '#fff' : K.text, tx = o.center ? x + w / 2 + 3 : x + 28 + (hov ? 8 : 0), al = o.center ? 'center' : 'left', mw = w - 40;
    if (o.sub) { this.tx(label, tx, y + h * 0.37, size, col, { d: true, ls: o.ls ?? 2, align: al, maxW: mw }); this.tx(o.sub, tx, y + h * 0.72, 18, hov ? K.text : K.dim, { w: 600, align: al, maxW: mw }); }
    else this.tx(label, tx, y + h / 2 + 1, size, col, { d: true, ls: o.ls ?? 2, align: al, maxW: mw });
    c.restore();
  }
  /** Поле-«список» (select ПК): тёмное поле, голубая рамка, ▾ справа. o: label (подпись сверху) | swatch | chips | enabled | open | center. */
  field(id, x, y, w, h, text, action, o = {}) {
    const c = this.ctx, en = o.enabled !== false, hov = en && this.hoverId === id, open = this.pop && this.pop.id === id, prs = en && this.pressId === id;
    this.push(id, x, y, w, h, text, action, en);
    c.save(); if (!en) c.globalAlpha = 0.45;
    this.rr(x, y, w, h, 4); c.fillStyle = prs ? 'rgba(93,255,176,.2)' : hov ? '#12243a' : K.field; c.fill();
    c.lineWidth = hov || open ? 3 : 2; c.strokeStyle = open ? K.accent2 : hov ? K.accent : K.line2; c.stroke();
    if (o.swatch) { c.fillStyle = o.swatch; c.fillRect(x + 8, y + 8, w - 16, h - 16); c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,.6)'; c.strokeRect(x + 8, y + 8, w - 16, h - 16); c.restore(); return; }
    const arrow = en && !o.noArrow, chipsW = (o.chips || []).length ? 34 : 0, right = x + w - (arrow ? 24 : 8) - chipsW;
    if (arrow) { c.fillStyle = hov ? '#fff' : K.accent; c.beginPath(); c.moveTo(x + w - 22, y + h / 2 - 4); c.lineTo(x + w - 9, y + h / 2 - 4); c.lineTo(x + w - 15.5, y + h / 2 + 5); c.fill(); }
    if (chipsW) { const cw = 30 / o.chips.length; o.chips.forEach((col, k) => { c.fillStyle = col; c.fillRect(right + 2 + k * cw, y + h / 2 - 12, cw, 24); }); c.strokeStyle = 'rgba(255,255,255,.3)'; c.lineWidth = 1; c.strokeRect(right + 2, y + h / 2 - 12, 30, 24); }
    const tx = o.center ? (x + right) / 2 : x + 10, al = o.center ? 'center' : 'left', mw = right - x - 14;
    if (o.label) { this.tx(o.label, x + 12, y + 17, 13, K.dim, { d: true, ls: 1, maxW: w - 24 }); this.tx(text, x + 12, y + h - 20, 22, en ? '#fff' : K.dim, { w: 700, maxW: mw }); }
    else this.tx(text, tx, y + h / 2 + 1, o.fs || 20, en ? (hov ? '#fff' : K.text) : K.dim, { w: 700, align: al, maxW: mw });
    c.restore();
  }
  /** Квадратная кнопка со стрелкой ◀ / ▶ (или ✕). */
  arrow(id, x, y, s, dir, action, enabled = true, danger = false) {
    const c = this.ctx, hov = enabled && this.hoverId === id, prs = enabled && this.pressId === id, acc = danger ? K.bad : K.accent2;
    this.push(id, x, y, s, s, dir < 0 ? '◀' : dir > 0 ? '▶' : '✕', action, enabled);
    c.save(); if (!enabled) c.globalAlpha = 0.35;
    this.rr(x, y, s, s, 4); c.fillStyle = prs ? 'rgba(93,255,176,.35)' : hov ? (danger ? 'rgba(255,74,58,.22)' : 'rgba(93,255,176,.18)') : 'rgba(95,208,255,.08)'; c.fill();
    c.lineWidth = 2; c.strokeStyle = hov ? acc : K.line2; c.stroke();
    const cx = x + s / 2, cy = y + s / 2, r = s * 0.17; c.fillStyle = hov ? '#fff' : danger ? K.dim : K.accent; c.strokeStyle = c.fillStyle;
    if (dir) { c.beginPath(); c.moveTo(cx + dir * r * 1.1, cy); c.lineTo(cx - dir * r * 0.8, cy - r * 1.2); c.lineTo(cx - dir * r * 0.8, cy + r * 1.2); c.fill(); }
    else { c.lineWidth = 4; c.beginPath(); c.moveTo(cx - r, cy - r); c.lineTo(cx + r, cy + r); c.moveTo(cx + r, cy - r); c.lineTo(cx - r, cy + r); c.stroke(); }
    c.restore();
  }
  /** ◀ [подпись + значение] ▶ (ручки генератора, громкость). */
  stepper(id, x, y, w, h, label, value, step, enabled = true) {
    this.arrow(id + '-', x, y, h, -1, () => step(-1), enabled); this.arrow(id + '+', x + w - h, y, h, 1, () => step(1), enabled);
    const c = this.ctx, bx = x + h + 6, bw = w - 2 * h - 12;
    this.rr(bx, y, bw, h, 4); c.fillStyle = K.field; c.fill(); c.lineWidth = 2; c.strokeStyle = K.line; c.stroke();
    if (label) { this.tx(label, bx + bw / 2, y + 17, 13, K.dim, { d: true, ls: 1, align: 'center', maxW: bw - 12 }); this.tx(value, bx + bw / 2, y + h - 20, 22, enabled ? '#fff' : K.dim, { align: 'center', maxW: bw - 12 }); }
    else this.tx(value, bx + bw / 2, y + h / 2 + 1, 24, enabled ? '#fff' : K.dim, { align: 'center', maxW: bw - 12 });
  }
  /** Флажок во всю строку (туман войны, пасстру): подпись слева, квадрат справа. */
  check(id, x, y, w, h, label, on, action, sub) {
    const c = this.ctx, hov = this.hoverId === id;
    this.push(id, x, y, w, h, label, action, true);
    this.rr(x, y, w, h, 4); c.fillStyle = hov ? '#12243a' : K.field; c.fill(); c.lineWidth = hov ? 3 : 2; c.strokeStyle = hov ? K.accent : K.line2; c.stroke();
    if (sub) { this.tx(sub, x + 12, y + 17, 13, K.dim, { d: true, ls: 1 }); this.tx(label, x + 12, y + h - 20, 22, '#fff', { maxW: w - 80 }); }
    else this.tx(label, x + 14, y + h / 2 + 1, 22, '#fff', { maxW: w - 80 });
    const s = 38, bx = x + w - s - 14, by = y + (h - s) / 2;
    this.rr(bx, by, s, s, 4); c.fillStyle = on ? K.accent2 : 'rgba(0,0,0,.4)'; c.fill(); c.lineWidth = 2; c.strokeStyle = on ? K.accent2 : K.line2; c.stroke();
    if (on) { c.strokeStyle = '#06210f'; c.lineWidth = 5; c.beginPath(); c.moveTo(bx + 9, by + 20); c.lineTo(bx + 16, by + 28); c.lineTo(bx + 30, by + 11); c.stroke(); }
  }
  /** Полноэкранная панель (.ng-box) с заголовком. */
  frame(title, right) {
    const c = this.ctx; this.area = FULL;
    this.rr(3, 3, W - 6, H - 6, 8); c.fillStyle = 'rgba(6,12,18,.95)'; c.fill();
    const g = c.createLinearGradient(0, 0, W, 0); g.addColorStop(0, 'rgba(95,208,255,.13)'); g.addColorStop(0.6, 'rgba(95,208,255,0)');
    c.fillStyle = g; c.fillRect(5, 5, W - 10, 70);
    c.fillStyle = K.line; c.fillRect(5, 75, W - 10, 1);
    this.rr(3, 3, W - 6, H - 6, 8); c.lineWidth = 2; c.strokeStyle = K.line2; c.stroke();
    this.tx(title, 40, 41, 26, K.accent, { d: true, ls: 5 });
    if (right) this.tx(right, W - 40, 41, 18, K.dim, { w: 600, align: 'right' });
  }
  /** Окно (.modal-card) по центру; остальной холст прозрачный, лазер мимо окна холст не задевает. */
  modal(w, h, title, color = K.accent, glow) {
    const c = this.ctx, x = (W - w) / 2, y = (H - h) / 2; this.area = { x, y, w, h };
    this.rr(x - 8, y - 8, w + 16, h + 16, 14); c.fillStyle = 'rgba(0,0,0,.3)'; c.fill();
    this.rr(x, y, w, h, 8); c.fillStyle = 'rgba(6,12,18,.97)'; c.fill();
    this.rr(x, y, w, h, 8); c.lineWidth = 2; c.strokeStyle = K.line2; c.stroke();
    if (title) { if (glow) { c.save(); c.shadowColor = glow; c.shadowBlur = 24; } this.tx(title, x + 34, y + 48, glow ? 40 : 26, color, { d: true, ls: glow ? 6 : 5 }); if (glow) c.restore(); }
    return { x, y, w, h };
  }
  footer(x = 40, y = H - 30, align = 'left', maxW = W - 80) {
    const t = this.noteText || 'Курок — выбрать · B — назад · Y — меню' + (this.screen === 'setup' ? ' · курок по номеру на карте — занять старт выбранным слотом' : '');
    this.tx(t, x, y, 18, this.noteText ? K.warn : K.dim, { w: 600, align, maxW });
  }

  // ---------------------------------------------------------------- pop-up list (вместо <select> ПК)
  /** Открыть список под полем id. opts: [[значение, подпись, цвет?, занят слотом?]]; pick(v) — выбор. */
  openList(id, title, opts, cur, pick, kind) {
    const b = this.btns.find(x => x.id === id) || { x: W / 2 - 160, y: H / 2 - 100, w: 320, h: 0 };
    this.pop = { id, title, opts, cur, pick, kind, ax: b.x, ay: b.y, aw: b.w, ah: b.h }; this.dirty = true;
  }
  openSlot(i, f) {   // поле слота лобби: список из main.js (те же варианты, что в <select> ПК)
    const L = this.hooks.lobby, o = L.opts(i, f), id = f === 'color' ? 'sw:' + i : 'pick:' + i + ':' + f;
    this.psel = i;
    this.openList(id, o.title, o.opts, o.cur, (v) => { L.set(i, f, v); this.psel = i; }, f === 'color' || f === 'custom' ? 'swatch' : '');
  }
  drawPop() {
    const P = this.pop, c = this.ctx, n = P.opts.length, sw = P.kind === 'swatch';
    const cols = sw ? 4 : n > 6 ? 2 : 1, rows = Math.ceil(n / cols), cw = sw ? 104 : Math.max(330, Math.min(440, P.aw + 140)), ch = sw ? 84 : 62, gap = 8;
    const w = cols * cw + (cols - 1) * gap + 32, h = 64 + rows * (ch + gap) - gap + (sw ? 44 : 18);
    const x = Math.max(16, Math.min(W - w - 16, P.ax)); let y = P.ay + P.ah + 8; if (y + h > H - 12) y = Math.max(12, P.ay - h - 8);
    this.btns.length = 0; this.area = FULL;
    c.fillStyle = 'rgba(0,0,0,.5)'; c.fillRect(0, 0, W, H);
    this.rr(x - 8, y - 8, w + 16, h + 16, 12); c.fillStyle = 'rgba(0,0,0,.45)'; c.fill();
    this.rr(x, y, w, h, 6); c.fillStyle = 'rgba(10,20,30,.98)'; c.fill();
    this.rr(x, y, w, h, 6); c.lineWidth = 3; c.strokeStyle = K.accent; c.stroke();
    this.tx(P.title, x + 16, y + 32, 15, K.accent, { d: true, ls: 2, maxW: w - 32 });
    P.opts.forEach((o, k) => {
      const ox = x + 16 + (k % cols) * (cw + gap), oy = y + 58 + Math.floor(k / cols) * (ch + gap), id = 'opt:' + o[0], cur = String(o[0]) === String(P.cur), hov = this.hoverId === id;
      this.push(id, ox, oy, cw, ch, String(o[1]), () => { this.pop = null; P.pick(o[0]); }, true);
      this.rr(ox, oy, cw, ch, 4); c.fillStyle = cur ? 'rgba(93,255,176,.14)' : hov ? 'rgba(95,208,255,.22)' : 'rgba(255,255,255,.04)'; c.fill();
      c.lineWidth = cur || hov ? 3 : 1.5; c.strokeStyle = cur ? K.accent2 : hov ? K.accent : K.line; c.stroke();
      if (sw) {
        c.save(); if (o[3] >= 0) c.globalAlpha = 0.45; c.fillStyle = o[2]; c.fillRect(ox + 10, oy + 10, cw - 20, ch - 20); c.restore();
        if (cur) this.tx('✓', ox + cw / 2, oy + ch / 2 + 2, 34, '#000', { align: 'center' });
        else if (o[3] >= 0) this.tx(String(o[3] + 1), ox + cw / 2, oy + ch / 2 + 2, 26, '#000', { align: 'center' });
      } else {
        if (o[2]) { c.fillStyle = o[2]; c.fillRect(ox + 12, oy + 16, 30, ch - 32); }
        this.tx(o[1], ox + (o[2] ? 54 : 18), oy + ch / 2 + 1, 22, cur ? K.accent2 : hov ? '#fff' : K.text, { maxW: cw - (o[2] ? 54 : 18) - 40 });
        if (cur) this.tx('✓', ox + cw - 18, oy + ch / 2 + 1, 24, K.accent2, { align: 'right' });
      }
    });
    if (sw && P.opts[0] && P.opts[0][3] !== undefined) this.tx('Цифра — чей это цвет; выбор меняет цвета местами', x + 16, y + h - 20, 15, K.dim, { w: 600, maxW: w - 32 });
    this.push('pop:close', 0, 0, W, H, 'закрыть', () => { this.pop = null; }, true);   // мимо списка — закрыть (последней: кнопки списка проверяются раньше)
  }

  draw() {
    const c = this.ctx, h = this.hooks, sc = this.screen; this.dirty = false;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H); c.globalAlpha = 1; c.shadowBlur = 0;
    this.btns = []; this.area = FULL;
    if (!h) { this.tex.needsUpdate = true; return; }
    this['s_' + sc]();
    if (this.pop) this.drawPop();
    if (this.hoverId && !this.btns.some(b => b.id === this.hoverId && b.enabled)) this.hoverId = null;
    this.tex.needsUpdate = true;
  }
  /** Колонка кнопок .mbtn; o.half = 1 / 2: две кнопки в одной строке. */
  col(list, x, y0, w, bh, gap) {
    let row = 0;
    list.forEach(([id, label, fn, en, o]) => {
      const hf = o && o.half, y = y0 + row * (bh + gap), hw = (w - gap) / 2;
      this.btn(id, hf === 2 ? x + hw + gap : x, y, hf ? hw : w, bh, label, fn, en !== false, o || {});
      if (hf !== 1) row++;
    });
    return y0 + row * (bh + gap);
  }

  // ---------------------------------------------------------------- screens
  s_main() {
    const c = this.ctx, h = this.hooks, au = this.saves && this.saves.auto, d = au && h.saveDesc(au);
    this.area = FULL;
    const g = c.createLinearGradient(0, 0, W, 0); g.addColorStop(0, 'rgba(3,7,12,.97)'); g.addColorStop(0.45, 'rgba(3,7,12,.93)'); g.addColorStop(1, 'rgba(3,7,12,.82)');
    this.rr(3, 3, W - 6, H - 6, 8); c.fillStyle = g; c.fill(); c.lineWidth = 2; c.strokeStyle = K.line; c.stroke();
    c.drawImage(this.logo(), 52, 62);   // логотип как на ПК (.logo-top / .logo-main / .logo-sub)
    const quitLabel = this.vr.isTWA ? 'ВЫЙТИ ИЗ ИГРЫ' : 'ВЫЙТИ ИЗ VR';
    const list = [
      ['quick', 'БЫСТРЫЙ БОЙ', () => this.begin(() => h.launch(false)), true, { primary: !au }],
      ['new', 'НОВАЯ ИГРА', () => this.go('setup')],
      ['watch', 'ИИ ПРОТИВ ИИ (НАБЛЮДЕНИЕ)', () => this.begin(() => h.launch(true))],
      ['load', 'ЗАГРУЗИТЬ ИГРУ', () => this.go('load')],
      ['memory', 'ПАМЯТЬ ИИ', () => this.go('memory'), true, { half: 1 }],
      ['help', 'УПРАВЛЕНИЕ', () => this.go('help'), true, { half: 2 }],
      ['settings', 'НАСТРОЙКИ', () => this.go('settings')],
      ['quit', quitLabel, () => this.vr.isTWA ? this.ask('Выйти из игры? Сессия VR завершится.', () => this.quit()) : this.quit(), true, { danger: true }]
    ];
    if (au) list.unshift(['continue', 'ПРОДОЛЖИТЬ', () => this.begin(() => h.loadGame('auto')), d.ok, { primary: true, sub: d.t }]);
    this.col(list, 92, au ? 282 : 300, 560, au ? 64 : 68, 10);
    this.brief(740, 112, 820, 776);
    this.footer(92, H - 34);
    if (BUILD_TIME) this.tx('сборка ' + BUILD_TIME, W - 24, 26, 15, K.dim, { align: 'right' });
  }
  logo() {   // 640 x 210, рисуется один раз (свечение shadowBlur дорогое на шлеме)
    if (this.logoCv) return this.logoCv;
    const cv = this.logoCv = document.createElement('canvas'); cv.width = 640; cv.height = 210;
    const c = this.ctx, c2 = cv.getContext('2d'); this.ctx = c2;
    try {
      this.tx('SUPREME', 40, 50, 24, K.accent, { d: true, w: 500, ls: 22 });
      c2.save(); c2.shadowColor = 'rgba(95,208,255,.6)'; c2.shadowBlur = 30; this.tx('COMMANDER', 36, 110, 72, '#fff', { d: true, w: 900, ls: 4 }); c2.restore();
      c2.fillStyle = '#1a3a50'; c2.fillRect(40, 152, 520, 2);
      this.tx('ТАКТИЧЕСКИЙ 3D СИМУЛЯТОР', 40, 178, 17, K.accent2, { d: true, ls: 6 });
    } finally { this.ctx = c; }
    return cv;
  }
  /** Карточка «ТЕКУЩАЯ СХВАТКА» в главном меню: что запустит «Быстрый бой». */
  brief(x, y, w, h) {
    const c = this.ctx, B = this.hooks.lobby.brief();
    this.rr(x, y, w, h, 6); c.fillStyle = 'rgba(10,18,26,.86)'; c.fill(); c.lineWidth = 2; c.strokeStyle = K.line; c.stroke();
    const g = c.createLinearGradient(x, 0, x + w, 0); g.addColorStop(0, 'rgba(95,208,255,.12)'); g.addColorStop(1, 'rgba(95,208,255,0)'); c.fillStyle = g; c.fillRect(x + 2, y + 2, w - 4, 56);
    this.tx('ТЕКУЩАЯ СХВАТКА', x + 24, y + 30, 18, K.accent, { d: true, ls: 4 });
    const s = 400, px = x + 24, py = y + 76;
    c.fillStyle = '#0a141e'; c.fillRect(px, py, s, s); if (B.cv) c.drawImage(B.cv, px, py, s, s); c.strokeStyle = 'rgba(255,255,255,.15)'; c.lineWidth = 2; c.strokeRect(px, py, s, s);
    const tx = px + s + 28, tw = x + w - tx - 20;
    this.tx(B.name, tx, py + 18, 24, '#fff', { d: true, ls: 1, maxW: tw });
    this.tx(B.line, tx, py + 52, 18, K.accent2, { w: 600, maxW: tw });
    this.sub('ИГРОКИ', tx, py + 100);
    B.slots.forEach((p, k) => {
      const yy = py + 136 + k * 50; c.fillStyle = p.css; c.fillRect(tx, yy - 15, 30, 30); c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1.5; c.strokeRect(tx, yy - 15, 30, 30);
      this.tx(p.name, tx + 44, yy - (p.sub ? 8 : 0), 21, K.text, { maxW: tw - 44 }); if (p.sub) this.tx(p.sub, tx + 44, yy + 13, 15, K.dim, { w: 600, maxW: tw - 44 });
    });
    const oy = py + s + 40;
    this.sub('УСЛОВИЯ', px, oy);
    [['Победа', B.victory], ['Лимит юнитов', String(B.cap)], ['Туман войны', B.fog ? 'включён' : 'выключен']].forEach(([l, v], k) => {
      const yy = oy + 40 + k * 36; this.tx(l, px, yy, 20, K.dim, { w: 600 }); this.tx(v, px + 220, yy, 20, K.text);
    });
    this.tx('«Быстрый бой» — эта схватка · «Новая игра» — настроить лобби', px, y + h - 30, 17, K.dim, { w: 600, maxW: w - 48 });
  }

  // ---------------------------------------------------------------- lobby «Новая игра» (один экран, как #newgame на ПК)
  s_setup() {
    const L = this.hooks.lobby, I = L.info(), c = this.ctx, n = I.slots.length, sel = this.psel = Math.min(this.psel || 0, n - 1);
    this.frame('НОВАЯ ИГРА — ЛОББИ СХВАТКИ');
    // ---- слоты игроков (.ls-row)
    const xs = []; let cx = LX + 6; for (const [, w] of COLS) { xs.push(cx); cx += w + 6; }
    COLS.forEach(([s, w], k) => this.tx(s, xs[k] + 2, 98, 12, K.dim, { d: true, ls: 0.5, maxW: w + 2 }));
    I.slots.forEach((s, i) => {
      const y = 112 + i * 80, rh = 74, fy = y + 6, fh = 62, on = i === sel, rowHov = this.hoverId === 'sel:' + i;
      this.rr(LX, y, LW, rh, 4); c.fillStyle = on ? 'rgba(93,255,176,.07)' : 'rgba(255,255,255,.035)'; c.fill();
      if (on || rowHov) { c.lineWidth = 2; c.strokeStyle = on ? K.accent2 : K.line2; c.stroke(); }
      const f = (k, fld, extra) => this.field('pick:' + i + ':' + fld, xs[k], fy, COLS[k][1], fh, s.lab[fld], () => this.openSlot(i, fld), extra);
      if (i === 0) f(0, 'ai');
      else { c.fillStyle = s.css; c.fillRect(xs[0], fy + 8, 5, fh - 16); this.tx(s.name, xs[0] + 14, fy + fh / 2 + 1, 21, '#fff', { maxW: COLS[0][1] - 14 }); }
      this.field('sw:' + i, xs[1], fy, COLS[1][1], fh, s.lab.color, () => this.openSlot(i, 'color'), { swatch: s.css });
      f(2, 'team', { center: true, noArrow: true }); f(3, 'start', { center: true, noArrow: true }); f(4, 'camo');
      if (s.custom) {   // «Свой цвет»: список + квадрат цвета (на ПК <input type=color>)
        this.field('pick:' + i + ':pal', xs[5], fy, COLS[5][1] - 66, fh, s.lab.pal, () => this.openSlot(i, 'pal'), { noArrow: true });
        this.field('pick:' + i + ':custom', xs[5] + COLS[5][1] - 60, fy, 60, fh, '', () => this.openSlot(i, 'custom'), { swatch: s.custom });
      } else f(5, 'pal', { enabled: !s.camoTeam, chips: s.chips });
      if (s.ai) { f(6, 'diff'); f(7, 'doctrine'); }
      else { this.tx('—', xs[6] + COLS[6][1] / 2, fy + fh / 2, 22, K.dim, { align: 'center' }); this.tx('—', xs[7] + COLS[7][1] / 2, fy + fh / 2, 22, K.dim, { align: 'center' }); }
      if (n > 2 && i > 0) this.arrow('del:' + i, xs[8], fy, fh, 0, () => { L.del(i); if (this.psel >= n - 1) this.psel = 0; }, true, true);
      this.push('sel:' + i, LX, y, LW, rh, s.name, () => { this.psel = i; }, true);   // строка целиком: выбрать слот (после полей — они проверяются раньше)
    });
    const ay = 112 + n * 80 + 4;
    this.btn('add', LX, ay, 300, 62, '+ ДОБАВИТЬ ИИ', () => { const k = L.add(); if (k >= 0) this.psel = k; }, I.canAdd, { size: 19 });
    if (I.msg) this.tx(I.msg, LX + 320, ay + 31, 19, K.bad, { w: 600, maxW: LW - 330 });
    // ---- карты (.map-card)
    const per = 6, pages = Math.ceil(I.maps.length / (per - 1)), many = I.maps.length > per;
    if (!many) this.mapPage = 0; else this.mapPage %= pages;
    const shown = many ? I.maps.slice(this.mapPage * (per - 1), this.mapPage * (per - 1) + per - 1) : I.maps;
    const my = 534, cw = (LW - 24) / 3, ch = 104;
    this.sub('КАРТА', LX, my - 14);
    shown.forEach((m, k) => this.mapCard(m, LX + (k % 3) * (cw + 12), my + Math.floor(k / 3) * (ch + 10), cw, ch));
    if (many) this.btn('maps+', LX + 2 * (cw + 12), my + ch + 10, cw, ch, 'ЕЩЁ КАРТЫ  ▶', () => { this.mapPage = (this.mapPage + 1) % pages; }, true, { center: true, sub: `страница ${this.mapPage + 1} из ${pages}`, size: 20 });
    // ---- генератор случайной карты (#gen-panel)
    const gy = my + 2 * (ch + 10) + 32;
    if (I.map.isGen) this.genPanel(gy);
    else this.tx('Параметры генератора появятся, если выбрать «Случайную карту».', LX, gy + 20, 18, 'rgba(138,160,174,.6)', { w: 600 });
    // ---- правая колонка: превью с метками стартов (.ng-side)
    const ps = RW, py = 92;
    c.fillStyle = '#0a141e'; c.fillRect(RX, py, ps, ps); if (I.map.cv) c.drawImage(I.map.cv, RX, py, ps, ps);
    c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 2; c.strokeRect(RX, py, ps, ps);
    I.map.starts.forEach(([sx, sy], k) => {   // старт кликом по карте, как на ПК: занять позицию выбранным слотом
      const id = 'st:' + (k + 1), px = RX + sx * ps, pyy = py + sy * ps;
      if (this.hoverId === id) { c.beginPath(); c.arc(px, pyy, 24, 0, 7); c.lineWidth = 4; c.strokeStyle = K.accent2; c.stroke(); }
      this.push(id, px - 32, pyy - 32, 64, 64, 'старт ' + (k + 1), () => L.start(sel, k + 1), true);
    });
    this.tx(I.map.name, RX, py + ps + 26, 21, '#fff', { d: true, ls: 1, maxW: RW });
    this.tx(I.map.line, RX, py + ps + 54, 17, K.accent2, { w: 600, maxW: RW });
    this.wrap(I.map.desc, RX, py + ps + 80, RW, 20, 16, K.dim, 3);
    // ---- опции матча (.ng-opts)
    const oy = 638;
    this.field('pick:victory', RX, oy, RW, 62, I.victory, () => { const o = L.opts(-1, 'victory'); this.openList('pick:victory', o.title, o.opts, o.cur, (v) => L.set(-1, 'victory', v)); }, { label: 'ПОБЕДА' });
    this.check('fog', RX, oy + 72, RW, 62, 'Туман войны', I.fog, () => L.fog(), 'РАЗВЕДКА');
    this.field('pick:cap', RX, oy + 144, RW, 62, String(I.cap) + (I.cap >= 500 ? '   ⚠ может снизить FPS' : ''), () => { const o = L.opts(-1, 'cap'); this.openList('pick:cap', o.title, o.opts, o.cur, (v) => L.set(-1, 'cap', v)); }, { label: 'ЛИМИТ ЮНИТОВ НА КОМАНДУ' });
    // ---- кнопки (.ng-btns)
    this.btn('back', RX, 892, 150, 82, 'НАЗАД', () => this.back(), true, { center: true, size: 20 });
    this.btn('start', RX + 162, 892, RW - 162, 82, 'В БОЙ', () => this.begin(() => this.hooks.launch(false)), true, { primary: true, center: true, size: 32, ls: 6 });
    this.footer(LX, H - 30, 'left', LW);
  }
  mapCard(m, x, y, w, h) {
    const c = this.ctx, id = 'map:' + m.id, hov = this.hoverId === id;
    this.push(id, x, y, w, h, m.name, () => { if (this.hooks.lobby.map(m.id)) this.psel = Math.min(this.psel, 3); }, true);
    if (m.active) { this.rr(x - 4, y - 4, w + 8, h + 8, 7); c.lineWidth = 5; c.strokeStyle = 'rgba(93,255,176,.22)'; c.stroke(); }
    this.rr(x, y, w, h, 4); c.fillStyle = m.active ? 'rgba(14,34,30,.95)' : hov ? 'rgba(20,36,52,.95)' : 'rgba(14,22,30,.9)'; c.fill();
    this.rr(x, y, w, h, 4); c.lineWidth = m.active || hov ? 3 : 1.5; c.strokeStyle = m.active ? K.accent2 : hov ? K.accent : K.line; c.stroke();
    const s = h - 16; if (m.cv) c.drawImage(m.cv, x + 8, y + 8, s, s); c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1; c.strokeRect(x + 8, y + 8, s, s);
    const tx = x + s + 20, tw = w - s - 30;
    this.tx(m.name, tx, y + 24, 18, '#fff', { d: true, ls: 1, maxW: tw });
    this.tx(m.en, tx, y + 54, 15, K.accent, { w: 600, maxW: tw });
    this.tx(m.size, tx, y + 80, 15, K.accent2, { w: 600, maxW: tw });
  }
  genPanel(y) {
    const G = this.hooks.gen, I = G.info(), g = I.g, pct = (v) => Math.round(v * 100) + '%', cw = (LW - 36) / 4, h = 62, st = (k) => (d) => G.step(k, d);
    this.sub('СЛУЧАЙНАЯ КАРТА', LX, y - 14);
    const cells = [['type', 'ТИП', I.typeName], ['mountains', 'ГОРЫ', pct(g.mountains)], ['water', 'ВОДА', pct(g.water)], ['mass', 'МАССА', pct(g.mass)], ['forest', 'ЛЕС', pct(g.forest)], ['players', 'ИГРОКОВ', String(g.players)]];
    cells.forEach(([k, l, v], i) => this.stepper('g:' + k, LX + (i % 4) * (cw + 12), y + Math.floor(i / 4) * (h + 10), cw, h, l, v, st(k)));
    const y2 = y + h + 10;
    this.btn('g:seed', LX + 2 * (cw + 12), y2, cw, h, 'НОВЫЙ СИД', () => G.newSeed(), true, { sub: 'сид ' + g.seed, size: 18 });
    this.tx(I.genId ? 'Сохранённая карта' : 'Связность карты', LX + 3 * (cw + 12) + 8, y2 + 20, 16, K.dim, { w: 600, maxW: cw - 8 });
    this.tx(I.genId ? 'правка создаст новую' : 'проверяется при старте', LX + 3 * (cw + 12) + 8, y2 + 44, 16, K.dim, { w: 600, maxW: cw - 8 });
  }

  // ---------------------------------------------------------------- other screens
  s_memory() {
    const M = this.mem || this.hooks.memory.info(), c = this.ctx;
    this.frame('ДОЛГОВРЕМЕННАЯ ПАМЯТЬ ИИ');
    const kv = [['МАТЧЕЙ', M.games, '#fff'], ['ПОБЕД ИИ', M.wins, K.mass], ['ПОРАЖЕНИЙ ИИ', M.losses, K.bad], ['АВИАЦИЯ ПРОТИВНИКА', M.air + '%', '#fff'], ['ФЛОТ ПРОТИВНИКА', M.naval + '%', '#fff'], ['ПЕРВАЯ АТАКА (СРЕД.)', M.rush, '#fff']];
    const tw = (W - 80 - 5 * 12) / 6;
    kv.forEach(([l, v, col], k) => {   // .ai-kv
      const x = 40 + k * (tw + 12), y = 100;
      c.fillStyle = 'rgba(255,255,255,.035)'; c.fillRect(x, y, tw, 96); c.strokeStyle = 'rgba(255,255,255,.08)'; c.lineWidth = 1.5; c.strokeRect(x, y, tw, 96);
      this.tx(l, x + 16, y + 26, 13, K.dim, { d: true, ls: 1, maxW: tw - 28 }); this.tx(String(v), x + 16, y + 64, 36, col, { maxW: tw - 28 });
    });
    this.sub('КАРТА × СТРАТЕГИЯ: ЧТО РАБОТАЕТ', 40, 236, K.accent);
    const cx = [40, 560, 1170, 1300, 1430], hy = 278;
    [['КАРТА', 'left'], ['СТРАТЕГИЯ', 'left'], ['ИГР', 'center'], ['ПОБЕД', 'center'], ['%', 'center']].forEach(([s, a], k) => this.tx(s, cx[k] + (a === 'center' ? 50 : 0), hy, 14, K.accent, { d: true, ls: 1, align: a }));
    c.fillStyle = K.line; c.fillRect(40, hy + 16, W - 80, 1.5);
    if (!M.rows.length) this.tx('Пока пусто — сыграйте матч.', W / 2, 460, 26, K.dim, { align: 'center', w: 600 });
    M.rows.forEach((r, k) => {
      const y = hy + 48 + k * 54; if (k % 2) { c.fillStyle = 'rgba(255,255,255,.025)'; c.fillRect(40, y - 26, W - 80, 52); }
      [r.map, r.strat, r.n, r.w, r.pct + '%'].forEach((v, j) => this.tx(String(v), cx[j] + (j > 1 ? 50 : 0), y, 22, j === 4 ? (r.pct >= 50 ? K.mass : K.text) : K.text, { w: j > 1 ? 700 : 600, align: j > 1 ? 'center' : 'left', maxW: j === 0 ? 500 : j === 1 ? 580 : 120 }));
    });
    this.btn('reset', W - 40 - 300 - 12 - 260, 892, 300, 82, 'СТЕРЕТЬ ПАМЯТЬ', () => this.ask('Стереть долговременную память ИИ? Накопленная статистика пропадёт.', () => { this.hooks.memory.reset(); this.mem = null; this.go('memory'); }), M.games > 0 || M.rows.length > 0, { danger: true, center: true, size: 20 });
    this.btn('back', W - 40 - 260, 892, 260, 82, 'НАЗАД', () => this.back(), true, { primary: true, center: true });
    this.footer(40, H - 56, 'left', 700);
  }
  slots(keys, by, saving) {
    const h = this.hooks;
    if (by === null) { this.tx('Загрузка списка…', W / 2, 420, 28, K.dim, { align: 'center', w: 600 }); return; }
    if (by === false) { this.tx('Хранилище сохранений недоступно', W / 2, 420, 28, K.bad, { align: 'center' }); return; }
    if (!keys.length) { this.tx('Сохранений пока нет.', W / 2, 420, 28, K.dim, { align: 'center', w: 600 }); return; }
    keys.slice(0, 10).forEach((k, i) => {
      const m = by[k], d = h.saveDesc(m), x = 40 + (i % 2) * 766, y = 104 + Math.floor(i / 2) * 150;
      const act = saving ? () => this.begin2(k) : () => this.begin(() => h.loadGame(k));
      this.btn('slot:' + k, x, y, 754, 136, h.SLOT_NAMES[k] + (saving && m ? ' · ПЕРЕЗАПИСАТЬ' : ''), act, saving ? this.inBattle : d.ok, { sub: d.t, size: 22, primary: k === 'auto' || k === 'quick' });
    });
  }
  begin2(k) { const h = this.hooks; h.saveGame(k).then(() => { this.go(this.ret); }); }
  s_load() {
    const by = this.saves; this.frame('ЗАГРУЗИТЬ ИГРУ');
    this.slots(by ? Object.keys(this.hooks.SLOT_NAMES).filter(k => by[k]) : [], by, false);
    this.btn('back', W - 40 - 260, 892, 260, 82, 'НАЗАД', () => this.back(), true, { center: true }); this.footer(40, H - 56, 'left', 900);
  }
  s_save() {
    this.frame('СОХРАНИТЬ ИГРУ');
    this.slots(Object.keys(this.hooks.SLOT_NAMES).filter(k => k !== 'auto'), this.saves ?? {}, true);
    this.btn('back', W - 40 - 260, 892, 260, 82, 'НАЗАД', () => this.back(), true, { center: true }); this.footer(40, H - 56, 'left', 900);
  }
  s_settings() {
    const s = this.hooks.settings, vr = this.vr, pass = vr.passthrough;
    this.frame('НАСТРОЙКИ VR');
    const gw = 720, gx = [40, W - 40 - gw], row = (g, i, label) => { const y = 150 + i * 92; this.tx(label, gx[g], y + 33, 23, K.text, { w: 700 }); return y; };
    const list = (id, g, i, label, opts, cur, pick, title) => { const y = row(g, i, label); this.field(id, gx[g] + 300, y, gw - 300, 66, (opts.find(o => o[0] === cur) || opts[0])[1], () => this.openList(id, title || label.toUpperCase(), opts, cur, pick)); };
    this.sub('VR', gx[0], 116, K.accent2); this.sub('ГРАФИКА И ЗВУК', gx[1], 116, K.accent2);
    { const y = row(0, 0, 'Окружение'); this.check('passthrough', gx[0] + 300, y, gw - 300, 66, pass ? 'Пасстру (реальный мир)' : 'Небо (виртуальный мир)', pass, () => { vr.togglePassthrough(); s.vrPassthrough = vr.passthrough; this.hooks.commit(); this.dirty = true; }); }
    list('turn', 0, 1, 'Поворот', TURNS, s.vrTurn || 'snap30', (v) => this.setting('vrTurn', v));
    list('icon', 0, 2, 'Размер значков', ICONS, ICONS.some(v => v[0] === s.vrIconDeg) ? s.vrIconDeg : 1.3, (v) => this.setting('vrIconDeg', v));
    list('quality', 0, 3, 'Качество картинки', VR_QUALITY.map(q => [q, QUALITY[q] || q]), s.vrQuality || 'med', (v) => this.quality(v));
    list('bars', 1, 0, 'Полоски здоровья', BARS.map((b, i) => [i, b]), s.healthBars ?? 1, (v) => this.setting('healthBars', v));
    { const y = row(1, 1, 'Громкость'); this.stepper('vol', gx[1] + 300, y, gw - 300, 66, '', Math.round((s.volume ?? 0.6) * 100) + '%', (d) => this.step('vol', d)); }
    { const y = row(1, 2, 'Музыка'); this.stepper('mus', gx[1] + 300, y, gw - 300, 66, '', s.music === false ? 'ВЫКЛ' : Math.round((s.musicVolume ?? 0.5) * 100) + '%', (d) => this.step('mus', d)); }
    this.tx('Качество: модели перезагружаются сразу, масштаб кадра и фовеация — при следующем входе в VR.', 40, 560, 18, K.dim, { w: 600, maxW: W - 80 });
    this.btn('back', W - 40 - 260, 892, 260, 82, 'НАЗАД', () => this.back(), true, { primary: true, center: true });
    this.footer(40, H - 56, 'left', 1200);
  }
  // ---------------------------------------------------------------- «УПРАВЛЕНИЕ» (2 страницы): схема контроллеров и жесты. Источник текста: docs/QUEST_VR.md §8.
  // helpPad / helpTips рисуют в старом кадре CW x CH (стр. 90…630 по высоте); здесь он вписан в холст преобразованием.
  s_help() {
    const pg = this.helpPage = this.helpPage || 0, c = this.ctx;
    this.frame('УПРАВЛЕНИЕ', `${pg + 1} / 2 · ${pg ? 'Жесты и приёмы' : 'Контроллеры'}`);
    const k = 1.42, ox = (W - CW * k) / 2, oy = 86 - 88 * k;
    c.save(); c.setTransform(k, 0, 0, k, ox, oy);
    if (pg === 0) this.helpPad(); else this.helpTips();
    c.restore();
    this.btn('back', 40, 892, 300, 82, 'НАЗАД', () => this.back(), true, { center: true });
    if (pg === 0) this.btn('help-next', W - 40 - 520, 892, 520, 82, 'ЖЕСТЫ И ПРИЁМЫ  ▶', () => { this.helpPage = 1; }, true, { primary: true, center: true });
    else this.btn('help-prev', W - 40 - 520, 892, 520, 82, '◀  КОНТРОЛЛЕРЫ', () => { this.helpPage = 0; }, true, { primary: true, center: true });
    this.footer(W / 2, H - 67, 'center', 460);
  }
  helpPad() {
    const c = this.ctx, im = this.helpImgs, SC = 1.2, SX = 130, SY = 105, SW = 230, SH = 325, IY = 150, X0 = { l: 247, r: 501 };
    const COL = { trigger: '#ffb040', squeeze: '#5dffb0', stick: '#5fd0ff', a: '#ff7a9a', b: '#c59bff' };
    // [ключ, тег, строки]; ниже сортируются по высоте точки на картинке, чтобы линии не пересекались
    const LAB = {
      l: [['squeeze', 'ЗАХВАТ', ['взять стол', 'две руки: масштаб']], ['a', 'X', ['панель на руке']], ['stick', 'СТИК', ['двигать карту', 'нажать: виды']], ['b', 'Y', ['меню паузы']], ['trigger', 'КУРОК', ['держать: Shift', '(очередь)']]],
      r: [['squeeze', 'ЗАХВАТ', ['взять стол', 'две руки: поворот']], ['a', 'A', ['приказ, строй']], ['stick', 'СТИК', ['↑ ↓: полёт к взгляду', '← →: поворот', 'нажать: стол к себе']], ['b', 'B', ['отмена']], ['trigger', 'КУРОК', ['выбрать, приказ', 'зажать: круг']]]
    };
    for (const k of ['l', 'r']) {
      const x0 = X0[k], pts = CTRL_PTS[k];
      if (im && im[k].complete && im[k].naturalWidth) c.drawImage(im[k], SX, SY, SW, SH, x0, IY, SW * SC, SH * SC);
      else this.t('загрузка…', x0 + SW * SC / 2, 330, 24, '#8aa0ae', 'center', false);
      this.t(k === 'l' ? 'ЛЕВЫЙ' : 'ПРАВЫЙ', x0 + SW * SC / 2, 108, 26, '#fff', 'center');
      const rows = [...LAB[k]].sort((a, b) => pts[a[0]][1] - pts[b[0]][1]), RH = 100, bw = 250, bx = k === 'l' ? 12 : CW - 12 - bw, y0 = 128;
      rows.forEach(([key, tag, lines], i) => {
        const y = y0 + i * (RH + 4), col = COL[key], p = pts[key], dx = x0 + (p[0] * 512 - SX) * SC, dy = IY + (p[1] * 512 - SY) * SC;
        const ex = k === 'l' ? bx + bw : bx, ey = y + RH / 2;
        c.strokeStyle = col; c.lineWidth = 3; c.beginPath(); c.moveTo(ex, ey); c.lineTo(dx, dy); c.stroke();
        this.rr(bx, y, bw, RH, 12); c.fillStyle = 'rgba(14,30,46,.96)'; c.fill(); c.lineWidth = 3; c.strokeStyle = col; c.stroke();
        c.beginPath(); c.arc(dx, dy, 9, 0, 7); c.fillStyle = col; c.fill(); c.lineWidth = 2.5; c.strokeStyle = '#000'; c.stroke();
        this.t(tag, bx + 12, y + 19, 26, col, 'left', true, bw - 20);
        lines.forEach((l, j) => this.t(l, bx + 12, y + 44 + j * 23, 22, '#e6eef4', 'left', false, bw - 20));
      });
    }
  }
  helpTips() {
    const c = this.ctx, A = '#5fd0ff', O = '#ffb040', G = '#5dffb0';
    const ring = (x, y, r, col, w = 4) => { c.beginPath(); c.arc(x, y, r, 0, 7); c.lineWidth = w; c.strokeStyle = col; c.stroke(); };
    const dot = (x, y, r, col) => { c.beginPath(); c.arc(x, y, r, 0, 7); c.fillStyle = col; c.fill(); };
    const arrow = (x1, y1, x2, y2, col) => { const a = Math.atan2(y2 - y1, x2 - x1); c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 4; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - 12 * Math.cos(a - 0.5), y2 - 12 * Math.sin(a - 0.5)); c.lineTo(x2 - 12 * Math.cos(a + 0.5), y2 - 12 * Math.sin(a + 0.5)); c.fill(); };
    const cards = [
      ['ДВЕ РУКИ НА ЗАХВАТ', ['Тянуть врозь: масштаб.', 'Вращать: поворот стола.'], (x, y) => { dot(x - 22, y, 11, O); dot(x + 22, y, 11, O); arrow(x - 30, y, x - 52, y, A); arrow(x + 30, y, x + 52, y, A); }],
      ['КРУГ ВЫДЕЛЕНИЯ', ['Курок на пустом месте,', 'вести лазер: выбрать всех.'], (x, y) => { c.setLineDash([8, 7]); ring(x, y, 40, G, 4); c.setLineDash([]); dot(x - 14, y - 12, 6, '#fff'); dot(x + 12, y + 8, 6, '#fff'); dot(x - 6, y + 18, 6, '#fff'); }],
      ['ДВОЙНОЙ КУРОК', ['По юниту: все такие', 'на видимой части стола.'], (x, y) => { [[-24, -10], [20, -16], [4, 22]].forEach(([a, b]) => { ring(x + a, y + b, 15, G, 4); dot(x + a, y + b, 6, '#fff'); }); }],
      ['СТРОЙКА', ['Здание липнет к краю соседа.', 'Линии: бонус смежности.'], (x, y) => { c.fillStyle = 'rgba(95,208,255,.55)'; c.fillRect(x - 42, y - 20, 36, 40); c.fillStyle = 'rgba(93,255,176,.7)'; c.fillRect(x - 2, y - 20, 36, 40); c.strokeStyle = O; c.lineWidth = 3; c.beginPath(); c.moveTo(x - 24, y); c.lineTo(x + 16, y); c.stroke(); dot(x + 42, y - 22, 6, O); }],
      ['ВИДЫ КАРТЫ', ['Левый стик, нажатие:', 'Обзор, Сверху, Сбоку.'], (x, y) => { [['О', -34], ['С', 0], ['Б', 34]].forEach(([s, dx], i) => { this.rr(x + dx - 15, y - 17, 30, 34, 6); c.fillStyle = i ? 'rgba(22,52,80,.95)' : 'rgba(255,176,64,.5)'; c.fill(); c.lineWidth = 2; c.strokeStyle = i ? A : O; c.stroke(); this.t(s, x + dx, y + 1, 22, '#fff', 'center'); }); }],
      ['ПАНЕЛЬ НА РУКЕ', ['Выбор, приказы, виды.', 'X: скрыть; «?»: схема.'], (x, y) => { c.save(); c.translate(x, y); c.rotate(-0.25); this.rr(-32, -26, 64, 52, 6); c.fillStyle = 'rgba(22,52,80,.95)'; c.fill(); c.lineWidth = 3; c.strokeStyle = A; c.stroke(); for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { c.fillStyle = A; c.fillRect(-24 + i * 18, -16 + j * 20, 14, 14); } c.restore(); }]
    ];
    cards.forEach(([title, lines, icon], i) => {
      const x = 14 + (i % 2) * 502, y = 92 + Math.floor(i / 2) * 182, w = 494, h = 170;
      this.rr(x, y, w, h, 14); c.fillStyle = 'rgba(14,30,46,.96)'; c.fill(); c.lineWidth = 2; c.strokeStyle = 'rgba(95,208,255,.5)'; c.stroke();
      icon(x + 78, y + h / 2);
      this.t(title, x + 150, y + 40, 28, O, 'left', true, w - 160);
      lines.forEach((l, j) => this.t(l, x + 150, y + 85 + j * 32, 24, '#e6eef4', 'left', false, w - 160));
    });
  }
  s_pause() {
    const over = !this.inBattle, m = this.modal(600, 758, 'ПАУЗА');
    this.col([
      ['resume', 'ПРОДОЛЖИТЬ', () => this.close(), true, { primary: true }],
      ['staff', 'ШТАБ', () => this.vr.staff.open(), !over && !!this.vr.ui.staff],   // помощники-лейтенанты (js/vrstaff.js)
      ['save', 'СОХРАНИТЬ ИГРУ', () => this.go('save'), !over],
      ['load', 'ЗАГРУЗИТЬ ИГРУ', () => this.go('load')],
      ['settings', 'НАСТРОЙКИ', () => this.go('settings'), true, { half: 1, size: 19 }],
      ['help', 'УПРАВЛЕНИЕ', () => this.go('help'), true, { half: 2, size: 19 }],
      ['surrender', 'СДАТЬСЯ', () => this.ask('Сдаться? Матч будет засчитан как поражение.', () => { this.hooks.surrender(); this.go('pause'); }), !over, { danger: true }],
      ['tomenu', 'В ГЛАВНОЕ МЕНЮ', () => this.ask(over ? 'Выйти в главное меню?' : 'Выйти в главное меню? Матч будет засчитан как поражение.', () => { this.hooks.leaveToMenu(); this.go('main'); })]
    ], m.x + 34, m.y + 90, m.w - 68, 68, 10);
    this.footer(W / 2, m.y + m.h - 30, 'center', m.w - 40);
  }
  s_staff() { this.vr.staff.draw(this); }   // «ШТАБ»: помощники-лейтенанты, js/vrstaff.js
  s_confirm() {
    const m = this.modal(900, 400, 'ПОДТВЕРЖДЕНИЕ'), lines = this.confirmText.split(/(?<=[.?!]) /);
    lines.forEach((l, i) => this.tx(l, m.x + 34, m.y + 120 + i * 44, 30, i ? K.text : '#fff', { w: i ? 600 : 700, maxW: m.w - 68 }));
    const by = m.y + m.h - 112;
    this.btn('no', m.x + m.w - 34 - 520 - 12, by, 260, 84, 'НЕТ', () => this.go(this.noScreen), true, { center: true, size: 24 });
    this.btn('yes', m.x + m.w - 34 - 260, by, 260, 84, 'ДА', () => { const f = this.yes; this.yes = null; if (f) f(); if (this.screen === 'confirm') this.go(this.noScreen); }, true, { primary: true, center: true, size: 24 });
  }
  s_loading() {
    const m = this.modal(1000, 220);
    this.tx('РАЗВЁРТЫВАНИЕ ТЕАТРА ВОЕННЫХ ДЕЙСТВИЙ…', W / 2, m.y + 92, 30, K.accent, { d: true, ls: 4, align: 'center', maxW: m.w - 60 });
    this.tx('Карта, войска и штабы ИИ готовятся к бою', W / 2, m.y + 148, 20, K.dim, { w: 600, align: 'center' });
  }
  s_over() {
    const d = this.overData || { title: '', sub: '', time: '', rows: [] }, c = this.ctx;
    const col = d.good ? K.mass : d.bad ? K.bad : K.accent, m = this.modal(1240, 720, d.title, col, d.good ? 'rgba(70,224,112,.55)' : d.bad ? 'rgba(255,74,58,.55)' : 'rgba(95,208,255,.5)');
    this.tx(d.sub, m.x + 34, m.y + 104, 23, K.dim, { w: 600, maxW: m.w - 68 });
    this.tx('Длительность: ' + d.time, m.x + 34, m.y + 142, 21, K.text, { w: 600 });
    const cols = [[m.x + 34, 'СТОРОНА', 'left'], [m.x + 620, 'ПОСТРОЕНО', 'center'], [m.x + 780, 'УБИТО', 'center'], [m.x + 920, 'ПОТЕРЯНО', 'center'], [m.x + 1080, 'МАССА ДОБЫТО', 'center']];
    const hy = m.y + 200; cols.forEach(([x, s, a]) => this.tx(s, x, hy, 14, K.accent, { d: true, ls: 1, align: a }));
    c.fillStyle = K.line; c.fillRect(m.x + 34, hy + 18, m.w - 68, 1.5);
    d.rows.slice(0, 4).forEach((r, i) => {
      const y = hy + 58 + i * 56; if (i % 2) { c.fillStyle = 'rgba(255,255,255,.03)'; c.fillRect(m.x + 34, y - 26, m.w - 68, 52); }
      [r.name, r.built, r.kills, r.lost, r.mass ?? '—'].forEach((v, k) => this.tx(String(v), cols[k][0], y, 24, k ? '#fff' : r.color, { align: cols[k][2], maxW: k ? 150 : 540 }));
    });
    const by = m.y + m.h - 140;
    this.btn('resume', m.x + 34, by, 420, 84, 'ОСМОТРЕТЬ ПОЛЕ БОЯ', () => this.close(), true, { center: true, size: 19 });
    this.btn('again', m.x + m.w - 34 - 300 - 12 - 330, by, 330, 84, 'РЕВАНШ', () => this.begin(() => this.hooks.playAgain()), true, { center: true });
    this.btn('tomenu', m.x + m.w - 34 - 300, by, 300, 84, 'ГЛАВНОЕ МЕНЮ', () => { this.hooks.leaveToMenu(); this.go('main'); }, true, { primary: true, center: true, size: 19 });
    this.footer(W / 2, m.y + m.h - 28, 'center', 600);
  }
}
