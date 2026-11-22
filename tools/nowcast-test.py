# Rückrechnung Kurzfrist-Radar: reine Verschiebung (DWD) gegen Verschiebung + Trend (Ab-/Zunahme)
# Läuft ca. 2,5 Std.: mehrere Startzeiten, später Vergleich mit den tatsächlichen Radarbildern.
import json, urllib.request, base64, zlib, time, datetime, sys
import numpy as np
def frame(t):
    iso = t.strftime('%Y-%m-%dT%H:%M')
    for k in range(4):
        try:
            d = json.load(urllib.request.urlopen(f'https://api.brightsky.dev/radar?format=compressed&date={iso}Z&last_date={iso}Z&tz=Etc/UTC', timeout=90))
            r = [x for x in d['radar'] if x['timestamp'].startswith(iso)]
            if not r: return None, None
            a = np.frombuffer(zlib.decompress(base64.b64decode(r[0]['precipitation_5'])), dtype='<u2').reshape(1200,1100).astype(np.float32)*0.12
            return a, r[0]['source']
        except Exception as e: err = e; time.sleep(10)
    print('Fehler', e); return None, None
def boxmean(a, r):
    c = np.pad(a, r, mode='edge').cumsum(0).cumsum(1); c = np.pad(c, ((1,0),(1,0)))
    n = 2*r+1
    return (c[n:, n:] - c[:-n, n:] - c[n:, :-n] + c[:-n, :-n]) / (n*n)
def floor5(t): return t.replace(second=0, microsecond=0, minute=t.minute - t.minute % 5)
LEADS = [30, 60, 90]; INITS = int(sys.argv[1]) if len(sys.argv) > 1 else 7
cases = []
for k in range(INITS):
    now = datetime.datetime.now(datetime.UTC).replace(tzinfo=None)
    t0 = floor5(now - datetime.timedelta(minutes=8))
    a0, s0 = frame(t0); am, _ = frame(t0 - datetime.timedelta(minutes=30))
    if a0 is None or am is None: print('übersprungen', t0); time.sleep(600); continue
    fc = {L: frame(t0 + datetime.timedelta(minutes=L))[0] for L in LEADS}
    cases.append({'t0': t0, 'a0': a0, 'am': am, 'fc': fc}); print('Start', t0, s0, 'nass %.1f %%' % (100*(a0 > 0.1).mean()), flush=True)
    if k < INITS - 1: time.sleep(600)
# warten, bis alle Vorhersagezeiten vorbei und gemessen sind
last = max(c['t0'] for c in cases) + datetime.timedelta(minutes=max(LEADS) + 12)
while datetime.datetime.now(datetime.UTC).replace(tzinfo=None) < last: time.sleep(60)
meth = {'nur Verschiebung (DWD)': None}
for R in (15, 30, 50):
    for kk in (0.5, 1.0):
        meth[f'Trend {R} km, Stärke {kk}'] = (R, kk)
res = {m: {L: [0, 0, 0, 0] for L in LEADS} for m in meth}   # Summe Fehler, Anzahl, Treffer nass/trocken, Anzahl
for c in cases:
    trends = {}
    for R in (15, 30, 50):
        b0, bm = boxmean(c['a0'], R), boxmean(c['am'], R)
        ok = (b0 > 0.02) & (bm > 0.02)
        g = np.where(ok, (b0 + 0.05)/(bm + 0.05), 1.0)
        trends[R] = g
    for L in LEADS:
        obs, _ = frame(c['t0'] + datetime.timedelta(minutes=L)); f = c['fc'][L]
        if obs is None or f is None: continue
        for m, p in meth.items():
            pr = f if p is None else f * np.clip(trends[p[0]] ** (p[1]*L/30), 0.3, 2.0)
            sel = (f > 0.05) | (obs > 0.05)
            r = res[m][L]; r[0] += float(np.abs(pr - obs)[sel].sum()); r[1] += int(sel.sum())
            r[2] += int(((pr >= 0.1) == (obs >= 0.1))[sel].sum()); r[3] += int(sel.sum())
print('\nFälle:', len(cases))
for m in meth:
    print('%-28s' % m + '  '.join('+%d min: %.3f mm/h, %.1f %% richtig' % (L, res[m][L][0]/max(1,res[m][L][1]), 100*res[m][L][2]/max(1,res[m][L][3])) for L in LEADS))
