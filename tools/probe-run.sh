#!/bin/bash
# Freie Testabfragen (nur auf Knopfdruck); Ergebnis landet im Zweig probe2
set +e
python3 - <<'PY' > out/mos.txt 2>&1
import json, urllib.request, datetime
now = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:00')
end = (datetime.datetime.utcnow()+datetime.timedelta(days=11)).strftime('%Y-%m-%d')
for n,la,lo in [('Muenchen',48.137,11.575),('Hilden',51.17,6.94),('Garmisch',47.49,11.1),('Petoskey',45.37,-84.96),('Vancouver',49.28,-123.12)]:
    try:
        d = json.load(urllib.request.urlopen(f'https://api.brightsky.dev/weather?lat={la}&lon={lo}&date={now}&last_date={end}&tz=Etc/UTC', timeout=60))
        src = [s for s in d['sources']]
        print(n, [(s['id'], s['observation_type'], s.get('station_name'), s.get('distance'), s.get('height'), s.get('wmo_station_id')) for s in src])
        w = d['weather']; print('  n', len(w), 'von', w[0]['timestamp'], 'bis', w[-1]['timestamp'])
        print('  ', json.dumps(w[3])[:900])
        print('  Quellen je Zeitpunkt:', sorted(set(x['source_id'] for x in w)))
    except Exception as e: print(n, 'FEHLER', e)
PY
