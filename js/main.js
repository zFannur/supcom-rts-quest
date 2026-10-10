import './xremu.js';
// Bootstrap: menus, settings, match setup and the fixed-timestep game loop.
import { Renderer } from './render.js';
import { Audio } from './audio.js';
import { Music } from './music.js';
import { GameUI } from './ui.js';
import { Game } from './sim.js';
import { AICommander, STRATEGIES, loadLTM, resetLTM } from './ai.js';
import { Staff } from './lieutenant.js'; // delegated sub-commanders (Штаб)
import { MAPS, MAP_LIST, MAP_SIZE, massCount } from './maps.js';
import { GEN_TYPES, genNorm, genKey, genRandomSeed, genPreview, generateMap, mapOf } from './mapgen.js'; // случайные карты
import { Terrain } from './terrain.js';
import { DT, TEAM_CSS, PLAYER_COLORS, setTeamColor } from './specs.js';
import { loadGLB } from './models.js';
import { loadStrategyNet } from './stratnet.js';
import { loadUniversalNet } from './unet.js';
import { loadCombatNet } from './combatnet.js'; // сеть «бой или отход» (ml/models/combat_v1.json); нет файла — игра остаётся на эвристике
import { generateThumbs } from './thumbs.js';
import { CAMO_PATTERNS, CAMO_PALETTES, CAMO_DEFAULT_CUSTOM, camoLook, camoRandom } from './camo.js';
import { VRSystem } from './vr.js';
import { LITE, LITE_SETTINGS } from './quest.js';
import { hasServer, localSaves, localSave, localLoad } from './store.js'; // без run.py (GitHub Pages / PWA): сохранения в IndexedDB

await loadGLB(); // Blender-модели (assets/models/*.glb)
loadCombatNet(); // не ждём: грузится в фоне
loadStrategyNet(); // стратегическая модель (ml/models/strategy_v1.json): макро-решения ИИ; нет файла — ИИ без неё
loadUniversalNet(); // сложность «Нейросеть»: универсальный командир (ml/models/universal_v1.json); нет файла — ИИ играет как «Нормальный»

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (t) => { const d = new Date(t); return t ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '—'; };
const fmtT = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

const DEFAULTS = {
  pixelRatio: 1.5, shadows: true, shadowRes: 2048, bloom: true, particles: 2, healthBars: 1, iconDist: 340,
  unitThoughts: true, edgeScroll: true, panSpeed: 1, zoomSpeed: 1, volume: 0.6, sound: true, music: true, musicVolume: 0.5,
  autonomy: 'full', autoOC: false, gameSpeed: 1
};
const load = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch (e) { return { ...d }; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

// ------------------------------------------------------------------ лобби: слоты игроков
// слот: ai — ведёт ИИ (слот 0 — человек, пока не выбран «Наблюдатель»); color — индекс PLAYER_COLORS; team — союз (0 — без союзников);
// start — 0 авто / 1..N; camo/pal — камуфляж техники и зданий ('random' — случайный при старте); diff/doctrine — для ИИ
const AI_NAMES = ['Аякс', 'Борей', 'Вега', 'Гром'], DIFFS = [['easy', 'Лёгкий'], ['normal', 'Нормальный'], ['hard', 'Сложный (×1.25)'], ['nightmare', 'Кошмар (×1.6, всевидящий)'], ['neural', 'Нейросеть (экспериментально)']];
const newSlot = (i, o = {}) => ({ ai: i > 0, color: i, team: 0, start: 0, camo: i ? 'random' : 'team', pal: i ? 'random' : 'green', custom: CAMO_DEFAULT_CUSTOM, diff: 'normal', doctrine: 'adaptive', ...o });
const aiName = (i) => `ИИ «${AI_NAMES[i]}»`;
// списки значений полей слота: общие для ПК-лобби (select) и VR-меню (шаги ◀ ▶)
const DOC_OPTS = [['adaptive', 'Адаптивная (UCB1)'], ...Object.entries(STRATEGIES).map(([k, s]) => [k, s.name])];
const PAT_OPTS = [['random', 'Случайный'], ...Object.entries(CAMO_PATTERNS).map(([k, v]) => [k, v[0]])];
const PAL_OPTS = [['random', 'Случайный'], ...Object.entries(CAMO_PALETTES).map(([k, v]) => [k, v[0]]), ['custom', 'Свой цвет']];
const TEAM_OPTS = [[0, '—'], [1, 1], [2, 2], [3, 3], [4, 4]];
const hexOf = c => '#' + c.getHexString();
const OLD_PAL = { forest: 'green', desert: 'sand', winter: 'white', urban: 'gray', khaki: 'brown', custom: 'custom' };
/** Старый формат (mode/doctrine/doctrine2/difficulty/camoU/camoPal/camoCustom) -> { slots }. */
function migrate(o) {
  if (Array.isArray(o.slots)) return o;
  const obs = o.mode === 'aivai', d = o.difficulty || 'normal';
  const s0 = newSlot(0, { ai: obs, camo: o.camoU || 'team', pal: OLD_PAL[o.camoPal] || 'green', custom: Array.isArray(o.camoCustom) ? o.camoCustom[0] : CAMO_DEFAULT_CUSTOM, diff: d, doctrine: obs ? o.doctrine : 'adaptive' });
  return { ...o, slots: [s0, newSlot(1, { diff: d, doctrine: (obs ? o.doctrine2 : o.doctrine) || 'adaptive' })] };
}
/** Приводит слоты к допустимому виду: 2..4 слота, уникальные цвета и старты, известные ключи. */
function sanitize(sl, nStarts = 4) {
  sl = (Array.isArray(sl) ? sl : []).slice(0, 4).map((s, i) => ({ ...newSlot(i), ...s }));
  while (sl.length < 2) sl.push(newSlot(sl.length));
  const used = new Set(), usedS = new Set();
  sl.forEach((s, i) => {
    s.ai = i > 0 || !!s.ai;
    if (!(s.color >= 0 && s.color < PLAYER_COLORS.length) || used.has(s.color)) s.color = PLAYER_COLORS.findIndex((_, c) => !used.has(c));
    used.add(s.color);
    s.team = [1, 2, 3, 4].includes(+s.team) ? +s.team : 0;
    s.start = +s.start >= 1 && +s.start <= nStarts && !usedS.has(+s.start) ? +s.start : 0; usedS.add(s.start);
    if (s.camo !== 'random' && !CAMO_PATTERNS[s.camo]) s.camo = i ? 'random' : 'team';
    if (s.pal !== 'random' && s.pal !== 'custom' && !CAMO_PALETTES[s.pal]) s.pal = i ? 'random' : 'green';
    if (!/^#[0-9a-f]{6}$/i.test(s.custom)) s.custom = CAMO_DEFAULT_CUSTOM;
    if (!DIFFS.some(d => d[0] === s.diff)) s.diff = 'normal';
    if (s.doctrine !== 'adaptive' && !STRATEGIES[s.doctrine]) s.doctrine = 'adaptive';
    if (s.rolled && !(CAMO_PATTERNS[s.rolled.pattern] && CAMO_PALETTES[s.rolled.pal])) delete s.rolled;
  });
  return sl;
}
function loadSetup() {
  let o = {}; try { o = migrate(JSON.parse(localStorage.getItem('supcom3d_setup') || '{}')); } catch (e) { o = {}; }
  const gen = genNorm(o.gen || { seed: genRandomSeed() }), map = o.map === 'gen' || MAPS[o.map] ? o.map : 'dualgap';   // gen — параметры случайной карты (всегда есть), genId — какая сохранённая карта выбрана
  return { map, gen, genId: o.map === 'gen' && typeof o.genId === 'string' ? o.genId : '', fog: o.fog !== false, victory: o.victory === 'annihilation' ? 'annihilation' : 'assassination', unitCap: [250, 500, 1000].includes(+o.unitCap) ? +o.unitCap : LITE ? 250 : 1000, slots: sanitize(o.slots, map === 'gen' ? gen.players : MAPS[map].starts.length) };
}
const persist = () => save('supcom3d_setup', setup);

const settings = load('supcom3d_settings', DEFAULTS);
if (LITE) Object.assign(settings, LITE_SETTINGS);   // Quest: облегчённый профиль поверх сохранённых настроек
const setup = loadSetup();

const renderer = new Renderer($('gl'), $('overlay'), settings);
/** Цвета команд (specs.setTeamColor) и камуфляж техники/зданий каждого слота; «Случайный» бросается один раз и запоминается в слоте. Возвращает ключ внешнего вида (для пересборки иконок). */
function applyLobby(slots) {
  slots.forEach((s, i) => { const c = PLAYER_COLORS[s.color]; setTeamColor(i + 1, c[1], c[2]); });
  renderer.refreshTeamColors();
  const taken = slots.filter(s => s.camo !== 'team' && CAMO_PALETTES[s.pal]).map(s => s.pal), key = [];
  slots.forEach((s, i) => {
    let pat = s.camo, pal = s.pal;
    if (pat === 'random' || pal === 'random') {
      s.rolled = s.rolled || camoRandom(taken);
      if (pat === 'random') pat = s.rolled.pattern;
      if (pal === 'random') { pal = s.rolled.pal; taken.push(pal); }
    }
    const look = camoLook(pat, pal, s.custom);
    for (const k of ['unit', 'struct']) renderer.setCamo(k, i + 1, look);
    key.push(s.color, pat, pal, pal === 'custom' ? s.custom : '');
  });
  return key.join() + '|' + slots.length;
}
const genIcons = (ids) => generateThumbs(renderer, LITE ? ids.slice(0, 1) : ids, LITE ? { lite: true } : undefined);   // Quest: миниатюры для панели VR (11.9.5) — только команда 1, по одной модели за простой, бюджет ~6 мс
let thumbKey = applyLobby(sanitize(setup.slots)), thumbsP = genIcons(setup.slots.map((_, i) => i + 1)); // HUD model icons, rendered incrementally in the background
const audio = new Audio(), music = new Music();
audio.music = music;
const applyAudio = () => { audio.setVolume(settings.volume); audio.enabled = settings.sound; music.setVolume(settings.musicVolume ?? 0.5); music.setEnabled(settings.music !== false); };
applyAudio();
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => music.unlock(), { capture: true, passive: true });   // autoplay: music after the first gesture
let gameGen = 0;   // растёт при каждом построенном матче (VR-меню ждёт его на экране «загрузка»)
let game = null, ais = [], staff = null, acc = 0, menuOpen = true, sysPaused = false, overShown = false, lastConfig = null;
const terrainFor = (map) => map._T || (map._T = new Terrain(map));

const ui = new GameUI(renderer, audio, settings, {
  pauseMenu: () => togglePauseMenu(),
  menuOpen: () => menuOpen,
  quickSave: () => saveGame('quick'),
  quickLoad: () => loadGame('quick')
});

const vr = new VRSystem(renderer, ui, {
  pauseMenu: () => vr.menu.toggle(),   // в VR пауза — трёхмерное меню, не DOM
  sessionEnd: () => vrSessionEnd()
});
renderer.setVR(vr);

window.addEventListener('resize', () => renderer.resize());

// ------------------------------------------------------------------ screens
function show(id, on = true) { $(id).classList.toggle('hidden', !on); }
function showMenu() {
  menuOpen = true; game = null; ais = []; staff = null; ui.game = null; ui.staffUI.setStaff(null);
  show('hud', false); show('menu'); show('newgame', false); show('gameover', false); show('pause', false);
  renderer.localTeam = 0;
  previewMap(mapOf(setup));
}
function previewMap(map) {
  const t = terrainFor(map);
  if (renderer.terrain !== t) { renderer.loadTerrain(t); renderer.view.dist = renderer.view.tdist = 1040; }
}

// 1 world unit = 2.5 m; shown to the nearest half kilometre (2048 -> 5)
const mapKm = (size) => +(Math.round(size * 2.5 / 500) / 2).toString();

const mapBases = new WeakMap();
function mapBase(map) {   // карта без стартов (кэш): прямо из функции высот, строить весь Terrain ради превью не нужно
  if (mapBases.has(map)) return mapBases.get(map);
  const N = 200, c = document.createElement('canvas'); c.width = c.height = N;
  const ctx = c.getContext('2d'), img = ctx.createImageData(N, N), pal = map.palette, H = new Float32Array(N * N), at = (i, j) => H[Math.max(0, Math.min(N - 1, j)) * N + Math.max(0, Math.min(N - 1, i))], e = 2 * MAP_SIZE / N;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = map.height((i + 0.5) / N * MAP_SIZE, (j + 0.5) / N * MAP_SIZE);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const h = H[j * N + i], gx = (at(i + 1, j) - at(i - 1, j)) / e, gy = (at(i, j + 1) - at(i, j - 1)) / e;
    const sh = Math.max(0.4, Math.min(1.4, 1 - gx * 1.3 - gy));
    let col = h < map.water ? [0.1, 0.32, 0.48] : pal.low.map((v, n) => (v + (pal.high[n] - v) * Math.min(1, Math.max(0, (h - 15) / 55))) * sh);
    if (h >= map.water && h > pal.peakH) col = pal.peak.map(v => v * sh);
    const o = (j * N + i) * 4; img.data[o] = col[0] * 255; img.data[o + 1] = col[1] * 255; img.data[o + 2] = col[2] * 255; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (const m of map.mass) { if (map.height(m.x, m.y) <= map.water + 1.5) continue; ctx.fillStyle = '#3cff78'; ctx.fillRect(m.x / MAP_SIZE * N - 1.2, m.y / MAP_SIZE * N - 1.2, 3, 3); }
  mapBases.set(map, c);
  return c;
}
function mapPreviewCanvas(map, marks = []) {   // marks[i] — цвет слота, занявшего старт i
  const b = mapBase(map), N = b.width, k = N / 160, c = document.createElement('canvas'); c.width = c.height = N;
  const ctx = c.getContext('2d'); ctx.drawImage(b, 0, 0);
  map.starts.forEach((s, i) => { ctx.fillStyle = marks[i] || '#8a9aa6'; ctx.beginPath(); ctx.arc(s.x / MAP_SIZE * N, s.y / MAP_SIZE * N, 5 * k, 0, 6.28); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.fillStyle = marks[i] ? '#000' : '#fff'; ctx.font = `bold ${8 * k}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText(i + 1, s.x / MAP_SIZE * N, s.y / MAP_SIZE * N + 3 * k); });
  return c;
}

// ------------------------------------------------------------------ лобби «Новая игра»
let selSlot = 0, swOpen = -1;   // выбранный слот (старт кликом по карте), слот с открытой палитрой цвета
const optH = (arr, cur) => arr.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('');
const lobbyMap = () => setup.map === 'gen' ? genPreview(setup.gen) : MAPS[setup.map];   // для лобби: у случайной — черновик/уже проверенная карта
const nStartsOf = () => lobbyMap().starts.length;
function assignStart(i, v) {   // занятый другим слотом старт меняется местами
  const sl = setup.slots, old = sl[i].start; if (v && v === old) v = 0;
  const o = v && sl.find((s, k) => k !== i && s.start === v); if (o) o.start = old;
  sl[i].start = v;
}
const startOpts = (nS) => [[0, 'Авто'], ...Array.from({ length: nS }, (_, n) => [n + 1, n + 1])];
/** Одно поле слота (ПК и VR одинаково): ai ('o' — наблюдатель), start (обмен с занявшим), color (обмен с занявшим), прочее — как есть. */
function setSlotField(i, f, v) {
  const sl = setup.slots, s = sl[i];
  if (f === 'ai') s.ai = v === 'o' || v === true;
  else if (f === 'start') assignStart(i, +v);
  else if (f === 'color') { const o = sl.find((x, k) => k !== i && x.color === +v); if (o) o.color = s.color; s.color = +v; }
  else s[f] = f === 'team' ? +v : v;
}
function renderLobby() {
  const sl = setup.slots, nS = nStartsOf();
  const docO = DOC_OPTS, patO = PAT_OPTS, palO = PAL_OPTS, startO = startOpts(nS), teamO = TEAM_OPTS, hex = hexOf;
  let h = '<div class="ls-row ls-head"><span>ИГРОК</span><span>ЦВЕТ</span><span>КОМАНДА</span><span>СТАРТ</span><span>КАМУФЛЯЖ</span><span>ЦВЕТ КАМУФЛЯЖА</span><span>СЛОЖНОСТЬ</span><span>ДОКТРИНА</span><span></span></div>';
  sl.forEach((s, i) => {
    const pc = PLAYER_COLORS[s.color], ai = s.ai;
    const who = i === 0 ? `<select data-f="ai">${optH([['h', 'Вы'], ['o', 'Наблюдатель']], ai ? 'o' : 'h')}</select>` : `<span class="ls-name">${aiName(i)}</span>`;
    const pop = swOpen === i ? `<div class="sw-pop">${PLAYER_COLORS.map((c, ci) => `<button class="sw${ci === s.color ? ' cur' : ''}${sl.some((o, k) => k !== i && o.color === ci) ? ' used' : ''}" data-pick="${ci}" title="${c[0]}" style="background:${c[2]}"></button>`).join('')}</div>` : '';
    const pal = s.pal === 'custom' ? `<input type="color" data-f="custom" value="${s.custom}" title="Свой цвет камуфляжа">`
      : CAMO_PALETTES[s.pal] ? `<span class="ls-chips">${camoLook('khaki', s.pal).cols.map(c => `<i style="background:${hex(c)}"></i>`).join('')}</span>` : '';
    h += `<div class="ls-row${i === selSlot ? ' sel' : ''}" data-i="${i}">${who}
      <div class="sw-wrap"><button class="sw" data-sw="1" title="${pc[0]}" style="background:${pc[2]}"></button>${pop}</div>
      <select data-f="team">${optH(teamO, s.team)}</select><select data-f="start">${optH(startO, s.start)}</select>
      <select data-f="camo">${optH(patO, s.camo)}</select>
      <div class="ls-pal"><select data-f="pal"${s.camo === 'team' ? ' disabled' : ''}>${optH(palO, s.pal)}</select>${s.camo === 'team' ? '' : pal}</div>
      ${ai ? `<select data-f="diff">${optH(DIFFS, s.diff)}</select><select data-f="doctrine">${optH(docO, s.doctrine)}</select>` : '<span class="ls-na">—</span><span class="ls-na">—</span>'}
      ${sl.length > 2 && i > 0 ? '<button class="ls-x" data-x="1" title="Убрать слот">✕</button>' : '<span></span>'}</div>`;
  });
  $('lobby-slots').innerHTML = h;
  $('lobby-add').disabled = sl.length >= 4; $('lobby-add').style.opacity = sl.length >= 4 ? 0.4 : 1;
  $('lobby-msg').textContent = sl.length > nS ? `На карте только ${nS} стартовые позиции — уберите лишние слоты.` : '';
}
const startMarks = () => { const marks = []; setup.slots.forEach(s => { if (s.start) marks[s.start - 1] = PLAYER_COLORS[s.color][2]; }); return marks; };
function renderMapBig() {
  const m = lobbyMap(), cv = mapPreviewCanvas(m, startMarks());
  cv.title = 'Клик по стартовой позиции — занять её выбранным слотом';
  cv.onclick = (e) => {
    const r = cv.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * MAP_SIZE, y = (e.clientY - r.top) / r.height * MAP_SIZE;
    let best = -1, bd = (MAP_SIZE * 0.1) ** 2;
    m.starts.forEach((s, i) => { const d = (s.x - x) ** 2 + (s.y - y) ** 2; if (d < bd) { bd = d; best = i; } });
    if (best < 0) return;
    assignStart(selSlot, best + 1); persist(); renderLobby(); renderMapBig();
  };
  const d = document.createElement('div');
  d.innerHTML = `<div class="mc-name">${esc(m.name)}</div><div class="mc-size">${mapKm(m.size)} × ${mapKm(m.size)} км · масса: ${massCount(m)} · стартов: ${m.starts.length}</div><div class="dim">${esc(m.desc)}</div>`;
  $('map-big').replaceChildren(cv, d);
}
// ---- сохранённые случайные карты: файлы в %LOCALAPPDATA%\SupCom3D\maps (run.py), без сервера — localStorage
let savedMaps = [];   // [{ id, name, params }]
const lsMaps = () => { try { return JSON.parse(localStorage.getItem('supcom3d_maps') || '{}'); } catch (e) { return {}; } };
async function loadSavedMaps() {
  let srv = []; try { if (await hasServer()) { const r = await fetch('api/maps'); if (r.ok) srv = await r.json(); } } catch (e) { /* нет сервера игры */ }
  const loc = Object.entries(lsMaps()).map(([id, v]) => ({ id, ...v })).filter(m => !srv.some(x => x.id === m.id));
  savedMaps = [...srv, ...loc].filter(m => m && m.params);
}
async function storeMap(name, params) {
  const id = 'm' + Date.now().toString(36), body = { name, params };
  try { if (!await hasServer()) throw new Error('no server'); const r = await fetch('api/map/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(r.status); }
  catch (e) { const l = lsMaps(); l[id] = body; save('supcom3d_maps', l); }
  return id;
}
async function removeMap(id) {
  try { if (await hasServer()) await fetch('api/map/' + id, { method: 'DELETE' }); } catch (e) { /* нет сервера игры */ }
  const l = lsMaps(); if (l[id]) { delete l[id]; save('supcom3d_maps', l); }
}
const typeName = (t) => GEN_TYPES.find(x => x[0] === t)[1];

function renderCards() {
  const cards = $('map-cards');
  cards.innerHTML = '';
  const addCard = (m, name, en, active, pick, del) => {
    const d = document.createElement('div');
    d.className = 'map-card' + (active ? ' active' : '');
    d.appendChild(mapPreviewCanvas(m));
    const info = document.createElement('div');
    info.innerHTML = `<div class="mc-name">${esc(name)}</div><div class="mc-en">${esc(en)}</div><div class="mc-size">${mapKm(m.size)} × ${mapKm(m.size)} км · масса: ${massCount(m)}</div>`;
    d.appendChild(info);
    if (del) { const x = document.createElement('button'); x.className = 'ls-x mc-x'; x.title = 'Удалить сохранённую карту'; x.textContent = '✕'; x.onclick = async (e) => { e.stopPropagation(); await removeMap(del); if (setup.genId === del) setup.genId = ''; persist(); await loadSavedMaps(); renderCards(); }; d.appendChild(x); }
    d.onclick = () => {
      pick(); setup.slots = sanitize(setup.slots, setup.map === 'gen' ? setup.gen.players : m.starts.length); persist(); buildNewGame(); audio.init(); audio.play('ui');
      if (setup.map === 'gen') genSoon(60); else previewMap(m);
    };
    cards.appendChild(d);
  };
  for (const m of MAP_LIST) addCard(m, m.name, `${m.en} · до 4 игроков · ${m.naval ? 'суша/море/воздух' : 'суша/воздух'}`, setup.map === m.id, () => { setup.map = m.id; });
  addCard(genPreview(setup.gen), 'Случайная карта', 'Генератор · суша/острова/кратер/океан · 2–4 игрока', setup.map === 'gen' && !setup.genId, () => { setup.map = 'gen'; setup.genId = ''; });
  for (const s of savedMaps) { const p = genNorm(s.params); addCard(genPreview(p), s.name, `Своя · ${typeName(p.type)} · сид ${p.seed} · ${p.players} игрока`, setup.map === 'gen' && setup.genId === s.id, () => { setup.map = 'gen'; setup.gen = p; setup.genId = s.id; }, s.id); }
}
// параметры случайной карты: ползунки, сид, сохранение
function renderGen() {
  const el = $('gen-panel'), g = setup.gen;
  el.classList.toggle('hidden', setup.map !== 'gen'); if (setup.map !== 'gen') return;
  const rng = (k, l) => `<label>${l}<input type="range" data-g="${k}" min="0" max="1" step="0.01" value="${g[k]}"><span class="rv">${Math.round(g[k] * 100)}%</span></label>`;
  el.innerHTML = `<div class="ng-sub">СЛУЧАЙНАЯ КАРТА</div><div class="gen-grid">
    <label>Тип<select data-g="type">${optH(GEN_TYPES, g.type)}</select></label>${rng('mountains', 'Горы')}${rng('water', 'Вода')}${rng('mass', 'Масса')}${rng('forest', 'Лес')}
    <label>Игроков<select data-g="players">${optH([[2, 2], [4, 4]], g.players)}</select></label>
    <label>Сид<input type="number" id="g-seed" data-g="seed" min="0" max="99999999" value="${g.seed}"><button class="mbtn small" id="g-dice" title="Новый случайный сид">🎲</button></label>
    <div class="gen-save"><button class="mbtn small" id="g-save">СОХРАНИТЬ КАРТУ</button><span id="g-savebox" class="hidden"><input id="g-name" maxlength="40" placeholder="Название карты"><button class="mbtn small primary" id="g-ok">OK</button><button class="mbtn small" id="g-cancel">✕</button></span></div></div>
  <div class="dim" id="g-msg"></div>`;
}
const genMsg = (t) => { const e = $('g-msg'); if (e) e.textContent = t; };
let genT = 0, genDeb = 0;
/** Проверка карты (связность, сид+1 при неудаче) после паузы ввода; итоговый сид запоминается, превью и фон меню обновляются. */
function genSoon(ms = 450) {
  clearTimeout(genT); genMsg('Проверка карты…');
  genT = setTimeout(() => requestAnimationFrame(() => setTimeout(() => {
    if (setup.map !== 'gen' || !menuOpen) return;
    const t0 = performance.now(), was = setup.gen.seed, m = settleGen(), e = $('g-seed');
    if (e) e.value = setup.gen.seed;
    genMsg(m.gen.errors.length ? `⚠ Карта не прошла проверку за ${m.gen.tries} попыток: ${m.gen.errors[0]}` : `✓ Карта проверена за ${Math.round(performance.now() - t0)} мс${setup.gen.seed !== was ? ` · сид ${was} не годился, взят ${setup.gen.seed}` : ''}`);
    previewMap(m); renderMapBig(); renderCards();
  }, 0)), ms);
}
/** Проверенная карта по параметрам лобби; сид в параметрах заменяется итоговым. */
function settleGen() { const m = generateMap(setup.gen); setup.gen = { ...m.gen.params }; persist(); return m; }
function buildNewGame() {
  renderCards(); renderGen();
  $('opt-fog').checked = setup.fog; $('opt-victory').value = setup.victory; $('opt-cap').value = String(setup.unitCap);
  renderLobby(); renderMapBig();
  loadSavedMaps().then(renderCards);
}
$('gen-panel').addEventListener('input', (e) => {
  const t = e.target, k = t.dataset.g; if (!k) return;
  setup.gen = genNorm({ ...setup.gen, [k]: t.value }); setup.genId = '';
  if (t.type === 'range') t.nextElementSibling.textContent = Math.round(setup.gen[k] * 100) + '%';
  genEdited();
});
function genEdited() {   // превью — через 200 мс после последнего изменения, проверка — ещё через 450 мс
  persist(); clearTimeout(genDeb); clearTimeout(genT); genMsg('');
  genDeb = setTimeout(() => { setup.slots = sanitize(setup.slots, setup.gen.players); renderLobby(); renderMapBig(); renderCards(); genSoon(); }, 200);
}
$('gen-panel').addEventListener('click', async (e) => {
  const id = e.target.id, box = $('g-savebox');
  if (id === 'g-dice') { setup.gen = genNorm({ ...setup.gen, seed: genRandomSeed() }); setup.genId = ''; $('g-seed').value = setup.gen.seed; genEdited(); }
  else if (id === 'g-save') { box.classList.remove('hidden'); $('g-name').value = lobbyMap().name; $('g-name').focus(); $('g-name').select(); }
  else if (id === 'g-cancel') box.classList.add('hidden');
  else if (id === 'g-ok') {
    const name = $('g-name').value.trim() || lobbyMap().name; settleGen();
    setup.genId = await storeMap(name, setup.gen); persist(); box.classList.add('hidden');
    await loadSavedMaps(); renderCards(); genMsg(`✓ Карта «${name}» сохранена`);
  }
});
$('gen-panel').addEventListener('keydown', (e) => { if (e.target.id !== 'g-name') return; if (e.key === 'Enter') $('g-ok').click(); else if (e.key === 'Escape') { e.stopPropagation(); $('g-cancel').click(); } });
const lobbyEl = $('lobby-slots'), lobbyChanged = () => { $('lobby-msg').textContent = ''; persist(); renderLobby(); renderMapBig(); };
lobbyEl.addEventListener('change', (e) => {
  const t = e.target, f = t.dataset.f, row = t.closest('.ls-row'); if (!f || !row) return;
  const i = selSlot = +row.dataset.i, s = setup.slots[i];
  setSlotField(i, f, t.value);
  lobbyChanged();
});
lobbyEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const t = e.target, row = t.closest('.ls-row'); if (!row || !('i' in row.dataset)) return;
  const i = +row.dataset.i, sl = setup.slots, pick = t.closest('[data-pick]');
  if (t.closest('[data-x]')) { sl.splice(i, 1); if (selSlot >= sl.length) selSlot = 0; swOpen = -1; }
  else if (pick) { setSlotField(i, 'color', +pick.dataset.pick); swOpen = -1; selSlot = i; }
  else if (t.closest('[data-sw]')) { swOpen = swOpen === i ? -1 : i; selSlot = i; }
  else {   // клик по строке: выбрать слот (без перерисовки, чтобы не закрыть открытый список)
    selSlot = i; for (const r of lobbyEl.querySelectorAll('.ls-row[data-i]')) r.classList.toggle('sel', +r.dataset.i === i);
    if (swOpen < 0) return; swOpen = -1; renderLobby(); return;
  }
  lobbyChanged();
});
document.addEventListener('click', () => { if (swOpen >= 0) { swOpen = -1; renderLobby(); } });   // клик вне лобби закрывает палитру цвета
$('lobby-add').onclick = () => {
  const sl = setup.slots; if (sl.length >= 4) return;
  sl.push(newSlot(sl.length, { color: PLAYER_COLORS.findIndex((_, c) => !sl.some(s => s.color === c)) })); selSlot = sl.length - 1;
  if (setup.map === 'gen' && sl.length > setup.gen.players) { setup.gen = { ...setup.gen, players: 4 }; setup.genId = ''; renderGen(); }   // третий игрок на случайной карте — генерируем на 4 старта
  lobbyChanged();
};
for (const id of ['opt-fog', 'opt-victory', 'opt-cap']) $(id).addEventListener('change', () => {
  setup.fog = $('opt-fog').checked; setup.victory = $('opt-victory').value; setup.unitCap = +$('opt-cap').value || 1000; persist();
});
/** Конфиг матча из лобби (глубокая копия); watch — одноразово отдать слот 0 ИИ (наблюдение). */
const makeCfg = (watch) => { if (setup.map === 'gen') settleGen(); const c = JSON.parse(JSON.stringify(setup)); if (watch) c.slots[0].ai = true; return c; };
const launch = (watch) => { if (setup.map !== 'gen') return startGame(makeCfg(watch)); show('loading'); setTimeout(() => startGame(makeCfg(watch)), 30); };   // проверка случайной карты может занять секунды

// ------------------------------------------------------------------ match
function startGame(cfg, save = null) {
  const lc = { ...cfg, ...migrate(cfg) };   // старые сохранения и конфиги без slots
  lc.slots = sanitize(lc.slots);
  const pvai = !lc.slots[0].ai; lc.mode = pvai ? 'pvai' : 'aivai';
  const map = mapOf(lc);
  if (!save && lc.slots.length > map.starts.length) {   // пока на карте меньше стартовых позиций, чем слотов
    show('loading', false); show('menu', false); show('newgame'); buildNewGame(); $('lobby-msg').textContent = `На карте «${map.name}» только ${map.starts.length} стартовые позиции — уберите лишние слоты.`; vr.menu.fail(`На карте «${map.name}» только ${map.starts.length} стартовые позиции — уберите лишних соперников.`); return;
  }
  lastConfig = lc;
  show('loading');
  setTimeout(() => {
    const aiMult = (d) => d === 'easy' ? 0.8 : d === 'nightmare' ? 1.6 : d === 'hard' ? 1.25 : 1;
    const teams = lc.slots.map((s, i) => ({
      id: i + 1, ai: s.ai, ally: s.team, start: s.start ? s.start - 1 : undefined, name: s.ai ? aiName(i) : 'Вы',
      autonomy: !s.ai ? settings.autonomy : s.diff === 'easy' ? 'smart' : 'full', autoOC: s.ai ? true : settings.autoOC, resMult: s.ai ? aiMult(s.diff) : 1, difficulty: s.ai && s.diff !== 'neural' ? s.diff : 'normal'
    }));
    game = save ? Game.restore(map, save.game) : new Game(map, { teams, fog: lc.fog, victory: lc.victory, unitCap: lc.unitCap || 1000 });
    ais = [];
    lc.slots.forEach((s, i) => { if (s.ai) ais.push(new AICommander(game, i + 1, { difficulty: s.diff === 'neural' ? 'normal' : s.diff, neural: s.diff === 'neural', doctrine: s.doctrine, name: aiName(i) })); });
    if (save) for (const a of ais) { const d = save.ais.find(x => x.team === a.team); if (d) a.restore(d); }
    game.controllers.push(...ais);
    staff = pvai ? new Staff(game, 1) : null; // player's lieutenants (after the AIs so the enemy moves first each tick)
    if (staff && save && save.staff) staff.restore(save.staff);
    renderer.localTeam = pvai ? 1 : 0;
    const look = applyLobby(lc.slots);   // цвета команд и камуфляж (до loadTerrain: он пересоздаёт все виды)
    if (look !== thumbKey) { thumbKey = look; const ids = lc.slots.map((_, i) => i + 1); thumbsP = thumbsP.then(() => genIcons(ids)); }
    renderer.loadTerrain(game.terrain);
    for (const f of game.terrain.features) if (f.gone) renderer.hideFeature(f);
    ui.setGame(game, ais, pvai ? 1 : 0, staff);
    if (save && save.cam) { renderer.centerOn(save.cam.x, save.cam.y, save.cam.dist); Object.assign(renderer.view, { x: save.cam.x, y: save.cam.y, dist: save.cam.dist }); }
    acc = 0; overShown = false; sysPaused = false; lastAutoSave = game.time;
    menuOpen = false; gameGen++;
    show('menu', false); show('newgame', false); show('loading', false); show('hud'); show('gameover', false); show('pause', false);
    $('ai-window').classList.toggle('hidden', pvai && !settings.aiWindowOpen);
    if (!pvai) $('ai-window').classList.remove('hidden');
  }, 30);
}

// ------------------------------------------------------------------ save / load (files in %LOCALAPPDATA%\SupCom3D\saves via run.py)
const SLOT_NAMES = { quick: 'Быстрое сохранение (F5)', auto: 'Автосохранение (каждые 3 мин)' };
for (let i = 1; i <= 8; i++) SLOT_NAMES['slot' + i] = 'Слот ' + i;
let lastAutoSave = 0;
const OLD_SAVE = (size) => `Сохранение от карты ${size} × ${size} (старая версия игры): карты стали ${MAP_SIZE} × ${MAP_SIZE}, загрузить его нельзя`;
async function saveGame(slot, quiet = false) {
  if (!game || game.over) { if (!quiet) ui.flash('Нечего сохранять'); return; }
  const data = {
    v: 1, mapSize: MAP_SIZE, meta: { date: Date.now(), map: game.map.id, mapName: game.map.name, mapSize: MAP_SIZE, time: game.time, mode: lastConfig.mode, difficulty: lastConfig.difficulty },
    cfg: lastConfig, game: game.serialize(), ais: ais.map(a => a.serialize()), staff: staff ? staff.serialize() : null, cam: { x: renderer.view.tx, y: renderer.view.ty, dist: renderer.view.tdist }
  };
  try {
    if (await hasServer()) {
      const r = await fetch('api/save/' + slot, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (!r.ok) throw new Error(r.status);
    } else await localSave(slot, data);
    if (!quiet) ui.flash(`Сохранено: ${SLOT_NAMES[slot]} (${fmtT(game.time)})`, true);
  } catch (e) { ui.flash('Не удалось сохранить: ' + (e.message || 'сервер игры недоступен')); }
}
async function loadGame(slot) {
  try {
    let d;
    if (await hasServer()) {
      const r = await fetch('api/save/' + slot);
      if (!r.ok) { ui.flash(r.status === 404 ? 'Сохранение не найдено' : 'Ошибка загрузки'); return; }
      d = await r.json();
    } else if (!(d = await localLoad(slot))) { ui.flash('Сохранение не найдено'); return; }
    if ((d.mapSize || 1024) !== MAP_SIZE) { ui.flash(OLD_SAVE(d.mapSize || 1024), false, 6000); return; }
    if (game && !game.over) game.over = { winner: 0, time: game.time, loaded: true }; // leave the current match without LTM stats
    show('saves', false); show('pause', false);
    startGame(d.cfg, d);
    return true;
  } catch (e) { ui.flash('Не удалось загрузить: ' + e.message); }
  return false;
}
/** Слоты сохранений { slot: meta } (сервер run.py или IndexedDB); бросает, если хранилище недоступно. */
async function listSaves() { const list = await hasServer() ? await (await fetch('api/saves')).json() : await localSaves(); return Object.fromEntries(list.map(x => [x.slot, x])); }
const saveDesc = (m) => !m ? { ok: false, t: 'пусто' } : m.broken ? { ok: false, t: 'повреждено' } : (m.mapSize || 1024) !== MAP_SIZE ? { ok: false, t: 'старая версия игры' }
  : { ok: true, t: `${fmtDate(m.date)} · ${m.mapName || m.map} · ${fmtT(m.time)}${m.mode === 'aivai' ? ' · ИИ-ИИ' : ''}` };
async function buildSaves(mode) {
  $('saves-title').textContent = mode === 'save' ? 'СОХРАНИТЬ ИГРУ' : 'ЗАГРУЗИТЬ ИГРУ';
  $('saves-body').innerHTML = '<div class="dim">Загрузка списка…</div>';
  let by;
  try { by = await listSaves(); } catch (e) { $('saves-body').innerHTML = '<div class="bad">Хранилище сохранений недоступно</div>'; return; }
  const slots = mode === 'save' ? Object.keys(SLOT_NAMES).filter(k => k !== 'auto') : Object.keys(SLOT_NAMES).filter(k => by[k]);
  if (!slots.length) { $('saves-body').innerHTML = '<div class="dim">Сохранений пока нет. В бою: Esc → «Сохранить игру» или F5.</div>'; return; }
  $('saves-body').innerHTML = `<table class="tbl saves">${slots.map(k => {
    const m = by[k];
    const old = m && !m.broken && (m.mapSize || 1024) !== MAP_SIZE;
    const info = m ? (m.broken ? '<span class="bad">повреждено</span>' : old ? `<span class="bad">${esc(OLD_SAVE(m.mapSize || 1024))}</span>` : `${esc(m.mapName || m.map)} · ${fmtT(m.time)} · ${m.mode === 'aivai' ? 'ИИ против ИИ' : 'против ИИ'} · ${new Date(m.date).toLocaleString()}`) : '<span class="dim">пусто</span>';
    const btn = mode === 'save' ? `<button class="mbtn small" data-slot="${k}">${m ? 'ПЕРЕЗАПИСАТЬ' : 'СОХРАНИТЬ'}</button>` : `<button class="mbtn small primary" data-slot="${k}" ${m && !m.broken && !old ? '' : 'disabled'}>ЗАГРУЗИТЬ</button>`;
    return `<tr><td><b>${SLOT_NAMES[k]}</b></td><td>${info}</td><td>${btn}</td></tr>`;
  }).join('')}</table>`;
  for (const b of $('saves-body').querySelectorAll('button[data-slot]')) b.onclick = async () => {
    if (mode === 'save') { await saveGame(b.dataset.slot); buildSaves('save'); } else loadGame(b.dataset.slot);
  };
}

function togglePauseMenu(force) {
  if (!game) return;
  const on = force === undefined ? $('pause').classList.contains('hidden') : force;
  show('pause', on);
  sysPaused = on && renderer.localTeam !== 0;
}

function endScreen() {
  overShown = true;
  const g = game, w = g.over.winner, ws = g.over.winners || [w], pvai = renderer.localTeam === 1, cs = lastConfig.slots;
  const col = (id) => PLAYER_COLORS[cs[id - 1]?.color]?.[0] || 'Команда ' + id, who = (id) => cs[id - 1]?.ai ? aiName(id - 1) : 'Вы';
  const won = pvai && ws.includes(1);   // победа союзника — общая
  $('go-title').textContent = pvai ? (won ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ') : `ПОБЕДИЛИ: ${ws.map(col).join(' + ').toUpperCase()}`;
  $('go-title').className = pvai ? (won ? 'good' : 'bad') : '';
  $('go-sub').textContent = pvai ? (won ? 'Вражеский командир уничтожен' : 'Ваш командир погиб') : 'Матч ИИ против ИИ завершён';
  const rows = Object.values(g.teams).map(T => `<tr><td style="color:${TEAM_CSS[T.id]}">${col(T.id)} · ${who(T.id)}</td><td>${T.stats.built}</td><td>${T.stats.kills}</td><td>${T.stats.lost}</td><td>${Math.round(T.eco.collectedM)}</td><td>${Math.round(T.stats.massKilled)}</td></tr>`).join('');
  const mem = ais.map(a => `<div class="dim">🧠 ${esc(a.name)}: стратегия «${esc(STRATEGIES[a.initialStrategy].name)}» записана в память как ${ws.includes(a.team) ? '<b class="good">победная</b>' : '<b class="bad">проигрышная</b>'}.</div>`).join('');
  if (vr.inVR) vr.menu.showOver({ title: $('go-title').textContent, sub: $('go-sub').textContent, good: pvai && won, bad: pvai && !won, time: fmtT(g.time),
    rows: Object.values(g.teams).map(T => ({ name: `${col(T.id)} · ${who(T.id)}`, color: TEAM_CSS[T.id], built: T.stats.built, kills: T.stats.kills, lost: T.stats.lost, mass: Math.round(T.eco.collectedM) })) });
  $('go-stats').innerHTML = `<div class="dim">Длительность: ${fmtT(g.time)}</div><table class="tbl"><tr><th>Сторона</th><th>Построено</th><th>Убито</th><th>Потеряно</th><th>Масса добыто</th><th>Урон (масса)</th></tr>${rows}</table>${mem}`;
  show('gameover');
}

function surrender() {
  if (!game || game.over) return;
  game.over = { winner: renderer.localTeam === 1 ? 2 : 0, time: game.time };
  for (const a of ais) a.finalize();
  togglePauseMenu(false);
}

// ------------------------------------------------------------------ settings modal
function buildSettings() {
  const s = settings;
  const sel = (id, opts, val) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const chk = (id, v) => `<input type="checkbox" id="${id}" ${v ? 'checked' : ''}>`;
  const rng = (id, min, max, step, v) => `<input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}"><span class="rv" id="${id}-v">${v}</span>`;
  $('settings-body').innerHTML = `
    <div class="set-group"><div class="set-h">ГРАФИКА</div>
      <label>Разрешение рендера ${sel('s-pr', [[0.75, 'Низкое (0.75×)'], [1, 'Среднее (1×)'], [1.5, 'Высокое (1.5×)'], [2, 'Ультра (2×)']], s.pixelRatio)}</label>
      <label>Тени ${chk('s-shadows', s.shadows)}</label>
      <label>Качество теней ${sel('s-shres', [[1024, '1024'], [2048, '2048'], [4096, '4096']], s.shadowRes)}</label>
      <label>Свечение (bloom) ${chk('s-bloom', s.bloom)}</label>
      <label>Частицы и эффекты ${sel('s-part', [[0, 'Мало'], [1, 'Средне'], [2, 'Много']], s.particles)}</label>
      <label>Полосы здоровья ${sel('s-bars', [[0, 'Только выделенные'], [1, 'Повреждённые'], [2, 'Всегда']], s.healthBars)}</label>
      <label>Стратегические иконки с высоты ${rng('s-icon', 150, 800, 10, s.iconDist)}</label>
    </div>
    <div class="set-group"><div class="set-h">ИГРА И ИИ ЮНИТОВ</div>
      <label>Автономия ваших юнитов ${sel('s-auton', [['off', 'Выкл. — только ответный огонь'], ['smart', 'Умная — фокус, кайт, уклонение'], ['full', 'Полная — + отступление, авто-инженеры']], s.autonomy)}</label>
      <label>Авто-Сверхзаряд ACU ${chk('s-oc', s.autoOC)}</label>
      <label>Мысли юнитов над головой (F3) ${chk('s-thoughts', s.unitThoughts)}</label>
      <label>Скорость игры по умолчанию ${sel('s-speed', [[0.5, '×0.5'], [1, '×1'], [1.5, '×1.5'], [2, '×2']], s.gameSpeed)}</label>
    </div>
    <div class="set-group"><div class="set-h">УПРАВЛЕНИЕ</div>
      <label>Прокрутка краем экрана ${chk('s-edge', s.edgeScroll)}</label>
      <label>Скорость камеры ${rng('s-pan', 0.4, 2.5, 0.1, s.panSpeed)}</label>
      <label>Скорость зума ${rng('s-zoom', 0.4, 2.5, 0.1, s.zoomSpeed)}</label>
    </div>
    <div class="set-group"><div class="set-h">ЗВУК</div>
      <label>Звук ${chk('s-sound', s.sound)}</label>
      <label>Громкость ${rng('s-vol', 0, 1, 0.05, s.volume)}</label>
      <label>Музыка ${chk('s-music', s.music !== false)}</label>
      <label>Громкость музыки ${rng('s-mvol', 0, 1, 0.05, s.musicVolume ?? 0.5)}</label>
      <p class="dim small">Музыка: Kevin MacLeod (incompetech.com), CC BY 4.0. Звуки: freesound.org, CC0. Подробно: assets/CREDITS.md</p>
    </div>`;
  for (const r of document.querySelectorAll('#settings-body input[type=range]')) r.oninput = () => { $(r.id + '-v').textContent = r.value; };
}

function applySettingsFromForm() {
  const v = (id) => $(id).value, c = (id) => $(id).checked;
  Object.assign(settings, {
    pixelRatio: +v('s-pr'), shadows: c('s-shadows'), shadowRes: +v('s-shres'), bloom: c('s-bloom'), particles: +v('s-part'), healthBars: +v('s-bars'), iconDist: +v('s-icon'),
    autonomy: v('s-auton'), autoOC: c('s-oc'), unitThoughts: c('s-thoughts'), gameSpeed: +v('s-speed'),
    edgeScroll: c('s-edge'), panSpeed: +v('s-pan'), zoomSpeed: +v('s-zoom'), sound: c('s-sound'), volume: +v('s-vol'), music: c('s-music'), musicVolume: +v('s-mvol')
  });
  save('supcom3d_settings', settings);
  renderer.applySettings(settings);
  applyAudio();
  if (game && game.teams[1] && !game.teams[1].ai) { game.teams[1].autonomy = settings.autonomy; game.teams[1].autoOC = settings.autoOC; }
}

/** Память ИИ (LTM): общие цифры и строки карта × стратегия (для окна ПК и VR-экрана). */
function memoryData() {
  const L = loadLTM(), rows = [];
  for (const m of [...MAP_LIST, ...GEN_TYPES.map(([t, n]) => ({ id: 'gen_' + t, name: 'Случайная: ' + n }))]) {
    const st = L.maps[m.id]?.strats || {};
    for (const [k, s] of Object.entries(STRATEGIES)) { const x = st[k]; if (x && x.n) rows.push({ map: m.name, strat: s.name, n: x.n, w: x.w, pct: Math.round(x.w / x.n * 100) }); }
  }
  return { L, rows };
}
function buildMemory() {
  const { L, rows: data } = memoryData();
  const rows = data.map(r => `<tr><td>${esc(r.map)}</td><td>${esc(r.strat)}</td><td>${r.n}</td><td>${r.w}</td><td>${r.pct}%</td></tr>`);
  $('memory-body').innerHTML = `<p class="dim">ИИ запоминает исход каждого матча: какие стратегии побеждают на каждой карте (многорукий бандит UCB1) и привычки противника (доля авиации/флота, время первой атаки). Это влияет на выбор доктрины и раннюю оборону в следующих играх.</p>
    <div class="ai-kv small"><div>Матчей<b>${L.games}</b></div><div>Побед ИИ<b class="good">${L.wins}</b></div><div>Поражений ИИ<b class="bad">${L.losses}</b></div><div>Авиация противника<b>${Math.round(L.profile.air * 100)}%</b></div><div>Флот противника<b>${Math.round(L.profile.naval * 100)}%</b></div><div>Первая атака (сред.)<b>${L.profile.n ? fmtT(L.profile.rushT) : '—'}</b></div></div>
    <table class="tbl"><tr><th>Карта</th><th>Стратегия</th><th>Игр</th><th>Побед</th><th>%</th></tr>${rows.join('') || '<tr><td colspan="5" class="dim">Пока пусто — сыграйте матч.</td></tr>'}</table>`;
}

// ------------------------------------------------------------------ wiring
$('m-new').onclick = () => { audio.init(); audio.play('ui'); show('menu', false); show('newgame'); buildNewGame(); };
$('m-quick').onclick = () => { audio.init(); launch(); };
$('m-watch').onclick = () => { audio.init(); launch(true); };
$('m-settings').onclick = () => { buildSettings(); show('settings'); };
$('m-load').onclick = () => { buildSaves('load'); show('saves'); };
$('p-save').onclick = () => { buildSaves('save'); show('saves'); };
$('p-load').onclick = () => { buildSaves('load'); show('saves'); };
$('saves-close').onclick = () => show('saves', false);
$('m-help').onclick = () => show('help');
$('m-memory').onclick = () => { buildMemory(); show('memory'); };
$('ng-back').onclick = () => { show('newgame', false); show('menu'); };
$('ng-start').onclick = () => launch();
$('settings-apply').onclick = () => { applySettingsFromForm(); show('settings', false); };
$('settings-cancel').onclick = () => show('settings', false);
$('help-close').onclick = () => show('help', false);
$('memory-close').onclick = () => show('memory', false);
$('memory-reset').onclick = () => { if (confirm('Стереть долговременную память ИИ?')) { resetLTM(); buildMemory(); } };
$('p-resume').onclick = () => togglePauseMenu(false);
$('p-settings').onclick = () => { buildSettings(); show('settings'); };
$('p-help').onclick = () => show('help');
$('p-surrender').onclick = () => surrender();
const leaveToMenu = () => { if (game && !game.over) surrender(); showMenu(); };
const playAgain = () => startGame({ ...lastConfig, slots: lastConfig.slots.map(({ rolled, ...x }) => x) });   // «Случайный» камуфляж бросается заново
$('p-menu').onclick = () => { if (game && !game.over && renderer.localTeam === 1 && !confirm('Выйти в меню? Матч будет засчитан как поражение.')) return; leaveToMenu(); };
$('go-menu').onclick = () => showMenu();
$('go-again').onclick = playAgain;
$('go-watch').onclick = () => { show('gameover', false); };

// ------------------------------------------------------------------ loop
// Simulation steps per rendered frame are limited by wall-clock time, not by count: when a step costs more than the
// frame allows (huge armies), the game runs slower than the requested speed instead of spiralling (every frame owing
// more steps than it can do). The unpaid part is dropped, never carried over. ui.simRate = achieved / requested speed.
const STEP_BUDGET_MS = 20;
let last = performance.now(), orbit = 0, rateWant = 0, rateGot = 0;
let frameErr = 0;
function frame(now) {
  try { tick(now || performance.now()); } catch (e) { console.error(e); if (now - frameErr > 5000) { frameErr = now; ui.flash('Ошибка игры: ' + e.message); } }
}
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (game) {
    if (!ui.paused && !sysPaused && !game.over) {
      acc += dt * ui.speed;
      const t0 = performance.now();
      let n = 0;
      while (acc >= DT) {
        game.step(); acc -= DT; n++;
        if (performance.now() - t0 > STEP_BUDGET_MS) break;
      }
      if (acc >= DT) acc = 0;                       // could not keep up: forget the backlog
      rateWant += dt * ui.speed; rateGot += n * DT;
      if (rateWant > 0.5) { ui.simRate = Math.min(1, rateGot / rateWant); rateWant = rateGot = 0; }
    }
    if (game.over && !overShown && !game.over.loaded) endScreen();
    if (!game.over && game.time - lastAutoSave > 180) { lastAutoSave = game.time; saveGame('auto', true); }
  } else {
    orbit += dt * 0.05;
    const v = renderer.view;
    v.tx = MAP_SIZE / 2 + Math.cos(orbit) * 360; v.ty = MAP_SIZE / 2 + Math.sin(orbit) * 360; v.tdist = 1120;
  }
  ui.update(dt);
  music.update(dt, game && !game.over ? 'battle' : 'menu', audio.heat);
  renderer.render(game, game ? Math.min(1, acc / DT) : 1, dt, game ? ui : null);
}

showMenu();
$('boot').classList.add('hidden');
renderer.gl.setAnimationLoop(frame);

// ------------------------------------------------------------------ VR: запуск, меню, выход (6.1 / 6.2 / 7.4)
vr.isTWA = !!window.getDigitalGoodsService;   // установленное приложение Quest (TWA immersive); xremu.js эмулирует по ?twa=1
// VR-лобби «Новая игра» одним экраном, как на ПК (11.14): те же setup / persist / sanitize / setSlotField / assignStart, что в DOM-лобби
const SLOT_FIELDS = ['color', 'team', 'start', 'camo', 'pal', 'diff', 'doctrine', 'ai'];
const slotOpts = (f) => f === 'team' ? TEAM_OPTS : f === 'start' ? startOpts(nStartsOf()) : f === 'camo' ? PAT_OPTS : f === 'pal' ? PAL_OPTS : f === 'diff' ? DIFFS : f === 'doctrine' ? DOC_OPTS
  : f === 'color' ? PLAYER_COLORS.map((c, k) => [k, c[0]]) : [['h', 'Вы'], ['o', 'Наблюдатель']];
const slotVal = (s, f) => f === 'ai' ? (s.ai ? 'o' : 'h') : s[f];
const SLOT_TITLES = { color: 'ЦВЕТ', team: 'КОМАНДА (СОЮЗ)', start: 'СТАРТОВАЯ ПОЗИЦИЯ', camo: 'КАМУФЛЯЖ', pal: 'ЦВЕТ КАМУФЛЯЖА', diff: 'СЛОЖНОСТЬ ИИ', doctrine: 'ДОКТРИНА ИИ', ai: 'ИГРОК', custom: 'СВОЙ ЦВЕТ КАМУФЛЯЖА' };
// «Свой цвет» камуфляжа: на ПК <input type=color>, в VR — набор оттенков
const CUSTOM_COLS = ['#5a6b3a', '#7d8a4a', '#3f5a2e', '#2e3b26', '#a89060', '#c2a878', '#7a5a3a', '#4a3523', '#8a8d90', '#5c6670', '#e8edf0', '#2b2d30', '#8a2f26', '#3a5a86', '#2f7a7a', '#6a4a86'];
const VICT_OPTS = [['assassination', 'Убийство командира'], ['annihilation', 'Полное уничтожение']], CAP_OPTS = [[250, '250'], [500, '500'], [1000, '1000']];
const thumbs = new WeakMap();   // миниатюра карты для карточки (карта -> canvas): строится один раз
const thumbOf = (m) => { let c = thumbs.get(m); if (!c) thumbs.set(m, c = mapPreviewCanvas(m)); return c; };
let bigPrev = { k: '', cv: null };   // большое превью с метками стартов: пересобирается только при смене карты / стартов / цветов
function lobbyPreview() {
  const m = lobbyMap(), marks = startMarks(), k = (setup.map === 'gen' ? 'gen:' + genKey(setup.gen) : setup.map) + '|' + marks.join();
  if (bigPrev.k !== k) bigPrev = { k, cv: mapPreviewCanvas(m, marks) };
  return { m, cv: bigPrev.cv };
}
const mapChoices = () => [
  ...MAP_LIST.map(m => ({ id: m.id, m, name: m.name, en: `${m.en} · ${m.naval ? 'суша/море/воздух' : 'суша/воздух'}`, active: setup.map === m.id, pick: () => { setup.map = m.id; setup.genId = ''; } })),
  { id: 'gen', m: genPreview(setup.gen), name: 'Случайная карта', en: 'Генератор · 2–4 игрока', active: setup.map === 'gen' && !setup.genId, pick: () => { setup.map = 'gen'; setup.genId = ''; } },
  ...savedMaps.map(s => { const p = genNorm(s.params); return { id: 'saved:' + s.id, m: genPreview(p), name: s.name, en: `Своя · ${typeName(p.type)} · сид ${p.seed}`, active: setup.map === 'gen' && setup.genId === s.id, pick: () => { setup.map = 'gen'; setup.gen = p; setup.genId = s.id; } }; })
];
const mapLine = (m) => `${mapKm(m.size)} × ${mapKm(m.size)} км · масса: ${massCount(m)}`;
const slotName = (s, i) => i === 0 ? (s.ai ? 'Наблюдатель' : 'Вы') : aiName(i);
const vrLobby = {
  /** Всё для экрана лобби: слоты, карточки карт, превью, опции. Вызывается только при перерисовке меню. */
  info() {
    const sl = setup.slots, { m, cv } = lobbyPreview(), nS = m.starts.length;
    return {
      slots: sl.map((s, i) => {
        const lab = {}; for (const f of SLOT_FIELDS) lab[f] = (slotOpts(f).find(o => String(o[0]) === String(slotVal(s, f))) || ['', '?'])[1];
        const chips = s.camo === 'team' ? [] : s.pal === 'custom' ? [s.custom] : CAMO_PALETTES[s.pal] ? camoLook('khaki', s.pal).cols.map(hexOf) : [];
        return { i, ai: s.ai, name: slotName(s, i), css: PLAYER_COLORS[s.color][2], lab, chips, camoTeam: s.camo === 'team', custom: s.pal === 'custom' && s.camo !== 'team' ? s.custom : '' };
      }),
      maps: mapChoices().map(c => ({ id: c.id, name: c.name, en: c.en, size: mapLine(c.m), cv: thumbOf(c.m), active: c.active })),
      map: { name: m.name, line: `${mapLine(m)} · стартов: ${nS}`, desc: m.desc || '', cv, starts: m.starts.map(s => [s.x / MAP_SIZE, s.y / MAP_SIZE]), isGen: setup.map === 'gen' },
      victory: VICT_OPTS.find(v => v[0] === setup.victory)[1], cap: setup.unitCap, fog: setup.fog, canAdd: sl.length < 4,
      msg: sl.length > nS ? `На карте только ${nS} стартовые позиции — уберите лишние слоты.` : ''
    };
  },
  /** Краткая сводка для главного меню («Быстрый бой» играет текущую схватку). */
  brief() {
    const { m, cv } = lobbyPreview();
    return { name: m.name, line: mapLine(m), cv, victory: VICT_OPTS.find(v => v[0] === setup.victory)[1], cap: setup.unitCap, fog: setup.fog,
      slots: setup.slots.map((s, i) => ({ name: slotName(s, i), css: PLAYER_COLORS[s.color][2], sub: s.ai && i > 0 ? (DIFFS.find(d => d[0] === s.diff) || DIFFS[1])[1] : '' })) };
  },
  /** Варианты для всплывающего списка: поле слота (i, f) или опция лобби (i = -1: 'victory' | 'cap'). Вариант: [значение, подпись, цвет?, занят слотом?]. */
  opts(i, f) {
    if (i < 0) return f === 'cap' ? { title: 'ЛИМИТ ЮНИТОВ НА КОМАНДУ', opts: CAP_OPTS, cur: setup.unitCap } : { title: 'ПОБЕДА', opts: VICT_OPTS, cur: setup.victory };
    const s = setup.slots[i];
    if (f === 'custom') return { title: SLOT_TITLES.custom, opts: CUSTOM_COLS.map(c => [c, c, c]), cur: s.custom };
    const opts = slotOpts(f).map(o => f === 'color' ? [o[0], o[1], PLAYER_COLORS[o[0]][2], setup.slots.findIndex((x, k) => k !== i && x.color === o[0])] : o);
    return { title: SLOT_TITLES[f] + ' · ' + slotName(s, i).toUpperCase(), opts, cur: slotVal(s, f) };
  },
  set(i, f, v) {
    if (i < 0) { if (f === 'cap') setup.unitCap = [250, 500, 1000].includes(+v) ? +v : 1000; else if (f === 'victory') setup.victory = v === 'annihilation' ? 'annihilation' : 'assassination'; persist(); return; }
    if (f === 'custom') { if (/^#[0-9a-f]{6}$/i.test(v)) setup.slots[i].custom = v; }
    else setSlotField(i, f, v);
    persist();
  },
  start(i, n) { assignStart(i, n); persist(); },   // клик по стартовой позиции на превью (повторный клик — снова «Авто»)
  fog() { setup.fog = !setup.fog; persist(); },
  add() {   // «+ ДОБАВИТЬ ИИ» — как $('lobby-add')
    const sl = setup.slots; if (sl.length >= 4) return -1;
    sl.push(newSlot(sl.length, { color: PLAYER_COLORS.findIndex((_, c) => !sl.some(s => s.color === c)) }));
    if (setup.map === 'gen' && sl.length > setup.gen.players) { setup.gen = { ...setup.gen, players: 4 }; setup.genId = ''; }
    persist(); return sl.length - 1;
  },
  del(i) { const sl = setup.slots; if (i > 0 && sl.length > 2) { sl.splice(i, 1); persist(); } },
  map(id) {   // карточка карты — как renderCards()
    const c = mapChoices().find(x => x.id === id); if (!c) return false;
    c.pick(); setup.slots = sanitize(setup.slots, setup.map === 'gen' ? setup.gen.players : c.m.starts.length); persist();
    if (setup.map !== 'gen') previewMap(c.m);
    return true;
  },
  refreshMaps(done) { loadSavedMaps().then(done, done); }
};
// панель генератора в лобби: те же setup.gen/genId, что в ПК-панели (любая правка сбрасывает genId); проверка карты — при старте (makeCfg)
const vrGen = {
  info() { const g = setup.gen; return { g, typeName: typeName(g.type), key: genKey(g), genId: setup.genId, cv: lobbyPreview().cv }; },
  step(k, d) {
    const g = setup.gen;
    if (k === 'type') { const i = GEN_TYPES.findIndex(t => t[0] === g.type); setup.gen = genNorm({ ...g, type: GEN_TYPES[(i + d + GEN_TYPES.length) % GEN_TYPES.length][0] }); }
    else if (k === 'players') setup.gen = genNorm({ ...g, players: g.players === 4 ? 2 : 4 });
    else setup.gen = genNorm({ ...g, [k]: g[k] + d * 0.25 });   // ползунки 0..1, шаг 0.25
    this.edited();
  },
  newSeed() { setup.gen = genNorm({ ...setup.gen, seed: genRandomSeed() }); this.edited(); },
  edited() {
    setup.genId = '';
    if (setup.gen.players === 2 && setup.slots.length > 2) setup.slots.length = 2;   // на 2 старта — не больше двух слотов
    setup.slots = sanitize(setup.slots, setup.gen.players); persist();
  }
};
const vrMemory = {
  info() {
    const { L, rows } = memoryData();
    return { games: L.games, wins: L.wins, losses: L.losses, air: Math.round(L.profile.air * 100), naval: Math.round(L.profile.naval * 100), rush: L.profile.n ? fmtT(L.profile.rushT) : '—', rows: rows.sort((a, b) => b.n - a.n || b.pct - a.pct).slice(0, 8) };
  },
  reset() { resetLTM(); }
};
Object.assign(vr.menu, { hooks: {
  game: () => game, gameId: () => gameGen, pause: (on) => { sysPaused = on && renderer.localTeam !== 0; },   // как togglePauseMenu: пауза только в бою против ИИ
  launch: (watch) => launch(watch), playAgain, loadGame, saveGame: (slot) => saveGame(slot), listSaves, saveDesc, SLOT_NAMES, surrender, leaveToMenu,
  lobby: vrLobby, gen: vrGen, memory: vrMemory, settings, commit() { save('supcom3d_settings', settings); renderer.applySettings(settings); applyAudio(); }
} });
vr.menu.applySettings();
ui.flashHook = (text, ms) => { if (vr.inVR) { vr.panel.message(text, ms); vr.menu.note(text, ms + 1500); } };   // сообщения игры видны и в шлеме

// Вход в VR: без боя — меню `main` (в TWA и в браузере); бой запускается кнопкой меню, а не сам. С идущим боем — сразу в бой.
const onVRClick = async () => {
  if (vr.inVR) { await vr.endSession(); return; }
  audio.init();   // клик по кнопке — жест: AudioContext создаётся до сессии (в TWA жеста нет — см. sessionstart ниже)
  if (await vr.startSession() && !game) { vr.menu.open('main'); vr.menu.firstRunHelp(); }   // первый запуск: схема управления один раз
};
// Звук в VR (11.2): DOM-кликов в шлеме нет, а AudioContext запускается только по жесту. Курок/захват в XR-сессии — жест
// (Chromium/Meta Browser), поэтому init() на каждом selectstart/squeezestart: создаёт контекст или будит приостановленный.
renderer.gl.xr.addEventListener('sessionstart', () => {
  const s = renderer.gl.xr.getSession();
  for (const ev of ['selectstart', 'squeezestart']) s.addEventListener(ev, () => audio.init());
});
const btnVR = $('btn-vr'), mVR = $('m-vr');
if (btnVR) btnVR.onclick = onVRClick;
if (mVR) mVR.onclick = onVRClick;

// TWA: сразу сессия (пустой шлем без неё), без launch(). Запуск по иконке считается жестом; не дали — войти по первому клику/триггеру.
// Сессия закончилась не по «Выйти из игры» (системная кнопка) — снова войти по первому клику.
const autoVR = async () => { if (vr.inVR) return; try { await onVRClick(); } catch (e) { console.warn('auto VR', e); } };
function vrSessionEnd() {
  autosaveNow();   // выход из VR посреди боя: автосохранение, чтобы вернуться кнопкой «Продолжить»
  if (!vr.isTWA) return;
  if (vr.quitting) { try { window.close(); } catch (e) { /* не наше окно */ } return; }
  addEventListener('pointerup', autoVR, { once: true });
}
if (vr.isTWA && navigator.xr) autoVR().then(() => { if (!vr.inVR) addEventListener('pointerup', autoVR, { once: true }); });

// автосохранение при уходе из боя (слот auto): конец VR-сессии, вкладка скрыта (шлем снят / приложение свернуто), закрытие страницы
function autosaveNow() {
  if (!game || game.over || menuOpen || !lastConfig || game.time < 3) return;
  lastAutoSave = game.time; saveGame('auto', true);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosaveNow(); });
addEventListener('pagehide', autosaveNow);

// офлайн-кэш (PWA/TWA): только по https, т.е. не на ПК с run.py (http://localhost)
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
hasServer().then(ok => { // run.py: /api/status = the page is up; на Pages (404/не JSON) пинги не шлём
  if (!ok) return;
  setInterval(() => fetch('api/ping').catch(() => {}), 10000); // desktop launcher shuts the server down when pings stop
  addEventListener('pagehide', () => navigator.sendBeacon('api/bye')); // window closed: launcher exits at once
});
window.__dbg = { get setup() { return setup; }, renderer, ui, audio, music, vr, get game() { return game; }, get ais() { return ais; }, get staff() { return staff; } };
