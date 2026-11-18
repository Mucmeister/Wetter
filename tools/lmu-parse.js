// Liest die Tages-Zeitreihen (matplotlib-SVG) der LMU-Stadtstation Theresienstraße aus.
// Die Achsen werden an den Gitterlinien geeicht, die Datenlinie über ihre Farbe gefunden.
function lmuAxes(svg){
  const parts = svg.split(/<g id="axes_\d+">/).slice(1);
  const axes = parts.map(part => {
    // Jeder Tick: Gitterlinie (falls vorhanden) + Beschriftung (Kommentar) + Textposition
    const tick = kind => part.split(new RegExp(`<g id="${kind}_\\d+">`)).slice(1).map(seg => {
      const g = seg.match(/^\s*<g id="line2d_\d+">\s*<path d="M ([\d.]+) ([\d.]+)\s*L ([\d.]+) ([\d.]+)/);
      const c = seg.match(/<!--\s*([^>]*?)\s*-->/);
      const tr = seg.match(/translate\(([\d.]+) ([\d.]+)\)/);
      return {gx: g ? +g[1] : null, gy: g ? +g[2] : null, label: c ? c[1] : '', tx: tr ? +tr[1] : null, ty: tr ? +tr[2] : null};
    });
    const lines = [...part.matchAll(/<g id="line2d_\d+">\s*<path d="([^"]*)"[^>]*style="[^"]*stroke: (#[0-9a-f]{6})/g)]
      .map(m => ({color:m[2], pts:[...m[1].matchAll(/([\d.]+) ([\d.]+)/g)].map(p => [+p[1], +p[2]])}))
      .filter(l => l.pts.length > 3);
    return {xt: tick('xtick'), yt: tick('ytick'), lines};
  });
  // Achsen ohne Gitterlinien (rechte Achse): Pixelposition aus der Beschriftung, Versatz aus einer anderen Achse geeicht
  const ref = axes.flatMap(a => a.yt).find(t => t.gy != null && t.ty != null);
  const off = ref ? ref.ty - ref.gy : 3.61;
  for(const a of axes) for(const t of a.yt) if(t.gy == null && t.ty != null) t.gy = t.ty - off;
  return axes.map(a => ({lines: a.lines,
    xt: a.xt.filter(t => t.gx != null).map(t => ({x1:t.gx, label:t.label})),
    yt: a.yt.filter(t => t.gy != null).map(t => ({y1:t.gy, label:t.label}))}));
}
function lmuFit(a, b){ // lineare Abbildung Pixel -> Wert aus zwei Stützstellen
  return p => a.v + (p - a.p) * (b.v - a.v) / (b.p - a.p);
}
// Liefert für eine Linie (Farbe) 25 Stundenwerte 00..24 UTC (null, wo keine Daten)
function lmuHourly(svg, axIndex, color, maxGap = 3){
  const all = lmuAxes(svg), ax = all[axIndex]; if(!ax) return null;
  if(!ax.xt.length) ax.xt = all[0].xt;          // geteilte Zeitachse
  const xs = ax.xt.filter(t => /^\d+$/.test(t.label)).map(t => ({p:t.x1, v:+t.label}));
  const ys = ax.yt.filter(t => /^-?[\d.]+$/.test(t.label)).map(t => ({p:t.y1, v:+t.label}));
  if(xs.length < 2 || ys.length < 2) return null;
  const fx = lmuFit(xs[0], xs[xs.length-1]), fy = lmuFit(ys[0], ys[ys.length-1]);
  const line = ax.lines.find(l => l.color === color); if(!line) return null;
  const pts = line.pts.map(([x,y]) => [fx(x), fy(y)]);
  const out = [];
  for(let h=0; h<=24; h++){
    // Wert zur vollen Stunde: linear zwischen den umliegenden Punkten (matplotlib lässt gerade Stücke weg)
    let v = null;
    for(let i=0;i<pts.length;i++){
      const [t,y] = pts[i];
      if(Math.abs(t-h) < 1e-6){ v = y; break; }
      if(t > h){ if(i>0){ const [t0,y0] = pts[i-1]; if(t-t0 <= maxGap) v = y0 + (y-y0)*(h-t0)/(t-t0); } break; }
    }
    if(h === 24 && v == null && pts.length && pts[pts.length-1][0] >= 23.75) v = pts[pts.length-1][1];
    out.push(v == null ? null : Math.round(v*100)/100);
  }
  return out;
}
const LMU_TEMP = {file:'temp', ax:0, color:'#800000'};   // Temperatur 2 m
const LMU_RAIN = {file:'rest', ax:1, color:'#0000ff', maxGap:24};   // Regensumme seit 0 UTC
if(typeof module !== 'undefined') module.exports = {lmuAxes, lmuHourly, LMU_TEMP, LMU_RAIN};
