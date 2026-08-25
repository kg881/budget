/* Бюджет — минимальный service worker.
   index.html: network-first (обновления приходят сразу, офлайн — из кэша).
   Иконки/манифест/шрифты Google: cache-first (не меняются). */
const CACHE = 'budget-v5';

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

  // приложение: сеть с ревалидацией (cache:'no-cache' обходит 10-минутный HTTP-кэш
  // GitHub Pages — обновления видны сразу) → кэш как fallback офлайн
  if (e.request.mode === 'navigate' || u.pathname.endsWith('/index.html')) {
    // Ключ кэша — конкретный URL запроса, а не './': иначе любая страница в области
    // действия (например /budget/beta/) перезаписала бы офлайн-копию основного приложения.
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' })
        .then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
        .catch(() => caches.match(e.request).then(m => m || caches.match('./')))
    );
    return;
  }

  // свой код (cloud.js и прочие .js) — сеть с ревалидацией, иначе обновления
  // логики залипали бы в кэше так же, как раньше залипало приложение
  if (u.origin === location.origin && u.pathname.endsWith('.js')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' })
        .then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
        .catch(() => caches.match(e.request))
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
