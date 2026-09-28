// Rede primeiro para receber manifest e interface atualizados; o cache é só
// reserva para falta de conexão. Dados do Supabase nunca passam pelo worker.
const CACHE_NAME = 'gestao-ammi-v3';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './ammi-logo.png',
  './pwa-icon-192.png',
  './pwa-icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all(
      APP_SHELL.map(async (arquivo) => {
        const resposta = await fetch(arquivo, { cache: 'reload' });
        await cache.put(arquivo, resposta);
      }),
    )).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      return response;
    }).catch(() => caches.match(event.request)
      .then((cached) => cached || (event.request.mode === 'navigate' ? caches.match('./index.html') : undefined))),
  );
});
