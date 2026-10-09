const CACHE = 'iptvlivre-v7';
const CORE = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/player.js',
  '/js/login.js',
  '/vendor/hls.min.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const net = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return hit || (await net) || Response.error();
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // nunca cacheia api nem proxy de stream
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/proxy')) return;

  // pagina: sempre rede, com cache so como reserva offline
  if (req.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(networkFirst(req));
    return;
  }

  // estaticos do proprio site: mostra rapido e atualiza em segundo plano
  if (url.origin === self.location.origin) {
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  // externa (logo/favicon): cache primeiro, nunca bloqueia a fila
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).catch(() => Response.error()))
  );
});