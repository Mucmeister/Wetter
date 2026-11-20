// Prüft die veröffentlichte Radarseite mit echten Daten (läuft nur auf Knopfdruck in GitHub Actions)
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true, timezoneId:'Europe/Berlin', locale:'de-DE'});
  const pg = await ctx.newPage(); const errs = [];
  pg.on('pageerror', e => errs.push(String(e))); pg.on('console', m => { if(m.type()==='error') errs.push(m.text()); });
  await pg.goto('https://mucmeister.github.io/Wetter/radar/?' + Date.now());
  await pg.waitForTimeout(15000);
  const st = () => pg.evaluate(() => ({clock: clock.textContent, kind: kind.textContent, here: here.textContent, msg: msg.textContent,
    n: times.length, ok: [...info.values()].filter(s=>s.ok).length, failed: [...info.values()].filter(s=>s.failed).length,
    measured: [...info.entries()].filter(([t,s])=>s.measured).length, hg: hgMeta && hgMeta.time, typeOn, sub: sub.textContent}));
  console.log(JSON.stringify(await st()));
  await pg.screenshot({path:'out/1-radar.png'});
  await pg.evaluate(() => map.setView([50.5, 10.5], 6));
  await pg.waitForTimeout(3000); await pg.screenshot({path:'out/2-deutschland.png'});
  await pg.click('#chipSat'); await pg.waitForTimeout(8000); await pg.screenshot({path:'out/3-satellit.png'});
  await pg.click('#chipRadar'); await pg.waitForTimeout(3000); await pg.screenshot({path:'out/4-nur-satellit.png'});
  await pg.click('#chipRadar'); await pg.click('#chipSat');
  const box = await pg.locator('#slider').boundingBox();
  await pg.mouse.click(box.x + box.width*0.99, box.y + 20); await pg.waitForTimeout(1500);
  console.log(JSON.stringify(await st())); await pg.screenshot({path:'out/5-plus2h.png'});
  await pg.mouse.click(box.x + 2, box.y + 20); await pg.waitForTimeout(1500);
  console.log(JSON.stringify(await st())); await pg.screenshot({path:'out/6-minus2h.png'});
  console.log('ERRORS', JSON.stringify(errs));
  await b.close();
})();
