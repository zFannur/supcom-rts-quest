// Service worker: офлайн-кэш игры (PWA / TWA на Quest). Регистрируется только по https (main.js), на ПК с run.py не участвует.
// Кэш-первым для всего своего origin (кроме api/ и полноразмерных assets/models/); новая сборка (tools/build_web.mjs) докачивает только изменённые файлы.
const VERSION = 'a3e4b062d6';
// FILES: one cache for all builds (precache.json in it = the build that is on). A new build downloads only its changed files into
// STAGE while the old build keeps running from FILES, and moves them into FILES on activate (a few files: milliseconds).
const FILES = 'supcom3d-files', STAGE = 'supcom3d-stage-' + VERSION;
// Music (assets/music, ~8.5 MB) is not precached: each track goes into its own cache on first play and survives new builds.
// Rename MUSIC_CACHE when the tracks change.
const MUSIC_CACHE = 'supcom3d-music-1';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const skip = (path) => path.includes('/api/') || path.includes('/assets/models/');
const manifest = async (c) => { const r = await c.match('precache.json'); return r ? r.json() : {}; };

// No skipWaiting on install: the new build is switched on only by the boot gate in index.html ('activate' message, before any game code
// loads) or on the next launch. Switching it on under a running page mixed two builds (old main.js + new vrmenu.js): the VR menu vanished.
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    let list;
    try { list = await (await fetch('precache.json', { cache: 'no-store' })).json(); }
    catch (err) { return; }   // нет списка (запуск из исходников): кэшируем по мере запросов
    for (const k of await caches.keys()) if (k.startsWith('supcom3d-stage-') && k !== STAGE) await caches.delete(k);   // брошенные установки
    const cur = await manifest(await caches.open(FILES)), st = await caches.open(STAGE);
    const fresh = Object.keys(list).filter(f => cur[f] !== list[f]);
    const report = async (done) => { for (const cl of await self.clients.matchAll({ includeUncontrolled: true })) cl.postMessage({ update: { done, total: fresh.length, version: VERSION } }); };
    for (let i = 0; i < fresh.length; i += 8) {
      await Promise.all(fresh.slice(i, i + 8).map(u => st.match(u).then(h => h || st.add(new Request(u, { cache: 'reload' })))));   // мимо HTTP-кэша: Pages держит файлы 10 мин
      report(Math.min(fresh.length, i + 8));
    }
    await st.put('precache.json', new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } }));
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'activate') self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const f = await caches.open(FILES);
    if (await caches.has(STAGE)) {
      const st = await caches.open(STAGE), old = await manifest(f), list = await manifest(st);
      for (const k of await st.keys()) await f.put(k, await st.match(k));
      for (const k of Object.keys(old)) if (!(k in list)) await f.delete(k);
      const ix = await f.match('index.html'); if (ix) await f.put('./', ix);   // запуск APK открывает каталог: index.html этой сборки
    }
    await caches.delete(STAGE);
    // старая схема (supcom3d-<версия>); чужие stage не трогать: следующая сборка может уже ставиться
    for (const k of await caches.keys()) if (k.startsWith('supcom3d-') && k !== FILES && k !== MUSIC_CACHE && !k.startsWith('supcom3d-stage-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (FONT_HOSTS.includes(url.hostname)) { e.respondWith(fonts(req)); return; }
  if (url.origin !== location.origin || skip(url.pathname)) return;
  e.respondWith(local(req, url.pathname.includes('/assets/music/') ? MUSIC_CACHE : FILES));
});

async function local(req, name = FILES) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
  if (hit) return hit;
  try {
    const r = await fetch(req);
    if (r.ok && r.status === 200) c.put(req, r.clone());
    return r;
  } catch (err) {
    if (req.mode === 'navigate') { const i = await c.match('index.html'); if (i) return i; }
    throw err;
  }
}

// Google Fonts: сеть, при успехе копия (opaque тоже годится); офлайн берём копию, нет её — игра остаётся на системном шрифте
async function fonts(req) {
  const c = await caches.open(FILES);
  try {
    const r = await fetch(req);
    if (r.ok || r.type === 'opaque') c.put(req, r.clone());
    return r;
  } catch (err) {
    const hit = await c.match(req);
    if (hit) return hit;
    return Response.error();
  }
}
