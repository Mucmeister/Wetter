// Ruft die veröffentlichte Seite für viele Orte auf, öffnet alle Details und prüft auf Widersprüche (tools/audit.js)
const { chromium } = require('playwright'); const fs = require('fs');
const AUD = fs.readFileSync(__dirname + '/audit.js', 'utf8');
const src = fs.readFileSync(__dirname + '/backtest-fetch.py', 'utf8');
const PLACES = Object.entries(JSON.parse(src.split('PLACES = ')[1].split('\ndef get')[0].replace(/'/g, '"').replace(/\(/g, '[').replace(/\)/g, ']')));
PLACES.push(['Zugspitze', [47.421, 10.985]], ['Feldberg', [47.874, 8.004]], ['Sylt', [54.910, 8.313]], ['Wien', [48.208, 16.373]], ['Paris', [48.857, 2.352]], ['Zürich', [47.377, 8.540]]);
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({viewport:{width:390,height:844}, isMobile:true, hasTouch:true, timezoneId:'Europe/Berlin', locale:'de-DE'});
  for(const [name, [lat, lon]] of PLACES.filter(p => !ONLY.length || ONLY.includes(p[0]))){
    const pg = await ctx.newPage(); const errs = [];
    pg.on('pageerror', e => errs.push(String(e).slice(0,200)));
    await pg.addInitScript(([n,a,o]) => localStorage.setItem('wx:place', JSON.stringify({name:n, lat:a, lon:o})), [name, lat, lon]);
    try{
      await pg.goto('https://mucmeister.github.io/Wetter/?' + Date.now());
      for(let k=0;k<60;k++){ await pg.waitForTimeout(2000); if(await pg.evaluate(() => !!(window.state && state.res && state.res.ST && state.res.ST.track && document.querySelector('.days')))) break; }
      await pg.waitForTimeout(4000);
      for(const r of await pg.$$('.days .row')){ try{ await r.click({timeout:2000}); await pg.waitForTimeout(120); }catch(e){} }
      const t = await pg.$('#howToggle'); if(t){ await t.click(); await pg.waitForTimeout(200); }
      const res = await pg.evaluate(AUD);
      const info = await pg.evaluate(() => ({build: BUILD, st: state.res.ST && state.res.ST.station && state.res.ST.station.name, n: state.res.avail.length, hero: (document.querySelector('#hero .cond')||{}).innerText, c0: [0,1].map(i => (document.querySelector('#det'+i+' .sures')||{}).innerText), d6: state.res.days[6] && state.res.days[6].byModel.map(x => x.m.name.slice(0,10) + ' ' + Math.round(x.share*100)).join(', ')}));
      console.log(JSON.stringify({name, ...info, errs, issues: res}));
    }catch(e){ console.log(JSON.stringify({name, fail: String(e).slice(0,200), errs})); }
    await pg.close();
  }
  await b.close();
})();
