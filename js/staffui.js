// "Штаб" (HQ) window: the player's roster of lieutenants — cards, area picker, hand-over of selected units,
// zone drawing, on-map and minimap markers. Self-contained: ui.js only forwards a few hooks (see StaffUI usage there).
import { AREAS, AREA_ORDER, STYLES, NO_SACU } from './lieutenant.js';
import { MAP_SIZE } from './maps.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtT = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const plural = (n, f) => { const a = n % 10, b = n % 100; return f[a === 1 && b !== 11 ? 0 : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 1 : 2]; };
// radius of a zone being drawn: a click without a drag = 120, a drag = at least 40 (PC and VR, js/vrstaff.js)
export const zoneR = (z) => z.moved ? Math.max(40, z.r) : 120;
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; };

// 24x24 line icons
const ICONS = {
  eco: '<path d="M13 2 4.5 13.5H11L10 22l9-12h-6.5z"/>',
  land: '<rect x="2.5" y="13" width="19" height="6" rx="3"/><path d="M7 13v-3.2h8.5V13M15.5 11.4 21 9.2"/><circle cx="7" cy="16" r=".6"/><circle cx="12" cy="16" r=".6"/><circle cx="17" cy="16" r=".6"/>',
  air: '<path d="M12 2.5c1 0 1.8 1 1.8 2.6v4.7l7.7 4.6v2.2l-7.7-2.3v4l2.6 1.9V21l-4.4-1.1L7.6 21v-1.4l2.6-1.9v-4l-7.7 2.3v-2.2l7.7-4.6V5.1C10.2 3.500 11 2.500 12 2.500z"/>',
  naval: '<circle cx="12" cy="5" r="2.2"/><path d="M12 7.2V20M8 11h8M4.500 14.500C5 18 8 20.500 12 20.500s7-2.500 7.500-6M3 15l1.500-.5M21 15l-1.500-.5"/>',
  defense: '<path d="M12 2.500 4.500 5.500v5.800c0 4.700 3.200 8.400 7.500 10.200 4.300-1.800 7.500-5.500 7.500-10.200V5.500z"/><path d="M9 11.500l2.200 2.200L15.500 9.500"/>',
  staff: '<path d="M12 2.500l2.700 5.700 6.200.8-4.600 4.300 1.200 6.200L12 16.400 6.500 19.500l1.200-6.200L3.100 9l6.200-.8z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', pause: '<path d="M8 5v14M16 5v14"/>', play: '<path d="M7 4.500v15l12-7.500z"/>',
  eye: '<path d="M2.500 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12z"/><circle cx="12" cy="12" r="2.800"/>',
  zone: '<circle cx="12" cy="12" r="8.500" stroke-dasharray="3.200 2.800"/><circle cx="12" cy="12" r="1.800"/>',
  give: '<path d="M4 12h13M12 6l6 6-6 6"/>', recall: '<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>', chev: '<path d="M6 9l6 6 6-6"/>'
};
const svg = (n, s = 18) => `<svg class="ico" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`;
const CAT_CLS = { 'ЭКОНОМИКА': 'eco', 'ВОЙСКА': 'mil', 'ОБОРОНА': 'def', 'ТЕХНОЛОГИИ': 'tech', 'ПРИКАЗ': 'cmd' };
const STYLE_TIP = {
  cautious: 'Осторожный: атакует поздно и крупными силами, держит резерв, отступает при малейшем перевесе врага.',
  balanced: 'Сбалансированный: атакует при разумном соотношении сил, отступает при явном перевесе врага.',
  aggressive: 'Агрессивный: ранние атаки малыми силами, минимум резерва, отступает лишь при большом перевесе.'
};

export class StaffUI {
  constructor(ui) {
    this.ui = ui; this.staff = null;
    this.win = $('staff-window'); this.list = $('staff-list');
    this.cards = new Map(); this.view = 'list'; this.pick = { area: null, style: 'balanced', budget: 50, give: false, sacu: null };
    this.hover = null; this.zoneEdit = null; this.folded = new Set(); this.t = 0; this.dragged = false; this.confirm = null; this.logOpen = new Set();
    this.bind();
  }
  get open() { return !this.win.classList.contains('hidden'); }
  get g() { return this.ui.game; }

  // ---------------------------------------------------------------- wiring
  bind() {
    const ui = this.ui;
    $('btn-staff').onclick = (e) => { this.toggle(); e.currentTarget.blur(); };
    $('staff-close').onclick = () => this.toggle(false);
    ui.makeDraggable(this.win, $('staff-head'));
    $('staff-head').addEventListener('mousedown', () => { this.dragged = true; });
    $('staff-add').onclick = () => this.openPick(this.transferable().length > 0);
    $('staff-give').onclick = (e) => this.openMenu(e.currentTarget);
    this.win.addEventListener('click', (e) => this.onClick(e));
    this.list.addEventListener('input', (e) => {
      const r = e.target.closest('input[data-act="budget"]'); if (!r) return;
      const lt = this.ltOf(r); if (!lt) return;
      lt.budget = r.value / 100; r.closest('.lt-bud').querySelector('b').textContent = r.value + '%';
    });
    this.list.addEventListener('change', (e) => { if (e.target.matches('input[type=range]')) e.target.blur(); });
    this.list.addEventListener('mouseover', (e) => { const c = e.target.closest('.lt-card'); this.hover = c ? +c.dataset.id : null; });
    this.list.addEventListener('mouseleave', () => { this.hover = null; });
    $('staff-menu').addEventListener('click', (e) => this.onMenu(e));
    $('staff-selbar').addEventListener('click', (e) => this.onSelbar(e));
    document.addEventListener('mousedown', (e) => { if (!e.target.closest('#staff-menu, #staff-give, #staff-selbar')) this.closeMenu(); });
    // zone drawing: capture phase so the map / minimap handlers of ui.js never see these clicks
    window.addEventListener('mousedown', (e) => this.zoneDown(e), true);
    window.addEventListener('mousemove', (e) => this.zoneMove(e));
    window.addEventListener('mouseup', (e) => this.zoneUp(e));
  }
  setStaff(staff) {
    this.staff = staff; this.cards.clear(); this.list.innerHTML = ''; this.view = 'list'; this.zoneEdit = null; this.confirm = null; this.hover = null;
    this.closeMenu();
    $('btn-staff').classList.toggle('hidden', !staff);
    if (!staff) this.win.classList.add('hidden');
    this.render(true);
  }
  ltOf(el) { const c = el.closest('.lt-card'); return c && this.staff ? this.staff.get(+c.dataset.id) : null; }

  toggle(v) {
    if (!this.staff) return;
    const on = v === undefined ? !this.open : v;
    this.win.classList.toggle('hidden', !on);
    $('btn-staff').classList.toggle('on', on);
    if (on) {
      if (!this.dragged) { // stay clear of the AI window when both are open
        const ai = $('ai-window');
        this.win.style.right = ai && !ai.classList.contains('hidden') ? '494px' : '12px'; this.win.style.left = 'auto'; this.win.style.top = '68px';
      }
      this.render(true);
    } else this.closeMenu();
    this.ui.audio.play('ui');
  }

  // ---------------------------------------------------------------- selection helpers
  transferable() {
    const ui = this.ui, t = ui.team;
    return ui.selection.filter(e => e.alive && e.team === t && e.key !== 'acu' && e.key !== 'sacu' && !e.carried);
  }
  // Soft advice when the handed-over set doesn't fit the lieutenant's area.
  advice(lt, ents) {
    const eng = ents.some(e => e.kind === 'unit' && e.spec.role === 'eng'), fac = ents.some(e => e.kind === 'struct' && e.spec.produces), mil = ents.some(e => e.kind === 'unit' && e.spec.dps > 0);
    if (lt.area === 'eco' && !eng && !fac && !lt.allUnits.some(u => u.spec.role === 'eng')) return 'Экономике нужны инженеры — без них строить некому.';
    if ((lt.area === 'land' || lt.area === 'air' || lt.area === 'naval') && !fac && !mil && !lt.ownStructs.some(s => s.spec.produces)) return 'Этой области нужен завод нужного типа (или уже готовые войска).';
    if (lt.area === 'defense' && !eng && !lt.allUnits.some(u => u.spec.role === 'eng')) return 'Обороне нужен хотя бы один инженер, чтобы строить укрепления.';
    return '';
  }
  give(lt, ents) {
    ents = ents || this.transferable();
    if (!ents.length) { this.ui.flash('Сначала выделите юнитов или здания, которые нужно передать'); return false; }
    const r = this.staff.assign(lt, ents);
    if (!r.units && !r.structs) { this.ui.flash('Эти объекты нельзя передать (командир остаётся под вашим управлением)'); return false; }
    const bits = [];
    if (r.units) bits.push(`${r.units} ${plural(r.units, ['юнит', 'юнита', 'юнитов'])}`);
    if (r.structs) bits.push(`${r.structs} ${plural(r.structs, ['здание', 'здания', 'зданий'])}`);
    const adv = this.advice(lt, ents);
    this.ui.flash(`Передано «${lt.name}»: ${bits.join(', ')}${adv ? ' · ' + adv : ''}`, true);
    this.ui.audio.play('ui');
    this.render(true);
    return true;
  }
  takeBack(ents) {
    const n = this.staff.release(ents || this.ui.selection);
    if (n) { this.ui.flash(`Забрано у помощников: ${n} ед.`, true); this.ui.audio.play('ui'); this.render(true); }
  }

  // ---------------------------------------------------------------- keyboard (returns true when consumed)
  onKey(e) {
    if (!this.staff) return false;
    if (e.code === 'Escape') {
      if (this.menuOpen) { this.closeMenu(); return true; }
      if (this.zoneEdit) { this.zoneCancel(); return true; }
      if (this.open && this.view === 'pick') { this.view = 'list'; this.render(true); return true; }
      return false;
    }
    if (e.code === 'KeyH' && !e.altKey && !e.metaKey) {
      e.preventDefault();
      if (e.ctrlKey) this.quickGive(); else this.toggle();
      return true;
    }
    return false;
  }
  // Ctrl+H: hand the selection to the last used lieutenant.
  // onNone: what to open when there is no lieutenant yet (VR: its own HQ screen); default — the PC window's pick view.
  quickGive(onNone) {
    const ents = this.transferable();
    if (!ents.length) { this.ui.flash('Ctrl+H: выделите юнитов или здания, чтобы передать их помощнику'); return; }
    const lt = this.staff.last;
    if (!lt) { if (onNone) onNone(); else { this.toggle(true); this.openPick(true); } return; }
    this.give(lt, ents);
  }

  // ---------------------------------------------------------------- floating menus
  get menuOpen() { return !$('staff-menu').classList.contains('hidden'); }
  closeMenu() { $('staff-menu').classList.add('hidden'); }
  openMenu(anchor) {
    if (!this.staff) return;
    const m = $('staff-menu'), ents = this.transferable();
    const items = this.staff.list.map(lt => {
      const s = lt.summary();
      return `<button class="sm-item" data-lt="${lt.id}" style="--lc:${lt.A.color}"><span class="sm-ico">${svg(lt.area, 16)}</span><span class="sm-t"><b>${esc(lt.name)}</b><i>${esc(lt.A.name)} · ${s.units} ед. · ${s.structs} зд.</i></span></button>`;
    }).join('');
    m.innerHTML = `<div class="sm-head">${ents.length ? `Передать выделенное (${ents.length}) помощнику` : 'Выделите юнитов или здания'}</div>${items}<button class="sm-item new" data-new="1"><span class="sm-ico">${svg('plus', 16)}</span><span class="sm-t"><b>Назначить нового помощника…</b></span></button>`;
    m.classList.remove('hidden'); m.classList.toggle('empty', !ents.length);
    const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + 'px';
    const below = r.bottom + 4 + h < window.innerHeight - 250;
    m.style.top = (below ? r.bottom + 4 : Math.max(8, r.top - h - 4)) + 'px';
  }
  onMenu(e) {
    const b = e.target.closest('.sm-item'); if (!b) return;
    this.closeMenu();
    if (b.dataset.new) { this.toggle(true); this.openPick(this.transferable().length > 0); return; }
    const lt = this.staff.get(+b.dataset.lt);
    if (lt) this.give(lt);
  }
  onSelbar(e) {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'give') { if (this.staff.list.length) this.openMenu(b); else { this.toggle(true); this.openPick(true); } }
    if (b.dataset.act === 'take') this.takeBack(this.ui.selection.filter(x => x.lt !== undefined));
  }

  // ---------------------------------------------------------------- window rendering
  update(dt) {
    this.t -= dt; if (this.t > 0) return;
    this.t = 0.3;
    if (!this.staff) { $('staff-selbar').classList.add('hidden'); return; }
    this.updateSelbar();
    if (this.zoneEdit && this.ui.mode !== 'zone') this.zoneCancel();
    const n = this.staff.list.length, bd = $('staff-badge');
    bd.textContent = n; bd.classList.toggle('hidden', !n);
    if (this.open) this.render(false);
  }
  render(force) {
    if (!this.staff) return;
    const st = this.staff, ents = this.transferable();
    const free = st.freeSacu().length;
    $('staff-count').textContent = (st.list.length ? `${st.list.length} из 8` : 'нет помощников') + ` · свободных sACU: ${free}`;
    $('staff-add').classList.toggle('dim', !free);
    $('staff-give').disabled = false;
    $('staff-give').innerHTML = `${svg('give', 15)}<span>Передать выделенное${ents.length ? ` <b>${ents.length}</b>` : ''}</span>`;
    $('staff-give').classList.toggle('dim', !ents.length);
    $('staff-add').classList.toggle('hidden', this.view === 'pick');
    if (this.view === 'pick') { if (force || !this.pickBuilt) this.renderPick(); else this.updatePickCount(); this.list.classList.add('hidden'); $('staff-pick').classList.remove('hidden'); return; }
    this.pickBuilt = false;
    $('staff-pick').classList.add('hidden'); this.list.classList.remove('hidden');
    // drop cards of dismissed lieutenants, add new ones (kept in roster order)
    for (const [id, c] of this.cards) if (!st.get(id)) { c.el.remove(); this.cards.delete(id); }
    let empty = $('staff-empty');
    if (!st.list.length) {
      if (!empty) { empty = document.createElement('div'); empty.id = 'staff-empty'; empty.innerHTML = this.emptyHTML(); this.list.appendChild(empty); }
      return;
    }
    if (empty) empty.remove();
    for (const lt of st.list) {
      let c = this.cards.get(lt.id);
      if (!c) { c = this.buildCard(lt); this.cards.set(lt.id, c); this.list.appendChild(c.el); if (this.justAdded === lt.id) { c.el.classList.add('new'); this.justAdded = null; c.el.scrollIntoView?.({ block: 'nearest' }); } }
      this.updateCard(lt, c, ents);
    }
    st.list.forEach((lt, i) => { const c = this.cards.get(lt.id); if (this.list.children[i] !== c.el) this.list.insertBefore(c.el, this.list.children[i] || null); });
  }
  emptyHTML() {
    return `<div class="se-icons">${AREA_ORDER.map(a => `<span style="--lc:${AREAS[a].color}">${svg(a, 26)}</span>`).join('')}</div>
      <div class="se-title">Делегируйте — не микро-менеджьте</div>
      <div class="se-text">Помощника-лейтенанта воплощает робот-командир поддержки (sACU): постройте его на заводе Т3, назначьте ему область (экономика, армия, авиация, флот, оборона) и передайте инженеров или заводы: выделите их и нажмите <kbd>Ctrl</kbd>+<kbd>H</kbd>.</div>
      <div class="se-text dim">Если sACU погибнет, помощник распускается, а его юниты и здания возвращаются к вам.</div>
      <div class="se-text dim">Помощник тратит только свою долю дохода, не видит сквозь туман и не трогает юнитов, которым вы отдали приказ.</div>
      <button class="lt-b primary big" data-act="empty-add">${svg('plus', 16)} Назначить первого помощника</button>
      ${this.staff && this.staff.freeSacu().length ? '' : `<div class="se-text warn">${NO_SACU}</div>`}`;
  }

  buildCard(lt) {
    const el = document.createElement('div');
    el.className = 'lt-card'; el.dataset.id = lt.id; el.style.setProperty('--lc', lt.A.color);
    const mil = lt.area !== 'eco';
    el.innerHTML = `
      <div class="lt-top">
        <div class="lt-ico">${svg(lt.area, 24)}</div>
        <div class="lt-id"><div class="lt-name">${esc(lt.name)}</div><div class="lt-sub"><span>${esc(lt.A.name)}</span><span class="lt-stl"></span><span class="lt-stl lt-body"></span></div></div>
        <div class="lt-state"><i class="lt-dot"></i><span class="lt-stt"></span></div>
        <button class="lt-fold" data-act="fold" data-tip="Свернуть / развернуть карточку">${svg('chev', 16)}</button>
      </div>
      <div class="lt-status"></div>
      <div class="lt-block hidden"></div>
      <div class="lt-tiles">
        <div class="tile" data-k="eng"><i>ИНЖЕНЕРЫ</i><b>0</b></div><div class="tile" data-k="facs"><i>ЗАВОДЫ</i><b>0</b></div>
        <div class="tile" data-k="combat"><i>БОЕВЫЕ</i><b>0</b></div><div class="tile" data-k="structs"><i>ЗДАНИЯ</i><b>0</b></div>
        <div class="tile warn" data-k="held"><i>ВРУЧНУЮ</i><b>0</b></div>
      </div>
      <div class="lt-zoneinfo hidden"></div>
      <div class="lt-meters">
        <div class="lt-meter m"><span class="mt-l">МАССА</span><div class="mt-bar"><div></div></div><span class="mt-v"></span></div>
        <div class="lt-meter e"><span class="mt-l">ЭНЕРГИЯ</span><div class="mt-bar"><div></div></div><span class="mt-v"></span></div>
      </div>
      <div class="lt-ctl">
        <label class="lt-bud" data-tip="Вес помощника при дележе дохода между помощниками (экономика получает приоритет). Новые проекты он не начнёт, если его расход выше доли; лишний запас на складе он тратит сверх неё."><span>БЮДЖЕТ</span><input type="range" min="10" max="100" step="5" value="${Math.round(lt.budget * 100)}" data-act="budget"><b>${Math.round(lt.budget * 100)}%</b></label>
        ${mil ? `<div class="seg lt-style">${Object.entries(STYLES).map(([k, s]) => `<button data-act="style" data-v="${k}" data-tip="${esc(STYLE_TIP[k])}">${esc(s.name)}</button>`).join('')}</div>` : ''}
      </div>
      <div class="lt-opts">
        <button class="lt-b tog" data-act="tfac" data-tip="Разрешить помощнику самому строить новые заводы (по мере роста дохода). Выключено — только то, что вы передали."></button>
        <button class="lt-b tog" data-act="tupg" data-tip="Улучшать экстракторы и заводы по тирам автоматически, пока хватает дохода и энергии."></button>
      </div>
      <div class="lt-btns">
        <button class="lt-b" data-act="pause"></button>
        <button class="lt-b" data-act="show" data-tip="Выделить всё, что принадлежит помощнику, и показать на карте">${svg('eye', 15)}<span>Показать</span></button>
        <span class="lt-zgrp"><button class="lt-b" data-act="zone" data-tip="Ограничить область: ЛКМ по карте или миникарте — центр, протяжка — радиус"><span class="zl"></span></button><button class="lt-b" data-act="clearzone" data-tip="Снять зону ответственности">✕</button></span>
        <button class="lt-b" data-act="give" data-tip="Передать выделенные юниты и здания этому помощнику (Ctrl+H — последнему)"></button>
        <button class="lt-b danger icon" data-act="recall" data-tip="Отозвать помощника: все его юниты и здания вернутся к вам"></button>
      </div>
      <div class="lt-log"><div class="lt-log5"></div><button class="lt-more" data-act="log"></button><div class="lt-logfull hidden"></div></div>`;
    const q = (s) => el.querySelector(s);
    const c = { el, lt: null, cache: {}, r: {
      blk: q('.lt-block'), tfac: q('[data-act="tfac"]'), tupg: q('[data-act="tupg"]'), stl: q('.lt-stl'), body: q('.lt-body'), dot: q('.lt-dot'), stt: q('.lt-stt'), status: q('.lt-status'), zoneinfo: q('.lt-zoneinfo'),
      mBar: q('.lt-meter.m .mt-bar div'), mVal: q('.lt-meter.m .mt-v'), eBar: q('.lt-meter.e .mt-bar div'), eVal: q('.lt-meter.e .mt-v'),
      pause: q('[data-act="pause"]'), zone: q('[data-act="zone"] .zl'), clear: q('[data-act="clearzone"]'), give: q('[data-act="give"]'), recall: q('[data-act="recall"]'),
      log5: q('.lt-log5'), full: q('.lt-logfull'), more: q('.lt-more'), bud: q('.lt-bud input'), budV: q('.lt-bud b'), styleBtns: [...el.querySelectorAll('[data-act="style"]')], tiles: {}
    } };
    for (const t of el.querySelectorAll('.tile')) c.r.tiles[t.dataset.k] = t;
    return c;
  }
  updateCard(lt, c, ents) {
    const r = c.r, ca = c.cache, s = lt.summary();
    const set = (k, el, v) => { if (ca[k] !== v) { ca[k] = v; el.textContent = v; } };
    const html = (k, el, v) => { if (ca[k] !== v) { ca[k] = v; el.innerHTML = v; } };
    set('stl', r.stl, ' · ' + lt.st.name);
    const sc = lt.sacu; set('body', r.body, sc ? ` · sACU #${sc.id} ${Math.round(sc.hp / sc.maxHp * 100)}%` : '');
    const none = !s.units && !s.structs, state = lt.paused ? 'pause' : none ? 'none' : lt.block ? 'wait' : /^Жду задач/.test(lt.status) ? 'idle' : 'work';
    if (ca.state !== state) { ca.state = state; c.el.dataset.state = state; r.stt.textContent = { pause: 'ПАУЗА', none: 'НЕТ ЮНИТОВ', idle: 'ПРОСТОЙ', wait: 'ЗАТЫК', work: 'РАБОТАЕТ' }[state]; }
    set('status', r.status, lt.status);
    // почему стоит: бюджет / энергия / нет инженеров / нет завода
    const bk = lt.paused || none ? null : lt.block;
    r.blk.classList.toggle('hidden', !bk); r.blk.dataset.kind = bk ? bk.kind : '';
    set('blk', r.blk, bk ? '⚠ ' + bk.text : '');
    for (const [k, on, t] of [['tfac', lt.allowFac, 'Заводы'], ['tupg', lt.autoUpg, 'Улучшения']]) {
      html(k, r[k], `<span class="tg-d"></span><span>${t}</span>`); r[k].classList.toggle('active', on);
    }
    r.tfac.style.display = lt.area === 'defense' ? 'none' : '';
    for (const k of ['eng', 'facs', 'combat', 'structs', 'held']) {
      const v = s[k]; if (ca['t' + k] !== v) { ca['t' + k] = v; r.tiles[k].querySelector('b').textContent = v; r.tiles[k].classList.toggle('zero', !v); }
    }
    r.tiles.combat.style.display = lt.area === 'eco' ? 'none' : '';
    r.tiles.held.style.display = s.held ? '' : 'none';
    // meters: smoothed spending vs the limit
    const A = lt.allow, D = lt.demAvg || { m: 0, e: 0 };
    const pct = (d, a) => Math.min(100, Math.round(d / Math.max(a, 0.5) * 100));
    const mp = pct(D.m, A.m), ep = pct(D.e, A.e);
    if (ca.mp !== mp) { ca.mp = mp; r.mBar.style.width = mp + '%'; r.mBar.parentNode.classList.toggle('over', D.m > A.m + 0.6); }
    if (ca.ep !== ep) { ca.ep = ep; r.eBar.style.width = ep + '%'; r.eBar.parentNode.classList.toggle('over', D.e > A.e + 6); }
    set('mv', r.mVal, `${D.m.toFixed(1)} / ${A.m.toFixed(1)} М/с`);
    set('ev', r.eVal, `${Math.round(D.e)} / ${Math.round(A.e)} Э/с`);
    // controls
    const bp = Math.round(lt.budget * 100);
    if (document.activeElement !== r.bud && +r.bud.value !== bp) { r.bud.value = bp; r.budV.textContent = bp + '%'; }
    for (const b of r.styleBtns) { const on = b.dataset.v === lt.style; if (b.classList.contains('on') !== on) b.classList.toggle('on', on); }
    html('pause', r.pause, lt.paused ? `${svg('play', 15)}<span>Продолжить</span>` : `${svg('pause', 15)}<span>Пауза</span>`);
    r.pause.classList.toggle('on', lt.paused);
    html('zl', r.zone, `${svg('zone', 15)}<span>Зона</span>`);
    r.zone.closest('.lt-b').classList.toggle('zoned', !!lt.zone);
    c.el.classList.toggle('folded', this.folded.has(lt.id));
    r.clear.classList.toggle('hidden', !lt.zone);
    if (lt.zone) { r.zoneinfo.classList.remove('hidden'); set('zi', r.zoneinfo, `Зона ответственности: (${Math.round(lt.zone.x)}, ${Math.round(lt.zone.y)}) · радиус ${Math.round(lt.zone.r)}`); }
    else r.zoneinfo.classList.add('hidden');
    const fit = ents.filter(e => e.lt !== lt.id).length;
    html('give', r.give, `${svg('give', 15)}<span>Передать${fit ? ` <b>${fit}</b>` : ''}</span>`);
    r.give.classList.toggle('ready', fit > 0);
    const sure = !!(this.confirm && this.confirm.id === lt.id && performance.now() < this.confirm.until);
    html('rc', r.recall, `${svg('recall', 15)}<span>${sure ? 'Точно отозвать?' : 'Отозвать'}</span>`);
    r.recall.classList.toggle('sure', sure);
    // log
    const open = this.logOpen.has(lt.id), sig = lt.logs.length + '|' + (lt.logs[0] ? lt.logs[0].t + lt.logs[0].text : '') + '|' + open;
    if (ca.log !== sig) {
      ca.log = sig;
      const row = (l, i) => `<div class="lg-row ${l.level}${l.x !== undefined ? ' go' : ''}" data-i="${i}"><span class="lg-t">${fmtT(l.t)}</span><span class="lg-c ${CAT_CLS[l.cat] || ''}">${esc(l.cat)}</span><span class="lg-x">${esc(l.text)}</span></div>`;
      r.log5.innerHTML = lt.logs.length ? lt.logs.slice(0, 5).map(row).join('') : '<div class="lg-row dim">Пока без решений — жду задач.</div>';
      r.full.innerHTML = open ? lt.logs.slice(5, 70).map((l, i) => row(l, i + 5)).join('') : '';
      r.full.classList.toggle('hidden', !open);
    }
    set('more', r.more, open ? 'Свернуть журнал ▴' : `Весь журнал (${lt.logs.length}) ▾`);
  }

  // ---------------------------------------------------------------- clicks
  onClick(e) {
    const row = e.target.closest('.lg-row.go');
    if (row) { const l = this.ltOf(row)?.logs[+row.dataset.i]; if (l && l.x !== undefined) this.ui.r.centerOn(l.x, l.y); return; }
    const b = e.target.closest('[data-act]');
    if (!b || !this.staff) return;
    const act = b.dataset.act;
    const lt = this.ltOf(b);
    const ui = this.ui;
    if (act === 'empty-add') { this.openPick(this.transferable().length > 0); }
    else if (act === 'fold' && lt) { if (this.folded.has(lt.id)) this.folded.delete(lt.id); else this.folded.add(lt.id); }
    else if (lt && this.cardAct(act, lt, b.dataset.v)) { /* pause / tfac / tupg / style / show / zone / clearzone / give */ }
    else if (act === 'log' && lt) { if (this.logOpen.has(lt.id)) this.logOpen.delete(lt.id); else this.logOpen.add(lt.id); this.cards.get(lt.id).cache.log = null; }
    else if (act === 'recall' && lt) {
      const now = performance.now();
      if (this.confirm && this.confirm.id === lt.id && now < this.confirm.until) { this.recallNow(lt); this.confirm = null; } else this.confirm = { id: lt.id, until: now + 4500 };
    }
    else if (act === 'pk-back') { this.view = 'list'; }
    else if (act === 'pk-area') { if (this.pickArea(this.pick, b.dataset.v)) this.renderPick(); return; }
    else if (act === 'pk-sacu') { this.pick.sacu = +b.dataset.v; this.renderPick(); return; }
    else if (act === 'pk-style') { this.pick.style = b.dataset.v; this.renderPick(); return; }
    else if (act === 'pk-ok') { this.confirmPick(); return; }
    if (b.tagName === 'BUTTON') b.blur();
    this.render(true);
  }
  // Card actions shared by the PC window and the VR HQ screen (js/vrstaff.js); v = style key. Returns false for an unknown action.
  cardAct(act, lt, v) {
    if (act === 'pause') { lt.paused = !lt.paused; lt.say('ПРИКАЗ', lt.paused ? 'Работа приостановлена игроком.' : 'Работа возобновлена.'); }
    else if (act === 'tfac') { lt.allowFac = !lt.allowFac; lt.say('ПРИКАЗ', lt.allowFac ? 'Строить заводы самому: разрешено.' : 'Строить заводы самому: запрещено.'); }
    else if (act === 'tupg') { lt.autoUpg = !lt.autoUpg; lt.say('ПРИКАЗ', lt.autoUpg ? 'Улучшать экстракторы и заводы автоматически: включено.' : 'Автоматические улучшения выключены.'); }
    else if (act === 'show') this.show(lt);
    else if (act === 'zone') this.zoneStart(lt);
    else if (act === 'clearzone') lt.setZone(null);
    else if (act === 'give') this.give(lt);
    else if (act === 'style' && STYLES[v]) { lt.style = v; lt.retreatK = lt.st.retreatK; lt.say('ПРИКАЗ', `Стиль: «${lt.st.name}».`); }
    else return false;
    return true;
  }
  // Budget weight in percent, 10..100 (the slider of the card).
  setBudget(lt, pct) { lt.budget = Math.max(10, Math.min(100, Math.round(pct))) / 100; }
  // Dismiss without the confirmation step (the caller asked already).
  recallNow(lt) {
    const n = lt.summary(); this.staff.dismiss(lt);
    this.ui.flash(`Помощник «${lt.name}» отозван: ${n.units} ед. и ${n.structs} зд. возвращены вам`, true);
  }
  show(lt) {
    const ui = this.ui;
    const ents = [...lt.allUnits, ...lt.ownStructs];
    let c = null;
    if (ents.length) { c = ui.centroid(ents); ui.selection = ents.filter(e => e.alive); ui.refreshPanels(true); }
    else if (lt.zone) c = lt.zone;
    if (c) ui.r.centerOn(c.x, c.y);
    else ui.flash('У помощника пока нет юнитов — передайте ему что-нибудь', true);
  }

  // ---------------------------------------------------------------- "assign a lieutenant" view
  openPick(give, area = null) {
    this.toggle(true);
    this.pick = this.newPick(give, area);
    this.view = 'pick'; this.render(true);
  }
  // Pick state of a new lieutenant {area, style, budget %, give, sacu id}: the selected free sACU first (also js/vrstaff.js).
  newPick(give, area = null) {
    const sel = this.ui.selection.find(e => e.key === 'sacu' && e.ltHead === undefined && e.alive);
    return { area, style: 'balanced', budget: area ? Math.round(AREAS[area].budget * 100) : 50, give: !!give, sacu: sel ? sel.id : null };
  }
  areaOff(a) { const g = this.g; return !!AREAS[a].needsWater && !(g && g.map.naval); }
  // Choose an area: its default budget. False when the area is not available on this map.
  pickArea(P, a) { if (!AREAS[a] || this.areaOff(a)) return false; P.area = a; P.budget = Math.round(AREAS[a].budget * 100); return true; }
  // The sACU the pick will use: the chosen one if still free, else the first free one. Returns the free list.
  pickSacu(P) { const free = this.staff.freeSacu(); if (!free.some(u => u.id === P.sacu)) P.sacu = free.length ? free[0].id : null; return free; }
  renderPick() {
    const P = this.pick, n = this.transferable().length, free = this.pickSacu(P);
    const tile = (a) => {
      const A = AREAS[a], off = this.areaOff(a);
      return `<button class="pk-tile${P.area === a ? ' on' : ''}${off ? ' off' : ''}" data-act="pk-area" data-v="${a}" style="--lc:${A.color}">
        <div class="pk-ico">${svg(a, 30)}</div>
        <div class="pk-t"><b>${A.name}</b><span>${off ? 'На этой карте нет воды' : esc(A.desc)}</span></div>
        <ul>${A.does.map(x => `<li>${esc(x)}</li>`).join('')}</ul></button>`;
    };
    const A = P.area ? AREAS[P.area] : null;
    $('staff-pick').innerHTML = `
      <div class="pk-top"><button class="lt-b" data-act="pk-back">← К списку</button><span>Выберите область ответственности</span></div>
      <div class="pk-sacu${free.length ? '' : ' none'}">${free.length ? `<span class="pk-l">КОМАНДИР ПОДДЕРЖКИ</span>${free.map(u => `<button class="lt-b${u.id === P.sacu ? ' primary' : ''}" data-act="pk-sacu" data-v="${u.id}" data-tip="Помощник воплощается в этом роботе: если он погибнет, помощник распускается">sACU #${u.id} · ${Math.round(u.hp / u.maxHp * 100)}%</button>`).join('')}` : esc(NO_SACU)}</div>
      <div class="pk-grid">${AREA_ORDER.map(tile).join('')}</div>
      <div class="pk-opts" style="--lc:${A ? A.color : 'var(--accent)'}">${A ? `
        <div class="pk-row"><div class="seg">${Object.entries(STYLES).map(([k, s]) => `<button data-act="pk-style" data-v="${k}" class="${P.style === k ? 'on' : ''}" data-tip="${esc(STYLE_TIP[k])}">${esc(s.name)}</button>`).join('')}</div>
          <label class="lt-bud"><span>БЮДЖЕТ</span><input type="range" min="10" max="100" step="5" value="${P.budget}" id="pk-budget"><b id="pk-budget-v">${P.budget}%</b></label></div>
        <div class="pk-hint">${esc(A.give)}</div>
        <div class="pk-row"><label class="pk-give"><input type="checkbox" id="pk-give" ${P.give && n ? 'checked' : ''} ${n ? '' : 'disabled'}> <span id="pk-give-t"></span></label>
          <button class="lt-b primary big${free.length ? '' : ' dim'}" data-act="pk-ok">Назначить: ${A.name}</button></div>` : '<div class="pk-hint center">Нажмите на плитку области — затем настройте стиль и бюджет.</div>'}</div>`;
    const bud = $('pk-budget');
    if (bud) { bud.oninput = () => { this.pick.budget = +bud.value; $('pk-budget-v').textContent = bud.value + '%'; }; bud.onchange = () => bud.blur(); }
    const gv = $('pk-give'); if (gv) gv.onchange = () => { this.pick.give = gv.checked; gv.blur(); };
    this.pickBuilt = true; this.updatePickCount();
  }
  updatePickCount() {
    const t = $('pk-give-t'); if (!t) return;
    const n = this.transferable().length;
    t.textContent = n ? `Сразу передать выделенное (${n})` : 'Ничего не выделено — передать можно позже';
    const gv = $('pk-give'); if (gv) gv.disabled = !n;
  }
  confirmPick() {
    const P = this.pick; if (!P.area) return;
    const gv = $('pk-give');
    this.createFrom(P, gv && gv.checked ? this.transferable() : []);
  }
  // Create a lieutenant from a pick and hand `ents` to it (PC window and VR HQ screen). Returns the lieutenant or null.
  createFrom(P, ents) {
    if (!P.area) return null;
    const sacu = this.staff.freeSacu().find(u => u.id === P.sacu);
    const r = this.staff.create(P.area, { style: P.style, budget: P.budget / 100, sacu });
    if (!r.ok) { this.ui.flash(r.why); return null; }
    this.justAdded = r.lt.id; this.view = 'list';
    this.ui.audio.play('ui');
    if (ents.length) this.give(r.lt, ents);
    else this.ui.flash(`Назначен «${r.lt.name}» — ${AREAS[P.area].name}. ${AREAS[P.area].give}`, true);
    this.render(true);
    return r.lt;
  }

  // ---------------------------------------------------------------- selection bar (floating above the selection panel)
  updateSelbar() {
    const bar = $('staff-selbar'), st = this.staff, ui = this.ui;
    const ents = this.transferable();
    if (!st || !ents.length || !ui.canCommand) { bar.classList.add('hidden'); return; }
    const owned = ents.filter(e => e.lt !== undefined), names = new Set(owned.map(e => e.lt));
    const who = names.size === 1 ? st.get([...names][0]) : null;
    const sig = ents.length + '|' + owned.length + '|' + (who ? who.id : names.size) + '|' + st.list.length;
    if (bar.dataset.sig !== sig) {
      bar.dataset.sig = sig;
      const info = owned.length ? (who ? `Под управлением: <b style="color:${who.A.color}">${esc(who.name)}</b>${owned.length < ents.length ? ` (${owned.length} из ${ents.length})` : ''}` : `${owned.length} из ${ents.length} у помощников`) : `${ents.length} ${plural(ents.length, ['объект', 'объекта', 'объектов'])} выделено`;
      bar.innerHTML = `<span class="sb-ico">${svg('staff', 16)}</span><span class="sb-t">${info}</span>
        <button data-act="give" class="lt-b primary">Передать помощнику ▸ <kbd>Ctrl+H</kbd></button>${owned.length ? '<button data-act="take" class="lt-b">Забрать себе</button>' : ''}`;
    }
    bar.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- zone drawing (map or minimap)
  zoneStart(lt) {
    this.zoneEdit = { lt, x: 0, y: 0, r: 0, active: false };
    this.ui.setMode('zone');
    $('mode-hint').textContent = `Зона «${lt.name}»: ЛКМ по карте или миникарте — центр, протяжка — радиус, клик — радиус 120. ПКМ / Esc — отмена`;
  }
  zoneCancel() { if (this.zoneEdit) { this.zoneEdit = null; if (this.ui.mode === 'zone') this.ui.setMode(null); } }
  pointerGround(e, src) {
    if (src === 'mm') { const r = $('minimap').getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * MAP_SIZE, y: (e.clientY - r.top) / r.height * MAP_SIZE }; }
    const r = this.ui.r.overlay.getBoundingClientRect();
    return this.ui.r.screenToGround(e.clientX - r.left, e.clientY - r.top);
  }
  zoneDown(e) {
    const z = this.zoneEdit; if (!z || this.ui.mode !== 'zone') return;
    const onMm = !!e.target.closest && !!e.target.closest('#minimap'), onMap = e.target === this.ui.r.overlay;
    if (!onMm && !onMap) return;
    if (e.button === 2) { if (onMm) { e.stopImmediatePropagation(); this.zoneCancel(); } return; } // on the map ui.js cancels the mode itself
    if (e.button !== 0) return;
    const p = this.pointerGround(e, onMm ? 'mm' : 'map'); if (!p) return;
    e.stopImmediatePropagation(); e.preventDefault();
    this.zoneAt(p, onMm ? 'mm' : 'map');
  }
  zoneMove(e) {
    const z = this.zoneEdit; if (!z || !z.active) return;
    const p = this.pointerGround(e, z.src); if (p) this.zoneDrag(p);
  }
  zoneUp(e) { if (e.button === 0) this.zoneFinish(); }
  // Zone drawing steps in ground coordinates {x, y} (the mouse here, the VR laser in js/vrstaff.js).
  zoneAt(p, src) { const z = this.zoneEdit; if (z) Object.assign(z, { x: p.x, y: p.y, r: 0, active: true, src, moved: false }); }
  zoneDrag(p) { const z = this.zoneEdit; if (!z || !z.active) return; z.r = Math.hypot(p.x - z.x, p.y - z.y); if (z.r > 12) z.moved = true; }
  zoneFinish() {
    const z = this.zoneEdit; if (!z || !z.active) return;
    z.active = false;
    const r = zoneR(z);
    const lt = z.lt; this.zoneEdit = null;
    this.ui.setMode(null);
    if (this.staff && this.staff.get(lt.id)) { lt.setZone({ x: z.x, y: z.y, r }); this.ui.flash(`Зона задана: «${lt.name}» — радиус ${Math.round(lt.zone.r)}`, true); this.ui.audio.play('ui'); this.render(true); }
  }

  // ---------------------------------------------------------------- selection panel markers (called from ui.js)
  badge(e) {
    if (!this.staff || e.lt === undefined) return '';
    const lt = this.staff.get(e.lt); if (!lt) return '';
    const man = e.ltMan && e.ltMan.until > this.g.time;
    return `<span class="lt-badge${man ? ' manual' : ''}" style="--lc:${lt.A.color}" data-tip="Под управлением помощника «${esc(lt.name)}» (${esc(lt.A.name)}).<br>${man ? 'Сейчас вы командуете вручную — помощник не вмешивается, пока приказ не выполнен.' : 'Отдайте приказ вручную — помощник временно отступит.'}">${svg(lt.area, 12)}<span>${esc(lt.name.replace('Лейтенант ', ''))}${man ? ' · вручную' : ''}</span></span>`;
  }
  cellMark(c) {
    if (!c.lt) return '';
    return `<i class="lt-cell-mark${c.lt === c.n ? '' : ' part'}" data-tip="${c.lt === c.n ? 'Все под управлением помощников' : c.lt + ' из ' + c.n + ' под управлением помощников'}">⚑</i>`;
  }

  // ---------------------------------------------------------------- drawing hooks
  // On-map: zones as translucent discs on the terrain.
  drawZones(c, R, game) {
    const st = this.staff; if (!st) return;
    const t = game.terrain, hi = this.hover;
    const zones = st.list.filter(l => l.zone).map(l => ({ lt: l, z: l.zone }));
    if (this.zoneEdit && this.zoneEdit.active) zones.push({ lt: this.zoneEdit.lt, z: { x: this.zoneEdit.x, y: this.zoneEdit.y, r: zoneR(this.zoneEdit) }, edit: true });
    for (const { lt, z, edit } of zones) {
      const col = lt.A.color, on = edit || hi === lt.id || this.open;
      const pts = [];
      for (let i = 0; i < 56; i++) {
        const a = i / 56 * Math.PI * 2, x = z.x + Math.cos(a) * z.r, y = z.y + Math.sin(a) * z.r;
        const p = R.project(x, y, t.surfaceAt(Math.max(1, Math.min(MAP_SIZE - 1, x)), Math.max(1, Math.min(MAP_SIZE - 1, y))) + 0.6);
        if (!p.ok) { pts.length = 0; break; }
        pts.push(p);
      }
      if (pts.length < 3) continue;
      c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath();
      c.fillStyle = rgba(col, edit ? 0.16 : hi === lt.id ? 0.14 : on ? 0.09 : 0.05); c.fill();
      c.lineWidth = hi === lt.id || edit ? 2.6 : 1.8; c.strokeStyle = rgba(col, on ? 0.95 : 0.55); c.setLineDash([9, 6]); c.stroke(); c.setLineDash([]);
      if (on) {
        const top = pts.reduce((a, b) => (b.y < a.y ? b : a));
        c.font = '700 12px Rajdhani, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
        const txt = `${lt.A.short} · ${lt.name.replace('Лейтенант ', '')}`;
        const w = c.measureText(txt).width + 12;
        c.fillStyle = 'rgba(6,12,18,0.85)'; c.fillRect(top.x - w / 2, top.y - 20, w, 16);
        c.strokeStyle = rgba(col, 0.8); c.lineWidth = 1; c.strokeRect(top.x - w / 2, top.y - 20, w, 16);
        c.fillStyle = col; c.fillText(txt, top.x, top.y - 8);
      }
    }
  }
  // Marker on an owned unit / structure (strategic icons always, close view only when selected / highlighted / window open).
  markEntity(c, e, p, iconMode, selected) {
    const st = this.staff; if (!st) return;
    const lt = st.get(e.lt); if (!lt) return;
    const hi = this.hover === lt.id;
    if (!iconMode && !selected && !hi && !this.open) return;
    const col = lt.A.color, manual = e.ltMan && e.ltMan.until > this.g.time;
    const x = iconMode ? p.x + 9 : p.x + 14, y = iconMode ? p.y - 6 : p.y - 8, s = hi ? 5.6 : 4.4;
    c.beginPath(); c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y); c.closePath();
    c.lineWidth = 1.4; c.strokeStyle = 'rgba(4,10,16,0.95)';
    if (manual) { c.fillStyle = 'rgba(4,10,16,0.7)'; c.fill(); c.strokeStyle = '#ffb040'; c.lineWidth = 1.6; c.stroke(); }
    else { c.fillStyle = col; c.fill(); c.stroke(); }
    if (hi) { c.beginPath(); c.arc(p.x, p.y + (iconMode ? 6 : 0), 14, 0, 6.28); c.strokeStyle = rgba(col, 0.8); c.lineWidth = 1.5; c.stroke(); }
  }
  drawMinimap(ctx, k) {
    const st = this.staff; if (!st) return;
    for (const lt of st.list) {
      const col = lt.A.color;
      if (lt.zone) {
        ctx.beginPath(); ctx.arc(lt.zone.x * k, lt.zone.y * k, lt.zone.r * k, 0, 6.28);
        ctx.fillStyle = rgba(col, this.hover === lt.id ? 0.32 : 0.2); ctx.fill();
        ctx.strokeStyle = rgba(col, 0.95); ctx.lineWidth = 1.4; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      for (const u of lt.allUnits) ctx.strokeRect(u.x * k - 2.5, u.y * k - 2.5, 5, 5);
      for (const s of lt.ownStructs) { const h = Math.max(3.5, s.spec.size * k / 2 + 1.5); ctx.strokeRect(s.x * k - h, s.y * k - h, h * 2, h * 2); }
    }
    const z = this.zoneEdit;
    if (z && z.active) {
      const col = z.lt.A.color, r = zoneR(z);
      ctx.beginPath(); ctx.arc(z.x * k, z.y * k, r * k, 0, 6.28); ctx.fillStyle = rgba(col, 0.25); ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke();
    }
  }
}
