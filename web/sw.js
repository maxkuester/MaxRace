// MaxRace web version: keeps a copy of the app on the phone so it opens at sea without internet.
// The page is fetched fresh when there is a connection (so updates arrive), the saved copy is used otherwise.
const CACHE = "maxrace-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "index.html", "icon.png", "manifest.webmanifest"]).catch(() => {})));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match("index.html")))
  );
});
