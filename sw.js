// Service Worker: lässt die Wetter-App sofort starten und offline den letzten Stand zeigen.
// Seite selbst: erst Netz (damit Updates sofort ankommen), sonst Cache.
// Bibliotheken & Icons: aus dem Cache. Wetterdaten: nie hier (die App speichert sie selbst).
const CACHE = 'wetter-v2';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  // Seite: Netz zuerst
  if(req.mode === 'navigate' || (sameOrigin && url.pathname.endsWith('.html'))){
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put('index.html', c)); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }
  // Messwerte (data/…): immer frisch aus dem Netz, offline aus dem Cache
  if(sameOrigin && url.pathname.includes('/data/')){
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); return r; })
      .catch(() => caches.match(req, {ignoreSearch:true})));
    return;
  }
  // Eigene Dateien und Leaflet-Bibliothek: Cache zuerst
  if(sameOrigin || url.hostname === 'cdnjs.cloudflare.com'){
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if(r.ok || r.type === 'opaque'){ const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
      return r;
    })));
  }
  // Alles andere (Wetterdaten, Karten, Radar) geht direkt ins Netz.
});
