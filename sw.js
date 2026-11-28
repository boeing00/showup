// Offline cache: app shell + CDN libraries. Roster PDFs are never cached or sent anywhere.
const CACHE = 'showup-v10';
const SHELL = ['./', './index.html', './ocr.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
const CDN = [
  'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs',
];
self.addEventListener('install', e => {
  // cache:'reload' bypasses the browser's HTTP cache (GitHub Pages sends max-age=600)
  const fresh = SHELL.map(u => new Request(u, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([...fresh, ...CDN]).catch(() => c.addAll(fresh))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isCdn = url.hostname === 'cdn.jsdelivr.net';
  if (url.origin !== location.origin && !isCdn) return;
  // only app files are ever cached (never anything else on this origin)
  const scope = new URL(self.registration.scope).pathname;
  const name = url.pathname.startsWith(scope) ? url.pathname.slice(scope.length) : null;
  const APP = ['', 'index.html', 'ocr.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
               'icon-maskable-512.png', 'apple-touch-icon.png'];
  if (!isCdn && !APP.includes(name)) return;
  if (isCdn) {  // versioned libraries: cache first
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
    })));
    return;
  }
  // app files: network first (revalidated with the server, never a stale HTTP-cache copy),
  // cached copy only when offline
  e.respondWith(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html'))));
});
