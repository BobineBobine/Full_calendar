// Service worker : permet d'ouvrir l'appli hors ligne.
// Stratégie « réseau d'abord » : en ligne, on prend toujours la dernière version
// (pas de mélange ancien/nouveau fichiers) ; hors ligne, on sert la copie en cache.
// Les appels OneDrive / Microsoft ne passent jamais par ce cache.
const VERSION = 'v3';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/auth.js', 'js/graph.js', 'js/md.js', 'js/markdown.js', 'js/nlp.js',
  'vendor/fullcalendar.min.js', 'vendor/fc-fr.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isNav = e.request.mode === 'navigate';
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(e.request, { cache: 'no-cache' });
      if (res.ok) cache.put(isNav ? './' : e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(isNav ? './' : e.request, { ignoreSearch: isNav })) || Response.error();
    }
  })());
});
