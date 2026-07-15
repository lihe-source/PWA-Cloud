const CACHE_NAME = "drivedock-v2.8.0";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./version.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./icon-maskable-192.png",
  "./icon-96.png",
  "./icon-128.png",
  "./icon-144.png",
  "./icon-384.png",
  "./apple-touch-icon.png",
  "./apple-touch-icon-152.png",
  "./favicon.ico",
  "./favicon-16.png",
  "./favicon-32.png",
  "./favicon-48.png",
  "./splash-640x1136.png",
  "./splash-750x1334.png",
  "./splash-828x1792.png",
  "./splash-1125x2436.png",
  "./splash-1170x2532.png",
  "./splash-1179x2556.png",
  "./splash-1206x2622.png",
  "./splash-1242x2208.png",
  "./splash-1242x2688.png",
  "./splash-1284x2778.png",
  "./splash-1290x2796.png",
  "./splash-1320x2868.png",
  "./splash-1536x2048.png",
  "./splash-1620x2160.png",
  "./splash-1640x2360.png",
  "./splash-1668x2224.png",
  "./splash-1668x2388.png",
  "./splash-2048x2732.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "CLEAR_OLD_CACHES") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.includes("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html")),
    );
    return;
  }

  if (url.pathname.endsWith("/version.json")) {
    event.respondWith(
      fetch(new Request(request, { cache: "no-store" }))
        .then((response) => response)
        .catch(() => caches.match("./version.json")),
    );
    return;
  }

  if (url.pathname.endsWith("/config.js")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
