#!/bin/bash
set +e
python3 - <<'PY' > out/depth.txt 2>&1
import json, urllib.request
M='ecmwf_ifs,ecmwf_aifs025_single,dwd_icon_seamless,meteofrance_seamless,ukmo_seamless,ncep_gfs_seamless,ncep_aigfs025'
for a,b in [('2025-11-01','2025-11-03'),('2025-06-01','2025-06-03'),('2025-01-01','2025-01-03'),('2024-06-01','2024-06-03')]:
    try:
        d=json.load(urllib.request.urlopen(f'https://previous-runs-api.open-meteo.com/v1/forecast?latitude=53.55&longitude=9.99&timezone=GMT&hourly=temperature_2m_previous_day1,cloud_cover_previous_day1,wind_speed_10m_previous_day1&models={M}&start_date={a}&end_date={b}',timeout=90))
        H=d['hourly']; print(a, {k.replace('temperature_2m_previous_day1_',''): sum(v is not None for v in H[k]) for k in H if k.startswith('temperature')}, 'cloud', sum(v is not None for v in H.get('cloud_cover_previous_day1_ecmwf_ifs',[]) ))
    except Exception as e: print(a,'FEHLER',str(e)[:200])
for a in ['2025-01-01','2024-06-01']:
    try:
        w=json.load(urllib.request.urlopen(f'https://api.brightsky.dev/weather?lat=53.55&lon=9.99&date={a}&last_date={a}T23:00&tz=Etc/UTC',timeout=90)); print('brightsky',a,len(w['weather']))
    except Exception as e: print('bs',a,e)
PY
