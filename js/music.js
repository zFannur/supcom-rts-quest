// Background music: a menu theme and a shuffled battle playlist with 2.5 s crossfades. No VR or game dependencies (portable to master).
// Tracks: assets/music/<name>.ogg (Kevin MacLeod, CC BY 4.0, see assets/CREDITS.md). Each track is fetched whole with a plain GET (the service
// worker caches it on first play, it is not in the precache) and played by an <audio> element from a blob: URL, so memory holds only the
// compressed file (~2 MB), never decoded PCM. Playback starts only after unlock() (a user gesture, autoplay policy).
export const MUSIC = {
  menu: ['menu_crusade'],
  battle: ['battle_volatile_reaction', 'battle_hiding_your_reality', 'battle_clash_defiant']
};
const FADE = 2.5;   // crossfade, seconds

export class Music {
  constructor(base = 'assets/music/') {
    this.base = base; this.volume = 0.5; this.enabled = true; this.unlocked = false;
    this.mode = null; this.decks = []; this.cur = null; this.loading = null; this.blobs = new Map();
    this.bag = []; this.lastBattle = ''; this.int = 0.7; this.wait = 0; this.stats = { started: 0, errors: 0, track: '' };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {   // the game loop stops in a hidden tab, so does the music
      for (const d of this.decks) if (document.hidden) d.el.pause(); else if (d.target > 0) this.play(d);
    });
  }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); }
  setEnabled(on) { this.enabled = !!on; }
  unlock() { this.unlocked = true; }
  // Per frame. mode: 'menu' | 'battle'; heat: battle intensity (Audio.heat) - louder music in a big fight.
  update(dt, mode, heat = 0) {
    dt = Math.min(0.25, dt || 0);
    const on = this.enabled && this.unlocked && this.volume > 0;
    if (this.wait > 0) this.wait -= dt;
    else if (on && (mode !== this.mode || !this.cur || (!this.loading && this.ending(this.cur)))) this.next(mode);
    if (!on && this.cur) { this.cur.target = 0; this.cur = null; this.mode = null; }
    const want = mode === 'battle' ? 0.7 + 0.3 * Math.min(1, heat / 8) : 1;
    this.int += (want - this.int) * Math.min(1, dt / 3);
    for (const d of this.decks) {
      d.g += Math.sign(d.target - d.g) * Math.min(Math.abs(d.target - d.g), dt / FADE);
      d.el.volume = Math.max(0, Math.min(1, d.g * d.g * this.volume * (d.mode === 'battle' ? this.int : 1)));
      if (d.g <= 0 && d.target <= 0) { d.el.pause(); d.dead = true; }
    }
    if (this.decks.some(d => d.dead)) this.decks = this.decks.filter(d => !d.dead);
  }
  ending(d) { const e = d.el; return d.started && (e.ended || (e.duration > 0 && e.duration - e.currentTime < FADE + 0.2)); }
  pick(mode) {
    const list = MUSIC[mode] || MUSIC.menu;
    if (mode !== 'battle' || list.length < 2) return list[0];
    if (!this.bag.length) { this.bag = list.slice().sort(() => Math.random() - 0.5); if (this.bag[0] === this.lastBattle) this.bag.push(this.bag.shift()); }
    return (this.lastBattle = this.bag.shift());
  }
  async next(mode) {
    if (this.loading && this.loading.mode === mode) return;
    this.mode = mode;
    const name = this.pick(mode), tok = { mode };
    this.loading = tok;
    if (this.cur) { this.cur.target = 0; this.cur = null; }
    try {
      const url = await this.blob(name);
      if (this.loading !== tok) return;   // the mode changed while loading
      const el = new window.Audio(url); el.preload = 'auto'; el.volume = 0;
      const d = { el, name, mode, g: 0, target: 1, started: false };
      this.decks.push(d); this.cur = d; this.stats.track = name;
      this.play(d);
    } catch (e) { this.stats.errors++; this.stats.lastError = String(e); this.mode = null; this.wait = 10; }   // missing file / offline: try again later
    finally { if (this.loading === tok) this.loading = null; }
  }
  play(d) {
    const p = d.el.play();
    const ok = () => { d.started = true; this.stats.started++; };
    if (p && p.then) p.then(ok, (e) => { if (e && e.name === 'NotAllowedError') { this.unlocked = false; if (this.cur === d) { this.cur = null; this.mode = null; } d.target = 0; } else if (!e || e.name !== 'AbortError') {   // AbortError: the deck was stopped (mode switch) before it started - expected
      this.stats.errors++; this.stats.lastError = String(e); } });
    else ok();
  }
  async blob(name) {
    if (this.blobs.has(name)) { const u = this.blobs.get(name); this.blobs.delete(name); this.blobs.set(name, u); return u; }
    const r = await fetch(this.base + name + '.ogg'); if (!r.ok) throw new Error(r.status);
    const u = URL.createObjectURL(await r.blob());
    this.blobs.set(name, u);
    while (this.blobs.size > 2) {   // keep the two most recent tracks; never revoke one that is still playing
      const [k, v] = this.blobs.entries().next().value;
      if (this.decks.some(d => d.name === k)) break;
      URL.revokeObjectURL(v); this.blobs.delete(k);
    }
    return u;
  }
}
