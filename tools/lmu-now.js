// Aktueller Messwert der LMU-Stadtstation (Theresienstraße 37) -> now.json
// Läuft alle 10 Minuten über GitHub Actions und landet im Zweig "live" (löst keinen Seiten-Neubau aus).
const fs = require('fs');
const URL = 'https://www.meteo.physik.uni-muenchen.de/~quicklooks/aktuelle_messwerte/messwerte_stadt.html';
const num = s => s == null ? null : parseFloat(String(s).replace(',', '.'));

(async () => {
  const r = await fetch(URL, {signal: AbortSignal.timeout(30000)});
  if(!r.ok) throw new Error('HTTP ' + r.status);
  const html = await r.text();
  // "Stand: 20.11.2026 06:30 Uhr" (Ortszeit München)
  const st = html.match(/Stand:\s*(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
  if(!st) throw new Error('Kein Zeitstempel gefunden');
  const [, D, M, Y, h, m] = st;
  // Ortszeit -> UTC über die Zeitzone Europe/Berlin
  const guess = Date.UTC(+Y, +M-1, +D, +h, +m);
  const off = (ms) => { const p = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Berlin', hour12:false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}).formatToParts(new Date(ms));
    const g = t => +p.find(x => x.type === t).value; return Date.UTC(g('year'), g('month')-1, g('day'), g('hour') % 24, g('minute')) - ms; };
  const utc = guess - off(guess);
  const row = label => { const m = html.match(new RegExp(label + '<\\/td>\\s*<td>([-\\d.,]+)')); return m ? num(m[1]) : null; };
  const t = row('Lufttemperatur'), rh = row('Relative Feuchte');
  const rr = (html.match(/<td>([\d.,]+)\s*mm\/h<\/td>/) || [])[1];
  if(t == null) throw new Error('Keine Temperatur gefunden');
  const out = {station: 'LMU-Stadtstation Theresienstraße', lat: 48.1481, lon: 11.5733, time: new Date(utc).toISOString(), t, rh, rain_mmh: num(rr)};
  fs.writeFileSync('now.json', JSON.stringify(out));
  console.log(out);
})().catch(e => { console.error(e.message); process.exit(1); });
