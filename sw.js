// Service Worker: lässt die Wetter-App sofort starten und offline den letzten Stand zeigen.
// Seite selbst: erst Netz (damit Updates sofort ankommen), sonst Cache.
// Bibliotheken & Icons: aus dem Cache. Wetterdaten: nie hier (die App speichert sie selbst).
const CACHE = 'wetter-v10';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/fonts/fonts.css'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Netz zuerst; antwortet das Netz nicht innerhalb von ms, kommt die gespeicherte Version (falls vorhanden)
function netFirst(req, key, ms){
  const net = fetch(req, {cache:'no-cache'}).then(r => { if(r.ok){ const c = r.clone(); caches.open(CACHE).then(x => x.put(key, c)); } return r; });
  const cached = caches.match(key, {ignoreSearch:true});
  const slow = new Promise(res => setTimeout(res, ms)).then(() => cached).then(c => c || net);
  return Promise.race([net.catch(() => cached.then(c => c || Promise.reject())), slow]);
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  // Seite: Netz zuerst
  if(req.mode === 'navigate' || (sameOrigin && url.pathname.endsWith('.html'))){
    e.respondWith(netFirst(req, 'index.html', 3500));
    return;
  }
  if(sameOrigin && url.pathname.endsWith('app.js')){
    e.respondWith(netFirst(req, new URL('app.js', self.registration.scope).href, 3500));
    return;
  }
  // Messwerte (data/…): immer frisch aus dem Netz, offline aus dem Cache
  if(sameOrigin && url.pathname.endsWith('version.txt')) return;   // immer direkt aus dem Netz
  if(sameOrigin && url.pathname.includes('/data/')){
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); return r; })
      .catch(() => caches.match(req, {ignoreSearch:true})));
    return;
  }
  // Eigene Dateien und Leaflet-Bibliothek: Cache zuerst
  if(sameOrigin && !url.pathname.endsWith('app.js')){
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if(r.ok || r.type === 'opaque'){ const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
      return r;
    })));
  }
  // Alles andere (Wetterdaten, Karten, Radar) geht direkt ins Netz.
});
