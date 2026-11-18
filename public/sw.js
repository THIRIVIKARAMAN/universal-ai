// Universal AI service worker: lets the app open with no internet.
const VERSION = "universal-ai-v10";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Anek+Latin:wdth,wght@75..125,400..800&family=Mukta:wght@400;500;700&display=swap";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // Cache every small app file (including tools that load later, like the photo and PDF readers).
    try {
      const list = await (await fetch("/precache.json", { cache: "no-store" })).json();
      await cache.addAll(list.core);
    } catch {
      // Older builds without precache.json: at least cache what index.html points to.
      try {
        const html = await (await fetch("/index.html", { cache: "no-store" })).text();
        await cache.addAll([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]));
      } catch {}
    }
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
  // Then quietly fetch the big engines (photo background remover, PDF reader) for offline use.
  cacheHeavyFiles();
});

async function cacheHeavyFiles() {
  try {
    const cache = await caches.open(VERSION);
    const list = await (await fetch("/precache.json", { cache: "no-store" })).json();
    for (const url of list.heavy) {
      if (await cache.match(url)) continue;
      try {
        const res = await fetch(url, { mode: url.startsWith("/") ? "same-origin" : "cors" });
        if (res.ok) await cache.put(url, res);
      } catch {}
    }
  } catch {}
}

// The page can ask for this again (for example when it comes back online).
self.addEventListener("message", (event) => {
  if (event.data === "cache-heavy") event.waitUntil(cacheHeavyFiles());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  const isModel = url.hostname === "storage.googleapis.com" && url.pathname.startsWith("/mediapipe-models/");
  if (!sameOrigin && !isFont && !isModel) return; // AI, App Check and maps go straight to the network.

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
