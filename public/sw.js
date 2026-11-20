/* The hosted server injects the current build's public asset list. */
const { cacheName, assets } = self.US_PUBLIC_BUILD;
const shell = "/offline-shell.html";
const allowed = new Set(assets);
const prefix = "us-public-shell-";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    try {
      await cache.addAll([shell, ...assets].map((path) =>
        new Request(path, { cache: "reload", credentials: "omit" }),
      ));
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const obsolete = (await caches.keys()).filter((key) => key.startsWith(prefix) && key !== cacheName);
    await Promise.all(obsolete.slice(0, -1).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "activate-public-update") event.waitUntil(self.skipWaiting());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && (url.pathname === "/" || /^\/app(?:\/|$)/.test(url.pathname))) {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(cacheName);
      return await cache.match(shell) ?? Response.error();
    }));
  } else if (allowed.has(url.pathname) && !url.search) {
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      return await cache.match(url.pathname) ?? fetch(request);
    })());
  } else if (/^\/assets\/[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]{8,}\.(js|css)$/.test(url.pathname) && !url.search) {
    event.respondWith((async () => {
      const oldCaches = (await caches.keys()).filter((key) => key.startsWith(prefix) && key !== cacheName);
      for (const key of oldCaches) {
        const hit = await (await caches.open(key)).match(url.pathname);
        if (hit) return hit;
      }
      return fetch(request);
    })());
  }
});
