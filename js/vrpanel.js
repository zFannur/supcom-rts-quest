import * as THREE from 'three';
import { UNITS, STRUCTS, PRODUCES, TIER_NAMES, TEAM_CSS, ENH } from './specs.js';
import { MAP_SIZE } from './maps.js';
import { iconSprite } from './vricons.js';
import { thumbURL } from './thumbs.js';
import { FORMS } from './ui.js';

// Wrist panel position relative to the left controller grip (metres / radians)
const PANEL_POS_X = 0;
const PANEL_POS_Y = 0.06;
const PANEL_POS_Z = -0.02;
const PANEL_ROT_X = -Math.PI / 4;
const PANEL_ROT_Y = Math.PI / 8;
const PANEL_ROT_Z = 0;

// Canvas 1024x768 (4:3) on a 0.26 x 0.195 m plane: ~3.9 px per mm, the smallest text is ~19 px (~5 mm).
const CW = 1024, CH = 768;
const PLANE_W = 0.26, PLANE_H = PLANE_W * CH / CW;
const REDRAW_DT = 0.1;       // full redraw / texture upload rate (10 Hz)
const REDRAW_MIN = 1 / 30;   // hover / click feedback is immediate, but never faster than this
const REDRAW_PAUSED = 0.5;   // nothing moves on a paused game

const FONT = 'Rajdhani, "Segoe UI", Arial, sans-serif';
const C_MASS = '#46e070', C_ENERGY = '#ffd23c', C_BAD = '#ff4a3a', C_EXP = '#ff8a6a', C_ACC = '#5fd0ff', C_DIM = '#8aa0ae', C_TEXT = '#dbe7ef';
const SPEED_LIST = [0.25, 0.5, 1, 1.5, 2, 3, 4];

// layout
const MM = { x: 10, y: 88, w: 340, h: 340 };
const SEL = { x: 10, y: 436, w: 340, h: 196 };
const VIEW_Y = 640, VIEW_H = 54;   // row «ВИД» under the selection: view presets (vr.viewPreset)
const RX = 362, RW = 652;
const CARD_W = 154, CARD_H = 128, CARD_GAP = 4, CARD_Y = 250, PER_PAGE = 12;
const GRP_Y = 648, GRP_H = 48;   // row under the cards: control groups 1-5 (left) + formation type / spacing (right)

const fmt = (n) => n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n).toString();
const fmtT = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const MODE_NAME = { build: 'Строительство', amove: 'Атака с ходу', patrol: 'Патруль', reclaim: 'Переработка', oc: 'Сверхзаряд', unload: 'Высадка', launch: 'Пуск ракеты', zone: 'Зона помощника' };
const ORDER_NAME = { move: 'Движение', amove: 'Атака с ходу', attack: 'Атака цели', patrol: 'Патруль', guard: 'Охрана', build: 'Строительство', assist: 'Помощь', repair: 'Ремонт', reclaim: 'Переработка', retreatTo: 'Отход', enhance: 'Улучшение', board: 'Посадка', pickup: 'Подбор груза', unload: 'Высадка' };

export class VRPanel {
  // cfg = { ui, renderer, hooks, system? }. system is the VRSystem itself (tableCenterGame, updateDolly, passthrough...);
  // vr.js should pass system: this, otherwise it is looked up lazily from window.__dbg.vr.
  constructor(cfg) {
    this.cfg = cfg;
    this.ui = cfg.ui;
    this.hooks = cfg.hooks;

    this.canvas = document.createElement('canvas');
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.ctx = this.canvas.getContext('2d');

    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;

    const geom = new THREE.PlaneGeometry(PLANE_W, PLANE_H);
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, toneMapped: false, depthTest: true });
    this.object3d = new THREE.Mesh(geom, mat);
    this.object3d.position.set(PANEL_POS_X, PANEL_POS_Y, PANEL_POS_Z);
    this.object3d.rotation.set(PANEL_ROT_X, PANEL_ROT_Y, PANEL_ROT_Z);

    this.buttons = [];
    this.hoverBtn = null;
    this.hitX = -1; this.hitY = -1;
    this.msgText = '';
    this.msgT = 0;

    this.imgs = new Map(); this.thumbDrawn = 0; this.iconDrawn = 0;   // thumbnails drawn / pictogram fallbacks in the last draw
    this.page = 0;
    this._pageSig = '';
    this.needsRedraw = true;
    this.t = 0;          // time since the last redraw
    this.drawCount = 0;

    this.draw();
  }

  get vr() { return this.cfg.system || (typeof window !== 'undefined' && window.__dbg && window.__dbg.vr) || null; }

  message(text, ms = 2500) {
    this.msgText = text;
    this.msgT = ms / 1000;
    this.needsRedraw = true;
  }

  hit(raycaster) {
    const inters = this.object3d.visible ? raycaster.intersectObject(this.object3d, false) : [];   // raycaster ignores .visible
    let newHover = null;
    if (inters.length > 0) {
      const uv = inters[0].uv;
      const x = uv.x * CW;
      const y = (1 - uv.y) * CH;
      for (const b of this.buttons) {
        if (b.enabled && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { newHover = b; break; }
      }
      const moved = newHover && newHover.id === 'minimap' && (Math.abs(x - this.hitX) > 2 || Math.abs(y - this.hitY) > 2);
      this.hitX = x; this.hitY = y;
      if ((this.hoverBtn ? this.hoverBtn.id : null) !== (newHover ? newHover.id : null) || moved) this.needsRedraw = true;
      this.hoverBtn = newHover;
      return inters[0].distance;
    }
    if (this.hoverBtn !== null) {
      this.hoverBtn = null;
      this.needsRedraw = true;
    }
    return null;
  }

  press() {
    if (this.hoverBtn && this.hoverBtn.action) {
      this.hoverBtn.action(this.hitX, this.hitY);
      this.needsRedraw = true;
    }
  }

  update(dt) {
    if (!this.object3d.parent) return;   // controller not connected: nobody sees the panel
    if (this.msgT > 0) {
      this.msgT -= dt;
      if (this.msgT <= 0) { this.msgT = 0; this.msgText = ''; this.needsRedraw = true; }
    }
    this.t += dt;
    const now = performance.now();   // FPS / frame ms readout (average over ~0.5 s), painted in the panel corner by draw()
    if (this.fpsT0) { this.fpsN++; if (now - this.fpsT0 >= 500) { this.fpsMs = (now - this.fpsT0) / this.fpsN; this.fpsT0 = now; this.fpsN = 0; } } else { this.fpsT0 = now; this.fpsN = 0; }
    const paused = this.ui.paused;
    if ((this.needsRedraw && this.t >= REDRAW_MIN) || this.t >= (paused ? REDRAW_PAUSED : REDRAW_DT)) {
      this.t = 0;
      this.needsRedraw = false;
      this.draw();
    }
  }

  // ------------------------------------------------------------------ drawing primitives
  rr(x, y, w, h, r = 6) {
    const c = this.ctx;
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
  }
  txt(s, x, y, size = 24, color = '#fff', align = 'left', bold = true, maxW) {
    const c = this.ctx;
    c.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`;
    c.fillStyle = color; c.textAlign = align; c.textBaseline = 'middle';
    if (maxW) c.fillText(s, x, y, maxW); else c.fillText(s, x, y);
  }
  wrap(s, maxW, size, maxLines) {
    const c = this.ctx; c.font = `${size}px ${FONT}`;
    const words = String(s).split(' '), lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (c.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
    return lines;
  }
  addButton(id, x, y, w, h, action, enabled = true, tip = '') {
    const b = { id, x, y, w, h, action, enabled, tip };
    this.buttons.push(b);
    return b;
  }
  isHover(id) { return !!this.hoverBtn && this.hoverBtn.id === id; }
  // plain labelled button (also registers its hit area)
  button(id, x, y, w, h, label, action, enabled = true, opt = {}) {
    const c = this.ctx, b = this.addButton(id, x, y, w, h, action, enabled, opt.tip || '');
    const hov = enabled && this.isHover(id);
    this.rr(x, y, w, h, 6);
    c.fillStyle = !enabled ? 'rgba(40,46,52,.85)' : hov ? 'rgba(95,208,255,.55)' : opt.on ? 'rgba(255,176,64,.45)' : 'rgba(22,52,80,.9)';
    c.fill();
    c.lineWidth = 2; c.strokeStyle = !enabled ? '#4a5560' : hov ? '#fff' : opt.on ? '#ffb040' : 'rgba(95,208,255,.55)'; c.stroke();
    this.txt(label, x + w / 2, y + h / 2 + 1, opt.size || 22, enabled ? '#fff' : '#7b8791', 'center', true, w - 10);
    return b;
  }

  // ------------------------------------------------------------------ main draw
  draw() {
    const ctx = this.ctx;
    this.drawCount++; this.thumbDrawn = 0; this.iconDrawn = 0;
    ctx.clearRect(0, 0, CW, CH);
    this.rr(1, 1, CW - 2, CH - 2, 14);
    ctx.fillStyle = 'rgba(7,14,21,0.92)'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#4f9fff'; ctx.stroke();

    this.buttons = [];
    const ui = this.ui, game = ui.game;
    if (this.fpsMs) this.txt(`${Math.round(1000 / this.fpsMs)} FPS · ${this.fpsMs.toFixed(1)} мс`, CW - 10, CH - 12, 16, '#6f8796', 'right', false);

    if (!game) {
      this.txt('ГЛАВНОЕ МЕНЮ', CW / 2, CH / 2 - 60, 54, '#fff', 'center');
      this.button('exit', CW / 2 - 160, CH / 2 + 30, 320, 90, this.vr && this.vr.isTWA ? 'МЕНЮ' : 'ВЫЙТИ ИЗ VR', () => this.hooks.exitVR(), true, { size: 34 });
      this.tex.needsUpdate = true;
      return;
    }

    this.drawTopRow(ctx, game, ui);
    this.drawMinimap(ctx, game, ui);
    this.drawSelection(ctx, game, ui);
    this.drawCommands(ctx, game, ui);
    this.drawGroupRow(ctx, ui);
    this.drawViewRow(ctx);
    this.drawBottomRow(ctx, ui);
    if (this.hoverBtn) this.hoverBtn = this.buttons.find(b => b.id === this.hoverBtn.id && b.enabled) || null;
    this.tex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- resources / time / speed
  drawTopRow(ctx, game, ui) {
    const T = game.teams[ui.team || 1], eco = T && T.eco;
    if (eco) {
      const stallM = eco.stallM && eco.mass < 5;
      const effM = stallM ? `ДЕФИЦИТ ${Math.round(eco.effM * 100)}%` : eco.mass >= eco.maxMass - 1 ? 'СКЛАД ПОЛОН' : eco.fabM && !eco.fabOn ? 'ФАБРИКИ ВЫКЛ' : '';
      const effE = eco.stallE ? `ДЕФИЦИТ ${Math.round(eco.effE * 100)}%` : '';
      this.resBlock(ctx, 10, 'М', C_MASS, eco.mass, eco.maxMass, eco.incM.toFixed(1), eco.spendM.toFixed(1), stallM, effM);
      this.resBlock(ctx, 360, 'Э', C_ENERGY, eco.energy, eco.maxEnergy, eco.incE.toFixed(0), (eco.spendE + eco.upkeep).toFixed(0), eco.stallE, effE);
    }

    this.txt(fmtT(game.time), 718, 24, 32, '#fff');
    const uc = T ? T.unitCount : 0;
    this.txt(`${uc}/${game.unitCap}`, 830, 24, 24, C_DIM);
    this.button('pause', 908, 6, 106, 38, ui.paused ? 'ИГРАТЬ' : 'ПАУЗА', () => { ui.togglePause(); }, true, { on: ui.paused, size: 22 });
    this.button('slower', 718, 48, 58, 36, '−', () => ui.changeSpeed(-1), ui.speedIdx > 0, { size: 28 });
    this.txt('×' + ui.speed, 842, 66, 28, ui.speed === 1 ? '#fff' : C_ACC, 'center');
    this.button('faster', 908, 48, 58, 36, '+', () => ui.changeSpeed(1), ui.speedIdx < SPEED_LIST.length - 1, { size: 28 });
  }
  resBlock(ctx, x, label, col, cur, max, inc, exp, stall, eff) {
    const w = 340, h = 34, f = Math.max(0, Math.min(1, max > 0 ? cur / max : 0));
    this.rr(x, 8, w, h, 6); ctx.fillStyle = '#0a1219'; ctx.fill();
    if (f > 0) {
      ctx.save(); this.rr(x, 8, w, h, 6); ctx.clip();
      ctx.fillStyle = col; ctx.globalAlpha = 0.55; ctx.fillRect(x, 8, w * f, h); ctx.globalAlpha = 1;
      ctx.restore();
    }
    this.rr(x, 8, w, h, 6); ctx.lineWidth = 2; ctx.strokeStyle = stall ? C_BAD : col; ctx.stroke();
    this.txt(label, x + 18, 26, 28, col, 'center');
    this.txt(`${fmt(cur)} / ${fmt(max)}`, x + w / 2 + 14, 26, 26, '#fff', 'center');
    this.txt('+' + inc, x + 8, 62, 26, col, 'left');
    this.txt('−' + exp, x + 100, 62, 26, C_EXP, 'left');
    if (eff) this.txt(eff, x + w - 4, 62, 20, C_BAD, 'right', true, 150);
  }

  // ---------------------------------------------------------------- minimap
  drawMinimap(ctx, game, ui) {
    const { x: mx, y: my, w: mw, h: mh } = MM, k = mw / MAP_SIZE, lt = ui.team;
    ctx.save();
    ctx.beginPath(); ctx.rect(mx, my, mw, mh); ctx.clip();
    ctx.fillStyle = '#0a1219'; ctx.fillRect(mx, my, mw, mh);
    ctx.imageSmoothingEnabled = true;
    if (ui.mmBase) ctx.drawImage(ui.mmBase, mx, my, mw, mh);
    if (lt && game.opts.fog && ui.mmFog) ctx.drawImage(ui.mmFog, mx, my, mw, mh);   // kept up to date by ui.drawMinimap
    ctx.translate(mx, my);

    for (const s of game.structs) {
      if (lt && !game.seenBy(lt, s)) continue;
      ctx.fillStyle = TEAM_CSS[s.team] || '#aaa'; const sz = Math.max(4, s.spec.size * k);
      ctx.fillRect(s.x * k - sz / 2, s.y * k - sz / 2, sz, sz);
    }
    for (const u of game.units) {
      const vis = !lt || game.visibleTo(lt, u);
      if (!vis && !(lt && u.rad && u.rad[lt])) continue;
      ctx.fillStyle = vis ? (TEAM_CSS[u.team] || '#aaa') : 'rgba(255,120,90,0.75)';
      const sz = u.spec.role === 'exp' ? 7 : u.key === 'acu' ? 6 : 3;
      ctx.fillRect(u.x * k - sz / 2, u.y * k - sz / 2, sz, sz);
      if (u.key === 'acu' && vis) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.strokeRect(u.x * k - 4.5, u.y * k - 4.5, 9, 9); }
    }
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#7dffb0';
    for (const s of ui.selection) ctx.strokeRect(s.x * k - 4, s.y * k - 4, 8, 8);
    for (const n of game.notes.slice(-4)) {
      if (n.kind === 'alert' && game.time - n.t < 6 && n.team === (lt || 1)) { ctx.strokeStyle = '#ff4a3a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(n.x * k, n.y * k, 8 + (game.time * 8 % 8), 0, 6.28); ctx.stroke(); }
    }
    for (const p of game.projectiles) {
      if (p.type !== 'nuke') continue;
      const own = !lt || game.allied(lt, p.team);
      ctx.strokeStyle = ctx.fillStyle = own ? '#7dffb0' : '#ff3a2a';
      ctx.globalAlpha = 0.3; ctx.beginPath(); ctx.arc(p.tx * k, p.ty * k, Math.max(5, p.zones[2] * k), 0, 6.28); ctx.fill();
      ctx.globalAlpha = 1; ctx.lineWidth = 2; ctx.stroke();
    }

    // area of the real table in front of the player + the head position
    const vr = this.vr;
    if (vr) this.drawTableMarker(ctx, vr, k);
    ctx.translate(-mx, -my);
    this.drawMinimapTail(ctx, game, ui, vr, mx, my, mw, mh);
  }
  drawTableMarker(ctx, vr, k) {
    const sc = vr.tablePhysicalScale || 1.25, th = vr.tableRotation || 0;
    const half = 0.6 * MAP_SIZE / sc;      // the table surface within ~0.6 m of its centre, in game units
    const cx = vr.tableCenterGame.x, cz = vr.tableCenterGame.z, cs = Math.cos(th), sn = Math.sin(th);
    const corner = (a, b) => [(cx + a * cs + b * sn) * k, (cz - a * sn + b * cs) * k];
    ctx.strokeStyle = '#ffe060'; ctx.lineWidth = 2.5; ctx.setLineDash([8, 5]);
    ctx.beginPath();
    [[-half, -half], [half, -half], [half, half], [-half, half]].forEach(([a, b], i) => { const p = corner(a, b); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
    ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#ffe060'; ctx.beginPath(); ctx.arc(cx * k, cz * k, 4, 0, 6.28); ctx.fill();
    ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx * k - 9, cz * k); ctx.lineTo(cx * k + 9, cz * k); ctx.moveTo(cx * k, cz * k - 9); ctx.lineTo(cx * k, cz * k + 9); ctx.stroke();
    const cam = this.cfg.renderer && this.cfg.renderer.camera;
    if (cam && vr.inVR) {
      const e = cam.matrixWorld.elements, hx = e[12] * k, hz = e[14] * k, fx = -e[8], fz = -e[10], fl = Math.hypot(fx, fz) || 1, ux = fx / fl, uz = fz / fl;
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx + ux * 9, hz + uz * 9); ctx.lineTo(hx - ux * 5 - uz * 5, hz - uz * 5 + ux * 5); ctx.lineTo(hx - ux * 5 + uz * 5, hz - uz * 5 - ux * 5); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  drawMinimapTail(ctx, game, ui, vr, mx, my, mw, mh) {
    // laser cursor
    if (this.isHover('minimap')) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(this.hitX, this.hitY, 9, 0, 6.28); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(this.hitX - 14, this.hitY); ctx.lineTo(this.hitX + 14, this.hitY); ctx.moveTo(this.hitX, this.hitY - 14); ctx.lineTo(this.hitX, this.hitY + 14); ctx.stroke();
    }
    ctx.restore();
    ctx.lineWidth = 2; ctx.strokeStyle = this.isHover('minimap') ? '#fff' : 'rgba(95,208,255,.7)'; ctx.strokeRect(mx, my, mw, mh);
    if (ui.paused) this.txt('ПАУЗА', mx + mw / 2, my + 24, 28, '#ffb040', 'center');

    this.addButton('minimap', mx, my, mw, mh, (px, py) => {
      if (!vr) return;
      const gx = THREE.MathUtils.clamp((px - mx) / mw * MAP_SIZE, 0, MAP_SIZE), gz = THREE.MathUtils.clamp((py - my) / mh * MAP_SIZE, 0, MAP_SIZE);
      vr.tableCenterGame.set(gx, game.terrain.surfaceAt(gx, gz), gz);
      vr.updateDolly();
    }, true, 'Миникарта: нажмите, чтобы сдвинуть стол к этой точке');
  }

  // ---------------------------------------------------------------- selection
  // Model thumbnail (thumbs.js, 11.9.5) once rendered and decoded; the pictogram is the fallback. Image objects are cached per url, a finished load repaints the panel.
  thumb(key, team) {
    const url = key && thumbURL(key, team || 1); if (!url) return null;
    let im = this.imgs.get(url);
    if (!im) { im = new Image(); im.onload = () => { this.needsRedraw = true; }; im.src = url; this.imgs.set(url, im); }
    return im.complete && im.naturalWidth ? im : null;
  }
  icon(ctx, spec, team, x, y, size, struct) {
    const im = this.thumb(spec.key, team);
    if (im) { this.thumbDrawn++; ctx.drawImage(im, x, y, size, size); return; }
    this.iconDrawn++;
    const col = TEAM_CSS[team] || '#8fb4cc';
    ctx.drawImage(iconSprite(spec.icon, col, struct), x, y, size, size);
  }
  drawSelection(ctx, game, ui) {
    const { x, y, w, h } = SEL, sel = ui.selection;
    this.rr(x, y, w, h, 8); ctx.fillStyle = 'rgba(16,28,38,.9)'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(95,208,255,.35)'; ctx.stroke();
    if (!sel.length) {
      this.txt('НИЧЕГО НЕ ВЫБРАНО', x + w / 2, y + 60, 26, '#fff', 'center');
      const lines = this.wrap('Наведите лазер на юнит и нажмите триггер, или обведите область. Кнопки справа — быстрый выбор командира и инженера.', w - 30, 21, 5);
      lines.forEach((l, i) => this.txt(l, x + 15, y + 100 + i * 28, 21, C_DIM, 'left', false));
      return;
    }
    if (sel.length > 1) {
      const counts = new Map();
      for (const e of sel) { if (!counts.has(e.key)) counts.set(e.key, { e, n: 0, hp: 0, max: 0 }); const c = counts.get(e.key); c.n++; c.hp += e.hp; c.max += e.maxHp; }
      const hp = sel.reduce((a, e) => a + e.hp, 0), mhp = sel.reduce((a, e) => a + e.maxHp, 0);
      this.txt(`ВЫБРАНО: ${sel.length}`, x + 12, y + 22, 26, '#fff');
      this.txt(`HP ${Math.round(hp / Math.max(1, mhp) * 100)}%`, x + w - 12, y + 22, 24, C_MASS, 'right');
      let i = 0;
      for (const [key, c] of counts) {
        if (i >= 8) break;
        const cw = 80, chh = 72, cx = x + 8 + (i % 4) * (cw + 4), cy = y + 42 + Math.floor(i / 4) * (chh + 6), id = 'selk:' + key, hov = this.isHover(id);
        this.addButton(id, cx, cy, cw, chh, () => { ui.selection = ui.selection.filter(e => e.key === key); ui.refreshPanels(true); }, true, `${c.e.spec.name} — нажмите, чтобы выбрать только их`);
        this.rr(cx, cy, cw, chh, 5); ctx.fillStyle = hov ? 'rgba(95,208,255,.4)' : 'rgba(8,15,22,.85)'; ctx.fill(); ctx.lineWidth = hov ? 2 : 1; ctx.strokeStyle = hov ? '#fff' : 'rgba(95,208,255,.3)'; ctx.stroke();
        this.icon(ctx, c.e.spec, c.e.team, cx + 14, cy + 2, 52, c.e.kind === 'struct');
        this.txt(String(c.n), cx + cw - 5, cy + 18, 22, '#fff', 'right');
        const f = c.hp / c.max; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(cx + 6, cy + chh - 11, cw - 12, 6);
        ctx.fillStyle = f > 0.6 ? '#46e070' : f > 0.3 ? '#e8c440' : C_BAD; ctx.fillRect(cx + 6, cy + chh - 11, (cw - 12) * f, 6);
        i++;
      }
      return;
    }
    const e = sel[0], s = e.spec, hpf = Math.max(0, e.hp / e.maxHp);
    this.icon(ctx, s, e.team, x + 8, y + 6, 92, e.kind === 'struct');
    this.txt(s.name, x + 106, y + 24, 25, '#fff', 'left', true, w - 150);
    if (s.tier) this.txt(TIER_NAMES[s.tier], x + w - 10, y + 24, 20, C_ACC, 'right');
    const bx = x + 106, bw = w - 118;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(bx, y + 44, bw, 22);
    ctx.fillStyle = hpf > 0.6 ? '#46e070' : hpf > 0.3 ? '#e8c440' : C_BAD; ctx.fillRect(bx, y + 44, bw * hpf, 22);
    this.txt(`${Math.round(e.hp)} / ${Math.round(e.maxHp)}`, bx + bw / 2, y + 56, 20, '#fff', 'center');
    if (e.kind === 'unit' && e.vet) this.txt('★'.repeat(e.vet), bx, y + 82, 20, '#ffd060', 'left');
    const lines = this.statLines(e, game, ui);
    lines.slice(0, 5).forEach((l, i) => this.txt(l[0], x + 12, y + 116 + i * 25, 21, l[1] || C_TEXT, 'left', false, w - 22));
  }
  statLines(e, game, ui) {
    const s = e.spec, L = [], lt = this.vr && this.vr.staff && this.vr.staff.ltLine(e);
    if (lt) L.push(lt);   // под управлением помощника (Штаб)
    if (e.kind === 'unit') {
      if (s.dps) L.push([`Урон/с ${Math.round(s.dps)} · дальн. ${s.maxRange}`]);
      L.push([`Скор. ${s.speed} · обзор ${s.vision}${s.bp ? ` · стройка ${s.bp}` : ''}`]);
      if (e.kills) L.push([`Убийств: ${e.kills}`]);
      if (e.pshield) L.push([`Щит ${Math.round(e.pshield.hp)}/${e.pshield.max}`, '#7fd8ff']);
      if (e.cargo) L.push([`Груз ${game.cargoUsed(e)}/${s.cargo} (${e.cargo.length} ед.)`]);
      if (e.enh) { const on = Object.values(e.enh).filter(Boolean).map(k => ENH[k].short); L.push([`Улучшения: ${on.length ? on.join(' ') : 'нет'}`]); }
      const o = e.orders[0];
      L.push([`Приказ: ${o ? (ORDER_NAME[o.type] || o.type) + (e.orders.length > 1 ? ` +${e.orders.length - 1}` : '') : 'нет'}`, C_DIM]);
    } else if (e.kind === 'struct') {
      if (!e.built) L.push([`Строится: ${Math.round(e.progress * 100)}%`, C_ACC]);
      if (s.mass) L.push([`Масса +${s.mass}/с`, C_MASS]);
      if (s.energy) L.push([`Энергия +${s.energy}/с`, C_ENERGY]);
      if (s.eUse) L.push([`Потребление −${s.eUse} Э/с`, C_EXP]);
      if (s.storeM) L.push([`Склад массы +${s.storeM}`, C_MASS]);
      if (s.storeE) L.push([`Склад энергии +${s.storeE}`, C_ENERGY]);
      if (s.dps) L.push([`Урон/с ${Math.round(s.dps)} · дальн. ${s.maxRange}`]);
      if (e.shield) L.push([`Щит ${Math.round(e.shield.hp)}/${e.shield.max}${e.shield.on ? '' : ' (откл.)'}`, '#7fd8ff']);
      if (s.radar) L.push([`Радар ${s.radar}${s.sonar ? ` · сонар ${s.sonar}` : ''}`]); else if (s.sonar) L.push([`Сонар ${s.sonar}`]);
      if (s.fabM) L.push([`Фабрикатор +${(s.fabM * (e.adj?.m || 1)).toFixed(1)} М/с за −${Math.round(s.fabE * (e.adj?.eCost || 1))} Э/с`, game.teams[e.team].eco.fabOn ? C_MASS : C_BAD]);
      if (e.upgrading) L.push([`Улучшение → ${STRUCTS[e.upgrading.to].name} ${Math.round(e.upgrading.prog * 100)}%`, C_ACC]);
      if (e.silo && e.built) L.push([`Ракеты ${e.silo.stock}/${s.silo.max}${e.silo.stock < s.silo.max ? ` · след. ${Math.round(e.silo.prog * 100)}%` : ''}`, '#ffd060']);
      if (s.produces) L.push([`Производство: ${e.queue.length ? (UNITS[e.queue[0]].short || UNITS[e.queue[0]].name) + ' ' + Math.round(e.prog * 100) + '%' : 'простаивает'}`]);
      if (e.adj && e.adj.n.length) L.push([`Соседство (${e.adj.n.length})`, C_MASS]);
    }
    return L;
  }

  // ---------------------------------------------------------------- commands / build / production
  drawCommands(ctx, game, ui) {
    const sel = ui.selection.filter(e => e.alive && (ui.mine(e) || !ui.team));
    const canCmd = ui.canCommand;
    const units = ui.commandUnits(), structs = sel.filter(e => e.kind === 'struct');
    const builders = units.filter(u => u.spec.canBuild);
    const facs = structs.filter(s => s.spec.produces && s.built);
    const sigKey = sel.map(e => e.id).join(',') + '|' + (ui.buildTier);
    if (sigKey !== this._pageSig) { this._pageSig = sigKey; this.page = 0; }

    // ---- order buttons: 5 per row, 2 rows
    const ords = [];
    if (canCmd) {
      if (units.length) {
        ords.push(['СТОП', () => game.orderStop(sel.filter(x => ui.mine(x))), true, 'Отменить все приказы']);
        ords.push(['АТАКА', () => ui.setMode('amove'), units.some(u => u.spec.weapons.length), 'Атака с ходу: двигаться, атакуя всё по пути']);
        ords.push(['ПАТРУЛЬ', () => ui.setMode('patrol'), true, 'Патрулировать между точками']);
        if (units.some(u => u.spec.bp)) ords.push(['ПЕРЕРАБ.', () => ui.setMode('reclaim'), true, 'Переработка: разобрать обломки, деревья, камни или любой юнит/здание']);
        if (units.some(u => u.spec.overcharge)) ords.push(['СВЕРХЗАР.', () => ui.setMode('oc'), true, 'Сверхзаряд ACU: мощный выстрел за 3000 энергии']);
        if (units.some(u => u.cargo && u.cargo.length)) ords.push(['ВЫСАДКА', () => ui.setMode('unload'), true, 'Транспорт садится в указанной точке и выгружает войска']);
      }
      const silos = structs.filter(s => s.silo && s.built && s.spec.silo.kind !== 'anti');
      if (silos.length) ords.push([`ПУСК ${silos.filter(s => s.silo.stock > 0).length}`, () => ui.startLaunch(), silos.some(s => s.silo.stock > 0), 'Пуск ракеты: затем наведите лазер на цель']);
      if (structs.some(s => s.built && s.spec.upgradesTo && !s.upgrading)) {
        const U = STRUCTS[structs.find(s => s.spec.upgradesTo && !s.upgrading).spec.upgradesTo];
        ords.push(['УЛУЧШИТЬ', () => ui.upgradeSelected(), true, `Улучшить → ${U.name} · М ${U.costM} Э ${U.costE}`]);
      }
      if (structs.length && structs.every(x => ui.mine(x))) ords.push(['★ В ПРЕСЕТ', () => ui.addPreset(structs), true, 'Запомнить расстановку выделенных зданий как пресет стройки (вкладка ★ у строителей). Опора — экстрактор, если он выделен.']);
      if (ui.mode === 'build' && ui.preset) { const p = ui.preset; ords.push(['УДАЛ. ПРЕСЕТ', () => ui.removePreset(p), true, `Удалить пресет «${p.name}»`]); }
      if (facs.length) { const f = facs[0]; ords.push(['ПОВТОР', () => { const v = !f.repeat; for (const x of facs) x.repeat = v; ui.refreshPanels(true); }, true, 'Зациклить очередь производства', !!f.repeat]); }
      const acu = game.teams[ui.team].acu;
      ords.push(['ACU', () => { if (acu && acu.alive) { ui.selection = [acu]; ui.refreshPanels(true); } }, !!(acu && acu.alive), 'Выбрать командира']);
      ords.push(['СВ.ИНЖ.', () => ui.selectIdleEngineer(), true, 'Выбрать свободного инженера']);
      if (ui.mode) ords.push(['ОТМЕНА', () => ui.setMode(null), true, 'Отменить текущий режим', true]);
    }
    const bw = 124, bh = 46;
    ords.slice(0, 10).forEach((o, i) => this.button('ord:' + o[0], RX + (i % 5) * (bw + 8), 88 + Math.floor(i / 5) * (bh + 6), bw, bh, o[0], () => { o[1](); ui.refreshPanels(true); }, o[2], { tip: o[3], on: o[4], size: 21 }));

    if (!canCmd) { this.txt('РЕЖИМ НАБЛЮДЕНИЯ', RX + RW / 2, 400, 30, C_DIM, 'center'); return; }

    // ---- list of cards
    let cards = [], tabsRow = null;
    const team = ui.team || 1;
    if (builders.length) {
      const maxTier = Math.max(...builders.map(u => u.spec.buildTier));
      const cmdr = builders.find(u => u.enh);
      const all = new Set(builders.flatMap(u => u.spec.canBuild));
      const has4 = Object.values(STRUCTS).some(S => S.tier >= 4 && all.has(S.key));
      const tier = ui.buildTier;
      tabsRow = 'build';
      this._tabs = { maxTier, has4, acu: !!cmdr };
      if (tier === 'preset') {
        for (const p of ui.presets) {
          const A = STRUCTS[p.items[0].key], sum = (f) => p.items.reduce((t, it) => t + STRUCTS[it.key][f], 0);
          const ok = p.items.some(it => all.has(it.key));
          cards.push({ id: 'p:' + ui.presets.indexOf(p) + p.name, spec: { ...A, short: p.name, costM: sum('costM'), costE: sum('costE'), bt: sum('bt'), tier: Math.max(...p.items.map(it => STRUCTS[it.key].tier)) },
            struct: true, locked: !ok, sel: ui.preset === p, mark: p.items.length + 'зд',
            tip: `Пресет «${p.name}»: ${p.items.length} зданий, опора — ${A.name}. Нажмите, затем триггером по месту опоры (можно по уже стоящему). Удалить — кнопка «УДАЛ. ПРЕСЕТ».${ok ? '' : ' Эти строители не умеют строить эти здания.'}`,
            action: () => ui.setMode('build', p.items[0].key, p) });
        }
      } else if (tier === 'enh' && cmdr) {
        for (const [k, E] of Object.entries(ENH)) {
          if (E.unit !== cmdr.key) continue;
          const inst = cmdr.enh[E.slot] === k, c = game.canEnhance(cmdr, k), o0 = cmdr.orders[0], busy = o0 && o0.type === 'enhance' && o0.key === k;
          cards.push({ id: 'enh:' + k, spec: { icon: 'plus', short: E.short, costM: E.costM, costE: E.costE, bt: E.bt, tier: cmdr.key === 'sacu' ? ({ rarm: 1, larm: 2, back: 3 })[E.slot] : E.slot === 'larm' ? (k === 'eng3' ? 3 : 2) : 1 }, struct: false, locked: !c.ok && !inst, mark: busy ? Math.round((cmdr.enhProg[k] || 0) * 100) + '%' : inst ? '✓' : '',
            tip: `${E.name}. М ${E.costM} · Э ${E.costE} · Время ${E.bt}. ${E.desc}${inst ? ' Установлено.' : !c.ok ? ' ' + c.why : ''}`, action: () => { game.orderEnhance([cmdr], k, !!(this.vr && this.vr.shift)); ui.audio && ui.audio.play('ui'); } });
        }
      } else {
        for (const k of Object.keys(STRUCTS)) {
          const S = STRUCTS[k];
          if (!all.has(k) || S.upgradeOnly || S.tier !== tier) continue;
          cards.push({ id: 'b:' + k, spec: S, struct: true, locked: false, sel: ui.mode === 'build' && ui.buildKey === k && !ui.preset,
            tip: `Строить: ${S.name}. М ${S.costM} · Э ${S.costE} · Время ${S.bt}. ${S.desc || ''}${S.mass ? ` +${S.mass} М/с.` : ''}${S.energy ? ` +${S.energy} Э/с.` : ''}`,
            action: () => ui.setMode('build', k) });
        }
      }
    } else if (facs.length) {
      const f = facs[0], type = f.spec.produces, same = facs.filter(x => x.spec.produces === type);
      tabsRow = 'queue';
      for (const k of PRODUCES[type]) {
        const U = UNITS[k], locked = U.tier > f.spec.tier, cnt = f.queue.filter(q => q === k).length;
        cards.push({ id: 'u:' + k, spec: U, struct: false, locked, mark: cnt ? '×' + cnt : '',
          tip: `${U.name} ${TIER_NAMES[U.tier]}. М ${U.costM} · Э ${U.costE} · Время ${U.bt}. ${U.desc || ''}${U.dps ? ` Урон/с ${Math.round(U.dps)}, дальн. ${U.maxRange}.` : ''}${locked ? ' Нужен завод ' + TIER_NAMES[U.tier] + '.' : ' Нажатие +1, ПКМ-очередь ниже: нажмите на значок, чтобы убрать.'}`,
          action: () => { for (const s of same) game.queueUnit(s, k, this.vr && this.vr.shift ? 5 : 1); ui.audio && ui.audio.play('ui'); } });
      }
    }

    // ---- third row: tier tabs (builders) / queue strip (factories) + paging
    const pages = Math.max(1, Math.ceil(cards.length / PER_PAGE));
    if (this.page >= pages) this.page = pages - 1;
    if (tabsRow === 'build') {
      const { maxTier, has4, acu: cmdr } = this._tabs, tw = 72;
      let tx = RX;
      for (let t = 1; t <= 4; t++) {
        const lock = t === 4 ? !has4 : t > maxTier;
        this.button('tab:' + t, tx, 194, tw, 50, TIER_NAMES[t], () => { ui.buildTier = t; this.page = 0; ui.refreshPanels(true); }, !lock, { on: ui.buildTier === t, size: 24 });
        tx += tw + 6;
      }
      this.button('tab:preset', tx, 194, 52, 50, '★', () => { ui.buildTier = 'preset'; this.page = 0; ui.refreshPanels(true); }, true, { on: ui.buildTier === 'preset', size: 26, tip: 'Пресеты стройки: сохранённые расстановки зданий' });
      tx += 58;
      if (cmdr) this.button('tab:enh', tx, 194, 96, 50, 'УЛУЧШ.', () => { ui.buildTier = 'enh'; this.page = 0; ui.refreshPanels(true); }, true, { on: ui.buildTier === 'enh', size: 21 });
    } else if (tabsRow === 'queue') {
      this.drawQueue(ctx, facs[0], facs.filter(x => x.spec.produces === facs[0].spec.produces), game, ui, team);
    }
    if (pages > 1) {
      const px = RX + RW - 170;
      this.button('pgprev', px, 194, 50, 50, '◀', () => { this.page = Math.max(0, this.page - 1); }, this.page > 0, { size: 24 });
      this.txt(`${this.page + 1}/${pages}`, px + 85, 219, 24, '#fff', 'center');
      this.button('pgnext', px + 120, 194, 50, 50, '▶', () => { this.page = Math.min(pages - 1, this.page + 1); }, this.page < pages - 1, { size: 24 });
    }

    if (!tabsRow) {
      const lines = this.wrap(sel.length ? 'У выбранного нет команд строительства или производства.' : 'Выберите ACU / инженера, чтобы строить, или завод, чтобы производить юнитов.', RW - 20, 24, 3);
      lines.forEach((l, i) => this.txt(l, RX + 10, 300 + i * 34, 24, C_DIM, 'left', false));
      return;
    }

    if (tabsRow === 'build' && ui.buildTier === 'preset' && !cards.length)
      this.wrap('Пресетов пока нет. Выделите свои здания (например, экстрактор и хранилища вокруг) и нажмите «★ В ПРЕСЕТ».', RW - 20, 24, 3).forEach((l, i) => this.txt(l, RX + 10, 300 + i * 34, 24, C_DIM, 'left', false));
    // ---- cards
    cards.slice(this.page * PER_PAGE, (this.page + 1) * PER_PAGE).forEach((c, i) => {
      const x = RX + (i % 4) * (CARD_W + 8), y = CARD_Y + Math.floor(i / 4) * (CARD_H + CARD_GAP);
      this.card(ctx, c, x, y, team);
    });
  }

  card(ctx, c, x, y, team) {
    const hov = !c.locked && this.isHover(c.id), s = c.spec;
    this.addButton(c.id, x, y, CARD_W, CARD_H, c.locked ? null : c.action, !c.locked, c.tip);
    this.rr(x, y, CARD_W, CARD_H, 7);
    ctx.fillStyle = hov ? 'rgba(95,208,255,.38)' : c.sel ? 'rgba(255,176,64,.3)' : c.locked ? 'rgba(22,28,34,.9)' : 'rgba(14,32,48,.92)'; ctx.fill();
    ctx.lineWidth = hov || c.sel ? 3 : 1.5; ctx.strokeStyle = hov ? '#fff' : c.sel ? '#ffb040' : c.locked ? '#3a444d' : 'rgba(95,208,255,.45)'; ctx.stroke();
    ctx.globalAlpha = c.locked ? 0.35 : 1;
    this.icon(ctx, s, team, x + (CARD_W - 64) / 2, y + 6, 64, c.struct);
    ctx.globalAlpha = 1;
    this.txt(s.short || s.name, x + CARD_W / 2, y + 82, 22, c.locked ? '#7b8791' : '#fff', 'center', true, CARD_W - 10);
    this.txt(String(s.costM), x + 8, y + 104, 21, c.locked ? '#5d7d68' : C_MASS, 'left');
    this.txt(fmt(s.costE), x + CARD_W - 8, y + 104, 21, c.locked ? '#8a7d45' : C_ENERGY, 'right');
    this.txt(`вр. ${s.bt}`, x + CARD_W / 2, y + 119, 17, C_DIM, 'center', false);
    if (s.tier) this.txt(TIER_NAMES[s.tier], x + 7, y + 14, 16, C_DIM, 'left');
    if (c.mark) this.txt(c.mark, x + CARD_W - 7, y + 16, 24, c.mark === '✓' ? C_MASS : '#fff', 'right');
  }

  drawQueue(ctx, f, same, game, ui, team) {
    const y = 194, h = 50;
    this.rr(RX, y, 440, h, 6); ctx.fillStyle = 'rgba(8,15,22,.85)'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(95,208,255,.3)'; ctx.stroke();
    if (!f.queue.length) { this.txt('Очередь пуста', RX + 14, y + 26, 22, C_DIM, 'left', false); return; }
    const groups = [];
    for (const k of f.queue) { const last = groups[groups.length - 1]; if (last && last.k === k) last.n++; else groups.push({ k, n: 1 }); }
    groups.slice(0, 8).forEach((q, i) => {
      const x = RX + 6 + i * 54, id = 'q:' + i + q.k;
      this.addButton(id, x, y + 3, 50, 44, () => { for (const s of same) game.dequeueUnit(s, q.k); ui.refreshPanels(true); }, true, `${UNITS[q.k].name} в очереди — нажмите, чтобы убрать один`);
      if (this.isHover(id)) { this.rr(x, y + 3, 50, 44, 4); ctx.fillStyle = 'rgba(255,74,58,.4)'; ctx.fill(); }
      this.icon(ctx, UNITS[q.k], team, x + 4, y + 3, 40, false);
      if (q.n > 1) this.txt(String(q.n), x + 48, y + 36, 20, '#fff', 'right');
      if (i === 0) { ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(x + 3, y + 42, 44, 5); ctx.fillStyle = C_ACC; ctx.fillRect(x + 3, y + 42, 44 * Math.max(0, Math.min(1, f.prog || 0)), 5); }
    });
  }

  // ---------------------------------------------------------------- control groups / formation
  drawGroupRow(ctx, ui) {
    if (!ui.canCommand || !this.vr) return;
    const vr = this.vr, sh = vr.shift, y = GRP_Y, h = GRP_H;
    for (let n = 1; n <= 5; n++) {
      const x = RX + (n - 1) * 68, cnt = (ui.groups[n] || []).filter(e => e.alive).length;
      this.button('grp:' + n, x, y, 62, h, String(n), () => vr.groupTap(n), sh || cnt > 0, { on: sh, size: 28, tip: `Группа ${n} (${cnt} ед.): нажатие - выбрать, дважды - стол к группе, с левым курком - назначить выделенное` });
      if (cnt) this.txt(String(cnt), x + 58, y + h - 10, 16, C_DIM, 'right');
    }
    const fm = FORMS.find(f => f[0] === ui.form.type) || FORMS[0], X = RX + 346;
    this.button('form', X, y, 160, h, 'Строй: ' + fm[1], () => { const i = FORMS.indexOf(fm); ui.setFormation(FORMS[(i + 1) % FORMS.length][0]); }, true, { size: 20, tip: 'Тип строя при движении (G). A зажать и вести лазер - повернуть строй по направлению' });
    this.button('fsp-', X + 166, y, 44, h, '−', () => ui.changeSpacing(-0.2), ui.form.spacing > 0.5, { size: 28, tip: 'Сомкнуть строй ([)' });
    this.txt('×' + ui.form.spacing, X + 232, y + h / 2 + 1, 22, '#fff', 'center');
    this.button('fsp+', X + 258, y, 44, h, '+', () => ui.changeSpacing(0.2), ui.form.spacing < 3, { size: 28, tip: 'Разомкнуть строй (])' });
  }

  // ---------------------------------------------------------------- view presets
  drawViewRow(ctx) {
    const vr = this.vr; if (!vr) return;
    const V = [['overview', 'ОБЗОР', 'Вид: вся карта перед собой, фокус на выделении (левый стик — нажатие)'],
      ['top', 'СВЕРХУ', 'Вид сверху: карта под головой, смотреть вниз'],
      ['side', 'СБОКУ', 'Вид сбоку: глаз над краем поля боя, взгляд через него'],
      ['ground', 'С ЗЕМЛИ', 'Вид с земли: юниты крупно, рядом с фокусом'],
      ['rot90', '↻90', 'Повернуть стол на 90° вокруг фокуса']];
    V.forEach((v, i) => this.button('view:' + v[0], 10 + i * 69, VIEW_Y, 64, VIEW_H, v[1], () => vr.viewPreset(v[0]), true, { size: v[0] === 'ground' || v[0] === 'overview' || v[0] === 'top' ? 16 : 20, tip: v[2], on: vr.viewName === v[0] }));
  }

  // ---------------------------------------------------------------- bottom row
  drawBottomRow(ctx, ui) {
    const by = 702, bh = 56;
    const tw = this.vr && this.vr.isTWA;
    this.button('exit', 10, by, 70, bh, 'ВЫХОД', () => this.hooks.exitVR(), true, { tip: tw ? 'В меню (игра остаётся запущенной)' : 'Выйти из VR', size: 20 });
    this.button('menu', 84, by, 70, bh, 'МЕНЮ', () => this.hooks.pauseMenu(), true, { tip: 'Меню паузы (Y)', size: 20 });
    this.button('table', 158, by, 70, bh, 'СТОЛ', () => { if (this.vr) this.vr.needPlace = true; }, true, { tip: 'Стол перед лицом (правый стик — нажатие)', size: 20 });
    this.button('pass', 232, by, 70, bh, this.vr && this.vr.passthrough ? 'ПАСС.' : 'НЕБО', () => this.hooks.togglePassthrough(), true, { tip: 'Переключить смешанную реальность (пасстру) / виртуальный мир', on: !!(this.vr && this.vr.passthrough), size: 20 });
    this.button('help', 306, by, 46, bh, '?', () => this.hooks.help && this.hooks.help(), true, { tip: 'Схема управления: контроллеры и жесты', size: 28 });

    const staffW = this.vr && this.vr.staff ? this.vr.staff.panelRow(this, by, bh) : 0;   // ШТАБ / → помощнику (js/vrstaff.js)
    let text = '', color = C_TEXT;
    if (this.msgText) { text = this.msgText; color = '#ff8a6a'; }
    else if (this.vr && this.vr.shift) { text = 'ОЧЕРЕДЬ: левый курок'; color = '#ffb040'; }
    else if (this.hoverBtn && this.hoverBtn.tip) text = this.hoverBtn.tip;
    else if (ui.mode === 'build' && this.vr && this.vr.ghostBonus) { text = this.vr.ghostBonus; color = '#9fffd0'; }
    else if (ui.mode) { text = `Режим: ${MODE_NAME[ui.mode] || ui.mode}${ui.mode === 'build' && ui.preset ? ' — пресет «' + ui.preset.name + '»' : ui.mode === 'build' && STRUCTS[ui.buildKey] ? ' — ' + STRUCTS[ui.buildKey].name : ''}. Триггер на карте — выполнить, «ОТМЕНА» — выйти.`; color = '#ffb040'; }
    else { text = 'Лазер правой руки: триггер — выбор/приказ, миникарта — перенос стола.'; color = C_DIM; }
    const lines = this.wrap(text, RW - 12 - staffW, 21, 3);
    lines.forEach((l, i) => this.txt(l, RX + 6, by + 10 + i * 22, 21, color, 'left', false));
  }

  dispose() {
    this.object3d.geometry.dispose();
    this.object3d.material.dispose();
    this.tex.dispose();
  }
}
