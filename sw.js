const CACHE = "bar-restock-v10";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./catalog.json",
  "./manifest.webmanifest",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png"
];
// App code and data: try the network first so updates arrive without a cache bump.
const FRESH = ["/", "/index.html", "/app.js", "/styles.css", "/catalog.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.addAll(SHELL);
      // Prefetch thumbs one by one so a single missing image doesn't skip the rest.
      try {
        const res = await fetch("./catalog.json");
        const catalog = await res.json();
        await Promise.allSettled(catalog.map((p) => cache.add(`./thumbs/${p.id}.jpg`)));
      } catch (e) {
        // thumbs can load on demand
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function fromNetwork(req) {
  return fetch(req).then((res) => {
    // Only cache good same-origin responses; never pin a 404/500.
    if (res.ok && res.type === "basic") {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  const path = "/" + url.pathname.slice(scope.length);
  const offline = () => new Response("Offline", { status: 503, statusText: "Offline" });

  if (req.mode === "navigate" || FRESH.includes(path)) {
    event.respondWith(
      fromNetwork(req).catch(() =>
        caches.match(req, { ignoreSearch: true })
          .then((c) => c || caches.match("./index.html"))
          .then((c) => c || offline())
      )
    );
    return;
  }
  // Images and icons: cache first.
  event.respondWith(
    caches.match(req).then((cached) => cached || fromNetwork(req).catch(offline))
  );
});
