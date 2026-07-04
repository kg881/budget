/* Бюджет — минимальный service worker.
   index.html: network-first (обновления приходят сразу, офлайн — из кэша).
   Иконки/манифест/шрифты Google: cache-first (не меняются). */
const CACHE = 'budget-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './manifest.webmanifest'])));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);

  // приложение: сеть → кэш (fallback офлайн)
  if (e.request.mode === 'navigate' || u.pathname.endsWith('/index.html')) {
    e.respondWith(
      fetch(e.request)
        .then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put('./', cp)); return r; })
        .catch(() => caches.match('./'))
    );
    return;
  }

  // статика и шрифты: кэш → сеть
  if (u.origin === location.origin || u.hostname.startsWith('fonts.')) {
    e.respondWith(
      caches.match(e.request).then(m => m || fetch(e.request).then(r => {
        const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r;
      }))
    );
  }
  // остальное (ЦБ, Google Sheets) — напрямую в сеть, не кэшируем
});
