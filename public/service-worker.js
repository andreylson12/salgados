// public/service-worker.js
const CACHE = "salgados-v10"; // ↑ mude a versão sempre que alterar o SW

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll([
        "/delivery",
        "/delivery.html",
        "/style.css",
        "/script.js",
        "/manifest.json?v=10", // combine com o link no HTML
        "/icons/icon-192.png",
        "/icons/icon-512.png",
      ])
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Apenas GET
  if (req.method !== "GET") return;

  const sameOrigin = url.origin === self.location.origin;

  // API da MESMA origem = network-first
  if (sameOrigin && url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // OUTRA origem (ex.: via.placeholder.com) -> não intercepta/cacheia
  if (!sameOrigin) {
    event.respondWith(fetch(req));
    return;
  }

  // Navegações = tenta rede e cai pro /delivery.html se offline
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/delivery.html"))
    );
    return;
  }

  // Estáticos da MESMA origem = cache-first com write-through
  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
    )
  );
});
