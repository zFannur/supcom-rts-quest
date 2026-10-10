// HUD, input & commands (SupCom-style), minimap, selection/build panels, AI thought window.
import { UNITS, STRUCTS, PRODUCES, TIER_NAMES, TEAM_CSS, DT, chainCost, ENH, ENH_SLOTS, fmtDist } from './specs.js';
import { STRATEGIES, INTENTS } from './ai.js';
import { MACROS } from './stratnet.js';
import { PN } from './terrain.js';
import { MAP_SIZE } from './maps.js';
import { thumbHTML } from './thumbs.js';
import { makePreset } from './sim.js';
import { StaffUI } from './staffui.js'; // lieutenants window (Штаб)

const $ = (id) => document.getElementById(id);
const fmt = (n) => n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n).toString();
const fmtT = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICON_GLYPH = { cmd: '★', eng: '⚒', bot: '◉', tank: '▣', arty: '▲', aa: '⌃', scout: '◇', fighter: '✈', bomber: '✹', gunship: '✚', transport: '⇪', frigate: '⛴', sub: '◒', destroyer: '⛴', cruiser: '⛴', battleship: '⛴', exp: '✦', mex: 'M', mfab: '♻', pgen: 'ϟ', store: '▤', fac_land: '⚙', fac_air: '✈', fac_naval: '⚓', pd: '⊕', aa_s: '⌃', torp: '≋', radar: '◎', shield: '◠', arty_s: '▲', nuke: '☢', antinuke: '⛨', tml: '⇈', tmd: '⌖', scmd: '☆' };
const ENH_GLYPH = { gun: '⌖', eng2: '⚒', eng3: '⚒', shield: '◠', regen: '✚', res: '♻', s_gun: '⌖', s_eng: '⚒', s_radar: '◉', s_res: '♻', s_shield: '◠', s_regen: '✚' };
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3, 4];
export const FORMS = [['line', 'Линия'], ['wedge', 'Клин'], ['column', 'Колонна'], ['box', 'Каре'], ['none', 'Без строя']];

export class GameUI {
  constructor(renderer, audio, settings, hooks) {
    this.r = renderer; this.audio = audio; renderer.audio = audio; this.settings = settings; this.hooks = hooks;
    this.game = null; this.ais = []; this.team = 1;
    this.selection = []; this.groups = {}; this.pings = []; this.drag = null;
    this.mode = null; this.buildKey = null; this.buildTier = 1;
    this.mouse = { x: 0, y: 0, in: false }; this.keys = {};
    this.hover = null; this._hvT = 0;   // entity under the cursor (its range rings are drawn by Renderer.ranges)
    this.lastClick = { t: 0, id: 0 }; this.lastGroupKey = { k: null, t: 0 };
    this.panelT = 0; this.aiT = 0; this.mmT = 0;
    this.aiTab = 'strategy'; this.aiTeamIdx = 0;
    this.speedIdx = 2; this.paused = false; this.simRate = 1;
    this.overlayOn = false;
    this.form = { type: 'line', spacing: 1 };
    try { Object.assign(this.form, JSON.parse(localStorage.getItem('supcom3d_form') || '{}')); } catch (e) { /* no storage */ }
    this.rdrag = null; this.formPreview = null;
    this.bind();
    this.staff = null; this.staffUI = new StaffUI(this); // lieutenants (js/lieutenant.js): roster, window, markers
  }
  saveForm() { try { localStorage.setItem('supcom3d_form', JSON.stringify(this.form)); } catch (e) { /* ignore */ } }
  // build presets (★ tab): [{ name, items: [{ key, dx, dy }] }], first item = anchor
  get presets() { if (!this._presets) { try { this._presets = JSON.parse(localStorage.getItem('supcom3d_presets') || '[]'); } catch (e) { this._presets = []; } } return this._presets; }
  savePresets() { try { localStorage.setItem('supcom3d_presets', JSON.stringify(this.presets)); } catch (e) { /* ignore */ } }
  addPreset(structs) { const p = makePreset(structs); this.presets.push(p); this.savePresets(); this.flash('Пресет сохранён: ' + p.name); this.audio.play('ui'); return p; }
  removePreset(p) { const i = this.presets.indexOf(p); if (i >= 0) { this.presets.splice(i, 1); this.savePresets(); } if (this.preset === p) this.setMode(null); this.refreshPanels(true); }
  formOpts(extra = {}) { return { type: this.form.type, spacing: this.form.spacing, ...extra }; }
  setFormation(type) { this.form.type = type; this.saveForm(); this.flash('Строй: ' + FORMS.find(f => f[0] === type)[1], true); this.refreshPanels(true); }
  changeSpacing(d) { this.form.spacing = Math.round(Math.max(0.5, Math.min(3, this.form.spacing + d)) * 10) / 10; this.saveForm(); this.flash(`Интервал строя: ×${this.form.spacing}`, true); this.refreshPanels(true); }

  setGame(game, ais, team, staff = null) {
    this.game = game; this.ais = ais; this.team = team;
    this.staff = staff; this.staffUI.setStaff(staff);
    this.selection = []; this.groups = {}; this.mode = null; this.buildKey = null; this.hover = null;
    this.speedIdx = SPEEDS.indexOf(this.settings.gameSpeed); if (this.speedIdx < 0) this.speedIdx = 2;
    this.paused = false; this.simRate = 1; this.notesShown = 0;
    this.aiTeamIdx = Math.max(0, ais.findIndex(a => a.team !== team));
    this.buildMinimapBase();
    const acu = team && game.teams[team].acu;
    if (acu) { this.selection = [acu]; this.r.centerOn(acu.x, acu.y, 150); this.r.view.x = acu.x; this.r.view.y = acu.y + 200; this.r.view.dist = 600; }
    else { this.r.centerOn(MAP_SIZE / 2, MAP_SIZE / 2, 2200); }
    $('ai-team-select').innerHTML = ais.map((a, i) => `<option value="${i}">${esc(a.name)} (команда ${a.team})</option>`).join('');
    $('ai-team-select').value = this.aiTeamIdx;
    $('notes').innerHTML = '';
    this.refreshPanels(true);
  }
  get speed() { return SPEEDS[this.speedIdx]; }
  get canCommand() { return this.team > 0; }
  mine(e) { return e && e.team === this.team; }

  // ---------------------------------------------------------------- input binding
  bind() {
    const ov = this.r.overlay;
    ov.addEventListener('contextmenu', e => e.preventDefault());
    ov.addEventListener('mousedown', e => this.onDown(e));
    window.addEventListener('mousemove', e => this.onMove(e));
    window.addEventListener('mouseup', e => this.onUp(e));
    ov.addEventListener('wheel', e => { e.preventDefault(); if (!this.game && !this.hooks.menuOpen()) return; this.r.zoomAt(e.offsetX, e.offsetY, Math.pow(1.0015, e.deltaY * (this.settings.zoomSpeed || 1))); }, { passive: false });
    document.documentElement.addEventListener('mouseleave', () => { this.mouse.in = false; });
    window.addEventListener('keydown', e => this.onKey(e, true));
    window.addEventListener('keyup', e => this.onKey(e, false));
    window.addEventListener('blur', () => { this.keys = {}; });
    const mm = $('minimap');
    const mmMove = (e) => { const r = mm.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width * MAP_SIZE, y = (e.clientY - r.top) / r.height * MAP_SIZE; return { x, y }; };
    mm.addEventListener('mousedown', e => {
      if (!this.game) return;
      const p = mmMove(e);
      if (e.button === 2) { this.commandAt(p, null, e.shiftKey); return; }
      this.mmDrag = true; this.r.centerOn(p.x, p.y);
    });
    mm.addEventListener('mousemove', e => { if (this.mmDrag) { const p = mmMove(e); this.r.centerOn(p.x, p.y); } });
    window.addEventListener('mouseup', () => { this.mmDrag = false; });
    mm.addEventListener('contextmenu', e => e.preventDefault());
    // HUD buttons
    $('btn-ai').onclick = () => this.toggleAI();
    $('ai-close').onclick = () => this.toggleAI(false);
    $('btn-overlay').onclick = () => this.toggleOverlay();
    $('btn-thoughts').onclick = () => this.toggleThoughts();
    $('btn-menu').onclick = () => this.hooks.pauseMenu();
    $('btn-pause').onclick = () => this.togglePause();
    $('btn-slower').onclick = () => this.changeSpeed(-1);
    $('btn-faster').onclick = () => this.changeSpeed(1);
    $('ai-team-select').onchange = (e) => { this.aiTeamIdx = +e.target.value; this.aiT = 0; };
    for (const b of document.querySelectorAll('.ai-tab')) b.onclick = () => { this.aiTab = b.dataset.tab; for (const x of document.querySelectorAll('.ai-tab')) x.classList.toggle('active', x === b); this.aiT = 0; this.renderAI(true); };
    this.makeDraggable($('ai-window'), $('ai-head'));
    // tooltips
    document.addEventListener('mouseover', e => { const t = e.target.closest('[data-tip]'); if (t) this.showTip(t.dataset.tip, e); });
    document.addEventListener('mousemove', e => { if (this.tipOn) this.moveTip(e); });
    document.addEventListener('mouseout', e => { if (e.target.closest('[data-tip]')) this.hideTip(); });
  }

  makeDraggable(win, handle) {
    let d = null;
    handle.addEventListener('mousedown', e => { if (e.target.closest('button,select')) return; d = { x: e.clientX - win.offsetLeft, y: e.clientY - win.offsetTop }; e.preventDefault(); });
    window.addEventListener('mousemove', e => { if (!d) return; win.style.left = Math.max(0, e.clientX - d.x) + 'px'; win.style.top = Math.max(0, e.clientY - d.y) + 'px'; win.style.right = 'auto'; });
    window.addEventListener('mouseup', () => { d = null; });
  }

  showTip(html, e) { const t = $('tooltip'); t.innerHTML = html; t.classList.remove('hidden'); this.tipOn = true; this.moveTip(e); }
  moveTip(e) { const t = $('tooltip'); const w = t.offsetWidth, h = t.offsetHeight; t.style.left = Math.min(window.innerWidth - w - 8, e.clientX + 14) + 'px'; t.style.top = Math.max(8, e.clientY - h - 12) + 'px'; }
  hideTip() { $('tooltip').classList.add('hidden'); this.tipOn = false; }

  // ---------------------------------------------------------------- picking
  pickEntity(sx, sy, filter) {
    const g = this.game; if (!g) return null;
    let best = null, bd = 1e9;
    const r = this.r, icon = r.iconMode;
    // units & structures: the renderer's on-screen list (frustum-culled, positions valid whether or not a 3D view exists)
    for (let k = 0; k < r.dlN; k++) {
      const e = r.dl[k];
      if (!e.alive || (filter && !filter(e))) continue;
      const o = k * 3, X = r.dlPos[o], Y = r.dlPos[o + 1], Z = r.dlPos[o + 2], hy = Y + (r.metaHeight(e) || 2) * 0.5;
      if (!r.projTo(X, hy, Z)) continue;
      const px = r.sx, py = r.sy;
      if (Math.abs(px - sx) > 80 || Math.abs(py - sy) > 80) continue;
      const rad = e.kind === 'struct' ? e.spec.size * 0.55 : Math.max(e.spec.radius * 1.4, 1.5);
      r.projTo(X + rad, hy, Z);
      const pr = Math.max(icon ? 9 : 7, Math.hypot(r.sx - px, r.sy - py));
      const d = Math.hypot(px - sx, py - sy);
      if (d < pr && d < bd) { bd = d; best = e; }
    }
    // wrecks: only the ones that are drawn
    if (!icon) for (const e of g.wrecks) {
      if (!e.alive || (filter && !filter(e))) continue;
      const v = r.views.get(e.id); if (!v || !v.root.visible) continue;
      const p = r.project(v.root.position.x, v.root.position.z, v.root.position.y + (v.meta.height || 2) * 0.5);
      if (!p.ok) continue;
      const q = r.project(v.root.position.x + Math.max(e.spec.radius * 1.4, 2), v.root.position.z, v.root.position.y + (v.meta.height || 2) * 0.5);
      const pr = Math.max(7, Math.hypot(q.x - p.x, q.y - p.y));
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < pr && d + 4 < bd) { bd = d + 4; best = e; }
    }
    return best;
  }
  // Visible unit/structure under the cursor (no wrecks); null while dragging, over UI or in placement / launch modes.
  pickHover() {
    const g = this.game, lt = this.team;
    if (!g || !this.mouse.in || this.mouse.overUI || this.drag || this.rdrag || this.mid || this.mode === 'build' || this.mode === 'launch') return null;
    return this.pickEntity(this.mouse.x, this.mouse.y, e => e.kind !== 'wreck' && (!lt || e.team === lt || g.seenBy(lt, e)));
  }
  pickFeature(p) {
    const list = this.game.terrain.featuresNear(p.x, p.y, 4);
    return list.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0] || null;
  }

  // ---------------------------------------------------------------- mouse
  onDown(e) {
    this.audio.init();
    if (!this.game) return;
    const sx = e.offsetX, sy = e.offsetY;
    if (e.button === 1) { this.mid = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    if (e.button === 2) {
      if (this.mode) { this.setMode(null); return; }
      const p = this.r.screenToGround(sx, sy); if (!p) return;
      // right-drag = formation move facing the drag direction; plain right-click = context command (on mouse up)
      this.rdrag = { sx, sy, p, ent: this.pickEntity(sx, sy), shift: e.shiftKey };
      return;
    }
    if (e.button !== 0) return;
    if (this.mode && this.canCommand) {
      const p = this.r.screenToGround(sx, sy); if (!p) return;
      this.modeClick(p, this.pickEntity(sx, sy), e.shiftKey);
      return;
    }
    this.drag = { x0: sx, y0: sy, x1: sx, y1: sy, shift: e.shiftKey, ctrl: e.ctrlKey };
  }
  onMove(e) {
    const rect = this.r.overlay.getBoundingClientRect();
    this.mouse.x = e.clientX - rect.left; this.mouse.y = e.clientY - rect.top; this.mouse.in = true;
    this.mouse.overUI = e.target !== this.r.overlay;
    if (this.mid) { const k = this.r.view.dist / 700; this.r.pan(-(e.clientX - this.mid.x) * k, -(e.clientY - this.mid.y) * k); this.mid = { x: e.clientX, y: e.clientY }; }
    if (this.drag) { this.drag.x1 = this.mouse.x; this.drag.y1 = this.mouse.y; }
    if (this.mode === 'reclaim' && !this.mouse.overUI) this.reclaimCursor();
    if (this.rdrag) {
      const r = this.rdrag;
      if (Math.hypot(this.mouse.x - r.sx, this.mouse.y - r.sy) > 12) {
        const q = this.r.screenToGround(this.mouse.x, this.mouse.y);
        const units = this.commandUnits();
        if (q && units.length) {
          r.facing = Math.atan2(q.y - r.p.y, q.x - r.p.x);
          const f = this.game.formation(units, r.p.x, r.p.y, this.formOpts({ facing: r.facing, queue: r.shift }));
          this.formPreview = { x: r.p.x, y: r.p.y, facing: r.facing, pts: [...f.values()] };
        }
      } else { r.facing = undefined; this.formPreview = null; }
    }
  }
  // Reclaim mode: 'copy' over something that can be reclaimed, 'not-allowed' over a commander, crosshair elsewhere (throttled).
  reclaimCursor() {
    const now = performance.now();
    if (now - (this._rcT || 0) < 90) return;
    this._rcT = now;
    const ent = this.pickEntity(this.mouse.x, this.mouse.y);
    let cur = 'crosshair';
    if (ent && ent.kind !== 'wreck') cur = this.game.canReclaim(ent).ok ? 'copy' : 'not-allowed';
    else if (ent) cur = 'copy';
    else { const q = this.r.screenToGround(this.mouse.x, this.mouse.y); if (q && this.pickFeature(q)) cur = 'copy'; }
    this.r.overlay.style.cursor = cur;
  }
  commandUnits() { return this.selection.filter(u => u.alive && u.kind === 'unit' && !u.carried && this.mine(u)); }
  onUp(e) {
    if (e.button === 1) this.mid = null;
    if (e.button === 2 && this.rdrag) {
      const r = this.rdrag; this.rdrag = null; this.formPreview = null;
      if (!this.game) return;
      if (r.facing !== undefined) {
        const units = this.commandUnits();
        if (units.length) { this.game.orderMove(units, r.p.x, r.p.y, r.shift, 'move', this.formOpts({ facing: r.facing })); this.ping(r.p, '#5dff8a'); this.audio.play('ui'); }
      } else this.commandAt(r.p, r.ent, r.shift);
      return;
    }
    if (e.button !== 0 || !this.drag) return;
    const d = this.drag; this.drag = null;
    if (!this.game) return;
    const small = Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 6;
    let picked = [];
    if (small) {
      const ent = this.pickEntity(d.x0, d.y0, e2 => e2.kind !== 'wreck');
      if (ent) {
        const now = performance.now();
        if (now - this.lastClick.t < 320 && this.lastClick.id === ent.id) {
          picked = this.onScreen().filter(o => o.team === ent.team && o.key === ent.key);
        } else picked = [ent];
        this.lastClick = { t: now, id: ent.id };
      }
    } else {
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      const inBox = this.onScreen().filter(o => o._sx >= x0 && o._sx <= x1 && o._sy >= y0 && o._sy <= y1 && (!this.team || o.team === this.team));
      const units = inBox.filter(o => o.kind === 'unit');
      picked = units.length ? units : inBox;
    }
    if (d.shift) {
      const set = new Set(this.selection);
      for (const p of picked) { if (set.has(p) && small) set.delete(p); else set.add(p); }
      this.selection = [...set];
    } else this.selection = picked;
    if (this.selection.length) this.audio.play('ui');
    this.refreshPanels(true);
  }
  onScreen() {
    const r = this.r, out = [], W = r.overlay.width, H = r.overlay.height;
    for (let k = 0; k < r.dlN; k++) {
      const e = r.dl[k];
      if (!e.alive) continue;
      const o = k * 3;
      if (!r.projTo(r.dlPos[o], r.dlPos[o + 1] + 1, r.dlPos[o + 2])) continue;
      if (r.sx < 0 || r.sy < 0 || r.sx > W || r.sy > H) continue;
      e._sx = r.sx; e._sy = r.sy; out.push(e);
    }
    return out;
  }

  ping(p, color) { this.pings.push({ x: p.x, y: p.y, t: performance.now(), color }); if (this.pings.length > 20) this.pings.shift(); }

  // Right-click context command.
  commandAt(p, ent, queue) {
    const g = this.game;
    if (!this.canCommand) return;
    const units = this.commandUnits();
    const facs = this.selection.filter(s => s.alive && s.kind === 'struct' && this.mine(s) && s.spec.produces);
    if (!units.length) {
      if (facs.length) { for (const f of facs) f.rally = { x: p.x, y: p.y }; this.ping(p, '#5fd0ff'); this.audio.play('ui'); }
      return;
    }
    const engs = units.filter(u => u.spec.bp);
    const fighters = units.filter(u => u.spec.weapons.length);
    const trans = units.filter(u => u.cargo);
    const form = this.formOpts();
    // transports: own ground unit under cursor -> pick it up; own transport under cursor -> selected ground units board it
    if (ent && ent.team === this.team && ent.kind === 'unit' && !units.includes(ent)) {
      if (ent.cargo) {
        const riders = units.filter(u => !u.cargo && u.spec.slots <= ent.spec.cargo);
        if (riders.length) { g.orderBoard(riders, ent, queue); this.ping(p, '#5dffb0'); this.audio.play('ui'); if (riders.length < units.length) this.flash('Часть юнитов не помещается в транспорт', true); return; }
      } else if (trans.length && ent.spec.slots < 99 && trans.length === units.length) {
        g.orderPickup(trans, ent, queue); this.ping(p, '#5dffb0'); this.audio.play('ui'); return;
      }
    }
    if (ent && ent.kind !== 'wreck' && g.isEnemy(ent.team, this.team)) {
      if (fighters.length) g.orderAttack(fighters, ent, queue);
      // engineers have no guns: right-click on an enemy unit / structure reclaims it (SupCom)
      const recl = units.filter(u => u.spec.bp && !u.spec.weapons.length);
      const canRec = recl.length && g.canReclaim(ent).ok;
      if (canRec) g.orderReclaim(recl, ent, queue);
      const rest = units.filter(u => !u.spec.weapons.length && !(canRec && u.spec.bp));
      if (rest.length) g.orderMove(rest, p.x, p.y, queue, 'move', form);
      this.ping(p, canRec && !fighters.length ? '#ffb040' : '#ff4a3a');
    } else if (ent && ent.kind === 'wreck' && engs.length) {
      g.orderReclaim(engs, ent, queue); this.ping(p, '#ffb040');
      const rest = units.filter(u => !u.spec.bp); if (rest.length) g.orderMove(rest, p.x, p.y, queue, 'move', form);
    } else if (ent && ent.team === this.team && !units.includes(ent)) {
      if (engs.length) {
        if (ent.kind === 'struct' && !ent.built) g.orderAssist(engs, ent, queue);
        else if (ent.hp < ent.maxHp) g.orderRepair(engs, ent, queue);
        else if (ent.kind === 'struct' && (ent.spec.produces || ent.upgrading)) g.orderAssist(engs, ent, queue);
        else g.orderGuard(engs, ent, queue);
      }
      const rest = units.filter(u => !u.spec.bp);
      if (rest.length) g.orderGuard(rest, ent, queue);
      this.ping(p, '#5dffb0');
    } else {
      const f = engs.length && !ent ? this.pickFeature(p) : null;
      if (f && engs.length === units.length) { g.orderReclaim(engs, f, queue); this.ping(p, '#ffb040'); }
      else { g.orderMove(units, p.x, p.y, queue, 'move', form); this.ping(p, '#5dff8a'); }
    }
    this.audio.play('ui');
  }

  modeClick(p, ent, shift) {
    const g = this.game;
    const units = this.selection.filter(u => u.alive && u.kind === 'unit' && this.mine(u));
    switch (this.mode) {
      case 'build': {
        const builders = units.filter(u => u.spec.canBuild && (this.preset || u.spec.canBuild.includes(this.buildKey)));
        const res = this.preset ? g.orderPreset(builders, this.preset, p.x, p.y, shift) : g.orderBuild(builders, this.buildKey, p.x, p.y, shift);
        if (!res.ok) { this.flash(res.why); return; }
        this.ping(res, '#ffe060');
        this.audio.play('ui');
        if (!shift) this.setMode(null);
        return;
      }
      case 'amove': g.orderAMove(units, p.x, p.y, shift, this.formOpts()); this.ping(p, '#ff9a3c'); break;
      case 'unload': {
        const tr = units.filter(u => u.cargo && u.cargo.length);
        if (!tr.length) { this.flash('Транспорты пусты'); break; }
        g.orderUnload(tr, p.x, p.y, shift); this.ping(p, '#5dffb0');
        break;
      }
      case 'patrol': g.orderPatrol(units, p.x, p.y, shift); this.ping(p, '#5fd0ff'); break;
      case 'reclaim': {
        const engs = units.filter(u => u.spec.bp);
        // any unit / structure (own or hostile) under the cursor, otherwise wrecks, trees and rocks
        if (ent && ent.kind !== 'wreck') {
          const c = g.canReclaim(ent);
          if (!c.ok) { this.flash(c.why); return; }
          if (!engs.some(u => u !== ent)) { this.flash('Инженер не может перерабатывать сам себя'); return; }
          g.orderReclaim(engs, ent, shift); this.ping(p, '#ffb040');
          break;
        }
        const t = ent && ent.kind === 'wreck' ? ent : this.pickFeature(p);
        const tt = t || g.wrecks.filter(w => Math.hypot(w.x - p.x, w.y - p.y) < 20).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
        if (tt) { g.orderReclaim(engs, tt, shift); this.ping(p, '#ffb040'); } else this.flash('Здесь нечего перерабатывать');
        break;
      }
      case 'launch': {
        const silos = this.launchSilos().filter(s => s.silo.stock > 0);
        if (!silos.length) { this.flash('Нет готовых ракет'); return; }
        const tgt = ent && ent.kind !== 'wreck' && g.isEnemy(ent.team, this.team) ? ent : null;
        const res = g.orderLaunch(silos, tgt ? tgt.x : p.x, tgt ? tgt.y : p.y, tgt);
        if (!res.n) { this.flash(res.why); return; }
        this.ping(p, '#ff6a3c'); this.audio.play('alert');
        this.refreshPanels(true);
        if (!shift) this.setMode(null);
        return;
      }
      case 'oc': {
        const acu = units.find(u => u.spec.overcharge);
        const t = ent && g.isEnemy(ent.team, this.team) && ent.kind !== 'wreck' ? ent : { x: p.x, y: p.y };
        if (!acu || !g.overcharge(acu, t)) this.flash('Сверхзаряд недоступен (дальность 44, нужна энергия 3000)');
        else this.ping(p, '#ffee88');
        break;
      }
    }
    this.audio.play('ui');
    if (!shift) this.setMode(null);
  }

  setMode(m, key, preset = null) {
    this.mode = m; this.buildKey = key || null; this.preset = preset;
    this.r.overlay.style.cursor = m ? 'crosshair' : 'default';
    if (m !== 'build') this.r.setGhost(null);
    if (m !== 'launch') this.r.setAim(null);
    $('mode-hint').textContent = preset ? `Пресет «${preset.name}» — ЛКМ по месту опоры (${STRUCTS[key].short}; можно по уже стоящему), Shift — несколько, ПКМ — отмена`
      : m === 'build' ? `Строительство: ${STRUCTS[key].name} — ЛКМ поставить, Shift — несколько, ПКМ — отмена`
      : m === 'amove' ? 'Атака с ходу: ЛКМ по точке (юниты атакуют всё по пути)' : m === 'patrol' ? 'Патруль: ЛКМ — точка маршрута' : m === 'reclaim' ? 'Переработка: ЛКМ по юниту/зданию (своему или вражескому), обломкам, деревьям, камням' : m === 'oc' ? 'Сверхзаряд ACU: ЛКМ по цели' : m === 'unload' ? 'Высадка: ЛКМ по суше — транспорты сядут и выгрузят войска' : m === 'launch' ? this.launchHint() : '';
    $('mode-hint').classList.toggle('hidden', !m);
  }
  // Silos of the selection that can fire on command (SML any range, TML within range).
  launchSilos() { return this.selection.filter(s => s.alive && s.kind === 'struct' && this.mine(s) && s.built && s.silo && s.spec.silo.kind !== 'anti'); }
  launchHint() {
    const list = this.launchSilos(), ready = list.filter(s => s.silo.stock > 0);
    const nuke = list.some(s => s.spec.silo.kind === 'nuke');
    return `☢ ПУСК: ${ready.length} из ${list.length} готово — ЛКМ по цели ${nuke ? `(любая дальность, зона поражения до ${fmtDist(this.nukeSpec().zones[2])}, задевает и своих)` : '(дальность 256)'}, Shift — несколько, ПКМ/Esc — отмена`;
  }
  // silo-спека ядерной шахты (зоны поражения берутся отсюда)
  nukeSpec() { return STRUCTS.sml.silo; }
  // N: fire control. With a silo selected -> aiming mode; otherwise pick our fullest strategic silo first.
  startLaunch() {
    if (!this.launchSilos().length) {
      const mine = this.game.structs.filter(s => s.alive && s.team === this.team && s.built && s.silo && s.spec.silo.kind === 'nuke');
      const best = mine.sort((a, b) => b.silo.stock - a.silo.stock)[0];
      if (!best) { this.flash('Нет ракетных шахт'); return; }
      this.selection = [best]; this.r.centerOn(best.x, best.y); this.refreshPanels(true);
    }
    if (!this.launchSilos().some(s => s.silo.stock > 0)) { this.flash('Нет готовых ракет — шахта ещё строит'); return; }
    this.setMode('launch');
  }
  flash(text, quiet, ms = 1800) { if (this.flashHook) this.flashHook(text, ms); const el = $('flash'); el.textContent = text; el.classList.remove('hidden'); clearTimeout(this._fl); this._fl = setTimeout(() => el.classList.add('hidden'), ms); if (!quiet) this.audio.play('alert'); }

  // ---------------------------------------------------------------- keyboard
  onKey(e, down) {
    const k = e.key.toLowerCase();
    if (down && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    this.keys[e.code] = down;
    if (e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault();   // Alt = range rings of the selection (no browser menu focus)
    if (!down) return;
    this.audio.init();
    if (e.code === 'Escape') { if (this.mode) this.setMode(null); else if (this.selection.length) { this.selection = []; this.refreshPanels(true); } else this.hooks.pauseMenu(); return; }
    if (e.code === 'F10') { e.preventDefault(); this.hooks.pauseMenu(); return; }
    if (!this.game) return;
    if (e.code === 'F1') { e.preventDefault(); this.toggleAI(); return; }
    if (e.code === 'F2') { e.preventDefault(); this.toggleOverlay(); return; }
    if (e.code === 'F3') { e.preventDefault(); this.toggleThoughts(); return; }
    if (this.staffUI.onKey(e)) return; // H — Штаб, Ctrl+H — передать выделенное помощнику
    if (e.code === 'F5') { e.preventDefault(); this.hooks.quickSave?.(); return; }
    if (e.code === 'F9') { e.preventDefault(); this.hooks.quickLoad?.(); return; }
    if (e.code === 'BracketLeft') { this.changeSpacing(-0.2); return; }
    if (e.code === 'BracketRight') { this.changeSpacing(0.2); return; }
    if (e.code === 'KeyG') { const i = FORMS.findIndex(f => f[0] === this.form.type); this.setFormation(FORMS[(i + 1) % FORMS.length][0]); return; }
    if (e.code === 'Pause' || (e.code === 'KeyP' && e.ctrlKey)) { e.preventDefault(); this.togglePause(); return; }
    if (e.code === 'NumpadAdd' || e.key === '+' || e.key === '=') { this.changeSpeed(1); return; }
    if (e.code === 'NumpadSubtract' || e.key === '-') { this.changeSpeed(-1); return; }
    if (/^Digit[0-9]$/.test(e.code)) {
      const n = e.code.slice(5);
      if (e.ctrlKey) { e.preventDefault(); this.groups[n] = this.selection.filter(x => this.mine(x)); this.flash(`Группа ${n}: ${this.groups[n].length} ед.`); return; }
      const grp = (this.groups[n] || []).filter(x => x.alive);
      if (!grp.length) return;
      const now = performance.now();
      if (this.lastGroupKey.k === n && now - this.lastGroupKey.t < 350) { const c = this.centroid(grp); this.r.centerOn(c.x, c.y); }
      this.lastGroupKey = { k: n, t: now };
      this.selection = e.shiftKey ? [...new Set([...this.selection, ...grp])] : grp;
      this.refreshPanels(true); return;
    }
    if (e.code === 'Space' || e.code === 'Home') {
      e.preventDefault();
      if (e.code === 'Home' || !this.selection.length) { const acu = this.team && this.game.teams[this.team].acu; if (acu && acu.alive) { this.selection = [acu]; this.r.centerOn(acu.x, acu.y); this.refreshPanels(true); } }
      else { const c = this.centroid(this.selection); this.r.centerOn(c.x, c.y); }
      return;
    }
    if (!this.canCommand) return;
    const units = this.commandUnits();
    switch (e.code) {
      case 'KeyT': if (units.some(u => u.cargo && u.cargo.length)) this.setMode('unload'); break;
      case 'KeyS': this.game.orderStop(this.selection.filter(x => this.mine(x))); this.setMode(null); break;
      case 'KeyA': if (units.some(u => u.spec.weapons.length)) this.setMode('amove'); break;
      case 'KeyP': if (units.length) this.setMode('patrol'); break;
      case 'KeyR': if (units.some(u => u.spec.bp)) this.setMode('reclaim'); break;
      case 'KeyO': if (units.some(u => u.spec.overcharge)) this.setMode('oc'); break;
      case 'KeyU': this.upgradeSelected(); break;
      case 'KeyN': this.startLaunch(); break;
      case 'KeyE': this.selectIdleEngineer(); break;
      case 'KeyF': { const acu = this.game.teams[this.team].acu; if (acu && acu.alive) { this.selection = [acu]; this.refreshPanels(true); } break; }
    }
  }
  centroid(list) { let x = 0, y = 0; for (const e of list) { x += e.x; y += e.y; } return { x: x / list.length, y: y / list.length }; }
  selectIdleEngineer() {
    const idle = this.game.units.filter(u => u.team === this.team && u.spec.role === 'eng' && (!u.orders.length || u.orders[0].auto));
    if (!idle.length) { this.flash('Нет свободных инженеров'); return; }
    this._ie = ((this._ie || 0) + 1) % idle.length;
    const u = idle[this._ie]; this.selection = [u]; this.r.centerOn(u.x, u.y); this.refreshPanels(true);
  }
  upgradeSelected() {
    let n = 0;
    for (const s of this.selection) if (s.kind === 'struct' && this.mine(s) && this.game.upgrade(s)) n++;
    if (n) { this.audio.play('ui'); this.refreshPanels(true); }
  }
  togglePause() { this.paused = !this.paused; $('btn-pause').textContent = this.paused ? '▶' : '❚❚'; $('paused-banner').classList.toggle('hidden', !this.paused); }
  changeSpeed(d) { this.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, this.speedIdx + d)); $('speed-val').textContent = '×' + this.speed; }
  toggleAI(v) { const w = $('ai-window'); w.classList.toggle('hidden', v === undefined ? !w.classList.contains('hidden') : !v); this.aiT = 0; }
  toggleOverlay() { this.overlayOn = !this.overlayOn; $('btn-overlay').classList.toggle('on', this.overlayOn); if (!this.overlayOn) this.r.setOverlay(null); }
  toggleThoughts() { this.settings.unitThoughts = !this.settings.unitThoughts; $('btn-thoughts').classList.toggle('on', this.settings.unitThoughts); }

  // ---------------------------------------------------------------- per-frame update
  update(dt) {
    const g = this.game; if (!g) return;
    // camera pan (arrows + edge scroll)
    const sp = (this.settings.panSpeed || 1) * this.r.view.dist * 1.1 * dt;
    let dx = 0, dy = 0;
    if (this.keys.ArrowLeft) dx -= 1; if (this.keys.ArrowRight) dx += 1; if (this.keys.ArrowUp) dy -= 1; if (this.keys.ArrowDown) dy += 1;
    if (this.settings.edgeScroll && this.mouse.in && !this.drag && document.hasFocus()) {
      const W = this.r.overlay.width, H = this.r.overlay.height, m = 6;
      if (this.mouse.x < m) dx -= 1; if (this.mouse.x > W - m) dx += 1; if (this.mouse.y < m) dy -= 1; if (this.mouse.y > H - m) dy += 1;
    }
    if (dx || dy) this.r.pan(dx * sp, dy * sp);
    this.selection = this.selection.filter(e => e.alive && !e.carried && (!this.team || e.team === this.team || g.visibleTo(this.team, e)));
    // hover: entity under the cursor for the range rings (pick throttled to ~12 Hz)
    const nowMs = performance.now();
    if (nowMs - this._hvT > 80) { this._hvT = nowMs; this.hover = this.pickHover(); }
    // fire control: blast zone under the cursor
    if (this.mode === 'launch' && this.mouse.in && !this.mouse.overUI) {
      const p = this.r.screenToGround(this.mouse.x, this.mouse.y), nuke = this.launchSilos().some(s => s.spec.silo.kind === 'nuke');
      if (p) this.r.setAim(p.x, p.y, nuke ? this.nukeSpec() : null);
    } else if (this.mode === 'launch') this.r.setAim(null);
    // build ghost
    if (this.mode === 'build' && this.mouse.in && !this.mouse.overUI) {
      const p = this.r.screenToGround(this.mouse.x, this.mouse.y);
      if (p) {
        const c = g.canPlace(this.team, this.buildKey, p.x, p.y);
        const x = c.x ?? p.x, y = c.y ?? p.y;
        const S = STRUCTS[this.buildKey];
        this.r.setGhost(this.buildKey, x, y, c.ok, this.team, S.place === 'water' ? g.terrain.water : g.terrain.heightAt(x, y));
        $('mode-hint').dataset.why = c.ok ? '' : c.why;
        let txt = c.ok ? '' : c.why;
        if (c.ok) {
          const a = g.previewAdjacency(this.team, this.buildKey, x, y), parts = [];
          if (a.m) parts.push(`+${Math.round(a.m * 100)}% массы`);
          if (a.e) parts.push(`+${Math.round(a.e * 100)}% энергии`);
          if (a.eCost) parts.push(`−${Math.round(Math.min(0.6, a.eCost) * 100)}% расхода энергии`);
          if (a.mCost) parts.push(`−${Math.round(Math.min(0.4, a.mCost) * 100)}% расхода массы`);
          if (a.give) parts.push(`усиливает соседей: ${a.give}`);
          if (parts.length) txt = '⬡ Соседство: ' + parts.join(', ');
        }
        $('ghost-why').textContent = txt; $('ghost-why').classList.toggle('good', c.ok);
        $('ghost-why').style.left = (this.mouse.x + 16) + 'px'; $('ghost-why').style.top = (this.mouse.y + 18) + 'px';
      }
    } else $('ghost-why').textContent = '';
    this.panelT -= dt; this.aiT -= dt; this.mmT -= dt;
    if (this.panelT <= 0) { this.panelT = 0.12; this.refreshPanels(false); this.updateTop(); this.updateNotes(); }
    if (this.mmT <= 0) { this.mmT = 0.1; this.drawMinimap(); }
    this.staffUI.update(dt);
    if (this.aiT <= 0) { this.aiT = 0.4; this.renderAI(false); if (this.overlayOn) this.r.setOverlay(this.ais[this.aiTeamIdx]); }
  }

  // ---------------------------------------------------------------- top bar & notes
  updateTop() {
    const g = this.game, T = g.teams[this.team || 1], eco = T.eco;
    const put = (id, v) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };
    put('mass-val', `${fmt(eco.mass)} / ${fmt(eco.maxMass)}`);
    put('energy-val', `${fmt(eco.energy)} / ${fmt(eco.maxEnergy)}`);
    put('mass-inc', `+${eco.incM.toFixed(1)}`); put('mass-exp', `-${eco.spendM.toFixed(1)}`);
    put('energy-inc', `+${eco.incE.toFixed(0)}`); put('energy-exp', `-${(eco.spendE + eco.upkeep).toFixed(0)}`);
    $('mass-fill').style.width = (eco.mass / eco.maxMass * 100) + '%';
    $('energy-fill').style.width = (eco.energy / eco.maxEnergy * 100) + '%';
    $('res-mass').classList.toggle('stall', eco.stallM && eco.mass < 5);
    $('res-energy').classList.toggle('stall', eco.stallE);
    put('mass-eff', eco.stallM && eco.mass < 5 ? `ДЕФИЦИТ ${Math.round(eco.effM * 100)}%` : eco.mass >= eco.maxMass - 1 ? 'СКЛАД ПОЛОН' : eco.fabM && !eco.fabOn ? 'ФАБРИКИ ВЫКЛ' : '');
    put('energy-eff', eco.stallE ? `ДЕФИЦИТ ${Math.round(eco.effE * 100)}%` : '');
    put('game-time', fmtT(g.time));
    put('speed-val', '×' + this.speed + (this.simRate < 0.93 && !this.paused ? ` (факт. ×${(this.speed * this.simRate).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')})` : ''));
    const UT = g.teams[this.team || 1];
    put('unit-count', `${UT ? UT.unitCount : 0} / ${g.unitCap}`);
    put('team-label', this.team ? 'ИГРОК' : 'НАБЛЮДЕНИЕ');
  }
  updateNotes() {
    const g = this.game, el = $('notes');
    const lt = this.team || 1;
    for (; this.notesShown < g.notes.length; this.notesShown++) {
      const n = g.notes[this.notesShown];
      if (n.team !== lt) continue;
      const d = document.createElement('div');
      d.className = 'note ' + n.kind;
      d.innerHTML = `<span class="note-t">${fmtT(n.t)}</span> ${esc(n.text)}`;
      d.onclick = () => this.r.centerOn(n.x, n.y);
      el.prepend(d);
      if (n.kind === 'alert') this.audio.play('alert');
      setTimeout(() => { d.classList.add('fade'); setTimeout(() => d.remove(), 800); }, 9000);
      while (el.children.length > 6) el.lastChild.remove();
    }
  }

  // ---------------------------------------------------------------- minimap
  buildMinimapBase() {
    const t = this.game.terrain, pal = t.map.palette, N = 256;
    const c = document.createElement('canvas'); c.width = c.height = N;
    const ctx = c.getContext('2d'), img = ctx.createImageData(N, N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / N * MAP_SIZE, y = (j + 0.5) / N * MAP_SIZE;
      const h = t.heightAt(x, y);
      const [gx, gy] = t.gradAt(x, y);
      const shade = Math.max(0.45, Math.min(1.35, 1 - gx * 1.2 - gy * 0.8));
      let col;
      if (h < t.water) { const d = Math.min(1, (t.water - h) / 12); col = [0.12 + 0.1 * (1 - d), 0.3 + 0.2 * (1 - d), 0.45 + 0.1 * (1 - d)]; }
      else {
        const k = Math.min(1, Math.max(0, (h - 15) / 55));
        col = pal.low.map((v, n) => v + (pal.high[n] - v) * k);
        if (t.slopeAt(x, y) > pal.rockSlope) col = pal.rock;
        if (h > pal.peakH) col = pal.peak;
        col = col.map(v => v * shade);
      }
      const o = (j * N + i) * 4;
      img.data[o] = col[0] * 255; img.data[o + 1] = col[1] * 255; img.data[o + 2] = col[2] * 255; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    for (const m of t.mass) { ctx.fillStyle = '#3cff78'; ctx.fillRect(m.x / MAP_SIZE * N - 1.5, m.y / MAP_SIZE * N - 1.5, 3, 3); }
    this.mmBase = c;
    this.mmFog = document.createElement('canvas'); this.mmFog.width = this.mmFog.height = PN;
    this.mmFogImg = this.mmFog.getContext('2d').createImageData(PN, PN);
  }
  drawMinimap() {
    const g = this.game, cv = $('minimap'), ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, k = W / MAP_SIZE;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.mmBase, 0, 0, W, H);
    const lt = this.team;
    if (lt && g.opts.fog) {
      const T = g.teams[lt], d = this.mmFogImg.data;
      for (let i = 0; i < PN * PN; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 0; d[i * 4 + 3] = T.vis[i] ? 0 : T.explored[i] ? 110 : 190; }
      this.mmFog.getContext('2d').putImageData(this.mmFogImg, 0, 0);
      ctx.drawImage(this.mmFog, 0, 0, W, H);
    }
    for (const s of g.structs) {
      if (lt && !g.seenBy(lt, s)) continue;
      ctx.fillStyle = TEAM_CSS[s.team]; const sz = Math.max(3, s.spec.size * k);
      ctx.fillRect(s.x * k - sz / 2, s.y * k - sz / 2, sz, sz);
    }
    for (const u of g.units) {
      const vis = !lt || g.visibleTo(lt, u);
      if (!vis && !(lt && u.rad[lt])) continue;
      ctx.fillStyle = vis ? TEAM_CSS[u.team] : 'rgba(255,120,90,0.7)';
      const sz = u.spec.role === 'exp' ? 5 : u.key === 'acu' ? 4 : 2;
      ctx.fillRect(u.x * k - sz / 2, u.y * k - sz / 2, sz, sz);
      if (u.key === 'acu' && vis) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(u.x * k - 3, u.y * k - 3, 6, 6); }
    }
    for (const s of this.selection) { ctx.strokeStyle = '#7dffb0'; ctx.strokeRect(s.x * k - 2.5, s.y * k - 2.5, 5, 5); }
    this.staffUI.drawMinimap(ctx, k);
    // camera footprint
    const ov = this.r.overlay, pts = [[0, 0], [ov.width, 0], [ov.width, ov.height], [0, ov.height]].map(([x, y]) => this.r.screenToGround(x, y));
    if (pts.every(Boolean)) { ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.2; ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k)); ctx.closePath(); ctx.stroke(); }
    for (const pg of this.pings) { const a = (performance.now() - pg.t) / 900; if (a < 1) { ctx.strokeStyle = pg.color; ctx.globalAlpha = 1 - a; ctx.beginPath(); ctx.arc(pg.x * k, pg.y * k, 3 + a * 8, 0, 6.28); ctx.stroke(); ctx.globalAlpha = 1; } }
    for (const p of g.projectiles) {   // strategic missiles in flight: impact zone + current position
      if (p.type !== 'nuke') continue;
      const own = !lt || g.allied(lt, p.team), pulse = 0.5 + 0.5 * Math.sin(performance.now() / 150);
      ctx.strokeStyle = ctx.fillStyle = own ? '#7dffb0' : '#ff3a2a';
      ctx.globalAlpha = 0.25 + 0.3 * pulse; ctx.beginPath(); ctx.arc(p.tx * k, p.ty * k, Math.max(4, p.zones[2] * k), 0, 6.28); ctx.fill();
      ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x * k, p.y * k, 2.2, 0, 6.28); ctx.fill();
    }
    for (const n of g.notes.slice(-4)) if (n.kind === 'alert' && g.time - n.t < 6 && n.team === (lt || 1)) { ctx.strokeStyle = '#ff4a3a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(n.x * k, n.y * k, 6 + (g.time * 8 % 8), 0, 6.28); ctx.stroke(); }
  }

  // ---------------------------------------------------------------- panels
  refreshPanels(force) {
    const g = this.game; if (!g) return;
    const sel = this.selection;
    const sig = sel.map(e => e.id + ':' + e.key + ':' + (e.built ? 1 : 0) + ':' + (e.queue ? e.queue.length : '') + ':' + (e.upgrading ? 1 : 0) + ':' + (e.repeat ? 1 : 0)
      + ':' + (e.enh ? Object.values(e.enh).join('') + (e.orders[0]?.type === 'enhance' ? e.orders[0].key : '') : '') + ':' + (e.ltHead ?? '') + ':' + (e.cargo ? e.cargo.length : '') + ':' + (e.silo ? e.silo.stock + (e.paused ? 'p' : '') : '')).join(',') + '|' + this.buildTier + '|' + this.form.type + this.form.spacing;
    if (force || sig !== this._sig) { this._sig = sig; this.buildCommandPanel(); }
    this.updateSelectionPanel();
    this.updateQueueProgress();
  }

  updateSelectionPanel() {
    const el = $('selpanel'), sel = this.selection, g = this.game;
    if (!sel.length) { el.innerHTML = `<div class="sel-empty"><div class="sel-empty-t">НИЧЕГО НЕ ВЫБРАНО</div><div>ЛКМ — выбрать · рамка — группа · двойной клик — все такие на экране<br>ПКМ — приказ · A атака-движение · P патруль · S стоп · E свободный инженер · F командир<br>F1 — мысли ИИ · F2 — карта угроз ИИ · F3 — мысли юнитов</div></div>`; this._selKey = null; return; }
    if (sel.length > 1) {
      const counts = new Map();
      for (const e of sel) { const k = e.key; if (!counts.has(k)) counts.set(k, { e, n: 0, hp: 0, max: 0, lt: 0 }); const c = counts.get(k); c.n++; c.hp += e.hp; c.max += e.maxHp; if (e.lt !== undefined) c.lt++; }
      const key = [...counts.entries()].map(([k, c]) => k + c.lt).join(',') + sel.length; // + how many of each kind a lieutenant controls
      const html = `<div class="sel-multi-head">ВЫБРАНО: ${sel.length}</div><div class="sel-grid">${[...counts.entries()].map(([k, c]) => `<div class="sel-cell" data-key="${k}" data-tip="${esc(c.e.spec.name)} — нажмите, чтобы выбрать только их"><div class="sel-ico" style="color:${TEAM_CSS[c.e.team]}">${thumbHTML(k, c.e.team, ICON_GLYPH[c.e.spec.icon] || '■')}</div><div class="sel-n">${c.n}</div>${this.staffUI.cellMark(c)}<div class="sel-hp"><div style="width:${c.hp / c.max * 100}%"></div></div></div>`).join('')}</div>`;
      if (key !== this._selKey) {
        el.innerHTML = html; this._selKey = key;
        for (const c of el.querySelectorAll('.sel-cell')) c.onclick = () => { this.selection = this.selection.filter(e => e.key === c.dataset.key); this.refreshPanels(true); };
      } else {
        el.querySelectorAll('.sel-cell').forEach(c => { const cc = counts.get(c.dataset.key); if (cc) c.querySelector('.sel-hp div').style.width = (cc.hp / cc.max * 100) + '%'; });
      }
      return;
    }
    const e = sel[0], s = e.spec;
    this._selKey = null;
    const hpf = e.hp / e.maxHp;
    const tier = TIER_NAMES[s.tier];
    let body = '';
    if (e.kind === 'unit') {
      const b = e.brain;
      const o = e.orders[0];
      const ordName = { move: 'Движение', amove: 'Атака с ходу', attack: 'Атака цели', patrol: 'Патруль', guard: 'Охрана', build: 'Строительство', assist: 'Помощь', repair: 'Ремонт', reclaim: 'Переработка', retreatTo: 'Отход', enhance: 'Улучшение', board: 'Посадка', pickup: 'Подбор груза', unload: 'Высадка' };
      const stats = [];
      if (s.dps) stats.push(`<span>УРОН/с <b>${Math.round(s.dps)}</b></span>`, `<span>ДАЛЬН. <b>${s.maxRange}</b></span>`);
      if (s.bp) stats.push(`<span>СТРОЙ <b>${s.bp}</b></span>`, `<span>РАДИУС СТРОЙКИ <b>${s.buildRange || 20}</b></span>`);
      stats.push(`<span>СКОР. <b>${s.speed}</b></span>`, `<span>ОБЗОР <b>${s.vision}</b></span>`);
      if (e.kills) stats.push(`<span>УБИЙСТВ <b>${e.kills}</b></span>`);
      if (e.vet) stats.push(`<span>ВЕТЕРАН <b class="vet">${'★'.repeat(e.vet)}</b></span>`);
      if (e.pshield) stats.push(`<span>ЩИТ <b>${Math.round(e.pshield.hp)}/${e.pshield.max}</b></span>`);
      if (e.cargo) stats.push(`<span>ГРУЗ <b>${g.cargoUsed(e)}/${s.cargo}</b> мест${e.cargo.length ? ` (${e.cargo.length} ед.) — T высадка` : ''}</span>`);
      if (e.enh) {
        const on = Object.entries(e.enh).filter(([, v]) => v).map(([sl, k]) => `${ENH_SLOTS[sl]}: ${ENH[k].name}`);
        const o0 = e.orders[0];
        stats.push(`<span>УЛУЧШЕНИЯ <b>${on.length ? esc(on.join(' · ')) : 'нет'}</b>${o0?.type === 'enhance' ? ` · ставлю «${esc(ENH[o0.key].name)}» ${Math.round((e.enhProg[o0.key] || 0) * 100)}%` : ''}</span>`);
      }
      body = `<div class="sel-stats">${stats.join('')}</div>
        <div class="sel-order">Приказ: <b>${o ? (ordName[o.type] || o.type) + (o.auto ? ' (сам)' : '') + (e.orders.length > 1 ? ` +${e.orders.length - 1}` : '') : 'нет'}</b>${e.platoon && !this.mine(e) ? ` · взвод ИИ #${e.platoon}` : ''}</div>
        <div class="brain"><div class="brain-h">🧠 МЫСЛЬ ЮНИТА</div><div class="brain-t">${esc(b.thought)}</div>
        <div class="brain-meta">Угроза рядом: <b class="${b.enemyPow > b.friendPow ? 'bad' : ''}">${Math.round(b.enemyPow)}</b> · Свои: <b>${Math.round(b.friendPow)}</b>${b.best ? ` · Цель: <b>${esc(b.best.spec.short || b.best.spec.name)}</b> (${Math.round(b.bestScore)})` : ''}</div>
        <div class="brain-log">${b.log.map(l => `<div><span>${fmtT(l.t)}</span> ${esc(l.text)}</div>`).join('')}</div></div>`;
    } else if (e.kind === 'struct') {
      const lines = [];
      if (!e.built) lines.push(`Строится: <b>${Math.round(e.progress * 100)}%</b>`);
      if (s.mass) lines.push(`Масса: <b class="m">+${s.mass}/с</b>`);
      if (s.energy) lines.push(`Энергия: <b class="en">+${s.energy}/с</b>`);
      if (s.eUse) lines.push(`Потребление: <b>-${s.eUse} Э/с</b>`);
      if (s.storeM) lines.push(`Склад массы: <b>+${s.storeM}</b>`);
      if (s.storeE) lines.push(`Склад энергии: <b>+${s.storeE}</b>`);
      if (s.dps) lines.push(`Урон/с: <b>${Math.round(s.dps)}</b> · Дальность: <b>${s.maxRange}</b>`);
      if (e.shield) lines.push(`Щит: <b>${Math.round(e.shield.hp)} / ${e.shield.max}</b>${e.shield.on ? '' : ' (отключён)'}`);
      if (s.radar) lines.push(`Радар: <b>${s.radar}</b>${s.sonar ? ` · Сонар: <b>${s.sonar}</b>` : ''}`);
      else if (s.sonar) lines.push(`Сонар: <b>${s.sonar}</b>`);
      if (s.fabM) { const eco = g.teams[e.team].eco; lines.push(`Фабрикатор: <b class="m">+${(s.fabM * (e.adj?.m || 1)).toFixed(1)} М/с</b> за <b>−${Math.round(s.fabE * (e.adj?.eCost || 1))} Э/с</b>${eco.fabOn ? '' : ' <b class="bad">(выкл. — мало энергии)</b>'}`); }
      const a = e.adj;
      if (a && a.n.length) {
        const bits = [];
        if (a.m > 1) bits.push(`+${Math.round((a.m - 1) * 100)}% массы`);
        if (a.e > 1) bits.push(`+${Math.round((a.e - 1) * 100)}% энергии`);
        if (a.eCost < 1) bits.push(`−${Math.round((1 - a.eCost) * 100)}% расхода энергии`);
        if (a.mCost < 1) bits.push(`−${Math.round((1 - a.mCost) * 100)}% расхода массы`);
        lines.push(`⬡ Соседство (${a.n.length}): <b class="good">${bits.join(', ')}</b>`);
      }
      if (e.upgrading) lines.push(`Улучшение → ${STRUCTS[e.upgrading.to].name}: <b>${Math.round(e.upgrading.prog * 100)}%</b>`);
      if (e.silo && e.built) {
        const sp = s.silo, full = e.silo.stock >= sp.max, col = sp.kind === 'nuke' ? '#ff6a3c' : sp.kind === 'anti' ? '#5fe8ff' : '#ffd060';
        const label = sp.kind === 'nuke' ? 'Ядерные ракеты' : sp.kind === 'anti' ? 'Антиракеты' : 'Тактические ракеты';
        lines.push(`${label}: <b style="color:${col}">${'▮'.repeat(e.silo.stock)}<span style="opacity:.35">${'▯'.repeat(sp.max - e.silo.stock)}</span> ${e.silo.stock}/${sp.max}</b>`);
        lines.push(full ? 'Склад ракет полон' : `Следующая ракета: <b>${Math.round(e.silo.prog * 100)}%</b>${e.paused ? ' <b class="bad">(пауза)</b>' : e.building ? '' : ' (нет ресурсов)'} · ${sp.costM} М + ${fmt(sp.costE)} Э`);
        if (!full) lines.push(`<div style="height:5px;background:rgba(0,0,0,.45);margin:2px 0"><div style="width:${e.silo.prog * 100}%;height:100%;background:${col}"></div></div>`);
        if (sp.kind === 'anti') lines.push(`Зона перехвата: <b>${sp.cover}</b>`);
        if (sp.kind === 'nuke') lines.push(`Поражение: <b>${fmtDist(sp.zones[0])}</b> — всё, <b>${fmtDist(sp.zones[1])}</b> — тяжёлое, <b>${fmtDist(sp.zones[2])}</b> — слабое${e.launch ? ' · <b class="bad">ШАХТА ОТКРЫТА, ПУСК…</b>' : ''}`);
      }
      if (s.produces) lines.push(`Производство: <b>${e.queue.length ? UNITS[e.queue[0]].name + ' ' + Math.round(e.prog * 100) + '%' : 'простаивает'}</b>${e.paused ? ' (пауза ИИ)' : ''}`);
      body = `<div class="sel-lines">${lines.map(l => `<div>${l}</div>`).join('')}</div><div class="sel-desc">${esc(s.desc || '')}</div>`;
    } else body = `<div class="sel-lines"><div>Масса: <b>${Math.round(e.mass)}</b></div></div>`;
    el.innerHTML = `<div class="sel-single"><div class="sel-head"><div class="sel-big-ico" style="color:${TEAM_CSS[e.team] || '#aaa'}">${thumbHTML(e.key, e.team, ICON_GLYPH[s.icon] || '■')}</div>
      <div><div class="sel-name">${esc(s.name)} <span class="tier">${tier || ''}</span>${this.staffUI.badge(e)}</div>
      <div class="sel-hpbar"><div style="width:${hpf * 100}%;background:${hpf > 0.6 ? '#46e070' : hpf > 0.3 ? '#e8c440' : '#ff4a3a'}"></div><span>${Math.round(e.hp)} / ${e.maxHp}</span></div></div></div>${body}</div>`;
  }

  buildCommandPanel() {
    const g = this.game, sel = this.selection.filter(e => this.mine(e) || !this.team);
    const orders = $('orders'), grid = $('buildgrid'), tabs = $('buildtabs'), queue = $('queue'), title = $('cmd-title');
    orders.innerHTML = ''; grid.innerHTML = ''; tabs.innerHTML = ''; queue.innerHTML = '';
    if (!this.canCommand || !sel.length) { title.textContent = this.canCommand ? 'КОМАНДЫ' : 'РЕЖИМ НАБЛЮДЕНИЯ'; return; }
    const units = sel.filter(e => e.kind === 'unit');
    const structs = sel.filter(e => e.kind === 'struct');
    const btn = (label, key, tip, fn, cls = '') => { const b = document.createElement('button'); b.className = 'ord ' + cls; b.innerHTML = `${label}${key ? `<kbd>${key}</kbd>` : ''}`; b.dataset.tip = tip; b.onclick = fn; orders.appendChild(b); return b; };
    if (units.length) {
      btn('Стоп', 'S', 'Отменить все приказы', () => { g.orderStop(sel); });
      if (units.some(u => u.spec.weapons.length)) btn('Атака-движ.', 'A', 'Двигаться, атакуя всех врагов по пути', () => this.setMode('amove'));
      btn('Патруль', 'P', 'Патрулировать между точками', () => this.setMode('patrol'));
      if (units.some(u => u.spec.bp)) btn('Переработка', 'R', 'Разобрать на массу/энергию обломки, камни, деревья, а также любой юнит или здание (в т.ч. вражеское и недостроенное)', () => this.setMode('reclaim'));
      const sac = units.find(u => u.key === 'sacu');
      if (sac && this.staff) {
        if (sac.ltHead === undefined) btn('Назначить область', 'H', 'Командир поддержки без дела. Назначьте ему область (экономика, армия, авиация, флот, оборона) — он станет помощником-лейтенантом и будет сам строить и командовать.', () => this.staffUI.openPick(false), 'oc');
        else btn('Штаб', 'H', 'Этот командир поддержки ведёт область — управление в окне Штаба.', () => this.staffUI.toggle(true));
      }
      if (units.some(u => u.spec.overcharge)) btn('Сверхзаряд', 'O', 'Мощный выстрел ACU за 3000 энергии', () => this.setMode('oc'), 'oc');
      if (units.some(u => u.cargo && u.cargo.length)) btn('Высадка', 'T', 'Транспорт садится в указанной точке и выгружает войска (корабль — на ближайший к точке берег)', () => this.setMode('unload'), 'up');
      if (units.filter(u => u.spec.move !== 'air').length > 1 || units.length > 2) {
        const fm = FORMS.find(f => f[0] === this.form.type);
        btn(`Строй: ${fm[1]}`, 'G', 'Тип строя при движении группы (Линия / Клин / Колонна / Каре / Без строя).<br>ПКМ с протяжкой — повернуть строй лицом по направлению протяжки.', () => { const i = FORMS.indexOf(fm); this.setFormation(FORMS[(i + 1) % FORMS.length][0]); }, 'form');
        btn('−', '[', 'Сомкнуть строй (плотнее)', () => this.changeSpacing(-0.2), 'form');
        const sp = document.createElement('span'); sp.className = 'hint-small'; sp.textContent = `интервал ×${this.form.spacing}`; orders.appendChild(sp);
        btn('+', ']', 'Разомкнуть строй (шире — меньше урона от артиллерии)', () => this.changeSpacing(0.2), 'form');
      }
    }
    const silos = structs.filter(s => s.silo && s.built);
    if (silos.length) {
      const fire = silos.filter(s => s.spec.silo.kind !== 'anti'), ready = fire.filter(s => s.silo.stock > 0).length;
      if (fire.length) {
        const nuke = fire.some(s => s.spec.silo.kind === 'nuke');
        const b = btn(`Пуск · ${ready}`, 'N', nuke ? `<b>Пуск ядерной ракеты</b><br>Режим прицеливания: ЛКМ по любой точке карты. До ${fmtDist(STRUCTS.sml.silo.zones[0])} — полное уничтожение, до ${fmtDist(STRUCTS.sml.silo.zones[1])} — тяжёлый урон, до ${fmtDist(STRUCTS.sml.silo.zones[2])} — слабый. Поражает и свои войска. Противник получает предупреждение.<br>Shift — оставаться в режиме.` : '<b>Пуск тактической ракеты</b><br>ЛКМ по точке или цели в радиусе 256 (24 — минимум). TML и так сама бьёт по зданиям и медленным целям.', () => this.startLaunch(), 'oc');
        if (!ready) b.style.opacity = 0.45;
      }
      const allP = silos.every(s => s.paused);
      btn(allP ? '▶ Ракеты' : '❚❚ Ракеты', '', allP ? 'Возобновить постройку ракет' : 'Приостановить постройку ракет (ресурсы не тратятся, готовые остаются)', () => { g.toggleSiloPause(silos); this.refreshPanels(true); }, allP ? 'on' : '');
    }
    if (structs.some(s => s.built && s.spec.upgradesTo && !s.upgrading)) {
      const s0 = structs.find(s => s.spec.upgradesTo && !s.upgrading), U = STRUCTS[s0.spec.upgradesTo];
      btn('Улучшить', 'U', `<b>${U.name}</b><br>Масса ${U.costM} · Энергия ${U.costE}<br>${esc(U.desc)}`, () => this.upgradeSelected(), 'up');
    }
    if (structs.length && structs.every(s => this.mine(s))) {
      btn('★ В пресет', '', 'Запомнить расстановку выделенных зданий как пресет стройки (вкладка ★ у строителей). Опора — экстрактор, если он выделен.', () => this.addPreset(structs));
    }
    const builders = units.filter(u => u.spec.canBuild);
    const facs = structs.filter(s => s.spec.produces && s.built);
    if (builders.length) {
      const maxTier = Math.max(...builders.map(u => u.spec.buildTier));
      const cmdr = builders.find(u => u.enh);
      const all = new Set(builders.flatMap(u => u.spec.canBuild));
      const has4 = Object.values(STRUCTS).some(S => S.tier >= 4 && all.has(S.key));   // вкладка Т4 — эксперименталы (инженер Т3 / ACU с модулем Т3)
      if (this.buildTier === 'enh' && !cmdr) this.buildTier = 1;
      if (typeof this.buildTier === 'number' && this.buildTier > maxTier && !(this.buildTier === 4 && has4)) this.buildTier = Math.min(maxTier, 3);
      title.textContent = 'СТРОИТЕЛЬСТВО';
      for (let t = 1; t <= 4; t++) {
        const lock = t === 4 ? !has4 : t > maxTier;
        const b = document.createElement('button'); b.className = 'tab' + (t === this.buildTier ? ' active' : '') + (lock ? ' locked' : '');
        b.textContent = TIER_NAMES[t]; b.disabled = lock; b.onclick = () => { this.buildTier = t; this.refreshPanels(true); };
        if (lock && t === 4) b.dataset.tip = 'Эксперименталы строят инженеры Т3 и командир с модулем Т3 (не sACU)';
        else if (lock && cmdr?.key === 'acu') b.dataset.tip = 'Установите командиру «Инженерный модуль» во вкладке УЛУЧШ.';
        tabs.appendChild(b);
      }
      {
        const b = document.createElement('button'); b.className = 'tab enh' + (this.buildTier === 'preset' ? ' active' : '');
        b.textContent = '★'; b.dataset.tip = 'Пресеты стройки: сохранённые расстановки зданий'; b.onclick = () => { this.buildTier = 'preset'; this.refreshPanels(true); };
        tabs.appendChild(b);
      }
      if (cmdr) {
        const b = document.createElement('button'); b.className = 'tab enh' + (this.buildTier === 'enh' ? ' active' : '');
        b.textContent = 'УЛУЧШ.'; b.dataset.tip = cmdr.key === 'sacu' ? 'Улучшения командира поддержки' : 'Улучшения командира (ACU)'; b.onclick = () => { this.buildTier = 'enh'; this.refreshPanels(true); };
        tabs.appendChild(b);
      }
      if (this.buildTier === 'preset') {
        title.textContent = 'ПРЕСЕТЫ СТРОЙКИ';
        if (!this.presets.length) { const d = document.createElement('div'); d.className = 'hint-small'; d.textContent = 'Пусто. Выделите свои здания и нажмите «★ В пресет».'; grid.appendChild(d); }
        this.presets.forEach((p) => {
          const a = STRUCTS[p.items[0].key], m = p.items.reduce((t, it) => t + STRUCTS[it.key].costM, 0), en = p.items.reduce((t, it) => t + STRUCTS[it.key].costE, 0);
          const tier = Math.max(...p.items.map(it => STRUCTS[it.key].tier)), ok = p.items.some(it => all.has(it.key));
          const b = this.gridButton(grid, { icon: a.icon, short: p.name, costM: m, costE: en, tier }, `<b>${esc(p.name)}</b> — ${p.items.length} зд.<br>Масса ${m} · Энергия ${en}<br><i>ЛКМ — поставить (опора: ${esc(a.name)}) · ПКМ или ✕ — удалить</i>${ok ? '' : '<br><b class="bad">Эти строители не умеют строить эти здания</b>'}`,
            () => this.setMode('build', p.items[0].key, p), () => this.removePreset(p), !ok, 0, p.items[0].key);
          b.classList.add('preset');
          const x = document.createElement('span'); x.className = 'g-del'; x.textContent = '✕';
          x.onclick = (ev) => { ev.stopPropagation(); this.removePreset(p); };
          b.appendChild(x);
        });
        return;
      }
      if (this.buildTier === 'enh') {
        title.textContent = cmdr.key === 'sacu' ? 'УЛУЧШЕНИЯ КОМАНДИРА ПОДДЕРЖКИ' : 'УЛУЧШЕНИЯ КОМАНДИРА';
        const o0 = cmdr.orders[0];
        for (const [k, E] of Object.entries(ENH)) {
          if (E.unit !== cmdr.key) continue;
          const inst = cmdr.enh[E.slot] === k, c = g.canEnhance(cmdr, k), busy = o0?.type === 'enhance' && o0.key === k;
          const cur = cmdr.enh[E.slot] && !inst ? `<br><i>Заменит: ${esc(ENH[cmdr.enh[E.slot]].name)}</i>` : '';
          const tip = `<b>${esc(E.name)}</b> · слот: ${ENH_SLOTS[E.slot]}<br>Масса ${E.costM} · Энергия ${E.costE} · Время ${E.bt}<br>${esc(E.desc)}${cur}${inst ? '<br><b class="good">Установлено</b>' : !c.ok ? `<br><b class="bad">${esc(c.why)}</b>` : '<br><i>ЛКМ — установить (командир стоит на месте; инженеры могут помогать)</i>'}`;
          const btnEl = this.gridButton(grid, { icon: null, short: E.short, costM: E.costM, costE: E.costE, tier: cmdr.key === 'sacu' ? ({ rarm: 1, larm: 2, back: 3 })[E.slot] : E.slot === 'larm' ? (k === 'eng3' ? 3 : 2) : 1 }, tip,
            (ev) => { g.orderEnhance([cmdr], k, ev.shiftKey); this.audio.play('ui'); this.refreshPanels(true); }, null, !c.ok && !inst, busy ? Math.round((cmdr.enhProg[k] || 0) * 100) + '%' : inst ? '✓' : 0);
          btnEl.querySelector('.g-ico').textContent = ENH_GLYPH[k] || '✦';
          if (inst) btnEl.classList.add('installed');
        }
        return;
      }
      for (const k of Object.keys(STRUCTS)) {
        const S = STRUCTS[k];
        if (!all.has(k) || S.upgradeOnly || S.tier !== this.buildTier) continue;
        this.gridButton(grid, S, `Строить: <b>${S.name}</b><br>Масса ${S.costM} · Энергия ${S.costE} · Время ${S.bt}<br>${esc(S.desc)}${S.mass ? `<br>+${S.mass} М/с` : ''}${S.energy ? `<br>+${S.energy} Э/с` : ''}`, () => { this.setMode('build', k); }, null, false, 0, k);
      }
    } else if (facs.length) {
      const f = facs[0], type = f.spec.produces;
      const same = facs.filter(x => x.spec.produces === type);
      title.textContent = `ПРОИЗВОДСТВО · ${f.spec.name.toUpperCase()}`;
      for (const k of PRODUCES[type]) {
        const U = UNITS[k], locked = U.tier > f.spec.tier;
        const cnt = f.queue.filter(q => q === k).length;
        const b = this.gridButton(grid, U, `<b>${U.name}</b> ${TIER_NAMES[U.tier]}<br>Масса ${U.costM} · Энергия ${U.costE} · Время ${U.bt}<br>${esc(U.desc)}${U.dps ? `<br>Урон/с ${Math.round(U.dps)} · Дальность ${U.maxRange}` : ''}<br><i>ЛКМ +1 · Shift +5 · ПКМ −1</i>${locked ? '<br><b class="bad">Требуется завод ' + TIER_NAMES[U.tier] + '</b>' : ''}`,
          (ev) => { for (const s of same) g.queueUnit(s, k, ev.shiftKey ? 5 : 1); this.audio.play('ui'); this.refreshPanels(true); },
          () => { for (const s of same) g.dequeueUnit(s, k); this.refreshPanels(true); }, locked, cnt, k);
      }
      const rep = document.createElement('button'); rep.className = 'ord' + (f.repeat ? ' on' : ''); rep.innerHTML = '⟳ Повтор'; rep.dataset.tip = 'Зациклить очередь производства';
      rep.onclick = () => { const v = !f.repeat; for (const s of same) s.repeat = v; this.refreshPanels(true); };
      orders.appendChild(rep);
      const rally = document.createElement('div'); rally.className = 'hint-small'; rally.textContent = 'ПКМ по карте — точка сбора';
      orders.appendChild(rally);
      queue.innerHTML = this.queueHTML(f);
    } else title.textContent = structs.length ? structs[0].spec.name.toUpperCase() : 'КОМАНДЫ';
  }
  gridButton(grid, spec, tip, onClick, onRight, locked, count, tkey) {
    const b = document.createElement('div');
    b.className = 'gbtn' + (locked ? ' locked' : '');
    b.innerHTML = `<div class="g-ico">${tkey ? thumbHTML(tkey, this.team || 1, ICON_GLYPH[spec.icon] || '■') : ICON_GLYPH[spec.icon] || '■'}</div><div class="g-name">${esc(spec.short || spec.name)}</div><div class="g-cost"><span class="m">${spec.costM}</span> <span class="en">${fmt(spec.costE)}</span></div><div class="g-tier">${TIER_NAMES[spec.tier]}</div>${count ? `<div class="g-count">${count}</div>` : ''}`;
    b.dataset.tip = tip;
    if (!locked) { b.onclick = onClick; if (onRight) b.oncontextmenu = (e) => { e.preventDefault(); onRight(); }; }
    grid.appendChild(b);
    return b;
  }
  queueHTML(f) {
    if (!f.queue.length) return '<div class="q-empty">Очередь пуста</div>';
    const groups = [];
    for (const k of f.queue) { const last = groups[groups.length - 1]; if (last && last.k === k) last.n++; else groups.push({ k, n: 1 }); }
    return groups.slice(0, 10).map((q, i) => `<div class="q-item">${thumbHTML(q.k, this.team || 1, ICON_GLYPH[UNITS[q.k].icon] || '■')}${q.n > 1 ? `<b>${q.n}</b>` : ''}${i === 0 ? '<div class="q-prog"><div id="qprog"></div></div>' : ''}</div>`).join('');
  }
  updateQueueProgress() {
    const f = this.selection.find(s => s.kind === 'struct' && s.spec.produces);
    const el = document.getElementById('qprog');
    if (f && el) el.style.width = (f.prog * 100) + '%';
  }

  // ---------------------------------------------------------------- AI thought window
  renderAI(force) {
    const w = $('ai-window');
    if (w.classList.contains('hidden') && !force) return;
    const ai = this.ais[this.aiTeamIdx];
    const body = $('ai-body');
    if (!ai) { body.innerHTML = '<div class="dim">В этой игре нет ИИ.</div>'; return; }
    const S = ai.S, eco = ai.T.eco, g = this.game;
    $('ai-strat-chip').textContent = S.name;
    $('ai-strat-chip').style.borderColor = TEAM_CSS[ai.team];
    let html = '';
    if (this.aiTab === 'strategy') {
      const intents = INTENTS.map(i => ({ ...i, ...ai.intents[i.key] })).sort((a, b) => b.f - a.f);
      html = `<div class="ai-row"><span class="chip">${esc(ai.phase)}</span><span class="chip">Доктрина: ${ai.doctrine === 'adaptive' ? 'адаптивная (обучаемая)' : esc(STRATEGIES[ai.doctrine]?.name || ai.doctrine)}</span><span class="chip">Сложность: ${esc(ai.diff)}</span>${ai.macroInfo || ai.macroIdx ? `<span class="chip" title="Макро-решение стратегической модели (раз в 60–90 с) и её оценка шанса победы">Макро: ${esc(MACROS[ai.macroIdx].ru)}${ai.macroInfo ? ` · победа ${Math.round(ai.macroInfo.v * 100)}%` : ''}</span>` : ''}</div>
      <div class="ai-kv"><div>Стратегия<b>${esc(S.name)}</b></div><div>Масса<b class="m">+${eco.incM.toFixed(1)}</b></div><div>Энергия<b class="en">+${eco.incE.toFixed(0)}</b></div><div>Уровень<b>Т${ai.tier}</b></div><div>ACU<b>${esc(ai.acuState)}</b></div><div>Угроза базе<b class="${ai.baseThreat > 0 ? 'bad' : ''}">${Math.round(ai.baseThreat)}</b></div></div>
      <div class="ai-sub">НАМЕРЕНИЯ</div>
      <div class="intents">${intents.map((it, i) => `<div class="intent ${i === 0 ? 'top' : ''}"><div class="it-name">${i === 0 ? '★ ' : ''}${esc(it.ru)}</div>
        <div class="it-bars"><div class="bar f" style="width:${Math.min(100, it.f * 83)}%"></div></div>
        <div class="it-val">${Math.round(it.f * 100)}%</div></div>`).join('')}</div>
            ${ai.features ? `<div class="ai-sub">ОЦЕНКА ОБСТАНОВКИ</div><div class="ai-kv small"><div>Наша сила<b>${Math.round(ai.features.ourPow)}</b></div><div>Сила врага (оценка)<b>${Math.round(ai.features.enemyPow)}</b></div><div>Соотношение<b class="${ai.features.ratio < 0.8 ? 'bad' : 'good'}">${ai.features.ratio.toFixed(2)}</b></div><div>Авиация врага<b>${Math.round(ai.features.enemyAir)}</b></div><div>Наша ПВО<b>${Math.round(ai.features.ourAA)}</b></div><div>Свободных масс-точек<b>${ai.features.freeMex}</b></div><div>Потери 3 мин<b class="bad">${Math.round(ai.features.lost)}</b></div><div>Уничтожено 3 мин<b class="good">${Math.round(ai.features.killed)}</b></div></div>` : ''}
      ${ai.stratHistory.length ? `<div class="ai-sub">СМЕНЫ ДОКТРИНЫ</div>${ai.stratHistory.map(h => `<div class="dim">${fmtT(h.t)}: ${esc(STRATEGIES[h.from].name)} → <b>${esc(STRATEGIES[h.to].name)}</b></div>`).join('')}` : ''}`;
    } else if (this.aiTab === 'memory') {
      const I = ai.intel, L = ai.ltm, mp = L.maps[g.map.id]?.strats || {};
      const c = I.comp;
      html = `<div class="mem-grid"><canvas id="ai-heat" width="224" height="224"></canvas>
        <div class="mem-side"><div class="ai-sub">КРАТКОСРОЧНАЯ ПАМЯТЬ</div>
        <div class="dim">Известно юнитов врага: <b>${I.units.size}</b></div><div class="dim">Известно зданий врага: <b>${I.structs.size}</b></div>
        <div class="dim">Уровень технологий врага: <b>Т${I.enemyTier}</b></div>
        <div class="dim">Состав (замечено): суша <b>${c.land}</b> · авиа <b>${c.air}</b> · флот <b>${c.naval}</b> · ПВО <b>${c.aa}</b> · арт. <b>${c.arty}</b>${c.exp ? ` · <b class="bad">эксп. ${c.exp}</b>` : ''}</div>
        <div class="dim">Вражеский ACU: <b>${I.enemyAcu ? `замечен ${fmtT(I.enemyAcu.t)}, HP ${Math.round(I.enemyAcu.hp * 100)}%` : 'не обнаружен'}</b></div>
        <div class="dim">Первый контакт у базы: <b>${I.firstRushT ? fmtT(I.firstRushT) : '—'}</b></div>
        <div class="legend"><span class="lg" style="background:#ff4a3a"></span>угроза земле <span class="lg" style="background:#4a8aff"></span>угроза воздуху <span class="lg" style="background:#ffcc40"></span>потери</div></div></div>
        <div class="ai-sub">ДОЛГОВРЕМЕННАЯ ПАМЯТЬ (между матчами)</div>
        <div class="ai-kv small"><div>Матчей<b>${L.games}</b></div><div>Побед ИИ<b class="good">${L.wins}</b></div><div>Поражений<b class="bad">${L.losses}</b></div><div>Профиль: авиация<b>${Math.round(L.profile.air * 100)}%</b></div><div>Профиль: флот<b>${Math.round(L.profile.naval * 100)}%</b></div><div>Ранняя атака врага<b>${L.profile.n ? fmtT(L.profile.rushT) : '—'}</b></div></div>
        <div class="ai-sub">СТАТИСТИКА СТРАТЕГИЙ НА «${esc(g.map.name).toUpperCase()}» (UCB1)</div>
        <table class="tbl"><tr><th>Стратегия</th><th>Игр</th><th>Побед</th><th>Винрейт</th></tr>${Object.entries(STRATEGIES).map(([k, s]) => { const st = mp[k] || { n: 0, w: 0 }; return `<tr class="${k === ai.initialStrategy ? 'cur' : ''}"><td>${esc(s.name)}</td><td>${st.n}</td><td>${st.w}</td><td>${st.n ? Math.round(st.w / st.n * 100) + '%' : '—'}</td></tr>`; }).join('')}</table>
        ${L.history.length ? `<div class="ai-sub">ПОСЛЕДНИЕ МАТЧИ</div>${L.history.slice(0, 6).map(h => `<div class="dim">${new Date(h.date).toLocaleDateString()} · ${esc(h.map)} · ${esc(STRATEGIES[h.strat]?.name || h.strat)} · <b class="${h.result === 'win' ? 'good' : 'bad'}">${h.result === 'win' ? 'победа' : 'поражение'}</b> · ${fmtT(h.dur)}</div>`).join('')}` : ''}`;
    } else if (this.aiTab === 'army') {
      html = `<table class="tbl"><tr><th>Взвод</th><th>Задача</th><th>Ед.</th><th>Сила</th></tr>${ai.platoons.filter(p => p.units.length).map(p => `<tr><td>${esc(p.name)}</td><td>${esc({ reserve: 'сбор', attack: 'атака', raid: 'рейд', defend: 'оборона', airstrike: 'авиаудар', aircap: 'ПВО-патруль', scout: 'разведка', retreat: 'отход', exp: 'эксп. удар' }[p.mission] || p.mission)}</td><td>${p.units.length}</td><td>${Math.round(p.pow)}</td></tr><tr class="sub"><td colspan="4">${esc(p.status || '')}</td></tr>`).join('')}</table>
      <div class="ai-sub">ИНЖЕНЕРЫ И ЗАДАЧИ</div>${(ai.buildTasks || []).slice(0, 8).map(t => `<div class="dim">${Math.round(t.prio)} · ${esc(STRUCTS[t.key].name)}${t.assigned ? ` · назначено ${t.assigned}` : ''}</div>`).join('') || '<div class="dim">—</div>'}`;
    } else {
      const catCls = { 'ЭКОНОМИКА': 'eco', 'ТЕХНОЛОГИИ': 'tech', 'ВОЙСКА': 'mil', 'РАЗВЕДКА': 'intel', 'ACU': 'acu', 'ПАМЯТЬ': 'mem', 'СТРАТЕГИЯ': 'strat', 'МАКРО': 'strat' };
      html = `<div class="log">${ai.logs.slice(0, 60).map(l => `<div class="log-row ${l.level}"><span class="lt">${fmtT(l.t)}</span><span class="lc ${catCls[l.cat] || ''}">${esc(l.cat)}</span>${esc(l.text)}</div>`).join('')}</div>`;
    }
    if (html !== this._aiHtml || force) {
      const open = body.querySelector('details')?.open;
      body.innerHTML = html; this._aiHtml = html;
      if (open) { const d = body.querySelector('details'); if (d) d.open = true; }
    }
    if (this.aiTab === 'memory') this.drawHeat(ai);
  }
  drawHeat(ai) {
    const cv = document.getElementById('ai-heat'); if (!cv) return;
    const ctx = cv.getContext('2d'), I = ai.intel, W = cv.width; let k;
    ctx.drawImage(this.mmBase, 0, 0, W, W);
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, W, W);
    const GN = Math.round(Math.sqrt(I.thrLand.length)); k = W / GN;
    let mx = 1; for (let i = 0; i < GN * GN; i++) mx = Math.max(mx, I.thrLand[i], I.thrAir[i]);
    for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
      const n = j * GN + i, l = I.thrLand[n] / mx, a = I.thrAir[n] / mx, loss = Math.min(1, I.loss[n] / 300);
      if (l > 0.02) { ctx.fillStyle = `rgba(255,70,50,${Math.min(0.85, l * 1.8)})`; ctx.fillRect(i * k, j * k, k, k); }
      if (a > 0.02) { ctx.fillStyle = `rgba(70,130,255,${Math.min(0.7, a * 1.8)})`; ctx.fillRect(i * k + k * 0.25, j * k + k * 0.25, k * 0.5, k * 0.5); }
      if (loss > 0.05) { ctx.strokeStyle = `rgba(255,210,60,${loss})`; ctx.strokeRect(i * k + 1, j * k + 1, k - 2, k - 2); }
    }
    const s = W / MAP_SIZE;
    for (const r of I.structs.values()) { ctx.fillStyle = TEAM_CSS[r.e.team]; ctx.fillRect(r.x * s - 2, r.y * s - 2, 4, 4); }
    for (const r of I.units.values()) { ctx.fillStyle = r.radar ? 'rgba(255,150,120,0.7)' : TEAM_CSS[r.e.team]; ctx.fillRect(r.x * s - 1, r.y * s - 1, 2, 2); }
    for (const u of ai.myUnits || []) { ctx.fillStyle = TEAM_CSS[ai.team]; ctx.fillRect(u.x * s - 1, u.y * s - 1, 2, 2); }
    for (const p of ai.platoons) if (p.target && p.units.length && p.mission !== 'reserve') { ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(p.target.x * s, p.target.y * s, 5, 0, 6.28); ctx.stroke(); }
    ctx.strokeStyle = TEAM_CSS[ai.team]; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ai.base.x * s, ai.base.y * s, 8, 0, 6.28); ctx.stroke(); ctx.lineWidth = 1;
  }
}
