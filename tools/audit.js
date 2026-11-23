// Prüft die gerenderte Seite auf Widersprüche (läuft im Browser, nachdem alle Details geöffnet wurden). Ergebnis: Liste von Befunden.
(() => {
  const P = [], R = state.res, add = (w, s) => P.push(w + ': ' + s);
  const txt = document.querySelector('#app').innerText;
  for(const bad of ['NaN', 'undefined', 'null', 'Infinity', '[object', '-0°', '−0°', ' ,', ' .', '..', '  '])
    { const i = txt.indexOf(bad); if(i >= 0 && !(bad === '..' && txt.slice(i-1, i+3) === '...')) add('Text', `„${bad}“ in: …${txt.slice(Math.max(0,i-40), i+30).replace(/\n/g,' ')}…`); }
  const num = s => s == null ? null : +String(s).replace('−','-').replace(',', '.').replace(/[^\d.\-]/g, '');
  // Tageszeilen gegen Detail
  document.querySelectorAll('.days .row:not(.past)').forEach(row => {
    const i = +row.dataset.i, d = R.days[i], det = document.getElementById('det' + i); if(!d || !det) return;
    const lab = row.querySelector('.d').innerText.split('\n')[0];
    const mn = num(row.querySelector('.mn').innerText), mx = num(row.querySelector('.mx').innerText);
    const cons = det.querySelector('.mrow.cons');
    if(cons){ const c = [...cons.children].map(x => x.innerText); const t = c.filter(x => /°/.test(x)).map(num);
      if(t[0] !== mn || t[1] !== mx) add(lab, `Zeile ${mn}/${mx}°, Detail ${t[0]}/${t[1]}°`); }
    const amt = row.querySelector('.amt'); const dtx = det.innerText;
    const m8 = dtx.match(/Niederschlag\s+([\d,]+) mm \(8–20 Uhr\)/);
    if(amt && m8 && num(amt.innerText) !== num(m8[1])) add(lab, `Menge Zeile ${amt.innerText}, Detail ${m8[1]} mm`);
    if(amt && /trocken \(8–20/.test(dtx)) add(lab, `Zeile ${amt.innerText}, Detail trocken`);
    const tf = dtx.match(/Temperatur\s+(-?\d+)° bis (-?\d+)°/);
    if(tf && (+tf[1] > mn || +tf[2] < mx)) add(lab, `ganzer Tag ${tf[1]}–${tf[2]}° enger als 8–20 Uhr ${mn}–${mx}°`);
    const hw = dtx.match(/Höchstwert wahrscheinlich (-?\d+)° bis (-?\d+)°, Tiefstwert (-?\d+)° bis (-?\d+)°/);
    if(hw && (+hw[1] > +hw[2] || +hw[3] > +hw[4])) add(lab, 'Spanne verkehrt: ' + hw[0]);
    const un = dtx.match(/(\d+) von (\d+) Modellen erwarten[^.]*?\), (\d+) (?:bleibt|bleiben) trocken(?:, (\d+) erwarte)?/);
    if(un && +un[1] + +un[3] + +(un[4]||0) !== +un[2]) add(lab, 'Zählung geht nicht auf: ' + un[0]);
    const sh = [...det.querySelectorAll('.mrow:not(.head):not(.cons) .infl span')].map(x => num(x.innerText));
    if(sh.length){ const s = sh.reduce((a,b)=>a+b,0); if(Math.abs(s - 100) > 3) add(lab, `Anteile ergeben ${s} %`); }
    if(['snow','snowshower','snowshowernight','sleet'].includes(d.cond.k) && /\bRegen\b/.test(dtx)) add(lab, 'Schnee-Tag, aber „Regen“ im Detail');
    const us = row.querySelector('.unsure'), badge = det.querySelector('.sure');
    if(us && (!badge || !badge.innerText.endsWith(us.innerText))) add(lab, `Zeile „${us.innerText}“, Detail „${badge ? badge.innerText : '–'}“`);
    if(i === 0 && badge) add(lab, 'Sicherheits-Angabe für heute');
    const pp = row.querySelector('.pp').innerText.match(/(\d+)%/); if(pp && (+pp[1] < 0 || +pp[1] > 100)) add(lab, 'Prozent ' + pp[1]);
  });
  // Stunden: nachts keine Sonne
  R.hourly.forEach(h => { const k = hourCond(h).k; if(!h.isDay && ['sun','mostlysun','partly','showers','snowshower'].includes(k)) add('Stunde ' + h.t.slice(5,13), 'Sonnensymbol nachts (' + k + ')'); });
  // Kurztext: „Morgen tagsüber a–b°“
  const note = (document.querySelector('.note') || {}).innerText || '';
  const mt = note.match(/Morgen tagsüber (-?\d+)(?:°)?(?:–| bis )(-?\d+)°/);
  if(mt && R.days[1]){ const a = Math.round(R.days[1].tmin), b = Math.round(R.days[1].tmax); if(+mt[1] !== a || +mt[2] !== b) add('Kurztext', `${mt[0]} vs. Tagesliste ${a}–${b}°`); }
  if(/regnet/.test(note) && ['snow','sleet'].includes(nowCond(R).k)) add('Kurztext', 'regnet, aber Symbol Schnee');
  const heroC = (document.querySelector('#hero .cond') || {}).innerText || '';
  if(/Regen/.test(heroC) && /Schnee/.test(note) || /Schnee/.test(heroC) && /regnet/.test(note)) add('Kopf', `„${heroC}“ vs. „${note.slice(0,60)}“`);
  // Kacheln
  const tiles = [...document.querySelectorAll('.tile, .kv')].map(t => t.innerText).join('\n');
  const sun = txt.match(/(\d+) h Sonne von (\d+) h möglichen/); if(sun && +sun[1] > +sun[2]) add('Sonne', sun[0]);
  const wd = txt.match(/WIND\s+(\d+) km\/h[\s\S]{0,40}?Böen bis (\d+) km\/h/); if(wd && +wd[2] < +wd[1]) add('Wind', `Böen ${wd[2]} < Wind ${wd[1]}`);
  const nt = txt.match(/NIEDERSCHLAG\s+[\s\S]{0,40}?8–20 Uhr: ([\d,]+) mm/);
  if(nt){ const hd = document.querySelector('.tsec') ? document.querySelectorAll('.tsec')[1]?.innerText : ''; const di = /MORGEN/i.test(hd) ? 1 : 0;
    if(R.days[di] && Math.abs(num(nt[1]) - R.days[di].psum) > 0.051) add('Kachel Niederschlag', `${nt[1]} mm vs. Tag ${fmt1(R.days[di].psum)} mm`); }
  // Rückblick
  const H = R.ST && R.ST.hist; if(H && H.standing && H.standing.place > H.standing.of) add('Rückblick', 'Platz > Anzahl');
  return P;
})()
