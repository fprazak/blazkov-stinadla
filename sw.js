// Service worker:
//  - vlastní soubory (html/js/css): network-first, cache jako záloha
//  - verzované CDN (firebasejs 10.12.2, leaflet 1.9.4): CACHE-FIRST —
//    URL se nikdy nemění, takže po první návštěvě se načítají okamžitě
//    i na slabém signálu
const CACHE = "stinadla-v2";
const CDN_HOSTS = ["www.gstatic.com", "unpkg.com"];

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // CDN s verzovanými soubory → cache-first
  if (CDN_HOSTS.includes(url.host)) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        }))
    );
    return;
  }

  // vlastní origin → network-first (vždy čerstvé), cache jen offline záloha
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  }
});
