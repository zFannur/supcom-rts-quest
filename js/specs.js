// Unit & structure specifications (Supreme Commander-like values, tuned for 2048x2048 maps (1 unit = 2.5 m)).
// Units: speed/range in world units (≈ 0.5 ogrid), bt = build time in "build power seconds".

export const TPS = 30;
export const DT = 1 / TPS;
export const UNIT_CAP = 1000;                 // default unit limit per team (see Game.unitCap, chosen in the new-game menu)
export const UNIT_CAPS = [250, 500, 1000];   // choices offered in the new-game menu

export const TEAM_COLORS = { 1: 0x2f86e0, 2: 0xd9442e, 3: 0x3fbf5f, 4: 0xe0b02f };
export const TEAM_CSS = { 1: '#3f9bff', 2: '#ff5a3c', 3: '#4fdf6f', 4: '#ffc83c' };
// цвета игроков в лобби: [название, цвет модели, цвет HUD/миникарты]
export const PLAYER_COLORS = [['Синий', 0x2f86e0, '#3f9bff'], ['Красный', 0xd9442e, '#ff5a3c'], ['Зелёный', 0x3fbf5f, '#4fdf6f'], ['Жёлтый', 0xe0b02f, '#ffc83c'],
  ['Оранжевый', 0xe8832a, '#ff9a3c'], ['Фиолетовый', 0x9a4fd0, '#b46bff'], ['Бирюзовый', 0x2fc8c8, '#3fe6e6'], ['Белый', 0xdcdcdc, '#f2f2f2']];
/** Цвет команды id (меняется на месте: все модули читают TEAM_COLORS/TEAM_CSS при каждом обращении); вызывать до старта матча. */
export function setTeamColor(id, hex, css) {
  TEAM_COLORS[id] = hex;
  TEAM_CSS[id] = css || '#' + [16, 8, 0].map(sh => { const c = (hex >> sh) & 255; return Math.round(c + (255 - c) * 0.2).toString(16).padStart(2, '0'); }).join('');
}

const T1_BUILD = ['mex', 'pgen', 'land_fac', 'air_fac', 'naval_fac', 'pd', 'aa_turret', 'torp', 'radar', 'sonar', 'mstore', 'estore'];
const T2_BUILD = [...T1_BUILD, 'pgen2', 'mfab', 'shield', 'pd2', 'flak2', 'arty2', 'tml', 'tmd'];
export const T3_BUILD = [...T2_BUILD, 'pgen3', 'mfab3', 'sam3', 'arty3s', 'sml', 'smd'];
const EXP_BUILD = ['exp_colossus', 'exp_spider', 'exp_fortress', 'exp_czar', 'exp_seadragon'];
export const T4_BUILD = [...T3_BUILD, ...EXP_BUILD];   // вкладка «Т4»: эксперименталы строят инженеры Т3 и ACU с модулем Т3 (не sACU)
export { T1_BUILD, T2_BUILD };

const W = (o) => ({ turret: 0, speed: 80, splash: 0, minRange: 0, salvo: 1, targets: ['land', 'naval'], ...o });

export const UNITS = {
  acu: {
    name: 'ACU Командир', short: 'ACU', tier: 1, cat: 'cmd', role: 'cmd', move: 'amph', hp: 11000,
    costM: 0, costE: 0, bt: 1, speed: 5.4, turn: 3.2, radius: 3, vision: 64, bp: 10, buildRange: 30, icon: 'cmd', model: 'acu',
    weapons: [W({ name: 'Рельсотрон «Копьё»', range: 44, dmg: 100, rof: 1, proj: 'bullet', speed: 110, color: 0x8fe0ff })],
    overcharge: { cost: 3000, dmg: 3200, splash: 4, range: 44, cd: 5 },
    canBuild: T1_BUILD,
    desc: '18-метровый мех с пилотом-человеком — единственный человек на поле боя: без него ИИ-армия не имеет права стрелять. Реактор в груди, рельсотрон «Копьё», лазерный фабрикатор «Кузня» печатает базу из сырья. Сверхзаряд (O) — разряд всех конденсаторов. При гибели реактор уходит в разгон — ядерная вспышка.'
  },

  // ---------- LAND ----------
  eng1: {
    name: 'Инженер Т1', short: 'ИНЖ', tier: 1, cat: 'land', role: 'eng', move: 'amph', hp: 160,
    costM: 52, costE: 260, bt: 260, speed: 6.5, turn: 5, radius: 1.3, vision: 40, bp: 5, buildRange: 22, icon: 'eng', model: 'eng1',
    weapons: [], canBuild: T1_BUILD, desc: 'Строит сооружения, чинит, помогает заводам и собирает обломки. Амфибия: ходит по дну.'
  },
  lab: {
    name: 'Мех-пехотинец', short: 'LAB', tier: 1, cat: 'land', role: 'direct', move: 'land', hp: 210,
    costM: 36, costE: 180, bt: 180, speed: 10.5, turn: 6, radius: 1.2, vision: 42, icon: 'bot', model: 'lab',
    weapons: [W({ name: 'Пулемёт', range: 28, dmg: 9, rof: 3, proj: 'bullet', speed: 90, color: 0xffd27a })],
    desc: 'Быстрый лёгкий бот. Разведка, рейды по экстракторам.'
  },
  tank1: {
    name: 'Танк «Страйкер»', short: 'ТАНК', tier: 1, cat: 'land', role: 'direct', move: 'land', hp: 380,
    costM: 56, costE: 280, bt: 280, speed: 7.8, turn: 3.2, radius: 1.8, vision: 44, icon: 'tank', model: 'tank1',
    weapons: [W({ name: 'Пушка', range: 36, dmg: 30, rof: 1.2, proj: 'bullet', speed: 80, color: 0xffb060 })],
    desc: 'Основной танк Т1. Надёжный и дешёвый.'
  },
  arty1: {
    name: 'Артиллерия «Лобо»', short: 'АРТ', tier: 1, cat: 'land', role: 'arty', move: 'land', hp: 200,
    costM: 40, costE: 200, bt: 200, speed: 6, turn: 3, radius: 1.6, vision: 40, icon: 'arty', model: 'arty1',
    weapons: [W({ name: 'Гаубица', range: 66, minRange: 10, dmg: 90, rof: 0.33, proj: 'shell', speed: 45, splash: 4, color: 0xff9a40 })],
    desc: 'Навесной огонь по площади. Держит дистанцию (кайтит).'
  },
  aa1: {
    name: 'ПВО «Лучник»', short: 'ПВО', tier: 1, cat: 'land', role: 'aa', move: 'land', hp: 220,
    costM: 30, costE: 150, bt: 150, speed: 7.2, turn: 4, radius: 1.5, vision: 50, icon: 'aa', model: 'aa1',
    weapons: [W({ name: 'Зенитные ракеты', range: 50, dmg: 15, rof: 3, proj: 'aamissile', speed: 110, targets: ['air'], color: 0xbfe8ff })],
    desc: 'Мобильная зенитная установка. Прикрывает армию от авиации.'
  },
  eng2: {
    name: 'Инженер Т2', short: 'ИНЖ2', tier: 2, cat: 'land', role: 'eng', move: 'amph', hp: 480,
    costM: 130, costE: 650, bt: 650, speed: 6.5, turn: 5, radius: 1.6, vision: 44, bp: 12.5, buildRange: 26, icon: 'eng', model: 'eng2',
    weapons: [], canBuild: T2_BUILD, desc: 'Строит сооружения Т2: щиты, Т2 энергию, артиллерию.'
  },
  tank2: {
    name: 'Тяжёлый танк «Столп»', short: 'ТТАНК', tier: 2, cat: 'land', role: 'direct', move: 'land', hp: 1550,
    costM: 198, costE: 990, bt: 990, speed: 6.4, turn: 2.6, radius: 2.4, vision: 48, icon: 'tank', model: 'tank2',
    weapons: [W({ name: 'Спаренные пушки', range: 44, dmg: 55, rof: 1, salvo: 2, proj: 'bullet', speed: 90, color: 0xffb060 })],
    desc: 'Тяжёлый танк прорыва Т2 со спаренной башней.'
  },
  mml: {
    name: 'Ракетная установка', short: 'MML', tier: 2, cat: 'land', role: 'arty', move: 'land', hp: 520,
    costM: 200, costE: 1000, bt: 1000, speed: 6.2, turn: 3, radius: 2, vision: 46, icon: 'arty', model: 'mml',
    weapons: [W({ name: 'Тактические ракеты', range: 120, minRange: 18, dmg: 190, rof: 0.2, proj: 'missile', speed: 40, splash: 3, color: 0xffe0a0 })],
    desc: 'Мобильные самонаводящиеся ракеты — сносит оборону издалека.'
  },
  flak2: {
    name: 'Зенитка «Скай-Боксер»', short: 'ФЛАК', tier: 2, cat: 'land', role: 'aa', move: 'land', hp: 950,
    costM: 120, costE: 600, bt: 600, speed: 6.6, turn: 3.5, radius: 2, vision: 56, icon: 'aa', model: 'flak2',
    weapons: [W({ name: 'Флак', range: 58, dmg: 42, rof: 1.5, proj: 'flak', speed: 120, splash: 5, targets: ['air'], color: 0xfff0c0 })],
    desc: 'Т2 зенитная артиллерия с разрывными снарядами.'
  },
  eng3: {
    name: 'Инженер Т3', short: 'ИНЖ3', tier: 3, cat: 'land', role: 'eng', move: 'amph', hp: 1100,
    costM: 380, costE: 1900, bt: 1400, speed: 6.5, turn: 5, radius: 1.9, vision: 48, bp: 30, buildRange: 30, icon: 'eng', model: 'eng3',
    weapons: [], canBuild: T4_BUILD, desc: 'Строит Т3 электростанции и экспериментальные машины (вкладка Т4).'
  },
  sacu: {
    name: 'Командир поддержки', short: 'sACU', tier: 3, cat: 'land', role: 'eng', move: 'amph', hp: 7000,
    costM: 2400, costE: 28000, bt: 9000, speed: 4.6, turn: 3, radius: 2.6, vision: 56, bp: 30, buildRange: 30, icon: 'scmd', model: 'sacu',
    weapons: [W({ name: 'Рельсотрон «Игла»', range: 40, dmg: 60, rof: 1, proj: 'bullet', speed: 110, color: 0x8fe0ff })],
    canBuild: T3_BUILD,
    desc: 'Робот-командир без пилота: строится на заводе Т3 и ведёт делегированную область (экономика, армия, авиация, флот или оборона). Печатает здания до Т3 (без экспериментальных), сам держится позади армии. Без сверхзаряда, при гибели не взрывается — но помощник распускается, а его юниты возвращаются к вам.'
  },
  siege: {
    name: 'Осадный мех «Персиваль»', short: 'ОСАДА', tier: 3, cat: 'land', role: 'direct', move: 'land', hp: 6800,
    costM: 1100, costE: 8000, bt: 5000, speed: 5.2, turn: 2.2, radius: 3.4, vision: 60, icon: 'bot', model: 'siege',
    weapons: [W({ name: 'Тяжёлая пушка', range: 66, dmg: 520, rof: 0.3, proj: 'bullet', speed: 100, splash: 1.5, color: 0x9fdcff })],
    desc: 'Т3 штурмовой мех с орудием огромного калибра.'
  },
  arty3: {
    name: 'Тяжёлая арт. «Жнец»', short: 'Т3АРТ', tier: 3, cat: 'land', role: 'arty', move: 'land', hp: 1500,
    costM: 600, costE: 4200, bt: 3000, speed: 4.6, turn: 2, radius: 2.8, vision: 50, icon: 'arty', model: 'arty3',
    weapons: [W({ name: 'Осадное орудие', range: 150, minRange: 30, dmg: 720, rof: 0.1, proj: 'shell', speed: 55, splash: 7, color: 0xff8030 })],
    desc: 'Мобильная тяжёлая артиллерия Т3. Разрушает базы с огромной дистанции.'
  },
  aa3: {
    name: 'Т3 ЗРК «Гарпун»', short: 'Т3ПВО', tier: 3, cat: 'land', role: 'aa', move: 'land', hp: 2600,
    costM: 420, costE: 4200, bt: 2200, speed: 6, turn: 3, radius: 2.4, vision: 80, icon: 'aa', model: 'aa3',
    weapons: [W({ name: 'Зенитные ракеты', range: 82, dmg: 120, rof: 1.2, salvo: 2, proj: 'aamissile', speed: 150, targets: ['air'], color: 0xd0f0ff })],
    desc: 'Т3 мобильный зенитный комплекс: дальние ракеты сбивают ASF, стратегов и ганшипы.'
  },

  // ---------- AIR ----------
  scout_air: {
    name: 'Самолёт-разведчик', short: 'РАЗВ', tier: 1, cat: 'air', role: 'scout', move: 'air', fly: 'jet', alt: 24, hp: 70,
    costM: 25, costE: 500, bt: 150, speed: 55, turn: 2.2, radius: 1.3, vision: 110, icon: 'scout', model: 'scout_air',
    weapons: [], desc: 'Очень быстрый разведчик с огромным радиусом обзора.'
  },
  int1: {
    name: 'Перехватчик', short: 'ИСТР', tier: 1, cat: 'air', role: 'fighter', move: 'air', fly: 'jet', alt: 28, hp: 320,
    costM: 50, costE: 1500, bt: 400, speed: 42, turn: 2.4, radius: 1.6, vision: 60, icon: 'fighter', model: 'int1',
    weapons: [W({ name: 'Автопушка', range: 36, dmg: 14, rof: 4, proj: 'bullet', speed: 160, targets: ['air'], turret: -1, color: 0xfff0a0 })],
    desc: 'Истребитель завоевания господства в воздухе.'
  },
  bomb1: {
    name: 'Бомбардировщик', short: 'БОМБ', tier: 1, cat: 'air', role: 'bomber', move: 'air', fly: 'jet', alt: 24, hp: 420,
    costM: 100, costE: 2200, bt: 500, speed: 32, turn: 1.8, radius: 2, vision: 50, icon: 'bomber', model: 'bomb1',
    weapons: [W({ name: 'Бомбы', range: 8, dmg: 260, rof: 0.25, proj: 'bomb', speed: 0, splash: 5, turret: -1, color: 0xff7030 })],
    desc: 'Заходит на цель и сбрасывает бомбы. Уничтожает инженеров и экстракторы.'
  },
  gunship: {
    name: 'Ганшип', short: 'ГАНШ', tier: 2, cat: 'air', role: 'gunship', move: 'air', fly: 'hover', alt: 18, hp: 1350,
    costM: 240, costE: 2400, bt: 1200, speed: 17, turn: 2.6, radius: 2.4, vision: 56, icon: 'gunship', model: 'gunship',
    weapons: [W({ name: 'Плазменные пушки', range: 32, dmg: 22, rof: 3, proj: 'bullet', speed: 90, color: 0x9fe8ff })],
    desc: 'Штурмовой вертолёт. Зависает над целью и поливает огнём.'
  },
  asf: {
    name: 'Истребитель ASF', short: 'ASF', tier: 3, cat: 'air', role: 'fighter', move: 'air', fly: 'jet', alt: 32, hp: 2300,
    costM: 350, costE: 8000, bt: 2500, speed: 58, turn: 2.8, radius: 2.2, vision: 70, icon: 'fighter', model: 'asf',
    weapons: [W({ name: 'Ракеты В-В', range: 52, dmg: 190, rof: 1, proj: 'aamissile', speed: 150, targets: ['air'], turret: -1, color: 0xd0f0ff })],
    desc: 'Т3 истребитель превосходства в воздухе.'
  },
  strat: {
    name: 'Стратег. бомбардировщик', short: 'СТРАТ', tier: 3, cat: 'air', role: 'bomber', move: 'air', fly: 'jet', alt: 34, hp: 2700,
    costM: 420, costE: 12000, bt: 3500, speed: 44, turn: 1.6, radius: 3.4, vision: 60, icon: 'bomber', model: 'strat',
    weapons: [W({ name: 'Тяжёлая бомба', range: 10, dmg: 2900, rof: 0.15, proj: 'bomb', speed: 0, splash: 8, turret: -1, color: 0xff6020 })],
    desc: 'Т3 стратегический бомбардировщик. Одна бомба — одна база.'
  },
  kami: {
    name: 'Дрон-камикадзе «Оса»', short: 'ДРОН', tier: 1, cat: 'air', role: 'gunship', kami: true, move: 'air', fly: 'hover', alt: 9, hp: 90,
    costM: 20, costE: 400, bt: 100, speed: 36, turn: 4, radius: 0.9, vision: 46, icon: 'scout', model: 'kami',
    weapons: [W({ name: 'Боевая часть', range: 4, dmg: 300, rof: 1, proj: 'kami', splash: 4, turret: -1, color: 0xff7030 })],
    desc: 'Дешёвый ударный дрон: летит к наземной цели и взрывается (урон по площади), сам гибнет. Берите роем.'
  },
  trans1: {
    name: 'Транспорт «Пеликан»', short: 'ТРАНС', tier: 1, cat: 'air', role: 'transport', move: 'air', fly: 'hover', alt: 16, hp: 700,
    costM: 120, costE: 2400, bt: 600, speed: 22, turn: 2.4, radius: 2.6, vision: 40, cargo: 6, icon: 'transport', model: 'trans1',
    weapons: [], desc: 'Перевозит до 6 мест наземных юнитов (Т1 — 1 место, Т2 — 2, Т3 — 4). ПКМ своими юнитами по транспорту — посадка, T — высадка.'
  },
  trans2: {
    name: 'Тяж. транспорт «Континенталь»', short: 'ТРАНС2', tier: 2, cat: 'air', role: 'transport', move: 'air', fly: 'hover', alt: 18, hp: 2600,
    costM: 380, costE: 7500, bt: 1500, speed: 20, turn: 2, radius: 3.6, vision: 46, cargo: 16, icon: 'transport', model: 'trans2',
    weapons: [W({ name: 'Зенитки', range: 34, dmg: 12, rof: 3, proj: 'aamissile', speed: 110, targets: ['air'], turret: -1, color: 0xbfe8ff })],
    desc: 'Бронированный транспорт на 16 мест (может нести командира) с лёгкой ПВО.'
  },

  // ---------- NAVAL ----------
  frigate: {
    name: 'Фрегат «Громовержец»', short: 'ФРЕГ', tier: 1, cat: 'naval', role: 'naval', move: 'naval', hp: 1850,
    costM: 260, costE: 1300, bt: 1300, speed: 8.4, turn: 1.6, radius: 3, vision: 64, radar: 120, icon: 'frigate', model: 'frigate',
    weapons: [
      W({ name: 'Палубное орудие', range: 60, dmg: 60, rof: 0.8, proj: 'bullet', speed: 80, color: 0xffb060 }),
      W({ name: 'Зенитка', range: 44, dmg: 10, rof: 2, proj: 'aamissile', speed: 110, targets: ['air'], turret: -1, color: 0xbfe8ff })
    ],
    desc: 'Многоцелевой корабль с орудием и лёгкой ПВО.'
  },
  sub: {
    name: 'Подлодка «Тигровая акула»', short: 'ПЛ', tier: 1, cat: 'naval', role: 'sub', move: 'naval', sub: true, hp: 1250,
    costM: 200, costE: 1600, bt: 1200, speed: 8.6, turn: 1.8, radius: 2.4, vision: 44, icon: 'sub', model: 'sub',
    weapons: [W({ name: 'Торпеды', range: 46, dmg: 180, rof: 0.3, proj: 'torpedo', speed: 26, targets: ['naval', 'sub'], turret: -1, color: 0x70f0ff })],
    desc: 'Скрытная подлодка. Поражается только торпедами.'
  },
  destroyer: {
    name: 'Эсминец «Отважный»', short: 'ЭСМ', tier: 2, cat: 'naval', role: 'naval', move: 'naval', hp: 6200,
    costM: 900, costE: 6000, bt: 3000, speed: 7.4, turn: 1.3, radius: 4.4, vision: 72, radar: 150, icon: 'destroyer', model: 'destroyer',
    weapons: [
      W({ name: 'Главный калибр', range: 76, dmg: 140, rof: 0.6, salvo: 2, proj: 'bullet', speed: 90, color: 0xffb060 }),
      W({ name: 'Торпеды', range: 50, dmg: 130, rof: 0.3, proj: 'torpedo', speed: 26, targets: ['naval', 'sub'], turret: -1, color: 0x70f0ff })
    ],
    desc: 'Т2 эсминец: орудия и торпеды против подлодок.'
  },
  cruiser: {
    name: 'Крейсер «Губернатор»', short: 'КРЕЙС', tier: 2, cat: 'naval', role: 'naval', move: 'naval', hp: 3300,
    costM: 800, costE: 5000, bt: 2600, speed: 7.8, turn: 1.4, radius: 4, vision: 70, radar: 180, icon: 'cruiser', model: 'cruiser',
    weapons: [
      W({ name: 'ЗУР', range: 100, dmg: 50, rof: 2, proj: 'aamissile', speed: 130, targets: ['air'], turret: -1, color: 0xd0f0ff }),
      W({ name: 'Крылатые ракеты', range: 150, minRange: 20, dmg: 260, rof: 0.2, proj: 'missile', speed: 42, splash: 3, turret: -1, color: 0xffe0a0 })
    ],
    desc: 'Т2 крейсер ПВО и ракетного удара по побережью.'
  },
  battleship: {
    name: 'Линкор «Саммит»', short: 'ЛИНК', tier: 3, cat: 'naval', role: 'naval', move: 'naval', hp: 24000,
    costM: 3000, costE: 30000, bt: 12000, speed: 5.6, turn: 0.8, radius: 8, vision: 90, radar: 200, icon: 'battleship', model: 'battleship',
    weapons: [0, 1, 2].map(i => W({ name: 'Башня ГК ' + (i + 1), range: 165, minRange: 30, dmg: 700, rof: 0.2, proj: 'shell', speed: 70, splash: 6, turret: i, color: 0xff9a40 })),
    desc: 'Т3 линкор. Три башни главного калибра разрушают побережье.'
  },

  // ---------- EXPERIMENTAL ----------
  x_colossus: {
    name: 'Экспериментал «Колосс»', short: 'ЭКСП', tier: 4, cat: 'land', role: 'exp', move: 'amph', hp: 60000,
    costM: 6000, costE: 80000, bt: 20000, speed: 4.2, turn: 1, radius: 9, vision: 90, icon: 'exp', model: 'colossus',
    weapons: [
      W({ name: 'Глазной лазер', range: 72, dmg: 650, rof: 0.6, proj: 'laser', color: 0x7fe7ff }),
      W({ name: 'Наплечные пушки', range: 54, dmg: 90, rof: 2, salvo: 2, proj: 'bullet', speed: 100, turret: 1, color: 0x9fe8ff }),
      W({ name: 'ПВО-лазер', range: 60, dmg: 70, rof: 1.5, proj: 'laser', targets: ['air'], turret: -1, color: 0x9fffd0 })
    ],
    desc: 'Гигантский шагающий робот. Ходит по дну моря. Конец игры для любой базы.'
  },
  x_spider: {
    name: 'Экспериментал «Монарх»', short: 'ПАУК', tier: 4, cat: 'land', role: 'exp', move: 'amph', hp: 42000,
    costM: 5000, costE: 60000, bt: 16000, speed: 6.2, turn: 1.6, radius: 7, vision: 80, icon: 'exp', model: 'spider',
    weapons: [
      W({ name: 'Тепловой луч', range: 60, dmg: 380, rof: 1.5, proj: 'laser', color: 0xff5a3c }),
      W({ name: 'Лазеры ближнего боя', range: 40, dmg: 60, rof: 3, salvo: 2, proj: 'laser', turret: -1, color: 0xff9a60 }),
      W({ name: 'Торпедный аппарат', range: 46, dmg: 150, rof: 0.4, proj: 'torpedo', speed: 26, targets: ['naval', 'sub'], turret: -1, color: 0x70f0ff })
    ],
    desc: 'Быстрый шестиногий паук с тепловым лучом. Ходит по дну, выжигает армии.'
  },
  x_fortress: {
    name: 'Экспериментал «Бастион»', short: 'КРЕП', tier: 4, cat: 'land', role: 'exp', move: 'land', hp: 52000,
    costM: 5800, costE: 90000, bt: 18000, speed: 3.6, turn: 0.9, radius: 9, vision: 90, pshield: { hp: 16000, regen: 120, r: 16 }, icon: 'exp', model: 'fortress',
    weapons: [0, 1, 2, 3].map(i => W({ name: 'Орудийная башня ' + (i + 1), range: 90, dmg: 260, rof: 0.5, salvo: 2, proj: 'shell', speed: 70, splash: 4, turret: i, color: 0xffb060 })).concat([
      W({ name: 'Зенитный комплекс', range: 60, dmg: 40, rof: 3, proj: 'aamissile', speed: 130, targets: ['air'], turret: -1, color: 0xbfe8ff })
    ]),
    desc: 'Гусеничная крепость: четыре орудийные башни, ПВО и собственный щит-купол.'
  },
  x_czar: {
    name: 'Экспериментал «Царь»', short: 'ЦАРЬ', tier: 4, cat: 'air', role: 'exp', move: 'air', fly: 'hover', quad: true, alt: 34, hp: 38000,
    costM: 6500, costE: 150000, bt: 20000, speed: 9, turn: 0.8, radius: 12, vision: 90, cargo: 24, icon: 'exp', model: 'czar',
    weapons: [
      W({ name: 'Подбородочный пулемёт', range: 55, dmg: 25, rof: 4, salvo: 2, proj: 'bullet', speed: 110, color: 0xffd27a }),
      W({ name: 'Кормовой пулемёт', range: 55, dmg: 25, rof: 4, salvo: 2, proj: 'bullet', speed: 110, turret: 1, color: 0xffd27a }),
      W({ name: 'Блоки НУРС', range: 70, dmg: 110, rof: 0.5, salvo: 6, proj: 'missile', speed: 70, splash: 3, turret: 2, color: 0xffe0a0 }),
      W({ name: 'Ракеты В-В', range: 60, dmg: 70, rof: 2, proj: 'aamissile', speed: 150, targets: ['air'], turret: -1, color: 0xd0f0ff })
    ],
    desc: 'Штурмовой конвертоплан: бронированный фюзеляж на четырёх винтах, блоки НУРС под крыльями, два спаренных пулемёта и кормовая рампа — перевозит до 24 мест наземных юнитов, включая командира и Т3. Уязвим для ПВО.'
  },
  x_seadragon: {
    name: 'Экспериментал «Морской дракон»', short: 'ДРАКОН', tier: 4, cat: 'naval', role: 'exp', move: 'naval', hp: 45000,
    costM: 6000, costE: 100000, bt: 18000, speed: 5, turn: 0.7, radius: 11, vision: 90, radar: 200, cargo: 30, icon: 'exp', model: 'seadragon',
    weapons: [0, 1, 2].map(i => W({ name: 'РСЗО «Ливень-М» ' + (i + 1), range: 140, minRange: 25, dmg: 90, rof: 0.15, salvo: 10, proj: 'missile', speed: 42, splash: 4, turret: i, color: 0xffe0a0 })).concat([
      W({ name: 'ЗРК', range: 90, dmg: 50, rof: 2, salvo: 2, proj: 'aamissile', speed: 130, targets: ['air'], turret: -1, color: 0xd0f0ff })
    ]),
    desc: 'Морской транспорт-экраноплан: три башни РСЗО бьют по побережью, ПВО, в трюме 30 мест десанта. ПКМ своими наземными юнитами по кораблю — посадка (подойти к берегу), T — высадка на ближайший берег.'
  }
};

// ---------- ENHANCEMENTS of the ACU and the sACU (unit; slots: rarm / larm / back, one per slot) ----------
export const ENH = {
  gun: { unit: 'acu', short: 'ПУШКА', name: 'Удлинённые рельсы «Копьё-М»', slot: 'rarm', costM: 250, costE: 2500, bt: 450, desc: 'Дальность 44 → 60, урон ×1.8.' },
  eng2: { unit: 'acu', short: 'ИНЖ Т2', name: 'Печатающая головка Т2', slot: 'larm', costM: 300, costE: 3000, bt: 550, desc: 'Строит здания Т2. Скорость стройки 10 → 25.' },
  eng3: { unit: 'acu', short: 'ИНЖ Т3', name: 'Печатающая головка Т3', slot: 'larm', req: 'eng2', costM: 1200, costE: 15000, bt: 1500, desc: 'Строит Т3 и эксперименталы. Скорость стройки → 60.' },
  shield: { unit: 'acu', short: 'ЩИТ', name: 'Персональный купол активной защиты', slot: 'back', costM: 400, costE: 5000, bt: 700, desc: 'Щит 5000 ед., восстанавливается 50/с.' },
  regen: { unit: 'acu', short: 'БРОНЯ', name: 'Самовосстанавливающаяся броня', slot: 'back', costM: 300, costE: 3000, bt: 450, desc: '+6000 к прочности и регенерация 30 HP/с.' },
  res: { unit: 'acu', short: 'РЕСУРСЫ', name: 'Встроенный дезинтегратор', slot: 'back', costM: 500, costE: 6000, bt: 800, desc: '+10 массы и +300 энергии в секунду.' },
  s_gun: { unit: 'sacu', short: 'ПЛАЗМА', name: 'Тяжёлая плазма «Игла-М»', slot: 'rarm', costM: 300, costE: 3500, bt: 600, desc: 'Дальность 40 → 56, урон 60 → 150.' },
  s_eng: { unit: 'sacu', short: 'ФОКУС', name: 'Инженерный фокус', slot: 'rarm', costM: 400, costE: 4000, bt: 700, desc: 'Скорость стройки 30 → 80.' },
  s_radar: { unit: 'sacu', short: 'СЕНСОР', name: 'Сенсорный комплекс', slot: 'larm', costM: 150, costE: 2000, bt: 400, desc: 'Обзор 56 → 80, радар 300.' },
  s_res: { unit: 'sacu', short: 'РЕСУРСЫ', name: 'Генератор ресурсов', slot: 'larm', costM: 600, costE: 7000, bt: 900, desc: '+6 массы и +300 энергии в секунду.' },
  s_shield: { unit: 'sacu', short: 'ЩИТ', name: 'Персональный щит', slot: 'back', costM: 450, costE: 5500, bt: 800, desc: 'Щит 4000 ед., восстанавливается 40/с.' },
  s_regen: { unit: 'sacu', short: 'БРОНЯ', name: 'Наноброня', slot: 'back', costM: 350, costE: 3500, bt: 500, desc: '+4000 к прочности и регенерация 25 HP/с.' }
};
export const ENH_SLOTS = { rarm: 'Правая рука', larm: 'Левая рука', back: 'Спина' };

// ---------- STRUCTURES ----------
export const STRUCTS = {
  mex: { name: 'Экстрактор массы', short: 'MEX', tier: 1, hp: 600, costM: 36, costE: 360, bt: 60, size: 6, mass: 2, eUse: 2, place: 'mex', upgradesTo: 'mex2', icon: 'mex', model: 'mex', desc: 'Добывает массу на месторождении. +2 М/с.' },
  mex2: { name: 'Экстрактор Т2', short: 'MEX2', tier: 2, hp: 1600, costM: 540, costE: 3240, bt: 800, size: 6, mass: 6, eUse: 9, place: 'mex', upgradesTo: 'mex3', upgradeOnly: true, icon: 'mex', model: 'mex2', desc: '+6 М/с.' },
  mex3: { name: 'Экстрактор Т3', short: 'MEX3', tier: 3, hp: 4000, costM: 2400, costE: 16000, bt: 2400, size: 6, mass: 18, eUse: 27, place: 'mex', upgradeOnly: true, icon: 'mex', model: 'mex3', desc: '+18 М/с.' },
  pgen: { name: 'Электростанция Т1', short: 'PGEN', tier: 1, hp: 600, costM: 75, costE: 750, bt: 125, size: 8, energy: 20, place: 'land', icon: 'pgen', model: 'pgen', desc: '+20 Э/с.' },
  pgen2: { name: 'Электростанция Т2', short: 'PGEN2', tier: 2, hp: 2200, costM: 1200, costE: 12000, bt: 1400, size: 14, energy: 500, place: 'land', icon: 'pgen', model: 'pgen2', desc: '+500 Э/с. При гибели мощно взрывается.' },
  pgen3: { name: 'Электростанция Т3', short: 'PGEN3', tier: 3, hp: 5000, costM: 3240, costE: 57600, bt: 3000, size: 20, energy: 2500, place: 'land', icon: 'pgen', model: 'pgen3', desc: '+2500 Э/с.' },
  mstore: { name: 'Хранилище массы', short: 'MSTO', tier: 1, hp: 1200, costM: 200, costE: 1500, bt: 250, size: 6, storeM: 500, place: 'land', icon: 'store', model: 'mstore', desc: '+500 к запасу массы.' },
  estore: { name: 'Хранилище энергии', short: 'ESTO', tier: 1, hp: 1200, costM: 250, costE: 1200, bt: 250, size: 6, storeE: 5000, place: 'land', icon: 'store', model: 'estore', desc: '+5000 к запасу энергии.' },

  land_fac: { name: 'Завод бронетехники Т1', short: 'ЗАВОД', tier: 1, hp: 4000, costM: 240, costE: 2100, bt: 300, size: 22, bp: 20, produces: 'land', place: 'land', upgradesTo: 'land_fac2', icon: 'fac_land', model: 'land_fac', desc: 'Производит наземные войска и инженеров.' },
  land_fac2: { name: 'Завод бронетехники Т2', short: 'ЗАВОД2', tier: 2, hp: 6000, costM: 520, costE: 3500, bt: 1500, size: 22, bp: 40, produces: 'land', place: 'land', upgradesTo: 'land_fac3', upgradeOnly: true, icon: 'fac_land', model: 'land_fac2', desc: 'Открывает технику Т2.' },
  land_fac3: { name: 'Завод бронетехники Т3', short: 'ЗАВОД3', tier: 3, hp: 9000, costM: 1400, costE: 10000, bt: 4000, size: 22, bp: 80, produces: 'land', place: 'land', upgradeOnly: true, icon: 'fac_land', model: 'land_fac3', desc: 'Открывает технику Т3.' },
  air_fac: { name: 'Авиазавод Т1', short: 'АВИА', tier: 1, hp: 3600, costM: 210, costE: 2400, bt: 300, size: 22, bp: 20, produces: 'air', place: 'land', upgradesTo: 'air_fac2', icon: 'fac_air', model: 'air_fac', desc: 'Производит авиацию.' },
  air_fac2: { name: 'Авиазавод Т2', short: 'АВИА2', tier: 2, hp: 5500, costM: 520, costE: 4000, bt: 1500, size: 22, bp: 40, produces: 'air', place: 'land', upgradesTo: 'air_fac3', upgradeOnly: true, icon: 'fac_air', model: 'air_fac2', desc: 'Открывает авиацию Т2.' },
  air_fac3: { name: 'Авиазавод Т3', short: 'АВИА3', tier: 3, hp: 8000, costM: 1400, costE: 12000, bt: 4000, size: 22, bp: 80, produces: 'air', place: 'land', upgradeOnly: true, icon: 'fac_air', model: 'air_fac3', desc: 'Открывает авиацию Т3.' },
  naval_fac: { name: 'Верфь Т1', short: 'ВЕРФЬ', tier: 1, hp: 4500, costM: 300, costE: 1500, bt: 400, size: 28, bp: 20, produces: 'naval', place: 'water', upgradesTo: 'naval_fac2', icon: 'fac_naval', model: 'naval_fac', desc: 'Строит флот. Ставится на воду.' },
  naval_fac2: { name: 'Верфь Т2', short: 'ВЕРФЬ2', tier: 2, hp: 7000, costM: 700, costE: 4500, bt: 1800, size: 28, bp: 40, produces: 'naval', place: 'water', upgradesTo: 'naval_fac3', upgradeOnly: true, icon: 'fac_naval', model: 'naval_fac2', desc: 'Открывает флот Т2.' },
  naval_fac3: { name: 'Верфь Т3', short: 'ВЕРФЬ3', tier: 3, hp: 10000, costM: 1800, costE: 13000, bt: 4500, size: 28, bp: 80, produces: 'naval', place: 'water', upgradeOnly: true, icon: 'fac_naval', model: 'naval_fac3', desc: 'Открывает линкоры.' },

  pd: { name: 'Огневая точка Т1', short: 'PD', tier: 1, hp: 1500, costM: 180, costE: 1400, bt: 300, size: 6, place: 'land', icon: 'pd', model: 'pd',
    weapons: [W({ name: 'Пушка', range: 52, dmg: 34, rof: 1.5, proj: 'bullet', speed: 90, color: 0xffb060 })], desc: 'Оборонительная турель против наземных целей.' },
  aa_turret: { name: 'Зенитная турель Т1', short: 'AA', tier: 1, hp: 800, costM: 90, costE: 900, bt: 200, size: 6, place: 'land', icon: 'aa_s', model: 'aa_turret',
    weapons: [W({ name: 'ЗУР', range: 62, dmg: 17, rof: 3, proj: 'aamissile', speed: 120, targets: ['air'], color: 0xbfe8ff })], desc: 'Стационарная ПВО.' },
  torp: { name: 'Торпедная установка', short: 'TORP', tier: 1, hp: 1300, costM: 150, costE: 1200, bt: 300, size: 6, place: 'water', icon: 'torp', model: 'torp',
    weapons: [W({ name: 'Торпеды', range: 62, dmg: 150, rof: 0.3, proj: 'torpedo', speed: 26, targets: ['naval', 'sub'], color: 0x70f0ff })], desc: 'Защита побережья от кораблей и подлодок.' },
  radar: { name: 'Радар', short: 'RADAR', tier: 1, hp: 220, costM: 60, costE: 600, bt: 120, size: 6, radar: 220, eUse: 20, place: 'land', upgradesTo: 'radar2', icon: 'radar', model: 'radar', desc: 'Показывает вражеские юниты на большом расстоянии.' },
  radar2: { name: 'Радар Т2', short: 'RADAR2', tier: 2, hp: 900, costM: 220, costE: 3600, bt: 500, size: 6, radar: 400, vision: 60, eUse: 100, place: 'land', upgradesTo: 'radar3', upgradeOnly: true, icon: 'radar', model: 'radar2', desc: 'Радиус радара 400.' },
  radar3: { name: 'Омни-сенсор Т3', short: 'OMNI', tier: 3, hp: 2400, costM: 900, costE: 18000, bt: 1500, size: 6, radar: 650, sonar: 300, vision: 90, eUse: 400, place: 'land', upgradeOnly: true, icon: 'radar', model: 'radar3', desc: 'Радар 650 и сонар 300 — видит подлодки.' },
  sonar: { name: 'Сонар', short: 'SONAR', tier: 1, hp: 300, costM: 80, costE: 800, bt: 150, size: 6, sonar: 220, radar: 120, eUse: 20, place: 'water', icon: 'radar', model: 'sonar', desc: 'Обнаруживает подлодки и подводные юниты в радиусе 220.' },
  mfab: { name: 'Масс-фабрикатор Т2', short: 'MFAB', tier: 2, hp: 800, costM: 200, costE: 4000, bt: 450, size: 6, fabM: 1.5, fabE: 150, place: 'land', icon: 'mfab', model: 'mfab', desc: 'Превращает энергию в массу: −150 Э/с → +1.5 М/с. Сам отключается при нехватке энергии.' },
  mfab3: { name: 'Масс-фабрикатор Т3', short: 'MFAB3', tier: 3, hp: 5000, costM: 3000, costE: 65000, bt: 3000, size: 12, fabM: 14, fabE: 1400, place: 'land', icon: 'mfab', model: 'mfab3', desc: '−1400 Э/с → +14 М/с. При гибели взрывается.' },
  pd2: { name: 'Огневая точка Т2', short: 'PD2', tier: 2, hp: 4200, costM: 600, costE: 4200, bt: 1000, size: 8, place: 'land', icon: 'pd', model: 'pd2',
    weapons: [W({ name: 'Спаренная пушка', range: 66, dmg: 170, rof: 0.8, salvo: 2, proj: 'bullet', speed: 100, color: 0xffb060 })], desc: 'Тяжёлая оборонительная турель.' },
  flak2: { name: 'Зенитная пушка Т2', short: 'FLAK', tier: 2, hp: 2600, costM: 350, costE: 2800, bt: 700, size: 8, place: 'land', icon: 'aa_s', model: 'flak2s',
    weapons: [W({ name: 'Флак', range: 74, dmg: 46, rof: 1.5, proj: 'flak', speed: 130, splash: 6, targets: ['air'], color: 0xfff0c0 })], desc: 'Разрывная зенитная артиллерия.' },
  shield: { name: 'Генератор щита', short: 'ЩИТ', tier: 2, hp: 900, costM: 400, costE: 5000, bt: 900, size: 8, eUse: 80, place: 'land', icon: 'shield', model: 'shield',
    shield: { radius: 36, hp: 6000, regen: 70 }, upgradesTo: 'shield2', desc: 'Купол, поглощающий снаряды. Потребляет энергию. Улучшается (U) в три ступени.' },
  shield2: { name: 'Щит «Бастион-2»', short: 'ЩИТ2', tier: 2, hp: 1600, costM: 600, costE: 7000, bt: 1000, size: 8, eUse: 140, place: 'land', icon: 'shield', model: 'shield2',
    shield: { radius: 46, hp: 10000, regen: 110 }, upgradesTo: 'shield3', upgradeOnly: true, desc: 'Радиус 46, запас 10 000, восстановление 110/с.' },
  shield3: { name: 'Щит «Бастион-3»', short: 'ЩИТ3', tier: 3, hp: 2600, costM: 1200, costE: 15000, bt: 1800, size: 8, eUse: 240, place: 'land', icon: 'shield', model: 'shield3',
    shield: { radius: 58, hp: 16000, regen: 170 }, upgradesTo: 'shield4', upgradeOnly: true, desc: 'Радиус 58, запас 16 000, восстановление 170/с.' },
  shield4: { name: 'Щит «Эгида»', short: 'ЭГИДА', tier: 3, hp: 4000, costM: 2400, costE: 30000, bt: 3000, size: 8, eUse: 380, place: 'land', icon: 'shield', model: 'shield4',
    shield: { radius: 72, hp: 26000, regen: 260 }, upgradeOnly: true, desc: 'Высшая ступень: радиус 72, запас 26 000, восстановление 260/с.' },
  arty2: { name: 'Артиллерия Т2', short: 'АРТ2', tier: 2, hp: 3200, costM: 1300, costE: 12000, bt: 2500, size: 10, place: 'land', icon: 'arty_s', model: 'arty2',
    weapons: [W({ name: 'Гаубица', range: 300, minRange: 40, dmg: 900, rof: 0.1, proj: 'shell', speed: 70, splash: 7, color: 0xff8030 })], desc: 'Стационарная дальнобойная артиллерия.' },
  arty3s: { name: 'Тяжёлая артиллерия Т3 «Гром»', short: 'АРТ3', tier: 3, hp: 8000, costM: 4500, costE: 60000, bt: 6000, size: 14, place: 'land', icon: 'arty_s', model: 'arty3s',
    weapons: [W({ name: 'Сверхдальнее орудие', range: 650, minRange: 60, dmg: 1800, rof: 0.07, proj: 'shell', speed: 95, splash: 9, color: 0xff6020 })], desc: 'Стационарное орудие Т3: накрывает базы на 650 (1,6 км). Нужен радар или разведка.' },
  sam3: { name: 'ЗРК Т3 «Купол»', short: 'SAM', tier: 3, hp: 5000, costM: 800, costE: 8000, bt: 1600, size: 8, place: 'land', icon: 'aa_s', model: 'sam3',
    weapons: [W({ name: 'ЗУР большой дальности', range: 110, dmg: 150, rof: 1.5, salvo: 2, proj: 'aamissile', speed: 160, targets: ['air'], color: 0xd0f0ff })], desc: 'Т3 зенитный ракетный комплекс: дальность 110, сбивает ASF и стратегов.' },
  // ---------- MISSILE SILOS: build their own missiles (stock counter), see Game.updateSilo ----------
  // silo.kind: 'nuke' (strategic, manual launch at any range), 'anti' (SMD interceptors), 'tac' (TML, uses weapons[0] on the stock)
  tml: { name: 'Тактическая ракетная установка', short: 'TML', tier: 2, hp: 2400, costM: 800, costE: 8000, bt: 1400, size: 8, bp: 15, place: 'land', icon: 'tml', model: 'tml',
    silo: { kind: 'tac', max: 4, costM: 120, costE: 1500, bt: 300 },
    weapons: [W({ name: 'Тактическая ракета', range: 256, minRange: 24, dmg: 2800, rof: 0.25, proj: 'missile', speed: 44, splash: 6, full: true, mhp: 110, silo: true, slowOnly: true, minValue: 150, color: 0xffd090 })],
    desc: 'Сама строит крылатые ракеты (до 4) и бьёт по зданиям и медленным целям в радиусе 256; ЛКМ «Пуск» — по точке или цели. Ракеты можно сбить противоракетной защитой.' },
  tmd: { name: 'Противоракетная защита', short: 'TMD', tier: 2, hp: 1800, costM: 320, costE: 3600, bt: 600, size: 6, place: 'land', icon: 'tmd', model: 'tmd', vision: 60,
    weapons: [W({ name: 'Противоракетная пушка', range: 46, dmg: 55, rof: 2.5, proj: 'laser', targets: ['missile'], turret: 0, color: 0x9fffe0 })],
    desc: 'Сбивает тактические ракеты (TML, MML, крейсеры) в радиусе 46. Ядерные не берёт — для них нужна SMD.' },
  sml: { name: 'Стратегическая ракетная шахта', short: 'ЯДЕРКА', tier: 3, hp: 9000, costM: 3600, costE: 54000, bt: 4000, size: 14, bp: 30, place: 'land', icon: 'nuke', model: 'sml',
    silo: { kind: 'nuke', max: 3, costM: 3200, costE: 64000, bt: 6000, zones: [100, 200, 300], zoneNames: ['Полное уничтожение', 'Тяжёлый урон', 'Слабый урон'], heavyT3: 0.75, heavyExp: 0.35, light: 1500 },
    desc: 'Строит ядерные ракеты (до 3). Пуск вручную (N) по любой точке карты. До 250 м от эпицентра гибнет всё, включая эксперименталы и ACU; 250 – 500 м: Т1/Т2 уничтожены, Т3 теряют 75% прочности, эксперименталы — 35%; 500 – 750 м: слабый урон (до 1500). Поражает и своих. Противник получает предупреждение; сбивается только SMD.' },
  smd: { name: 'Антиядерная защита', short: 'SMD', tier: 3, hp: 6500, costM: 2400, costE: 30000, bt: 3000, size: 12, bp: 20, place: 'land', icon: 'antinuke', model: 'smd',
    silo: { kind: 'anti', max: 2, costM: 500, costE: 9000, bt: 1800, cover: 300 },
    desc: 'Строит антиракеты (до 2) и автоматически перехватывает ядерные ракеты, падающие в радиусе 300 (750 м).' },
  exp_colossus: { name: 'Колосс (сборка)', short: 'КОЛОСС', tier: 4, hp: 60000, costM: 6000, costE: 80000, bt: 20000, size: 22, place: 'land', icon: 'exp', model: 'xframe', spawnsUnit: 'x_colossus', desc: 'Шагающий робот с глазным лазером. Ходит по дну моря. Строится инженерами.' },
  exp_spider: { name: 'Монарх (сборка)', short: 'МОНАРХ', tier: 4, hp: 42000, costM: 5000, costE: 60000, bt: 16000, size: 20, place: 'land', icon: 'exp', model: 'xframe', spawnsUnit: 'x_spider', desc: 'Быстрый паук с тепловым лучом, амфибия.' },
  exp_fortress: { name: 'Бастион (сборка)', short: 'БАСТИОН', tier: 4, hp: 52000, costM: 5800, costE: 90000, bt: 18000, size: 22, place: 'land', icon: 'exp', model: 'xframe', spawnsUnit: 'x_fortress', desc: 'Гусеничная крепость с 4 башнями и щитом.' },
  exp_czar: { name: 'Царь (сборка)', short: 'ЦАРЬ', tier: 4, hp: 38000, costM: 6500, costE: 150000, bt: 20000, size: 22, place: 'land', icon: 'exp', model: 'xframe', spawnsUnit: 'x_czar', desc: 'Штурмовой конвертоплан с НУРС, пулемётами и десантным отсеком на 24 места.' },
  exp_seadragon: { name: 'Морской дракон (сборка)', short: 'ДРАКОН', tier: 4, hp: 45000, costM: 6000, costE: 100000, bt: 18000, size: 22, place: 'water', icon: 'exp', model: 'xframe', spawnsUnit: 'x_seadragon', desc: 'Морской транспорт с РСЗО. Строится на воде у берега.' }
};

export const ALL_SPECS = { ...UNITS, ...STRUCTS };

export const UNIT_M = 2.5;   // метров в одной единице мира
export const fmtDist = (r) => { const m = Math.round(r * UNIT_M); return m < 1000 ? m + ' м' : (m / 1000).toString().replace('.', ',') + ' км'; };
export const nukeZoneLabel = (sp, i) => `${sp.zoneNames[i]} ${fmtDist(sp.zones[i])}`;
// Урон ядерной боеголовки по цели на расстоянии d от эпицентра (sp — silo-спека sml). Infinity = гарантированная гибель.
// 0..zones[0]: всё; ..zones[1]: Т1/Т2 гибнут, Т3 теряют heavyT3 прочности, эксперименталы — heavyExp; ..zones[2]: light со спадом.
export function nukeDamage(sp, spec, maxHp, d) {
  const [z0, z1, z2] = sp.zones;
  if (d <= z0) return Infinity;
  if (d <= z1) { const t = spec.role === 'cmd' ? 3 : spec.tier; return t <= 2 ? Infinity : maxHp * (t >= 4 ? sp.heavyExp : sp.heavyT3); }
  if (d <= z2) return sp.light * (1 - 0.6 * (d - z1) / (z2 - z1));
  return 0;
}

export const PRODUCES = {
  land: ['eng1', 'lab', 'tank1', 'arty1', 'aa1', 'eng2', 'tank2', 'mml', 'flak2', 'eng3', 'siege', 'arty3', 'aa3', 'sacu'],
  air: ['scout_air', 'int1', 'bomb1', 'kami', 'trans1', 'gunship', 'trans2', 'asf', 'strat'],
  naval: ['frigate', 'sub', 'destroyer', 'cruiser', 'battleship']
};

export const TIER_NAMES = ['', 'Т1', 'Т2', 'Т3', 'Т4'];

// Precomputed helpers.
function derive(s) {
  s.dps = (s.weapons || []).reduce((a, w) => a + w.dmg * w.rof * w.salvo, 0);
  s.dpsGround = (s.weapons || []).filter(w => w.targets.includes('land')).reduce((a, w) => a + w.dmg * w.rof * w.salvo, 0);
  s.dpsAir = (s.weapons || []).filter(w => w.targets.includes('air')).reduce((a, w) => a + w.dmg * w.rof * w.salvo, 0);
  s.dpsNaval = (s.weapons || []).filter(w => w.targets.includes('naval') || w.targets.includes('sub')).reduce((a, w) => a + w.dmg * w.rof * w.salvo, 0);
  s.maxRange = Math.max(0, ...(s.weapons || []).map(w => w.range));
  return s;
}
for (const [k, s] of Object.entries(UNITS)) {
  s.key = k; s.isUnit = true;
  derive(s);
  s.layer = s.move === 'air' ? 'air' : s.move === 'naval' ? (s.sub ? 'sub' : 'naval') : 'land';
  s.buildTier = s.canBuild ? s.tier : 0;
  s.slots = s.cargo ? 0 : s.role === 'exp' || s.move !== 'land' && s.move !== 'amph' ? 99 : s.key === 'acu' ? 6 : s.tier >= 3 ? 4 : s.tier === 2 ? 2 : 1;
}

// Per-unit spec of an ACU / sACU with installed enhancements (enh = { rarm, larm, back }).
export function unitSpec(key, enh = {}) { return key === 'sacu' ? sacuSpec(enh) : key === 'acu' ? acuSpec(enh) : UNITS[key]; }
function sacuSpec(enh) {
  const b = UNITS.sacu, s = { ...b, enh };
  const gun = enh.rarm === 's_gun';
  s.weapons = [{ ...b.weapons[0], range: gun ? 56 : 40, dmg: gun ? 150 : 60 }];
  s.bp = enh.rarm === 's_eng' ? 80 : 30;
  s.vision = enh.larm === 's_radar' ? 80 : 56; s.radar = enh.larm === 's_radar' ? 300 : 0;
  s.resM = enh.larm === 's_res' ? 6 : 0; s.resE = enh.larm === 's_res' ? 300 : 0;
  s.hp = b.hp + (enh.back === 's_regen' ? 4000 : 0);
  s.regen = enh.back === 's_regen' ? 25 : 0;
  s.pshield = enh.back === 's_shield' ? { hp: 4000, regen: 40, r: 6 } : null;
  return derive(s);
}
export function acuSpec(enh = {}) {
  const b = UNITS.acu, s = { ...b, enh };
  const gun = enh.rarm === 'gun';
  s.weapons = [{ ...b.weapons[0], range: gun ? 60 : 44, dmg: gun ? 180 : 100 }];
  if (gun) s.overcharge = { ...b.overcharge, range: 60 };
  const lt = enh.larm === 'eng3' ? 3 : enh.larm === 'eng2' ? 2 : 1;
  s.canBuild = lt === 3 ? T4_BUILD : lt === 2 ? T2_BUILD : T1_BUILD;
  s.buildTier = lt; s.bp = lt === 3 ? 60 : lt === 2 ? 25 : 10;
  s.hp = b.hp + (enh.back === 'regen' ? 6000 : 0);
  s.regen = enh.back === 'regen' ? 30 : 0;
  s.pshield = enh.back === 'shield' ? { hp: 5000, regen: 50, r: 7 } : null;
  s.resM = enh.back === 'res' ? 10 : 0; s.resE = enh.back === 'res' ? 300 : 0;
  return derive(s);
}
for (const [k, s] of Object.entries(STRUCTS)) {
  s.key = k; s.isStruct = true; s.speed = 0; s.radius = s.size * 0.6; s.vision = s.vision || (s.weapons ? 70 : 40);
  s.weapons = s.weapons || [];
  s.dps = s.weapons.filter(w => !w.targets.every(t => t === 'missile')).reduce((a, w) => a + w.dmg * w.rof * w.salvo, 0); // missile-defence guns hurt nobody
  s.dpsGround = s.weapons.filter(w => w.targets.includes('land')).reduce((a, w) => a + w.dmg * w.rof * w.salvo, 0);
  s.dpsAir = s.weapons.filter(w => w.targets.includes('air')).reduce((a, w) => a + w.dmg * w.rof * w.salvo, 0);
  s.dpsNaval = s.weapons.filter(w => w.targets.includes('naval') || w.targets.includes('sub')).reduce((a, w) => a + w.dmg * w.rof * w.salvo, 0);
  s.maxRange = Math.max(0, ...s.weapons.map(w => w.range));
  s.layer = s.place === 'water' ? 'naval' : 'land';
  s.cat = 'struct';
}

// Total cost of a structure including the upgrade chain (for wreck value / AI value).
// upgraded structure -> the one it was upgraded from
export const UPGRADE_FROM = Object.fromEntries(Object.values(STRUCTS).filter(s => s.upgradesTo).map(s => [s.upgradesTo, s.key]));
export function chainCost(key) {
  let m = 0, e = 0, bt = 0;
  let k = key;
  while (k) { const s = ALL_SPECS[k]; m += s.costM; e += s.costE; bt += s.bt || 0; k = UPGRADE_FROM[k]; }
  return { m, e, bt };
}
// Buildable root of an upgrade chain (mex3 -> mex).
export const baseKey = (k) => { while (UPGRADE_FROM[k]) k = UPGRADE_FROM[k]; return k; };
