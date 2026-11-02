/*
 * ROOMSHIFT audio engine — browser port of engine/rs_audio.c (AudioWorklet).
 * Same DSP, same constants, same voice and music logic, so what you hear in
 * the browser is what the iOS build will play. Keep the two in sync.
 *
 * Messages (main thread -> worklet), applied at the start of the next
 * 128-frame block (<= 2.7 ms jitter in the browser; the iOS kernel is
 * sample-accurate):
 *   {type:'sample', id, data:Float32Array (interleaved), frames, ch}
 *   {type:'theme', stems:[Float32Array x4] (interleaved stereo), frames}
 *   {type:'pullBegin'} {type:'pullSet', d} {type:'pullEnd'}
 *   {type:'bounce', speed} {type:'play', id, gainDb, rate}
 *   {type:'chain', level} {type:'musicStart'} {type:'musicStop'}
 *   {type:'volumes', sfx, music}
 */

const TWO_PI = Math.PI * 2;

// ---- tuning (identical to rs_audio.c) ----
const HUM_ROOT_HZ = 110, HUM_OCTAVES = 1.5, HUM_INDEX_MIN = 0.8, HUM_INDEX_RANGE = 3.0;
const HUM_DETUNE_MIN_C = 3, HUM_DETUNE_RANGE_C = 15, HUM_GAIN_COMP_DB = 2.5, HUM_LEVEL = 0.16;
const HUM_HOLD_S = 0.150;     // hum only for pulls held longer than this (fast flicks stay silent)
const HUM_ATTACK_S = 0.060, HUM_RELEASE_S = 0.020;
const HUM_TAU_PITCH_S = 0.012, HUM_TAU_BRIGHT_S = 0.020;
const CREAK_TAU_VEL_S = 0.040, CREAK_FULL_VEL = 4.0, CREAK_LEVEL = 0.55, CREAK_Q = 9.0, CREAK_BAND_RATIO = 2.5;
const TICK_MIN_GAP_S = 0.045, TICK_LEVEL = 0.27;
const CHAIN_DROP_FADE_S = 0.300, MUSIC_START_FADE_S = 0.010, MUSIC_STOP_FADE_S = 0.400;
const LIMIT_THRESHOLD = 0.841, LIMIT_RELEASE_S = 0.080;
const KILL_FADE_SEC = 0.002, TICK_SLOTS = 6, TICK_LIMIT = 4, SMP_SLOTS = 16, SMP_LIMIT = 12;
const TEMPO_BPM = 128, NUM_STEMS = 4;
const TICK_SCALE = [220.00, 261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.26];
const BAR_RATIO = [1.0, 2.756, 5.404];

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const onepole = (tau, sr) => 1 - Math.exp(-1 / (tau * sr));

class RoomshiftEngine extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    this.sr = sr;
    this.q = [];
    this.port.onmessage = (e) => this.q.push(e.data);
    this.samples = [];
    this.clock = 0;
    this.rng = 0x9e3779b9 >>> 0;

    // hum
    this.pullTarget = 0;
    this.humOn = false; this.holdLeft = 0; this.envT = 0;
    this.envUp = 1 / (HUM_ATTACK_S * sr); this.envDown = 1 / (HUM_RELEASE_S * sr);
    this.octS = 0; this.dB = 0; this.dLin = 0; this.dPrev = 0; this.velS = 0;
    this.ph1 = 0; this.ph2 = 0;
    this.aPitch = onepole(HUM_TAU_PITCH_S, sr); this.aBright = onepole(HUM_TAU_BRIGHT_S, sr);
    this.aVel = onepole(CREAK_TAU_VEL_S, sr); this.aVol = onepole(0.050, sr);
    this.creakTimer = 0; this.ic1 = 0; this.ic2 = 0; this.svfCount = 0;
    this.updateSvf(CREAK_BAND_RATIO * HUM_ROOT_HZ);

    // voices
    this.tick = Array.from({ length: TICK_SLOTS }, () => this.newTick());
    this.smp = Array.from({ length: SMP_SLOTS }, () => ({ active: false }));
    this.lastTickClock = 0; this.lastTickSpeed = 0; this.lastTickSlot = 0; this.haveLastTick = false;

    // music
    this.theme = null; this.musicOn = false; this.ph = 0;
    this.beatLen = Math.round(sr * 60 / TEMPO_BPM);
    this.stemG = [1, 0, 0, 0]; this.stemTgt = [1, 0, 0, 0]; this.stemStep = [0, 0, 0, 0];
    this.chain = 1; this.pendingChain = 0;
    this.musicEnv = 0; this.musicEnvStep = 0;

    this.volSfx = 1; this.volMusic = 1; this.sfxG = 1; this.musG = 1;
    this.limEnv = 0; this.limRel = onepole(LIMIT_RELEASE_S, sr);
  }

  frand() { let x = this.rng; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.rng = x; return (x >>> 8) / 16777216; }
  newTick() { return { active: false, killing: false, start: 0, c: [0, 0, 0], s: [0, 0, 0], wc: [0, 0, 0], ws: [0, 0, 0], amp: [0, 0, 0], dec: [0, 0, 0], level: 0, clickEnv: 0, clickDec: 0, clickAmp: 0, kill: 1, killStep: 0 }; }

  updateSvf(fc) {
    fc = clamp(fc, 40, 0.4 * this.sr);
    const g = Math.tan(Math.PI * fc / this.sr), k = 1 / CREAK_Q;
    this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }

  // ---------------- events ----------------
  apply(m) {
    switch (m.type) {
      case 'sample': this.samples[m.id] = { data: m.data, frames: m.frames, ch: m.ch }; break;
      case 'theme': this.theme = m; this.resetLayers(); if (this.musicOn) { this.musicEnv = 0; this.musicEnvStep = 1 / (MUSIC_START_FADE_S * this.sr); } break;
      case 'pullSet': this.pullTarget = clamp(m.d, 0, 1); break;
      case 'pullBegin': this.humBegin(); break;
      case 'pullEnd': this.humOn = false; break;
      case 'bounce': this.tickTrigger(clamp(m.speed, 0, 1)); break;
      case 'play': this.smpTrigger(m.id, m.gainDb || 0, m.rate || 1); break;
      case 'chain': this.musicChain(m.level); break;
      case 'musicStart': this.resetLayers(); this.musicOn = true; this.musicEnv = 0; this.musicEnvStep = 1 / (MUSIC_START_FADE_S * this.sr); break;
      case 'musicStop': this.musicOn = false; this.musicEnvStep = 1 / (MUSIC_STOP_FADE_S * this.sr); break;
      case 'volumes': this.volSfx = clamp(m.sfx, 0, 1); this.volMusic = clamp(m.music, 0, 1); break;
    }
  }

  // ---------------- hum ----------------
  humBegin() {
    const d = this.pullTarget;
    if (this.envT <= 0) { this.octS = HUM_OCTAVES * d; this.dB = d; this.dLin = d; this.dPrev = d; this.velS = 0; }
    this.humOn = true;
    this.holdLeft = Math.round(HUM_HOLD_S * this.sr);
  }

  humProcess(dt) {
    const sr = this.sr;
    if (!this.humOn) dt = this.dLin;
    if (this.humOn && this.holdLeft > 0) this.holdLeft--;
    const sounding = this.humOn && this.holdLeft === 0;   // a flick never gets past the hold
    if (sounding) { this.envT += this.envUp; if (this.envT > 1) this.envT = 1; }
    else { this.envT -= this.envDown; if (this.envT < 0) this.envT = 0; }

    // keep smoothers tracking during the hold so the hum enters at the right pitch
    this.octS += this.aPitch * (HUM_OCTAVES * dt - this.octS);
    this.dB += this.aBright * (dt - this.dB);
    this.dLin += this.aPitch * (dt - this.dLin);
    const vel = Math.abs(this.dLin - this.dPrev) * sr; this.dPrev = this.dLin;
    this.velS += this.aVel * (vel - this.velS);
    if (this.envT <= 0) return 0;

    const env = 0.5 - 0.5 * Math.cos(Math.PI * this.envT);
    const f0 = HUM_ROOT_HZ * Math.pow(2, this.octS);
    const det = Math.pow(2, (HUM_DETUNE_MIN_C + HUM_DETUNE_RANGE_C * this.dB) / 1200);
    const idx = HUM_INDEX_MIN + HUM_INDEX_RANGE * this.dB * this.dB;
    this.ph1 += f0 / sr; if (this.ph1 >= 1) this.ph1 -= 1;
    this.ph2 += f0 * det / sr; if (this.ph2 >= 1) this.ph2 -= 1;
    const x1 = TWO_PI * this.ph1, x2 = TWO_PI * this.ph2;
    const y = 0.5 * (Math.sin(x1 + idx * Math.sin(x1)) + Math.sin(x2 + idx * Math.sin(x2)));

    const creakAmt = clamp(this.velS / CREAK_FULL_VEL, 0, 1);
    let exc = 0;
    if (creakAmt > 0.01) {
      this.creakTimer -= 1 / sr;
      if (this.creakTimer <= 0) {
        const rate = 18 + 45 * creakAmt;
        this.creakTimer = (0.7 + 0.6 * this.frand()) / rate;
        exc = (0.5 + 0.5 * this.frand()) * (this.frand() < 0.5 ? -1 : 1);
      }
    }
    if (++this.svfCount >= 16) { this.svfCount = 0; this.updateSvf(CREAK_BAND_RATIO * f0); }
    const v3 = exc - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    const creak = v1 * CREAK_LEVEL * creakAmt;
    const comp = Math.pow(2, -HUM_GAIN_COMP_DB * this.dB / 6.0206);
    return (y * HUM_LEVEL * comp + creak) * env;
  }

  // ---------------- bounce tick ----------------
  tickKill(v) { if (!v.active || v.killing) return; v.killing = true; v.kill = 1; v.killStep = 1 / (KILL_FADE_SEC * this.sr); }

  tickTrigger(speed) {
    const sr = this.sr;
    if (this.haveLastTick && (this.clock - this.lastTickClock) < TICK_MIN_GAP_S * sr) {
      if (speed <= this.lastTickSpeed) return;
      this.tickKill(this.tick[this.lastTickSlot]);
    }
    let audible = 0, oldest = -1;
    this.tick.forEach((v, i) => { if (v.active && !v.killing) { audible++; if (oldest < 0 || v.start < this.tick[oldest].start) oldest = i; } });
    if (audible >= TICK_LIMIT && oldest >= 0) this.tickKill(this.tick[oldest]);
    let slot = this.tick.findIndex(v => !v.active);
    if (slot < 0) { let best = 2; this.tick.forEach((v, i) => { if (v.killing && v.kill < best) { best = v.kill; slot = i; } }); if (slot < 0) slot = 0; }

    const v = this.newTick(); this.tick[slot] = v;
    v.active = true; v.start = this.clock;
    const deg = Math.round(speed * (TICK_SCALE.length - 1)), f = TICK_SCALE[deg];
    const tau = 0.040 - 0.020 * speed;
    const gains = [1, 0.30 + 0.45 * speed, 0.10 + 0.35 * speed], taus = [tau, tau * 0.55, tau * 0.35];
    for (let k = 0; k < 3; k++) {
      const fk = f * BAR_RATIO[k], w = TWO_PI * fk / sr;
      if (fk > 0.45 * sr) continue;
      v.c[k] = 1; v.s[k] = 0; v.wc[k] = Math.cos(w); v.ws[k] = Math.sin(w);
      v.amp[k] = gains[k]; v.dec[k] = Math.exp(-1 / (taus[k] * sr));
    }
    v.level = TICK_LEVEL * (0.35 + 0.65 * speed);
    v.clickEnv = 1; v.clickDec = Math.exp(-1 / (0.0006 * sr)); v.clickAmp = 0.22 * (0.3 + 0.7 * speed);
    this.haveLastTick = true; this.lastTickClock = this.clock; this.lastTickSpeed = speed; this.lastTickSlot = slot;
  }

  tickProcess(v) {
    let y = 0;
    for (let k = 0; k < 3; k++) {
      y += v.amp[k] * v.s[k];
      const nc = v.c[k] * v.wc[k] - v.s[k] * v.ws[k], ns = v.c[k] * v.ws[k] + v.s[k] * v.wc[k];
      v.c[k] = nc; v.s[k] = ns; v.amp[k] *= v.dec[k];
    }
    y += v.clickAmp * v.clickEnv * (this.frand() * 2 - 1);
    v.clickEnv *= v.clickDec;
    y *= v.level;
    if (v.killing) { y *= v.kill; v.kill -= v.killStep; if (v.kill <= 0) v.active = false; }
    if (v.amp[0] < 1e-4 && v.clickEnv < 1e-4) v.active = false;
    return y;
  }

  // ---------------- samples ----------------
  smpKill(v) { if (!v.active || v.killing) return; v.killing = true; v.kill = 1; v.killStep = 1 / (KILL_FADE_SEC * this.sr); }

  smpTrigger(id, gainDb, rate) {
    const s = this.samples[id]; if (!s) return;
    let audible = 0, oldest = -1;
    this.smp.forEach((v, i) => { if (v.active && !v.killing) { audible++; if (oldest < 0 || v.start < this.smp[oldest].start) oldest = i; } });
    if (audible >= SMP_LIMIT && oldest >= 0) this.smpKill(this.smp[oldest]);
    let slot = this.smp.findIndex(v => !v.active);
    if (slot < 0) { let best = 2; this.smp.forEach((v, i) => { if (v.killing && v.kill < best) { best = v.kill; slot = i; } }); if (slot < 0) slot = 0; }
    this.smp[slot] = { active: true, killing: false, start: this.clock, data: s.data, frames: s.frames, ch: s.ch,
                       pos: 0, rate: clamp(rate > 0 ? rate : 1, 0.25, 4), gain: Math.pow(10, gainDb / 20), kill: 1, killStep: 0 };
  }

  // ---------------- music ----------------
  resetLayers() {
    this.ph = 0; this.chain = 1; this.pendingChain = 0;
    for (let k = 0; k < NUM_STEMS; k++) { this.stemG[k] = k === 0 ? 1 : 0; this.stemTgt[k] = this.stemG[k]; this.stemStep[k] = 0; }
  }

  musicChain(lvl) {
    lvl = clamp(lvl | 0, 1, NUM_STEMS);
    if (lvl > this.chain) this.pendingChain = lvl;
    else {
      this.pendingChain = 0;
      if (lvl < this.chain) {
        this.chain = lvl;
        for (let k = lvl; k < NUM_STEMS; k++) { this.stemTgt[k] = 0; this.stemStep[k] = 1 / (CHAIN_DROP_FADE_S * this.sr); }
      }
    }
  }

  // ---------------- render ----------------
  process(_inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    while (this.q.length) this.apply(this.q.shift());
    const dt = this.pullTarget, th = this.theme;

    for (let i = 0; i < n; i++) {
      this.sfxG += this.aVol * (this.volSfx - this.sfxG);
      this.musG += this.aVol * (this.volMusic - this.musG);

      let mono = this.humProcess(dt);
      for (let k = 0; k < TICK_SLOTS; k++) if (this.tick[k].active) mono += this.tickProcess(this.tick[k]);
      let l = mono, r = mono;
      for (let k = 0; k < SMP_SLOTS; k++) {
        const v = this.smp[k]; if (!v.active) continue;
        const i0 = v.pos | 0;
        if (i0 + 1 >= v.frames) { v.active = false; continue; }
        const fr = v.pos - i0; let g = v.gain;
        if (v.killing) { g *= v.kill; v.kill -= v.killStep; if (v.kill <= 0) v.active = false; }
        const d = v.data;
        if (v.ch === 1) { const y = (d[i0] + (d[i0 + 1] - d[i0]) * fr) * g; l += y; r += y; }
        else { const p = 2 * i0; l += (d[p] + (d[p + 2] - d[p]) * fr) * g; r += (d[p + 1] + (d[p + 3] - d[p + 1]) * fr) * g; }
        v.pos += v.rate;
      }
      l *= this.sfxG; r *= this.sfxG;

      if (th && (this.musicOn || this.musicEnv > 0)) {
        let play = true;
        if (this.musicOn) { this.musicEnv += this.musicEnvStep; if (this.musicEnv > 1) this.musicEnv = 1; }
        else { this.musicEnv -= this.musicEnvStep; if (this.musicEnv <= 0) { this.musicEnv = 0; play = false; } }
        if (play) {
          if (this.pendingChain && this.ph % this.beatLen === 0) {
            this.chain = this.pendingChain; this.pendingChain = 0;
            for (let k = 0; k < NUM_STEMS; k++) { const tgt = k < this.chain ? 1 : 0; if (tgt > this.stemTgt[k]) this.stemStep[k] = 1 / this.beatLen; this.stemTgt[k] = tgt; }
          }
          let sl = 0, srr = 0; const j = 2 * this.ph;
          for (let k = 0; k < NUM_STEMS; k++) {
            let g = this.stemG[k];
            if (g !== this.stemTgt[k]) {
              if (g < this.stemTgt[k]) { g += this.stemStep[k]; if (g > this.stemTgt[k]) g = this.stemTgt[k]; }
              else { g -= this.stemStep[k]; if (g < this.stemTgt[k]) g = this.stemTgt[k]; }
              this.stemG[k] = g;
            }
            if (g > 0) { const gc = g * g * (3 - 2 * g), s = th.stems[k]; sl += s[j] * gc; srr += s[j + 1] * gc; }
          }
          if (++this.ph >= th.frames) this.ph = 0;
          const m = this.musicEnv * this.musG;
          l += sl * m; r += srr * m;
        }
      }

      const pk = Math.max(Math.abs(l), Math.abs(r));
      if (pk > this.limEnv) this.limEnv = pk; else this.limEnv += this.limRel * (pk - this.limEnv);
      if (this.limEnv > LIMIT_THRESHOLD) { const g = LIMIT_THRESHOLD / this.limEnv; l *= g; r *= g; }
      L[i] = clamp(l, -1, 1); if (R !== L) R[i] = clamp(r, -1, 1);
      this.clock++;
    }
    return true;
  }
}

registerProcessor('roomshift-engine', RoomshiftEngine);
