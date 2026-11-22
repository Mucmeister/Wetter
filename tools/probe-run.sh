#!/bin/bash
set +e
curl -s "https://api.brightsky.dev/sources?lat=48.137&lon=11.575&max_dist=30000" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(s['id'],s['observation_type'],s['station_name'],s['distance'],s['height']) for s in d.get('sources',[]) if s['observation_type']=='forecast']" > out/src.txt 2>&1
D=$(date -u +%Y-%m-%d); E=$(date -u -d '+11 days' +%Y-%m-%d)
curl -s -o out/w.json -w "%{http_code} %{size_download}\n" "https://api.brightsky.dev/weather?source_id=202203&date=$D&last_date=$E&tz=Etc/UTC" >> out/src.txt
curl -s "https://api.open-meteo.com/v1/forecast?latitude=48.137&longitude=11.575&hourly=temperature_2m&forecast_days=1" | python3 -c "import json,sys; print('elev', json.load(sys.stdin).get('elevation'))" >> out/src.txt
