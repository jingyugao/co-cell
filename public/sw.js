const CACHE_NAME = 'cocell-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Only a public, static fallback is cached. Reject accidental login redirects.
    await cache.add(new Request(OFFLINE_URL, { cache: 'reload', credentials: 'omit', redirect: 'error' }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('cocell-offline-') && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.mode !== 'navigate' || url.origin !== self.location.origin ||
    /^\/(?:api|mcp|auth)(?:\/|$)/.test(url.pathname)) return;

  event.respondWith((async () => {
    try {
      // Preserve redirects and authentication errors. Never cache the workspace.
      return await fetch(request);
    } catch {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(OFFLINE_URL) ?? new Response('CoCell 暂时无法连接，请恢复网络后重试。', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
