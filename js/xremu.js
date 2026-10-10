// Opt-in desktop WebXR runtime (Meta Immersive Web Emulator). Never installed on normal desktop/headset launches.
//   ?xr=emu              Quest 3 emulator + DevUI (keyboard/mouse: WASD/arrows = sticks, mouse = right controller,
//                        LMB = right trigger, RMB = right grip, Q/E = left trigger/grip, Enter/RShift = A/B)
//   &xrmode=vr           immersive-vr instead of immersive-ar
//   &room=office_small   synthetic MR room (SEM, vendor/iwer/rooms/*.json) for passthrough; &room=0 none
//   &devui=0             no DevUI overlay (automated tests drive __xrdev directly)
// Record & playback: window.__xrrec.start() / .stop() -> JSON recording; __xrrec.play(json) replays it (see tools/vr_replay.mjs).
const params = new URLSearchParams(location.search);
if (params.get('twa') === '1' && !window.getDigitalGoodsService) window.getDigitalGoodsService = async () => ({});   // emulate the installed TWA app
if (params.get('xr') === 'emu' || params.has('xremu')) {
  const devui = params.get('devui') !== '0';
  const room = params.get('room') ?? (params.get('xrmode') === 'vr' ? '0' : 'office_small');
  const I = await import(devui || room !== '0' ? '../vendor/iwer/iwer-devui.module.js' : '../vendor/iwer/iwer.module.js')
    .catch(() => import('../vendor/iwer/iwer.module.js'));   // static build ships only the plain runtime
  const config = params.get('xrmode') === 'vr'
    ? { ...I.metaQuest3, supportedSessionModes: ['inline', 'immersive-vr'] }
    : I.metaQuest3;
  const device = new I.XRDevice(config);
  device.installRuntime({ forceInstall: true, polyfillLayers: false });
  // head 1.6 m, looking ~22° down at the table (0.75 m high, 0.85 m ahead); controllers in front of the chest
  const tilt = [-Math.sin(Math.PI / 16), 0, 0, Math.cos(Math.PI / 16)];
  const pose = { headset: { position: [0, 1.6, 0], quaternion: tilt },
    controllers: { left: { position: [-0.2, 1.25, -0.35], quaternion: tilt }, right: { position: [0.2, 1.25, -0.35], quaternion: tilt } } };
  if (devui && I.DevUI) { device.installDevUI(I.DevUI); device.devui.applyDefaultPose(pose); }
  if (room !== '0' && I.SyntheticEnvironmentModule) {
    device.installSEM(I.SyntheticEnvironmentModule);
    fetch(new URL(`../vendor/iwer/rooms/${room}.json`, import.meta.url)).then(r => r.json()).then(j => device.sem.loadEnvironment(j))
      .catch(e => console.warn('xremu room', room, e));
  }
  device.position.set(0, 1.6, 0);
  device.quaternion.set(-Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8));
  window.__xrdev = device;
  window.__xriwer = I;
  // scripts that set __xrdev poses/buttons must call this first, or DevUI overwrites them every frame
  window.__xrscript = (on = true) => { device.controlMode = on ? 'programmatic' : 'manual'; };
}

// Recorder works with any WebXR runtime (also on the real headset), so a session played on the Quest can be replayed on the PC.
window.__xrrec = {
  rec: null, player: null, last: null,
  // called by VRSystem every XR frame
  frame(frame, refSpace) {
    if (this.rec && refSpace) this.rec.recordFrame(frame);
  },
  async start() {
    const vr = window.__dbg?.vr, s = vr?.session;
    if (!s) throw new Error('no XR session');
    const I = window.__xriwer || await import('../vendor/iwer/iwer.module.js');
    this.rec = new I.ActionRecorder(s, vr.r.gl.xr.getReferenceSpace());
    return true;
  },
  stop() {
    if (!this.rec) return null;
    this.last = this.rec.getRecording(); this.rec = null;
    return this.last;
  },
  play(recording, opts = {}) {
    const dev = window.__xrdev, vr = window.__dbg?.vr;
    if (!dev || !vr?.session) throw new Error('playback needs ?xr=emu and an XR session');
    window.__xrscript?.();
    // without an event context ActionPlayer replays poses and gamepad values, but no select/squeeze events
    const P = window.__xriwer?.P_SESSION;
    const eventContext = { session: vr.session, getFrame: () => (P && vr.session[P]?.activeFrame) || vr.r.gl.xr.getFrame?.() || null };
    this.player = dev.createActionPlayer(vr.r.gl.xr.getReferenceSpace(), typeof recording === 'string' ? JSON.parse(recording) : recording, { eventContext, ...opts });
    this.player.play();
    return this.player;
  },
  get playing() { return !!this.player?.playing; },
};
