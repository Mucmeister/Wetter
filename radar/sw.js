// Service Worker der Radarseite: Seite und Skripte zuerst aus dem Netz (Updates kommen sofort an),
// Bibliotheken aus dem Cache. Radar- und Satellitendaten werden nie zwischengespeichert.
const CACHE = 'radar-v1';
const SHELL = ['./', 'index.html', 'radar.js', 'worker.js', 'manifest.json', 'icon-180.png', 'icon-192.png',
  '../vendor/leaflet/leaflet.js', '../vendor/leaflet/leaflet.css', '../vendor/fflate.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x.startsWith('radar-') && x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
function netFirst(req, ms){
  const net = fetch(req, {cache:'no-cache'}).then(r => { if(r.ok){ const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return r; });
  const cached = caches.match(req, {ignoreSearch:true});
  const slow = new Promise(res => setTimeout(res, ms)).then(() => cached).then(c => c || net);
  return Promise.race([net.catch(() => cached.then(c => c || Promise.reject())), slow]);
}
self.addEventListener('fetch', e => {
  const req = e.request; if(req.method !== 'GET') return;
  const url = new URL(req.url); if(url.origin !== location.origin) return;
  if(url.pathname.endsWith('version.txt')) return;
  if(req.mode === 'navigate' || /\/radar\/(index\.html|radar\.js|worker\.js)?$/.test(url.pathname) || /(radar|worker)\.js$/.test(url.pathname)){
    e.respondWith(netFirst(req, 3500)); return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
