// Universal AI service worker: lets the app open with no internet.
const VERSION = "universal-ai-v3";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Anek+Latin:wdth,wght@75..125,400..800&family=Mukta:wght@400;500;700&display=swap";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // Cache the built JS/CSS that index.html points to.
    try {
      const html = await (await fetch("/index.html", { cache: "no-store" })).text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
      await cache.addAll(assets);
    } catch {}
    // Cache the fonts so the app looks the same offline.
    try {
      const cssRes = await fetch(FONT_CSS);
      const css = await cssRes.clone().text();
      await cache.put(FONT_CSS, cssRes);
      const fonts = [...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
      await Promise.all(fonts.map((u) => fetch(u, { mode: "cors" }).then((r) => cache.put(u, r)).catch(() => {})));
    } catch {}
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !isFont) return; // AI, App Check and maps go straight to the network.

  // Pages: try the network for the latest version, fall back to the saved copy.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((res) => {
        caches.open(VERSION).then((c) => c.put("/index.html", res.clone()));
        return res;
      }).catch(async () => (await caches.match("/index.html")) || (await caches.match("/")))
    );
    return;
  }

  // Everything else: saved copy first, update it in the background.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response("", { status: 504 });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window" }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow("/"))));
});
