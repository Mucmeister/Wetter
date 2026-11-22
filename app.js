"use strict";
/* ================= Konfiguration ================= */
// Tagesfenster: Werte für einen Tag beziehen sich nur auf 8–20 Uhr.
const WIN_START = 8, WIN_END = 20;
const DAYS = 10;
const CACHE_MIN = 20;

// Deterministische Modelle (Forecast API). prior = Grundgewicht laut veröffentlichten
// Verifikationen (ECMWF/WMO-Scorecards); wird durch die lokale Trefferquote angepasst.
const MODELS = [
  {id:'ecmwf_ifs',            name:'ECMWF IFS',      by:'ECMWF',        ki:false, prior:1.00},
  {id:'ecmwf_aifs025_single', name:'ECMWF AIFS',     by:'ECMWF',        ki:true,  prior:1.00},
  {id:'dwd_icon_seamless',    name:'DWD ICON',       by:'Dt. Wetterdienst', ki:false, prior:0.90},
  {id:'meteofrance_seamless', name:'Météo-France',   by:'ARPEGE/AROME', ki:false, prior:0.80},
  {id:'ukmo_seamless',        name:'UK Met Office',  by:'UKMO',         ki:false, prior:0.85},
  {id:'ncep_gfs_seamless',    name:'NOAA GFS',       by:'NOAA',         ki:false, prior:0.70},
  {id:'ncep_aigfs025',        name:'NOAA AIGFS',     by:'NOAA',         ki:true,  prior:0.75},
];
// Ensembles (Ensemble API). WeatherNext-Mittel geht zusätzlich als eigenes Modell in den Konsens ein.
const ENSEMBLES = [
  {id:'google_weathernext2_ensemble', name:'Google WeatherNext 2', short:'WeatherNext', ki:true, prior:1.00, asModel:true},
  {id:'ecmwf_ifs025_ensemble',        name:'ECMWF ENS',  ki:false},
  {id:'ecmwf_aifs025_ensemble',       name:'ECMWF AIFS ENS', ki:true},
  {id:'dwd_icon_seamless_eps',        name:'DWD ICON-EPS', ki:false},
];
const WN = ENSEMBLES[0];
const ALL_MODELS = [...MODELS, {id:WN.id, name:'Google WeatherNext', by:'Google DeepMind', ki:true, prior:WN.prior, ens:true}];

// Vorlaufzeit-Klassen für die Gewichtung (Tage im Voraus)
const BUCKETS = [{k:'d1', off:1, from:0, to:1, label:'0–1'}, {k:'d2', off:2, from:2, to:3, label:'2–3'},
                 {k:'d4', off:4, from:4, to:5, label:'4–5'}, {k:'d6', off:6, from:6, to:99, label:'6+'}];
const bucketFor = d => BUCKETS.find(b => d >= b.from && d <= b.to);

const DEMO = location.hash === '#demo';
const BUILD = '2026-11-22.11';   // bei jeder Änderung erhöhen (gleich wie version.txt)
// Neue Version automatisch laden, sobald die App wieder geöffnet wird
async function checkUpdate(){
  try{ const v = (await fetch('version.txt?' + Date.now(), {cache:'no-store'}).then(r => r.ok ? r.text() : '')).trim();
       if(!v || v === BUILD) return;
       // höchstens ein Neuladen pro neuer Version, damit nie eine Schleife entsteht
       if(store.get('wx:reloadedFor') === v) return;
       store.set('wx:reloadedFor', v);
       location.reload(); }catch(e){}
}

/* ================= Hilfen ================= */
const $ = s => document.querySelector(s);
const median = a => { const s=a.filter(v=>v!=null&&!isNaN(v)).sort((x,y)=>x-y); if(!s.length) return null; const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const mean = a => { const s=a.filter(v=>v!=null&&!isNaN(v)); return s.length? s.reduce((x,y)=>x+y,0)/s.length : null; };
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const r0 = v => v==null? '–' : Math.round(v);
const fmt2 = v => v==null? '–' : (Math.round(v*100)/100).toLocaleString('de-DE',{minimumFractionDigits:2});
const fmt1 = v => v==null? '–' : (Math.round(v*10)/10).toLocaleString('de-DE');
const WD = ['So','Mo','Di','Mi','Do','Fr','Sa'];
const dayName = (iso, i) => i===0 ? 'Heute' : WD[new Date(iso+'T12:00:00Z').getUTCDay()];
const store = { get(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } },
                set(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} } };

// Jede Abfrage bricht nach spätestens ms ab, damit eine hängende Verbindung nie die App blockiert
async function getJSON(url, ms = 15000){
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), ms);
  let r;
  try{ r = await fetch(url, {signal: ctl.signal}); }
  catch(e){ clearTimeout(tm); throw new Error(e.name === 'AbortError' ? 'Zeitüberschreitung' : (e.message || 'Netzwerkfehler')); }
  clearTimeout(tm);
  if(!r.ok){ let m=''; try{ m=(await r.json()).reason; }catch(e){} throw new Error(m || ('HTTP '+r.status)); }
  return r.json();
}

/* ============ Antwort-Parser: Variablen pro Modell zerlegen ============ */
// Open-Meteo hängt bei mehreren Modellen den Modellnamen an: temperature_2m_ecmwf_ifs
function splitByModel(block, modelIds){
  const ids = [...modelIds].sort((a,b)=>b.length-a.length);
  const out = {}; // out[model][varKey] = array
  for(const key of Object.keys(block)){
    if(key==='time') continue;
    let k = key, member = null;
    const mm = k.match(/_member(\d+)/); if(mm){ member = +mm[1]; k = k.replace(mm[0], ''); }
    const id = ids.find(m => k.endsWith('_'+m));
    if(!id) continue;
    let v = k.slice(0, k.length - id.length - 1);
    if(member!=null) v += '#'+member;
    (out[id] ||= {})[v] = block[key];
  }
  return out;
}

/* ================= Daten laden ================= */
const HOURLY = 'sunshine_duration,pressure_msl,temperature_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,is_day';
const STATS_MIN = 360;          // Prüfung an Messwerten: alle 6 Stunden neu
const PAST_DAYS = 46;           // so weit zurück werden alte Vorhersagen geholt
const WINDOW_DAYS = 30;         // Lernfenster für Korrektur und Gewichte
const TRACK_DAYS = 14;          // Trefferbilanz: letzte 14 Tage
const HIST_DAYS = 7;           // Rückblick: letzte 7 Tage
const LMU = {lat:48.1481, lon:11.5733, radiusKm:12};   // Innenstadt-Station Theresienstraße

const km = (a,b,c,d) => { const r=Math.PI/180, x=(d-b)*r*Math.cos((a+c)/2*r), y=(c-a)*r; return Math.sqrt(x*x+y*y)*6371; };

function urls(lat, lon){
  const base = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`;
  const ids = MODELS.map(m=>m.id).join(',');
  const prevVars = ['temperature_2m','precipitation'];
  for(const v of ['temperature_2m','precipitation']) for(const b of BUCKETS) prevVars.push(`${v}_previous_day${b.off}`);
  prevVars.push('temperature_2m_previous_day3', 'temperature_2m_previous_day5');   // nur für die Trefferbilanz in 3 und 5 Tagen
  // Geländeprüfung: Ort + 6 Punkte im Abstand von ~15 km
  const ring = [[0,0]].concat([0,60,120,180,240,300].map(a => [Math.cos(a*Math.PI/180)*0.135, Math.sin(a*Math.PI/180)*0.135/Math.cos(lat*Math.PI/180)]));
  return {
    fc:   `https://api.open-meteo.com/v1/forecast?${base}&timezone=auto&hourly=${HOURLY}&daily=sunrise,sunset&models=${ids}&forecast_days=${DAYS}&wind_speed_unit=kmh`,
    ens:  `https://ensemble-api.open-meteo.com/v1/ensemble?${base}&timezone=auto&hourly=temperature_2m,precipitation&models=${ENSEMBLES.map(e=>e.id).join(',')}&forecast_days=${DAYS}`,
    prev: `https://previous-runs-api.open-meteo.com/v1/forecast?${base}&timezone=GMT&hourly=${prevVars.join(',')}&models=${ids}&past_days=${PAST_DAYS}&forecast_days=1`,
    elev: `https://api.open-meteo.com/v1/elevation?latitude=${ring.map(p=>(lat+p[0]).toFixed(3)).join(',')}&longitude=${ring.map(p=>(lon+p[1]).toFixed(3)).join(',')}`,
  };
}

// DWD-Radar am Ort (Bright Sky): letzte 30 Min. gemessen + 2 Std. Radar-Vorhersage, 5-Minuten-Schritte
function loadRadar(lat, lon){
  const from = new Date(Date.now() - 35*60e3).toISOString().slice(0,16), to = new Date(Date.now() + 125*60e3).toISOString().slice(0,16);
  return getJSON(`https://api.brightsky.dev/radar?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&distance=2000&format=plain&date=${from}&last_date=${to}&tz=Etc/UTC`, 6000)
    .then(j => j && j.radar && j.radar.length ? j : null).catch(() => null);
}

async function loadAll(lat, lon, force){
  const nearLMU = km(lat, lon, LMU.lat, LMU.lon) <= LMU.radiusKm;
  const lmuNow = (DEMO || !nearLMU) ? Promise.resolve(null)
    : getJSON('https://raw.githubusercontent.com/Mucmeister/wetter/live/now.json?t=' + Math.floor(Date.now()/6e4), 6000).catch(() => null);
  const live = DEMO ? [null,null,null] : [loadRadar(lat, lon),
    getJSON(`https://api.brightsky.dev/alerts?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`, 6000).catch(() => null),
    getJSON(`https://api.brightsky.dev/current_weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&max_dist=20000`, 6000).catch(() => null)];
  const d0 = await loadAll2(lat, lon, force);
  // Live-Daten (Radar, Warnungen, Messwert): höchstens 2,5 s warten, sonst später nachreichen
  const liveAll = Promise.all([...live, lmuNow]).then(([radar, alerts, current, lmu]) => ({radar, alerts, current, lmuNow: lmu}));
  const quick = await Promise.race([liveAll, new Promise(r => setTimeout(() => r(null), 2500))]);
  if(quick) return {...d0, ...quick};
  return {...d0, radar:null, alerts:null, current:null, lmuNow:null, liveP: liveAll};
}
async function loadAll2(lat, lon, force){
  const key = `wx:${lat.toFixed(2)},${lon.toFixed(2)}`, skey = `wxs:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const c = store.get(key);
  let S = store.get(skey);
  const statsDue = !S || S.v !== BUILD || Date.now()-S.t > STATS_MIN*60e3;
  if(!force && !statsDue && c && Date.now()-c.t < CACHE_MIN*60e3){ state.dataTime = c.t; return {...c.d, stats:S}; }
  if(DEMO){ state.dataTime = Date.now(); return makeDemo(); }
  const u = urls(lat, lon);
  const [fc, ens] = await Promise.allSettled([getJSON(u.fc), getJSON(u.ens)]);
  if(fc.status!=='fulfilled'){
    // Offline oder Server-Fehler: letzten Stand zeigen, falls vorhanden
    if(c){ state.dataTime = c.t; state.stale = true; return {...c.d, stats:S}; }
    throw fc.reason;
  }
  state.dataTime = Date.now(); state.stale = false;
  const d = {fc: fc.value, ens: ens.status==='fulfilled'? ens.value : null,
             errs: [ens].filter(x=>x.status!=='fulfilled').map(x=>String(x.reason&&x.reason.message||x.reason))};
  let statsP = null;
  if(statsDue){
    // läuft im Hintergrund; die Seite erscheint sofort und wird danach mit den Prüfdaten neu gezeichnet
    statsP = computeAllStats(lat, lon, fc.value.utc_offset_seconds)
      .then(N => { N.t = Date.now(); N.v = BUILD; store.set(skey, N); return N; })
      .catch(() => null);
    if(S && S.v !== BUILD) S = null;
  }
  try{
    Object.keys(localStorage).filter(k => /^wxs?:\d/.test(k) && k!==key && k!==skey)
      .map(k => ({k, t:(store.get(k)||{}).t||0})).sort((a,b)=>b.t-a.t).slice(2).forEach(x => localStorage.removeItem(x.k));   // Speicher schonen (iPhone: ca. 5 MB)
  }catch(e){}
  store.set(key, {t:Date.now(), d});
  return {...d, stats:S, statsP};
}

/* ============ Messwerte: Innenstadt (LMU) oder nächste DWD-Station ============ */
async function loadObs(lat, lon, elev){
  const dL = km(lat, lon, LMU.lat, LMU.lon);
  if(dL <= LMU.radiusKm){
    const j = await getJSON('data/lmu.json?v=' + Math.floor(Date.now()/9e5));
    const s = Date.parse(j.start + ':00Z'), obs = new Map();
    j.t.forEach((v,i) => obs.set(new Date(s + i*3600e3).toISOString().slice(0,13), {t:v, p:j.p[i]}));
    return {name:'LMU-Stadtstation Theresienstraße', by:'Meteorologisches Institut der LMU', dist:dL, elev:j.station.elevation, obs};
  }
  const from = new Date(Date.now() - PAST_DAYS*864e5).toISOString().slice(0,10);
  const to = new Date().toISOString().slice(0,13) + ':00';
  const j = await getJSON(`https://api.brightsky.dev/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&date=${from}&last_date=${to}&tz=Etc/UTC`, 30000);
  const src = (j.sources||[]).filter(s => s.observation_type !== 'forecast');
  // Station: höchstens 25 km entfernt und höchstens 150 m Höhenunterschied
  const pick = src.filter(s => s.distance <= 25000 && (elev==null || s.height==null || Math.abs(s.height - elev) <= 150))
                  .sort((a,b) => a.distance - b.distance)[0];
  if(!pick) return null;
  const same = s => (pick.dwd_station_id && s.dwd_station_id === pick.dwd_station_id) || (pick.wmo_station_id && s.wmo_station_id === pick.wmo_station_id);
  const ids = new Set(src.filter(same).map(s => s.id));
  const obs = new Map();
  for(const w of j.weather || []) if(ids.has(w.source_id) && w.temperature != null) obs.set(w.timestamp.slice(0,13), {t:w.temperature, p:w.precipitation});
  if(obs.size < 24*10) return null;
  const named = src.find(s => same(s) && s.observation_type === 'historical') || pick;   // ausgeschriebener Name statt Kürzel
  return {name: named.station_name, by:'Deutscher Wetterdienst', dist: pick.distance/1000, elev: pick.height, obs};
}

/* ============ Fehler je Modell: systematische Abweichung + Treffsicherheit ============ */
// Systematische Abweichung (z. B. „in der Stadt nachts 1,5° zu kalt“) getrennt nach Tageszeit (6 Blöcke à 4 h).
const BINS = 6, binOf = h => Math.floor(h/4);
function prepPrev(prev, obsInfo, offH){
  const H = prev.hourly, time = H.time, per = splitByModel(H, MODELS.map(m=>m.id));
  const n = time.length, obsT = new Array(n).fill(null), obsP = new Array(n).fill(null);
  if(obsInfo){
    time.forEach((t,i) => { const o = obsInfo.obs.get(t.slice(0,13)); if(o){ obsT[i] = o.t; obsP[i] = o.p; } });
  } else { // ohne Station: Median der jüngsten Modellläufe als Ersatz-Referenz
    for(let i=0;i<n;i++){ obsT[i] = median(MODELS.map(m => per[m.id]?.temperature_2m?.[i])); obsP[i] = median(MODELS.map(m => per[m.id]?.precipitation?.[i])); }
  }
  const lh = time.map(t => (+t.slice(11,13) + offH + 24) % 24);               // Ortszeit-Stunde
  const lday = time.map(t => new Date(Date.parse(t+':00Z') + offH*3600e3).toISOString().slice(0,10));
  const nowKey = new Date().toISOString().slice(0,13);
  const past = time.map(t => t.slice(0,13) < nowKey);
  return {time, per, obsT, obsP, lh, lday, past, n};
}
function statsWindow(D, i0, i1, withBias, only){
  const S = {};
  for(const m of MODELS){
    const P = D.per[m.id]; if(!P) continue;
    S[m.id] = {};
    for(const b of BUCKETS){
      if(only && !only.includes(b.k)) continue;
      const F = P[`temperature_2m_previous_day${b.off}`], R = P[`precipitation_previous_day${b.off}`];
      if(!F) continue;
      const sum = new Array(BINS).fill(0), cnt = new Array(BINS).fill(0); let absRaw = 0, n = 0;
      for(let i=i0;i<i1;i++){ if(!D.past[i] || F[i]==null || D.obsT[i]==null) continue;
        const e = F[i] - D.obsT[i], k = binOf(D.lh[i]); sum[k] += e; cnt[k]++; absRaw += Math.abs(e); n++; }
      if(n < 72) continue;
      const bias = withBias ? sum.map((s,k) => s/(cnt[k]+12)) : new Array(BINS).fill(0);   // gedämpft gegen Ausreißer
      let absC = 0;
      for(let i=i0;i<i1;i++){ if(!D.past[i] || F[i]==null || D.obsT[i]==null) continue; absC += Math.abs(F[i] - bias[binOf(D.lh[i])] - D.obsT[i]); }
      // Niederschlag: Tagessummen 8–20 Uhr
      const days = {};
      if(R) for(let i=i0;i<i1;i++){ const h = D.lh[i]; if(!D.past[i] || h<=WIN_START || h>WIN_END || R[i]==null || D.obsP[i]==null) continue;
        const d = (days[D.lday[i]] ||= {f:0, o:0, n:0}); d.f += R[i]; d.o += D.obsP[i]; d.n++; }
      const dd = Object.values(days).filter(d => d.n >= 10);
      S[m.id][b.k] = {bias, maeRaw: absRaw/n, maeT: absC/n, maeP: dd.length >= 5 ? dd.reduce((s,d)=>s+Math.abs(d.f-d.o),0)/dd.length : null, n};
    }
  }
  return S;
}
// ===== Optimale Mischung: welche Kombination der Modelle hätte die Messungen der letzten 30 Tage am besten getroffen? =====
// Getrennt für Tag (9–18 Uhr) und Nacht, weil Modelle nachts (Kaltluft, Nebel) ganz anders abschneiden als tagsüber.
// Rückrechnung an 9 Stationen über 60 Tage: Fehler 0,98° → 0,93° gegenüber den bisherigen Gewichten (Tage 1–4).
const isDayH = h => h >= 9 && h <= 18;
const WN_SHARE = 0.12;            // WeatherNext hat keine Archivdaten: fester Anteil
const STACK_A = 0.75;             // 75 % optimale Mischung, 25 % bisherige Gewichte: robuster (Rückrechnung inkl. LMU-Station)
// Ab Tag 6 gibt es keine Prüfdaten. Dann zählt, wer in Deutschland langfristig am besten abschneidet:
// ECMWF AIFS (eigene Rückrechnung 1–5 Tage: bestes Modell, Vorsprung wächst mit dem Vorlauf; ECMWF: 5–15 % geringere Fehler als IFS),
// dazu Ensemble-Mittel (WeatherNext 2) und ECMWF IFS.
const LONG_W = {ecmwf_aifs025_single:0.38, google_weathernext2_ensemble:0.22, ecmwf_ifs:0.15, dwd_icon_seamless:0.08,
                ukmo_seamless:0.06, ncep_aigfs025:0.06, ncep_gfs_seamless:0.05, meteofrance_seamless:0.03};
function nnls(A, b, k){                 // nichtnegative kleinste Quadrate über die Normalgleichungen (k ≤ 8)
  const w = new Array(k).fill(1/k);
  for(let it=0; it<400; it++){
    let moved = 0;
    for(let j=0;j<k;j++){ if(A[j][j] <= 0) continue; let r = b[j]; for(let q=0;q<k;q++) r -= A[j][q]*w[q];
      const nw = Math.max(0, w[j] + r/A[j][j]); moved += Math.abs(nw - w[j]); w[j] = nw; }
    if(moved < 1e-7) break;
  }
  return w;
}
// Schreibt für die Vorlaufklassen 'keys' die Gewichte tw = [Nacht, Tag] in W (Basis: Korrektur aus S, Fenster i0..i1)
function stackInto(W, D, S, i0, i1, keys){
  for(const b of BUCKETS){
    if(!keys.includes(b.k)) continue;
    const key = `temperature_2m_previous_day${b.off}`;
    // nur Modelle mit lückenarmen Daten im Fenster (sonst bleiben zu wenige gemeinsame Stunden)
    const cov = m => { const F = D.per[m.id][key]; let c = 0, n = 0; for(let i=i0;i<i1;i++){ if(!D.past[i] || D.obsT[i]==null) continue; n++; if(F[i]!=null) c++; } return n ? c/n : 0; };
    const ms = MODELS.filter(m => S[m.id]?.[b.k] && D.per[m.id]?.[key] && cov(m) >= 0.8);
    const ws = stackW(D, key, i0, i1, ms, (m, bin) => S[m.id][b.k].bias[bin]);
    if(!ws) continue;
    const cur = ms.map(m => W[b.k][m.id].t); ws[0] = mixW(ws[0], cur); ws[1] = mixW(ws[1], cur);
    for(const m of ALL_MODELS){ const e = W[b.k][m.id]; if(!e) continue;
      const j = ms.indexOf(m);
      e.tw = j >= 0 ? [ws[0][j]*(1-WN_SHARE), ws[1][j]*(1-WN_SHARE)] : (m.id === WN.id ? [WN_SHARE, WN_SHARE] : [0, 0]); }
  }
}
// Mischungsgewichte [Nacht[], Tag[]] für die Modelle ms (Summe je 1) oder null bei zu wenig Daten
function stackW(D, key, i0, i1, ms, biasOf){
  {
    if(ms.length < 3) return null;
    const k = ms.length, parts = [0, 1].map(() => ({A: [...Array(k)].map(() => new Array(k).fill(0)), b: new Array(k).fill(0), n: 0}));
    const x = new Array(k);
    for(let i=i0;i<i1;i++){
      const o = D.obsT[i]; if(!D.past[i] || o == null) continue;
      const bin = binOf(D.lh[i]); let ok = true;
      for(let j=0;j<k;j++){ const f = D.per[ms[j].id][key][i]; if(f == null){ ok = false; break; } x[j] = f - biasOf(ms[j], bin); }
      if(!ok) continue;
      const P = parts[isDayH(D.lh[i]) ? 1 : 0]; P.n++;
      for(let j=0;j<k;j++){ P.b[j] += x[j]*o; for(let q=0;q<k;q++) P.A[j][q] += x[j]*x[q]; }
    }
    if(parts.some(P => P.n < 72)) return null;
    return parts.map(P => { const w = nnls(P.A, P.b, k), t = w.reduce((a,c)=>a+c,0); return w.map(v => t > 0 ? v/t : 1/k); });
  }
}
// optimale Mischung mit den bisherigen Gewichten (cur, beliebig skaliert) verbinden
const mixW = (st, cur) => { const t = cur.reduce((a,c)=>a+c,0) || 1; return st.map((v,j) => STACK_A*v + (1-STACK_A)*cur[j]/t); };
const wT = (w, h) => w.tw ? w.tw[isDayH(h) ? 1 : 0] : w.t;       // Temperaturgewicht zur Tageszeit
// Gewichte für die Vorhersage vom Vortag, nur mit Wissen bis s0 (für Trefferbilanz und Rückblick)
function weightsAt(D, s0, hilly, stack = true){
  const i0 = Math.max(0, s0 - WINDOW_DAYS*24), S = statsWindow(D, i0, s0, true, ['d1']);
  const W = weightsFrom(S, hilly); if(stack) stackInto(W, D, S, i0, s0, ['d1']); return W.d1;
}

function weightsFrom(S, hilly){
  const W = {};
  for(const b of BUCKETS){
    W[b.k] = {};
    const mT = median(MODELS.map(m => S[m.id]?.[b.k]?.maeT)), mP = median(MODELS.map(m => S[m.id]?.[b.k]?.maeP));
    const medBias = [...Array(BINS).keys()].map(k => median(MODELS.map(m => S[m.id]?.[b.k]?.bias[k])) || 0);
    for(const m of ALL_MODELS){
      // Gelände: hochaufgelöste Modelle (ICON-D2, AROME) bilden Berge/Täler in den ersten Tagen besser ab
      const prior = m.prior * (hilly && b.k !== 'd4' && b.k !== 'd6' && ['dwd_icon_seamless','meteofrance_seamless'].includes(m.id) ? 1.3 : 1);
      const s = S[m.id]?.[b.k];
      if(s && mT){
        const fT = clamp(Math.pow(mT/Math.max(s.maeT,0.15), 2), 0.35, 2.5);
        const fP = (s.maeP!=null && mP!=null) ? clamp(Math.pow(Math.max(mP,0.3)/Math.max(s.maeP,0.3), 2), 0.35, 2.5) : 1;
        W[b.k][m.id] = {t: prior*fT, p: prior*fP, src:'skill', maeT:s.maeT, maeRaw:s.maeRaw, bias:s.bias};
      } else {
        // ohne eigene Prüfdaten (WeatherNext): typische Abweichung der anderen Modelle übernehmen
        W[b.k][m.id] = {t: prior, p: prior, src:'prior', bias: medBias};
      }
    }
  }
  // Ab Tag 6: feste Gewichte nach langfristiger Treffsicherheit; Ortskorrektur aus 4–5 Tagen, abgeschwächt
  for(const m of ALL_MODELS){
    const e = W.d6[m.id], b4 = W.d4[m.id] && W.d4[m.id].bias;
    W.d6[m.id] = {...e, t: LONG_W[m.id] ?? 0.03, src: e.src === 'skill' ? 'skill' : e.src, long: true,
                  bias: b4 ? b4.map(v => v*0.7) : e.bias};
  }
  return W;
}

async function computeAllStats(lat, lon, offSec){
  const u = urls(lat, lon), offH = Math.round(offSec/3600);
  const [prev, el] = await Promise.all([getJSON(u.prev, 30000), getJSON(u.elev).catch(() => null)]);
  const e = el && el.elevation ? el.elevation.filter(v => v!=null) : null;
  const elev = e && e.length ? e[0] : null;
  const sd = e && e.length > 3 ? Math.sqrt(mean(e.map(v => (v - mean(e))**2))) : 0;
  const hilly = sd > 100;
  let station = null;
  try{ station = await loadObs(lat, lon, elev); }catch(err){ station = null; }
  const D = prepPrev(prev, station, offH);
  // Regen-Kalibrierung: Wie viel Regen kam tatsächlich, verglichen mit dem Modell-Mittel (1 Tag Vorlauf, 8–20 Uhr)?
  const rday = {};
  if(station) for(let i=0;i<D.n;i++){ const h = D.lh[i]; if(!D.past[i] || h <= WIN_START || h > WIN_END) continue;
    const r = (rday[D.lday[i]] ||= {i0:i, o:0, on:0, f:[], fn:0}); if(D.obsP[i] != null){ r.o += D.obsP[i]; r.on++; }
    const v = MODELS.map(m => D.per[m.id]?.precipitation_previous_day1?.[i]).filter(x => x != null);
    if(v.length >= 3){ r.f.push(mean(v)); r.fn++; } }
  const rdays = Object.entries(rday).sort().map(([d,r]) => ({d, i0:r.i0, o:r.o, f:r.f.reduce((a,b)=>a+b,0), ok: r.on >= 10 && r.fn >= 10}));
  // Faktor aus den Tagen vor Index i0 (max. 30 Tage), gedämpft und begrenzt
  const rainK = before => { const h = rdays.filter(x => x.ok && x.i0 < before).slice(-WINDOW_DAYS);
    if(h.length < 10) return 1; const so = h.reduce((a,x)=>a+x.o,0), sf = h.reduce((a,x)=>a+x.f,0); return clamp((so+2)/(sf+2), 0.4, 1.5); };
  const kNow = station ? rainK(Infinity) : 1;
  const all = statsWindow(D, Math.max(0, D.n - WINDOW_DAYS*24), D.n, !!station);
  const W = weightsFrom(all, hilly);
  if(station) stackInto(W, D, all, Math.max(0, D.n - WINDOW_DAYS*24), D.n, ['d1','d2','d4']);
  // Ortskorrektur in Worten: mittlere Abweichung der Modelle bei 1 Tag Vorlauf
  const cityBias = station ? median(MODELS.map(m => all[m.id]?.d1 ? mean(all[m.id].d1.bias) : null)) : null;
  const nightBias = station ? median(MODELS.map(m => all[m.id]?.d1 ? Math.min(...all[m.id].d1.bias.slice(0,2)) : null)) : null;
  // Trefferbilanz: jeder der letzten Tage nur mit Wissen von davor (ehrlicher Rückblick)
  let track = null, useStack = true;
  if(station){
    const dayStarts = [];
    for(let i=1;i<D.n;i++) if(D.lh[i] === 0 && D.past[i] && i+23 < D.n && D.past[i+23]) dayStarts.push(i);
    const use = dayStarts.slice(-TRACK_DAYS), acc = {ours:[0,0], avg:[0,0], old:[0,0]}, per = {};
    let days = 0; const rain = {days:0, ours:0, avg:0, per:{}};
    const yieldUI = () => new Promise(r => setTimeout(r, 0));   // Rechnung stückeln, damit Scrollen/Tippen flüssig bleibt
    await yieldUI();
    for(const s0 of use){
      if(s0 < 20*24) continue;
      if(dayStarts.indexOf(s0) % 3 === 0) await yieldUI();
      const Ww = weightsAt(D, s0, hilly);
      let used = 0;
      for(let i=s0;i<s0+24;i++){
        const o = D.obsT[i]; if(o==null) continue;
        let sw=0, sv=0, sw0=0, sv0=0, raw=[];
        for(const m of MODELS){ const f = D.per[m.id]?.temperature_2m_previous_day1?.[i]; if(f==null) continue;
          raw.push(f); (per[m.id] ||= [0,0]); per[m.id][0] += Math.abs(f-o); per[m.id][1]++;
          const w = Ww[m.id], fc = f - (w.bias? w.bias[binOf(D.lh[i])] : 0), ww = wT(w, D.lh[i]);
          sw += ww; sv += ww*fc; sw0 += w.t; sv0 += w.t*fc; }          // neue Mischung und bisherige Gewichte im Vergleich
        if(!sw || raw.length < 3) continue;
        acc.ours[0] += Math.abs(sv/sw - o); acc.ours[1]++; acc.old[0] += Math.abs(sv0/sw0 - o); acc.old[1]++; acc.avg[0] += Math.abs(mean(raw) - o); acc.avg[1]++; used++;
      }
      if(used >= 18) days++;
      // Regen ja/nein zwischen 8 und 20 Uhr (ab 0,5 mm)
      let o = 0, on = 0; const ms = {};
      for(let i=s0;i<s0+24;i++){ const h = D.lh[i]; if(h <= WIN_START || h > WIN_END) continue;
        if(D.obsP[i] != null){ o += D.obsP[i]; on++; }
        for(const m of MODELS){ const f = D.per[m.id]?.precipitation_previous_day1?.[i]; if(f != null){ (ms[m.id] ||= [0,0]); ms[m.id][0] += f; ms[m.id][1]++; } } }
      const full = Object.entries(ms).filter(([id,v]) => v[1] >= 10);
      if(on >= 10 && full.length >= 3){
        const wetO = o >= 0.5; rain.days++;
        let sw = 0, sv = 0; for(const [id,v] of full){ const w = Ww[id] ? Ww[id].p : 1; sw += w; sv += w*v[0]; }
        if((sv/sw * rainK(s0) >= 0.5) === wetO) rain.ours++;
        if((mean(full.map(([id,v]) => v[0])) >= 0.5) === wetO) rain.avg++;
        for(const [id,v] of full){ (rain.per[id] ||= 0); if((v[0] >= 0.5) === wetO) rain.per[id]++; }
      }
    }
    // Ortsabhängig: Die neue Mischung wird nur verwendet, wenn sie hier in den letzten 14 Tagen nicht schlechter war
    useStack = !(acc.old[1] && acc.old[0] < acc.ours[0]);
    if(!useStack){ for(const k of ['d1','d2','d4']) for(const id in W[k]) delete W[k][id].tw; acc.ours = acc.old; }
    if(days >= 5){
      const pm = Object.entries(per).map(([id,v]) => ({id, mae:v[0]/v[1]})).sort((a,b)=>a.mae-b.mae);
      track = {days, ours: acc.ours[0]/acc.ours[1], avg: acc.avg[0]/acc.avg[1], best: pm[0], models: pm};
      if(rain.days >= 5){ const bp = Object.entries(rain.per).sort((a,b) => b[1]-a[1])[0];
        track.rain = {days: rain.days, ours: rain.ours, avg: rain.avg, best: bp ? {id: bp[0], hits: bp[1]} : null}; }
      // Bilanz für längere Vorlaufzeiten (3 und 5 Tage), gleiche Methode: Korrektur + Gewichte nur aus der Zeit davor
      track.leads = [{lead: 1, ours: track.ours, avg: track.avg}];
      for(const L of [3, 5]){
        await yieldUI();
        const key = `temperature_2m_previous_day${L}`, ok = MODELS.filter(m => D.per[m.id]?.[key]);
        let so = 0, sa = 0, nn = 0;
        for(const s0 of use){
          if(s0 < 20*24) continue;
          const Wl = {}, Bl = {}, errs = [];
          for(const m of ok){ const F = D.per[m.id][key], sm = new Array(BINS).fill(0), c = new Array(BINS).fill(0);
            for(let i=Math.max(0, s0-WINDOW_DAYS*24); i<s0; i++){ if(!D.past[i] || F[i]==null || D.obsT[i]==null) continue; const k = binOf(D.lh[i]); sm[k] += F[i]-D.obsT[i]; c[k]++; }
            if(c.reduce((a,b)=>a+b,0) < 72) continue;
            Bl[m.id] = sm.map((x,k) => x/(c[k]+12));
            let a = 0, q = 0; for(let i=Math.max(0, s0-WINDOW_DAYS*24); i<s0; i++){ if(!D.past[i] || F[i]==null || D.obsT[i]==null) continue; a += Math.abs(F[i]-Bl[m.id][binOf(D.lh[i])]-D.obsT[i]); q++; }
            errs.push([m, a/q]); }
          if(errs.length < 3) continue;
          const md = median(errs.map(e => e[1]));
          for(const [m, e] of errs) Wl[m.id] = m.prior * clamp(Math.pow(md/Math.max(e,0.15), 2), 0.35, 2.5);
          const ms = errs.map(e => e[0]), sw2 = stackW(D, key, Math.max(0, s0-WINDOW_DAYS*24), s0, ms, (m, bin) => Bl[m.id][bin]);
          if(sw2 && useStack){ const cur = ms.map(m => Wl[m.id]); sw2[0] = mixW(sw2[0], cur); sw2[1] = mixW(sw2[1], cur); }
          for(let i=s0;i<s0+24;i++){ const o = D.obsT[i]; if(o==null) continue;
            let sw=0, sv=0; const raw=[];
            for(const [m] of errs){ const f = D.per[m.id][key][i]; if(f==null) continue; raw.push(f);
              const ww = sw2 && useStack ? sw2[isDayH(D.lh[i]) ? 1 : 0][ms.indexOf(m)] : Wl[m.id]; sw += ww; sv += ww*(f - Bl[m.id][binOf(D.lh[i])]); }
            if(raw.length < 3) continue; so += Math.abs(sv/sw - o); sa += Math.abs(mean(raw) - o); nn++; }
        }
        if(nn >= 24*5) track.leads.push({lead: L, ours: so/nn, avg: sa/nn});
      }
    }
  }
  // Rückblick: die letzten Tage – gemessen gegenüber dem, was am Vortag vorhergesagt war
  let hist = null;
  if(station){
    const starts = [];
    for(let i=1;i<D.n;i++) if(D.lh[i] === 0 && D.past[i] && i+23 < D.n && D.past[i+23]) starts.push(i);
    const out = [];
    for(const s0 of starts.slice(-HIST_DAYS)){
      if(s0 < 20*24) continue;
      await new Promise(r => setTimeout(r, 0));
      const Ww = weightsAt(D, s0, hilly, useStack);
      const rk = rainK(s0), obsH = [], obsP = [], ourH = [], ourP = [];
      for(let i=s0;i<s0+24;i++){
        obsH.push(D.obsT[i]); obsP.push(D.obsP[i]);
        let sw=0, sv=0, pw=0, pv=0, n=0;
        for(const m of MODELS){ const w = Ww[m.id]; if(!w) continue;
          const f = D.per[m.id]?.temperature_2m_previous_day1?.[i]; if(f!=null){ const ww = wT(w, D.lh[i]); sw += ww; sv += ww*(f - (w.bias ? w.bias[binOf(D.lh[i])] : 0)); n++; }
          const q = D.per[m.id]?.precipitation_previous_day1?.[i]; if(q!=null){ pw += w.p; pv += w.p*q; } }
        ourH.push(n >= 3 ? sv/sw : null); ourP.push(pw ? pv/pw*rk : null);
      }
      // Kennzahlen 8–20 Uhr (Temperatur 8:00–20:00, Regen der Stunden bis 9…20 Uhr)
      const win = a => { const v = a.slice(WIN_START, WIN_END+1).filter(x => x!=null); return v.length >= 10 ? {tmax: Math.max(...v), tmin: Math.min(...v)} : null; };
      const rsum = a => { const v = a.slice(WIN_START+1, WIN_END+1); return v.filter(x => x!=null).length >= 10 ? v.reduce((t,x) => t + (x||0), 0) : null; };
      const o = win(obsH), f = win(ourH);
      if(!o || !f) continue;
      const models = [];
      for(const m of MODELS){
        const T = D.per[m.id]?.temperature_2m_previous_day1, P = D.per[m.id]?.precipitation_previous_day1; if(!T) continue;
        const tw = win(T.slice(s0, s0+24)); if(!tw) continue;
        models.push({id: m.id, ...tw, rain: P ? rsum(P.slice(s0, s0+24)) : null});
      }
      out.push({d: D.lday[s0], obsH, obsP, ourH, ourP, o: {...o, rain: rsum(obsP)}, f: {...f, rain: rsum(ourP)}, models});
    }
    if(out.length) hist = {days: out};
  }
  return {W, track, cityBias, nightBias, elev, hilly, rainK: kNow, hist, useStack,
          station: station ? {name:station.name, by:station.by, dist:station.dist, elev:station.elev} : null};
}

/* ================= Konsens bilden ================= */
function localNow(off){ return new Date(Date.now() + off*1000).toISOString().slice(0,13)+':00'; }

function build(data){
  const fc = data.fc, H = fc.hourly, time = H.time, off = fc.utc_offset_seconds;
  const now = localNow(off);
  const per = splitByModel(H, MODELS.map(m=>m.id));
  const dailyPer = fc.daily ? splitByModel(fc.daily, MODELS.map(m=>m.id)) : {};

  // Ensembles
  const ensPer = data.ens ? splitByModel(data.ens.hourly, ENSEMBLES.map(e=>e.id)) : {};
  const ensTimeIdx = {};
  if(data.ens) data.ens.hourly.time.forEach((t,i)=> ensTimeIdx[t]=i);
  const members = {}; // members[ensId] = {T:[arrays], P:[arrays]}
  for(const e of ENSEMBLES){
    const E = ensPer[e.id]; if(!E) continue;
    const T=[], P=[];
    for(const k of Object.keys(E)){
      if(k.startsWith('temperature_2m') && E[k].some(v=>v!=null)) T.push(E[k]);
      if(k.startsWith('precipitation') && E[k].some(v=>v!=null)) P.push(E[k]);
    }
    if(T.length) members[e.id] = {T, P};
  }
  // WeatherNext-Mittel als Modell einhängen (auf Zeitachse der Forecast API)
  if(members[WN.id]){
    const M = members[WN.id];
    per[WN.id] = {
      temperature_2m: time.map(t => { const i=ensTimeIdx[t]; return i==null? null : mean(M.T.map(a=>a[i])); }),
      precipitation:  time.map(t => { const i=ensTimeIdx[t]; return i==null? null : mean(M.P.map(a=>a[i])); }),
    };
  }

  const ST = data.stats || null;
  const W = ST && ST.W ? ST.W : weightsFrom({}, false);
  const avail = ALL_MODELS.filter(m => per[m.id] && per[m.id].temperature_2m && per[m.id].temperature_2m.some(v=>v!=null));

  const nowIdx = Math.max(0, time.findIndex(t => t >= now));
  const leadDay = i => Math.max(0, Math.floor((i - nowIdx)/24));

  // Regen-Kalibrierung: Mengen um den lokal gemessenen Faktor anpassen (Radar bleibt unverändert)
  const RK = ST && ST.rainK ? ST.rainK : 1;
  if(RK !== 1){
    for(const m of avail){ const A = per[m.id].precipitation; if(A) per[m.id].precipitation = A.map(x => x==null ? null : x*RK); }
    for(const M of Object.values(members)) M.P = M.P.map(a => a.map(x => x==null ? null : x*RK));
  }

  // Ortskorrektur: systematische Abweichung je Modell, Vorlaufzeit und Tageszeit abziehen
  const raw = {};
  for(const m of avail){
    raw[m.id] = per[m.id].temperature_2m.slice();
    for(const v of ['temperature_2m','apparent_temperature']){
      const A = per[m.id][v]; if(!A) continue;
      per[m.id][v] = A.map((x,i) => { if(x==null) return null; const w = W[bucketFor(leadDay(i)).k][m.id];
        return w && w.bias ? x - w.bias[binOf(+time[i].slice(11,13))] : x; });
    }
  }

  function blend(varName, i, kind){
    const b = bucketFor(leadDay(i)).k;
    let s=0, w=0;
    for(const m of avail){
      const v = per[m.id][varName]?.[i]; if(v==null) continue;
      const e = W[b][m.id], ww = kind === 't' ? wT(e, +time[i].slice(11,13)) : e[kind]; s += v*ww; w += ww;
    }
    return w ? s/w : null;
  }
  const hourly = time.map((t,i) => {
    const temp = blend('temperature_2m', i, 't');
    const prcp = blend('precipitation', i, 'p');
    const cloud = blend('cloud_cover', i, 't');
    // Gewitter-/Nebelanteil der Modelle (gewichtet)
    const b = bucketFor(leadDay(i)).k; let th=0, fog=0, wsum=0;
    for(const m of avail){ const c = per[m.id].weather_code?.[i]; if(c==null) continue; const ww=W[b][m.id].p; wsum+=ww; if(c>=95) th+=ww; if(c===45||c===48) fog+=ww; }
    // Regenwahrscheinlichkeit dieser Stunde
    const pr = rainProb(i, i, 0.1);
    const isDay = (() => { for(const m of MODELS){ const v = per[m.id]?.is_day?.[i]; if(v!=null) return v; } const h=+t.slice(11,13); return h>=7&&h<18?1:0; })();
    return {t, i, temp, prcp, cloud, pr, isDay, thunder: wsum? th/wsum : 0, fog: wsum? fog/wsum:0,
      feels: blend('apparent_temperature', i, 't'), wind: blend('wind_speed_10m', i, 't'),
      gust: blend('wind_gusts_10m', i, 't'), rh: blend('relative_humidity_2m', i, 't'), sun: blend('sunshine_duration', i, 't'), pres: blend('pressure_msl', i, 'p')};
  });

  // Wahrscheinlichkeit für ≥thr mm Niederschlag im Stundenbereich [i0..i1] (Summe)
  function rainProb(i0, i1, thr){
    const b = bucketFor(leadDay(i0)).k;
    // Deterministische Modelle, gewichtet nach Niederschlags-Trefferquote
    let hit=0, w=0;
    for(const m of avail){
      const P = per[m.id].precipitation; if(!P) continue;
      let s=0, ok=true; for(let i=i0;i<=i1;i++){ if(P[i]==null){ok=false;break;} s+=P[i]; }
      if(!ok) continue; const ww = W[b][m.id].p; w+=ww; if(s>=thr) hit+=ww;
    }
    const det = w ? hit/w : null;
    // Ensembles: Anteil der Läufe
    const ens = [];
    for(const e of ENSEMBLES){
      const M = members[e.id]; if(!M || !M.P.length) continue;
      const j0 = ensTimeIdx[time[i0]], j1 = ensTimeIdx[time[i1]]; if(j0==null||j1==null) continue;
      let h=0, n=0;
      for(const a of M.P){ let s=0, ok=true; for(let j=j0;j<=j1;j++){ if(a[j]==null){ok=false;break;} s+=a[j]; } if(ok){ n++; if(s>=thr) h++; } }
      if(n>=5) ens.push(h/n);
    }
    const ensP = ens.length ? mean(ens) : null;
    if(det==null) return ensP; if(ensP==null) return det;
    return 0.6*ensP + 0.4*det;
  }

  // ===== Jetzt und die nächsten 2 Stunden: Radar statt Modell =====
  const NC = nowcast(data.radar, off);
  if(NC){
    const H0 = hourly[nowIdx];
    if(H0){ H0.prcp = NC.rateNow; H0.pr = NC.rateNow >= 0.1 ? 0.95 : NC.rateNow > 0 ? 0.5 : 0.03; H0.radar = true; }
    for(const k of [1,2]){
      const h = hourly[nowIdx+k]; if(!h) continue;
      const sum = NC.sumFor(h.t); if(sum == null) continue;
      const wR = k === 1 ? 1 : 0.5;     // nach über einer Stunde wird die Radar-Vorhersage unsicherer
      h.prcp = wR*sum + (1-wR)*(h.prcp||0);
      h.pr = wR*(sum >= 0.1 ? 0.9 : sum > 0.02 ? 0.45 : 0.05) + (1-wR)*(h.pr||0); h.radar = true;
    }
  }

  // ===== Regenmesser der LMU-Station: nur bis 3 km, nur wenn frisch (≤ 30 Min.), nur wenn das Radar trocken meldet =====
  let gauge = null;
  const LG = data.lmuNow;
  if(LG && LG.rain_mmh != null && LG.rain_mmh >= 0.05 && LG.time && (Date.now() - Date.parse(LG.time))/60e3 <= 30){
    const P = state.place || {}, from = P.exact || P;
    if(km(from.lat, from.lon, LG.lat, LG.lon) <= 3 && !(NC && NC.rateNow >= 0.1)){
      gauge = {mmh: LG.rain_mmh};
      const H0 = hourly[nowIdx];
      if(H0){ H0.prcp = Math.max(H0.prcp || 0, LG.rain_mmh, 0.1); H0.pr = 0.9; }
    }
  }

  // ===== Gemessene Temperatur für „Jetzt“ (nächste DWD-Station, max. 20 km, ähnliche Höhe, max. 90 Min. alt) =====
  let curObs = null;
  const CW = data.current;
  if(CW && CW.weather && CW.weather.temperature != null && CW.sources && CW.sources[0]){
    const src = CW.sources.find(x => x.id === CW.weather.source_id) || CW.sources[0];
    const age = (Date.now() - Date.parse(CW.weather.timestamp))/60e3;
    const elev = ST && ST.elev;
    if(src.distance <= 20000 && age <= 90 && (elev == null || src.height == null || Math.abs(src.height - elev) <= 150))
      { let nm = umlaut(src.station_name); const full = ST && ST.station && ST.station.name;
        if(full && full.toLowerCase().startsWith(nm.toLowerCase().slice(0, 12))) nm = full;
        const P = state.place || {};
        const from = P.exact || null;
        const dist = (from && src.lat != null) ? km(from.lat, from.lon, src.lat, src.lon) : src.distance/1000;
        curObs = {t: CW.weather.temperature, name: nm, dist, age, fromYou: !!from}; }
  }
  // In der Innenstadt hat die LMU-Station Vorrang (max. 60 Min. alt)
  const LN = data.lmuNow;
  // LMU bevorzugen, solange der Wert frisch ist (≤ 30 Min.) oder frischer als der DWD-Wert (max. 90 Min.)
  const lnAge = LN && LN.time ? (Date.now() - Date.parse(LN.time))/60e3 : 999;
  if(LN && LN.t != null && (lnAge <= 30 || (lnAge <= 90 && (!curObs || lnAge <= curObs.age)))){
    const P = state.place || {}, from = P.exact || null;
    curObs = {t: LN.t, name: 'LMU-Station Theresienstraße', dist: km(from ? from.lat : P.lat, from ? from.lon : P.lon, LN.lat, LN.lon),
              age: (Date.now() - Date.parse(LN.time))/60e3, fromYou: !!from};
  }
  if(curObs && hourly[nowIdx] && hourly[nowIdx].temp != null){
    // Gemessene Abweichung klingt über die nächsten Stunden ab (Rückrechnung: Fehler in 1 Std. 1,0° → 0,5°, in 3 Std. → 0,8°)
    const delta = clamp(curObs.t - hourly[nowIdx].temp, -5, 5);
    for(let h=0; h<=18 && hourly[nowIdx+h]; h++){ const H = hourly[nowIdx+h], f = delta*Math.exp(-h/6);
      if(H.temp != null) H.temp += f; if(H.feels != null) H.feels += f; }
    hourly[nowIdx].temp = curObs.t;
  }

  // Tage (Fenster 8–20 Uhr)
  const dates = [...new Set(time.map(t=>t.slice(0,10)))].slice(0, DAYS);
  const days = dates.map((d, di) => {
    const idx = h => time.indexOf(`${d}T${String(h).padStart(2,'0')}:00`);
    const iS = idx(WIN_START), iE = idx(WIN_END);
    if(iS<0 || iE<0) return null;
    const win = hourly.slice(iS, iE+1);             // Momentanwerte 8:00–20:00
    const acc = hourly.slice(iS+1, iE+1);           // Niederschlag 8–20 (Stundensummen bis 9..20 Uhr)
    if(!win.some(h => h.temp != null)) return null;
    const tmax = Math.max(...win.map(h=>h.temp).filter(v=>v!=null));
    const tmin = Math.min(...win.map(h=>h.temp).filter(v=>v!=null));
    const psum = acc.reduce((s,h)=>s+(h.prcp||0),0);
    const pprob = rainProb(iS+1, iE, 0.5);
    const cloud = mean(win.map(h=>h.cloud));
    const thunder = Math.max(...win.map(h=>h.thunder));
    const fog = mean(win.slice(0,4).map(h=>h.fog));
    // Ganzer Kalendertag (0–24 Uhr) – nur für Detailansicht und Nacht-Hinweis
    const i0 = idx(0);
    const full = i0>=0 ? hourly.slice(i0, i0+24) : win;
    const sumP = (a,b) => { let s=0, n=0; for(let i=Math.max(a,0);i<=b && i<hourly.length;i++){ if(hourly[i].prcp!=null){ s+=hourly[i].prcp; n++; } } return n? s : null; };
    const pEarly = i0>=0 ? sumP(i0+1, iS) : null;          // 0–8 Uhr
    const pLate  = sumP(iE+1, (i0>=0?i0:iS-WIN_START)+24); // 20–24 Uhr
    const fullT = full.map(h=>h.temp).filter(v=>v!=null);
    // Sonnenscheindauer 8–20 Uhr (Stundenwerte gelten für die Stunde davor); nur Modelle, die sie liefern
    const sunV = acc.map(h=>h.sun).filter(v=>v!=null);
    const sunH = sunV.length >= acc.length - 2 ? sunV.reduce((a,b)=>a+b,0)/3600 : null;
    // Sonnenstunden des ganzen Tages (Stundenwerte gelten für die Stunde davor: 1:00 … 24:00)
    const sunF = hourly.slice(i0 + 1, i0 + 25).map(h => h.sun);
    const sunDay = i0 >= 0 && sunF.filter(v => v != null).length >= 22 ? sunF.reduce((a,b) => a + (b||0), 0)/3600 : null;
    const sunM = avail.map(m => { const S = per[m.id].sunshine_duration; if(!S) return null; let x=0;
      for(let i=iS+1;i<=iE;i++){ if(S[i]==null) return null; x+=S[i]; } return x/3600; }).filter(v=>v!=null);
    const fullDay = {hours: full, tmin: fullT.length ? Math.min(...fullT) : tmin, tmax: fullT.length ? Math.max(...fullT) : tmax, pEarly, pLate};
    const nightP = (pEarly||0) + (pLate||0);
    // Modellstreuung + Einzelwerte
    const lead = Math.max(0, Math.floor((iS - nowIdx)/24));
    const b = bucketFor(lead).k;
    const byModel = avail.map(m => {
      const T = per[m.id].temperature_2m, P = per[m.id].precipitation;
      const tw = []; for(let i=iS;i<=iE;i++) if(T[i]!=null) tw.push(T[i]);
      let ps=0, pn=0; if(P) for(let i=iS+1;i<=iE;i++) if(P[i]!=null){ps+=P[i];pn++;}
      return {m, tmax: tw.length? Math.max(...tw):null, tmin: tw.length? Math.min(...tw):null, psum: pn? ps:null, w: W[b][m.id]};
    }).filter(x=>x.tmax!=null);
    const wsum = byModel.reduce((s,x)=>s+x.w.t,0);
    byModel.forEach(x => x.share = x.w.t/wsum);
    const sd = Math.sqrt(mean(byModel.map(x => (x.tmax - tmax)**2)) || 0);
    const minT = Math.min(...win.map(h=>h.temp));
    // Spanne aus den Ensembles (10–90 %), auf den Konsens zentriert
    let range = null;
    const j0 = ensTimeIdx[time[iS]], j1 = ensTimeIdx[time[iE]];
    if(j0!=null && j1!=null){
      const hi=[], lo=[];
      for(const M of Object.values(members)) for(const a of M.T){ let mx=-99, mn=99, ok=0;
        for(let j=j0;j<=j1;j++) if(a[j]!=null){ mx=Math.max(mx,a[j]); mn=Math.min(mn,a[j]); ok++; }
        if(ok>=6){ hi.push(mx); lo.push(mn); } }
      if(hi.length >= 20){
        const q = (arr,p) => { const s=arr.slice().sort((x,y)=>x-y); return s[Math.min(s.length-1, Math.max(0, Math.round(p*(s.length-1))))]; };
        const sh = tmax - q(hi,.5), sl = tmin - q(lo,.5);
        range = {hi:[q(hi,.1)+sh, q(hi,.9)+sh], lo:[q(lo,.1)+sl, q(lo,.9)+sl], n: hi.length};
        range.width = range.hi[1] - range.hi[0];
      }
    }
    const cond = condition({cloud, psum, pprob, thunder, fog, temp: (tmax+tmin)/2, isDay:1});
    return {d, di, tmax, tmin, psum, pprob, cloud, thunder, nightP, fullDay, byModel, sd, cond, minT, bucket:b, range, sunH, sunM, sunDay};
  }).filter(Boolean);

  const cur = hourly[nowIdx];
  // Sonnenauf-/untergang
  let sun = null;
  for(const m of MODELS){ const D = dailyPer[m.id]; if(D && D.sunrise && D.sunrise[0]){ sun = {rise:D.sunrise, set:D.sunset}; break; } }
  if(!sun && fc.daily && fc.daily.sunrise) sun = {rise: fc.daily.sunrise, set: fc.daily.sunset};

  return {hourly, days, cur, nowIdx, W, ST, avail, per, members, sun, now, meta:fc, NC, curObs, gauge, alerts: data.alerts};
}

// Radar auswerten: Werte in 0,01 mm je 5 Min.; Ort = latlon_position im Raster, dazu Nachbarschaft ±1 Pixel
function nowcast(radar, offSec){
  if(!radar) return null;
  const pos = radar.latlon_position, cx = Math.round(pos.x), cy = Math.round(pos.y);
  const nowMs = Date.now();
  const frames = radar.radar.map(f => {
    const g = f.precipitation_5, at = (y,x) => (g[y] && g[y][x] != null) ? g[y][x] : null;
    const c = at(cy, cx); let mx = 0;
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){ const v = at(cy+dy, cx+dx); if(v!=null) mx = Math.max(mx, v); }
    return {ms: Date.parse(f.timestamp), mm: c==null ? null : c/100, near: mx/100};
  }).filter(f => f.mm != null).sort((a,b) => a.ms - b.ms);
  if(frames.length < 6) return null;
  const past = frames.filter(f => f.ms <= nowMs);
  const cur = past.length ? past[past.length-1] : frames[0];
  // aktuelle Stärke (mm/h): Regenbeginn sofort aus dem neuesten Bild,
  // „trocken“ erst, wenn auch das Bild davor trocken war (verhindert Flackern)
  const lastF = past.length ? past[past.length-1] : frames[0], prevF = past.length > 1 ? past[past.length-2] : null;
  const wetMM = 0.1/12;
  const rateNow = lastF.mm >= wetMM ? lastF.mm*12 : (prevF && prevF.mm >= wetMM ? prevF.mm*12 : 0);
  const toLocal = ms => new Date(ms + offSec*1000).toISOString().slice(0,16);
  const last = frames[frames.length-1].ms;
  return {
    frames, rateNow, nearNow: cur.near*12, last,
    // Summe für die Stunde, die zur Ortszeit tLocal endet (wie Open-Meteo)
    sumFor(tLocal){ const end = Date.parse(tLocal + ':00Z') - offSec*1000, start = end - 3600e3;
      if(end > last + 60e3 || end <= frames[0].ms) return null;
      return frames.filter(f => f.ms > start && f.ms <= end).reduce((s,f) => s + f.mm, 0); },
    // nächster Wechsel trocken/nass in der Radar-Vorhersage
    change(){ const wet = rateNow >= 0.1; const f = frames.find(f => f.ms > nowMs && ((f.mm*12 >= 0.1) !== wet));
      if(!f) return null;
      const peak = Math.max(...frames.filter(x => x.ms >= f.ms).map(x => x.mm*12));
      return {wet: !wet, at: toLocal(f.ms).slice(11,16), light: peak < 0.5}; },
  };
}

const umlaut = n => String(n||'').replace(/Ae/g,'Ä').replace(/Oe/g,'Ö').replace(/Ue/g,'Ü').replace(/ae/g,'ä').replace(/oe/g,'ö').replace(/(^|[^qQ])ue/g, (m, c) => c + 'ü');   // ohne Lookbehind: ältere iPhones (iOS < 16.4) kennen den nicht

/* ================= Wetterzustand + Icons ================= */
function condition({cloud, psum, pprob, thunder, fog, temp, isDay, hourly}){
  const snow = temp!=null && temp < 1;
  const pr = Math.round(pprob*10)/10;               // so wie die Prozentzahl angezeigt wird
  const wet = hourly ? (psum >= 0.1 && pr >= 0.4) : (pr >= 0.6 && psum >= 1);
  const showers = !wet && (hourly ? (psum >= 0.1 && pr >= 0.3) : (pr >= 0.4 && psum >= 0.2));
  // Anzahl Regenstriche im Symbol nach Menge: leicht / mäßig / kräftig (Tag 8–20 Uhr bzw. pro Stunde)
  const n = hourly ? (psum < 0.5 ? 1 : psum < 2.5 ? 2 : 3) : (psum < 2 ? 1 : psum < 8 ? 2 : 3);
  if(thunder >= 0.3 && (pprob>=0.35)) return {k:'thunder', txt:'Gewitter'};
  if(wet) return snow ? {k:'snow', txt: psum>(hourly?1.5:8)? 'Starker Schneefall':'Schnee'}
                      : {k:'rain', n, txt: psum>(hourly?2.5:10)? 'Starker Regen' : psum<(hourly?0.5:2) ? 'Leichter Regen' : 'Regen'};
  if(showers) return snow ? {k:'snowshower', txt:'Schneeschauer möglich'} : {k:'showers', n: Math.min(n, 2), txt:'Schauer möglich'};
  if(fog >= 0.4) return {k:'fog', txt:'Nebel'};
  if(cloud == null) return {k:'partly', txt:'–'};
  if(cloud < 20) return {k: isDay?'sun':'moon', txt: isDay?'Sonnig':'Klar'};
  if(cloud < 50) return {k: isDay?'mostlysun':'mostlymoon', txt: isDay?'Überwiegend sonnig':'Überwiegend klar'};
  if(cloud < 80) return {k: isDay?'partly':'partlynight', txt:'Teils bewölkt'};
  return {k:'cloud', txt:'Bewölkt'};
}
function hourCond(h){ return condition({cloud:h.cloud, psum:h.prcp||0, pprob:h.pr||0, thunder:h.thunder, fog:h.fog, temp:h.temp, isDay:h.isDay, hourly:true}); }

const SUNSYM = '<svg class="sunsym" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1"/></g></svg>';
const inflCell = (v, max) => `<div class="infl"><span>${Math.round(v*100)} %</span><i style="width:${Math.max(2, Math.round(v/max*22))}px"></i></div>`;
const shortName = m => m.id === WN.id ? 'WeatherNext' : m.name;
const SUNUP = '<svg class="srs" viewBox="0 0 24 24" aria-label="Aufgang"><path d="M5 18a7 7 0 0 1 14 0" fill="#ffd23f"/><path d="M2 20h20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12 3v7M9 6l3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SUNDOWN = '<svg class="srs" viewBox="0 0 24 24" aria-label="Untergang"><path d="M5 18a7 7 0 0 1 14 0" fill="#ff9a3c"/><path d="M2 20h20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M12 10V3M9 7l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Sonnenstunden: erwartet gegenüber astronomisch möglich (Sonnenaufgang bis -untergang)
function sunPossible(R, day, k){
  if(!R.sun || !R.sun.rise[k] || day.sunDay == null) return '';
  const max = (Date.parse(R.sun.set[k]) - Date.parse(R.sun.rise[k]))/3600e3, v = Math.min(day.sunDay, max);
  const exp = v < 0.5 ? 'kaum Sonne' : `${Math.round(v)} h Sonne`;
  return `${exp} von ${Math.round(max)} h möglichen`;
}
// Taupunkt (Magnus-Formel) und Luftdruck-Tendenz
function dewTxt(c){
  if(c.temp == null || c.rh == null) return '';
  const a = 17.62, b = 243.12, g = Math.log(Math.max(c.rh, 1)/100) + a*c.temp/(b + c.temp), td = b*g/(a - g);
  const feel = td >= 16 ? 'schwül' : c.rh >= 93 ? 'sehr feucht' : c.rh < 35 ? 'trocken' : '';
  return `Taupunkt ${r0(td)}°${feel ? '<br>' + feel : ''}`;
}
function presTxt(R){
  const a = R.hourly[R.nowIdx], b = R.hourly[R.nowIdx + 3];
  if(!a || !b || a.pres == null || b.pres == null) return '';
  const d = b.pres - a.pres, dd = (d > 0 ? '+' : '−') + Math.abs(Math.round(d)) + ' hPa in 3 h';
  if(Math.abs(d) < 1) return 'gleichbleibend<br>keine Wetteränderung absehbar';
  return d > 0 ? `steigt (${dd})<br>${d >= 3 ? 'Wetter beruhigt sich deutlich' : 'Wetter wird ruhiger'}`
               : `fällt (${dd})<br>${d <= -3 ? 'Wetter wird deutlich unbeständiger' : 'Wetter wird wechselhafter'}`;
}
const sunHrs = h => h < 0.5 ? 'kaum Sonne' : `${Math.round(h)} h Sonne`;
const DROPSYM = '<svg class="drop" viewBox="0 0 10 14" aria-hidden="true"><path d="M5 1C5 1 1 6.2 1 9a4 4 0 0 0 8 0C9 6.2 5 1 5 1z" fill="currentColor"/></svg>';
const SUN = '#ffd23f', CLOUD='#fff', DARK='#c9d3df', DROP='#5ec2ff', MOONC='#e9eefc';
function icon(k, n){
  const sun = (cx,cy,r)=>`<g stroke="${SUN}" stroke-width="2" stroke-linecap="round">${[0,45,90,135,180,225,270,315].map(a=>{const x=Math.cos(a*Math.PI/180),y=Math.sin(a*Math.PI/180);return `<line x1="${cx+x*(r+3)}" y1="${cy+y*(r+3)}" x2="${cx+x*(r+6)}" y2="${cy+y*(r+6)}"/>`}).join('')}</g><circle cx="${cx}" cy="${cy}" r="${r}" fill="${SUN}"/>`;
  const moon = (cx,cy,r)=>`<path d="M${cx+r*.3} ${cy-r} a${r} ${r} 0 1 0 ${r*.8} ${r*1.55} a${r*.8} ${r*.8} 0 0 1 -${r*.8} -${r*1.55}z" fill="${MOONC}"/>`;
  const cloud = (dx,dy,s,c)=>`<path transform="translate(${dx} ${dy}) scale(${s})" d="M7 19h11a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 7.1 9.4 4.8 4.8 0 0 0 7 19z" fill="${c||CLOUD}"/>`;
  const drops = n => [6,11,16].slice(0,n).map((x,i)=>`<line x1="${x+3}" y1="${24+(i%2)}" x2="${x+1.5}" y2="${28.5+(i%2)}" stroke="${DROP}" stroke-width="2.2" stroke-linecap="round"/>`).join('');
  const flakes = [7,12.5,18].map((x,i)=>`<circle cx="${x+1}" cy="${26+(i%2)*1.5}" r="1.6" fill="#fff"/>`).join('');
  const bolt = `<path d="M14 21l-3 5h3l-2 5 6-7h-3l2-3z" fill="${SUN}"/>`;
  const inner = {
    sun: sun(16,16,6.5), moon: moon(15,16,7),
    mostlysun: sun(12,12,5)+cloud(6,8,.85), mostlymoon: moon(11,11,5.5)+cloud(6,8,.85),
    partly: sun(11,11,5)+cloud(3,5,1.05), partlynight: moon(10,10,5.5)+cloud(3,5,1.05),
    cloud: cloud(-1,1,1.1,DARK)+cloud(3,5,1.0),
    showers: sun(11,9,4.5)+cloud(3,2,1.05)+drops(n||2), rain: cloud(2,0,1.15,DARK)+drops(n||3),
    snow: cloud(2,0,1.15,DARK)+flakes, sleet: cloud(2,0,1.15,DARK)+`<line x1="9" y1="24" x2="7.5" y2="28.5" stroke="${DROP}" stroke-width="2.2" stroke-linecap="round"/><circle cx="14" cy="27" r="1.6" fill="#fff"/><line x1="21" y1="24" x2="19.5" y2="28.5" stroke="${DROP}" stroke-width="2.2" stroke-linecap="round"/>`, snowshower: sun(11,9,4.5)+cloud(3,2,1.05)+flakes,
    thunder: cloud(2,-1,1.15,DARK)+bolt, fog: cloud(2,0,1.1,DARK)+`<g stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".85"><line x1="5" y1="25" x2="27" y2="25"/><line x1="8" y1="29" x2="24" y2="29"/></g>`,
  }[k] || '';
  return `<svg viewBox="0 0 32 32">${inner}</svg>`;
}
const tempColor = t => { // für Temperaturbalken
  const stops = [[-10,'#9ab4ff'],[0,'#7fd3ff'],[8,'#7ee0c3'],[15,'#c6e36a'],[22,'#ffd24a'],[28,'#ff9a3c'],[35,'#ff5a4a']];
  for(let i=1;i<stops.length;i++) if(t<=stops[i][0]) return stops[i][1];
  return stops[stops.length-1][1];
};

/* ================= Darstellung ================= */
let state = {place:null, res:null, mapLayers:null};

function render(place, R){
  $('#btnLoc').style.opacity = 1;
  if(!R.days.length || !R.cur){ $('#app').innerHTML = `<div class="hero"><div class="place">${esc(place.name)}</div></div><div class="err">Für diesen Ort liegen gerade keine vollständigen Vorhersagedaten vor. Zum erneuten Versuch nach unten ziehen.</div>`; return; }
  const c = R.cur, today = R.days[0];
  const hc = nowCond(R);
  // Hintergrund
  const cls = [];
  if(!c.isDay) cls.push('night');
  if(['rain','thunder','showers'].includes(hc.k)) cls.push('rain'); else if(hc.k.startsWith('snow') || hc.k === 'sleet') cls.push('snow'); else if(c.cloud>75 || hc.k==='fog') cls.push('overcast');
  document.body.className = cls.join(' ') + (document.body.classList.contains('mapopen') ? ' mapopen' : '');
  requestAnimationFrame(() => { const c1 = getComputedStyle(document.body).getPropertyValue('--bg1').trim();
    if(c1){ document.querySelector('meta[name=theme-color]').setAttribute('content', c1); document.documentElement.style.background = c1; } });

  const afterWin = +R.now.slice(11,13) >= WIN_END;
  const hlDay = afterWin && R.days[1] ? R.days[1] : today;
  const hlLabel = afterWin ? 'Morgen 8–20 Uhr' : 'Heute 8–20 Uhr';

  // Text-Zusammenfassung
  const summary = makeSummary(R);

  // Stunden: nächste 26 h
  const hrs = R.hourly.slice(R.nowIdx, R.nowIdx+26).map((h, j) => {
    const hh = +h.t.slice(11,13);
    const inWin = hh>=WIN_START && hh<=WIN_END;
    const pr = h.pr!=null && h.pr>=0.2 && h.prcp>=0.05 ? DROPSYM + Math.round(h.pr*10)*10+'%' : '';
    return `<div class="hr ${inWin?'win':'out'}"><div class="t">${j===0?'Jetzt':String(hh).padStart(2,'0')}</div>
      <div class="p">${pr}</div>${j===0 ? `<span class="nowi">${(c => icon(c.k, c.n))(nowCond(R))}</span>` : (c => icon(c.k, c.n))(hourCond(h))}<div class="h">${r0(h.temp)}°</div></div>`;
  }).join('');

  // 10 Tage
  const gMin = Math.min(...R.days.map(d=>d.tmin)), gMax = Math.max(...R.days.map(d=>d.tmax));
  const span = Math.max(1, gMax-gMin);
  const days = R.days.map((d,i) => {
    const l = (d.tmin-gMin)/span*100, w = (d.tmax-d.tmin)/span*100;
    const grad = `linear-gradient(90deg, ${tempColor(d.tmin)}, ${tempColor(d.tmax)})`;
    const dot = i===0 && !afterWin && c.temp!=null ? `<b style="left:calc(${clamp((c.temp-gMin)/span*100,0,100)}% - 4.5px)"></b>` : '';
    const pp = d.pprob>=0.15 ? DROPSYM + Math.round(d.pprob*10)*10+'%' + (d.psum >= 0.1 ? `<span class="amt">${d.psum < 0.95 ? '<1' : Math.round(d.psum)} mm</span>` : '') : '';
    // „unsicher“ nur in den ersten 6 Tagen: danach ist jede Vorhersage unsicher, der Hinweis wäre nur Rauschen
    const night = d.range && i <= 5 && d.range.width >= 4.5 + 0.6*Math.max(0, i-2) ? `<div class="nightrain unsure">unsicher</div>`
                : d.nightP!=null && d.nightP>=1 && d.pprob < 0.3 && d.psum < 0.5 ? `<div class="nightrain">Regen nachts</div>` : '';
    return `<div class="row" data-i="${i}"><div class="d">${dayName(d.d,i)}${night}</div>${icon(d.cond.k, d.cond.n)}<div class="pp">${pp}</div>
      <div class="mn">${r0(d.tmin)}°</div><div class="bar"><i style="left:${l}%;width:${Math.max(w,3)}%;background:${grad}"></i>${dot}</div><div class="mx">${r0(d.tmax)}°</div></div>
      <div class="detail" id="det${i}"></div>`;
  }).join('');

  // Kacheln
  const wdir = '';
  const sd = afterWin && R.sun && R.sun.rise[1] ? 1 : 0;
  const sunRS = R.sun ? `<span>${SUNUP}${R.sun.rise[sd].slice(11,16)}</span><span>${SUNDOWN}${R.sun.set[sd].slice(11,16)}</span>` : '–';
  const pDay = (hlDay.fullDay ? (hlDay.fullDay.pEarly||0) + (hlDay.fullDay.pLate||0) : 0) + (hlDay.psum||0);
  const pToday = hlDay.psum;

  $('#app').innerHTML = `
  <div class="hero" id="hero">
    <div class="place-row"><div class="place">${esc(place.name)}</div><button class="star ${isFav(place)?'on':''}" id="star" aria-label="Favorit">${isFav(place)?'★':'☆'}</button></div>
    ${favDots(place)}
    <div class="temp">${r0(c.temp)}°</div>
    ${R.curObs ? `<div class="measured">${R.curObs.t.toLocaleString("de-DE",{minimumFractionDigits:1,maximumFractionDigits:1})}° gemessen an ${R.curObs.name.startsWith('LMU') ? 'der ' : 'der Station '}${esc(R.curObs.name)}${R.curObs.dist >= 1 ? ` (${fmt1(R.curObs.dist)} km ${R.curObs.fromYou ? 'von dir' : 'vom Ortszentrum'})` : ''}, ${R.curObs.age < 2 ? 'gerade eben' : `vor ${Math.round(R.curObs.age)} Min.`}</div>` : ''}
    <div class="cond">${hc.txt}</div>
    <div class="hl">H: ${r0(hlDay.tmax)}°  T: ${r0(hlDay.tmin)}°${hlDay.sunH!=null ? `<span class="sun">${SUNSYM}${sunHrs(hlDay.sunH)}</span>` : ''}</div>
    <div class="sub">${hlLabel} · Konsens aus ${R.avail.length} Modellen</div>
    <div class="updated">${updatedTxt()}</div>
  </div>

  ${warnBlock(R)}
  ${state.warn ? `<div class="err">${state.warn}</div>`:''}

  <div class="card">
    <div class="note">${summary}</div>
    ${rainChart(R)}
    <div class="hours">${hrs}</div>
  </div>

  <div class="card">
    <h3>${svgCal()} 10-Tage-Vorhersage · 8–20 Uhr</h3>
    <div class="legend">${DROPSYM} Regenwahrscheinlichkeit zwischen 8 und 20 Uhr</div>
    <div class="days">${histRow(R, gMin, gMax)}${days}</div>
  </div>

  <div class="grid">
    <div class="card"><h3>Gefühlt</h3><div class="tile"><div class="v">${r0(c.feels)}°</div><div class="s">${feelTxt(c)}</div></div></div>
    <div class="card"><h3>Niederschlag ${afterWin?'morgen':'heute'}</h3><div class="tile"><div class="v">${fmt1(pDay)} mm</div><div class="s">ganzer Tag<br><span style="white-space:nowrap">8–20 Uhr: ${fmt1(pToday)} mm</span> · <span style="white-space:nowrap">${Math.round((hlDay.pprob||0)*100)} %</span></div></div></div>
    <div class="card"><h3>Wind</h3><div class="tile"><div class="v">${r0(c.wind)} <span style="font-size:16px">km/h</span></div><div class="s">Böen bis ${r0(c.gust)} km/h</div></div></div>
    <div class="card"><h3>Sonne</h3><div class="tile"><div class="v sunv">${sunRS}</div><div class="s">${sunPossible(R, hlDay, sd)}</div></div></div>
    <div class="card"><h3>Luftfeuchte</h3><div class="tile"><div class="v">${r0(c.rh)} %</div><div class="s">${dewTxt(c)}</div></div></div>
    <div class="card"><h3>Luftdruck</h3><div class="tile"><div class="v">${c.pres != null ? Math.round(c.pres) : '–'} <span style="font-size:16px">hPa</span></div><div class="s">${presTxt(R)}</div></div></div>
  </div>

  <div class="card mapcard">
    <h3>${svgRadar()} Niederschlagsradar</h3>
    <div class="mapwrap"><div id="map"></div>
      <button class="expand" id="mapToggle" aria-label="Karte vergrößern"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg></button></div>
    <div class="mapbar">
      <button class="chip on" data-l="radar">Radar</button>
      <button class="chip" data-l="warn">DWD-Warnungen</button>
      <span class="plegend"><i style="background:linear-gradient(90deg,#62d6ff,#1466c8)"></i>Regen <i style="background:linear-gradient(90deg,#ffb0de,#cc2f93)"></i>Schnee <i style="background:linear-gradient(90deg,#d3c2ff,#6340c9)"></i>Schneeregen</span>
      <span style="margin-left:auto">Radar: DWD (nur Deutschland) · Karte © <a href="https://www.openstreetmap.org/copyright" style="color:inherit">OpenStreetMap</a></span>
    </div>
  </div>

  <div class="card models">
    <h3 id="howToggle" class="fold">${svgScale()} Wie diese Vorhersage entsteht <span class="chev">›</span></h3>
    <div class="teaser">${teaser(R)}</div>
    <div class="foldbody">
    <div class="explain">
      <p>Statt einem Wettermodell zu vertrauen, kombiniert diese Seite <b>${R.avail.length} Modelle</b> großer Wetterdienste, darunter drei KI-Modelle. Jedes Modell wird laufend mit echten Messwerten verglichen: Wer an diesem Ort zuletzt besser lag, bekommt mehr <b>Anteil</b>, und typische Fehler werden herausgerechnet.</p>
    </div>
    ${trackBlock(R)}
    ${modelTable(R)}
    <div class="explain">
      <p><b>Fehler:</b> So weit lag das Modell hier in den letzten 4 Wochen im Schnitt daneben (Temperatur für den nächsten Tag, nach Ortskorrektur).</p>
      <p><b>Anteil:</b> wie stark das Modell in die App-Prognose eingeht. In den ersten Tagen zählt die Mischung, die hier zuletzt am besten traf, getrennt für Tag und Nacht. Ab Tag 6 zählt vor allem ECMWF AIFS, langfristig das stärkste Modell für Deutschland.</p>
      <p><b>Tageswerte</b> gelten für 8–20 Uhr. Tippe auf einen Tag für Details und alle Modelle.</p>
      <p><b>Regenwahrscheinlichkeit und Spannen</b> stammen aus ${Object.values(R.members).reduce((s,m)=>s+m.P.length,0)} leicht variierten Rechenläufen von Google, ECMWF und DWD.${R.ST && R.ST.elev!=null ? ` Ort auf ${Math.round(R.ST.elev)} m Höhe${R.ST.hilly? '; im bergigen Gelände zählen fein aufgelöste Modelle (ICON-D2, AROME) in den ersten Tagen mehr':''}.`:''}</p>
      <p class="muted">Google WeatherNext liefert keine Archivdaten; es geht mit festem Anteil ein und erhält die durchschnittliche Ortskorrektur der anderen Modelle.</p>
    </div>
    </div>
  </div>

  <div class="foot">Daten: <a href="https://open-meteo.com/">Open-Meteo</a> (CC BY 4.0) · ECMWF · DWD · NOAA · Météo-France · UK Met Office · Google DeepMind<br>
  Messwerte: ${R.ST && R.ST.station && R.ST.station.by.includes('LMU') ? 'Meteorologisches Institut der LMU München (Stadtstation)' : '<a href="https://brightsky.dev/">Bright Sky</a> / Deutscher Wetterdienst'}<br>
  Radar, Kurzfristvorhersage &amp; Warnungen: <a href="https://www.dwd.de/">Deutscher Wetterdienst</a> (über Bright Sky) · Karte © OpenStreetMap-Mitwirkende<br>
  <details style="margin:8px auto 6px;max-width:460px;text-align:left"><summary style="text-align:center;cursor:pointer">Datenschutz</summary>
  <div style="margin-top:6px;line-height:1.5">Diese Seite hat keinen eigenen Server und speichert nichts über dich. Favoriten und zuletzt gesuchte Orte bleiben nur auf deinem Gerät. Für die Wetterdaten fragt dein Gerät direkt bei Open-Meteo, Bright Sky (Daten des Deutschen Wetterdienstes), dem DWD-Kartendienst und OpenStreetMap an; nur wenn du „Standort“ antippst, auch bei BigDataCloud für den Ortsnamen. Diese Dienste sehen dabei deine IP-Adresse und den gesuchten Ort, auf etwa 1 km gerundet. Gehostet bei GitHub Pages.</div></details>
  Stand: ${R.meta.generated_at_local || R.now.replace('T',' ')} · Modelllauf-Abruf ${new Date(state.fetched||Date.now()).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}</div>`;

  document.querySelectorAll('.days .row[data-i]').forEach(r => r.onclick = () => toggleDetail(+r.dataset.i));
  const hr = document.querySelector('.days .row.past'); if(hr) hr.onclick = () => toggleHist();
  document.querySelectorAll('.warn').forEach(w => w.onclick = () => w.classList.toggle('open'));
  $('#howToggle').onclick = $('.models .teaser').onclick = () => $('.models').classList.toggle('open');
  $('#star').onclick = () => { toggleFav(place); render(place, R); };
  swipeFavs();
  try{ initMap(place); }catch(e){ const m = $('#map'); if(m) m.innerHTML = '<div class="loading" style="padding:120px 0">Karte gerade nicht verfügbar</div>'; }
}

// ===== Rückblick: Wie war es wirklich – und was war vorhergesagt? =====
let histK = null;                                   // gezeigter Tag im Rückblick (Index in hist.days)
const fmtDay = iso => { const d = new Date(iso + 'T12:00:00Z'); return WD[d.getUTCDay()] + ', ' + d.getUTCDate() + '.' + (d.getUTCMonth()+1) + '.'; };
function histRow(R, gMin, gMax){
  const H = R.ST && R.ST.hist; if(!H || !H.days.length) return '';
  const d = H.days[H.days.length-1], o = d.o, span = Math.max(1, gMax - gMin);
  const yest = new Date(Date.parse(R.days[0].d + 'T12:00:00Z') - 864e5).toISOString().slice(0,10);
  const l = clamp((o.tmin-gMin)/span*100, 0, 100), w = clamp((o.tmax-o.tmin)/span*100, 3, 100 - l);
  const rain = o.rain != null && o.rain >= 0.1 ? `<span class="amt">${o.rain < 0.95 ? '<1' : Math.round(o.rain)} mm</span>` : '';
  return `<div class="row past"><div class="d">${d.d === yest ? 'Gestern' : WD[new Date(d.d+'T12:00:00Z').getUTCDay()]}<div class="nightrain">gemessen</div></div><div class="ist"></div><div class="pp">${rain}</div>
    <div class="mn">${r0(o.tmin)}°</div><div class="bar"><i style="left:${l}%;width:${w}%;background:linear-gradient(90deg,${tempColor(o.tmin)},${tempColor(o.tmax)})"></i></div><div class="mx">${r0(o.tmax)}°</div></div>
    <div class="detail" id="detH"></div>`;
}
function toggleHist(forceOpen){
  const el = document.getElementById('detH'), H = state.res && state.res.ST && state.res.ST.hist; if(!el || !H) return;
  if(histK == null || histK >= H.days.length) histK = H.days.length - 1;
  el.innerHTML = histDetail(H, histK);
  el.classList.toggle('open', forceOpen === true ? true : !el.classList.contains('open'));
  toggleHistBind(el, H);
}
function toggleHistBind(el, H){ el.querySelectorAll('[data-k]').forEach(b => b.onclick = ev => { ev.stopPropagation(); histK = +b.dataset.k; el.innerHTML = histDetail(H, histK); toggleHistBind(el, H); }); }
function histChart(d){
  const W = 300, L = 26, Rr = 22, top = 14, Ht = 104, gap = 30, Hp = 34, all = [...d.obsH, ...d.ourH].filter(v => v != null);
  if(all.length < 10) return '';
  const x = h => L + h/23*(W-L-Rr);
  // Temperatur
  const lo0 = Math.min(...all), hi0 = Math.max(...all), stp = hi0 - lo0 <= 5 ? 1 : hi0 - lo0 <= 12 ? 2 : 5;
  const lo = Math.floor((lo0 - .5)/stp)*stp, hi = Math.ceil((hi0 + .5)/stp)*stp;
  const y = t => top + (hi - t)/(hi - lo)*(Ht - top);
  const line = (a, attrs) => { let p = '', pen = false; a.forEach((v,h) => { if(v == null){ pen = false; return; } p += (pen ? 'L' : 'M') + x(h).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; }); return `<path d="${p}" fill="none" ${attrs}/>`; };
  let grid = '';
  for(let t = lo; t <= hi + 1e-9; t += stp){
    const z = Math.abs(t) < 1e-9;
    grid += `<line x1="${L}" x2="${W-Rr}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="${z ? '#9fd3ff' : 'rgba(243,238,228,.13)'}" stroke-width="${z ? 1.4 : 1}"${z ? '' : ' stroke-dasharray="2 3"'}/>`
          + `<text x="${L-4}" y="${(y(t)+3).toFixed(1)}" text-anchor="end"${z ? ' style="fill:#9fd3ff"' : ''}>${t}°</text>`;
  }
  // Niederschlag: eigener Bereich darunter, gleiche Zeitachse, eigene Skala in mm pro Stunde
  const pv = [...d.obsP, ...d.ourP].filter(v => v != null), pm = Math.max(...pv, 0);
  const wetDay = pm >= 0.05, p0 = Ht + gap, pTop = [0.5, 1, 2, 5, 10, 20, 50].find(v => v >= pm) || 50;
  const yp = v => p0 + Hp - Math.min(1, v/pTop)*Hp;
  let pgrid = '', pbars = '';
  if(wetDay){
    // eigener, abgesetzter Bereich: Überschrift, Skala rechts (die Temperaturskala steht links)
    pgrid = `<line x1="0" x2="${W}" y1="${Ht+10}" y2="${Ht+10}" stroke="rgba(243,238,228,.22)"/>`
          + `<rect x="${L}" y="${p0}" width="${W-L-Rr}" height="${Hp}" fill="rgba(124,196,255,.06)"/>`
          + `<text x="0" y="${p0-5}" class="ph">Niederschlag in mm/h</text>`
          + [pTop, pTop/2].map(v => `<line x1="${L}" x2="${W-Rr}" y1="${yp(v)}" y2="${yp(v)}" stroke="rgba(124,196,255,.22)" stroke-dasharray="2 3"/><text x="${W-Rr+4}" y="${yp(v)+3}" class="pl">${v.toLocaleString('de-DE')}</text>`).join('')
          + `<line x1="${L}" x2="${W-Rr}" y1="${yp(0)}" y2="${yp(0)}" stroke="rgba(243,238,228,.3)"/><text x="${W-Rr+4}" y="${yp(0)+3}" class="pl">0</text>`;
    const bw = (W-L-Rr)/24*0.62;
    pbars = d.obsP.map((v,h) => v > 0.05 ? `<rect x="${(x(h)-bw/2).toFixed(1)}" y="${yp(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(p0+Hp-yp(v)).toFixed(1)}" rx="1" fill="#7cc4ff"/>` : '').join('')
          + d.ourP.map((v,h) => v > 0.05 ? `<rect x="${(x(h)-bw/2).toFixed(1)}" y="${yp(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(p0+Hp-yp(v)).toFixed(1)}" rx="1" fill="none" stroke="#d9b26f" stroke-width="1.2" stroke-dasharray="2 2"/>` : '').join('');
  }
  const Hb = wetDay ? p0 + Hp : Ht;
  const win = `<rect x="${x(WIN_START)}" y="0" width="${x(WIN_END)-x(WIN_START)}" height="${Ht}" fill="rgba(243,238,228,.06)"/>`
            + (wetDay ? `<rect x="${x(WIN_START)}" y="${p0}" width="${x(WIN_END)-x(WIN_START)}" height="${Hp}" fill="rgba(243,238,228,.06)"/>` : '')
            + `<text x="${(x(WIN_START)+x(WIN_END))/2}" y="9" text-anchor="middle" class="wl">Tageswerte 8–20 Uhr</text>`;
  const ticks = [[0,'0 Uhr','start'],[6,'6','middle'],[12,'12','middle'],[18,'18','middle'],[23,'24','end']].map(([h,t,a]) => `<text x="${x(h)}" y="${Hb+13}" text-anchor="${a}">${t}</text>`).join('');
  return `<svg class="histchart" viewBox="0 0 ${W} ${Hb+16}">${win}${grid}${pgrid}${pbars}${line(d.ourH, 'stroke="#d9b26f" stroke-width="2" stroke-dasharray="5 4"')}${line(d.obsH, 'stroke="#f3eee4" stroke-width="2.4" stroke-linejoin="round"')}${ticks}</svg>
    <div class="histleg"><span><i class="m"></i>gemessen</span><span><i class="f"></i>App-Prognose vom Vortag</span>${wetDay ? '<span><i class="r"></i>Niederschlag an der Wetterstation gemessen</span>' : '<span>kein Niederschlag</span>'}</div>`;
}
function histDetail(H, k){
  const d = H.days[k], o = d.o, f = d.f, st = state.res.ST.station;
  const mm = v => v == null ? '–' : v < 0.05 ? 'trocken' : fmt1(v) + ' mm';
  const dv = (a, b) => { const x = Math.round(a) - Math.round(b); return x === 0 ? 'getroffen' : `${Math.abs(x)}° zu ${x > 0 ? 'warm' : 'kalt'}`; };
  const wetO = o.rain != null && o.rain >= 0.5, wetF = f.rain != null && f.rain >= 0.5;
  const rainV = o.rain == null || f.rain == null ? '' : wetO === wetF ? (wetO ? 'Regen richtig vorhergesagt' : 'kein nennenswerter Regen, wie vorhergesagt')
    : wetO ? (f.rain >= 0.1 ? 'mehr Regen als vorhergesagt' : 'Regen nicht vorhergesagt')
           : (o.rain >= 0.05 ? 'weniger Regen als vorhergesagt' : 'Regen vorhergesagt, blieb aber trocken');
  const nm = id => (MODELS.find(m => m.id === id) || {name:id}).name;
  const err = m => Math.abs(m.tmax - o.tmax) + Math.abs(m.tmin - o.tmin);
  // Platzierung nach Treffsicherheit (Abweichung bei Hoch + Tief), die App-Prognose zählt mit
  // Platz = 1 + Anzahl der Vorhersagen, die echt besser lagen (gleich gute teilen sich den Platz)
  const re = m => Math.abs(r0(m.tmax) - r0(o.tmax)) + Math.abs(r0(m.tmin) - r0(o.tmin));
  // bei gleicher Temperatur-Abweichung entscheidet die Niederschlagsmenge (auf 0,1 mm gerundet)
  // danach die genaue (ungerundete) Temperatur-Abweichung, sodass gleiche Plätze praktisch nicht mehr vorkommen
  const rr = m => m.rain == null || o.rain == null ? Infinity : Math.abs(Math.round(m.rain*10) - Math.round(o.rain*10));
  const cmp = (a, b) => re(a) - re(b) || rr(a) - rr(b) || err(a) - err(b);
  const appM = {tmin:f.tmin, tmax:f.tmax, rain:f.rain}, pool = [appM, ...d.models];
  const place = m => { const k = 1 + pool.filter(x => cmp(x, m) < 0).length; return k <= 3 ? `<i class="rank r${k}">${k}</i>` : '<i class="rank"></i>'; };
  const rows = d.models.slice().sort((a,b) => cmp(a, b) || err(a) - err(b)).map(m => `<div class="hrow"><div class="n">${place(m)}${nm(m.id)}</div><div>${r0(m.tmin)}°</div><div>${r0(m.tmax)}°</div><div>${m.rain == null ? '–' : fmt1(m.rain)}</div></div>`).join('');
  const nav = `<div class="histnav">${k > 0 ? `<button data-k="${k-1}" aria-label="Tag davor">‹</button>` : '<span></span>'}<b>${fmtDay(d.d)}</b>${k < H.days.length-1 ? `<button data-k="${k+1}" aria-label="Tag danach">›</button>` : '<span></span>'}</div>`;
  return `${nav}
    ${histChart(d)}
    <div class="dline">App-Prognose: Höchstwert ${dv(f.tmax, o.tmax)}, Tiefstwert ${dv(f.tmin, o.tmin)}${rainV ? ', ' + rainV : ''}.</div>
    <div class="dsec">Vorhersagen vom Vortag (8–20 Uhr)</div>
    <div class="hrow head"><div class="n"></div><div>Tief</div><div>Hoch</div><div>mm</div></div>
    <div class="hrow obs"><div class="n"><i class="rank"></i>Gemessen</div><div>${r0(o.tmin)}°</div><div>${r0(o.tmax)}°</div><div>${o.rain == null ? '–' : fmt1(o.rain)}</div></div>
    <div class="hrow cons"><div class="n">${place(appM)}App-Prognose</div><div>${r0(f.tmin)}°</div><div>${r0(f.tmax)}°</div><div>${f.rain == null ? '–' : fmt1(f.rain)}</div></div>
    ${rows}
    <div class="hint" style="margin-top:6px"><i class="rank r1">1</i><i class="rank r2">2</i><i class="rank r3">3</i> Platz nach Treffsicherheit bei Hoch und Tief, bei Gleichstand entscheidet der Niederschlag. An der Wetterstation gemessener Niederschlag (${esc(st ? st.name : 'Wetterstation')}).</div>`;
}

// Tagesdetail: Inhalt wird beim ersten Öffnen erzeugt
function toggleDetail(i, forceOpen){
  const el = document.getElementById('det' + i); if(!el || !state.res || !state.res.days[i]) return;
  if(!el.innerHTML) el.innerHTML = dayDetail(state.res.days[i], i);
  el.classList.toggle('open', forceOpen === true ? true : !el.classList.contains('open'));
}
function dayDetail(d, i){
  const F = d.fullDay;
  const hrs = F.hours.map(h => {
    const hh = +h.t.slice(11,13), inWin = hh>=WIN_START && hh<=WIN_END;
    const pr = h.pr!=null && h.pr>=0.2 && h.prcp>=0.05 ? DROPSYM + Math.round(h.pr*10)*10+'%' : '';
    return `<div class="hr ${inWin?'win':'out'}"><div class="t">${String(hh).padStart(2,'0')}</div><div class="p">${pr}</div>${(c => icon(c.k, c.n))(hourCond(h))}<div class="h">${r0(h.temp)}°</div></div>`;
  }).join('');
  const mm = v => v==null ? '–' : (v<0.05 ? 'trocken' : fmt1(v)+' mm');
  const lo = Math.min(...d.byModel.map(x=>x.tmin), d.tmin), hi = Math.max(...d.byModel.map(x=>x.tmax), d.tmax), sp = Math.max(1, hi-lo);
  const bar = (a,b) => `<div class="bar"><i style="left:${(a-lo)/sp*100}%;width:${Math.max((b-a)/sp*100,4)}%;background:linear-gradient(90deg,${tempColor(a)},${tempColor(b)})"></i></div>`;
  const maxShare = Math.max(...d.byModel.map(x=>x.share));
  const rows = d.byModel.slice().sort((a,b)=>b.share-a.share).map(x => `<div class="mrow">
    <div class="n">${shortName(x.m)}</div>
    <div class="r">${r0(x.tmin)}°</div>${bar(x.tmin,x.tmax)}<div>${r0(x.tmax)}°</div>
    <div class="r">${x.psum==null?'–':fmt1(x.psum)}</div>
    ${inflCell(x.share, maxShare)}</div>`).join('');
  return `
    <div class="dsec">Ganzer Tag (0–24 Uhr)</div>
    <div class="hours">${hrs}</div>
    <div class="kv">
      <div>Temperatur</div><div>${r0(F.tmin)}° bis ${r0(F.tmax)}°${r0(F.tmin) !== r0(d.tmin) || r0(F.tmax) !== r0(d.tmax) ? ` <span>(8–20 Uhr: ${r0(d.tmin)}° bis ${r0(d.tmax)}°)</span>` : ''}</div>
      <div>Niederschlag</div><div>${(() => { const rest = (F.pEarly||0) + (F.pLate||0);
        return d.psum < 0.05 && rest < 0.05 ? 'trocken' : `${mm(d.psum)} <span>(8–20 Uhr)</span>${rest >= 0.05 ? ` <span>· sonst ${mm(rest)}</span>` : ''}`; })()}</div>
      ${d.sunH!=null ? `<div>Sonne</div><div>${d.sunH<0.5 ? 'kaum' : 'etwa ' + Math.round(d.sunH) + ' h'}${d.sunM.length>=2 && Math.round(Math.max(...d.sunM)) > Math.round(Math.min(...d.sunM)) ? ` <span>· Modelle ${Math.round(Math.min(...d.sunM))}–${Math.round(Math.max(...d.sunM))} h</span>` : ''}</div>` : ''}
    </div>
    ${certainty(d)}
    <div class="dsec">Die Modelle und ihr Anteil an der App-Prognose (8–20 Uhr)</div>
    <div class="mrow head"><div></div><div class="r">Tief</div><div></div><div>Hoch</div><div class="r">mm</div><div>Anteil</div></div>
    <div class="mrow cons"><div class="n">App-Prognose</div><div class="r">${r0(d.tmin)}°</div>${bar(d.tmin,d.tmax)}<div>${r0(d.tmax)}°</div><div class="r">${fmt1(d.psum)}</div><div></div></div>
    ${rows}`;
}

// Regenbalken: nur sichtbar, wenn in den nächsten 2 Stunden laut Radar Regen fällt
function rainChart(R){
  const NC = R.NC; if(!NC) return '';
  const now = Date.now(), fr = NC.frames.filter(f => f.ms >= now - 5*60e3 && f.ms <= now + 120*60e3);
  const ch = NC.change();
  if(fr.length < 6 || !(NC.rateNow >= 0.1 || (ch && ch.wet))) return '';
  // Skala in mm pro Stunde, passt sich an die stärkste Stunde an (0,5 … 50 mm/h)
  const W = 300, H = 70, L0 = 34, top = 8, bw = (W - L0)/fr.length;
  const mx = Math.max(...fr.map(f => f.mm*12)), top_ = [0.5, 1, 2, 5, 10, 20, 50].find(v => v >= mx) || 50;
  const y = v => H - Math.min(1, v/top_)*(H - top);
  // Farbe nach Niederschlagsart: jetzt gemessen, später nach vorhergesagter Temperatur
  const PCOL = {Regen:'#7fb8e6', Schnee:'#ff9fd6', Schneeregen:'#b49bff', Niederschlag:'#a9c3da', Graupel:'#ffd447', Hagel:'#ffa43d', 'gefrierender Regen':'#45e285'};
  const used = new Set();
  const bars = fr.map((f,i) => { const v = f.mm*12; if(v <= 0) return ''; const h = Math.max(1.5, H - y(v));
    const P = f.ms <= now + 20*60e3 ? ptypeAt(R, R.nowIdx, true) : ptypeAt(R, R.nowIdx + Math.round((f.ms - now)/3600e3));
    used.add(P.noun);
    return `<rect x="${(L0 + i*bw + 0.8).toFixed(1)}" y="${(H-h).toFixed(1)}" width="${(bw-1.6).toFixed(1)}" height="${h.toFixed(1)}" rx="1.2" fill="${PCOL[P.noun] || '#7fb8e6'}"/>`; }).join('');
  const kinds = [...used].filter(k => k !== 'Regen' || used.size > 1);
  const nf = v => v.toLocaleString('de-DE');
  const grid = [top_, top_/2].map(v => `<line x1="${L0}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(243,238,228,.14)" stroke-dasharray="2 3"/><text x="${L0-4}" y="${y(v)+3}" text-anchor="end">${nf(v)}</text>`).join('')
    + `<line x1="${L0}" x2="${W}" y1="${H-0.5}" y2="${H-0.5}" stroke="rgba(243,238,228,.25)"/><text x="${L0-4}" y="${H}" text-anchor="end">0</text>`;
  const word = mx < 2.5 ? 'leicht' : mx < 10 ? 'mäßig' : 'kräftig';           // Einteilung wie beim DWD
  const t = ms => new Date(ms).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
  return `<div class="rain2h"><div class="rlab">Niederschlag laut Radar in mm/h · bis ${nf(Math.round(mx*10)/10)} mm/h (${word})${kinds.length ? '<br>' + kinds.map(k => `<i class="pk" style="background:${PCOL[k]}"></i>${k}`).join(' ') : ''}</div><svg viewBox="0 0 ${W} ${H}">${grid}${bars}</svg>
    <div class="ax" style="padding-left:${(L0/W*100).toFixed(1)}%"><span>Jetzt</span><span>${t(now+30*60e3)}</span><span>${t(now+60*60e3)}</span><span>${t(now+90*60e3)}</span><span>${t(now+120*60e3)}</span></div></div>`;
}

// Warnungen: in Deutschland amtlich (DWD), sonst eigene Hinweise aus den Modellen
function warnBlock(R){
  const fmtT = iso => { const d = new Date(iso); return WD[d.getDay()] + ' ' + d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}); };
  const A = R.alerts && R.alerts.alerts;
  if(A){
    const now = Date.now(), rank = {extreme:4, severe:3, moderate:2, minor:1};
    // gleiche Warnart zusammenfassen (DWD schickt oft mehrere Zeitabschnitte)
    const by = {};
    for(const a of A.filter(a => Date.parse(a.expires || a.onset) > now && a.status === 'actual' && a.category === 'met')){
      const k = a.event_de, b = by[k];
      if(!b) by[k] = {...a};
      else { if(a.onset < b.onset) b.onset = a.onset; if(a.expires > b.expires) b.expires = a.expires;
             if((rank[a.severity]||0) > (rank[b.severity]||0)){ b.severity = a.severity; b.description_de = a.description_de; b.instruction_de = a.instruction_de; } }
    }
    const act = Object.values(by).sort((a,b) => (rank[b.severity]||0) - (rank[a.severity]||0)).slice(0,3);
    return act.map(a => `<div class="warn ${a.severity}"><b>⚠︎ ${esc(cap(a.event_de))}</b><small>DWD · ${Date.parse(a.onset) > now ? 'ab ' + fmtT(a.onset) + ' ' : ''}bis ${fmtT(a.expires)} · antippen für Details</small>
      <div class="more">${esc(a.description_de || '')}${a.instruction_de ? '\n\n' + esc(a.instruction_de) : ''}</div></div>`).join('');
  }
  // Ausland: Hinweise aus dem Modell-Konsens der nächsten 48 Stunden
  const H = R.hourly.slice(R.nowIdx, R.nowIdx + 48), out = [];
  const g = Math.max(...H.map(h => h.gust || 0)); if(g >= 65) out.push(`Sturmböen bis ${r0(g)} km/h möglich`);
  let rr = 0; for(let i=0;i<H.length;i++){ let s=0; for(let j=i;j<Math.min(H.length,i+24);j++) s += H[j].prcp || 0; rr = Math.max(rr, s); }
  if(rr >= 25) out.push(`Starkregen möglich, bis ${r0(rr)} mm in 24 Stunden`);
  if(H.some(h => h.thunder >= 0.4)) out.push('Gewitter möglich');
  const tx = Math.max(...H.map(h => h.temp ?? -99)), tn = Math.min(...H.map(h => h.temp ?? 99));
  if(tx >= 32) out.push(`Hitze bis ${r0(tx)}°`); if(tn <= -10) out.push(`Strenger Frost bis ${r0(tn)}°`);
  if(!out.length) return '';
  return `<div class="warn hint"><b>Hinweis: ${out.join(' · ')}</b><small>Aus den Wettermodellen, keine amtliche Warnung · antippen</small>
    <div class="more">Für diesen Ort liegen keine amtlichen Warnungen vor, weil der Deutsche Wetterdienst nur Deutschland abdeckt. Amtliche Warnungen für Europa: meteoalarm.org</div></div>`;
}
const cap = t => { t = String(t||'').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };

// Favoriten
const favs = () => store.get('wx:favs') || [];
const sameP = (a,b) => Math.abs(a.lat-b.lat) < 0.01 && Math.abs(a.lon-b.lon) < 0.01;
const isFav = p => favs().some(f => sameP(f,p));
function toggleFav(p){ const f = favs(); store.set('wx:favs', isFav(p) ? f.filter(x => !sameP(x,p)) : f.concat([{name:p.name, lat:p.lat, lon:p.lon, region:p.region}])); }
function favDots(p){ const f = favs(); if(f.length < 2) return ''; const i = f.findIndex(x => sameP(x,p));
  return `<div class="dots">${f.map((x,k) => `<i class="${k===i?'on':''}"></i>`).join('')}</div>`; }
function swipeFavs(){
  const el = $('#hero'); if(!el) return; let x0 = null, y0 = null;
  el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, {passive:true});
  el.addEventListener('touchend', e => {
    if(x0 == null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    const f = favs(); if(f.length < 2 || Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
    let i = f.findIndex(x => sameP(x, state.place)); i = (i < 0 ? 0 : i + (dx < 0 ? 1 : -1) + f.length) % f.length;
    setPlace(f[i]);
  });
}

function certainty(d){
  const parts = [];
  if(d.range){
    const w = d.range.width;
    const cls = w < 3 ? ['good','ziemlich sicher'] : w < 5 ? ['mid','etwas unsicher'] : ['bad','unsicher'];
    parts.push(`<div class="dline" style="margin-bottom:4px"><span class="sure ${cls[0]}">Temperatur ${cls[1]}</span></div>`);
    parts.push(`<div class="dline">Höchstwert wahrscheinlich ${r0(d.range.hi[0])}° bis ${r0(d.range.hi[1])}°, Tiefstwert ${r0(d.range.lo[0])}° bis ${r0(d.range.lo[1])}° <span>(8–20 Uhr)</span></div>`);
  }
  const wet = d.byModel.filter(x => x.psum != null && x.psum >= 1), dry = d.byModel.filter(x => x.psum != null && x.psum < 0.2);
  const names = a => a.map(x => x.m.name).join(', ');
  let rain = '';
  if(wet.length && dry.length) rain = `Uneinig beim Regen: ${wet.length} von ${d.byModel.length} Modellen erwarten Regen (${names(wet)}), ${dry.length} bleiben trocken.`;
  else if(wet.length === d.byModel.length) rain = 'Alle Modelle erwarten Regen.';
  else if(dry.length === d.byModel.length) rain = 'Alle Modelle bleiben trocken.';
  if(rain) parts.push(`<div class="dline">${rain}</div>`);
  const s = d.byModel.slice().sort((a,b)=>a.tmax-b.tmax);
  if(s.length > 2 && s[s.length-1].tmax - s[0].tmax >= 2)
    parts.push(`<div class="dline">Höchstwert je nach Modell ${r0(s[0].tmax)}° <span>(${s[0].m.name})</span> bis ${r0(s[s.length-1].tmax)}° <span>(${s[s.length-1].m.name})</span>.</div>`);
  return parts.length ? `<div class="dsec">Wie sicher ist die Vorhersage für diesen Tag?</div>${parts.join('')}` : '';
}

// Eine Zeile, die auch eingeklappt sichtbar bleibt
function teaser(R){
  const T = R.ST && R.ST.track;
  const base = `${R.avail.length} Modelle, gewichtet nach Treffsicherheit`;
  if(T && (1 - T.ours/T.avg) >= 0.05) return `${base} · zuletzt <b>${Math.round((1 - T.ours/T.avg)*100)} % genauer</b> als der Modell-Durchschnitt. Antippen für Details.`;
  if(R.ST && R.ST.station) return `${base}, geprüft an der Messstation ${esc(R.ST.station.name)}. Antippen für Details.`;
  return `${base}. Antippen für Details.`;
}

function trackBlock(R){
  const S = R.ST;
  if(!S || !S.station) return `<div class="explain"><p>Für diesen Ort gibt es keine Messstation in der Nähe (höchstens 25 km, ähnliche Höhe). Die Modelle werden deshalb untereinander verglichen statt an echten Messwerten.</p></div>`;
  const st = S.station, T = S.track;
  const where = `<b>${esc(st.name)}</b> (${st.by}, ${fmt1(st.dist)} km entfernt${st.elev!=null? ', '+Math.round(st.elev)+' m':''})`;
  let html = `<div class="explain"><p>Geprüft an echten Messwerten: ${where}.</p>`;
  if(S.cityBias != null && Math.abs(S.cityBias) >= 0.3)
    html += `<p><b>Ortskorrektur:</b> Die Modelle lagen hier zuletzt im Schnitt ${fmt1(Math.abs(S.cityBias))}° zu ${S.cityBias<0?'kalt':'warm'}${S.nightBias!=null && S.cityBias<0 && S.nightBias < S.cityBias-0.3 ? `, nachts bis ${fmt1(Math.abs(S.nightBias))}°` : ''}. Das wird ausgeglichen, getrennt nach Tageszeit.</p>`;
  if(S.rainK && Math.abs(1 - S.rainK) >= 0.15)
    html += `<p><b>Regenkorrektur:</b> Die Modelle sagten hier zuletzt rund ${Math.round(Math.abs(1 - S.rainK)*100)} % ${S.rainK < 1 ? 'zu viel' : 'zu wenig'} Regen voraus. Die Mengen werden entsprechend angepasst.</p>`;
  html += `</div>`;
  if(T){
    const leads = T.leads || [{lead:1, ours:T.ours, avg:T.avg}];
    const f1 = v => v.toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1});
    html += `<div class="dsec" style="padding:0 16px">Trefferbilanz · letzte ${T.days} Tage</div><div class="track">
      <div class="hrow head"><div class="n">Temperatur</div><div>App</div><div>Modelle</div><div>besser</div></div>` +
      leads.map(l => { const g = Math.round((1 - l.ours/l.avg)*100);
        return `<div class="hrow"><div class="n">${l.lead === 1 ? '1 Tag' : l.lead + ' Tage'} im Voraus</div><div class="us">±${f1(l.ours)}°</div><div>±${f1(l.avg)}°</div><div class="${g > 0 ? 'plus' : ''}">${g > 0 ? g + ' %' : g === 0 ? 'gleich' : '–'}</div></div>`; }).join('');
    if(T.rain){
      const r = T.rain, bm = r.best && ALL_MODELS.find(m => m.id === r.best.id);
      html += `<div class="hrow head" style="margin-top:10px"><div class="n">Regen ja/nein richtig</div><div>App</div><div>Modelle</div><div>bestes</div></div>
        <div class="hrow"><div class="n">Tage von ${r.days}${bm ? `<span class="sub">bestes: ${shortName(bm)}</span>` : ''}</div><div class="us">${r.ours}</div><div>${r.avg}</div><div>${r.best ? r.best.hits : '–'}</div></div>`;
    }
    html += `</div><div class="explain" style="padding-top:4px">Temperatur: mittlere Abweichung Stunde für Stunde (kleiner ist besser). Regen: an wie vielen Tagen „Regen“ oder „trocken“ zwischen 8 und 20 Uhr stimmte (ab 0,5 mm). Für jeden Tag wurde nur genutzt, was vorher bekannt war.</div>`;
  }
  return html;
}

function modelTable(R){
  const g = (bk, id) => { const e = R.W[bk][id]; return e.tw ? (e.tw[0] + e.tw[1])/2 : e.t; };
  const share = (bk, id) => { const tot = R.avail.reduce((s,x)=>s+g(bk, x.id),0); return g(bk, id)/tot; };
  const list = R.avail.slice().sort((a,b)=>share('d1',b.id)-share('d1',a.id));
  const mx = Math.max(...list.flatMap(m => [share('d1',m.id), share('d6',m.id)]));
  const cell = (bk, m) => inflCell(share(bk, m.id), mx);
  const G = 'style="grid-template-columns:minmax(0,1fr) 58px 58px 58px"';
  const rows = list.map(m => {
    const err = R.W.d1[m.id]?.src === 'skill' ? R.W.d1[m.id].maeT : null;
    return `<div class="mrow" ${G}>
      <div class="n">${shortName(m)}${m.ki?'<span class="tag ki">KI</span>':''}</div>
      <div class="r">${err!=null? '±'+fmt1(err)+'°' : '<span class="muted">–</span>'}</div>
      ${cell('d1', m)}${cell('d6', m)}</div>`;
  }).join('');
  return `<div style="padding:4px 16px 0">
    <div class="mrow head" ${G}><div>Modell</div><div class="r">Fehler</div><div>Anteil<br>1–2 Tage</div><div>Anteil<br>ab Tag 6</div></div>
    ${rows}</div>`;
}

// Niederschlagsart: gemessene DWD-Niederschlagsart am Ort (wenn frisch), sonst nach Temperatur
// verb: „Laut Radar …“, it: Satz ohne Radar
const PTYPE = [{verb:'regnet es gerade', it:'Es regnet gerade', noun:'Regen', fall:'Regen'},
  {verb:'fällt gerade Schneeregen', it:'Gerade fällt Schneeregen', noun:'Schneeregen', fall:'Schneeregen'},
  {verb:'schneit es gerade', it:'Es schneit gerade', noun:'Schnee', fall:'Schneefall'},
  {verb:'fällt gerade gefrierender Regen (Glätte!)', it:'Gerade fällt gefrierender Regen (Glätte!)', noun:'gefrierender Regen', fall:'gefrierender Regen'},
  {verb:'fällt gerade Graupel', it:'Gerade fällt Graupel', noun:'Graupel', fall:'Graupel'},
  {verb:'hagelt es gerade', it:'Es hagelt gerade', noun:'Hagel', fall:'Hagel'}];
const PT_ANY = {verb:'gibt es gerade Niederschlag', it:'Gerade gibt es Niederschlag', noun:'Niederschlag', fall:'Niederschlag'};
function ptypeAt(R, i, now){
  if(now && state.hgType && state.hgType.key === (state.place && state.place.lat + ',' + state.place.lon) && Date.now() - state.hgType.at < 60*60e3 && state.hgType.type <= 5)
    return PTYPE[state.hgType.type];
  const t = now && R.curObs ? R.curObs.t : R.hourly[i] && R.hourly[i].temp;
  if(t == null) return PT_ANY;
  return t <= 0.5 ? PTYPE[2] : t < 2 ? PT_ANY : PTYPE[0];            // um 1 °C ist Schnee oder Regen offen
}
function nowCond(R){
  const c = R.cur, hc = hourCond(c);
  const radarWet = R.NC && R.NC.rateNow >= 0.1, wet = radarWet || ['rain','showers','snow','snowshower'].includes(hc.k);
  if(!wet || hc.k === 'thunder') return hc;
  const P = ptypeAt(R, R.nowIdx, true), rate = radarWet ? R.NC.rateNow : (c.prcp || 0);
  const st = rate < 0.5 ? 'Leichter ' : rate >= 4 ? 'Starker ' : '';
  if(P.noun === 'Schnee') return {k:'snow', txt: st + 'Schneefall'};
  if(P.noun === 'Schneeregen') return {k:'sleet', txt:'Schneeregen'};
  if(P.noun === 'gefrierender Regen') return {k:'rain', n:1, txt:'Gefrierender Regen – Glätte!'};
  if(P.noun === 'Graupel' || P.noun === 'Hagel') return {k:'snowshower', txt: P.noun};
  if(P.noun === 'Regen') return ['rain','showers'].includes(hc.k) ? hc : {k:'rain', n: rate < 0.5 ? 1 : rate < 2.5 ? 2 : 3, txt: st + 'Regen'};
  return ['rain','showers','snow','snowshower'].includes(hc.k) ? {...hc, txt:'Niederschlag'} : {k:'rain', n:1, txt:'Niederschlag'};
}
// wenn die gemessene Niederschlagsart nachträglich eintrifft: Text, Symbol und Satz anpassen
function applyNowCond(){
  const R = state.res; if(!R || !R.cur) return;
  const hc = nowCond(R), el = document.querySelector('#hero .cond'); if(el) el.textContent = hc.txt;
  const ni = document.querySelector('.nowi'); if(ni) ni.innerHTML = icon(hc.k, hc.n);
  const rc = document.querySelector('.rain2h'); if(rc){ const h = rainChart(R); if(h) rc.outerHTML = h; }
  const n = document.querySelector('.note'); if(n) n.innerHTML = makeSummary(R);
}
function makeSummary(R){
  const c = R.cur, rest = R.hourly.slice(R.nowIdx, R.nowIdx+12);
  const rainH = rest.find(h => h.pr>=0.5 && h.prcp>=0.2);
  const dry = !rest.some(h => h.pr>=0.3 && h.prcp>=0.1);
  let s = '';
  if(R.gauge){
    s = ptypeAt(R, R.nowIdx, true).noun === 'Schnee' ? 'Leichter Schneefall an der LMU-Station gemessen, das Radar sieht ihn nicht' : `${R.gauge.mmh < 0.5 ? 'Nieselregen' : 'Regen'} an der LMU-Station gemessen, das Radar sieht ihn nicht`;
  }
  else if(R.NC){
    const ch = R.NC.change();
    const P0 = ptypeAt(R, R.nowIdx, true);
    if(R.NC.rateNow >= 0.1) s = `Laut Radar ${P0.verb}${ch ? `, voraussichtlich bis etwa ${ch.at} Uhr` : ''}`;
    else if(ch && ch.wet) s = `Laut Radar trocken, ${ch.light ? 'leichter ' + P0.fall : P0.noun} ab etwa ${ch.at} Uhr`;
    else s = 'Laut Radar trocken in den nächsten 2 Stunden';
    const later = R.hourly.slice(R.nowIdx+3, R.nowIdx+12).find(h => h.pr>=0.5 && h.prcp>=0.2);
    if(R.NC.rateNow < 0.1 && !(ch && ch.wet) && later) s += `, danach ${ptypeAt(R, later.i).noun} ab etwa ${later.t.slice(11,13)} Uhr`;
  }
  else if(['rain','thunder','snow','sleet'].includes(nowCond(R).k) || (rainH && rainH.i===R.nowIdx)) s = ptypeAt(R, R.nowIdx, true).it;
  else if(rainH) s = `${ptypeAt(R, rainH.i).noun} wahrscheinlich ab etwa ${rainH.t.slice(11,13)} Uhr`;
  else if(dry) s = 'In den nächsten 12 Stunden trocken';
  else s = ptypeAt(R, R.nowIdx + 3).noun === 'Schnee' ? 'Vereinzelt Schneeschauer möglich' : 'Vereinzelt Schauer möglich';
  const tm = R.days[1];
  if(tm){ const t = tm.cond.txt, noun = /^(Regen|Schnee|Gewitter|Nebel|Starker|Leichter|Schauer|Schneeschauer)/.test(t);
    s += `. Morgen tagsüber ${tm.tmin < -0.5 ? `${r0(tm.tmin)}° bis ${r0(tm.tmax)}°` : `${r0(tm.tmin)}–${r0(tm.tmax)}°`}, ${noun ? t : t.charAt(0).toLowerCase() + t.slice(1)}`; }
  const g = R.hourly.slice(R.nowIdx, R.nowIdx+24).reduce((m,h)=>Math.max(m,h.gust||0),0);
  if(g >= 60) s += `. Sturmböen bis ${r0(g)} km/h`;
  return s + '.';
}
function feelTxt(c){
  if(c.feels==null||c.temp==null) return '';
  const d = c.feels - c.temp;
  if(d <= -3) return 'Wind lässt es kälter wirken.';
  if(d >= 3) return 'Luftfeuchte lässt es wärmer wirken.';
  return 'Ähnlich wie die tatsächliche Temperatur.';
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const svgCal = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;
const svgRadar = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12l6-6"/></svg>`;
const svgScale = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M5 7h14M5 7l-3 7h6zM19 7l-3 7h6z"/></svg>`;

/* ================= Karte (DWD-WMS) ================= */
// Die Karte wird nur einmal pro Ort erzeugt und beim Neuzeichnen der Seite weiterverwendet,
// damit Kacheln nicht neu geladen werden müssen.
let map = null, mapEl = null, mapKey = null, mapLayers = null;

// ===== Radar mit Niederschlagsart (Schnee rosa) – nutzt die Rechenlogik der Radarseite im Hintergrund =====
// Fällt das aus, bleibt das normale DWD-Radarbild (ohne Niederschlagsart) stehen.
const RB = {s: 45.6, n: 55.95, w: 1.4, e: 18.8}, mercY = lat => Math.log(Math.tan(Math.PI/4 + lat*Math.PI/360));
const RPAL = [
  ['#8fe8ff','#62d6ff','#38bff9','#26a6f2','#1787e0','#1466c8','#1847a8','#1b2f8a','#ff4b3e','#d1002f','#8b0022'],
  ['#e8ddff','#d3c2ff','#bca5ff','#a488fb','#8c6cf0','#7653e0','#6340c9','#5230ae','#432393','#36197a','#2a1163'],
  ['#ffc8ea','#ffb0de','#ffa3d9','#ff85cc','#f765bc','#e548a8','#cc2f93','#b01d7e','#93136a','#760b57','#5c0646'],
  ['#c6ffd9','#9af7bd','#6eeea0','#45e285','#22d36d','#0fbf5b','#0aa64d','#088c41','#067336','#055c2c','#044823'],
  ['#fff3b0','#ffec95','#ffe47a','#ffdc60','#ffd447','#ffcc2e','#ffc414','#f5b800','#e0a800','#cc9900','#b88a00'],
  ['#ffd199','#ffc27a','#ffb35c','#ffa43d','#ff951f','#ff8600','#f07a00','#db6f00','#c76400','#b35900','#9e4f00']];
let radarEng = null;
function radarEngine(){
  if(radarEng) return radarEng;
  try{
    const W = Math.round((RB.e - RB.w)*256*128/360), H = Math.round((mercY(RB.n) - mercY(RB.s))*256*128/(2*Math.PI));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const wk = new Worker('radar/worker.js');
    const E = radarEng = {cv, wk, W, H, init:false, ok:false, t:null, hg:false, busy:false, onReady:null, vid:0};
    const val = () => { const P = state.place; if(!P || !E.hg) return; const id = ++E.vid;
      wk.postMessage({cmd:'value', id, t: E.t, lat: P.lat, lon: P.lon}); E.valKey = P.lat + ',' + P.lon; };
    wk.onmessage = e => {
      const m = e.data;
      if(m.cmd === 'init'){ E.init = true; E.load(); }
      else if(m.cmd === 'hg'){ E.hg = !!(m.meta && Date.now() - Date.parse(m.meta.time) < 60*60e3); val(); if(E.ok) E.draw(); }
      else if(m.cmd === 'frame'){ if(m.t === E.t && m.ok) E.draw(); else if(m.t === E.t){ E.busy = false; } }
      else if(m.cmd === 'render'){ E.busy = false;
        cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.buf), W, H), 0, 0); E.buf = m.buf;
        E.ok = true; if(E.onReady) E.onReady(); if(E.again) E.draw(); }
      else if(m.cmd === 'value' && m.id === E.vid){
        state.hgType = m.type != null && m.type <= 5 ? {type: m.type, at: Date.now(), key: E.valKey} : null;
        applyNowCond();
      }
    };
    wk.onerror = () => { E.failed = true; };
    E.buf = new ArrayBuffer(W*H*4);
    E.load = () => { if(!E.init) return; E.t = Math.floor((Date.now() - 7*60e3)/300e3)*300e3;
      wk.postMessage({cmd:'hg'}); wk.postMessage({cmd:'frame', t: E.t}); };
    E.draw = () => { if(!E.buf){ E.again = true; return; } E.again = false; const b = E.buf; E.buf = null; E.busy = true; wk.postMessage({cmd:'render', t: E.t, buf: b, type: E.hg, id: 1}, [b]); };
    E.place = () => val();
    wk.postMessage({cmd:'init', W, H, west: RB.w, east: RB.e, yN: mercY(RB.n), yS: mercY(RB.s), palette: RPAL});
    return E;
  }catch(err){ return null; }
}
function initMap(place){
  const holder = $('#map'); if(!holder) return;
  if(typeof L === 'undefined') { holder.innerHTML = '<div class="loading" style="padding:120px 0">Karte nicht verfügbar</div>'; return; }
  const key = place.lat + ',' + place.lon;
  document.body.classList.remove('mapopen');
  if(map && mapKey === key && mapEl){
    holder.replaceWith(mapEl);                       // bestehende Karte samt geladenen Kacheln wieder einsetzen
    setTimeout(() => map.invalidateSize(), 30);
    const stamp = Math.floor(Date.now()/300e3);      // neues Radarbild höchstens alle 5 Minuten holen
    if(mapLayers.radarStamp !== stamp){ mapLayers.radarStamp = stamp; mapLayers.radar.setParams({_t: stamp}); if(radarEng) radarEng.load(); }
  } else {
    if(map){ map.remove(); map = null; }
    // In der Seite ist die Karte fest (sonst blockiert sie das Scrollen); per Tipp öffnet sie im Vollbild.
    map = L.map(holder, {zoomControl:false, attributionControl:false, dragging:false, touchZoom:false, doubleClickZoom:false,
      scrollWheelZoom:false, boxZoom:false, keyboard:false, tap:false, keepBuffer:4}).setView([place.lat, place.lon], 7);
    mapEl = holder; mapKey = key;
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:12, className:'basemap', keepBuffer:4}).addTo(map);
    const wms = (layers, op) => L.tileLayer.wms('https://maps.dwd.de/geoserver/dwd/wms', {layers, format:'image/png', transparent:true, opacity:op, version:'1.3.0', keepBuffer:4});
    mapLayers = {radar: wms('dwd:Niederschlagsradar', .75).addTo(map), warn: null, radarStamp: Math.floor(Date.now()/300e3), on: true, own: null};
    const E = radarEngine();
    if(E){
      mapLayers.own = L.svgOverlay(E.cv, [[RB.s, RB.w], [RB.n, RB.e]], {interactive:false, opacity: 0}).addTo(map);
      const ML = mapLayers;
      E.onReady = () => { if(mapLayers !== ML) return; ML.own.setOpacity(ML.on ? .85 : 0); ML.radar.setOpacity(0); ML.ownOk = true; };
      if(E.ok) E.onReady(); else E.load();
    }
    L.circleMarker([place.lat, place.lon], {radius:6, color:'#fff', weight:2, fillColor:'#2b7cff', fillOpacity:1}).addTo(map);
    mapEl.addEventListener('click', () => { const c = document.querySelector('.mapcard'); if(c && !c.classList.contains('full')) setMapFull(true); });
  }
  // Ebenen-Schalter: nur ein-/ausblenden (sofort), nichts neu laden
  document.querySelectorAll('.mapbar .chip').forEach(btn => {
    const k = btn.dataset.l;
    const isOn = k === 'radar' ? mapLayers.on !== false : !!(mapLayers.warn && mapLayers.warn.options.opacity > 0);
    btn.classList.toggle('on', isOn);
    btn.onclick = () => {
      const on = !btn.classList.contains('on'); btn.classList.toggle('on', on);
      if(k === 'radar'){ mapLayers.on = on; if(mapLayers.ownOk) mapLayers.own.setOpacity(on ? .85 : 0); else mapLayers.radar.setOpacity(on ? .75 : 0); }
      if(k === 'warn'){
        if(!mapLayers.warn) mapLayers.warn = L.tileLayer.wms('https://maps.dwd.de/geoserver/dwd/wms', {layers:'dwd:Warnungen_Gemeinden', format:'image/png', transparent:true, opacity:.55, version:'1.3.0'}).addTo(map);
        else mapLayers.warn.setOpacity(on ? .55 : 0);
      }
    };
  });
  $('#mapToggle').onclick = e => { e.stopPropagation(); setMapFull(!document.querySelector('.mapcard').classList.contains('full')); };
}
function setMapFull(full){
  const card = document.querySelector('.mapcard'), tog = $('#mapToggle'); if(!card || !map) return;
  card.classList.toggle('full', full); document.body.classList.toggle('mapopen', full);
  ['dragging','touchZoom','doubleClickZoom'].forEach(h => full ? map[h].enable() : map[h].disable());
  tog.innerHTML = full ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>'
                       : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>';
  setTimeout(() => { map.invalidateSize(); if(!full){ const [la, lo] = mapKey.split(',').map(Number); map.setView([la, lo], 7); } }, 60);
}

/* ================= Orte ================= */
const DEFAULT_PLACE = {name:'München', lat:48.137, lon:11.575};
// Koordinaten auf ca. 1 km runden: genauer braucht es kein Wettermodell, und es gibt weniger über den Standort preis
function setPlace(p){ p = {...p, lat: Math.round(p.lat*100)/100, lon: Math.round(p.lon*100)/100}; store.set('wx:place', p); state.place = p; load(); }

let loading = false, loadSeq = 0;
async function load(force){
  const my = ++loadSeq; loading = true;
  const p = state.place;
  const shown = $('#app').querySelector('.hero .place');
  if(!shown || shown.textContent !== p.name) $('#app').innerHTML = `<div class="loading"><div class="spin"></div>Lade ${esc(p.name)} …</div>`;
  try{
    const data = await loadAll(p.lat, p.lon, force);
    if(my !== loadSeq) return;                      // inzwischen wurde ein anderer Ort gewählt
    state.fetched = Date.now();
    const show = d => {
      state.warn = '';
      if(state.stale) state.warn = 'Keine Verbindung – du siehst den Stand von ' + hhmm(state.dataTime) + '. Zum Aktualisieren nach unten ziehen.';
      else if(d.errs && d.errs.length) state.warn = 'Die Ensemble-Läufe sind gerade nicht erreichbar. Die Vorhersage läuft, nur Regenwahrscheinlichkeit und Spannen sind ungenauer.';
      const R = build(d); state.res = R; render(p, R);
    };
    show(data); ptrDone();
    // Nachzügler (Live-Daten, Prüfdaten) still einarbeiten; offene Ansichten und Scrollposition bleiben
    let cur = data;
    const patch = add => {
      if(my !== loadSeq || document.body.classList.contains('mapopen')) { cur = {...cur, ...add}; return; }
      const y = window.scrollY, open = [...document.querySelectorAll('.detail.open')].map(x => x.id), mo = document.querySelector('.models.open');
      cur = {...cur, ...add}; show(cur);
      open.forEach(id => id === 'detH' ? toggleHist(true) : toggleDetail(+id.slice(3), true));
      if(mo) document.querySelector('.models')?.classList.add('open');
      window.scrollTo(0, y);
    };
    await Promise.all([
      data.liveP ? data.liveP.then(L => patch(L)).catch(() => {}) : null,
      data.statsP ? data.statsP.then(N => { if(N) patch({stats: N}); }).catch(() => {}) : null,
      (radarEng && radarEng.place(), null),
    ]);
  }catch(e){
    if(my === loadSeq) $('#app').innerHTML = `<div class="hero"><div class="place">${esc(p.name)}</div></div><div class="err">Daten konnten nicht geladen werden: ${esc(e.message||e)}<br>Zum erneuten Versuch nach unten ziehen.</div>`;
  }finally{ if(my === loadSeq){ loading = false; ptrDone(); } }
}
const hhmm = t => new Date(t).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
function updatedTxt(){
  if(!state.dataTime) return '';
  const min = Math.round((Date.now()-state.dataTime)/60e3);
  return (state.stale ? 'Offline · ' : '') + 'Aktualisiert ' + (min < 1 ? 'gerade eben' : min < 60 ? `vor ${min} Min.` : 'um ' + hhmm(state.dataTime));
}

/* ================= Ziehen zum Aktualisieren ================= */
const ptr = $('#ptr'); let ptrY = null, ptrD = 0;
window.addEventListener('touchstart', e => {
  if(window.scrollY < 5 && !$('#sheet').classList.contains('open') && !document.body.classList.contains('mapopen') && !e.target.closest('.hours,#map'))
    ptrY = e.touches[0].clientY; else ptrY = null;
}, {passive:true});
window.addEventListener('touchmove', e => {
  if(ptrY==null) return;
  ptrD = Math.max(0, e.touches[0].clientY - ptrY);
  const d = Math.min(ptrD, 110);
  ptr.style.opacity = Math.min(1, d/70);
  ptr.style.transform = `translateY(${d*0.6 - 40}px) rotate(${d*3}deg)`;
}, {passive:true});
window.addEventListener('touchend', () => {
  if(ptrY==null) return;
  if(ptrD > 75){ ptr.classList.add('spin'); ptr.style.transform = 'translateY(26px)'; load(true); }
  else ptrDone();
  ptrY = null; ptrD = 0;
});
function ptrDone(){ ptr.classList.remove('spin'); ptr.style.opacity = 0; ptr.style.transform = 'translateY(-50px)'; }

$('#btnSearch').onclick = () => { $('#sheet').classList.add('open'); showRecent(); setTimeout(()=>$('#q').focus(), 50); };
$('#close').onclick = () => $('#sheet').classList.remove('open');
function showRecent(){
  const F = favs(), rec = (store.get('wx:recent') || [DEFAULT_PLACE]).filter(p => !F.some(f => sameP(f,p)));
  $('#results').innerHTML =
    (F.length ? `<div class="fav-h">Favoriten</div>` + F.map((p,i)=>`<div data-f="${i}"><span class="rm" data-x="${i}">×</span>★ ${esc(p.name)}<small>${esc(p.region||'')}</small></div>`).join('') : '') +
    (rec.length ? `<div class="fav-h">Zuletzt</div>` + rec.map((p,i)=>`<div data-r="${i}">${esc(p.name)}<small>${esc(p.region||'')}</small></div>`).join('') : '') +
    (F.length ? '' : `<div class="fav-h" style="text-transform:none">Tipp: Mit dem ☆ neben dem Ortsnamen speicherst du Favoriten und wechselst dann durch Wischen.</div>`);
  $('#results').querySelectorAll('[data-f]').forEach(el => el.onclick = e => { if(e.target.dataset.x != null){ e.stopPropagation(); toggleFav(F[+e.target.dataset.x]); showRecent(); } else choose(F[+el.dataset.f]); });
  $('#results').querySelectorAll('[data-r]').forEach(el => el.onclick = () => choose(rec[+el.dataset.r]));
}
function choose(p){
  const rec = (store.get('wx:recent') || []).filter(x => x.name!==p.name);
  rec.unshift(p); store.set('wx:recent', rec.slice(0,8));
  $('#sheet').classList.remove('open'); $('#q').value = '';
  setPlace(p);
}
let qT, qSeq = 0;
$('#q').oninput = () => {
  clearTimeout(qT);
  const q = $('#q').value.trim();
  if(q.length < 2){ showRecent(); return; }
  qT = setTimeout(async () => {
    const mySeq = ++qSeq;
    try{
      const r = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=de&format=json`, 8000);
      if(mySeq !== qSeq) return;
      const list = (r.results||[]).map(x => ({name:x.name, lat:x.latitude, lon:x.longitude, region:[x.admin1, x.country].filter(Boolean).join(', ')}));
      $('#results').innerHTML = list.length ? list.map((p,i)=>`<div data-i="${i}">${esc(p.name)}<small>${esc(p.region)}</small></div>`).join('') : '<div>Kein Ort gefunden</div>';
      $('#results').querySelectorAll('[data-i]').forEach(el => el.onclick = () => choose(list[+el.dataset.i]));
    }catch(e){ if(mySeq === qSeq) $('#results').innerHTML = '<div>Suche nicht erreichbar – bitte erneut versuchen</div>'; }
  }, 280);
};
$('#btnLoc').onclick = () => {
  if(!navigator.geolocation){ return; }
  $('#btnLoc').style.opacity = .5;
  navigator.geolocation.getCurrentPosition(async pos => {
    const exact = {lat: pos.coords.latitude, lon: pos.coords.longitude};   // bleibt auf dem Gerät, nur für die Entfernungsanzeige
    const lat = Math.round(exact.lat*100)/100, lon = Math.round(exact.lon*100)/100;
    let name = 'Mein Standort';
    try{ // Ortsname über BigDataCloud (kostenlos, ohne Schlüssel)
      const r = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=de`);
      name = r.city || r.locality || name;
    }catch(e){}
    setPlace({name, lat, lon, gps:true, exact});
  }, () => { $('#btnLoc').style.opacity = 1; alertBox('Standort nicht verfügbar – bitte unter Einstellungen › Datenschutz › Ortungsdienste für Safari-Websites erlauben.'); }, {enableHighAccuracy:true, timeout:15000, maximumAge:60000});
};
function alertBox(msg){ state.warn = msg; if(state.res) render(state.place, state.res); }

// Neu laden, wenn die App wieder in den Vordergrund kommt
document.addEventListener('visibilitychange', () => {
  if(document.hidden) return;
  checkUpdate();
  if(state.fetched && Date.now()-state.dataTime > CACHE_MIN*60e3) load();
  else { const u = document.querySelector('.updated'); if(u) u.textContent = updatedTxt(); }
});
window.addEventListener('online', () => { if(state.stale) load(true); });
setInterval(() => {
  if(document.hidden || !state.fetched) return;
  if(Date.now() - state.dataTime > CACHE_MIN*60e3 && !loading) load();
  else { const u = document.querySelector('.updated'); if(u) u.textContent = updatedTxt(); }
}, 60e3);

/* ================= Offline-Fähigkeit (Service Worker) ================= */
if('serviceWorker' in navigator && location.protocol === 'https:'){
  navigator.serviceWorker.register('sw.js').catch(()=>{});
}

/* ================= Demo-Daten (nur #demo, zum Testen ohne Netz) ================= */
function makeDemo(){
  const off = 3600, start = new Date(Date.now()+off*1000); start.setUTCHours(0,0,0,0);
  const N = DAYS*24, time=[]; for(let i=0;i<N;i++) time.push(new Date(start.getTime()+i*3600e3).toISOString().slice(0,16));
  const rnd = (s => () => (s = (s*16807)%2147483647)/2147483647)(42);
  const base = i => { const h=i%24, d=Math.floor(i/24); return 4 + 5*Math.sin((h-9)/24*2*Math.PI) - d*0.4 + (d===3? 3:0); };
  const rainBase = i => { const h=i%24, d=Math.floor(i/24); if(d===1 && (h>=1&&h<=6)) return 1.2; if(d===2 && h>=11&&h<=16) return 0.8; if(d===5) return 0.4; return 0; };
  const hourly = {time};
  const daily = {time: [...new Set(time.map(t=>t.slice(0,10)))]};
  MODELS.forEach((m,mi) => {
    const bias = (mi-3)*0.35;
    hourly['temperature_2m_'+m.id] = time.map((t,i)=> +(base(i)+bias+(rnd()-.5)*(0.5+i/60)).toFixed(1));
    hourly['apparent_temperature_'+m.id] = hourly['temperature_2m_'+m.id].map(v=>+(v-2.5).toFixed(1));
    hourly['precipitation_'+m.id] = time.map((t,i)=> +(Math.max(0, rainBase(i)*(0.6+rnd()*0.8) - (mi===5?0.3:0))).toFixed(1));
    hourly['cloud_cover_'+m.id] = time.map((t,i)=> Math.round(clamp((rainBase(i)>0?95:40+30*Math.sin(i/7))+ (rnd()-.5)*30,0,100)));
    hourly['weather_code_'+m.id] = hourly['precipitation_'+m.id].map(v=> v>0.1? 61 : 2);
    hourly['wind_speed_10m_'+m.id] = time.map(()=> +(8+rnd()*10).toFixed(0));
    hourly['wind_gusts_10m_'+m.id] = time.map(()=> +(18+rnd()*20).toFixed(0));
    hourly['relative_humidity_2m_'+m.id] = time.map(()=> Math.round(70+rnd()*25));
    hourly['is_day_'+m.id] = time.map(t=> { const h=+t.slice(11,13); return h>=7&&h<17?1:0; });
    daily['sunrise_'+m.id] = daily.time.map(d=>d+'T07:32'); daily['sunset_'+m.id] = daily.time.map(d=>d+'T16:31');
  });
  const ens = {time}, eh = {time};
  ENSEMBLES.forEach((e,ei) => { const n = [64,51,51,40][ei];
    for(let k=0;k<n;k++){ const kk = k===0?'':`_member${String(k).padStart(2,'0')}`;
      eh[`temperature_2m${kk}_${e.id}`] = time.map((t,i)=> +(base(i)+(rnd()-.5)*(1+i/30)).toFixed(1));
      eh[`precipitation${kk}_${e.id}`] = time.map((t,i)=> +(rainBase(i)*(rnd()<0.75?rnd()*2:0)).toFixed(1)); } });
  const ptime = []; for(let i=-21*24;i<24;i++) ptime.push(new Date(start.getTime()+i*3600e3).toISOString().slice(0,16));
  const ph = {time: ptime};
  MODELS.forEach((m,mi) => { const q = [0.9,0.95,1.0,1.3,1.1,1.6,1.3][mi];
    ph['temperature_2m_'+m.id] = ptime.map((t,i)=> +(5+3*Math.sin(i/9)).toFixed(1));
    ph['precipitation_'+m.id] = ptime.map((t,i)=> (i%37<4)? 0.6:0);
    BUCKETS.forEach(b => { ph[`temperature_2m_previous_day${b.off}_${m.id}`] = ptime.map((t,i)=> +(5+3*Math.sin(i/9)+(rnd()-.5)*q*(1+b.off*.5)).toFixed(1));
      ph[`precipitation_previous_day${b.off}_${m.id}`] = ptime.map((t,i)=> (i%37<4)? +(0.6*rnd()*2*q).toFixed(1):0); }); });
  return {fc:{utc_offset_seconds:off, hourly, daily}, ens:{hourly:eh}, prev:{utc_offset_seconds:off, hourly:ph}, errs:[]};
}

/* ================= Start ================= */
state.place = store.get('wx:place') || DEFAULT_PLACE;
checkUpdate();
load();
