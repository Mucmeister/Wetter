# Speichert die MOSMIX-Vorhersage für einige Orte, damit sich ihre Treffsicherheit später prüfen lässt
import json, urllib.request, datetime, os, sys
PLACES = {'Hilden':(51.168,6.939),'München':(48.150,11.570),'Hamburg':(53.551,9.993),'Berlin':(52.520,13.405),
          'Garmisch':(47.492,11.096),'Freiburg':(47.999,7.842),'Rostock':(54.092,12.099),'Nürnberg':(49.452,11.077)}
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
now = datetime.datetime.now(datetime.UTC)
rec = {'run': now.strftime('%Y-%m-%dT%H:%M'), 'places': {}}
for n, (la, lo) in PLACES.items():
    try:
        a = now.strftime('%Y-%m-%d'); b = (now + datetime.timedelta(days=7)).strftime('%Y-%m-%d')
        w = json.load(urllib.request.urlopen(f'https://api.brightsky.dev/weather?lat={la}&lon={lo}&date={a}&last_date={b}&tz=Etc/UTC', timeout=60))
        src = w['sources'][0]
        rec['places'][n] = {'src': [src['station_name'], src['distance'], src['height']],
                            'w': [[x['timestamp'][:13], x['temperature'], x['precipitation']] for x in w['weather']]}
    except Exception as e: print(n, e)
fn = os.path.join(out, now.strftime('%Y-%m-%dT%H') + '.json')
json.dump(rec, open(fn, 'w')); print('gespeichert', fn)
