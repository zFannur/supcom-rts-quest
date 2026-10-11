// Хранилище без сервера (GitHub Pages / PWA / TWA): сохранения в IndexedDB (бывают в несколько МБ), форма списка как у run.py (/api/saves).
// hasServer(): один раз проверяет, что рядом run.py (api/status отвечает JSON); иначе все api/-вызовы пропускаются.
let srv = null;
export function hasServer() {
  return srv || (srv = (async () => {
    try {
      const r = await fetch('api/status', { cache: 'no-store' });
      return r.ok && (r.headers.get('content-type') || '').includes('json') && (await r.json()).status === 'ok';
    } catch (e) { return false; }
  })());
}

let dbp = null;
const db = () => dbp || (dbp = new Promise((res, rej) => {
  const q = indexedDB.open('supcom3d', 1);
  q.onupgradeneeded = () => { q.result.createObjectStore('meta'); q.result.createObjectStore('data'); };
  q.onsuccess = () => res(q.result);
  q.onerror = () => { dbp = null; rej(q.error || new Error('IndexedDB недоступна')); };
}));
const wait = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error || new Error('IndexedDB: ошибка записи')); });
const get = (os, key) => new Promise((res, rej) => { const q = os.get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });

/** Список слотов: [{ slot, ...meta, size }] */
export async function localSaves() {
  const d = await db(), os = d.transaction('meta').objectStore('meta');
  return new Promise((res, rej) => { const q = os.getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
export async function localSave(slot, data) {
  const json = JSON.stringify(data), d = await db(), tx = d.transaction(['meta', 'data'], 'readwrite');
  tx.objectStore('data').put(json, slot);
  tx.objectStore('meta').put({ slot, ...(data.meta || {}), size: json.length }, slot);
  await wait(tx);
}
/** Сохранение целиком или null, если слот пуст. */
export async function localLoad(slot) {
  const d = await db(), json = await get(d.transaction('data').objectStore('data'), slot);
  return json == null ? null : JSON.parse(json);
}
