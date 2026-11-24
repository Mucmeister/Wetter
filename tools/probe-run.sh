#!/bin/bash
set +e
python3 - <<'PY' > out/apple.txt 2>&1
import json, urllib.request
M='ecmwf_ifs,ecmwf_aifs025_single,dwd_icon_seamless,meteofrance_seamless,ukmo_seamless,ncep_gfs_seamless,ncep_aigfs025,gem_seamless,jma_seamless,cma_grapes_global,knmi_seamless,best_match,icon_d2,ecmwf_ifs025'
u=f'https://api.open-meteo.com/v1/forecast?latitude=48.14&longitude=11.58&timezone=Europe/Berlin&daily=temperature_2m_max,temperature_2m_min&models={M}&forecast_days=10'
d=json.load(urllib.request.urlopen(u,timeout=90))['daily']
print(json.dumps(d))
PY
