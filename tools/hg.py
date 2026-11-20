# Niederschlagsart (DWD HymecNG-Komposit) für die Radarseite aufbereiten.
# Ergebnis: radar-out/hg.bin = zlib-gepacktes Raster 1100 x 1200 (RADOLAN-Gitter, Zeile 0 = Norden)
# mit Codes 0 Regen, 1 Schneeregen, 2 Schnee, 3 gefrierender Regen, 4 Graupel, 5 Hagel, 255 unbekannt.
# Lücken (dort, wo gerade kein Niederschlag fällt) werden mit der nächstgelegenen Messung gefüllt (bis 100 km),
# damit heranziehender Niederschlag in der Vorhersage die Art bekommt, die dort gerade beobachtet wird.
import io, json, os, sys, urllib.request, zlib
import h5py, numpy as np
from scipy import ndimage

URL = 'https://opendata.dwd.de/weather/radar/composite/hymecng/composite_HymecNG_LATEST_000-hd5'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'radar-out'
os.makedirs(OUT, exist_ok=True)

raw = urllib.request.urlopen(URL, timeout=60).read()
h = h5py.File(io.BytesIO(raw), 'r')
w = h['dataset1/what'].attrs
t = w['enddate'].decode() + w['endtime'].decode()
stamp = f'{t[0:4]}-{t[4:6]}-{t[6:8]}T{t[8:10]}:{t[10:12]}:00Z'
meta_path = os.path.join(OUT, 'hg.json')
if os.path.exists(meta_path) and json.load(open(meta_path)).get('time') == stamp:
    print('unverändert', stamp); sys.exit(3)

d = h['dataset1/data1/data'][:]
assert d.shape == (1200, 1100), d.shape
code = np.full(d.shape, 255, np.uint8)
for src, dst in {2: 0, 3: 0, 6: 1, 7: 2, 4: 3, 5: 3, 8: 4, 9: 5, 10: 5}.items():
    code[d == src] = dst
valid = code != 255
if valid.any():
    dist, (iy, ix) = ndimage.distance_transform_edt(~valid, return_indices=True)
    filled = code[iy, ix]
    filled[dist > 100] = 255
else:
    filled = code
open(os.path.join(OUT, 'hg.bin'), 'wb').write(zlib.compress(filled.tobytes(), 9))
counts = {int(k): int(v) for k, v in zip(*np.unique(code[valid], return_counts=True))}
json.dump({'time': stamp, 'w': 1100, 'h': 1200, 'counts': counts}, open(meta_path, 'w'))
print('neu', stamp, counts)
