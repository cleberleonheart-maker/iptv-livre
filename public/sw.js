const CACHE = 'iptvlivre-v9';
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

/* A pagina pede os arquivos com ?v=... (cache-busting), mas o precache e
   feito sem query. ignoreSearch faz os dois casarem. */
const MATCH = { ignoreSearch: true };

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, MATCH);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, MATCH);
  const net = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  // mantem o worker vivo ate o revalidate terminar (mesmo com hit no cache)
  event.waitUntil(net.catch(() => {}));
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
    e.respondWith(staleWhileRevalidate(e, req));
    return;
  }

  // externa (logo/favicon): cache primeiro, nunca bloqueia a fila
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).catch(() => Response.error()))
  );
});
