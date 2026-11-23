# Sammelt EINEN Fall für die Radar-Trend-Rückrechnung (läuft ca. 105 min).
# Ergebnis: JSON mit Fehlersummen je Methode und Vorlauf -> Zweig nowcastarchiv.
import json, sys, datetime, time
sys.argv = sys.argv[:1]
exec(open(__file__.replace('nowcast-collect.py', 'nowcast-test.py')).read().split('LEADS =')[0])
LEADS = [30, 60, 90]
meth = {'shift': None}
for R in (15, 30, 50):
    for kk in (0.25, 0.5, 1.0): meth[f'{R}_{kk}'] = (R, kk)
now = datetime.datetime.now(datetime.UTC).replace(tzinfo=None)
t0 = floor5(now - datetime.timedelta(minutes=8))
a0, s0 = frame(t0); am, _ = frame(t0 - datetime.timedelta(minutes=30))
if a0 is None or am is None: print('keine Daten'); sys.exit(0)
fc = {L: frame(t0 + datetime.timedelta(minutes=L))[0] for L in LEADS}
wet = float((a0 > 0.1).mean())
while datetime.datetime.now(datetime.UTC).replace(tzinfo=None) < t0 + datetime.timedelta(minutes=max(LEADS) + 12): time.sleep(60)
trends = {}
for R in (15, 30, 50):
    b0, bm = boxmean(a0, R), boxmean(am, R)
    trends[R] = np.where((b0 > 0.02) & (bm > 0.02), (b0 + 0.05)/(bm + 0.05), 1.0)
out = {'t0': t0.isoformat(), 'wet': wet, 'res': {m: {} for m in meth}}
for L in LEADS:
    obs, _ = frame(t0 + datetime.timedelta(minutes=L)); f = fc[L]
    if obs is None or f is None: continue
    sel = (f > 0.05) | (obs > 0.05); n = int(sel.sum())
    for m, p in meth.items():
        pr = f if p is None else f * np.clip(trends[p[0]] ** (p[1]*L/30), 0.3, 2.0)
        out['res'][m][L] = [float(np.abs(pr - obs)[sel].sum()), n, int(((pr >= 0.1) == (obs >= 0.1))[sel].sum())]
json.dump(out, open('case.json', 'w')); print(t0, 'nass %.1f %%' % (100*wet))
