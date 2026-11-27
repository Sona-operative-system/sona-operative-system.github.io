'use strict';

const SONA_OS_SHELL_CACHE = 'sona-os-shell-v55';
const SONA_OS_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/sona-os.css?v=55',
  './js/config.js?v=55',
  './js/loader.js?v=55',
  './js/api.js?v=55',
  './js/bestand.js?v=55',
  './js/controlling.js?v=55',
  './js/einkauf.js?v=55',
  './js/rezeptur.js?v=55',
  './js/operations.js?v=55',
  './js/app.js?v=55',
  './assets/sona-logo.jpg',
  './assets/sona-logo-transparent.png',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SONA_OS_SHELL_CACHE).then((cache) =>
      Promise.all(
        SONA_OS_SHELL_ASSETS.map((assetUrl) =>
          cache.add(new Request(assetUrl, { cache: 'reload' }))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SONA_OS_SHELL_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }

  // Strictly bypass cache for Apps Script / API calls & version.json update checks
  if (
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('googleusercontent.com') ||
    url.search.includes('action=') ||
    url.pathname.endsWith('/version.json')
  ) {
    return;
  }

  // Network-First for HTML navigation (always fresh), Stale-While-Revalidate for static JS/CSS/assets
  if (url.origin !== self.location.origin) return;

  const isHtmlNav = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html');
  if (isHtmlNav) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SONA_OS_SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.open(SONA_OS_SHELL_CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const networkPromise = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              cache.put(req, res.clone()).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || networkPromise;
      })
    )
  );
});
