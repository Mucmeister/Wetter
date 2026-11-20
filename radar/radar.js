'use strict';
/* Regenradar – eigenständige Seite. Radar: DWD (Bright Sky), Niederschlagsart: DWD HymecNG, Satellit: EUMETSAT. */
const BUILD = '2026-11-20.r1';
const $ = s => document.querySelector(s);
const STEP = 15*60e3, SPAN = 8;                     // 15-Minuten-Schritte, 2 Std. zurück und 2 Std. voraus
const store = {
  get(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
};

/* ---------- Auto-Update: neue Version einmal neu laden ---------- */
async function checkUpdate(){
  try{
    const v = (await fetch('version.txt?' + Date.now(), {cache:'no-store'}).then(r => r.ok ? r.text() : '')).trim();
    if(v && v !== BUILD && sessionStorage.getItem('radar:reloadedFor') !== v){ sessionStorage.setItem('radar:reloadedFor', v); location.reload(); }
  }catch(e){}
}

/* ---------- Farben ---------- */
const PALETTE = [
  ['#8fe8ff','#62d6ff','#38bff9','#26a6f2','#1787e0','#1466c8','#1847a8','#1b2f8a','#ff4b3e','#d1002f','#8b0022'], // Regen
  ['#e8ddff','#d3c2ff','#bca5ff','#a488fb','#8c6cf0','#7653e0','#6340c9','#5230ae','#432393','#36197a','#2a1163'], // Schneeregen
  ['#ffc8ea','#ffb0de','#ffa3d9','#ff85cc','#f765bc','#e548a8','#cc2f93','#b01d7e','#93136a','#760b57','#5c0646'], // Schnee
  ['#c6ffd9','#9af7bd','#6eeea0','#45e285','#22d36d','#0fbf5b','#0aa64d','#088c41','#067336','#055c2c','#044823'], // gefrierender Regen
  ['#fff3b0','#ffec95','#ffe47a','#ffdc60','#ffd447','#ffcc2e','#ffc414','#f5b800','#e0a800','#cc9900','#b88a00'], // Graupel
  ['#ffd199','#ffc27a','#ffb35c','#ffa43d','#ff951f','#ff8600','#f07a00','#db6f00','#c76400','#b35900','#9e4f00'], // Hagel
];
const TYPE_NAME = ['Regen','Schneeregen','Schnee','gefrierender Regen','Graupel','Hagel'];
$('#legend').innerHTML = [
  ['Regen', PALETTE[0].slice(0,8)], ['Starkregen', PALETTE[0].slice(8)], ['Schnee', PALETTE[2].slice(1,9)],
  ['Schneeregen', PALETTE[1].slice(1,9)], ['Graupel/Hagel', [PALETTE[4][3], PALETTE[5][5]]], ['Glätte', PALETTE[3].slice(2,8)],
].map(([n, c]) => `<span><i style="background:linear-gradient(90deg,${c.join(',')})"></i>${n}</span>`).join('');

/* ---------- Karte ---------- */
const BOUNDS = {s: 45.6, n: 55.95, w: 1.4, e: 18.8};      // DWD-Radargitter mit etwas Rand
const merc = lat => Math.log(Math.tan(Math.PI/4 + lat*Math.PI/360));
const CW = Math.round((BOUNDS.e - BOUNDS.w) * 256*128/360);  // Auflösung wie Zoomstufe 7 ≈ 1 km
const CH = Math.round((merc(BOUNDS.n) - merc(BOUNDS.s)) * 256*128/(2*Math.PI));

const saved = store.get('radar:view') || null;
const place = store.get('wx:place');                   // Ort aus der Wetter-App (nur lesen, falls vorhanden)
const map = L.map('map', {zoomControl:false, attributionControl:true, minZoom:5, maxZoom:11, zoomSnap:0.5,
  maxBounds:[[38,-12],[64,36]], maxBoundsViscosity:0.8, preferCanvas:false, fadeAnimation:false});
map.attributionControl.setPrefix(false);
if(saved) map.setView([saved.lat, saved.lon], saved.z);
else if(place && place.lat > 46 && place.lat < 55.5 && place.lon > 5 && place.lon < 16) map.setView([place.lat, place.lon], 7.5);
else map.setView([51.1, 10.4], 6);
map.on('moveend', () => { const c = map.getCenter(); store.set('radar:view', {lat:+c.lat.toFixed(3), lon:+c.lng.toFixed(3), z:map.getZoom()}); });

map.createPane('sat');    map.getPane('sat').style.zIndex = 250;
map.createPane('radar');  map.getPane('radar').style.zIndex = 400; map.getPane('radar').style.pointerEvents = 'none';
map.createPane('labels'); map.getPane('labels').style.zIndex = 450; map.getPane('labels').style.pointerEvents = 'none';
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:11, className:'basemap', keepBuffer:3,
  attribution:'Karte © <a href="https://www.openstreetmap.org/copyright">OSM</a> · Radar DWD · Satellit EUMETSAT'}).addTo(map);

const canvas = document.createElement('canvas'); canvas.width = CW; canvas.height = CH; canvas.className = 'radarimg';
const ctx = canvas.getContext('2d');
const radarLayer = L.svgOverlay(canvas, [[BOUNDS.s, BOUNDS.w], [BOUNDS.n, BOUNDS.e]], {pane:'radar', interactive:false, opacity:.92}).addTo(map);

// Städte als Orientierung über dem Radar
const CITIES = [['Berlin',52.52,13.40,1],['Hamburg',53.55,9.99,1],['München',48.14,11.58,1],['Köln',50.94,6.96,1],['Frankfurt',50.11,8.68,1],
  ['Stuttgart',48.78,9.18,1],['Düsseldorf',51.23,6.78,0],['Leipzig',51.34,12.37,1],['Dortmund',51.51,7.47,0],['Bremen',53.08,8.80,1],
  ['Dresden',51.05,13.74,1],['Hannover',52.37,9.73,1],['Nürnberg',49.45,11.08,1],['Rostock',54.09,12.10,1],['Kiel',54.32,10.14,0],
  ['Erfurt',50.98,11.03,1],['Magdeburg',52.13,11.63,0],['Mainz',50.00,8.27,0],['Saarbrücken',49.24,6.99,0],['Freiburg',47.99,7.85,1],
  ['Regensburg',49.01,12.10,0],['Augsburg',48.37,10.90,0],['Würzburg',49.79,9.95,0],['Kassel',51.31,9.48,1],['Münster',51.96,7.63,0],
  ['Osnabrück',52.28,8.05,0],['Passau',48.57,13.43,0],['Konstanz',47.66,9.18,0],['Ingolstadt',48.77,11.43,0],['Rosenheim',47.86,12.12,0],
  ['Kempten',47.73,10.31,0],['Garmisch',47.49,11.10,0],['Bayreuth',49.95,11.58,0],['Chemnitz',50.83,12.92,0],['Görlitz',51.15,14.99,0],
  ['Flensburg',54.79,9.44,0],['Aachen',50.78,6.08,0],['Trier',49.75,6.64,0],['Karlsruhe',49.01,8.40,0],['Ulm',48.40,9.99,0],
  ['Salzburg',47.81,13.06,1],['Innsbruck',47.27,11.40,0],['Wien',48.21,16.37,1],['Zürich',47.38,8.54,1],['Basel',47.56,7.59,0],
  ['Straßburg',48.58,7.75,0],['Prag',50.08,14.44,1],['Amsterdam',52.37,4.90,1],['Brüssel',50.85,4.35,1],['Luxemburg',49.61,6.13,0],
  ['Kopenhagen',55.68,12.57,1],['Stettin',53.43,14.55,0],['Breslau',51.11,17.04,0],['Linz',48.31,14.29,0]];
CITIES.forEach(([n, la, lo, big]) => L.marker([la, lo], {pane:'labels', interactive:false, keyboard:false,
  icon: L.divIcon({className:'city' + (big ? '' : ' minor'), html:`<i></i>${n}`, iconSize:null, iconAnchor:[4,8]})}).addTo(map));
const zoomClass = () => { const z = Math.floor(map.getZoom()); document.body.classList.remove('z5','z6'); if(z <= 6) document.body.classList.add('z' + Math.max(5, z)); };
map.on('zoomend', zoomClass); zoomClass();

/* ---------- Zeitachse ---------- */
let times = [], t0 = 0, cur = 0, playing = null;
const info = new Map();                   // t -> {ok, measured, loading, failed}
function setupTimes(){
  const now = Date.now();
  t0 = Math.floor((now - 5*60e3)/STEP)*STEP;      // jüngstes sicher verfügbares Radarbild (15-Min-Raster)
  // genauer: das letzte 5-Minuten-Bild, das schon da sein sollte
  const latest = Math.floor((now - 3*60e3)/300e3)*300e3;
  times = [];
  for(let k = -SPAN; k <= SPAN; k++) times.push(t0 + k*STEP);
  if(latest > t0) times.splice(SPAN + 1, 0, latest);   // aktuellstes Bild zusätzlich
  return latest > t0 ? latest : t0;
}
const hm = t => new Date(t).toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'});
const frac = t => (t - times[0]) / (times[times.length-1] - times[0]);

function drawTimeline(){
  const nowT = times[nowIdx];
  $('#nowmark').style.left = (frac(nowT)*100) + '%';
  $('#tPast').style.width = (frac(nowT)*100) + '%';
  $('#tFut').style.width = ((1 - frac(nowT))*100) + '%';
  $('#ticks').innerHTML = [-120, -60, 0, 60, 120].map(m => {
    const t = t0 + m*60e3; return `<span style="left:${frac(t)*100}%">${m === 0 ? 'jetzt' : (m > 0 ? '+' : '−') + Math.abs(m)/60 + ' h'}</span>`; }).join('');
  $('#loads').innerHTML = times.map(t => { const s = info.get(t); return `<i class="load${s && (s.ok || s.failed) ? ' ok' : ''}" style="left:${frac(t)*100}%"></i>`; }).join('');
}
function updateClock(){
  const t = times[cur], s = info.get(t);
  $('#clock').textContent = hm(t);
  const k = $('#kind');
  if(!s || s.loading){ k.textContent = 'lädt …'; k.className = ''; }
  else if(s.failed){ k.textContent = 'kein Bild'; k.className = ''; }
  else if(s.measured){ k.textContent = t === times[nowIdx] ? 'Messung, aktuell' : 'Messung'; k.className = ''; }
  else { const m = Math.round((t - (s.run || times[nowIdx]))/60e3); k.textContent = 'Vorhersage +' + m + ' min'; k.className = 'fc'; }
  $('#knob').style.left = (frac(t)*100) + '%';
}

/* ---------- Rechen-Hintergrund (Worker) ---------- */
const worker = new Worker('worker.js');
let bufs = [new ArrayBuffer(CW*CH*4), new ArrayBuffer(CW*CH*4)], rendering = false, want = null, shown = null, typeOn = true;
let hgMeta = null, valueCb = new Map(), vid = 0;
worker.onmessage = e => {
  const m = e.data;
  if(m.cmd === 'frame'){
    info.set(m.t, {ok: m.ok, measured: m.measured, run: m.run, failed: !m.ok});
    framesDone++; progress();
    drawTimeline();
    if(m.t === times[cur]) { show(cur, true); }
    if(m.t === times[nowIdx] && m.ok) { clearFallback(); hereUpdate(); }
  } else if(m.cmd === 'render'){
    bufs.push(m.buf); rendering = false;
    if(m.id === renderId){
      ctx.putImageData(new ImageData(new Uint8ClampedArray(m.buf), CW, CH), 0, 0);
    }
    if(want != null){ const w = want; want = null; requestRender(w); }
  } else if(m.cmd === 'hg'){
    hgMeta = m.meta;
    const age = hgMeta ? (Date.now() - Date.parse(hgMeta.time))/60e3 : Infinity;
    typeOn = age < 60;
    $('#hgInfo').textContent = hgMeta ? `Letzte Bestimmung: ${hm(Date.parse(hgMeta.time))} Uhr.` + (typeOn ? '' : ' Sie ist zu alt und wird deshalb gerade nicht verwendet (alles in Regenfarben).') : 'Gerade nicht verfügbar – alles wird in Regenfarben gezeigt.';
    if(shown != null) requestRender(times[cur]);
    hereUpdate();
  } else if(m.cmd === 'value'){
    const cb = valueCb.get(m.id); valueCb.delete(m.id); if(cb) cb(m);
  } else if(m.cmd === 'init'){
    initDone = true; startLoading();
  }
};
worker.onerror = () => { msg('Die Radarberechnung ist auf diesem Gerät abgebrochen. Bitte Seite neu laden.', true); };
let initDone = false, renderId = 0;
worker.postMessage({cmd:'init', W:CW, H:CH, west:BOUNDS.w, east:BOUNDS.e, yN:merc(BOUNDS.n), yS:merc(BOUNDS.s), palette:PALETTE});

function requestRender(t){
  if(rendering || !bufs.length){ want = t; return; }
  rendering = true; const buf = bufs.pop(); renderId++;
  worker.postMessage({cmd:'render', t, buf, type: typeOn, id: renderId}, [buf]);
}
function show(i, force){
  cur = Math.max(0, Math.min(times.length-1, i));
  updateClock(); hereUpdate();
  const t = times[cur], s = info.get(t);
  if(radarOn && s && s.ok && (force || shown !== t)){ shown = t; requestRender(t); }
  else if(radarOn && s && s.failed){ shown = null; ctx.clearRect(0, 0, CW, CH); }
  if(satOn) satShow(t);
}

/* ---------- Laden ---------- */
let nowIdx = SPAN, framesDone = 0, framesTotal = 0, loadGen = 0;
function progress(){
  const p = $('#progress'), f = framesTotal ? framesDone/framesTotal : 1;
  p.style.width = (f*100) + '%'; p.style.opacity = f >= 1 ? 0 : 1;
}
async function startLoading(keepPast){
  const gen = ++loadGen;
  const latest = setupTimes();
  nowIdx = times.indexOf(latest);
  // bereits geladene Messbilder behalten, Vorhersagen immer neu holen
  for(const [t, s] of [...info]) if(!times.includes(t) || !s.measured) info.delete(t);
  worker.postMessage({cmd:'drop', keep: times.filter(t => info.has(t))});
  if(!keepPast) cur = nowIdx;
  drawTimeline(); updateClock();
  const order = [nowIdx]; for(let d = 1; d < times.length; d++){ if(nowIdx + d < times.length) order.push(nowIdx + d); if(nowIdx - d >= 0) order.push(nowIdx - d); }
  const todo = order.map(i => times[i]).filter(t => !info.has(t));
  framesDone = 0; framesTotal = todo.length; progress();
  todo.forEach(t => info.set(t, {loading:true}));
  worker.postMessage({cmd:'hg'});
  // höchstens 3 Abrufe gleichzeitig
  let next = 0;
  const run = async () => { while(next < todo.length && gen === loadGen){ const t = todo[next++]; await frameReq(t); } };
  await Promise.all([run(), run(), run()]);
  if(gen !== loadGen) return;
  const nowOk = info.get(times[nowIdx]) && info.get(times[nowIdx]).ok;
  if(nowOk) clearFallback(); else fallbackNow();
  show(cur, true);
}
function frameReq(t){
  return new Promise(res => {
    const h = e => { if(e.data.cmd === 'frame' && e.data.t === t){ worker.removeEventListener('message', h); res(); } };
    worker.addEventListener('message', h);
    worker.postMessage({cmd:'frame', t});
  });
}

// Fallback: wenn Bright Sky nicht antwortet, zeigt der DWD-Kartendienst wenigstens das aktuelle Bild
let fb = null;
function fallbackNow(){
  clearTimeout(fbRetry); fbRetry = setTimeout(() => { if(fb) startLoading(true); }, 60e3);
  if(fb) return;
  msg('Radardaten gerade nicht vollständig erreichbar – aktuelles Bild direkt vom DWD, ohne Zeitleiste und Niederschlagsart. Neuer Versuch läuft automatisch.', true);
  fb = L.tileLayer.wms('https://maps.dwd.de/geoserver/dwd/wms', {layers:'dwd:Niederschlagsradar', format:'image/png', transparent:true, opacity: radarOn ? .8 : 0, pane:'radar', version:'1.3.0'}).addTo(map);
}
let fbRetry = null;
function clearFallback(){ if(fb){ map.removeLayer(fb); fb = null; msg(''); } }
function msg(t, err){ const m = $('#msg'); m.textContent = t; m.className = 'msg' + (err ? ' err' : ''); }

/* ---------- Satellit (EUMETSAT, Meteosat-12, alle 10 Minuten) ---------- */
let satOn = false, radarOn = true;
const satLayers = new Map();
function satTimeFor(t){
  const latest = Math.floor((Date.now() - 20*60e3)/600e3)*600e3;   // Bilder kommen mit etwa 10–20 Minuten Verzögerung
  return Math.min(Math.floor(t/600e3)*600e3, latest);
}
function satLayer(st){
  let l = satLayers.get(st);
  if(!l){
    l = L.tileLayer.wms('https://view.eumetsat.int/geoserver/wms', {layers:'mtg_fd:rgb_geocolour', format:'image/jpeg', transparent:false,
      version:'1.3.0', time: new Date(st).toISOString().slice(0,19) + 'Z', pane:'sat', opacity:0, keepBuffer:1, maxNativeZoom:9, maxZoom:11});
    satLayers.set(st, l); l.addTo(map);
  }
  return l;
}
let satShown = null;
function satShow(t){
  const st = satTimeFor(t);
  const l = satLayer(st);
  satLayers.forEach((x, k) => x.setOpacity(k === st ? 1 : 0));
  satShown = st;
  // nicht mehr gebrauchte Bilder freigeben
  if(satLayers.size > 16) for(const [k, x] of satLayers) if(k !== st && satLayers.size > 12){ map.removeLayer(x); satLayers.delete(k); }
  $('#sub').textContent = `Satellit ${hm(st)} · Radar DWD`;
}
function satPreload(){ const keys = new Set(times.map(satTimeFor)); keys.forEach(k => satLayer(k)); }
function setSat(on){
  satOn = on; $('#chipSat').classList.toggle('on', on); document.body.classList.toggle('sat', on);
  if(on) satShow(times[cur]);
  else { satLayers.forEach(x => map.removeLayer(x)); satLayers.clear(); $('#sub').textContent = 'Deutschland · DWD'; }
}
function setRadar(on){
  radarOn = on; $('#chipRadar').classList.toggle('on', on);
  radarLayer.setOpacity(on ? .92 : 0); if(fb) fb.setOpacity(on ? .8 : 0);
  if(on) show(cur, true);
  $('#legend').style.display = on ? '' : 'none';
}
$('#chipSat').onclick = () => setSat(!satOn);
$('#chipRadar').onclick = () => { if(radarOn && !satOn) setSat(true); setRadar(!radarOn); };

/* ---------- Bedienung Zeitleiste ---------- */
const slider = $('#slider');
function idxFromX(x){
  const r = slider.getBoundingClientRect(), f = Math.max(0, Math.min(1, (x - r.left)/r.width));
  const t = times[0] + f*(times[times.length-1] - times[0]);
  let best = 0; times.forEach((tt, i) => { if(Math.abs(tt - t) < Math.abs(times[best] - t)) best = i; });
  return best;
}
let dragging = false;
slider.addEventListener('pointerdown', e => { dragging = true; stop(); slider.setPointerCapture(e.pointerId); show(idxFromX(e.clientX)); });
slider.addEventListener('pointermove', e => { if(dragging){ const i = idxFromX(e.clientX); if(i !== cur) show(i); } });
slider.addEventListener('pointerup', () => { dragging = false; });
slider.addEventListener('pointercancel', () => { dragging = false; });

const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>';
function play(){
  if(playing) return;
  if(satOn) satPreload();
  $('#play').innerHTML = PAUSE;
  let i = cur >= times.length-1 ? 0 : cur;
  const tick = () => {
    show(i);
    const last = i >= times.length-1;
    i = last ? 0 : i + 1;
    // nicht geladene Bilder überspringen
    while(i > 0 && info.get(times[i]) && info.get(times[i]).failed) i = (i + 1) % times.length;
    playing = setTimeout(tick, last ? 1500 : (i - 1 === nowIdx ? 900 : 550));
  };
  tick();
}
function stop(){ if(playing){ clearTimeout(playing); playing = null; } $('#play').innerHTML = PLAY; }
$('#play').onclick = () => playing ? stop() : play();

/* ---------- Standort ---------- */
let me = null, meMarker = null;
function setMe(lat, lon, fly){
  me = {lat, lon};
  if(!meMarker) meMarker = L.marker([lat, lon], {pane:'labels', interactive:false, icon: L.divIcon({className:'', html:'<div class="me"></div>', iconSize:[16,16], iconAnchor:[8,8]})}).addTo(map);
  else meMarker.setLatLng([lat, lon]);
  if(fly) map.setView([lat, lon], Math.max(map.getZoom(), 8.5));
  hereUpdate();
}
if(place && place.lat) setMe(place.lat, place.lon, false);
$('#btnLoc').onclick = () => {
  if(!navigator.geolocation) return;
  $('#btnLoc').classList.add('on');
  navigator.geolocation.getCurrentPosition(p => setMe(p.coords.latitude, p.coords.longitude, true),
    () => { $('#btnLoc').classList.remove('on'); msg('Standort nicht verfügbar – bitte in den Einstellungen für Safari-Websites erlauben.', true); },
    {enableHighAccuracy:false, timeout:12000, maximumAge:120000});
};
// „Bei dir“: Niederschlag am eigenen Ort zum gezeigten Zeitpunkt
function hereUpdate(){
  const el = $('#here');
  if(!me || !radarOn){ el.textContent = ''; return; }
  const t = times[cur], s = info.get(t);
  if(!s || !s.ok){ el.textContent = ''; return; }
  const id = ++vid;
  valueCb.set(id, m => {
    if(id !== vid) return;
    if(!m.inside){ el.textContent = ''; return; }
    if(!m.lev){ el.textContent = 'Bei dir: trocken'; return; }
    const ty = typeOn && m.type != null && m.type <= 5 ? m.type : 0;
    const st = m.lev <= 2 ? 'leichter' : m.lev <= 5 ? 'mäßiger' : m.lev <= 8 ? 'starker' : 'sehr starker';
    const name = TYPE_NAME[ty];
    const word = ty === 3 ? 'gefrierender Regen – Glätte!' : (ty === 4 || ty === 5) ? name : `${st} ${name}`;
    el.textContent = 'Bei dir: ' + word;
  });
  worker.postMessage({cmd:'value', id, t, lat: me.lat, lon: me.lon});
}

/* ---------- Info, Aktualisierung ---------- */
$('#btnInfo').onclick = () => $('#sheet').classList.add('open');
$('#sheetClose').onclick = () => $('#sheet').classList.remove('open');
$('#sheet').onclick = e => { if(e.target.id === 'sheet') $('#sheet').classList.remove('open'); };

let lastLoad = Date.now();
function refreshIfOld(){
  if(document.hidden || !initDone) return;
  if(Date.now() - lastLoad > 5*60e3){ lastLoad = Date.now(); const wasNow = cur === nowIdx; startLoading(!wasNow); }
}
document.addEventListener('visibilitychange', () => { if(!document.hidden){ checkUpdate(); refreshIfOld(); } else stop(); });
setInterval(refreshIfOld, 30e3);
window.addEventListener('online', () => { lastLoad = 0; refreshIfOld(); });

if('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
checkUpdate();
