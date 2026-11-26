// Service worker: makes the app installable, keeps the shell available offline, and keeps photos and other
// attachments once they've loaded (they never change), so scrolling back through a conversation doesn't download
// them again. Message data is not cached here; the app keeps that itself and clears both on sign-out.
const SHELL = 'mh-shell-v2';
const MEDIA = 'mh-media-v1';
const MEDIA_LIMIT = 1500;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== MEDIA).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

let trimming = false;
async function trimMedia() {
  if (trimming) return;
  trimming = true;
  try {
    const cache = await caches.open(MEDIA);
    const keys = await cache.keys();
    // Oldest entries first: Cache Storage keeps insertion order.
    for (const req of keys.slice(0, Math.max(0, keys.length - MEDIA_LIMIT))) await cache.delete(req);
  } finally {
    trimming = false;
  }
}

async function media(request) {
  const cache = await caches.open(MEDIA);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Only complete, successful files are kept (not failures or partial video ranges).
  if (res.status === 200 && !request.headers.has('range')) {
    cache.put(request, res.clone()).then(trimMedia).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/attachments/')) {
    event.respondWith(media(event.request));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/')));
  }
});
