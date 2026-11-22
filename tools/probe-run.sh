#!/bin/bash
set +e
python3 - <<'PY' > out/geo.txt 2>&1
import json, urllib.request, urllib.parse
for n in ['Bremen','Kreuth','Lenggries','Düsseldorf','Frankfurt am Main','Greven','Bodenheim','Guntersblum','Magdeburg','Köln','Braunschweig','Starnberg','Lichtenhaag','Schöllnach','Leipzig']:
    d = json.load(urllib.request.urlopen('https://geocoding-api.open-meteo.com/v1/search?count=5&language=de&countryCode=DE&name=' + urllib.parse.quote(n)))
    print(n, [(r['name'], r.get('admin1'), r.get('admin3'), r['latitude'], r['longitude'], r.get('elevation')) for r in d.get('results', [])][:3])
PY
