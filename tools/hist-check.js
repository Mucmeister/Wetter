// Analyse Rückblick: Wo landet die App-Prognose? (Debug-Zugriff auf D per Route-Injektion)
const { chromium } = require('playwright');
const PLACES = [['Hamburg', 53.551, 9.994], ['Bremen', 53.075, 8.807], ['Berlin', 52.52, 13.41], ['München', 48.137, 11.575], ['Köln', 50.938, 6.957]];
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({viewport:{width:390,height:844}, timezoneId:'Europe/Berlin', locale:'de-DE'});
  await ctx.route('**/app.js*', async r => { const res = await r.fetch(); let t = await res.text();
    t = t.replace('const D = prepPrev(prev, station, offH);', 'const D = prepPrev(prev, station, offH); window.__D = D; window.__hilly = hilly;');
    r.fulfill({response: res, body: t}); });
  for(const [name, lat, lon] of PLACES){
    const pg = await ctx.newPage(); const errs = [];
    pg.on('pageerror', e => errs.push(String(e)));
    await pg.addInitScript(([n,a,o]) => localStorage.setItem('wx:place', JSON.stringify({name:n, lat:a, lon:o})), [name, lat, lon]);
    await pg.goto('https://mucmeister.github.io/Wetter/?' + Date.now());
    for(let k=0;k<30;k++){ await pg.waitForTimeout(2000); if(await pg.evaluate(() => !!(state.res && state.res.ST && state.res.ST.hist))) break; }
    const r = await pg.evaluate(() => {
      const D = window.__D, ST = state.res.ST, hilly = window.__hilly;
      const starts = []; for(let i=1;i<D.n;i++) if(D.lh[i] === 0 && D.past[i] && i+23 < D.n && D.past[i+23]) starts.push(i);
      const days = [];
      for(const s0 of starts.slice(-21)){
        if(s0 < 20*24) continue;
        const Ww = weightsAt(D, s0, hilly, ST.useStack);
        const win = a => { const v = a.slice(8, 21).filter(x => x!=null); return v.length >= 10 ? [Math.min(...v), Math.max(...v)] : null; };
        const o = win(D.obsT.slice(s0, s0+24)); if(!o) continue;
        const mods = {}, corr = {}; const alt = {app:[], eq:[], nobias:[], best3:[]};
        for(const m of MODELS){ const T = D.per[m.id]?.temperature_2m_previous_day1; if(!T) continue; const w = win(T.slice(s0,s0+24)); if(w) mods[m.id] = w; }
        for(let i=s0;i<s0+24;i++){
          let sw=0,sv=0,se=0,ne=0,su=0; 
          for(const m of MODELS){ const w = Ww[m.id]; if(!w) continue; const f = D.per[m.id]?.temperature_2m_previous_day1?.[i]; if(f==null) continue;
            const bc = f - (w.bias ? w.bias[binOf(D.lh[i])] : 0), ww = wT(w, D.lh[i]); sw += ww; sv += ww*bc; su += ww*f; se += bc; ne++; }
          alt.app.push(sw ? sv/sw : null); alt.eq.push(ne ? se/ne : null); alt.nobias.push(sw ? su/sw : null);
        }
        const W = {}; for(const m of MODELS) if(Ww[m.id]) W[m.id] = {t: Ww[m.id].t, bias: Ww[m.id].bias, tw: Ww[m.id].tw};
        days.push({d: D.lday[s0], o, mods, app: win(alt.app), eq: win(alt.eq), nobias: win(alt.nobias), W});
      }
      return {standing: ST.hist.standing, tmd: state.res.days.slice(0,3).map(d=>[d.d,+d.tmin.toFixed(1),+d.tmax.toFixed(1)]), useStack: ST.useStack, station: ST.station, track: ST.track && {ours: ST.track.ours, avg: ST.track.avg, models: ST.track.models, leads: ST.track.leads}, days};
    });
    console.log(JSON.stringify({name, errs: errs.slice(0,3), ...r}));
    await pg.close();
  }
  await b.close();
})();
