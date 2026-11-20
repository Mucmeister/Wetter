// Rechenarbeit der Radarseite (läuft im Hintergrund, damit Karte und Wischen flüssig bleiben):
// Radardaten laden und entpacken, auf die Kartenprojektion umrechnen und einfärben.
importScripts('../vendor/fflate.js');

const GW = 1100, GH = 1200;                       // RADOLAN-Gitter des DWD (1 km), Zeile 0 = Norden
let W = 0, H = 0, lut = null, hg = null, pal = null;
const frames = new Map();                         // Zeitpunkt (ms) -> {lev: Uint8Array, run, measured}

// Polare stereografische Projektion des DWD-Gitters (wie +proj=stere +lat_ts=60 +lat_0=90 +lon_0=10, WGS84)
const A = 6378137, B = 6356752.3142451802, E = Math.sqrt(1 - B*B/(A*A));
const X0 = 543196.83521776402, Y0 = 3622588.8619310022, LON0 = 10*Math.PI/180, PHC = 60*Math.PI/180;
const tf = ph => Math.tan(Math.PI/4 - ph/2) / Math.pow((1 - E*Math.sin(ph)) / (1 + E*Math.sin(ph)), E/2);
const MC = Math.cos(PHC) / Math.sqrt(1 - E*E*Math.sin(PHC)**2), TC = tf(PHC);
function toGrid(lat, lon){
  const ph = lat*Math.PI/180, la = lon*Math.PI/180 - LON0;
  const rho = A*MC*tf(ph)/TC;
  const x = rho*Math.sin(la) + X0, y = -rho*Math.cos(la) + Y0;
  return [Math.round(x/1000), Math.round(-y/1000)];   // Spalte, Zeile (Zellmitten liegen auf vollen Kilometern)
}

// Farben: Stufen in mm/h; je Niederschlagsart eine eigene Farbfamilie
const LEVELS = [0.1, 0.3, 0.6, 1, 2, 4, 7, 12, 20, 35, 60];
function buildPalette(P){
  pal = new Uint32Array(8*16);
  P.forEach((row, t) => row.forEach((hex, l) => {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    const a = l === 0 ? 205 : 238;
    pal[t*16 + l + 1] = (a << 24 | b << 16 | g << 8 | r) >>> 0;
  }));
}
// Zehntel-Millimeter je 5 Minuten (Bright Sky: 0,01 mm / 5 min) -> Stufe 0..11
const LEVTAB = new Uint8Array(4096);
for(let v = 0; v < 4096; v++){ const mmh = v*0.12; let l = 0; while(l < LEVELS.length && mmh >= LEVELS[l]) l++; LEVTAB[v] = l; }

function decode(b64){
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const raw = fflate.unzlibSync(u8);
  const v16 = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
  const lev = new Uint8Array(GW*GH);
  for(let i = 0; i < lev.length; i++){ const v = v16[i]; lev[i] = v >= 4096 ? 11 : LEVTAB[v]; }
  return lev;
}

async function getJSON(url, ms){
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try{ const r = await fetch(url, {signal: ctl.signal}); if(!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally{ clearTimeout(t); }
}

async function loadFrame(t){
  const iso = new Date(t).toISOString().slice(0,16);
  const j = await getJSON(`https://api.brightsky.dev/radar?format=compressed&date=${iso}Z&last_date=${iso}Z&tz=Etc/UTC`, 20000);
  const f = j && j.radar && j.radar.find(x => Date.parse(x.timestamp) === t);
  if(!f) return null;
  const run = Date.parse((f.source || '').split('::').pop()) || null;
  const lev = decode(f.precipitation_5);
  const fr = {lev, run, measured: run != null && run >= t};
  frames.set(t, fr);
  return fr;
}

async function loadHG(){
  const base = 'https://raw.githubusercontent.com/Mucmeister/Wetter/radar/';
  const q = '?t=' + Math.floor(Date.now()/120e3);
  const meta = await getJSON(base + 'hg.json' + q, 10000);
  const r = await fetch(base + 'hg.bin' + q); if(!r.ok) throw new Error('HTTP ' + r.status);
  const raw = fflate.unzlibSync(new Uint8Array(await r.arrayBuffer()));
  if(raw.length !== GW*GH) throw new Error('Größe');
  hg = raw; return meta;
}

function render(t, buf, useType){
  const fr = frames.get(t), out = new Uint32Array(buf);
  if(!fr){ out.fill(0); return; }
  const lev = fr.lev, T = useType ? hg : null;
  for(let p = 0; p < out.length; p++){
    const idx = lut[p];
    if(idx < 0){ out[p] = 0; continue; }
    const l = lev[idx];
    if(!l){ out[p] = 0; continue; }
    let ty = T ? T[idx] : 0; if(ty > 5) ty = 0;
    out[p] = pal[ty*16 + l];
  }
}

onmessage = async e => {
  const m = e.data;
  try{
    if(m.cmd === 'init'){
      W = m.W; H = m.H; buildPalette(m.palette);
      lut = new Int32Array(W*H);
      const [lonW, lonE] = [m.west, m.east], yN = m.yN, yS = m.yS;   // y = Mercator-Nordwert
      const lons = new Float64Array(W);
      for(let i = 0; i < W; i++) lons[i] = lonW + (i + .5)/W*(lonE - lonW);
      for(let j = 0; j < H; j++){
        const y = yN - (j + .5)/H*(yN - yS), lat = (2*Math.atan(Math.exp(y)) - Math.PI/2)*180/Math.PI;
        for(let i = 0; i < W; i++){
          const [c, r] = toGrid(lat, lons[i]);
          lut[j*W + i] = (c >= 0 && c < GW && r >= 0 && r < GH) ? r*GW + c : -1;
        }
      }
      postMessage({cmd:'init', ok:true});
    } else if(m.cmd === 'frame'){
      let fr = null, err = null;
      try{ fr = await loadFrame(m.t); }catch(x){ err = String(x.message || x); }
      postMessage({cmd:'frame', t: m.t, ok: !!fr, measured: fr ? fr.measured : null, run: fr ? fr.run : null, err});
    } else if(m.cmd === 'hg'){
      let meta = null, err = null;
      try{ meta = await loadHG(); }catch(x){ err = String(x.message || x); hg = null; }
      postMessage({cmd:'hg', meta, err});
    } else if(m.cmd === 'render'){
      render(m.t, m.buf, m.type && !!hg);
      postMessage({cmd:'render', t: m.t, buf: m.buf, id: m.id}, [m.buf]);
    } else if(m.cmd === 'drop'){
      for(const t of [...frames.keys()]) if(!m.keep.includes(t)) frames.delete(t);
    } else if(m.cmd === 'value'){
      // Wert an einem Punkt (für „Regen bei dir“)
      const [c, r] = toGrid(m.lat, m.lon), fr = frames.get(m.t);
      const ok = c >= 0 && c < GW && r >= 0 && r < GH;
      postMessage({cmd:'value', id: m.id, lev: ok && fr ? fr.lev[r*GW + c] : null, type: ok && hg ? hg[r*GW + c] : null, inside: ok});
    }
  }catch(x){ postMessage({cmd:'error', err: String(x.message || x), req: m.cmd}); }
};
