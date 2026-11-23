#!/bin/bash
set +e
python3 - <<'PY' > out/st.txt 2>&1
import json, urllib.request, datetime, collections
fr=(datetime.date.today()-datetime.timedelta(days=46)).isoformat(); to=datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:00')
for n,la,lo,el in [('Rostock',54.092,12.099,None),('Nürnberg',49.452,11.077,None),('Köln',50.938,6.957,None),('Hamburg',53.551,9.994,None)]:
    e=json.load(urllib.request.urlopen(f'https://api.open-meteo.com/v1/elevation?latitude={la}&longitude={lo}'))['elevation'][0]
    j=json.load(urllib.request.urlopen(f'https://api.brightsky.dev/weather?lat={la:.3f}&lon={lo:.3f}&date={fr}&last_date={to}&tz=Etc/UTC',timeout=60))
    c=collections.Counter(w['source_id'] for w in j['weather'] if w['temperature'] is not None)
    print('==',n,'Höhe',e)
    for s in sorted(j['sources'],key=lambda s:s['distance']): print('  ',s['id'],s['observation_type'],s['station_name'],round(s['distance']/1000,1),'km',s.get('height'),'m dwd',s.get('dwd_station_id'),'Werte',c.get(s['id'],0))
PY
