// Prüft die veröffentlichte Wetterseite mit echten Daten (nur auf Knopfdruck)
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true, timezoneId:'Europe/Berlin', locale:'de-DE'});
  for(const [name, lat, lon] of [['Garmisch-Partenkirchen', 47.49, 11.1], ['Hilden', 51.17, 6.94]]){
    const pg = await ctx.newPage(); const errs = [];
    pg.on('pageerror', e => errs.push(String(e))); pg.on('console', m => { if(m.type()==='error') errs.push(m.text()); });
    await pg.addInitScript(([n,a,o]) => localStorage.setItem('wx:place', JSON.stringify({name:n, lat:a, lon:o})), [name, lat, lon]);
    await pg.goto('https://mucmeister.github.io/Wetter/?' + Date.now());
    await pg.waitForTimeout(20000);
    console.log(name, JSON.stringify(await pg.evaluate(() => ({note: document.querySelector('.note') && document.querySelector('.note').textContent, hg: state.hgType, own: mapLayers && mapLayers.ownOk,
      useStack: state.res && state.res.ST && state.res.ST.useStack, track: state.res && state.res.ST && state.res.ST.track && state.res.ST.track.leads}))), errs.slice(0,5));
    const c = await pg.$('.mapcard'); if(c) await c.screenshot({path:`out/map-${name.slice(0,6)}.png`});
    await pg.close();
  }
  await b.close();
})();
