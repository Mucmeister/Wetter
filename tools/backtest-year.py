# Lädt ein Jahr frühere Modellläufe (1 Tag Vorlauf) und Stationsmessungen für die Rückrechnung über alle Jahreszeiten
import json, urllib.request, datetime, time, sys, gzip
_src = open(__file__.replace('backtest-year.py', 'backtest-fetch.py')).read()
MODELS = eval(_src.split('MODELS = ')[1].split('\n')[0])
PLACES = eval(_src.split('PLACES = ')[1].split('\ndef get')[0])
def get(u):
    for k in range(4):
        try: return json.load(urllib.request.urlopen(u, timeout=120))
        except Exception as e: err = e; time.sleep(10)
    raise err
END = datetime.date.today() - datetime.timedelta(days=1); START = END - datetime.timedelta(days=364)
V = ['temperature_2m_previous_day1', 'temperature_2m_previous_day2', 'precipitation_previous_day1', 'cloud_cover_previous_day1', 'wind_speed_10m_previous_day1', 'wind_gusts_10m_previous_day1']
out = {}
for name, (la, lo) in PLACES.items():
    try:
        H = None
        for q in range(4):     # in Vierteljahren laden
            a = START + datetime.timedelta(days=92*q); b = min(END, a + datetime.timedelta(days=91))
            p = get(f'https://previous-runs-api.open-meteo.com/v1/forecast?latitude={la}&longitude={lo}&timezone=GMT&hourly={",".join(V)}&models={",".join(MODELS)}&start_date={a}&end_date={b}')
            if H is None: H = p['hourly']; elev = p.get('elevation')
            else:
                for k in H: H[k] += p['hourly'].get(k, [None]*len(p['hourly']['time']))
        obs = {}; src = None; d = START
        while d <= END:
            e = min(END, d + datetime.timedelta(days=24))
            w = get(f'https://api.brightsky.dev/weather?lat={la}&lon={lo}&date={d}&last_date={e}T23:00&tz=Etc/UTC')
            ss = [s for s in w.get('sources', []) if s['observation_type'] != 'forecast' and s['distance'] <= 25000 and (elev is None or s.get('height') is None or abs(s['height'] - elev) <= 150)]
            if ss:
                pick = sorted(ss, key=lambda s: s['distance'])[0]
                if src is None: src = {'name': pick['station_name'], 'dist': pick['distance'], 'h': pick['height']}
                ids = {s['id'] for s in ss if s.get('dwd_station_id') == pick.get('dwd_station_id')}
                for x in w['weather']:
                    if x['source_id'] in ids and x['temperature'] is not None:
                        obs[x['timestamp'][:13]] = [x['temperature'], x['precipitation'], x.get('wind_speed'), x.get('wind_gust_speed'), x.get('cloud_cover')]
            d = e + datetime.timedelta(days=1)
        out[name] = {'prev': H, 'elev': elev, 'obs': obs, 'station': src}
        print(name, len(H['time']), len(obs), src, flush=True)
    except Exception as e: print(name, 'FEHLER', e, flush=True)
json.dump(out, gzip.open(sys.argv[1], 'wt'))
