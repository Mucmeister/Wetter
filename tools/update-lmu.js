// Holt die stündlichen Messwerte der LMU-Stadtstation (Theresienstraße 37) und schreibt data/lmu.json.
// Läuft automatisch über GitHub Actions (.github/workflows/messwerte.yml).
const fs = require('fs');
const path = require('path');
const {lmuHourly, LMU_TEMP, LMU_RAIN} = require('./lmu-parse.js');

const FILE = path.join(__dirname, '..', 'data', 'lmu.json');
const BASE = 'https://www.meteo.physik.uni-muenchen.de/~quicklooks/zeitreihen/stadt/';
const KEEP_DAYS = 75, FIRST_DAYS = 60;

const ymd = d => d.toISOString().slice(0, 10);
async function get(url){
  for(let k = 0; k < 3; k++){
    try{ const r = await fetch(url, {signal: AbortSignal.timeout(30000)}); if(r.ok) return await r.text(); if(r.status === 404) return null; }
    catch(e){}
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}
async function day(d){
  const y = d.slice(0,4), m = d.slice(5,7), f = d.replace(/-/g, '');
  const [T, R] = await Promise.all([get(`${BASE}${y}/${m}/${f}_temp.svg`), get(`${BASE}${y}/${m}/${f}_rest.svg`)]);
  const t = T ? lmuHourly(T, LMU_TEMP.ax, LMU_TEMP.color) : null;
  let c = R ? lmuHourly(R, LMU_RAIN.ax, LMU_RAIN.color, LMU_RAIN.maxGap) : null;
  if(t && R && !c) c = Array(25).fill(0);        // keine Regenlinie = trockener Tag
  return {t, c};
}

(async () => {
  let old = {};
  try{ old = JSON.parse(fs.readFileSync(FILE, 'utf8')); }catch(e){}
  // Bestand in Map: Zeit (UTC, volle Stunde) -> [t, p]
  const rows = new Map();
  if(old.start && old.t){
    const s = Date.parse(old.start + ':00Z');
    old.t.forEach((v, i) => rows.set(new Date(s + i*3600e3).toISOString().slice(0,13), [v, old.p ? old.p[i] : null]));
  }
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const back = rows.size ? 2 : FIRST_DAYS;          // sonst nur heute + 2 Vortage nachladen
  for(let k = back; k >= 0; k--){
    const d = ymd(new Date(today - k*864e5));
    const {t, c} = await day(d);
    if(!t){ console.log('keine Daten', d); continue; }
    for(let h = 0; h < 24; h++){
      const key = `${d}T${String(h).padStart(2,'0')}`;
      // Niederschlag: Summe der Stunde, die zur Zeit h endet (wie Open-Meteo)
      let p = null;
      if(c && h > 0 && c[h] != null && c[h-1] != null) p = Math.max(0, +(c[h]-c[h-1]).toFixed(2));
      if(h === 0) p = rows.get(key)?.[1] ?? null;
      if(t[h] != null || !rows.has(key)) rows.set(key, [t[h] == null ? null : Math.round(t[h]*10)/10, p]);
      else if(p != null) rows.get(key)[1] = p;
    }
    // Stunde 24 (= 0 Uhr Folgetag) bekommt den Niederschlag der letzten Stunde des Tages
    if(c && c[24] != null && c[23] != null){
      const nk = ymd(new Date(Date.parse(d) + 864e5)) + 'T00';
      const prev = rows.get(nk) || [null, null]; prev[1] = Math.max(0, +(c[24]-c[23]).toFixed(2)); rows.set(nk, prev);
    }
    console.log('ok', d);
  }
  // Zusammenhängende Reihe der letzten KEEP_DAYS Tage
  const keys = [...rows.keys()].sort();
  const valid = keys.filter(k => rows.get(k)[0] != null);
  const lastKey = valid[valid.length-1];
  const end = Date.parse(lastKey + ':00:00Z'), start = Math.max(Date.parse(keys[0] + ':00:00Z'), end - KEEP_DAYS*864e5);
  const T = [], P = [];
  for(let ms = start; ms <= end; ms += 3600e3){
    const r = rows.get(new Date(ms).toISOString().slice(0,13)) || [null, null];
    T.push(r[0]); P.push(r[1]);
  }
  // einzelne Lücken in der Temperatur auffüllen
  for(let i = 1; i < T.length-1; i++) if(T[i] == null && T[i-1] != null && T[i+1] != null) T[i] = Math.round((T[i-1]+T[i+1])*5)/10;
  const out = {
    station: {name: 'LMU Stadtstation Theresienstraße', lat: 48.1481, lon: 11.5733, elevation: 517,
              source: 'Meteorologisches Institut der LMU München', url: 'https://www.meteo.physik.uni-muenchen.de/DokuWiki/doku.php?id=wetter:stadt:messung'},
    updated: new Date().toISOString(), start: new Date(start).toISOString().slice(0,16), t: T, p: P,
  };
  fs.mkdirSync(path.dirname(FILE), {recursive: true});
  fs.writeFileSync(FILE, JSON.stringify(out));
  console.log('Stunden:', T.length, 'letzte:', lastKey);
})();
