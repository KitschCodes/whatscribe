// Service worker: (1) receives the file from the Share menu, (2) makes the app usable offline.
const SHARE_CACHE = 'shared-audio';
const SHARE_KEY = 'shared-audio-file';

// Bump this on every change to the app files: it invalidates the old cached copy.
const VERSION = 'v9';
const SHELL_CACHE = `ws-shell-${VERSION}`;
const LIB_CACHE = `ws-lib-${VERSION}`;
const SHELL_FILES = ['./', 'index.html', 'app.js', 'worker.js', 'manifest.webmanifest', 'logo.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // cache: 'reload' avoids copying a stale version from the browser's HTTP cache.
    await Promise.all(SHELL_FILES.map(async (f) => {
      const res = await fetch(new Request(f, { cache: 'reload' }));
      if (res.ok) await cache.put(new URL(f, self.location).href, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if ((k.startsWith('ws-shell-') && k !== SHELL_CACHE) || (k.startsWith('ws-lib-') && k !== LIB_CACHE)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(req, url));
    return;
  }
  if (req.method !== 'GET') return;

  // Library (transformers.js and WASM files): cached on first request, served from the cache afterwards.
  if (url.origin === 'https://cdn.jsdelivr.net') {
    event.respondWith(cacheFirst(req, LIB_CACHE));
    return;
  }
  // App files: network first with a cached fallback.
  if (url.origin === self.location.origin) {
    event.respondWith(appFile(req, url));
  }
  // Everything else (Hugging Face, remote engine) passes through untouched: models have their own cache.
});

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function appFile(req, url) {
  const cache = await caches.open(SHELL_CACHE);
  // A page opened with parameters (e.g. ?shared=1) uses the same copy of index.html.
  const isPage = req.mode === 'navigate';
  // Only the app's own page maps to index.html; any other navigation just goes to the network.
  const appPath = new URL('./', self.location).pathname;
  if (isPage && url.pathname !== appPath && url.pathname !== appPath + 'index.html') return fetch(req);
  const key = isPage ? new URL('./', self.location).href : req.url;
  const hit = await cache.match(key, { ignoreSearch: true });
  const net = fetch(req).then((res) => {
    if (res.ok && !res.redirected) cache.put(key, res.clone());
    return res;
  }).catch(() => null);
  if (!hit) {
    const res = await net;
    return res || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  // Network first, so a new version shows up on the next open; fall back to the cached copy when offline or slow (3 s).
  const res = await Promise.race([net, new Promise((r) => setTimeout(() => r(null), 3000))]);
  return res && res.ok ? res : hit;
}

async function handleShare(request, url) {
  const base = url.pathname.replace(/share-target$/, '');
  try {
    const form = await request.formData();
    const file = form.getAll('audio').find((f) => f && typeof f !== 'string');
    if (file) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(SHARE_KEY, new Response(file, {
        headers: {
          'content-type': file.type || 'audio/ogg',
          'x-file-name': encodeURIComponent(file.name || 'vocale.ogg'),
        },
      }));
      return Response.redirect(base + '?shared=1', 303);
    }
  } catch (err) {
    // fall through to the error redirect
  }
  return Response.redirect(base + '?shared=error', 303);
}
