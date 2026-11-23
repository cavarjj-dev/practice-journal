/* Offline cache for the app shell. Network first (so updates arrive), cache as fallback offline.
   Only this site's own files are cached; AI requests are never cached. */
const CACHE = 'pj-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'zip.js', 'guided.js', 'csp.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'icons/icon-maskable-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? 'index.html' : req, copy)); }
    return res;
  }).catch(() => caches.match(req.mode === 'navigate' ? 'index.html' : req).then((hit) => hit || caches.match(req, { ignoreSearch: true }))));
});
