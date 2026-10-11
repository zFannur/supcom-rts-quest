// Battle audio (Web Audio API): recorded military samples (assets/sfx/<kind>_<n>.ogg, CC0, built by tools/build_audio.mjs, lazy-decoded after the
// first gesture), procedural synthesis as a fallback while a buffer is missing. play(kind, vol, pos?) - pos = {x,y,z} in scene units makes it positional
// (HRTF PannerNode). The listener sits at the origin; sources are placed relative to the head, so only the orientation is updated per frame
// (listen()). PC: the panner gives direction only (volume comes from vol, i.e. distance to the camera). VR: real distance model in physical metres.
// The samples are loudness-matched per category by the build (weapons -14 LUFS, explosions -12/-10, nuke -8, UI -21), GAIN sets the mix on top.
const KINDS = ['cannon', 'cannonL', 'arty', 'whistle', 'missile', 'aa', 'flak', 'burst', 'torpedo', 'bomb', 'laser', 'oc', 'explode', 'explodeL', 'collapse', 'nuke', 'nukeLaunch', 'built', 'ready', 'ui', 'alert'];
const VARIANTS = { cannon: 3, cannonL: 3, arty: 3, whistle: 3, missile: 3, aa: 3, flak: 3, burst: 3, torpedo: 3, bomb: 3, laser: 3, oc: 2, explode: 3, explodeL: 3, collapse: 3, nuke: 2, nukeLaunch: 2, built: 2, ready: 2, ui: 3, alert: 2, rumble: 1 };
const GAIN = { cannon: 0.42, cannonL: 0.6, arty: 0.7, whistle: 0.5, missile: 0.5, aa: 0.38, flak: 0.32, burst: 0.32, torpedo: 0.5, bomb: 0.45, laser: 0.35, oc: 0.7, explode: 0.55, explodeL: 0.8, collapse: 0.85, nuke: 1, nukeLaunch: 0.9, built: 0.55, ready: 0.45, ui: 0.5, alert: 0.55 };
const PRIO = { nuke: 9, nukeLaunch: 8, alert: 7, ui: 6, collapse: 5, explodeL: 5, arty: 4, explode: 4, whistle: 3.5, cannonL: 3.5, oc: 3, built: 3, ready: 3, torpedo: 2.5, bomb: 2.5, missile: 2.5, cannon: 2, laser: 2, flak: 1.5, aa: 1.5, burst: 1.2 };
// voice length for the synth fallback (a sample voice ends with its buffer)
const DUR = { cannon: 0.5, cannonL: 0.9, arty: 1, whistle: 1.5, missile: 1, aa: 0.3, flak: 0.3, burst: 0.4, torpedo: 1, bomb: 0.8, laser: 0.5, oc: 0.8, explode: 0.8, explodeL: 1.5, collapse: 1.5, nuke: 3.5, nukeLaunch: 2.6, built: 0.4, ready: 0.3, ui: 0.15, alert: 0.4 };
// min ms between two plays of a kind (many guns firing at once read as one volley rather than a buzz)
const THROTTLE = { cannon: 60, cannonL: 100, arty: 130, whistle: 260, missile: 110, aa: 90, flak: 70, burst: 70, torpedo: 150, bomb: 160, laser: 70, oc: 200, explode: 55, explodeL: 100, collapse: 180, nuke: 2000, nukeLaunch: 1500, built: 400, ready: 500, ui: 40, alert: 1500 };
const FIRE = { cannon: 1, cannonL: 1.5, arty: 2, missile: 1, aa: 0.6, flak: 0.6, burst: 0.4, torpedo: 1, bomb: 1, laser: 0.8, oc: 1.5, explode: 1, explodeL: 1.5, collapse: 1.5 };   // contribution to the battle rumble / music intensity
const NOPOS = { ui: 1, alert: 1, built: 1, ready: 1 };   // UI-ish sounds are never positional
const MAX_VOICES = 24;

export class Audio {
  constructor() {
    this.ctx = null; this.master = null; this.volume = 0.6; this.enabled = true; this.last = {}; this.noiseBuf = null;
    this.bufs = {}; this.loading = false; this.dest = null; this.voices = []; this.vrS = 0; this.heat = 0; this.heatT = 0; this.rumble = null;
    this.stats = { decodeErr: 0, loaded: 0, voices: 0, maxVoices: 0, played: 0, dropped: 0, stolen: 0, synth: 0 };
    this.music = null; this.base = 'assets/sfx/'; this.lis = { px: 0, py: 0, pz: 0 };
  }
  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain(); this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp); comp.connect(this.ctx.destination);
      const n = this.ctx.sampleRate * 2; this.noiseBuf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.music) this.music.unlock();   // the same gesture also allows the music (js/music.js)
    this.load();
  }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
  throttle(k, ms) { const now = performance.now(); if (this.last[k] && now - this.last[k] < ms) return false; this.last[k] = now; return true; }
  // Lazy and non-blocking (called from init() after the first user gesture). A failed file just stays on the synth fallback.
  async load() {
    if (this.loading || !this.ctx) return; this.loading = true;
    const names = []; for (const k of [...KINDS, 'rumble']) for (let i = 1; i <= VARIANTS[k]; i++) names.push(k + '_' + i);
    const next = async () => {
      while (names.length) {
        const n = names.shift();
        try {
          const r = await fetch(this.base + n + '.ogg'); if (!r.ok) throw new Error(r.status);
          const b = await this.ctx.decodeAudioData(await r.arrayBuffer());
          (this.bufs[n.replace(/_\d+$/, '')] ||= []).push(b); this.stats.loaded++;
        } catch (e) { this.stats.decodeErr++; }
      }
    };
    await Promise.all([next(), next(), next()]);
    this.startRumble();
  }
  // Per frame: head/camera orientation (the listener stays at the origin, see header). vrS = physical metres per scene unit (0 = PC).
  listen(cam, vrS = 0) {
    if (!this.ctx) return;
    const e = cam.matrixWorld.elements, L = this.ctx.listener, l = this.lis;
    this.vrS = vrS; l.px = e[12]; l.py = e[13]; l.pz = e[14];
    const nf = Math.hypot(e[8], e[9], e[10]) || 1, nu = Math.hypot(e[4], e[5], e[6]) || 1;
    const fx = -e[8] / nf, fy = -e[9] / nf, fz = -e[10] / nf, ux = e[4] / nu, uy = e[5] / nu, uz = e[6] / nu;
    if (L.forwardX) { L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz; L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz; }
    else if (L.setOrientation) L.setOrientation(fx, fy, fz, ux, uy, uz);
    // battle rumble follows how much is firing nearby
    const now = performance.now(), dt = Math.min(0.2, (now - (this.heatT || now)) / 1000); this.heatT = now;
    this.heat *= Math.exp(-dt / 1.5);
    if (this.rumble) this.rumble.g.gain.setTargetAtTime(this.enabled ? Math.min(0.5, this.heat * 0.045) : 0, this.ctx.currentTime, 0.4);
    this.stats.voices = this.activeVoices();
  }
  startRumble() {
    const bs = this.bufs.rumble; if (this.rumble || !bs || !bs.length || !this.ctx) return;
    const s = this.ctx.createBufferSource(), g = this.ctx.createGain(); s.buffer = bs[0]; s.loop = true; g.gain.value = 0;
    s.connect(g); g.connect(this.master); s.start(); this.rumble = { s, g };
  }
  activeVoices() { const t = this.ctx.currentTime; return (this.voices = this.voices.filter(v => v.end > t)).length; }
  // Output chain for a voice: gain -> (panner) -> master. Returns the node to connect sources to and the chain tail.
  out(pos, v, noPos) {
    const g = this.ctx.createGain(); g.gain.value = v;
    if (!pos || noPos || !this.ctx.createPanner) { g.connect(this.master); return { node: g, tail: g }; }
    const p = this.ctx.createPanner(), k = this.vrS || 1, l = this.lis;
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
    if (this.vrS) { p.refDistance = 0.5; p.rolloffFactor = 1.2; p.maxDistance = 100; } else p.rolloffFactor = 0;
    let x = (pos.x - l.px) * k, y = (pos.y - l.py) * k, z = (pos.z - l.pz) * k;
    if (!this.vrS) { const d = Math.hypot(x, y, z) || 1, s = 10 / d; x *= s; y *= s; z *= s; }   // PC: direction only
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z);
    g.connect(p); p.connect(this.master); return { node: g, tail: p };
  }
  play(kind, vol = 1, pos = null) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    if (!this.throttle(kind, THROTTLE[kind] || 80)) return;
    let v = Math.min(1, vol);
    const noPos = !!NOPOS[kind];
    if (pos && this.vrS && !noPos) {   // VR: loudness comes from the real distance to the head (the panner); here only cull the far ones
      const l = this.lis, d = Math.hypot(pos.x - l.px, pos.y - l.py, pos.z - l.pz) * this.vrS;
      if (d > 40) return; v = 1;
    }
    this.heat += (FIRE[kind] || 0) * v;
    const now = this.ctx.currentTime, prio = (PRIO[kind] || 2) * (0.3 + v);
    if (this.activeVoices() >= MAX_VOICES) {   // steal the lowest-priority voice if the new one outranks it
      let lo = null; for (const x of this.voices) if (!lo || x.prio < lo.prio) lo = x;
      if (!lo || lo.prio >= prio || !lo.stop) { this.stats.dropped++; return; }
      try { lo.stop(); } catch (e) { /* already stopped */ } this.voices = this.voices.filter(x => x !== lo); this.stats.stolen++;
    }
    const bs = this.bufs[kind], voice = { prio, end: now + (DUR[kind] || 0.5), stop: null };
    this.voices.push(voice); this.stats.played++;
    this.stats.maxVoices = Math.max(this.stats.maxVoices, this.voices.length);
    try {
      if (bs && bs.length) {
        const b = bs[Math.random() * bs.length | 0], s = this.ctx.createBufferSource(), o = this.out(pos, (GAIN[kind] || 0.5) * v, noPos);
        s.buffer = b; s.playbackRate.value = kind === 'alert' ? 1 : 1 + (Math.random() * 2 - 1) * 0.08;
        s.connect(o.node); voice.end = now + b.duration / s.playbackRate.value; voice.stop = () => s.stop();
        s.onended = () => { try { s.disconnect(); o.node.disconnect(); o.tail.disconnect(); } catch (e) { /* ignore */ } };
        s.start(); return;
      }
      this.stats.synth++;
      const o = this.out(pos, 1, noPos); this.dest = o.node;
      try { this.synth(kind, v); } finally { this.dest = null; }
    } catch (e) { /* audio node failures are non-fatal */ }
  }
  tone(type, f0, f1, dur, vol, delay = 0) {
    const t = this.ctx.currentTime + delay, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(this.dest || this.master); o.start(t); o.stop(t + dur + 0.02);
  }
  noise(dur, vol, f0, f1, type = 'lowpass', delay = 0) {
    const t = this.ctx.currentTime + delay, s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    s.buffer = this.noiseBuf; f.type = type; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    s.connect(f); f.connect(g); g.connect(this.dest || this.master); s.start(t, Math.random()); s.stop(t + dur + 0.02);
  }
  // Procedural fallback (used while a sample is not decoded / failed to load)
  synth(kind, v) {
    switch (kind) {
      case 'cannon': this.tone('triangle', 190, 45, 0.16, 0.18 * v); this.noise(0.08, 0.1 * v, 2500, 300); break;
      case 'cannonL': this.tone('sawtooth', 120, 30, 0.3, 0.2 * v); this.noise(0.18, 0.18 * v, 1800, 120); break;
      case 'arty': this.tone('sine', 110, 28, 0.45, 0.3 * v); this.noise(0.3, 0.2 * v, 900, 60); break;
      case 'missile': this.noise(0.5, 0.12 * v, 600, 4000, 'bandpass'); this.tone('sawtooth', 200, 800, 0.35, 0.03 * v); break;
      case 'aa': this.noise(0.25, 0.09 * v, 1500, 5000, 'bandpass'); break;
      case 'flak': this.tone('square', 420, 70, 0.07, 0.08 * v); this.noise(0.1, 0.08 * v, 3000, 400); break;
      case 'torpedo': this.tone('sine', 180, 340, 0.25, 0.1 * v); this.noise(0.4, 0.05 * v, 400, 900, 'bandpass'); break;
      case 'bomb': this.tone('sine', 900, 200, 0.6, 0.05 * v); break;
      case 'whistle': this.noise(1.2, 0.08 * v, 400, 2500, 'bandpass'); break;
      case 'burst': this.noise(0.2, 0.15 * v, 3000, 300); break;
      case 'laser': this.tone('sawtooth', 1300, 140, 0.14, 0.07 * v); this.tone('sine', 2600, 400, 0.1, 0.04 * v); break;
      case 'oc': this.tone('sawtooth', 80, 1600, 0.25, 0.15 * v); this.noise(0.4, 0.2 * v, 6000, 300, 'bandpass'); break;
      case 'explode': this.noise(0.35, 0.22 * v, 1400, 60); this.tone('sine', 90, 30, 0.3, 0.14 * v); break;
      case 'explodeL': case 'collapse': this.noise(0.9, 0.38 * v, 900, 30); this.tone('sine', 60, 20, 0.8, 0.3 * v); break;
      case 'nuke': this.noise(3.2, 0.7, 700, 20); this.tone('sine', 50, 12, 3, 0.6); this.noise(1.2, 0.4, 5000, 200, 'lowpass', 0.05); break;
      case 'nukeLaunch': this.noise(2.6, 0.5 * v, 300, 2600, 'bandpass'); this.tone('sawtooth', 45, 160, 2.2, 0.28 * v); this.noise(1.4, 0.35 * v, 5000, 300, 'lowpass', 0.1); break;
      case 'built': this.tone('triangle', 420, 840, 0.14, 0.08 * v); this.tone('triangle', 630, 1260, 0.16, 0.06 * v, 0.08); break;
      case 'ready': this.tone('sine', 700, 700, 0.06, 0.05 * v); break;
      case 'ui': this.tone('sine', 900, 1300, 0.05, 0.06); break;
      case 'alert': this.tone('square', 660, 660, 0.12, 0.06); this.tone('square', 520, 520, 0.14, 0.06, 0.16); break;
    }
  }
}
