# Speichert die MOSMIX-Vorhersage für einige Orte, damit sich ihre Treffsicherheit später prüfen lässt
import json, urllib.request, datetime, os, sys
PLACES = {'Hilden':(51.168,6.939),'München':(48.150,11.570),'Hamburg':(53.551,9.993),'Berlin':(52.520,13.405),
          'Garmisch':(47.492,11.096),'Freiburg':(47.999,7.842),'Rostock':(54.092,12.099),'Nürnberg':(49.452,11.077),
          'Bremen':(53.076,8.807),'Kreuth':(47.641,11.745),'Lenggries':(47.683,11.575),'Düsseldorf':(51.223,6.779),
          'Frankfurt':(50.116,8.684),'Greven':(52.094,7.594),'Bodenheim':(49.935,8.320),'Guntersblum':(49.798,8.346),
          'Magdeburg':(52.131,11.632),'Köln':(50.933,6.950),'Braunschweig':(52.266,10.527),'Starnberg':(48.002,11.344),
          'Lichtenhaag':(48.493,12.374),'Schöllnach':(48.754,13.178),'Leipzig':(51.340,12.371)}
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
now = datetime.datetime.now(datetime.UTC)
rec = {'run': now.strftime('%Y-%m-%dT%H:%M'), 'places': {}}
def get(u): return json.load(urllib.request.urlopen(u, timeout=60))
for n, (la, lo) in PLACES.items():
    try:
        # gleiche Stationswahl wie in der App: max. 30 km, höchstens 150 m Höhenunterschied, Station mit Daten
        el = get(f'https://api.open-meteo.com/v1/elevation?latitude={la}&longitude={lo}')['elevation'][0]
        src = [x for x in get(f'https://api.brightsky.dev/sources?lat={la}&lon={lo}&max_dist=30000')['sources']
               if x['observation_type'] == 'forecast' and (x.get('height') is None or abs(x['height'] - el) <= 150)]
        src.sort(key=lambda x: x['distance'])
        a = now.strftime('%Y-%m-%d'); b = (now + datetime.timedelta(days=7)).strftime('%Y-%m-%d')
        for c in src[:3]:
            try: w = get(f'https://api.brightsky.dev/weather?source_id={c["id"]}&date={a}&last_date={b}&tz=Etc/UTC')
            except Exception: continue
            rows = [[x['timestamp'][:13], x['temperature'], x['precipitation']] for x in w['weather'] if x['temperature'] is not None]
            if len(rows) < 48: continue
            rec['places'][n] = {'src': [c['station_name'], c['distance'], c['height'], el], 'w': rows}
            break
        else: print(n, 'keine passende MOSMIX-Station')
    except Exception as e: print(n, e)
# Ensembles: Regenwahrscheinlichkeit und Spanne für Hoch/Tief je Tag (8–20 Uhr Ortszeit), für die spätere Prüfung
ENS = ['ecmwf_ifs025_ensemble','ecmwf_aifs025_ensemble','dwd_icon_seamless_eps','google_weathernext2_ensemble']
def q(a, p): a = sorted(a); return a[min(len(a)-1, max(0, round(p*(len(a)-1))))]
rec['ens'] = {}
for n, (la, lo) in PLACES.items():
    try:
        e = get(f'https://ensemble-api.open-meteo.com/v1/ensemble?latitude={la}&longitude={lo}&timezone=Europe/Berlin&hourly=temperature_2m,precipitation&models={",".join(ENS)}&forecast_days=7')
        H = e['hourly']; t = H['time']; out_p = {}
        for m in ENS:
            keys = [k for k in H if k.startswith('temperature_2m') and m in k]
            days = {}
            for k in keys:
                T = H[k]; P = H.get(k.replace('temperature_2m', 'precipitation'))
                for d in sorted({x[:10] for x in t}):
                    i0 = t.index(d + 'T08:00') if d + 'T08:00' in t else None
                    if i0 is None or i0 + 12 >= len(t): continue
                    tv = [v for v in T[i0:i0+13] if v is not None]
                    pv = P[i0+1:i0+13] if P else []
                    if len(tv) < 10: continue
                    r = days.setdefault(d, {'lo': [], 'hi': [], 'p': []})
                    r['lo'].append(min(tv)); r['hi'].append(max(tv))
                    if pv and all(v is not None for v in pv): r['p'].append(sum(pv))
            out_p[m] = {d: {'n': len(r['hi']), 'lo': [round(q(r['lo'],x),1) for x in (.1,.5,.9)], 'hi': [round(q(r['hi'],x),1) for x in (.1,.5,.9)],
                            'p05': round(sum(v >= 0.5 for v in r['p'])/len(r['p']), 3) if r['p'] else None,
                            'p01': round(sum(v >= 0.1 for v in r['p'])/len(r['p']), 3) if r['p'] else None} for d, r in days.items() if len(r['hi']) >= 5}
        rec['ens'][n] = out_p
    except Exception as ex: print(n, 'Ensemble', ex)
fn = os.path.join(out, now.strftime('%Y-%m-%dT%H') + '.json')
json.dump(rec, open(fn, 'w')); print('gespeichert', fn)
