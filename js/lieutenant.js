// Lieutenants: sub-commanders the player delegates an area of the war to (economy, land army, air, navy, base defence).
//  A lieutenant is embodied by a support commander (sACU, unit `sacu`, built at the T3 land factory): `lt.sacu` / `sacu.ltHead`
//  point at each other. It is the lieutenant's own engineer; when it dies the lieutenant is dismissed and everything returns to the player.
//  A lieutenant only commands what the player handed over (units / structures carry `e.lt = lieutenant id`), spends
//  at most its budget (share of the team income), sees only what the player's team sees (fog of war) and steps
//  back from any unit the player orders by hand. It reuses the AICommander machinery (Intel threat maps, spot search,
//  target picking, platoon missions) through a mixin instead of duplicating it.
import { UNITS, STRUCTS, PRODUCES, ENH } from './specs.js';
import { AICommander, Intel } from './ai.js';
import { powerOf } from './unitai.js';
import { MAP_SIZE } from './maps.js';
import { PN, PCELL } from './terrain.js';

const KM = MAP_SIZE / 1024;   // distances tuned on the old 1024 map scale with the map

const hyp = Math.hypot;
const dist = (a, b) => hyp(a.x - b.x, a.y - b.y);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const fmtT = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const pt = (p) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;

const GRACE = 6;      // seconds a unit stays under manual control after the player's last own order ended
const ENDLESS = 60;   // patrol / guard orders from the player are adopted by the lieutenant after this many seconds
const MAX_LOG = 120;
export const NO_SACU = 'Нужен командир поддержки — строится на заводе Т3';
const TRAIL = 140;     // how far behind the main platoon the sACU keeps (world units)

export const AREAS = {
  eco: {
    name: 'Экономика', color: '#46e070', short: 'ЭКОН', budget: 0.8,
    desc: 'Развивает добычу и энергию: экстракторы, электростанции, хранилища, масс-фабрикаторы.',
    does: ['Занимает безопасные месторождения', 'Строит электростанции по потребности', 'Улучшает экстракторы, добавляет хранилища', 'Достраивает, чинит, разбирает обломки'],
    give: 'Передайте инженеров (и завод, если нужны новые).'
  },
  land: {
    name: 'Наземная армия', color: '#ffb040', short: 'АРМИЯ', budget: 0.6,
    desc: 'Заказывает танки и артиллерию, ведёт взводы в бой, занимает месторождения и удерживает территорию.',
    does: ['Производит наземные войска', 'Формирует ударные группы и резерв', 'Выбирает цели по риску и ценности', 'Отступает, если враг сильнее'],
    give: 'Передайте наземный завод (и, по желанию, войска).'
  },
  air: {
    name: 'Авиация', color: '#5fd0ff', short: 'АВИА', budget: 0.6,
    desc: 'Истребительное прикрытие, разведка, бомбардировщики и ганшипы по целям без ПВО.',
    does: ['Держит воздушное прикрытие', 'Разведывает карту', 'Бьёт по целям, где слабое ПВО', 'Перехватывает транспорты и бомберы'],
    give: 'Передайте авиазавод (или инженера — он построит его сам).'
  },
  naval: {
    name: 'Флот', color: '#4a8aff', short: 'ФЛОТ', needsWater: true, budget: 0.6,
    desc: 'Верфи, корабли, контроль моря и обстрел побережья. Доступно на картах с водой.',
    does: ['Строит верфь и береговую оборону', 'Собирает флотилии', 'Обстреливает береговые цели', 'Отводит корабли при перевесе врага'],
    give: 'Передайте верфь (или инженера для её постройки).'
  },
  defense: {
    name: 'Оборона базы', color: '#ff7a5c', short: 'ОБОРОНА', budget: 0.4,
    desc: 'Турели, ПВО, щиты и радар вокруг базы, гарнизон и реакция на нападение.',
    does: ['Ставит огневые точки и ПВО', 'Добавляет щиты и радар', 'Держит гарнизон у базы', 'Чинит укрепления, отражает налёты'],
    give: 'Передайте инженеров (и завод для гарнизона).'
  }
};
// улучшения своего sACU по областям (по одному на слот: правая рука → левая → спина), в порядке установки
const ENH_PLAN = { eco: ['s_eng', 's_res', 's_regen'], defense: ['s_eng', 's_res', 's_regen'], land: ['s_gun', 's_radar', 's_shield'], air: ['s_gun', 's_radar', 's_shield'], naval: ['s_gun', 's_radar', 's_shield'] };
export const AREA_ORDER = ['eco', 'land', 'air', 'naval', 'defense'];

export const STYLES = {
  cautious: { name: 'Осторожный', aggr: 0.7, firstAttack: 420, retreatK: 1.25, keep: 0.3, def: 1.3, minN: 11, riskK: 0.6 },
  balanced: { name: 'Сбалансированный', aggr: 1.0, firstAttack: 240, retreatK: 1.8, keep: 0.15, def: 1.0, minN: 8, riskK: 1.1 },
  aggressive: { name: 'Агрессивный', aggr: 1.45, firstAttack: 110, retreatK: 2.8, keep: 0.05, def: 0.7, minN: 6, riskK: 1.5 }
};

const NAMES = ['Орлова', 'Волков', 'Соколова', 'Ястребов', 'Громова', 'Беркут', 'Ветрова', 'Стрельцов', 'Лисицына', 'Барсов', 'Северова', 'Камнев'];

// ------------------------------------------------------------------ Lieutenant
export class Lieutenant {
  constructor(staff, id, area, opts = {}) {
    this.staff = staff; this.game = staff.g; this.team = staff.team; this.T = staff.g.teams[staff.team];
    this.id = id; this.area = area;
    this.sacu = opts.sacu; this.sacuId = opts.sacu.id; opts.sacu.lt = id; opts.sacu.ltHead = id; opts.sacu.platoon = null; opts.sacu.ltMan = null;
    this.style = opts.style || 'balanced'; this.budget = opts.budget ?? AREAS[area].budget; this.paused = false; this.zone = null;
    this.allowFac = opts.allowFac ?? true; this.autoUpg = opts.autoUpg ?? true; // тумблеры игрока: строить заводы / улучшать экстракторы и заводы сам
    this.free = { m: 0, e: 0 }; this.floating = false; this.idleEngs = 0; this.ePanic = false; this.floatT = 0; this.block = null;
    this.name = opts.name || `Лейтенант ${NAMES[(id * 5 + AREA_ORDER.indexOf(area) * 3) % NAMES.length]}`;
    this.logs = []; this.platoons = []; this.pid = 1; this.reserved = []; this.rallyMemo = {};
    this.status = 'Жду выданных юнитов'; this.dem = { m: 0, e: 0 }; this.allow = { m: 0, e: 0 }; this.projects = 0;
    this.stats = { built: {}, orders: 0, attacks: 0, retreats: 0 };
    this.builtSeen = new Set(); this.pending = {}; this.lastFlush = 0; this.noteT = {};
    this.allUnits = []; this.myUnits = []; this.ownStructs = []; this.myStructs = []; this.byId = new Map(); this.allById = new Map();
    this.held = 0; this.manualPrev = 0; this.tasks = []; this.pausedFacs = new Set();
    this.game.controllers.push(this);
    this.evSeen = this.game.events.length;
    this.g = makeGameProxy(this);
    this.intel = staff.intel;
    this.retreatK = STYLES[this.style].retreatK;
    this.retarget(true);
    this.say('ПРИКАЗ', `Принял область «${AREAS[area].name}», стиль «${STYLES[this.style].name}», бюджет ${Math.round(this.budget * 100)}%.`);
  }
  get A() { return AREAS[this.area]; }
  get st() { return STYLES[this.style]; }
  get isMil() { return this.area === 'land' || this.area === 'air' || this.area === 'naval' || this.area === 'defense'; }
  get attacks() { return this.area === 'land' || this.area === 'air' || this.area === 'naval'; }
  get label() { return `${this.name} — ${this.A.name}`; }

  say(cat, text, level = 'info', pos = null) {
    const last = this.logs[0];
    if (last && last.text === text && this.game.time - last.t < 20) return;
    this.logs.unshift({ t: this.game.time, cat, text, level, x: pos ? pos.x : undefined, y: pos ? pos.y : undefined });
    if (this.logs.length > MAX_LOG) this.logs.pop();
  }
  // Message into the player's notification feed (rate limited per key).
  notify(key, text, kind = 'info', pos = null) {
    const g = this.g;
    if (g.time - (this.noteT[key] || -99) < 25) return;
    this.noteT[key] = g.time;
    g.notify(this.team, `${this.A.name}: ${text}`, pos ? pos.x : this.base.x, pos ? pos.y : this.base.y, kind);
  }

  // ---------------------------------------------------------------- geometry & staging
  homeBase() {
    const facs = this.game.structs.filter(s => s.team === this.team && s.alive && s.built && s.spec.produces);
    if (!facs.length) return { ...this.T.start };
    let x = 0, y = 0; for (const f of facs) { x += f.x; y += f.y; }
    return { x: x / facs.length, y: y / facs.length };
  }
  setZone(z) {
    this.zone = z ? { x: clamp(z.x, 20, MAP_SIZE - 20), y: clamp(z.y, 20, MAP_SIZE - 20), r: clamp(z.r, 40, 400 * KM) } : null;
    this.retarget(true);
    this.say('ПРИКАЗ', this.zone ? `Зона ответственности: центр ${pt(this.zone)}, радиус ${Math.round(this.zone.r)}.` : 'Зона ответственности снята — действую по всей карте.', 'info', this.zone);
  }
  // Recompute anchor, direction to the (guessed) enemy and staging points.
  retarget(full = false) {
    const g = this.g, t = g.terrain;
    this.home = this.homeBase();
    this.base = this.zone ? { x: this.zone.x, y: this.zone.y } : { ...this.home };
    // the enemy start is never read from the game state: a known enemy building wins, otherwise the mirror of our base
    const known = [...this.intel.structs.values()].filter(r => r.spec.produces).sort((a, b) => dist(a, this.home) - dist(b, this.home))[0];
    this.enemyStart = known ? { x: known.x, y: known.y } : { x: MAP_SIZE - this.home.x, y: MAP_SIZE - this.home.y };
    const dx = this.enemyStart.x - this.base.x, dy = this.enemyStart.y - this.base.y, l = hyp(dx, dy) || 1;
    this.dir = { x: dx / l, y: dy / l };
    if (full || this.landReach === undefined) {
      const pd = t.pathDist('land', this.base.x, this.base.y, this.enemyStart.x, this.enemyStart.y);
      this.landReach = pd === null || pd === undefined ? 1000 * KM : pd;
      this.navalOk = !!g.map.naval;
    }
    const z = this.zone;
    this.staging = this.findPassableNear('land', z ? z.x : this.base.x + this.dir.x * 130, z ? z.y : this.base.y + this.dir.y * 130);
    this.airStaging = z ? { x: z.x, y: z.y } : { x: this.base.x + this.dir.x * 70, y: this.base.y + this.dir.y * 70 };
    if (this.navalOk && (full || !this.navalStaging)) this.navalStaging = this.findWaterNear(this.base, z ? z.r + 120 : 360 * KM);
    if (!this.navalOk) this.navalStaging = null;
  }
  inZone(p, margin = 0) { return !this.zone || hyp(p.x - this.zone.x, p.y - this.zone.y) <= this.zone.r + margin; }
  explored(p) { const T = this.T; return !this.game.opts.fog || T.explored[Math.min(PN - 1, (p.y / PCELL) | 0) * PN + Math.min(PN - 1, (p.x / PCELL) | 0)] === 1; }

  // ---------------------------------------------------------------- per tick
  update() {
    const g = this.g;
    if (g.over || !this.T.alive) return;
    this.claimNew();
    const k = g.tick + this.id * 7;
    if (k % 30 === 0) { this.snapshot(); this.phaseA(); this.flush(); }
    else if (k % 30 === 15) { this.snapshot(); this.phaseB(); }
  }
  // Units freshly built by handed-over factories go to the same lieutenant.
  claimNew() {
    const ev = this.game.events;
    for (; this.evSeen < ev.length; this.evSeen++) {
      const e = ev[this.evSeen];
      if (e.type !== 'unitBuilt' || e.team !== this.team || !e.factory || e.factory.lt !== this.id || !e.unit.alive) continue;
      e.unit.lt = this.id; e.unit.platoon = null;
      this.pending.units = (this.pending.units || 0) + 1;
    }
  }
  snapshot() {
    const g = this.g, now = g.time, id = this.id;
    this.allUnits = g.units.filter(u => u.alive && u.team === this.team && u.lt === id);
    this.ownStructs = g.structs.filter(s => s.alive && s.team === this.team && s.lt === id);
    this.myStructs = g.structs.filter(s => s.alive && s.team === this.team);
    this.reserved = this.reserved.filter(r => r.until > now);
    let manual = 0;
    for (const u of this.allUnits) if (this.checkManual(u, now)) manual++;
    if (manual > this.manualPrev) this.say('ПРИКАЗ', `Вы взяли под управление ${manual} ед. — не вмешиваюсь, пока приказ не выполнен.`);
    this.manualPrev = manual;
    this.myUnits = this.allUnits.filter(u => !u.carried && !(u.ltMan && u.ltMan.until > now));
    this.held = this.allUnits.length - this.myUnits.length;
    this.byId = new Map(this.myUnits.map(u => [u.id, u])); this.allById = new Map(this.allUnits.map(u => [u.id, u]));
    // structures raised by our engineers belong to us; completed ones are counted for notifications
    for (const e of this.myUnits) {
      const o = e.orders[0];
      if (o && o.type === 'build' && o.site && o.site.lt === undefined) o.site.lt = id;
    }
    for (const s of this.ownStructs) {
      if (s.built && !this.builtSeen.has(s.id)) {
        this.builtSeen.add(s.id);
        if (s.spec.upgradesTo || s.spec.place === 'mex' || s.spec.energy || s.spec.produces || s.spec.dps || s.spec.storeM || s.spec.storeE || s.spec.fabM || s.spec.shield) {
          this.stats.built[s.key] = (this.stats.built[s.key] || 0) + 1;
          this.pending[s.key] = (this.pending[s.key] || 0) + 1;
        }
      }
    }
    this.computeDemand();
    if (this.intel.structs.size && (g.tick % 300 === 0)) this.retarget(false);
  }
  // A unit is under manual control while it holds an order the player gave (no lieutenant tag, not an automatic order).
  checkManual(u, now) {
    let foreign = null;
    for (const o of u.orders) if (o.lt === undefined && !o.auto && !o.rally) { foreign = o; break; }
    if (!foreign) return !!(u.ltMan && u.ltMan.until > now);
    if (!u.ltMan) u.ltMan = { t0: now, until: now };
    const endless = foreign.type === 'patrol' || foreign.type === 'guard' || (foreign.type === 'assist' && foreign.target && !(foreign.target.kind === 'struct' && !foreign.target.built));
    if (endless && now - u.ltMan.t0 > ENDLESS) { this.adopt(u); u.ltMan = null; return false; }
    u.ltMan.until = now + GRACE;
    return true;
  }
  adopt(u) { for (const o of u.orders) if (o.lt === undefined) { o.lt = this.id; o.aiHelp = true; } }

  // Estimated resource flow of our own projects (engineer builds, factory queues, upgrades) against the budget.
  computeDemand() {
    const eco = this.T.eco;
    let dM = 0, dE = 0, fM = 0, fE = 0; const sites = new Set();
    const add = (S, bp) => { dM += S.costM / S.bt * bp; dE += S.costE / S.bt * bp; };
    for (const u of this.allUnits) {
      const o = u.orders[0]; if (!u.spec.bp || !o) continue;
      // инженер, который ещё идёт к месту стройки, пока почти не тратит: считаем его в треть силы
      if (o.type === 'build') {
        const k = o.site || hyp(u.x - o.x, u.y - o.y) < u.spec.buildRange + 10 ? 1 : 0.35, S = STRUCTS[o.key];
        add(S, u.spec.bp * k); sites.add(o.site ? o.site.id : o.x + ',' + o.y);
        if (o.key === 'mex' || S.energy) { fM += S.costM / S.bt * u.spec.bp * k; fE += S.costE / S.bt * u.spec.bp * k; } // нужное для роста — вне бюджета
      }
      else if ((o.type === 'assist' || o.type === 'repair') && o.target && o.target.kind === 'struct' && !o.target.built) { add(o.target.spec, u.spec.bp); sites.add(o.target.id); }
    }
    for (const s of this.ownStructs) {
      if (!s.built) continue;
      if (s.upgrading) {
        const S = STRUCTS[s.upgrading.to]; add(S, s.spec.bp || 10); sites.add('u' + s.id);
        if (s.spec.place === 'mex') { fM += S.costM / S.bt * 10; fE += S.costE / S.bt * 10; } // улучшение экстракторов — рост
      }
      else if (s.spec.produces && s.queue.length && !s.paused) {
        const U = UNITS[s.queue[0]], m = U.costM / U.bt * s.spec.bp, e = U.costE / U.bt * s.spec.bp;
        dM += m; dE += e; sites.add('f' + s.id);
        if (U.role === 'eng' || this.isMil) { fM += m; fE += e; } // инженеры — рост, основное производство армии бюджетом не режется
      }
    }
    this.projects = sites.size;
    this.dem = { m: dM, e: dE }; this.free = { m: fM, e: fE };
    // бюджет = доля трат: доход (минус содержание) делится между помощниками по весам бюджета, плюс стекающий излишек запаса
    const share = this.share, mult = eco.mult;
    this.floating = eco.mass > Math.max(450, Math.min(eco.maxMass * 0.4, 1000)) && eco.energy > eco.maxEnergy * 0.2 && !eco.stallE;
    this.floatT = this.floating ? this.floatT + 0.5 : 0;
    this.ePanic = eco.stallE && eco.energy < eco.maxEnergy * 0.12 && this.game.time > 60;
    const sM = Math.max(0, eco.mass - 150) / 25, sE = Math.max(0, eco.energy - eco.maxEnergy * 0.35) / 25;
    this.allow = { m: (eco.incM * mult + sM) * share, e: Math.max(10, eco.incE * mult - eco.upkeep + sE) * share };
    this.demAvg = this.demAvg || { m: 0, e: 0 };
    this.demAvg.m += (dM - this.demAvg.m) * 0.3; this.demAvg.e += (dE - this.demAvg.e) * 0.3;
  }
  // вес в делёжке дохода: экономика вкладывается в рост, поэтому её доля вдвое тяжелее, пока идёт стартовое развитие (до 10 мин)
  get weight() { return this.budget * (this.area === 'eco' ? (this.game.time < 600 ? 2 : 1.2) : 1); }
  get share() { const w = this.staff.list.reduce((a, l) => a + (l.paused ? 0 : l.weight), 0); return this.weight / Math.max(1, w); }
  // May a new project with the given per-second cost start? At least one project is always allowed; a floating stockpile lifts the limit.
  canSpend(rate) {
    if (this.ePanic) return false;
    if (this.projects === 0 || (this.idleEngs > 1 && this.T.eco.mass > 200 && !this.T.eco.stallE)) return true; // руки простаивают, а масса есть — бюджет не повод стоять
    return (this.floating || this.dem.m + rate.m <= this.allow.m + 1.5) && this.dem.e + rate.e <= this.allow.e + 10; // энергию «излишком запаса» не обойти: её не накопить
  }
  commit(rate) { this.dem.m += rate.m; this.dem.e += rate.e; this.projects++; }
  overBudget() { return this.projects > 0 && ((!this.floating && this.dem.m > this.allow.m + 1.5) || this.dem.e > this.allow.e + 10); }
  setBlock(kind, text) { if (!this.block || kind === 'energy') this.block = { kind, text }; }

  phaseA() {
    this.retarget(false);
    if (this.paused) { this.status = 'Пауза — жду приказа'; return; }
    if (!this.allUnits.length && !this.ownStructs.length) { this.status = 'Нет юнитов — передайте мне юнитов или завод'; return; }
    this.blocked = false; this.block = null; this.eNet = this.staff.econ().net;
    this.tasks = this.planBuilds();
    this.upgrades();
    this.enhanceSacu();
    this.engineers(this.tasks);
    this.factories();
    this.diagnose();
    this.updateStatus();
  }
  phaseB() {
    if (this.paused) return;
    if (this.isMil) this.military();
    if (this.area === 'land') this.trail();
    this.updateStatus();
  }
  flush() {
    const g = this.g;
    if (g.time - this.lastFlush < 45) return;
    const p = this.pending; const bits = [];
    const nm = { mex: ['экстрактор', 'экстрактора', 'экстракторов'], pgen: ['электростанция', 'электростанции', 'электростанций'], mstore: ['хранилище массы', 'хранилища массы', 'хранилищ массы'], estore: ['хранилище энергии', 'хранилища энергии', 'хранилищ энергии'], pd: ['огневая точка', 'огневые точки', 'огневых точек'], aa_turret: ['ПВО-турель', 'ПВО-турели', 'ПВО-турелей'], mfab: ['масс-фабрикатор', 'масс-фабрикатора', 'масс-фабрикаторов'] };
    const plural = (n, f) => { const m10 = n % 10, m100 = n % 100; return n + ' ' + (m10 === 1 && m100 !== 11 ? f[0] : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? f[1] : f[2]); };
    for (const k of Object.keys(p)) if (nm[k]) bits.push(plural(p[k], nm[k]));
    if (p.units >= 4 && this.area !== 'eco') bits.push(`${p.units} ед. с завода`);
    if (bits.length && (this.area === 'eco' || this.area === 'defense' || this.area === 'land')) {
      this.lastFlush = g.time;
      g.notify(this.team, `${this.A.name}: построено — ${bits.join(', ')}`, this.base.x, this.base.y, 'good');
      this.pending = {};
    } else if (bits.length && g.time - this.lastFlush > 120) { this.pending = {}; }
  }
  updateStatus() {
    if (this.paused) { this.status = 'Пауза — жду приказа'; return; }
    if (!this.allUnits.length && !this.ownStructs.length) { this.status = 'Нет юнитов — передайте мне юнитов или завод'; return; }
    const engs = this.myUnits.filter(u => u.spec.role === 'eng');
    const building = engs.filter(u => u.orders[0] && (u.orders[0].type === 'build' || u.orders[0].type === 'assist' || u.orders[0].type === 'repair' || u.orders[0].type === 'reclaim'));
    const parts = [];
    if (engs.length) {
      const o = building.map(u => u.orders[0]).find(o => o.type === 'build');
      if (o) parts.push(`Строю ${STRUCTS[o.key].name[0].toLowerCase()}${STRUCTS[o.key].name.slice(1)}${building.length > 1 ? ` (+${building.length - 1} инж.)` : ''}`);
      else if (building.length) parts.push(`Помогаю/чиню: ${building.length} инж.`);
      else parts.push('Инженеры свободны');
    }
    const fac = this.ownStructs.find(s => s.spec.produces && s.built && s.queue.length);
    if (this.isMil) {
      const pl = this.platoons.filter(p => p.units.length && p.mission !== 'reserve').sort((a, b) => b.pow - a.pow)[0];
      if (pl && pl.status) parts.push(pl.status);
      else {
        const res = this.platoons.find(p => p.mission === 'reserve');
        if (res && res.units.length) parts.push(res.status || `Резерв: ${res.units.length} ед.`);
      }
    }
    if (fac && !this.isMil) parts.push(`Завод: ${UNITS[fac.queue[0]].name}`);
    if (this.block) parts.push(this.block.text);
    if (this.held) parts.push(`вручную: ${this.held}`);
    this.status = parts.join(' · ') || 'Жду задач';
  }

  // Главная причина простоя — для карточки в Штабе.
  diagnose() {
    const eco = this.T.eco;
    if (this.ePanic) this.setBlock('energy', 'Дефицит энергии — новые проекты на паузе');
    else if (!this.myUnits.some(u => u.spec.role === 'eng')) this.setBlock('noeng', 'Нет инженеров');
    else if (this.blocked) this.setBlock('budget', 'Бюджет исчерпан — жду');
    const type = { land: 'land', air: 'air', naval: 'naval', eco: 'land' }[this.area];
    if (type && !this.block && !this.ownStructs.some(s => s.spec.produces === type) && !this.inProg(type + '_fac')) {
      this.setBlock('nofac', !this.allowFac ? 'Нет завода, а строить заводы запрещено' : eco.mass < 120 ? 'Нет завода — копит массу' : 'Нет завода — ищу место');
    }
  }

  // ---------------------------------------------------------------- build planning
  hasEng(tier) { return this.myUnits.some(u => u.spec.role === 'eng' && u.spec.tier >= tier); }
  // Сколько заводов типа нужно при нынешнем доходе (доля помощника, +1 при залежавшейся массе).
  facWant(type) {
    const facs = this.ownStructs.filter(s => s.spec.produces === type), incM = this.T.eco.incM * this.T.eco.mult;
    const avgBP = facs.length ? facs.reduce((a, f) => a + f.spec.bp, 0) / facs.length : 20;
    const mil = this.staff.list.filter(l => l.attacks && !l.paused).reduce((a, l) => a + l.budget, 0) || 1;   // доход делят между собой «заводские» области
    const total = clamp(Math.round(incM * 2.2 / avgBP) + Math.floor(this.floatT / 8), 1, 20);   // как у AICommander: заводов столько, сколько армии по силам прокормить
    return clamp(Math.round(total * Math.min(1, this.budget / mil)), 1, 12);
  }
  // Задача на постройку завода типа `type`, если их мало (первый — срочно, остальные — по доходу).
  facTask(tasks, type, near, first = 95) {
    const eco = this.T.eco, key = type + '_fac';
    const have = this.ownStructs.filter(s => s.spec.produces === type).length + this.inProg(key), want = this.facWant(type);
    if (!this.allowFac || !near || (this.ePanic && have) || this.game.time < (type === 'land' ? 15 : 30) || (this.game.time < 120 && (type !== 'land' || have) && eco.incE * eco.mult < 100)) return; // в первые минуты — экстракторы и электростанции
    if (have && (eco.stallE || eco.energy < eco.maxEnergy * 0.25)) return; // лишние заводы — только при здоровой энергетике
    if (have < want && (eco.mass > 100 || this.floating || have < 3)) tasks.push({ key, prio: have ? 56 : first, near, max: Math.min(2, want - have), first: have < 2 }); // два первых завода области — без оглядки на бюджет
  }
  teamTier() { return Math.max(1, ...this.myStructs.filter(s => s.spec.produces && s.built).map(s => s.spec.tier)); }
  inProg(key) {
    return this.game.units.filter(u => u.team === this.team && u.alive && u.orders[0]?.type === 'build' && u.orders[0].key === key).length
      + this.myStructs.filter(s => !s.built && s.key === key).length;
  }
  countNear(pred, c, r) { return this.myStructs.filter(s => pred(s) && dist(s, c) <= r).length; }
  planBuilds() {
    switch (this.area) {
      case 'eco': return this.planEco();
      case 'land': return this.planLand();
      case 'air': return this.planFactoryAndFriends('air');
      case 'naval': return this.planFactoryAndFriends('naval');
      case 'defense': return this.planDefense();
    }
    return [];
  }
  unfinished(tasks, filter) {
    for (const s of this.myStructs) {
      if (s.built || tasks.some(tk => tk.site === s)) continue;
      if (filter && !filter(s)) continue;
      const big = s.spec.bt >= 1400;
      if (!big && this.allUnits.some(u => u.orders[0] && (u.orders[0].site === s || u.orders[0].target === s))) continue;
      tasks.push({ key: s.key, prio: big ? 55 : 70, site: s, near: s, max: big ? 4 : 1 });
    }
  }
  // Free, safe, explored mass deposits (optionally only those matching `pred`).
  freeMex() {
    const g = this.g;
    if (this._fm && this._fm.tick === g.tick) return this._fm.v;
    const out = [];
    const claimed = new Set(g.units.filter(u => u.team === this.team && u.alive).flatMap(u => u.orders.filter(o => o.type === 'build' && o.key === 'mex').map(o => o.x + ',' + o.y)));
    const I = this.intel;
    for (const m of g.terrain.mass) {
      if (g.structs.some(s => s.alive && s.spec.place === 'mex' && s.x === m.x && s.y === m.y)) continue;
      if (claimed.has(m.x + ',' + m.y)) continue;
      if (!this.inZone(m)) continue;
      if (I.threatAt('land', m.x, m.y, 30) > 25) continue;
      if (!this.mexReach(m)) continue;
      if (!isFinite(g.terrain.pathDist('land', m.x, m.y, this.home.x, this.home.y) ?? 0)) continue;
      out.push(m);
    }
    this._fm = { tick: g.tick, v: out };
    return out;
  }
  mexReach(m) {
    const dB = dist(m, this.home), dE = dist(m, this.enemyStart);
    if (!this.zone && (dB > 1400 * KM || dE < 170)) return false;
    return !(dE < dB * 0.7 && this.game.time < 480);
  }

  // Задачи на свободные месторождения (приоритет `base`; maxD ограничивает удаление от базы).
  mexTasks(tasks, base, maxD = 1e9) {
    for (const m of this.freeMex()) {
      const dB = dist(m, this.home), dE = dist(m, this.enemyStart);
      if (dB > maxD) continue;
      tasks.push({ key: 'mex', prio: base - dB / (60 * KM) + (dE > dB ? 4 : -4) - (this.explored(m) ? 0 : 12), pos: { x: m.x, y: m.y }, max: 1 });
    }
  }
  // Охрана дальних экстракторов (PD там, где их недавно разгромили или рядом враг) — одна на всех помощников.
  guardTasks(tasks) {
    if (this.staff.guard !== this && !(this.area === 'eco' && this.floatT > 10)) return;
    const eco = this.T.eco, I = this.intel, t = this.game.time;
    const pdKey = this.hasEng(2) && eco.incM * eco.mult > 25 ? 'pd2' : 'pd', raids = this.staff.raids;
    let n = 0;
    for (const m of this.myStructs.filter(s => s.built && s.spec.place === 'mex' && dist(s, this.home) > 150 * KM)) {
      if (n >= (this.floatT > 10 ? 4 : 2)) break;
      const hot = raids.some(r => hyp(r.x - m.x, r.y - m.y) < 140) || I.threatAt('land', m.x, m.y, 120) > 5;
      if ((!hot && this.floatT <= 10) || this.myStructs.some(s => (s.key === 'pd' || s.key === 'pd2') && dist(s, m) < 55)) continue;   // масса залежалась — охраняем и спокойные
      tasks.push({ key: pdKey, prio: hot ? 63 : 45, near: m, max: 1 }); n++;
    }
  }

  planEco() {
    const g = this.g, eco = this.T.eco, t = g.time, tasks = [];
    if (!this.myUnits.some(u => u.spec.role === 'eng')) return tasks;
    const mult = eco.mult, incM = eco.incM * mult, incE = eco.incE * mult;
    const near = this.zone ? this.base : { x: this.home.x - this.dir.x * 40, y: this.home.y - this.dir.y * 40 };
    // своего завода нет — некому делать инженеров: строим один сами (больше не нужно)
    if (!this.ownStructs.some(s => s.spec.produces === 'land') && !this.inProg('land_fac') && this.allowFac && !eco.stallE && eco.energy > eco.maxEnergy * 0.25 && (t > 120 || incE >= 60)) tasks.push({ key: 'land_fac', prio: 88, near, max: 1, first: true });
    const facs = this.myStructs.filter(s => s.spec.produces && s.built);
    const needE = this.needE = this.staff.econ().needE;
    const net = this.eNet = incE - eco.upkeep - eco.spendE;   // реальный баланс энергии: доход − содержание − фактическая трата
    const eShort = eco.stallE || (eco.energy < eco.maxEnergy * 0.3 && t > 60) || (incE < needE * 0.95 && eco.energy < eco.maxEnergy * 0.5) || incE < needE * 0.6 || (net < 0 && eco.energy < -net * 150); // запаса хватит меньше чем на 150 с или он почти пуст
    const hardStall = eco.stallE && eco.energy < eco.maxEnergy * 0.25;
    // Т2/Т3 станции стоят 12–58 тыс. энергии, но дают в 25–125 раз больше Т1: берём их, когда масса есть, а энергии не хватает
    const gap = needE - incE;
    const genKey = hardStall ? 'pgen' : this.hasEng(3) && gap > 700 && incE > 500 && eco.mass > 2200 ? 'pgen3' : this.hasEng(2) && gap > 150 && incE > 100 && eco.mass > 800 ? 'pgen2' : 'pgen';
    if (eShort) {
      const n = genKey === 'pgen' ? clamp(Math.ceil((needE - incE) / 20), 1, hardStall ? 8 : 5) : genKey === 'pgen2' ? clamp(Math.floor(gap / 600) + 1, 1, 3) : 1;
      const fac = facs.filter(f => f.spec.produces !== 'naval').sort((a, b) => b.spec.tier - a.spec.tier || dist(a, this.home) - dist(b, this.home))[0];
      if (this.inProg(genKey) < n) tasks.push({ key: genKey, prio: eco.stallE || (eco.energy < eco.maxEnergy * 0.6 && incE < needE) ? 97 : incE < needE * 0.8 ? 90 : 72, near, adj: genKey !== 'pgen3' ? fac : null, max: n - this.inProg(genKey) + (genKey !== 'pgen' ? 2 : 0) });
    }
    this.mexTasks(tasks, 92);
    // mass fabricators on an energy surplus
    const eSurplus = incE - eco.upkeep - needE;
    const eFab = eco.energy > eco.maxEnergy * 0.8 && net > 250;   // энергия упирается в склад — превращаем излишек в массу
    const fabKey = this.hasEng(3) && eSurplus > 1700 ? 'mfab3' : this.hasEng(2) && (eSurplus > 200 || eFab) ? 'mfab' : null;
    if (fabKey && !eco.stallE && !this.floating && eco.energy > eco.maxEnergy * 0.6 && this.inProg(fabKey) < (eFab ? 2 : 1)) {   // масса и так лишняя — фабрикаторы только жрали бы энергию
      const gen = this.myStructs.find(s => s.built && s.spec.energy >= 500);
      tasks.push({ key: fabKey, prio: eFab ? 66 : 48, near: gen || near, adj: gen && fabKey === 'mfab' ? gen : null, max: eFab ? 2 : 1 });
    }
    // storages hugging upgraded extractors (adjacency) and overflow relief
    const cnt = (k) => this.myStructs.filter(s => s.key === k).length + this.inProg(k);
    const mx2 = this.myStructs.filter(s => s.built && s.spec.place === 'mex' && s.spec.tier >= 3 && (s.adj?.n.length || 0) < 4 && this.intel.threatAt('land', s.x, s.y) < 20)
      .sort((a, b) => b.spec.tier - a.spec.tier || dist(a, this.home) - dist(b, this.home))[0];
    if (mx2 && !eco.stallM && cnt('mstore') < 40) tasks.push({ key: 'mstore', prio: 44, near: mx2, adj: mx2, max: 1 });
    if (eco.mass > eco.maxMass * 0.95 && !eco.stallE && incM > 8 && cnt('mstore') < 3) tasks.push({ key: 'mstore', prio: 22, near, max: 1 });
    if (eco.energy > eco.maxEnergy * 0.95 && incE > 150 && cnt('estore') < 2 && t > 200) tasks.push({ key: 'estore', prio: 24, near, max: 1 });
    // масса залежалась, а строить больше нечего — вкладываем в укрепления вокруг базы (тоже защита заводов и инженеров)
    if (this.floatT > 10 && incM > 50 && this.hasEng(2)) {
      const ring = this.myStructs.filter(s => (s.key === 'pd2' || s.spec.shield) && dist(s, this.home) < 220).length + this.inProg('pd2') + this.inProg('shield');
      if (ring < clamp(6 + Math.floor(this.floatT / 10), 6, 24)) {
        const a = Math.random() * 6.28, r = 60 + Math.random() * 110;
        tasks.push({ key: ring % 5 === 4 && incE > 1000 ? 'shield' : 'pd2', prio: 42, near: { x: this.home.x + Math.cos(a) * r, y: this.home.y + Math.sin(a) * r }, max: 2 });
      }
    }
    this.guardTasks(tasks);
    this.unfinished(tasks, s => s.lt === this.id);
    return tasks.sort((a, b) => b.prio - a.prio);
  }
  // Air / naval lieutenants only need their own factory (built by the handed-over engineer when they have none).
  planFactoryAndFriends(type) {
    const tasks = [];
    if (!this.myUnits.some(u => u.spec.role === 'eng')) return tasks;
    const eco = this.T.eco, t = this.game.time;
    const site = type === 'naval' ? this.navalStaging : { x: this.base.x - this.dir.x * 25, y: this.base.y - this.dir.y * 25 };
    this.facTask(tasks, type, site);
    if (t < 600) this.mexTasks(tasks, 76, 350 * KM);   // у авиации и флота sACU часто простаивает — пусть ставит экстракторы рядом с базой
    if (this.wantBP() > 0 && this.allowFac && !this.ownStructs.some(s => s.spec.produces === 'land') && !this.inProg('land_fac') && eco.energy > eco.maxEnergy * 0.25) tasks.push({ key: 'land_fac', prio: 58, near: { x: this.base.x - this.dir.x * 45, y: this.base.y - this.dir.y * 45 }, max: 1 });
    if (type === 'naval' && this.navalStaging) {
      const I = this.intel;
      if (I.comp.naval > 2 && this.myStructs.filter(s => s.key === 'torp').length + this.inProg('torp') < 2) tasks.push({ key: 'torp', prio: 45, near: this.navalStaging, max: 1 });
      if (t > 300 && this.myStructs.filter(s => s.key === 'sonar').length + this.inProg('sonar') < 1) tasks.push({ key: 'sonar', prio: 30, near: this.navalStaging, max: 1 });
    }
    if (type === 'air' && t > 200 && this.myStructs.filter(s => s.spec.radar).length + this.inProg('radar') < 1 && eco.energy > 600) tasks.push({ key: 'radar', prio: 32, near: { x: this.base.x + this.dir.x * 40, y: this.base.y + this.dir.y * 40 }, max: 1 });
    this.unfinished(tasks, s => s.lt === this.id);
    return tasks.sort((a, b) => b.prio - a.prio);
  }
  planLand() {
    const tasks = [];
    if (!this.myUnits.some(u => u.spec.role === 'eng')) return tasks;
    const eco = this.T.eco;
    this.facTask(tasks, 'land', { x: this.base.x + this.dir.x * 30, y: this.base.y + this.dir.y * 30 });
    this.mexTasks(tasks, 86);   // месторождения на стороне фронта
    this.guardTasks(tasks);
    // hold captured deposits with a gun emplacement (cautious: every deposit, balanced: every other one)
    const mexes = this.ownStructs.filter(s => s.built && s.spec.place === 'mex');
    const perK = (this.style === 'cautious' ? 1 : this.style === 'balanced' ? 0.5 : 0.25) + (this.floatT > 3 ? 0.5 : 0);
    const pdHave = this.myStructs.filter(s => s.key === 'pd' || s.key === 'pd2').length + this.inProg('pd');
    if (perK && pdHave < mexes.length * perK && (eco.mass > 120 || this.floating) && this.game.time > 200) {
      const mx = mexes.filter(m => !this.myStructs.some(s => (s.key === 'pd' || s.key === 'pd2') && dist(s, m) < 45)).sort((a, b) => dist(b, this.home) - dist(a, this.home))[0];
      if (mx) tasks.push({ key: 'pd', prio: 40, near: mx, max: 1 });
    }
    this.unfinished(tasks, s => s.lt === this.id);
    return tasks.sort((a, b) => b.prio - a.prio);
  }
  planDefense() {
    const g = this.g, eco = this.T.eco, t = g.time, tasks = [], I = this.intel, st = this.st;
    if (!this.myUnits.some(u => u.spec.role === 'eng')) return tasks;
    const c = this.base, R = this.zone ? this.zone.r : 130, incM = eco.incM * eco.mult, incE = eco.incE * eco.mult;
    const toward = this.lastAttackPos && dist(this.lastAttackPos, c) < R + 300 ? this.lastAttackPos : { x: c.x + this.dir.x * R, y: c.y + this.dir.y * R };
    const a = Math.atan2(toward.y - c.y, toward.x - c.x);
    const ring = (r, spread) => { const b = a + (Math.random() - 0.5) * spread; return { x: c.x + Math.cos(b) * r, y: c.y + Math.sin(b) * r }; };
    const pdKey = this.hasEng(2) && incM > 12 ? 'pd2' : 'pd';
    const have = (pred) => this.countNear(pred, c, R + 60) + 0;
    const recent = t - (this.lastBaseAttackT || -999) < 120;
    const wantPd = Math.floor(st.def * (1 + incM / 5) + (recent ? 2 : 0) + Math.min(8, (this.baseThreat || 0) / 120) + (this.floatT > 3 ? 3 : 0));
    const pdHave = have(s => s.key === 'pd' || s.key === 'pd2') + this.inProg(pdKey);
    if (pdHave < wantPd && (eco.mass > 90 || this.floating) && t > 60) tasks.push({ key: pdKey, prio: recent ? 68 : 42, near: ring(R * 0.6, 1.6), max: 1 });
    const enemyAir = I.totalPower(s => s.move === 'air' && s.role !== 'scout');
    const strike = [...I.units.values()].some(u => u.spec.role === 'gunship' || u.spec.role === 'bomber');
    const aaKey = this.hasEng(2) && incM > 12 ? 'flak2' : 'aa_turret';
    const wantAA = Math.floor((t > 240 ? 1 : 0) + st.def * (enemyAir > 120 ? 2 : 0) + (strike ? 2 : 0) + incM / 12 + Math.min(6, enemyAir / 250));
    const aaHave = have(s => s.key === 'aa_turret' || s.key === 'flak2') + this.inProg(aaKey);
    if (aaHave < wantAA && eco.mass > 70) tasks.push({ key: aaKey, prio: strike ? 62 : 46, near: ring(R * 0.4, 6.28), max: 1 });
    if (this.hasEng(2)) {
      const wantSh = clamp(Math.floor((I.comp.arty > 3 ? 1 : 0) + (st.def > 1 ? 1 : 0) + incM / 40), 0, 3);
      if (incE > 500 && have(s => s.spec.shield) + this.inProg('shield') < wantSh) tasks.push({ key: 'shield', prio: 47, near: c, max: 1 });
    }
    if (t > 150 && this.myStructs.filter(s => s.spec.radar && s.spec.place === 'land').length + this.inProg('radar') < 1 && eco.energy > 500) tasks.push({ key: 'radar', prio: 34, near: { x: c.x + this.dir.x * 45, y: c.y + this.dir.y * 45 }, max: 1 });
    if (this.navalOk && this.navalStaging && I.comp.naval > 2 && have(s => s.key === 'torp') + this.inProg('torp') < 2) tasks.push({ key: 'torp', prio: 45, near: this.navalStaging, max: 1 });
    this.guardTasks(tasks);
    if (t < 900) this.mexTasks(tasks, 78, 450 * KM);   // пока месторождений много, свободные руки обороны тоже занимают их
    // damaged fortifications get repaired by idle engineers (see engineers()); unfinished ones are finished
    this.unfinished(tasks, s => s.lt === this.id);
    return tasks.sort((a, b) => b.prio - a.prio);
  }

  // ---------------------------------------------------------------- улучшения командира (sACU), по образцу enhanceACU у ИИ
  enhanceSacu() {
    const u = this.sacu, g = this.g, eco = this.T.eco, o = u.orders[0];
    if (!this.autoUpg || !u.alive || !u.enh || u.carried || this.ePanic || !this.byId.has(u.id)) return;   // нет тумблера / дефицит энергии / игрок держит командира
    if (o && o.type === 'enhance') return;   // установка уже идёт (своя или приказ игрока) — не перебиваем
    if (o && !o.auto && !o.aiHelp && !o.rally) return;   // занят настоящим приказом (стройка)
    if (g.time < 240 || (this.baseThreat || 0) > 150 || dist(u, this.home) > 200 || this.intel.threatAt('land', u.x, u.y, 80) > 10) return;
    const k = ENH_PLAN[this.area].find(x => !u.enh[ENH[x].slot]);
    if (!k) return;
    const E = ENH[k], rate = { m: E.costM / E.bt * u.spec.bp, e: E.costE / E.bt * u.spec.bp };
    if (eco.incM * eco.mult < 8 || eco.stallE || eco.energy < eco.maxEnergy * 0.5 || eco.mass < Math.max(100, E.costM * 0.3) || !(this.eNet > rate.e * 0.5 || eco.energy > eco.maxEnergy * 0.7)) return;
    if (!this.canSpend(rate)) { this.blocked = true; return; }
    g.orderEnhance([u], k); this.commit(rate);
    this.say('ТЕХНОЛОГИИ', `Командир ставит улучшение «${E.name}» (${E.costM} М / ${E.costE} Э).`, 'info', u);
  }

  // ---------------------------------------------------------------- upgrades (economy / factories)
  upgrades() {
    const g = this.g, eco = this.T.eco, t = g.time, incM = eco.incM * eco.mult, fl = this.floating;
    if (!this.autoUpg || !this.ownStructs.length || this.ePanic || (eco.energy < eco.maxEnergy * 0.35 && (this.eNet || 0) < 0)) return; // энергии на улучшения не хватает: сначала станции
    const start = (s, U, speak, text) => {
      const rate = { m: U.costM / U.bt * (s.spec.bp || 10), e: U.costE / U.bt * (s.spec.bp || 10) };
      if (!(this.eNet > rate.e || eco.energy > eco.maxEnergy * 0.7)) return false; // улучшение не должно тянуть энергию в дефицит
      if (!this.canSpend(rate) || eco.mass < Math.min(60, U.costM * 0.1)) { this.blocked = true; return false; }
      g.upgrade(s); this.commit(rate); this.say(speak, text, 'info', s); return true;
    };
    // экстракторы (как у AICommander): бюджет массы на улучшения общий на команду, первыми — с лучшей окупаемостью
    if (t > 100 && eco.energy > eco.maxEnergy * 0.2 && !(this.attacks && !this.ownStructs.some(s => s.spec.produces && s.built))) {   // армейскому помощнику сперва свой завод
      const E = this.staff.econ(), tier = this.teamTier(), drawOf = (st, U) => U.costM / U.bt * (st.spec.bp || 10);
      const cands = this.ownStructs.filter(s => s.built && s.spec.place === 'mex' && s.spec.upgradesTo && !s.upgrading)
        .filter(s => (s.spec.tier === 1 && incM >= 6) || (s.spec.tier === 2 && incM >= 26 && tier >= 2))
        .filter(s => this.intel.threatAt('land', s.x, s.y) < 30)
        .map(s => { const U = STRUCTS[s.spec.upgradesTo]; return { s, U, sc: U.costM / (U.mass - s.spec.mass) + dist(s, this.home) / 10 / KM }; }).sort((a, b) => a.sc - b.sc);
      for (const { s: mx, U } of cands) {
        const d = drawOf(mx, U);
        if (E.upDraw >= E.upBudget || (E.upDraw && (E.upDraw + d > E.upBudget * 1.3 || eco.effM < 0.5))) break;
        if (!(this.eNet > U.costE / U.bt * 10 || eco.energy > eco.maxEnergy * 0.7)) break;   // улучшение не должно тянуть энергию в дефицит
        g.upgrade(mx); E.upDraw += d; this.say('ЭКОНОМИКА', `Улучшаю экстрактор до ${U.short} у ${pt(mx)} (окупаемость ~${Math.round(U.costM / (U.mass - mx.spec.mass))} с).`, 'info', mx);
      }
    }
    // заводы лезут вверх по тирам вслед за доходом, даже когда очередь не пуста (производство на время апгрейда стоит)
    const target = incM >= 30 ? 3 : incM >= 9 && t > 150 ? 2 : 1;
    if (target > 1) {
      const cur = this.ownStructs.filter(s => s.upgrading && s.spec.produces).length;
      const lone = (s) => this.ownStructs.filter(f => f.spec.produces === s.spec.produces).length < 2 && ((!fl && incM < (s.spec.tier === 1 ? 14 : 40)) || (this.area !== 'eco' && this.allUnits.filter(u => u.spec.dps > 0 && u.spec.role !== 'eng' && u.spec.move === (s.spec.produces === 'air' ? 'air' : s.spec.produces === 'naval' ? 'naval' : u.spec.move)).length < 5)); // единственный завод на время апгрейда встаёт: ждём дохода и первых юнитов
      const f = cur < (fl && (this.eNet || 0) > 0 ? 2 : 1) && this.ownStructs.filter(s => s.built && s.spec.produces && s.spec.upgradesTo && !s.upgrading && s.spec.tier < target && !lone(s))
        .sort((a, b) => a.spec.tier - b.spec.tier || b.queue.length - a.queue.length)[0];
      if (f) { const U = STRUCTS[f.spec.upgradesTo]; start(f, U, 'ТЕХНОЛОГИИ', `Улучшаю ${f.spec.name} → ${U.name}.`); }
    }
  }

  // ---------------------------------------------------------------- engineers
  engineers(tasks) {
    const g = this.g;
    const engs = this.myUnits.filter(u => u.spec.role === 'eng');
    if (!engs.length) return;
    this.idleEngs = 0;
    for (const e of engs) {
      const o = e.orders[0];
      // побитый командир уходит на базу: его гибель распускает помощника
      if (e === this.sacu && e.hp < e.maxHp * 0.65 && this.intel.threatAt('land', e.x, e.y, 60) > 10) {
        if (dist(e, this.home) > 80 && !(o && o.retreat)) { g.orderMove([e], this.home.x, this.home.y); if (e.orders[0]) { e.orders[0].aiHelp = true; e.orders[0].retreat = true; } }
        continue;
      }
      const drop = this.ePanic && o && o.lt !== undefined && o.type !== 'enhance' && !this.essential(o.type === 'build' ? o.key : o.target && o.target.key); // дефицит энергии: всё, кроме электростанций и экстракторов, бросаем
      if (o && !o.auto && !o.aiHelp && !o.rally && !drop) continue; // busy with a real order
      if (e.brain.flee) continue;
      let best = null, bs = -1e9;
      for (const tk of tasks) {
        if ((tk.assigned || 0) >= tk.max) continue;
        if (!tk.site && !e.spec.canBuild.includes(tk.key)) continue;
        if (this.ePanic && !this.essential(tk.key)) continue;
        const p = tk.pos || tk.near;
        if (e === this.sacu && (this.intel.threatAt('land', p.x, p.y, 30) > 8 || (dist(p, this.home) > (this.area === 'land' ? 650 : 300) && !tk.first && !(tk.site && tk.site.lt === this.id)))) continue; // командира не пускаем под огонь и далеко от базы
        const sc = tk.prio - dist(e, p) / 12;
        if (sc > bs) { bs = sc; best = tk; }
      }
      if (best) {
        const S = STRUCTS[best.key], rate = { m: S.costM / S.bt * e.spec.bp, e: S.costE / S.bt * e.spec.bp };
        // energy and extractors are the point of the economy: they may start even a bit above the budget line when power is short
        const urgent = best.prio >= 85 || best.first || best.key === 'mex' || (S.energy && !best.site) || (this.ePanic && S.energy); // экстрактор окупается за секунды — бюджетом не режем
        if (!urgent && !best.site && !this.canSpend(rate)) { this.blocked = true; this.idleEngs++; this.hold(e); continue; }
        if (!urgent && best.site && !this.canSpend(rate) && this.projects > 0) { this.blocked = true; this.idleEngs++; this.hold(e); continue; }
        if (best.site) {
          if (!(o && o.type === 'assist' && o.target === best.site)) g.orderAssist([e], best.site);
          best.assigned = (best.assigned || 0) + 1; this.dem.m += rate.m; this.dem.e += rate.e;
          continue;
        }
        const spot = best.pos ? { x: best.pos.x, y: best.pos.y, ok: true } : (best.adj && this.findAdjSpot(best.key, best.adj)) || this.findSpot(best.key, best.near);
        if (!spot) { best.assigned = best.max; continue; }
        const c = g.orderBuild([e], best.key, spot.x, spot.y);
        if (c && c.ok) {
          best.assigned = (best.assigned || 0) + 1; this.commit(rate);
          this.reserve(c.x, c.y, S.size); this.stats.orders++;
          this.say(this.area === 'defense' ? 'ОБОРОНА' : 'ЭКОНОМИКА', `${e.spec.short} #${e.id}: строю ${S.name} у ${pt(c)}.`, 'info', c);
        } else best.assigned = best.max;
        continue;
      }
      if (this.idleJob(e)) continue;
      this.idleEngs++;
      if (this.overBudget()) this.hold(e);
    }
  }
  // Over budget: the engineer's own autonomy (auto-built extractors etc.) must not spend past the limit either.
  // что не бросают даже при дефиците энергии: экстракторы, электростанции и самый первый завод области
  essential(key) { const S = STRUCTS[key]; return key === 'mex' || !!(S && (S.energy || (S.produces && !this.ownStructs.some(s => s.built && s.spec.produces === S.produces)))); }
  hold(e) {
    if (e.brain) e.brain.nextAuto = Math.max(e.brain.nextAuto || 0, this.game.time + 4);
    const o = e.orders[0]; if (o && o.auto && o.type === 'build') e.orders.length = 0;
  }
  // Стройки и апгрейды других помощников (только их, не игрока): помочь — не значит командовать; при залежавшейся массе — и производство армии.
  staffHelp() { return this.area === 'eco' ? this.myStructs.filter(s => s.lt !== undefined && s.lt !== this.id && (s.upgrading || !s.built || (this.floatT > 5 && s.spec.produces && s.queue.length))) : []; }
  // No task: repair damaged buildings, reclaim wrecks, help factories — all within reach.
  idleJob(e) {
    const g = this.g, eco = this.T.eco;
    const o = e.orders[0], mark = () => { if (e.orders[0]) e.orders[0].aiHelp = true; return true; };
    // дефицит энергии: все свободные руки — на недостроенные электростанции
    if (this.ePanic) {
      const gen = this.myStructs.filter(s => !s.built && s.spec.energy && dist(s, e) < 400).sort((a, b) => dist(a, e) - dist(b, e))[0];
      if (gen) { if (!(o && o.target === gen)) { g.orderAssist([e], gen); mark(); } return true; }
    }
    const hurt = this.myStructs.filter(s => s.built && s.hp < s.maxHp * 0.75 && dist(s, e) < 220 && this.inZone(s, 60)).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
    if (hurt && !(o && o.type === 'repair' && o.target === hurt)) { g.orderRepair([e], hurt); mark(); this.say(this.area === 'defense' ? 'ОБОРОНА' : 'ЭКОНОМИКА', `Чиню ${hurt.spec.name} (${Math.round(hurt.hp / hurt.maxHp * 100)}%).`, 'info', hurt); return true; }
    if (hurt) return true;
    if (eco.mass < eco.maxMass * (this.area === 'eco' ? 0.85 : 0.5)) {
      let best = null, bd = 140;
      for (const w of g.wrecks) { const d = dist(e, w); if (d < bd && this.inZone(w) && this.intel.threatAt('land', w.x, w.y, 40) < 15) { bd = d; best = w; } }
      if (best && !(o && o.type === 'reclaim' && o.target === best)) { g.orderReclaim([e], best); mark(); this.say('ЭКОНОМИКА', `Разбираю обломки (${Math.round(best.mass || 0)} массы) у ${pt(best)}.`, 'info', best); return true; }
      if (best) return true;
    }
    // help an owned factory or upgrade (командир армии ходит за войсками — ему не до этого)
    const help = !(e === this.sacu && this.area === 'land') && [...this.ownStructs.filter(s => s.built && (s.upgrading || (s.spec.produces && s.queue.length))), ...this.staffHelp(), ...(e !== this.sacu && this.sacu.alive && this.sacu.orders[0] && this.sacu.orders[0].type === 'enhance' ? [this.sacu] : [])].sort((a, b) => (b.upgrading ? 1 : 0) - (a.upgrading ? 1 : 0) || dist(a, e) - dist(b, e))[0];
    if (help && dist(help, e) < 260 && (eco.mass > 60 || eco.effM > 0.9) && !this.overBudget() && !(o && o.aiHelp && o.target === help)) {
      g.orderAssist([e], help); return mark();
    }
    // drift back to the anchor when far away and idle (the sACU of the land army trails the troops instead, see trail())
    if (!o && !(e === this.sacu && this.area === 'land') && dist(e, this.base) > 260) g.orderMove([e], this.base.x + (Math.random() - 0.5) * 40, this.base.y + (Math.random() - 0.5) * 40);
    return false;
  }

  // ---------------------------------------------------------------- factories
  factories() {
    const g = this.g;
    const facs = this.ownStructs.filter(s => s.spec.produces && s.built && !s.upgrading);
    // как у AICommander: армии достаётся лишь то, что остаётся от дохода после экономических проектов (0,2 М/с на единицу мощности завода) — остальные заводы ждут
    const isEng = (f) => f.queue[0] && UNITS[f.queue[0]].role === 'eng';
    if (this.isMil) {
      const wsum = this.staff.list.filter(l => l.isMil && !l.paused).reduce((a, l) => a + l.budget, 0) || 1, allowed = this.staff.econ().army * this.budget / wsum;
      let used = 0;
      for (const f of facs.slice().sort((a, b) => isEng(b) - isEng(a) || b.spec.tier - a.spec.tier || a.id - b.id)) {
        const d = 0.2 * f.spec.bp;
        f.invest = used > 0 && used + d * 0.5 > allowed && !isEng(f);
        if (!f.invest) used += d;
      }
    }
    for (const f of facs) {
      // дефицит энергии или нехватка массы: боевое производство встаёт (инженеров не трогаем)
      const stop = (this.ePanic || (this.isMil && f.invest)) && f.queue.length && UNITS[f.queue[0]].role !== 'eng';
      if (stop && !f.paused) { f.paused = true; this.pausedFacs.add(f.id); } else if (!stop && this.pausedFacs.delete(f.id)) f.paused = false;
      const type = f.spec.produces;
      const stage = this.area === 'eco' || (type === 'land' && (this.area === 'air' || this.area === 'naval')) ? this.base : type === 'air' ? this.airStaging : type === 'naval' ? (this.navalStaging || this.base) : this.staging;
      const memo = this.rallyMemo[f.id];
      const manualRally = f.rally && !(memo && hyp(f.rally.x - memo.x, f.rally.y - memo.y) < 2);
      if (!manualRally && stage) { f.rally = { x: stage.x, y: stage.y }; this.rallyMemo[f.id] = { x: stage.x, y: stage.y }; }
      if (f.queue.length >= (this.floating ? 4 : 2) || this.T.unitCount >= g.unitCap - 1) continue;
      const key = this.pickUnit(f);
      if (!key) continue;
      const U = UNITS[key], rate = { m: U.costM / U.bt * f.spec.bp, e: U.costE / U.bt * f.spec.bp };
      const eng = U.role === 'eng';   // инженеры — это рост, их заказ бюджетом не режем
      if (f.queue.length === 0 && !eng && !this.canSpend(rate) && !(this.isMil && !this.ePanic)) { this.blocked = true; continue; } // основное производство армии бюджетом не режем
      if (f.queue.length === 1 && !eng && !this.isMil && this.overBudget()) continue;
      if (this.T.eco.stallM && this.T.eco.mass < 20 && f.queue.length >= 1) continue;
      g.queueUnit(f, key);
      if (f.queue.length === 1) this.commit(rate);
      if (U.role === 'eng') this.say('ЭКОНОМИКА', `Нужно больше инженеров — заказал ${U.name} на «${f.spec.name}».`, 'info', f);
    }
  }
  queuedCount(pred) { return this.ownStructs.reduce((a, f) => a + (f.queue || []).filter(k => pred(UNITS[k])).length, 0); }
  cnt(pred) { return this.allUnits.filter(u => pred(u.spec)).length + this.queuedCount(pred); }
  // Нужная суммарная строительная мощность инженеров (sACU тоже считается): строить надо не меньше, чем набегает массы.
  wantBP() {
    const eco = this.T.eco, incM = eco.incM * eco.mult;
    switch (this.area) {
      case 'eco': return clamp((this.game.time < 200 ? 55 : 35) + incM * 1.2, 35, 140);
      case 'land': return clamp(12 + incM * 0.4, 12, 120);
      case 'defense': return clamp(12 + incM * 0.2, 12, 40);
    }
    // авиации и флоту сперва хватает sACU; при хорошем доходе они заводят себе наземный завод ради инженеров (строить заводы и улучшения)
    return this.game.time > 300 && incM > 40 ? clamp(incM * 0.2 - 5, 0, 40) : 0;
  }
  haveBP() { return this.allUnits.reduce((a, u) => a + (u.spec.role === 'eng' ? u.spec.bp : 0), 0) + this.queuedCount(s => s.role === 'eng') * 8; }
  pickUnit(f) {
    const type = f.spec.produces, tier = f.spec.tier, g = this.game, t = g.time, eco = this.T.eco, st = this.st;
    const avail = PRODUCES[type].filter(k => UNITS[k].tier <= tier);
    const byRole = {};
    for (const k of avail) (byRole[UNITS[k].role] = byRole[UNITS[k].role] || []).push(k);
    if (type === 'land') {
      if (this.haveBP() < this.wantBP() && (t > 20 || !this.myUnits.some(u => u.spec.role === 'eng' && u.key !== 'sacu'))) {
        const small = this.cnt(s => s.role === 'eng' && s.tier === 1);
        return tier >= 3 ? 'eng3' : tier >= 2 && small >= 2 ? 'eng2' : 'eng1';
      }
      if (this.area === 'eco' || this.area === 'air' || this.area === 'naval') return null; // these areas produce no fighting land units
    }
    if (type === 'air' && !(this.area === 'air' || this.area === 'defense')) return null;
    if (type === 'naval' && !(this.area === 'naval' || this.area === 'defense')) return null;
    if (this.area === 'defense') {
      const cap = Math.round((4 + eco.incM * eco.mult / 2) * st.def);
      if (this.allUnits.filter(u => u.spec.dps > 0).length + this.queuedCount(s => s.dps > 0) >= cap) return null;
    }
    if (type === 'air' && this.cnt(s => s.role === 'scout') < (t < 400 ? 1 : 2) && this.area === 'air') return 'scout_air';
    const enemyAir = this.intel.totalPower(s => s.move === 'air' && s.role !== 'scout');
    const ourAA = this.allUnits.reduce((a, u) => a + Math.sqrt(u.spec.dpsAir * u.hp), 0) + this.myStructs.reduce((a, s) => a + Math.sqrt(s.spec.dpsAir * s.hp), 0);
    const aaNeed = clamp(enemyAir / (ourAA + 60), 0, 2);
    const w = {};
    if (type === 'land') { w.direct = 1.0; w.arty = 0.2 + (this.style === 'cautious' ? 0.25 : 0) + (this.intel.structs.size > 12 ? 0.25 : 0); w.aa = 0.08 + aaNeed * 0.7; if (t < 240 && byRole.direct) w.direct += 0.2; }
    else if (type === 'air') { w.fighter = 0.2 + aaNeed + (this.style === 'cautious' ? 0.3 : 0); w.bomber = (t < 600 ? 0.6 : 0.4) * st.aggr; w.gunship = 0.9 * st.aggr; }
    else { w.naval = 1.0; w.sub = 0.35 + (this.intel.comp.naval > 3 ? 0.4 : 0); }
    const roles = Object.keys(w).filter(r => byRole[r]);
    if (!roles.length) return null;
    let sum = roles.reduce((a, r) => a + w[r], 0), roll = Math.random() * sum, role = roles[0];
    for (const r of roles) { roll -= w[r]; if (roll <= 0) { role = r; break; } }
    let list = byRole[role];
    if (type === 'land' && role === 'direct' && t < 200 && list.includes('lab') && Math.random() < 0.3) return 'lab';
    list = list.filter(k => k !== 'lab' || t < 300);
    if (!list.length) list = byRole[role];
    if (type === 'naval' && role === 'naval') {
      if (tier >= 3 && Math.random() < 0.5) return 'battleship';
      if (tier >= 2) return aaNeed > 0.6 && Math.random() < 0.6 ? 'cruiser' : 'destroyer';
    }
    list.sort((a, b) => UNITS[b].tier - UNITS[a].tier);
    return Math.random() < 0.8 ? list[0] : list[(Math.random() * list.length) | 0];
  }

  // ---------------------------------------------------------------- military
  stageOf(type) { return type === 'naval' ? (this.navalStaging || this.base) : type === 'air' ? this.airStaging : this.staging; }
  operates(type) { return this.area === 'defense' || this.area === type; }
  military() {
    const g = this.g;
    for (const p of this.platoons) p.units = p.units.filter(id => this.allById.has(id));
    this.platoons = this.platoons.filter(p => p.units.length || p.mission === 'reserve');
    const reserveOf = (type) => this.platoonOf(type, 'reserve') || this.newPlatoon(type, 'reserve', type === 'land' ? 'Резерв (суша)' : type === 'air' ? 'Резерв (авиаудар)' : 'Резерв (флот)');
    for (const u of this.myUnits) {
      if (u.platoon && this.platoons.some(p => p.id === u.platoon)) continue;
      const s = u.spec;
      if (s.role === 'eng' || s.role === 'cmd') continue;
      let p;
      if (s.role === 'scout') p = this.platoonOf('air', 'scout') || this.newPlatoon('air', 'scout', 'Воздушная разведка');
      else if (s.role === 'fighter') p = this.platoonOf('air', 'aircap') || this.newPlatoon('air', 'aircap', 'Истребительное прикрытие');
      else if (s.role === 'exp') p = this.newPlatoon('land', 'exp', `Экспериментал «${s.name}»`);
      else if (s.move === 'air') p = reserveOf('air');
      else if (s.move === 'naval') p = reserveOf('naval');
      else p = reserveOf('land');
      p.units.push(u.id); u.platoon = p.id;
      const stage = this.stageOf(p.type);
      if (p.mission === 'reserve' && !u.orders.length) g.orderMove([u], stage.x + (Math.random() - 0.5) * 40, stage.y + (Math.random() - 0.5) * 40);
    }
    this.defend();
    const saved = this.staging;
    for (const p of [...this.platoons]) {
      const units = this.pUnits(p);
      p.pow = this.pPower(units);
      if (!units.length && p.mission !== 'reserve') continue;
      this.staging = p.type === 'naval' && this.navalStaging ? this.navalStaging : p.type === 'air' ? this.airStaging : saved; // retreat / return points per domain
      switch (p.mission) {
        case 'reserve': this.runReserve(p, units); break;
        case 'attack': case 'raid': case 'exp': this.runAttack(p, units); this.noteAttack(p); break;
        case 'defend': this.runDefend(p, units); break;
        case 'airstrike': this.runAirStrike(p, units); break;
        case 'aircap': this.runAirCap2(p, units); break;
        case 'scout': this.runScout(p, units); break;
        case 'retreat': this.runRetreat(p, units); break;
      }
    }
    this.staging = saved;
  }
  noteAttack(p) {
    if (p.mission === 'retreat' && !p.noted) { p.noted = true; this.stats.retreats++; this.notify('retreat', 'отступаю — враг сильнее', 'alert', this.centroid(this.pUnits(p).length ? this.pUnits(p) : [this.base])); }
  }
  // Threats near the anchor: pull the reserve into a defend platoon, gunships help against ground forces.
  defend() {
    const g = this.g, t = g.time;
    const R = this.zone ? this.zone.r + 80 : 300;
    const near = (u) => dist(u, this.base) < R || this.ownStructs.some(s => hyp(s.x - u.x, s.y - u.y) < 120);
    const threats = this.intel.clusters(8, near, 90);
    this.baseThreat = threats.reduce((a, c) => a + c.pow, 0);
    if (!threats.length) return;
    const c = threats[0];
    if (t - (this.lastBaseAttackT || -999) > 30 && (this.area === 'defense' || this.area === 'land' || this.zone)) { // one alarm from the areas that answer to the base, not from every helper
      this.say('ВОЙСКА', `Тревога! Враг у ${this.zone ? 'зоны' : 'базы'}: ${c.n} ед. (сила ${Math.round(c.pow)}), направление ${this.bearing(c)}.`, 'alert', c);
      this.notify('alert', `вражеские силы (${c.n} ед.) у ${this.zone ? 'зоны' : 'базы'}`, 'alert', c);
    }
    this.lastBaseAttackT = t; this.lastAttackPos = { x: c.x, y: c.y };
    const groundThreat = c.members.some(m => m.spec.move !== 'air');
    let def = this.platoonOf('land', 'defend');
    const res = this.platoonOf('land', 'reserve');
    const staticDef = this.myStructs.reduce((a, s) => a + (dist(s, c) < 120 ? powerOf(s) : 0), 0);
    if (groundThreat && res && this.operates('land')) {
      const have = (def ? this.pPower(this.pUnits(def)) : 0) + staticDef;
      const ru = this.pUnits(res).sort((a, b) => dist(a, c) - dist(b, c));
      const pull = []; let acc = have;
      for (const u of ru) { if (acc > c.pow * 1.6 + 100) break; pull.push(u); acc += powerOf(u); }
      if (pull.length) {
        if (!def) def = this.newPlatoon('land', 'defend', 'Оборона');
        this.movePl(pull, pull, res, def);
      }
    }
    if (def) def.target = { x: c.x, y: c.y, label: 'угроза' };
    const air = this.platoonOf('air', 'reserve');
    if (air && groundThreat && this.operates('air')) {
      const gs = this.pUnits(air).filter(u => u.spec.role === 'gunship' || u.spec.role === 'bomber');
      if (gs.length && t - (air.lastOrder || -99) > 4) { g.orderAMove(gs, c.x, c.y); air.lastOrder = t; }
    }
  }
  // Fighters: hunt enemy bombers / transports / gunships first (anywhere near the anchor), then the AI air-cap logic.
  runAirCap2(p, units) {
    const g = this.g;
    if (!units.length) return;
    const R = this.zone ? this.zone.r + 250 : 650;
    const prey = this.intel.clusters(6, u => (u.spec.role === 'bomber' || u.spec.role === 'transport' || u.spec.role === 'gunship') && dist(u, this.base) < R, 90)[0];
    if (prey && p.pow > prey.pow * 0.5) {
      if (g.time - p.lastOrder > 3) { g.orderAMove(units, prey.x, prey.y); p.lastOrder = g.time; }
      p.status = `Перехватываю ${prey.n} ударных/транспортных самолётов врага`;
      if (!p.hunting) { this.say('ВОЙСКА', `Истребители идут на перехват: ${prey.n} вражеских бомбардировщиков/транспортов.`, 'info', prey); this.notify('intercept', `перехват ${prey.n} вражеских самолётов`, 'info', prey); }
      p.hunting = true; return;
    }
    p.hunting = false;
    this.runAirCap(p, units);
  }
  runDefend(p, units) { return AICommander.prototype.runDefend.call(this, p, units); }
  // Scouts fly a loop over the suspected enemy base and a few deposits (orders are tagged so they don't look like manual ones).
  runScout(p, units) {
    const g = this.g;
    if (g.time - p.lastOrder < 25) return;
    p.lastOrder = g.time;
    const m = g.terrain.mass, pts = [this.enemyStart];
    for (let i = 0; i < 3; i++) pts.push(m[(Math.random() * m.length) | 0]);
    pts.push({ x: MAP_SIZE / 2, y: MAP_SIZE / 2 });
    for (const u of units) {
      u.orders.length = 0;
      for (const q of pts) u.orders.push({ type: 'move', x: q.x, y: q.y, lt: this.id });
    }
    p.status = 'Облёт предполагаемой базы врага и месторождений';
  }
  runReserve(p, units) {
    const g = this.g, t = g.time, st = this.st;
    const stage = this.stageOf(p.type);
    p.status = `На сборе: ${units.length} ед., сила ${Math.round(p.pow)}`;
    if (!units.length || !stage) return;
    for (const u of units) if (!u.orders.length && dist(u, stage) > 60) g.orderMove([u], stage.x + (Math.random() - 0.5) * 40, stage.y + (Math.random() - 0.5) * 40);
    if (!this.attacks || !this.operates(p.type)) { p.status = `Гарнизон: ${units.length} ед.`; return; }
    const zoneFilter = this.zone && this.style !== 'aggressive' ? (r) => this.inZone(r, 100) : undefined;
    if (p.type === 'air') {
      const strikers = units.filter(u => u.spec.role === 'bomber' || u.spec.role === 'gunship');
      const need = Math.max(2, Math.round((t < 500 ? 3 : 5) / st.aggr));
      if (strikers.length < need) { p.status += ` · нужно ≥${need} ударных`; return; }
      const tgt = this.pickTarget('air', this.pPower(strikers), strikers, zoneFilter);
      if (!tgt) { p.status += ' · целей нет'; return; }
      if (tgt.risk >= this.pPower(strikers) * st.riskK) { p.status += ` · ПВО у цели «${tgt.label}» слишком сильно (${Math.round(tgt.risk)})`; return; }
      const np = this.newPlatoon('air', 'airstrike', `Авиаудар #${this.pid}`);
      this.movePl(strikers, strikers, p, np); np.target = tgt; this.stats.attacks++;
      this.say('ВОЙСКА', `Авиаудар: ${strikers.length} машин → ${tgt.label} (ценность ${Math.round(tgt.value)}, ПВО ${Math.round(tgt.risk)}).`, 'info', tgt);
      return;
    }
    if (t < st.firstAttack && p.pow < 1500) { p.status += ` · атака не раньше ${fmtT(st.firstAttack)}`; return; }
    if (p.type === 'land' && !isFinite(this.landReach)) return;
    const attackers = units.filter(u => u.spec.role !== 'aa' || Math.random() < 0.7);
    const nKeep = Math.floor(units.length * st.keep);
    const go = attackers.slice(0, attackers.length - nKeep);
    const pow = this.pPower(go);
    const minN = p.type === 'naval' ? 3 : Math.max(4, Math.round(st.minN));
    const front = this.platoons.find(q => q.type === p.type && q.mission === 'attack' && q.units.length >= 3 && q.pow > (q.startPow || 0) * 0.45);
    if (front && go.length >= 3 && go.length < minN * 2) {
      const fc = this.centroid(this.pUnits(front));
      if (dist(fc, this.staging) < 700 * KM) {
        this.movePl(go, go, p, front); g.orderAMove(go, fc.x, fc.y);
        this.say('ВОЙСКА', `Подкрепление: ${go.length} ед. → группа #${front.id} (${front.target?.label || 'фронт'}).`, 'info', fc);
        return;
      }
    }
    if (go.length < minN) { p.status += ` · нужно ≥${minN} для атаки`; return; }
    const tgt = this.pickTarget(p.type, pow, go, zoneFilter);
    if (!tgt) { p.status += this.zone ? ' · держу зону, целей нет' : ' · нет достижимых целей'; return; }
    const safety = 1.25 / st.aggr;
    if (tgt.risk * safety > pow && go.length < 35) { p.status += ` · цель «${tgt.label}» слишком сильна (${Math.round(tgt.risk)} > ${Math.round(pow / safety)})`; return; }
    const np = this.newPlatoon(p.type, 'attack', `${p.type === 'naval' ? 'Флотилия' : 'Ударная группа'} #${this.pid}`);
    this.movePl(go, go, p, np); np.target = tgt; np.startPow = pow; this.stats.attacks++;
    this.say('ВОЙСКА', `Взвод ${np.id} атакует: ${tgt.label} (${go.length} ед., сила ${Math.round(pow)}, риск ${Math.round(tgt.risk)}).`, 'info', tgt);
    this.notify('attack', `наступление — ${go.length} ед. → ${tgt.label}`, 'info', tgt);
  }

  // The sACU of the land army stays behind the main platoon (between it and our base) instead of charging to the front.
  trail() {
    const u = this.sacu, g = this.g;
    if (!u || !u.alive || !this.byId.has(u.id) || u.carried) return;
    const o = u.orders[0];
    if (o && !o.auto && !o.aiHelp && !o.rally) return; // busy with a real order (building, manual)
    if (g.time - (this.trailT || -99) < 6) return;
    const pl = this.platoons.filter(p => p.mission !== 'reserve' && p.type === 'land' && p.units.length).sort((a, b) => b.pow - a.pow)[0];
    const c = pl ? this.centroid(this.pUnits(pl)) : null;
    let x, y;
    if (c) { const dx = this.home.x - c.x, dy = this.home.y - c.y, l = hyp(dx, dy) || 1, k = Math.min(TRAIL, l * 0.5) / l; x = c.x + dx * k; y = c.y + dy * k; }
    else { x = this.staging.x + (this.home.x - this.staging.x) * 0.3; y = this.staging.y + (this.home.y - this.staging.y) * 0.3; }
    if (hyp(u.x - x, u.y - y) < 35) return;
    this.trailT = g.time;
    g.orderMove([u], x, y);
    if (u.orders[0]) u.orders[0].aiHelp = true;
  }

  // ---------------------------------------------------------------- summary for the UI
  summary() {
    const eng = this.allUnits.filter(u => u.spec.role === 'eng').length;
    const facs = this.ownStructs.filter(s => s.spec.produces).length;
    const combat = this.allUnits.filter(u => u.spec.dps > 0).length;
    return { units: this.allUnits.length, structs: this.ownStructs.length, eng, facs, combat, held: this.held };
  }

  // ---------------------------------------------------------------- save / load
  serialize() {
    const tref = (tg) => tg ? { ...tg, e: tg.e ? tg.e.id : null, spec: undefined } : null;
    this.snapshot(); // кэш allUnits/ownStructs отстаёт до 15 тиков (новорождённые юниты, заложенные объекты) — иначе загрузка расходится с живой игрой
    return {
      id: this.id, area: this.area, sacu: this.sacuId, name: this.name, style: this.style, budget: this.budget, paused: this.paused, zone: this.zone, allowFac: this.allowFac, autoUpg: this.autoUpg, pf: [...this.pausedFacs],
      logs: this.logs.slice(0, 80), pid: this.pid, stats: this.stats, rallyMemo: this.rallyMemo, lastBaseAttackT: this.lastBaseAttackT || -999,
      units: this.allUnits.map(u => u.id), structs: this.ownStructs.map(s => s.id), built: [...this.builtSeen],
      platoons: this.platoons.map(p => ({ ...p, target: tref(p.target) }))
    };
  }
  restore(d) {
    const g = this.g, ent = new Map([...g.units, ...g.structs].map(e => [e.id, e]));
    Object.assign(this, { name: d.name, style: d.style, budget: d.budget, paused: d.paused, zone: d.zone, allowFac: d.allowFac ?? true, autoUpg: d.autoUpg ?? true, pausedFacs: new Set(d.pf || []), logs: d.logs || [], pid: d.pid, stats: d.stats || this.stats, rallyMemo: d.rallyMemo || {}, lastBaseAttackT: d.lastBaseAttackT });
    this.retreatK = this.st.retreatK;
    for (const id of d.units) { const e = ent.get(id); if (e && e.team === this.team) e.lt = this.id; }
    for (const id of d.structs) { const e = ent.get(id); if (e && e.team === this.team) e.lt = this.id; }
    this.builtSeen = new Set(d.built || []);
    this.platoons = (d.platoons || []).map(p => ({ ...p, target: p.target ? { ...p.target, e: p.target.e ? ent.get(p.target.e) || null : undefined } : null }));
    for (const p of this.platoons) if (p.target && p.target.e === null) delete p.target.e;
    this.evSeen = 0;
    this.retarget(true);
    this.snapshot();
    this.say('ПРИКАЗ', 'Игра загружена: продолжаю выполнение задач.');
  }
  // Hand everything back to the player.
  dismiss() {
    for (const f of this.game.structs) if (this.pausedFacs.has(f.id)) f.paused = false;   // заводы, которые мы придержали, возвращаются в работу
    for (const e of [...this.game.units, ...this.game.structs]) if (e.lt === this.id) { e.lt = undefined; e.ltMan = null; e.platoon = null; if (e.orders) for (const o of e.orders) if (o.lt === this.id) delete o.lt; }
    this.sacu.ltHead = undefined;
    const i = this.game.controllers.indexOf(this); if (i >= 0) this.game.controllers.splice(i, 1);
  }
}

// AICommander machinery shared with the lieutenants (they use the same fields: g, team, intel, platoons, myUnits, myStructs, byId, base, dir, staging …).
for (const k of ['findPassableNear', 'findWaterNear', 'isReserved', 'findSpot', 'reserve', 'findAdjSpot', 'platoonOf', 'newPlatoon', 'pUnits', 'pPower', 'centroid',
  'movePl', 'bearing', 'pickTarget', 'nearWater', 'runAttack', 'runRetreat', 'runAirStrike', 'runAirCap', 'findFlankWaypoint', 'quickDecide']) Lieutenant.prototype[k] = AICommander.prototype[k];

// Game facade for the mixin: every order the lieutenant issues is tagged (`order.lt`), which is how manual player orders are told apart.
function makeGameProxy(lt) {
  const g = lt.game, cache = new Map();
  return new Proxy(g, {
    get(target, key) {
      const v = target[key];
      if (typeof v !== 'function') return v;
      let f = cache.get(key);
      if (f) return f;
      if (typeof key === 'string' && key.startsWith('order')) {
        f = (units, ...a) => {
          const list = Array.isArray(units) ? units : [units];
          const before = list.map(u => u.orders && u.orders[u.orders.length - 1]);
          const r = v.call(target, units, ...a);
          list.forEach((u, i) => { const o = u.orders && u.orders[u.orders.length - 1]; if (o && o !== before[i] && o.lt === undefined) o.lt = lt.id; });
          return r;
        };
      } else f = v.bind(target);
      cache.set(key, f);
      return f;
    }
  });
}

// ------------------------------------------------------------------ Staff: the player's roster of lieutenants
export class Staff {
  constructor(g, team) {
    this.g = g; this.team = team;
    this.list = []; this.nextId = 1; this.lastId = null; this.raids = []; this.evSeen = g.events.length; // raids: где недавно потеряли экстракторы
    const T = g.teams[team];
    this.intel = new Intel({ g, team, omni: false, base: { ...T.start }, say() { /* lieutenants keep their own logs */ } });
    this.intelTick = -1;
    g.controllers.push(this);
  }
  // Кто ставит оборону у дальних экстракторов: оборона базы, а без неё — наземная армия.
  get guard() { return this.list.find(l => l.area === 'defense' && !l.paused) || this.list.find(l => l.area === 'land' && !l.paused) || null; }
  update() {
    const g = this.g;
    for (; this.evSeen < g.events.length; this.evSeen++) {
      const e = g.events[this.evSeen];
      if (e.type === 'death' && e.team === this.team && e.kind === 'struct' && STRUCTS[e.key] && STRUCTS[e.key].place === 'mex') this.raids.push({ x: e.x, y: e.y, t: g.time });
    }
    if (this.raids.length && g.time - this.raids[0].t > 600) this.raids = this.raids.filter(r => g.time - r.t < 600);
    if (g.tick % 10 === 0) for (const lt of [...this.list]) if (!lt.sacu.alive) this.lost(lt);
    if (g.tick % 15 === 0 && this.list.length && g.tick !== this.intelTick) { this.intelTick = g.tick; this.intel.update(); }
  }
  // The sACU died: the lieutenant is dismissed, its units and structures go back to the player (no explosion — it is not the ACU).
  lost(lt) {
    const n = lt.summary(), s = lt.sacu;
    this.g.notify(this.team, `Командир поддержки «${lt.name}» (${lt.A.name}) потерян — помощник распущен, ${Math.max(0, n.units - 1)} ед. и ${n.structs} зд. возвращены вам`, s.x, s.y, 'alert');
    this.dismiss(lt);
  }
  // Общая картина экономики команды (по образцу AICommander.economy): запрос на строительство, потребность в энергии, бюджет улучшений экстракторов и доля армии.
  econ() {
    const g = this.g;
    if (this._ec && this._ec.tick === g.tick) return this._ec;
    const T = g.teams[this.team], eco = T.eco, t = g.time, mult = eco.mult, incM = eco.incM * mult;
    let dM = 0, dE = 0, facM = 0, upDraw = 0, nf = 0, nAir = 0;
    for (const s of g.structs) {
      if (s.team !== this.team || !s.alive || !s.built) continue;
      if (s.spec.produces) { nf++; if (s.spec.produces === 'air') nAir++; }
      if (s.upgrading) {
        const U = STRUCTS[s.upgrading.to], bp = s.spec.bp || 10, m = U.costM / U.bt * bp;
        dM += m; dE += U.costE / U.bt * bp; if (s.spec.place === 'mex') upDraw += m;
      } else if (s.spec.produces && s.queue.length && !s.paused) {
        const U = UNITS[s.queue[0]], m = U.costM / U.bt * s.spec.bp; dM += m; facM += m; dE += U.costE / U.bt * s.spec.bp;
      }
    }
    for (const u of g.units) {
      const o = u.alive && u.team === this.team && u.spec.bp && u.orders[0];
      if (o && o.type === 'build') { const B = STRUCTS[o.key]; dM += B.costM / B.bt * u.spec.bp; dE += B.costE / B.bt * u.spec.bp; }
    }
    const afford = clamp((incM + Math.max(0, eco.mass - eco.maxMass * 0.2) / 40) / Math.max(dM, 1), 0.2, 1);   // при нехватке массы и стройки идут медленнее — энергии надо меньше
    const needE = Math.max(45 + t / 6, dE * afford * 1.1 + eco.upkeep, incM * (5 + (nf ? nAir / nf : 0) * 16) + eco.upkeep) * 1.15;
    const threatened = this.list.some(l => t - (l.lastBaseAttackT || -999) < 40);
    const bank = Math.max(0, eco.mass - eco.maxMass * 0.3) / 30;
    const army = Math.max(incM * (threatened ? 0.9 : t < 600 ? 0.3 : 0.4), incM + bank - (dM - facM));   // сколько массы в секунду остаётся армии после экономических проектов
    return (this._ec = { tick: g.tick, net: eco.incE * mult - eco.upkeep - eco.spendE, dM, dE, facM, upDraw, needE, army, upBudget: Math.max(7, incM * (t < 900 ? 0.5 : 0.4)) });
  }
  // Own sACUs that no lieutenant is embodied in yet.
  freeSacu() { return this.g.units.filter(u => u.alive && u.team === this.team && u.key === 'sacu' && u.ltHead === undefined); }
  get(id) { return this.list.find(l => l.id === id) || null; }
  get last() { return this.get(this.lastId) || this.list[this.list.length - 1] || null; }
  ltOf(e) { return e && e.lt !== undefined ? this.get(e.lt) : null; }
  canCreate(area, sacu) {
    if (!AREAS[area]) return { ok: false, why: 'Неизвестная область' };
    if (sacu ? !(sacu.alive && sacu.team === this.team && sacu.key === 'sacu' && sacu.ltHead === undefined) : !this.freeSacu().length) return { ok: false, why: NO_SACU };
    if (AREAS[area].needsWater && !this.g.map.naval) return { ok: false, why: 'На этой карте нет воды' };
    if (this.list.length >= 8) return { ok: false, why: 'Не больше 8 помощников' };
    return { ok: true };
  }
  create(area, opts = {}) {
    const sacu = opts.sacu || this.freeSacu()[0];
    const c = this.canCreate(area, sacu);
    if (!c.ok) return c;
    const lt = new Lieutenant(this, this.nextId++, area, { ...opts, sacu });
    this.list.push(lt); this.lastId = lt.id;
    return { ok: true, lt };
  }
  dismiss(lt) {
    lt.dismiss();
    this.list = this.list.filter(l => l !== lt);
    if (this.lastId === lt.id) this.lastId = this.list.length ? this.list[this.list.length - 1].id : null;
  }
  // Give entities to a lieutenant. Returns counts; anything that isn't ours or can't be used is skipped.
  assign(lt, ents) {
    let units = 0, structs = 0;
    for (const e of ents) {
      if (!e || !e.alive || e.team !== this.team || e.key === 'acu' || e.key === 'sacu') continue;
      if (e.kind === 'unit' && e.carried) continue;
      const prev = this.ltOf(e);
      e.lt = lt.id; e.platoon = null; e.ltMan = null;
      if (e.kind === 'unit') { for (const o of e.orders) if (o.lt === undefined) { o.lt = lt.id; o.aiHelp = true; } units++; } else structs++;
      if (prev && prev !== lt) prev.say('ПРИКАЗ', `${e.spec.name} #${e.id} передан помощнику «${lt.name}».`);
    }
    this.lastId = lt.id;
    if (units + structs) { lt.say('ПРИКАЗ', `Получено от игрока: ${units} ед., ${structs} зданий.`); lt.snapshot(); lt.pending.units = 0; }
    return { units, structs };
  }
  release(ents) {
    let n = 0;
    for (const e of ents) if (e && e.lt !== undefined && e.key !== 'sacu') { const lt = this.ltOf(e); e.lt = undefined; e.ltMan = null; e.platoon = null; n++; if (lt) lt.say('ПРИКАЗ', `${e.spec.name} #${e.id} забран игроком.`); }
    return n;
  }
  serialize() { return { nextId: this.nextId, lastId: this.lastId, list: this.list.map(l => l.serialize()) }; }
  restore(d) {
    if (!d) return;
    for (const l of [...this.list]) this.dismiss(l);
    this.nextId = d.nextId; this.lastId = d.lastId;
    for (const s of d.list) {
      const sacu = this.g.units.find(u => u.id === s.sacu && u.alive && u.key === 'sacu');
      if (!sacu) continue;
      const lt = new Lieutenant(this, s.id, s.area, { style: s.style, budget: s.budget, name: s.name, sacu, allowFac: s.allowFac, autoUpg: s.autoUpg });
      lt.logs = []; this.list.push(lt);
      lt.restore(s);
    }
  }
}
