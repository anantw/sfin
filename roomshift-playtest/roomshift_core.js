/* ROOMSHIFT physics core — LOCKED (see PHYSICS_VERSION). Shared by the iOS app (JavaScriptCore), web build, server replay check and tests. */
// Pure simulation: no DOM, fixed 120 Hz step, seeded RNG, fixed logical playfield (390 x 620 units on every device).
const RS = (() => {
  const PHYSICS_VERSION = '1.0.0'; // LOCKED. Any change here must bump this and update golden.json.
  const FW = 390, FH = 620, STEP = 1 / 120, RUN = 30;
  // Exact math only: + - * / and Math.sqrt are bit-identical in every engine (JavaScriptCore, V8, Swift).
  // Transcendentals (exp, cos, sin, hypot) are replaced by precomputed literals.
  const hyp = (x, y) => Math.sqrt(x * x + y * y);
  const SPEED_DECAY = 0.98757780049388144;      // Math.exp(-1.5 * STEP)
  const START_DIR_X = 0.78999223149736508, START_DIR_Y = -0.61311685197343380; // cos/sin(-0.66)
  const REST = [{ x: 52, y: 78 }, { x: 338, y: 92 }, { x: 328, y: 538 }, { x: 46, y: 552 }]; // clockwise on screen
  const K = 170, DAMP = 15;            // corner spring: ~0.4 s return with slight overshoot
  const WALL_CAP = 620;                // softened moving-wall influence for more readable bounces
  const WALL_TRANSFER = 0.45;          // only part of wall velocity is imparted to the orb
  const CHAIN_WIN = 2.8, RUSH = 5, AREA_FLOOR = 0.35, HITSTOP = 0.03, BONUS_LIFE = 4.5, STAR_COUNT = 5;
  const TIERS = {
    gold:   { value: 1, color: '#ffd57b', r: 7, ext: 0 },
    blue:   { value: 2, color: '#72c9ff', r: 8, ext: 1 },
    purple: { value: 3, color: '#c6a0ff', r: 8, ext: 2 },
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dist = (a, b) => hyp(a.x - b.x, a.y - b.y);
  function rng32(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function area(P) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p.x * q.y - q.x * p.y; } return Math.abs(a / 2); }
  function centroid(P) { return P.reduce((o, p) => ({ x: o.x + p.x / P.length, y: o.y + p.y / P.length }), { x: 0, y: 0 }); }
  // Largest signed distance from pt to any edge line (positive = outside the convex room).
  function maxSigned(P, pt) {
    let m = -Infinity;
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4], ex = b.x - a.x, ey = b.y - a.y, l = hyp(ex, ey) || 1;
      m = Math.max(m, (pt.x - a.x) * (ey / l) + (pt.y - a.y) * (-ex / l));
    }
    return m;
  }
  const inside = (P, pt) => maxSigned(P, pt) <= 0;
  const REST_AREA = area(REST), COS_MIN_ANGLE = 0.88294759285892699; // cos(28 deg)
  // Room validity: in bounds, strictly convex, no edge shorter than 56, no corner sharper than 28 deg, area >= 35% of rest.
  function validPoly(P) {
    for (const p of P) if (p.x < 8 || p.x > FW - 8 || p.y < 8 || p.y > FH - 8) return false;
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4], c = P[(i + 2) % 4];
      const e1x = b.x - a.x, e1y = b.y - a.y, e2x = c.x - b.x, e2y = c.y - b.y;
      const l1 = hyp(e1x, e1y), l2 = hyp(e2x, e2y);
      if (l1 < 56) return false;
      if ((e1x * e2y - e1y * e2x) / (l1 * l2) < 0.03) return false;
      const cosB = ((a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y)) / (l1 * l2);
      if (cosB > COS_MIN_ANGLE) return false;
    }
    return area(P) >= REST_AREA * AREA_FLOOR;
  }
  const baseSpeed = collected => Math.min(0.65, 0.35 + collected * 0.009) * FW;
  function rollTier(s) { const r = s.rnd(); return r < 0.70 ? 'gold' : r < 0.94 ? 'blue' : 'purple'; }
  function spawn(s, tier, prev) {
    const spec = TIERS[tier], bonus = tier !== 'gold';
    let best = null, bm = -Infinity;
    for (let n = 0; n < 900; n++) {
      const q = { x: FW * (0.06 + s.rnd() * 0.88), y: FH * (0.06 + s.rnd() * 0.88) };
      const sd = maxSigned(REST, q);
      // Keep every collectible comfortably inside the resting room.
      if (sd > -34) continue;
      const bD = dist(q, s.ball); if (bD < 40) continue;
      const oD = s.stars.length ? Math.min(...s.stars.map(t => dist(t, q))) : 1e6;
      const pD = prev ? dist(q, prev) : 1e6;
      const m = Math.min(bD / 130, oD / 55, pD / 60);
      if (m > bm) { bm = m; best = q; }
      if (m >= 1) break;
    }
    const p = best || { x: FW * 0.5, y: FH * 0.3 };
    return { x: p.x, y: p.y, tier, value: spec.value, r: spec.r, color: spec.color, bonus, outside: false,
             life: bonus ? BONUS_LIFE : Infinity, maxLife: BONUS_LIFE, phase: s.rnd() * Math.PI * 2, id: s.nextId++ };
  }
  function create(seed) {
    const s = {
      seed, rnd: rng32(seed), nextId: 1, t: 0, timeLeft: RUN, over: false,
      score: 0, collected: 0, chain: 0, bestChain: 0, lastHit: -99, extended: 0, slings: 0, hitstop: 0, boosted: false,
      corners: REST.map(p => ({ x: p.x, y: p.y, vx: 0, vy: 0 })), grab: -1,
      ball: { x: FW * 0.49, y: FH * 0.5, vx: 0, vy: 0, r: 7 }, stars: [], events: [], timeline: [0],
    };
    const v0 = baseSpeed(0); s.ball.vx = START_DIR_X * v0; s.ball.vy = START_DIR_Y * v0;
    for (let i = 0; i < STAR_COUNT; i++) s.stars.push(spawn(s, i < 3 ? 'gold' : rollTier(s)));
    return s;
  }
  function moveCorners(s, input) {
    const C = s.corners;
    for (let i = 0; i < 4; i++) {
      const c = C[i], ox = c.x, oy = c.y, grabbed = i === s.grab;
      let nx, ny;
      if (grabbed) {
        const tx = clamp(input.tx, 8, FW - 8), ty = clamp(input.ty, 8, FH - 8);
        nx = c.x + (tx - c.x) * 0.5; ny = c.y + (ty - c.y) * 0.5;
      } else {
        const dx = REST[i].x - c.x, dy = REST[i].y - c.y;
        if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05 && hyp(c.vx, c.vy) < 0.5) {
          // Snap home only if that keeps the room valid; otherwise let the spring step below handle it.
          const P0 = C.map(p => ({ x: p.x, y: p.y })); P0[i] = { x: REST[i].x, y: REST[i].y };
          if (validPoly(P0)) { c.x = REST[i].x; c.y = REST[i].y; c.vx = c.vy = 0; continue; }
        }
        c.vx += (K * dx - DAMP * c.vx) * STEP; c.vy += (K * dy - DAMP * c.vy) * STEP;
        nx = c.x + c.vx * STEP; ny = c.y + c.vy * STEP;
      }
      const P = C.map(p => ({ x: p.x, y: p.y }));
      const tryAt = t => { P[i].x = ox + (nx - ox) * t; P[i].y = oy + (ny - oy) * t; return validPoly(P); };
      let t = 1;
      if (!tryAt(1)) { let lo = 0, hi = 1; for (let k = 0; k < 12; k++) { const mid = (lo + hi) / 2; if (tryAt(mid)) lo = mid; else hi = mid; } t = lo; }
      c.x = ox + (nx - ox) * t; c.y = oy + (ny - oy) * t;
      const rvx = (c.x - ox) / STEP, rvy = (c.y - oy) / STEP;
      if (grabbed) { c.vx = c.vx * 0.4 + rvx * 0.6; c.vy = c.vy * 0.4 + rvy * 0.6; }
      else if (t < 1) { c.vx = rvx; c.vy = rvy; }
    }
  }
  function moveBall(s) {
    const b = s.ball, C = s.corners;
    b.x += b.vx * STEP; b.y += b.vy * STEP;
    let hit = false, push = 0, hx = 0, hy = 0;
    // Project the orb back inside every edge half-plane. Works even when a fast wall sweeps past the orb in one step.
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < 4; i++) {
        const a = C[i], c = C[(i + 1) % 4], ex = c.x - a.x, ey = c.y - a.y, len = hyp(ex, ey) || 1;
        const nx = ey / len, ny = -ex / len, sd = (b.x - a.x) * nx + (b.y - a.y) * ny;
        if (sd > -b.r) {
          const u = clamp(((b.x - a.x) * ex + (b.y - a.y) * ey) / (len * len), 0, 1);
          let wvx = (a.vx + (c.vx - a.vx) * u) * WALL_TRANSFER, wvy = (a.vy + (c.vy - a.vy) * u) * WALL_TRANSFER;
          const ws = hyp(wvx, wvy); if (ws > WALL_CAP) { wvx *= WALL_CAP / ws; wvy *= WALL_CAP / ws; }
          b.x -= nx * (sd + b.r + 0.01); b.y -= ny * (sd + b.r + 0.01);
          const rn = (b.vx - wvx) * nx + (b.vy - wvy) * ny;
          if (rn > 0) {
            b.vx -= 2 * rn * nx; b.vy -= 2 * rn * ny; hit = true; hx = b.x + nx * b.r; hy = b.y + ny * b.r;
            push = Math.max(push, -(wvx * nx + wvy * ny));
          }
        }
      }
    }
    if (!inside(C, b)) { const c = centroid(C); b.x = c.x; b.y = c.y; } // last-resort safety, should never trigger
    const target = baseSpeed(s.collected);
    let sp = hyp(b.vx, b.vy); if (sp < 1e-6) { b.vx = target; b.vy = 0; sp = target; }
    let ns = sp < target ? target : target + (sp - target) * SPEED_DECAY;
    ns = Math.min(ns, target * 2.0);
    b.vx *= ns / sp; b.vy *= ns / sp;
    s.boosted = ns > target * 1.3;
    if (hit) {
      if (push > 60 && s.boosted) s.events.push({ type: 'sling', x: hx, y: hy, power: ns / target });
      else s.events.push({ type: 'bounce', x: hx, y: hy, speed: ns });
    }
  }
  function collect(s) {
    const b = s.ball;
    for (let i = s.stars.length - 1; i >= 0; i--) {
      const st = s.stars[i];
      if (dist(b, st) >= b.r + st.r + 4) continue;
      s.chain = s.t - s.lastHit < CHAIN_WIN ? s.chain + 1 : 1; s.lastHit = s.t; s.bestChain = Math.max(s.bestChain, s.chain);
      const mult = Math.min(4, 1 + Math.floor((s.chain - 1) / 3)), rush = s.timeLeft <= RUSH ? 2 : 1, sling = s.boosted;
      const pts = st.value * (sling ? 2 : 1) * mult * rush;
      s.score += pts; s.collected++; if (sling) s.slings++;
      let ext = 0;
      if (st.bonus) { const before = s.timeLeft; s.timeLeft = Math.min(RUN, s.timeLeft + TIERS[st.tier].ext); ext = s.timeLeft - before; s.extended += ext; }
      s.hitstop = HITSTOP;
      s.events.push({ type: 'star', x: st.x, y: st.y, tier: st.tier, color: st.color, pts, mult, rush, sling, ext, chain: s.chain });
      s.stars.splice(i, 1); s.stars.push(spawn(s, rollTier(s), st));
    }
  }
  function step(s, input) {
    if (s.over) return;
    if (s.hitstop > 0) { s.hitstop -= STEP; return; }
    s.t += STEP; s.timeLeft -= STEP;
    if (input.grab !== s.grab) { if (s.grab >= 0) s.events.push({ type: 'release', i: s.grab }); s.grab = input.grab; }
    moveCorners(s, input);
    moveBall(s);
    collect(s);
    if (s.chain > 0 && s.t - s.lastHit >= CHAIN_WIN) { s.chain = 0; s.events.push({ type: 'chainEnd' }); }
    for (let i = s.stars.length - 1; i >= 0; i--) {
      const st = s.stars[i];
      if (st.bonus && (st.life -= STEP) <= 0) { s.events.push({ type: 'expire', x: st.x, y: st.y, color: st.color }); s.stars.splice(i, 1); s.stars.push(spawn(s, rollTier(s), st)); }
    }
    while (s.timeline.length <= Math.floor(s.t)) s.timeline.push(s.score);
    if (s.timeLeft <= 0) { s.timeLeft = 0; s.over = true; s.events.push({ type: 'end' }); }
  }
  return { PHYSICS_VERSION, FW, FH, STEP, RUN, REST, TIERS, CHAIN_WIN, RUSH, create, step, inside, validPoly, baseSpeed };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = RS;
if (typeof globalThis !== 'undefined') globalThis.RS = RS;
