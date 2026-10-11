// Ground-unit navigation "reflexes": waypoint following over the clearance-class flow fields (terrain.js),
// local avoidance with forward feelers, progress-based stuck detection and a multi-stage recovery ladder.
// State lives in u.nav (runtime only, not saved); u.nav.state / u.nav.msg are exposed for the unit's "thought".
//
// Recovery ladder (stage 1..5), each step tried when the unit made no progress towards the goal:
//   1 back    reverse a little while turning away;      2 side     detour via a lateral probe point;
//   3 repath  recompute the route with the stuck cell banned;   4 free  drive to the nearest free cell nearby;
//   5 giveup  drop the move order and say so.
import { DT } from './specs.js';
import { PN, PCELL, clearanceClass } from './terrain.js';

const hyp = (x, y) => Math.sqrt(x * x + y * y);

const MSG = {
  wait: 'Ищу путь — жду расчёта маршрута',
  avoid: 'Объезжаю препятствие на пути',
  back: 'Застрял — сдаю назад',
  side: 'Застрял — объезжаю препятствие сбоку',
  repath: 'Застрял — пересчитываю маршрут',
  free: 'Застрял — выбираюсь на свободное место',
  giveup: 'Путь заблокирован — отменяю приказ движения',
  crowd: 'Место занято своими — останавливаюсь рядом',
  partial: 'Цель недостижима — встал у ближайшей доступной точки',
  lost: 'Зажат в тупике — ищу выход'
};

export function createNav(u) {
  return {
    cls: clearanceClass(u.spec.radius), state: 'ok', msg: null, msgUntil: 0,
    hx: u.x, hy: u.y, has: false, st: 'direct', pd: Infinity, gx: NaN, gy: NaN, wpT: -99, partial: false,
    best: Infinity, bestT: 0, esc: Infinity, stage: 0, blockT: 0, lx: u.x, ly: u.y, lt: 0, turning: false,
    mode: 'go', modeUntil: 0, mx: 0, my: 0, rev: false, turn: 0, hold: false, slow: 1,
    ban: null, side: 1, delta: 0, dT: -99, lostT: 0, crowd: 0, turnT: 0, dCache: 0, sCache: 1, wx: u.x, wy: u.y, wt: 0
  };
}

// Cancel the current move order because it can't be finished; the unit stays where it is and says why.
function dropOrder(g, u, msgKey) {
  const b = u.brain;
  u.orders.shift(); b.run = null;
  if (!u.orders.length) b.home = { x: u.x, y: u.y };      // otherwise the idle brain drives back to the old "home"
  b.thought = MSG[msgKey]; b.state = 'nav-' + msgKey;
  b.log.unshift({ t: g.time, text: MSG[msgKey] }); if (b.log.length > 7) b.log.pop();
}
const isMove = (o, mt) => o && (o.type === 'move' || o.type === 'amove') && Math.abs(o.x - mt.x) < 1 && Math.abs(o.y - mt.y) < 1;

function tell(nv, g, state, dur = 1.2) { nv.state = state; nv.msg = MSG[state] || null; nv.msgUntil = g.time + dur; }

// Called when the unit has nothing to walk to: forget progress tracking.
export function idle(u) {
  const nv = u.nav;
  if (!nv.has && nv.best === Infinity && nv.mode === 'go') return;
  nv.crowd = 0; nv.best = Infinity; nv.stage = 0; nv.blockT = 0; nv.has = false; nv.mode = 'go'; nv.ban = null; nv.esc = Infinity; nv.partial = false; nv.lostT = 0;
  nv.lt = 0;
}

// Plan this tick's movement: sets nv.hx/hy (point to head for), nv.delta (avoidance offset), nv.rev, nv.slow, nv.hold.
export function plan(g, u, mt, d) {
  const nv = u.nav, s = u.spec, t = g.terrain, domain = s.move, now = g.time;
  nv.hold = false; nv.rev = false; nv.slow = 1; nv.delta = 0;
  if (now >= nv.msgUntil) { nv.state = 'ok'; nv.msg = null; }

  // ---- active manoeuvre (back / side / free)
  if (nv.mode !== 'go' && nv.mode !== 'repath') {
    const done = now >= nv.modeUntil || (nv.mode !== 'back' && hyp(nv.mx - u.x, nv.my - u.y) < 3.5);
    if (done) { nv.mode = 'go'; nv.blockT = 0; nv.lt = 0; nv.bestT = now; nv.wt = 0; }
    else {
      if (nv.mode === 'back') { nv.rev = true; nv.turn = nv.side * 0.7; nv.slow = 0.6; nv.hx = u.x; nv.hy = u.y; }
      else { nv.hx = nv.mx; nv.hy = nv.my; avoid(g, u, mt, d); }
      return;
    }
  }
  if (nv.mode === 'repath' && now >= nv.modeUntil) { nv.mode = 'go'; nv.ban = null; }

  // ---- (re)compute the waypoint
  const moved = Math.abs(nv.gx - mt.x) > 3 || Math.abs(nv.gy - mt.y) > 3;
  if (!nv.has || moved || (g.tick + u.id) % 6 === 0 || hyp(nv.hx - u.x, nv.hy - u.y) < PCELL * 0.5) {
    nv.gx = mt.x; nv.gy = mt.y;
    const R = t.steer(domain, nv.cls, u.x, u.y, mt.x, mt.y, nv.mode === 'repath' ? nv.ban : null);
    if (R.st === 'wait') {
      // no field yet (time budget): keep the previous waypoint for a while instead of driving into the wall
      if (!nv.has || now - nv.wpT > 4) { nv.hold = true; nv.bestT = now; tell(nv, g, 'wait'); return; }
    } else if (R.st === 'lost') {
      nv.wpT = now; nv.has = true; nv.hx = u.x; nv.hy = u.y; nv.st = 'lost'; nv.pd = Infinity;
      nv.lostT += 0.2; tell(nv, g, 'lost', 1.5);
    } else {
      nv.hx = R.x; nv.hy = R.y; nv.st = R.st; nv.pd = R.d; nv.partial = R.partial; nv.has = true; nv.wpT = now; nv.lostT = 0;
    }
  }

  // ---- goal in a pathing cell that only a building's rounded-up edge blocks: finish straight to the exact point
  if (nv.st !== 'direct' && nv.st !== 'lost' && d < PCELL * 2.5 && !t.passableAt(domain, mt.x, mt.y) && t.terrainPass(domain, mt.x, mt.y)) {
    let clear = true;
    for (let k = 1; k <= 4 && clear; k++) clear = g.walkable(domain, u.x + (mt.x - u.x) * k / 4, u.y + (mt.y - u.y) * k / 4);
    if (clear) { nv.hx = mt.x; nv.hy = mt.y; nv.st = 'direct'; nv.pd = d; nv.partial = false; }
  }

  // ---- unreachable goal: stand at the nearest reachable point
  if (nv.partial && nv.st !== 'lost' && nv.pd <= PCELL * 1.3 && hyp(nv.hx - u.x, nv.hy - u.y) < PCELL) {
    nv.hold = true; nv.bestT = now; tell(nv, g, 'partial', 2);
    if (d > 30 && isMove(u.orders[0], mt)) dropOrder(g, u, 'partial');
    return;
  }

  // ---- progress tracking
  const measure = isFinite(nv.pd) && nv.st !== 'direct' ? nv.pd : d;
  if (measure < nv.best - 6) { nv.best = measure; nv.bestT = now; if (nv.stage && measure < nv.esc - 16) { nv.stage = 0; nv.state = 'ok'; } }
  else if (nv.best === Infinity) { nv.best = measure; nv.bestT = now; }
  if (nv.lt === 0) { nv.lt = now; nv.lx = u.x; nv.ly = u.y; }
  else if (now - nv.lt >= 0.5) {
    const disp = hyp(u.x - nv.lx, u.y - nv.ly);
    if (!nv.turning && disp < s.speed * (mt.speedMul || 1) * 0.5 * 0.16) nv.blockT += 0.5; else nv.blockT = Math.max(0, nv.blockT - 0.5);
    nv.lt = now; nv.lx = u.x; nv.ly = u.y;
  }
  // wandering: no progress towards the goal AND no real displacement over a 4 s window (chasing a moving target is not stuck)
  let wander = false;
  if (!nv.wt) { nv.wt = now; nv.wx = u.x; nv.wy = u.y; nv.turnT = 0; }
  else {
    if (nv.turning) nv.turnT += DT;
    if (now - nv.wt >= 4) {
      // a slow turn on the spot (heavy units) is not wandering, endless jitter is
      wander = hyp(u.x - nv.wx, u.y - nv.wy) < 5 && nv.bestT < nv.wt + 0.01 && nv.turnT < 2.5;
      nv.wt = now; nv.wx = u.x; nv.wy = u.y; nv.turnT = 0;
    }
  }
  // the spot is taken: idle friends around the destination block the way -> stop next to them like a player would
  if (nv.crowd > 1.4 && d < 70) {
    if (isMove(u.orders[0], mt)) { dropOrder(g, u, 'crowd'); nv.crowd = 0; return; }
  }
  const nearGoal = d < Math.max(14, s.radius * 3 + 6);
  if (!nearGoal && (nv.blockT >= 1.5 || wander || nv.lostT >= 1)) escalate(g, u, mt, d);
  if (nv.mode !== 'go' && nv.mode !== 'repath') return plan(g, u, mt, d);

  // ---- local avoidance
  avoid(g, u, mt, d);
}

// Obstacles found by the last avoid() scan (module scratch: no per-call allocations, no closures).
const OBST = []; let NO = 0;

// 0 = free, 1 = static terrain blocks the feeler, 2 = an obstacle unit / structure does.
function blockedAt(g, domain, u, a, psi, wd, L, r) {
  const dx = Math.cos(a), dy = Math.sin(a);
  for (let k = 1; k <= 2; k++) {
    const px = u.x + dx * L * k / 2, py = u.y + dy * L * k / 2;
    // straight towards the waypoint the route already guarantees free ground (line of sight on the class grid)
    // (feelers look at the physical grid, class 0: the class-eroded route already keeps big bodies off the walls)
    if ((a !== psi || L * k / 2 > wd + 0.01) && !g.walkable(domain, px, py)) return 1;
    for (let i = 0; i < NO; i++) {
      const o = OBST[i];
      if (o.kind === 'unit') { const rr = r + o.spec.radius + 0.8, ddx = px - o.x, ddy = py - o.y; if (ddx * ddx + ddy * ddy < rr * rr) return 2; }
      else { const rr = o.spec.size / 2 + r * 0.7; if (Math.abs(px - o.x) < rr && Math.abs(py - o.y) < rr) return 2; }
    }
  }
  return 0;
}

// Forward feelers: steer around stationary units / blocked cells ahead. Result in nv.delta (radians) and nv.slow.
function avoid(g, u, mt, d) {
  const nv = u.nav, s = u.spec, t = g.terrain, now = g.time;
  const psi = Math.atan2(nv.hy - u.y, nv.hx - u.x);
  if (now - nv.dT < 0.1 && nv.mode === 'go') { nv.delta = nv.dCache; nv.slow = nv.sCache; return; }
  nv.dT = now;
  const r = s.radius, L = r + 3 + Math.min(12, u.speed * 0.9) + (s.speed > 8 ? 3 : 0);
  NO = 0;
  const H = g.hash, ux = u.x, uy = u.y, Rq = L + 9;
  const nr = H.rows(ux, uy, Rq + H.maxR), rk = H.rk, items = H.items, xs = H.xs, ys = H.ys, rs = H.rs, fl = H.fl, sp = H.sp;
  const slowMin = s.speed * 0.6;
  for (let q = 0; q < nr; q++) {
    for (let k = rk[2 * q], k1 = rk[2 * q + 1]; k < k1; k++) {
      const f = fl[k];
      if (f & 36) continue;                                              // dead (32) / air (4)
      if ((f & 16) && sp[k] >= slowMin) continue;                        // moving neighbours clear out on their own
      const qx = xs[k] - ux, qy = ys[k] - uy, rq = Rq + rs[k];
      if (qx * qx + qy * qy > rq * rq) continue;
      const o = items[k];
      if (o === u || !o.alive || o.carried) continue;
      if (o.kind === 'unit') {
        if (o.spec.move === 'air') continue;
        if (o.speed > 0.6 && o.spec.speed >= s.speed * 0.6) continue;         // moving neighbours clear out on their own
        if (g.layerOf(o) !== g.layerOf(u)) continue;
        if (hyp(o.x - mt.x, o.y - mt.y) < r + o.spec.radius + 8) continue;    // our destination / target
      } else if (hyp(o.x - mt.x, o.y - mt.y) < o.spec.size * 0.7 + r + 6) continue;
      OBST[NO++] = o;
    }
  }
  const domain = s.move;
  const wd = hyp(nv.hx - ux, nv.hy - uy);
  let delta = 0, slow = 1;
  const b0 = blockedAt(g, domain, u, psi, psi, wd, L, r);
  if (b0) {
    const first = nv.side;
    let found = false;
    search: for (let i = 0; i < 4; i++) {
      const a = i === 0 ? 0.55 : i === 1 ? 1.0 : i === 2 ? 1.5 : 2.0;
      for (let j = 0; j < 2; j++) {
        const sg = j === 0 ? first : -first;
        if (!blockedAt(g, domain, u, psi + a * sg, psi, wd, L, r)) { delta = a * sg; nv.side = sg; found = true; break search; }
      }
    }
    if (found) { slow = 0.75; if (b0 === 2 && nv.state === 'ok') tell(nv, g, 'avoid', 0.6); }
    else { slow = 0.4; }
    if (b0 === 2 && u.speed < s.speed * 0.4) nv.crowd += 0.07;
  } else nv.crowd = Math.max(0, nv.crowd - 0.14);
  nv.dCache = delta; nv.sCache = slow; nv.delta = delta; nv.slow = slow;
  NO = 0;
}

function escalate(g, u, mt, d) {
  const nv = u.nav, s = u.spec, t = g.terrain, now = g.time;
  nv.stage++; nv.blockT = 0; nv.bestT = now; nv.esc = nv.best === Infinity ? d : nv.best; nv.lt = 0;
  // remember which way round we tried
  nv.side = -nv.side;
  const yaw = u.yaw, fx = Math.cos(yaw), fy = Math.sin(yaw);
  const stage = nv.stage;
  if (globalThis.NAVDBG) {
    const near = g.units.filter(o => o !== u && hyp(o.x - u.x, o.y - u.y) < 45).map(o => `${o.key}#${o.id}(${o.x.toFixed(0)},${o.y.toFixed(0)} sp${o.speed.toFixed(1)}${o.moveTarget ? 'M' : 'i'})`).join(' ');
    console.log(`[nav] t=${now.toFixed(1)} ${u.key}#${u.id} stage ${stage} at (${u.x.toFixed(0)},${u.y.toFixed(0)}) d=${d.toFixed(0)} pd=${nv.pd.toFixed(0)} block=${nv.blockT} near: ${near}`);
  }
  if (stage === 1) {
    nv.mode = 'back'; nv.modeUntil = now + 0.5 + s.radius * 0.08; u.speed = 0; tell(nv, g, 'back', nv.modeUntil - now + 1);
  } else if (stage === 2 || stage === 4) {
    // lateral probe: first side (then the other) that is walkable with a clear line
    const ahead = stage === 2 ? s.radius * 2 : s.radius * 3, lat = s.radius * 2.5 + (stage === 2 ? 14 : 26);
    let best = null;
    for (const sg of [nv.side, -nv.side]) {
      for (const k of [1, 0.6, 1.6]) {
        const px = u.x - fy * sg * lat * k + fx * ahead, py = u.y + fx * sg * lat * k + fy * ahead;
        if (t.passableAtC(s.move, px, py, 0) && t.lineClear(s.move, u.x, u.y, px, py, 0)) { best = [px, py, sg]; break; }
      }
      if (best) break;
    }
    if (stage === 4 && !t.passableAt(s.move, u.x, u.y)) {
      // caught on a blocked cell (structures around us): head for the nearest walkable cell
      const [cx, cy] = t.nearestPassable(s.move, ...t.cell(u.x, u.y), 0);
      best = [(cx + 0.5) * PCELL, (cy + 0.5) * PCELL, nv.side];
    }
    if (best) { nv.mx = best[0]; nv.my = best[1]; nv.side = best[2]; nv.mode = stage === 2 ? 'side' : 'free'; nv.modeUntil = now + 3; tell(nv, g, stage === 2 ? 'side' : 'free', 3.5); }
    else if (stage === 2) return escalate(g, u, mt, d);
  } else if (stage === 3) {
    // reroute with the cells around us banned; also rebuild the field (the world may have changed)
    const [cx, cy] = t.cell(u.x, u.y);
    nv.ban = new Set();
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (cx + i >= 0 && cy + j >= 0) nv.ban.add((cy + j) * PN + cx + i);
    const [ax, ay] = t.cell(u.x + fx * PCELL * 1.5, u.y + fy * PCELL * 1.5);
    nv.ban.add(ay * PN + ax);
    t.dropField(s.move, nv.cls, t.cell(mt.x, mt.y)[0], t.cell(mt.x, mt.y)[1]);
    nv.mode = 'repath'; nv.modeUntil = now + 3; nv.has = false; tell(nv, g, 'repath', 3.5);
  } else {
    // nothing helped
    if (isMove(u.orders[0], mt)) { dropOrder(g, u, 'giveup'); tell(nv, g, 'giveup', 3); nv.stage = 0; }
    else nv.stage = 1;
  }
}
