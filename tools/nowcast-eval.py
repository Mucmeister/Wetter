# Wertet alle gesammelten Fälle aus (Zweig nowcastarchiv, Ordner data/).
import json, glob, sys
cs = [json.load(open(f)) for f in sorted(glob.glob((sys.argv[1] if len(sys.argv) > 1 else 'data') + '/*.json'))]
cs = [c for c in cs if c['wet'] > 0.005]   # (fast) trockene Lagen zählen nicht
print('Fälle mit Niederschlag:', len(cs), cs[0]['t0'] if cs else '', '…', cs[-1]['t0'] if cs else '')
for m in cs[0]['res'] if cs else []:
    row = []
    for L in ('30', '60', '90'):
        e = n = h = 0; wins = 0
        for c in cs:
            r = c['res'][m].get(L)
            if not r: continue
            e += r[0]; n += r[1]; h += r[2]
            s = c['res']['shift'].get(L); wins += (r[2] > s[2])
        row.append('+%s: %.3f mm/h %.1f %% (besser in %d Fällen)' % (L, e/max(1,n), 100*h/max(1,n), wins))
    print('%-8s' % m, ' | '.join(row))
