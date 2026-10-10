// Per-unit autonomous brain. Every unit "thinks" ~5 times a second:
//  * scores visible enemies (threat, value, HP, focus fire, overkill avoidance, role preferences)
//  * kites with longer range, dodges incoming artillery/bombs, retreats for repairs when badly hurt
//  * falls back when locally outnumbered, engineers self-assign repair/assist/reclaim tasks
// The brain executes player / AI orders on top of that and exposes a human-readable "thought".
import { STRUCTS, ENH, DT, chainCost } from './specs.js';
import { clearanceClass } from './terrain.js';
import { hitMask, rangeVsBit, wMask } from './layers.js';

const AUTON = { off: 0, smart: 1, full: 2 };
const hyp = (x, y) => Math.sqrt(x * x + y * y);
const dist = (a, b) => hyp(a.x - b.x, a.y - b.y);

export function createBrain(u) {
  return {
    state: 'idle', thought: 'Ожидаю приказов', log: [], home: { x: u.x, y: u.y },
    best: null, bestScore: 0, enemies: [], enemyPow: 0, friendPow: 0, thinkTick: -99, mt: null,
    dodge: null, retreat: null, fallback: null, flee: null, run: null, nextAuto: 0
  };
}

// Move target without a per-tick allocation: one object per brain, refilled on every call (nobody keeps a reference).
function mv(u, x, y, arrive, speedMul = 1) {
  const b = u.brain; let m = b.mt;
  if (!m) m = b.mt = { x: 0, y: 0, arrive: 0, speedMul: 1 };
  m.x = x; m.y = y; m.arrive = arrive; m.speedMul = speedMul;
  u.moveTarget = m;
}

// Скорость в строю: чем дальше юнит от своего слота относительно среднего по группе, тем быстрее (до своего максимума); кто впереди — притормаживает.
function fgMul(u, g, o) {
  const base = o.vmax ? Math.min(1, o.vmax / u.spec.speed) : 1, gr = o.fg && g.fgroups.get(o.fg);
  if (!gr || !gr.set.has(u)) return base;
  if (gr.tick !== g.tick) {
    let n = 0, sum = 0;
    for (const m of gr.set) { const mo = m.alive && m.orders[0]; if (mo && mo.fg === o.fg && m.stuck < 1) { n++; sum += hyp(m.x - mo.x, m.y - mo.y); } }
    if (!n) return base;   // все застряли; пустые группы чистит orderMove при > 64
    gr.tick = g.tick; gr.mean = sum / n;
  }
  return Math.max(0.3, Math.min(1, base * (1 + (hyp(u.x - o.x, u.y - o.y) - gr.mean) / 15)));
}

export const powerOf = (e) => (e.kind === 'struct' && !e.built) ? 0 : Math.sqrt(Math.max(0, e.spec.dps) * Math.max(1, e.hp));
const level = (u, g) => AUTON[g.teams[u.team].autonomy] ?? 2;

// Building thought strings every tick for thousands of units is pure garbage: hot call sites ask first.
const chat = (u, g, state) => u.brain.state !== state || ((g.tick + u.id) & 7) === 0;

function say(u, g, state, text) {
  const b = u.brain;
  b.thought = text;
  if (b.state !== state) {
    b.state = state;
    b.log.unshift({ t: g.time, text });
    if (b.log.length > 7) b.log.pop();
  }
}

export function onNewOrder(u) {
  const b = u.brain;
  b.retreat = null; b.fallback = null; b.run = null; b.flee = null; b.aid = null; b.unseen = null; b.ap = null;
}

export function onDeath(u) {
  const b = u.brain;
  if (b.best) b.best.incDps = Math.max(0, b.best.incDps - u.spec.dps);
  b.best = null;
  u.inFlightDmg = 0;
}

function setBest(u, t, score) {
  const b = u.brain;
  if (b.best !== t) {
    if (b.best) b.best.incDps = Math.max(0, b.best.incDps - u.spec.dps);
    if (t) t.incDps += u.spec.dps;
    b.best = t;
  }
  b.bestScore = score;
}

export function rangeVs(u, g, t) { return rangeVsBit(u.spec, g.layerBitOf(t)); }

function scoreTarget(u, g, t, d, R, myBit) {
  const s = u.spec, ts = t.spec, b = u.brain;
  let sc = 100 - (d / Math.max(R, 1)) * 35;
  if (d <= R + (ts.radius || 0)) sc += 30;
  if (hitMask(ts) & myBit) sc += 20 + Math.min(30, ts.dps / 8);
  sc += (1 - t.hp / t.maxHp) * 35;
  if (t.hp < s.dps * 1.5) sc += 25;
  sc += Math.log2(1 + (ts.costM || 40)) * 3;
  switch (s.role) {
    case 'arty': if (t.kind === 'struct') sc += 35; if ((t.speed || 0) < 1) sc += 15; break;
    case 'bomber': if (t.kind === 'struct') sc += 15; if (ts.role === 'eng' || t.key === 'mex' || t.key === 'acu') sc += 30; if (ts.dpsAir > 0) sc -= 25; sc -= aaCover(b, t); break;
    case 'gunship': if (ts.dpsAir > 0) sc -= 20; if (ts.role === 'eng') sc += 15; sc -= aaCover(b, t); break;
    case 'direct': case 'exp': if (t.kind === 'unit') sc += 10; break;
    case 'aa': case 'fighter': if (ts.role === 'bomber' || ts.role === 'gunship') sc += 25; break;
  }
  if (t.key === 'acu') sc += 15;
  if (t.kind === 'struct' && !t.built) sc -= 25;
  if (ts.role === 'eng') sc += 12;
  const tf = t.focus;
  if (tf && g.allied(tf.team, u.team) && (tf.key === 'acu' || tf.spec.role === 'eng')) sc += 25;
  const inc = t.incDps - (b.best === t ? s.dps : 0);
  if (inc > 0) { if (inc * 1.3 > t.hp) sc -= 45; else sc += Math.min(20, inc / 10); }
  const flying = t.inFlightDmg || 0;
  if (flying >= t.hp) sc -= 250;
  else if (flying > 0) sc -= (flying / Math.max(1, t.hp)) * 40;
  if (b.best === t) sc += 18;
  return sc;
}

// Air strikers avoid targets covered by enemy anti-air (sum of AA dps whose range covers the target).
function aaCover(b, t) {
  let a = 0;
  for (const e of b.enemies) if (e.spec.dpsAir > 0 && e !== t && dist(e, t) < e.spec.maxRange + 8) a += e.spec.dpsAir;
  return Math.min(70, a / 3);
}

function chooseBest(u, g) {
  const b = u.brain, myBit = g.layerBitOf(u), us = u.spec;
  let best = null, bs = -1e9;
  const list = b.enemies;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t.kind === 'struct' && !t.built && t.progress < 0.05) continue;
    const R = rangeVsBit(us, g.layerBitOf(t));
    if (!R) continue;
    const sc = scoreTarget(u, g, t, dist(u, t), R, myBit);
    if (sc > bs) { bs = sc; best = t; }
  }
  setBest(u, best, bs);
}

export function repairPoint(g, u) {
  let best = null, bd = 1e9;
  for (const s of g.structs) {
    if (s.team !== u.team || !s.built || !(s.spec.produces || s.shield || s.spec.weapons.length)) continue;
    const d = dist(s, u);
    if (d < bd) { bd = d; best = s; }
  }
  if (best) {
    const a = Math.atan2(u.y - best.y, u.x - best.x);
    return { x: best.x + Math.cos(a) * (best.spec.size / 2 + 8), y: best.y + Math.sin(a) * (best.spec.size / 2 + 8) };
  }
  return g.teams[u.team].start;
}

// ------------------------------------------------------------------ THINK
// Enemies considered per brain scan (the nearest ones); the threat numbers come from Game's aggregated threat fields.
const NEAR_CAP = 24;
function think(u, g) {
  const s = u.spec, b = u.brain, lvl = level(u, g);
  const scan = Math.max(s.vision, s.maxRange + 12);
  b.thinkTick = g.tick;
  // engineers keep the exact full-radius list (few of them, and they flee from any gun that reaches them)
  if (s.role === 'eng') g.enemiesNear(u.team, u.x, u.y, scan, true, b.enemies);
  else g.nearEnemies(u, scan, b.enemies, NEAR_CAP);
  const myBit = g.layerBitOf(u);
  b.enemyPow = g.threatAt(u.team, myBit, u.x, u.y);
  b.splashThreat = g.splashNear;
  b.friendPow = b.enemyPow > 0 ? g.friendPowAt(u.team, u.x, u.y, 45) : powerOf(u);

  if (s.weapons.length) chooseBest(u, g); else setBest(u, null, 0);

  // tactical awareness: hit by something we can't see (artillery, missiles from the fog)
  const att = u.lastAttacker;
  if (att && att.alive && g.time - u.lastHit < 1.2 && !g.visibleTo(u.team, att) && !att.rad[u.team]) {
    const err = 12;
    b.unseen = { x: att.x + (Math.random() - 0.5) * err, y: att.y + (Math.random() - 0.5) * err, t: g.time, range: att.spec.maxRange || 0 };
  }

  // ACU / auto overcharge
  if (s.overcharge && g.teams[u.team].autoOC && b.best && u.ocCd <= 0) {
    const eco = g.teams[u.team].eco, t = b.best;
    if (eco.energy > s.overcharge.cost + 800 && t.kind && (t.hp > 600 || t.spec.tier >= 2) && dist(u, t) < s.overcharge.range) {
      if (g.overcharge(u, t)) say(u, g, 'oc', `СВЕРХЗАРЯД по ${t.spec.short || t.spec.name}!`);
    }
  }

  if (lvl >= 1) checkDodge(u, g);
  if (lvl >= 2) checkRetreat(u, g);
  if (s.role === 'eng') engineerThink(u, g, lvl);
}

function checkDodge(u, g) {
  const s = u.spec, b = u.brain;
  if (!g.impacts.length || s.move === 'air' || s.speed < 5 || (b.dodge && g.time < b.dodge.until)) return;
  for (const im of g.impacts) {
    if (g.allied(im.team, u.team)) continue;
    const eta = im.t - g.time;
    if (eta <= 0.05 || eta > 1.8) continue;
    const d = hyp(u.x - im.x, u.y - im.y);
    const need = im.r + s.radius + 1;
    if (d >= need) continue;
    const move = need - d + 1.5;
    if (move / s.speed > eta + 0.35) continue;
    // prefer sidestepping perpendicular to our heading
    let ax = -Math.sin(u.yaw), ay = Math.cos(u.yaw);
    if ((u.x - im.x) * ax + (u.y - im.y) * ay < 0) { ax = -ax; ay = -ay; }
    const tx = u.x + ax * (move + 1), ty = u.y + ay * (move + 1);
    if (!g.terrain.passableAt(s.move, tx, ty)) { ax = -ax; ay = -ay; }
    b.dodge = { x: u.x + ax * (move + 1), y: u.y + ay * (move + 1), until: im.t + 0.15 };
    say(u, g, 'dodge', `Уклоняюсь от снаряда (удар через ${eta.toFixed(1)} с)`);
    return;
  }
}

function checkRetreat(u, g) {
  const s = u.spec, b = u.brain;
  const hpf = u.hp / u.maxHp;
  const noRetreat = s.role === 'cmd' || s.role === 'exp' || s.role === 'eng' || s.role === 'scout' || s.role === 'fighter';
  if (!noRetreat && !b.retreat && hpf < 0.3 && b.enemyPow > 0) {
    const rp = repairPoint(g, u);
    b.retreat = { x: rp.x, y: rp.y, until: g.time + 30 };
    say(u, g, 'retreat', `HP ${Math.round(hpf * 100)}% — отступаю на ремонт`);
  }
  if (b.retreat && (hpf > 0.8 || g.time > b.retreat.until || (hyp(u.x - b.retreat.x, u.y - b.retreat.y) < 16 && b.enemyPow === 0 && hpf > 0.55))) {
    b.retreat = null;
    say(u, g, 'resume', 'Ремонт окончен — возвращаюсь в строй');
  }
  const o = u.orders[0];
  const soft = !o || o.type === 'amove' || o.type === 'patrol' || o.auto;
  if (!noRetreat && !b.retreat && soft && b.enemyPow > 40 && b.enemyPow > b.friendPow * 2.6 && s.move !== 'air') {
    const rp = repairPoint(g, u);
    if (!b.fallback || g.time > b.fallback.until) {
      b.fallback = { x: rp.x, y: rp.y, until: g.time + 5 };
      say(u, g, 'fallback', `Перевес врага ×${(b.enemyPow / Math.max(1, b.friendPow)).toFixed(1)} — отхожу к своим`);
    }
  }
}

function engineerThink(u, g, lvl) {
  const s = u.spec, b = u.brain;
  // an explicit (queued) order to reclaim the threat itself overrides the instinct to run away
  const danger = b.enemies.find(e => e.kind === 'unit' && e.spec.dpsGround > 0 && e.spec.move !== 'air' && dist(u, e) < e.spec.maxRange + 14 && !u.orders.some(q => q.type === 'reclaim' && q.target === e));
  if (danger && lvl >= 1 && s.role === 'eng') {
    const rp = repairPoint(g, u);
    let ax = u.x - danger.x, ay = u.y - danger.y; const l = hyp(ax, ay) || 1;
    const tx = u.x + ax / l * 25 * 0.6 + (rp.x - u.x) * 0.4, ty = u.y + ay / l * 25 * 0.6 + (rp.y - u.y) * 0.4;
    b.flee = { x: tx, y: ty, until: g.time + 2.5 };
    say(u, g, 'flee', `Угроза: ${danger.spec.short || danger.spec.name} рядом — отхожу`);
    return;
  }
  if (lvl >= 2 && !u.orders.length && g.time > b.nextAuto && !b.flee) {
    b.nextAuto = g.time + 1.5;
    autoTask(u, g);
  }
}

function autoTask(u, g) {
  const eco = g.teams[u.team].eco;
  let best = null, bd = 70;
  for (const st of g.structs) {
    if (st.team !== u.team || st.built) continue;
    const d = dist(u, st); if (d < bd) { bd = d; best = st; }
  }
  if (best) { u.orders.push({ type: 'assist', target: best, auto: true }); return say(u, g, 'assist', `Помогаю строить: ${best.spec.name}`); }
  bd = 55;
  for (const f of g.friendsNear(u.team, u.x, u.y, 55)) {
    if (f === u || f.hp >= f.maxHp * 0.85 || (f.kind === 'struct' && !f.built) || f.spec.move === 'air') continue;
    const d = dist(u, f); if (d < bd) { bd = d; best = f; }
  }
  if (best) { u.orders.push({ type: 'repair', target: best, auto: true }); return say(u, g, 'repair', `Чиню: ${best.spec.name}`); }
  // capture a nearby free mass deposit if nobody is on it and no enemies are around
  if (u.spec.canBuild?.includes('mex') && eco.energy > 400) {
    bd = 150;
    const claimed = (m) => g.units.some(o => o.team === u.team && o.orders.some(q => q.type === 'build' && q.key === 'mex' && q.x === m.x && q.y === m.y));
    for (const m of g.terrain.mass) {
      const d = dist(u, m); if (d >= bd) continue;
      if (g.structs.some(s => s.alive && s.spec.place === 'mex' && s.x === m.x && s.y === m.y)) continue;
      if (g.enemiesNear(u.team, m.x, m.y, 60).some(e => e.spec.dps > 0) || claimed(m)) continue;
      bd = d; best = m;
    }
    if (best) { u.orders.push({ type: 'build', key: 'mex', x: best.x, y: best.y, site: null, auto: true }); return say(u, g, 'build', `Свободное месторождение в ${Math.round(bd)} м — ставлю экстрактор`); }
  }
  if (eco.mass < eco.maxMass * 0.92) {
    bd = 65;
    for (const w of g.wrecks) { const d = dist(u, w); if (d < bd) { bd = d; best = w; } }
    if (!best) for (const f of g.terrain.featuresNear(u.x, u.y, 45)) if (f.mass > 0) { const d = dist(u, f); if (d < bd) { bd = d; best = f; } }
  }
  if (!best && eco.energy < eco.maxEnergy * 0.9) {
    bd = 35;
    for (const f of g.terrain.featuresNear(u.x, u.y, 35)) if (f.energy > 0) { const d = dist(u, f); if (d < bd) { bd = d; best = f; } }
  }
  if (best) { u.orders.push({ type: 'reclaim', target: best, auto: true }); return say(u, g, 'reclaim', best.kind === 'wreck' ? 'Разбираю обломки на массу' : 'Перерабатываю ресурсы местности'); }
}

// ------------------------------------------------------------------ ACT
export function update(u, g) {
  const b = u.brain, ph = g.tick + u.id;
  // LOD of the brain: units in contact think at 5 Hz, ones on the move with nothing in sight at 2.5 Hz, idle ones at 1 Hz.
  // Incoming-shell dodging is a cheap reflex and keeps its 5 Hz cadence regardless.
  if (ph % (b.enemies.length ? 6 : u.orders.length ? 12 : 30) === 0) think(u, g);
  else if (g.impacts.length && ph % 6 === 0 && level(u, g) >= 1) checkDodge(u, g);
  u.moveTarget = null; u.focus = null; u.beam = null;
  execute(u, g);
  // navigation reflexes (stuck recovery, waiting for a path) override the "thought" while active
  const nv = u.nav;
  if (nv && nv.msg && u.moveTarget && g.time < nv.msgUntil) say(u, g, 'nav', nv.msg);
}

function fireAtBest(u, g) {
  const t = u.brain.best;
  if (t && t.alive && dist(u, t) <= rangeVs(u, g, t) + (t.spec.radius || 0)) u.focus = t;
}

function execute(u, g) {
  const b = u.brain, s = u.spec;
  if (b.dodge) {
    if (g.time < b.dodge.until) { mv(u, b.dodge.x, b.dodge.y, 0.6); fireAtBest(u, g); return; }
    b.dodge = null;
  }
  if (b.flee) {
    if (g.time < b.flee.until) { mv(u, b.flee.x, b.flee.y, 2); return; }
    b.flee = null;
  }
  if (b.retreat) { mv(u, b.retreat.x, b.retreat.y, 6); fireAtBest(u, g); return; }
  if (b.fallback) {
    if (g.time < b.fallback.until) { mv(u, b.fallback.x, b.fallback.y, 8); fireAtBest(u, g); return; }
    b.fallback = null;
  }
  const o = u.orders[0];
  if (!o) return idle(u, g);
  const done = (H[o.type] || H.move)(u, g, o);
  if (done) {
    u.orders.shift();
    b.run = null;
    if (!u.orders.length) b.home = { x: u.x, y: u.y };
  }
}

function engage(u, g, t, forced) {
  const s = u.spec, b = u.brain;
  const R = rangeVs(u, g, t);
  if (!R) return false;
  u.focus = t;
  const d = dist(u, t) - (t.spec.radius || 0);
  const nm = t.spec.short || t.spec.name;
  if (s.move === 'air') {
    if (s.role === 'bomber') return bombRun(u, g, t);
    if (s.quad) {   // квадрокоптер не кружит: встаёт на 0.7 дальности по линии цель→юнит и зависает носом к цели
      const l = hyp(u.x - t.x, u.y - t.y) || 1;
      mv(u, t.x + (u.x - t.x) / l * R * 0.7, t.y + (u.y - t.y) / l * R * 0.7, 2);
      if (chat(u, g, 'engage')) say(u, g, 'engage', `Зависаю над целью: ${nm}`);
      return true;
    }
    if (s.kami) { mv(u, t.x, t.y, 2); return true; }   // камикадзе — прямо в цель
    if (s.role === 'gunship' || s.fly === 'hover') {
      const a = Math.atan2(u.y - t.y, u.x - t.x) + 0.35;
      mv(u, t.x + Math.cos(a) * R * 0.6, t.y + Math.sin(a) * R * 0.6, 2);
      if (chat(u, g, 'engage')) say(u, g, 'engage', `Кружу над целью: ${nm}`);
      return true;
    }
    mv(u, t.x + (t.vx || 0) * 0.5, t.y + (t.vy || 0) * 0.5, 0);
    if (chat(u, g, 'engage')) say(u, g, 'engage', `Воздушный бой: ${nm}`);
    return true;
  }
  const lvl = level(u, g);
  const lbT = g.layerBitOf(t);
  let w0 = null; for (const w of s.weapons) if (wMask(w) & lbT) { w0 = w; break; }
  const theirR = t.kind === 'unit' && (hitMask(t.spec) & g.layerBitOf(u)) ? t.spec.maxRange : 0;
  if (lvl >= 1 && ((theirR > 0 && R > theirR + 6 && d < theirR + 7) || (w0 && w0.minRange && d < w0.minRange + 3))) {
    let ax = u.x - t.x, ay = u.y - t.y; const l = hyp(ax, ay) || 1;
    mv(u, u.x + ax / l * 14, u.y + ay / l * 14, 1);
    if (chat(u, g, 'kite')) say(u, g, 'kite', `Кайтинг: держу дистанцию ${Math.round(d)}/${Math.round(R)} от ${nm}`);
    return true;
  }
  // badly hurt front-liner steps back behind healthier friends while the fight is being won
  if (lvl >= 2 && theirR > 0 && s.role === 'direct' && u.hp < u.maxHp * 0.4 && b.friendPow > b.enemyPow * 1.3 && d < theirR + 3) {
    let ax = u.x - t.x, ay = u.y - t.y; const l = hyp(ax, ay) || 1;
    mv(u, u.x + ax / l * 12, u.y + ay / l * 12, 1);
    if (chat(u, g, 'rotate')) say(u, g, 'rotate', `Ранен (${Math.round(u.hp / u.maxHp * 100)}%) — пропускаю вперёд целых, стреляю из-за спин`);
    return true;
  }
  // Combined arms tethering: direct combat units don't sprint beyond AA escort when air threats are near
  if (lvl >= 1 && s.role === 'direct' && d > R * 0.92) {
    const airThreat = b.enemies.some(e => e.spec.move === 'air' && e.spec.dpsGround > 0);
    if (airThreat) {
      const nearAA = g.friendsNear(u.team, u.x, u.y, 40).some(f => f.spec.dpsAir > 15);
      if (!nearAA) {
        const aaFriend = g.friendsNear(u.team, u.x, u.y, 90).find(f => f.spec.dpsAir > 15 && f.spec.move !== 'air');
        if (aaFriend && dist(u, aaFriend) > 35) {
          if (chat(u, g, 'tether')) say(u, g, 'tether', `Жду прикрытия ПВО (${aaFriend.spec.short || 'зенитка'} в ${Math.round(dist(u, aaFriend))} м)`);
          return true;
        }
      }
    }
  }
  // Mobile artillery stays behind front-line direct combat screens
  if (lvl >= 1 && s.role === 'arty' && d < R * 0.65) {
    const friendFront = g.friendsNear(u.team, u.x, u.y, 45).some(f => f.spec.role === 'direct');
    if (friendFront && theirR > 0 && d < theirR + 12) {
      let ax = u.x - t.x, ay = u.y - t.y; const l = hyp(ax, ay) || 1;
      mv(u, u.x + ax / l * 12, u.y + ay / l * 12, 1);
      if (chat(u, g, 'screen')) say(u, g, 'screen', `Арт-позиция: веду огонь из-за спин союзников`);
      return true;
    }
  }
  if (d > R * 0.92) {
    mv(u, t.x, t.y, R * 0.82 + (t.spec.radius || 0));
    if (chat(u, g, 'engage')) say(u, g, 'engage', `Сближаюсь с целью: ${nm} (${Math.round(d)} м)`);
  } else {
    const inc = t.incDps > s.dps ? `, фокус-огонь ×${Math.max(1, Math.round(t.incDps / Math.max(1, s.dps)))}` : '';
    if (chat(u, g, 'engage')) say(u, g, 'engage', `Огонь по ${nm}: HP ${Math.round(t.hp / t.maxHp * 100)}%${inc}`);
  }
  return true;
}

function bombRun(u, g, t) {
  const b = u.brain;
  if (!b.run) b.run = { phase: 'in' };
  const ws = u.weapons[0];
  if (b.run.phase === 'in') {
    mv(u, t.x, t.y, 0);
    if (ws && ws.cd > (1 / ws.w.rof) * 0.7) { b.run = { phase: 'out', dx: Math.cos(u.yaw), dy: Math.sin(u.yaw), t: g.time }; }
    say(u, g, 'bombrun', `Заход на бомбометание: ${t.spec.short || t.spec.name}`);
  } else {
    mv(u, t.x + b.run.dx * 80, t.y + b.run.dy * 80, 0);
    if (dist(u, t) > 60 || g.time - b.run.t > 4) b.run.phase = 'in';
    say(u, g, 'bombrun', 'Выход из атаки, разворот на повторный заход');
  }
  return true;
}

function idle(u, g) {
  const s = u.spec, b = u.brain, lvl = level(u, g);
  if (s.move === 'air') {
    if (s.role !== 'transport' && b.best && hyp(b.best.x - b.home.x, b.best.y - b.home.y) < 90 && lvl >= 1) { engage(u, g, b.best); return; }
    b.run = null;
    if (chat(u, g, 'idle')) say(u, g, 'idle', s.role === 'scout' ? 'Барражирую, веду разведку' : s.role === 'transport' ? (u.cargo.length ? `Жду приказа, на борту ${u.cargo.length}` : 'Жду груз') : 'Патрулирую над позицией');
    return;
  }
  if (b.best) {
    const leash = Math.max(s.vision, s.maxRange) * 1.25;
    if (lvl >= 1 && hyp(b.best.x - b.home.x, b.best.y - b.home.y) < leash) { engage(u, g, b.best); return; }
    fireAtBest(u, g);
  } else if (lvl >= 1 && s.weapons.length && b.unseen && g.time - b.unseen.t < 5 && hyp(b.unseen.x - b.home.x, b.unseen.y - b.home.y) < 160) {
    // shelled from the fog: rush the shooter if it outranges us, otherwise sidestep out of its aim
    const un = b.unseen;
    if (un.range > s.maxRange + 5 && u.hp > u.maxHp * 0.4 && b.enemyPow <= b.friendPow) {
      mv(u, un.x, un.y, s.maxRange * 0.7);
      say(u, g, 'hunt', `Обстрел из-за пределов обзора (дальность ~${Math.round(un.range)}) — иду на источник`);
    } else {
      const a = Math.atan2(u.y - un.y, u.x - un.x) + Math.PI / 2 * (u.id % 2 ? 1 : -1);
      mv(u, u.x + Math.cos(a) * 10, u.y + Math.sin(a) * 10, 1);
      say(u, g, 'dodge', 'Под огнём невидимого врага — меняю позицию');
    }
    return;
  } else if (lvl >= 2 && s.weapons.length) {
    // mutual aid: a friend nearby is being shot by an enemy we can reach
    const ok = (a) => a && a.alive && (g.visibleTo(u.team, a) || a.rad[u.team]) && rangeVs(u, g, a) && hyp(a.x - b.home.x, a.y - b.home.y) < Math.max(s.vision, s.maxRange) * 1.8;
    if (b.aid && (g.time > b.aid.until || !ok(b.aid.t))) b.aid = null;
    if (!b.aid && (g.tick + u.id) % 10 === 0) {
      for (const f of g.friendsNear(u.team, u.x, u.y, 70)) {
        if (f !== u && g.time - f.lastHit < 2 && ok(f.lastAttacker)) { b.aid = { t: f.lastAttacker, f, until: g.time + 4 }; break; }
      }
    }
    if (b.aid) {
      engage(u, g, b.aid.t);
      say(u, g, 'aid', `Помогаю союзнику: ${b.aid.f.spec.short || b.aid.f.spec.name} под огнём ${b.aid.t.spec.short || b.aid.t.spec.name}`);
      return;
    }
  }
  if (lvl >= 1 && b.splashThreat && s.speed > 0 && (g.tick + u.id) % 15 === 0) {
    // spread out against artillery / bombs: nudge the home point away from the nearest friend
    let n = null, nd = s.radius * 2 + 6;
    for (const f of g.friendsNear(u.team, u.x, u.y, nd)) if (f !== u && f.kind === 'unit' && f.spec.move !== 'air') { const d = dist(u, f); if (d < nd) { nd = d; n = f; } }
    if (n) {
      const a = Math.atan2(u.y - n.y, u.x - n.x);
      b.home = { x: b.home.x + Math.cos(a) * 3, y: b.home.y + Math.sin(a) * 3 };
      if (!g.terrain.passableAt(s.move, b.home.x, b.home.y)) b.home = { x: u.x, y: u.y };
      say(u, g, 'spread', 'Рядом артиллерия/бомбардировщики — рассредоточиваюсь');
    }
  }
  if (hyp(u.x - b.home.x, u.y - b.home.y) > 5) { mv(u, b.home.x, b.home.y, 2); if (chat(u, g, 'return')) say(u, g, 'return', 'Возвращаюсь на позицию'); }
  else if (s.role === 'eng') say(u, g, 'idle', 'Жду задания (свободный инженер)');
  else if (chat(u, g, 'idle')) say(u, g, 'idle', b.enemies.length ? `Вижу ${b.enemies.length} враж. объектов — вне зоны ответственности` : 'Охраняю позицию');
}

// ------------------------------------------------------------------ REACH (SupCom style build range)
// Every builder has spec.buildRange, measured from the EDGE of the target (a size x size square for structures,
// a circle of `radius` for units / wrecks). An engineer that is out of range walks to the nearest free spot
// within range instead of pushing to the target's centre, so it can help from behind neighbouring buildings.
const isRect = (t) => t.kind === 'struct' || (t.kind === 'wreck' && t.struct && t.size > 0);
const halfOf = (t) => isRect(t) ? (t.spec?.size || t.size) / 2 : (t.spec?.radius ?? 2);
const rangeOf = (u) => u.spec.buildRange || 20;

export function edgeDist(x, y, t) {
  if (isRect(t)) {
    const h = halfOf(t);
    return hyp(Math.max(Math.abs(x - t.x) - h, 0), Math.max(Math.abs(y - t.y) - h, 0));
  }
  return Math.max(0, hyp(x - t.x, y - t.y) - halfOf(t));
}

// Nearest point of the target's edge to the unit, where the build beam lands.
function beamTo(u, t, kind, ok, size) {
  let x = t.x, y = t.y;
  if (isRect(t)) {
    const h = Math.max(0, halfOf(t) - 1.5);
    x = Math.max(t.x - h, Math.min(t.x + h, u.x)); y = Math.max(t.y - h, Math.min(t.y + h, u.y));
    size = Math.min(size || 4, 8);
  }
  u.beam = { x, y, kind, ok, size: size || 3 };
  return u.beam;
}

// Best standing point within `range` of the target's edge: passable, reachable, closest to the engineer.
// Returns { pt } (pt = null if nowhere to stand) or { pend: true } while the pathfinding budget is exhausted.
function approachPoint(u, g, t, range, force) {
  const dom = u.spec.move, T = g.terrain;
  const rect = isRect(t), h = halfOf(t);
  const offs = [range - 2.5, range * 0.7, range * 0.45, 3];
  const dirs = [Math.atan2(u.y - t.y, u.x - t.x)];
  for (let i = 0; i < 32; i++) dirs.push(i / 32 * Math.PI * 2);
  const cands = [];
  for (const a of dirs) {
    const cx = Math.cos(a), cy = Math.sin(a);
    const base = rect ? h / Math.max(Math.abs(cx), Math.abs(cy)) : h;
    for (const e of offs) {
      const x = t.x + cx * (base + e), y = t.y + cy * (base + e);
      if (!g.walkable(dom, x, y) || g.solidAt(x, y, u.spec.radius) || edgeDist(x, y, t) > range - 1) continue; // клетка может быть свободна по центру, а точка лежит у/внутри здания
      cands.push({ x, y, d: hyp(x - u.x, y - u.y) });
    }
  }
  if (!cands.length) return { pt: null };
  cands.sort((p, q) => p.d - q.d);
  for (let i = 0; i < cands.length && i < 12; i++) if (T.lineClear(dom, u.x, u.y, cands[i].x, cands[i].y)) return { pt: cands[i] };
  if (force) return { pt: cands[0] };
  // no straight walk: rank by real path length (one flow field from the engineer covers every candidate)
  const [ucx, ucy] = T.cell(u.x, u.y);
  const F = T.flowField(dom, clearanceClass(u.spec.radius), ucx, ucy);
  if (!F) return { pend: true };
  const f = F.dist;
  let best = null, bd = Infinity;
  for (const c of cands) {
    const pd = f[T.cellIdx(c.x, c.y)];
    if (pd < bd) { bd = pd; best = c; }
  }
  return { pt: isFinite(bd) ? best : null };
}

// Get within build range of `t`. Returns true when in range (work now), false while walking / waiting,
// 'fail' once the target has stayed unreachable (or too far to get to) for too long.
function toReach(u, g, t, state, text, key = t) {
  const b = u.brain, range = rangeOf(u);
  if (edgeDist(u.x, u.y, t) <= range) { b.ap = null; return true; }
  let ap = b.ap;
  const same = ap && ap.key === key;
  if (!same || g.time > ap.until || (t.kind === 'unit' && hyp(ap.tx - t.x, ap.ty - t.y) > 2.5) || (ap.pt && hyp(ap.pt.x - u.x, ap.pt.y - u.y) < 2.5)) {
    const pend = same ? ap.pend : 0;
    const r = approachPoint(u, g, t, range, pend > 8);
    ap = b.ap = {
      key, tx: t.x, ty: t.y, pt: r.pt || null, pend: r.pend ? pend + 1 : 0,
      until: g.time + (r.pt ? 6 : r.pend ? 0 : 1), since: same ? ap.since : g.time, failT: r.pt || r.pend ? 0 : (same && ap.failT) || g.time
    };
  }
  if (g.time - ap.since > 120) { say(u, g, 'fail', 'Не могу добраться до цели'); b.ap = null; return 'fail'; }
  if (ap.pt) {
    mv(u, ap.pt.x, ap.pt.y, 2);
    say(u, g, state, text);
    return false;
  }
  if (ap.pend) return false;
  say(u, g, 'fail', 'Не подойти на дальность стройки — цель недоступна');
  if (g.time - ap.failT > 4) { b.ap = null; return 'fail'; }
  return false;
}

function buildTick(u, g, site) {
  const S = site.spec, eco = g.teams[u.team].eco;
  const dp = u.spec.bp * DT / S.bt;
  const f = eco.spend(S.costM * dp, S.costE * dp);
  site.progress += dp * f;
  site.hp = Math.min(site.maxHp, site.hp + site.maxHp * dp * f);
  beamTo(u, site, 'build', f > 0.01, S.size);
  u.yaw += Math.max(-0.08, Math.min(0.08, angleTo(u, site)));
  if (site.progress >= 1 && !site.built) { site.progress = 1; site.built = true; site.hp = Math.max(site.hp, site.maxHp * 0.99); g.onBuilt(site); }
}
function angleTo(u, t) { let d = Math.atan2(t.y - u.y, t.x - u.x) - u.yaw; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }

function repairTick(u, g, t) {
  const eco = g.teams[u.team].eco;
  const per = Math.max(3, Math.min(12, t.maxHp / Math.max(300, t.spec.bt || 300)));
  const hp = u.spec.bp * per * DT;
  const f = eco.spend((t.spec.costM || 0) * hp / t.maxHp * 0.4, (t.spec.costE || 0) * hp / t.maxHp * 0.4);
  t.hp = Math.min(t.maxHp, t.hp + hp * f);
  if (t.kind === 'unit') u.beam = { x: t.x, y: t.y, kind: 'build', ok: true, size: t.spec.size || 2, unit: t };
  else beamTo(u, t, 'build', true, t.spec.size || 2);
}

// Reclaiming a working unit / structure (SupCom): takes about bt / bp * RECL_TIME seconds, refunds a share of the
// cost proportional to the HP taken away, and removes the target without wreck or explosion.
const RECL_TIME = 0.6;
const unfinished = (t) => t.kind === 'struct' && !t.built;
function reclaimEntity(u, g, t) {
  if (!g.canReclaim(t).ok) return true;
  const own = t.team === u.team, eco = g.teams[u.team].eco;
  let gainM, gainE;
  if (unfinished(t)) {
    // unfinished building: hands back what was invested (all of it for our own)
    const df = u.spec.bp * DT / (t.spec.bt * RECL_TIME);
    const dp = Math.min(t.progress, df), k = own ? 1 : 0.8;
    t.progress -= dp; t.rcDone = (t.rcDone || 0) + dp; t.hp = Math.max(1, Math.min(t.hp, t.maxHp * Math.max(0.01, t.progress)));
    gainM = t.spec.costM * dp * k; gainE = t.spec.costE * dp * k * (own ? 1 : 0.5);
  } else {
    let M, E, bt;
    if (t.kind === 'struct') { const c = chainCost(t.key); M = c.m; E = c.e; bt = c.bt; }
    else { M = t.spec.costM; E = t.spec.costE; bt = Math.max(20, t.spec.bt || 100); }
    const df = u.spec.bp * DT / (bt * RECL_TIME);
    const dh = Math.min(t.hp, t.maxHp * df), k = own ? 0.8 : 0.7;
    t.hp -= dh; t.rcDone = (t.rcDone || 0) + dh;
    gainM = M * k * dh / t.maxHp; gainE = E * k * 0.5 * dh / t.maxHp;
  }
  eco.add(gainM, gainE);
  t.lastHit = g.time;
  if (!own) {
    t.lastAttacker = u;
    if (!(g.time - (t.rcNote ?? -99) < 15)) { t.rcNote = g.time; g.notify(t.team, 'Противник перерабатывает: ' + t.spec.name, t.x, t.y, 'alert'); }
  }
  if (t.kind === 'unit') u.beam = { x: t.x, y: t.y, kind: 'reclaim', ok: true, size: 3 };
  else beamTo(u, t, 'reclaim', true, t.spec.size);
  if (unfinished(t) ? t.progress <= 0.002 : t.hp <= 0.5) { g.reclaimed(t); return true; }
  return false;
}
// share of the target already taken apart (damage dealt by others does not count)
const reclaimPct = (t) => { const left = unfinished(t) ? t.progress : t.hp, done = t.rcDone || 0; return Math.min(99, Math.round(done / Math.max(1e-6, done + left) * 100)); };

function reclaimTick(u, g, t) {
  if (t.kind === 'unit' || t.kind === 'struct') return reclaimEntity(u, g, t);
  const eco = g.teams[u.team].eco;
  const m = Math.min(t.mass || 0, u.spec.bp * 1.5 * DT), e = Math.min(t.energy || 0, u.spec.bp * 10 * DT);
  t.mass -= m; t.energy -= e; eco.add(m, e);
  u.beam = { x: t.x, y: t.y, kind: 'reclaim', ok: true, size: 3 };
  if (t.mass <= 0.01 && t.energy <= 0.01) { t.alive = false; if (t.type) g.fx.push({ type: 'feature', f: t }); return true; }
  return false;
}

// What a friendly unit / structure is busy with, so helpers can join in (SupCom "assist" on anything).
function workOf(t, depth = 0) {
  if (!t || !t.alive) return null;
  if (t.kind === 'struct') {
    if (!t.built) return { kind: 'build', obj: t };
    if (t.upgrading || (t.spec.produces && t.queue.length && !t.paused) || (t.silo && !t.paused && t.silo.stock < t.spec.silo.max)) return { kind: 'boost', obj: t };   // silos: missile in the works
    return t.hp < t.maxHp ? { kind: 'repair', obj: t } : null;
  }
  if (t.kind !== 'unit') return null;
  const o = t.orders[0];
  if (o) {
    if (o.type === 'enhance') return { kind: 'enh', obj: t, key: o.key };
    if (o.type === 'build' && o.site && o.site.alive && !o.site.built) return { kind: 'build', obj: o.site };
    if (o.type === 'reclaim' && o.target && o.target.alive) return { kind: 'reclaim', obj: o.target };
    if (depth < 2 && (o.type === 'assist' || o.type === 'repair' || o.type === 'guard') && o.target && o.target !== t) {
      const w = workOf(o.target, depth + 1); if (w) return w;
    }
  }
  return t.hp < t.maxHp ? { kind: 'repair', obj: t } : null;
}

// Do (or walk to) whatever `t` is working on. Returns false if there is nothing to help with,
// 'fail' if the work site cannot be reached.
function helpWith(u, g, t) {
  const w = workOf(t);
  if (!w) return false;
  const obj = w.obj, nm = obj.spec?.name || 'ресурсы';
  if (w.kind === 'reclaim' && (obj.kind === 'unit' || obj.kind === 'struct') && !g.canReclaim(obj).ok) return false;
  const r = toReach(u, g, obj, 'assist', `Иду помогать: ${nm}`);
  if (r === 'fail') return 'fail';
  if (!r) return true;
  u.yaw += Math.max(-0.08, Math.min(0.08, angleTo(u, obj)));
  switch (w.kind) {
    case 'build': buildTick(u, g, obj); say(u, g, 'assist', `Помогаю строить ${nm}: ${Math.round(obj.progress * 100)}%`); break;
    case 'boost':
      obj.assistBP += u.spec.bp;
      beamTo(u, obj, 'build', obj.building, obj.spec.size);
      say(u, g, 'assist', obj.upgrading ? `Ускоряю улучшение ${nm}` : `Ускоряю производство: ${nm}`); break;
    case 'enh':
      obj.assistBP += u.spec.bp;
      u.beam = { x: obj.x, y: obj.y, kind: 'build', ok: true, size: 3, unit: obj };
      say(u, g, 'assist', `Помогаю командиру: ${ENH[w.key].name} ${Math.round((obj.enhProg[w.key] || 0) * 100)}%`); break;
    case 'reclaim': reclaimTick(u, g, obj); say(u, g, 'reclaim', 'Помогаю перерабатывать'); break;
    case 'repair': repairTick(u, g, obj); say(u, g, 'repair', `Чиню ${nm}: ${Math.round(obj.hp / obj.maxHp * 100)}%`); break;
  }
  return true;
}

function follow(u, g, t, text) {
  const a = (u.id * 2.39996) % (Math.PI * 2);
  const r = (t.spec.size ? t.spec.size / 2 : t.spec.radius) + u.spec.radius + 6;
  const gx = t.x + Math.cos(a) * r, gy = t.y + Math.sin(a) * r;
  if (hyp(u.x - gx, u.y - gy) > 4) mv(u, gx, gy, 2, t.kind === 'unit' && t.speed > 0.5 ? Math.min(1, t.spec.speed / u.spec.speed + 0.3) : 1);
  if (chat(u, g, 'guard')) say(u, g, 'guard', text);
}

const H = {
  move(u, g, o) {
    const air = u.spec.move === 'air';
    mv(u, o.x, o.y, air ? 6 : 1.2, air ? 1 : fgMul(u, g, o));
    fireAtBest(u, g);
    const d = hyp(u.x - o.x, u.y - o.y);
    if (!o.t0) o.t0 = g.time;
    if (chat(u, g, 'move')) say(u, g, 'move', `Выдвигаюсь в точку (${Math.round(d)} м)`);
    return d < (air ? 12 : 2.2) || (d < 12 && u.speed < 0.3 && g.time - o.t0 > 2) || (!air && d < 30 && u.stuck > 2);
  },
  amove(u, g, o) {
    const b = u.brain;
    if (b.best && dist(u, b.best) < Math.max(u.spec.vision, u.spec.maxRange + 10)) { engage(u, g, b.best); return false; }
    const air = u.spec.move === 'air';
    mv(u, o.x, o.y, air ? 6 : 1.5, air ? 1 : fgMul(u, g, o));
    const d = hyp(u.x - o.x, u.y - o.y);
    if (chat(u, g, 'amove')) say(u, g, 'amove', `Атака с ходу: продвигаюсь, ищу цели (${Math.round(d)} м)`);
    return d < (air ? 14 : 3) || (d < 14 && u.speed < 0.3);
  },
  attack(u, g, o) {
    const t = o.target;
    if (!t || !t.alive) return true;
    if (!g.visibleTo(u.team, t) && !t.rad[u.team]) {
      mv(u, o.lx, o.ly, 3);
      say(u, g, 'hunt', 'Цель скрылась — иду к последней известной позиции');
      return hyp(u.x - o.lx, u.y - o.ly) < 8;
    }
    o.lx = t.x; o.ly = t.y;
    if (!engage(u, g, t, true)) return true;
    return false;
  },
  patrol(u, g, o) {
    const b = u.brain;
    if (b.best && dist(u, b.best) < Math.max(u.spec.vision, u.spec.maxRange + 10)) { engage(u, g, b.best); return false; }
    const p = o.pts[o.idx];
    mv(u, p.x, p.y, 2);
    if (hyp(u.x - p.x, u.y - p.y) < (u.spec.move === 'air' ? 14 : 4)) o.idx = (o.idx + 1) % o.pts.length;
    if (chat(u, g, 'patrol')) say(u, g, 'patrol', 'Патрулирую маршрут');
    return false;
  },
  guard(u, g, o) {
    const t = o.target, b = u.brain;
    if (!t || !t.alive || t.carried) return !t || !t.alive;
    if (u.spec.bp && t.team === u.team) { const r = helpWith(u, g, t); if (r && r !== 'fail') return false; }
    if (b.best && dist(b.best, t) < 70 && u.spec.weapons.length) { engage(u, g, b.best); return false; }
    follow(u, g, t, `Охраняю: ${t.spec.short || t.spec.name}`);
    return false;
  },
  enhance(u, g, o) {
    const E = ENH[o.key];
    if (!g.canEnhance(u, o.key).ok) return true;
    const eco = g.teams[u.team].eco;
    const bp = u.spec.bp + u.assistBP; u.assistBP = 0;
    const dp = bp * DT / E.bt, f = eco.spend(E.costM * dp, E.costE * dp);
    const p = u.enhProg[o.key] = (u.enhProg[o.key] || 0) + dp * f;
    u.beam = { x: u.x, y: u.y, kind: 'build', ok: f > 0.01, size: 4, unit: u };
    fireAtBest(u, g);
    say(u, g, 'enhance', `Устанавливаю улучшение «${E.name}»: ${Math.round(p * 100)}%`);
    if (p >= 1) { g.applyEnh(u, o.key); return true; }
    return false;
  },
  board(u, g, o) {
    const t = o.target;
    if (!t || !t.alive || !g.canCarry(t, u)) { say(u, g, 'fail', t && t.alive ? 'Транспорт заполнен' : 'Транспорт потерян'); return true; }
    const d = dist(u, t);
    // winched up from a short distance; a rider blocked by buildings under the transport gets picked up from further away
    // a ship stands off the shore: troops walk to the nearest bank and climb aboard from further away
    const ship = t.spec.move === 'naval';
    if (d < t.spec.radius + u.spec.radius + (ship ? 15 : 10) || (d < (ship ? t.spec.radius + 40 : 40) && u.stuck > 0.8)) { g.load(t, u); return true; }
    mv(u, t.x, t.y, 1);
    say(u, g, 'board', `Иду на посадку в ${t.spec.short} (${Math.round(d)} м)`);
    return false;
  },
  pickup(u, g, o) {
    const t = o.target;
    if (!t || !t.alive || t.carried || !g.canCarry(u, t)) return true;
    const d = dist(u, t), ship = u.spec.move === 'naval';
    mv(u, t.x, t.y, 2);
    if (d < 14) u.landing = true;
    if (d < (ship ? u.spec.radius + t.spec.radius + 15 : 6)) { g.load(u, t); return true; }
    say(u, g, 'pickup', `Лечу забрать ${t.spec.short || t.spec.name}`);
    return false;
  },
  unload(u, g, o) {
    if (!u.cargo.length) return true;
    const d = hyp(u.x - o.x, u.y - o.y);
    mv(u, o.x, o.y, 2);
    if (u.spec.move === 'naval') {   // sail as far as the water goes, then land the troops on the bank
      say(u, g, 'unload', `Иду к берегу на высадку: ${u.cargo.length} ед., ${Math.round(d)} м`);
      const nv = u.nav, stopped = nv && nv.hold && nv.partial;
      if (d < u.spec.radius + 25 || stopped || u.stuck > 1.5) {
        if (g.unloadAll(u, o.x, o.y)) return !u.cargo.length;
        if (d < 5 || stopped || u.stuck > 3) { say(u, g, 'fail', 'Негде высадиться — у борта нет суши'); return true; }
      }
      return false;
    }
    if (d < 16) u.landing = true;
    say(u, g, 'unload', `Лечу на высадку: ${u.cargo.length} ед., ${Math.round(d)} м`);
    if (d < 5 && u.z < 8) {
      if (!g.unloadAll(u, o.x, o.y)) { say(u, g, 'fail', 'Негде высадиться — нужна суша'); return true; }
      return !u.cargo.length;
    }
    return false;
  },
  build(u, g, o) {
    const S = STRUCTS[o.key];
    if (!o.site || !o.site.alive) {
      o.site = g.structs.find(st => st.alive && st.team === u.team && st.key === o.key && !st.built && Math.abs(st.x - o.x) < 1.5 && Math.abs(st.y - o.y) < 1.5) || null;
    }
    if (o.site && o.site.built) return true;
    if (!o.t0) o.t0 = g.time;
    if (!o.site && g.time - o.t0 > 80) { say(u, g, 'fail', `Не удалось добраться до стройки: ${S.name}`); return true; }
    const r = toReach(u, g, o.site || { kind: 'struct', x: o.x, y: o.y, spec: { size: S.size } }, 'build', `Иду строить: ${S.name}`, o.site || 'b' + o.x + ',' + o.y);
    if (r === 'fail') { say(u, g, 'fail', `Не могу подойти к стройке: ${S.name}`); return true; }
    if (!r) return false;
    if (!o.site) {
      const c = g.canPlace(u.team, o.key, o.x, o.y);
      if (!c.ok) { say(u, g, 'fail', `Не могу построить ${S.name}: ${c.why}`); return true; }
      o.site = g.placeStructure(u.team, o.key, c.x, c.y, false);
    }
    buildTick(u, g, o.site);
    say(u, g, 'build', `Строю ${S.name}: ${Math.round(o.site.progress * 100)}%`);
    return o.site.built;
  },
  assist(u, g, o) {
    const t = o.target;
    if (!t || !t.alive) return true;
    if (o.site0 === undefined) o.site0 = t.kind === 'struct' && !t.built; // assisting a construction ends when it's done
    if (o.site0 && t.built) return true;
    const hr = helpWith(u, g, t);
    if (hr === 'fail') return true;
    if (hr) return false;
    if (o.auto) return true;
    follow(u, g, t, `Жду работы у ${t.spec.short || t.spec.name}`);
    return false;
  },
  repair(u, g, o) {
    const t = o.target;
    if (!t || !t.alive || t.hp >= t.maxHp) return true;
    const r = toReach(u, g, t, 'repair', `Иду чинить: ${t.spec.name}`);
    if (r === 'fail') return true;
    if (!r) return false;
    repairTick(u, g, t);
    say(u, g, 'repair', `Чиню ${t.spec.name}: ${Math.round(t.hp / t.maxHp * 100)}%`);
    return t.hp >= t.maxHp;
  },
  reclaim(u, g, o) {
    const t = o.target;
    if (!t || !t.alive) return true;
    const ent = t.kind === 'unit' || t.kind === 'struct';
    const nm = ent ? (t.spec.short || t.spec.name) : '';
    const foe = ent && g.isEnemy(t.team, u.team);
    if (ent) {
      const c = g.canReclaim(t);
      if (!c.ok) { say(u, g, 'fail', c.why); return true; }
      // lost sight of a hostile target for a few seconds: give up
      o.lost = foe && !g.seenBy(u.team, t) ? (o.lost || 0) + DT : 0;
      if (o.lost > 4) { say(u, g, 'fail', `Цель скрылась: ${nm} — переработка отменена`); return true; }
      // chasing a fleeing enemy unit: give up after a while
      if (foe && t.kind === 'unit' && t.speed > 0.5) {
        o.chase = edgeDist(u.x, u.y, t) > rangeOf(u) ? (o.chase || 0) + DT : 0;
        if (o.chase > 30) { say(u, g, 'fail', `Не догнать ${nm} — отбой`); return true; }
      }
    }
    const r = toReach(u, g, t, 'reclaim', ent ? `Иду перерабатывать ${nm}${foe ? ' врага' : ''}` : 'Иду разбирать ресурсы');
    if (r === 'fail') return true;
    if (!r) return false;
    const done = reclaimTick(u, g, t);
    if (ent) say(u, g, 'reclaim', `Перерабатываю ${nm}${foe ? ' врага' : ''}: ${reclaimPct(t)}%`);
    else say(u, g, 'reclaim', `Перерабатываю: осталось ${Math.round(t.mass || t.energy)} ${t.mass > 0 ? 'массы' : 'энергии'}`);
    return done;
  },
  retreatTo(u, g, o) {
    mv(u, o.x, o.y, 4);
    fireAtBest(u, g);
    say(u, g, 'retreat', 'Отход по приказу командования');
    return hyp(u.x - o.x, u.y - o.y) < 8;
  }
};
