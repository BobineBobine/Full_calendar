// Service worker : met l'appli en cache pour un démarrage instantané et hors ligne.
// Les appels OneDrive / Microsoft ne passent jamais par ce cache.
const VERSION = 'v2';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/auth.js', 'js/graph.js', 'js/md.js', 'js/markdown.js', 'js/nlp.js',
  'vendor/fullcalendar.min.js', 'vendor/fc-fr.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate sur les fichiers de l'appli.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const key = url.search.includes('code=') || url.search.includes('error=') ? './' : e.request;
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(key, { ignoreSearch: key === './' });
      const network = fetch(e.request)
        .then(res => { if (res.ok && key !== './') cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
