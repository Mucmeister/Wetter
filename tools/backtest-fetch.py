# Lädt Vorhersagen früherer Modellläufe und Stationsmessungen für die Rückrechnung (nur Testzwecke)
import json, urllib.request, datetime, time, sys
MODELS = ['ecmwf_ifs','ecmwf_aifs025_single','dwd_icon_seamless','meteofrance_seamless','ukmo_seamless','ncep_gfs_seamless','ncep_aigfs025']
PLACES = {'Hilden':(51.168,6.939),'München':(48.150,11.570),'Hamburg':(53.551,9.993),'Berlin':(52.520,13.405),
          'Garmisch':(47.492,11.096),'Freiburg':(47.999,7.842),'Rostock':(54.092,12.099),'Nürnberg':(49.452,11.077)}
def get(u):
    for k in range(3):
        try: return json.load(urllib.request.urlopen(u, timeout=90))
        except Exception as e: err=e; time.sleep(5)
    raise err
out = {}
vars_ = ['temperature_2m'] + [f'temperature_2m_previous_day{d}' for d in (1,2,3,4,5,6,7)] + ['precipitation','precipitation_previous_day1']
for name,(la,lo) in PLACES.items():
    try:
        u = f'https://previous-runs-api.open-meteo.com/v1/forecast?latitude={la}&longitude={lo}&timezone=GMT&hourly={",".join(vars_)}&models={",".join(MODELS)}&past_days=92&forecast_days=1'
        p = get(u)
        end = datetime.datetime.utcnow(); obs = {}; src = None
        for k in range(4):
            a = (end - datetime.timedelta(days=24*(k+1))).strftime('%Y-%m-%dT%H:00'); b = (end - datetime.timedelta(days=24*k)).strftime('%Y-%m-%dT%H:00')
            w = get(f'https://api.brightsky.dev/weather?lat={la}&lon={lo}&date={a}&last_date={b}&tz=Etc/UTC')
            ss = [s for s in w.get('sources',[]) if s['observation_type'] != 'forecast' and s['distance'] <= 25000]
            if not ss: continue
            pick = sorted(ss, key=lambda s: s['distance'])[0]
            if src is None: src = {'name': pick['station_name'], 'dist': pick['distance'], 'h': pick['height']}
            ids = {s['id'] for s in ss if s.get('dwd_station_id') == pick.get('dwd_station_id')}
            for x in w['weather']:
                if x['source_id'] in ids and x['temperature'] is not None: obs[x['timestamp'][:13]] = [x['temperature'], x['precipitation']]
        out[name] = {'prev': p['hourly'], 'elev': p.get('elevation'), 'obs': obs, 'station': src}
        print(name, len(p['hourly']['time']), len(obs), src)
    except Exception as e: print(name, 'FEHLER', e)
json.dump(out, open(sys.argv[1], 'w'))
