#!/usr/bin/env python3
"""Phase A evaluation: does an embedding separate Tristan's labeled cases where dHash could not?

Usage: venv/bin/python eval_embed.py <embeddings.npz>
Prints (A) per-case cosine similarities within/cross, with global separation stats;
(B) random unrelated-pair similarity distribution (FP-rate curve vs threshold).
"""
import sys, os, json, glob, itertools, random
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
data = np.load(sys.argv[1], allow_pickle=False)
keys, vecs = list(data['keys']), data['vecs']
by_base = {}
for i, k in enumerate(keys):
    base = os.path.basename(str(k))
    # prefer DCIM/Camera originals, then any pulled corpus copy, then PhoneSync copy
    rank = 0 if '/DCIM/Camera/' in str(k) else (1 if '/data/photos/' in str(k) else 2)
    if base not in by_base or rank < by_base[base][0]:
        by_base[base] = (rank, i)

def sim(a, b):
    return float(np.dot(vecs[a], vecs[b]))

# ---- A. labeled cases ----
print('== A. Case cosine similarities (higher = more similar) ==')
all_within, all_cross = [], []
for dir_, tag in [("In Group But Shouldn't Be", 'BAD'), ('Not In Group', 'NIG')]:
    for sub in sorted(os.listdir(os.path.join('/home/tristan/PhoneSync', dir_)), key=str):
        f = os.path.join('/home/tristan/PhoneSync', dir_, sub, 'expected.json')
        if not os.path.exists(f):
            continue
        exp = json.load(open(f))
        groups = [[by_base[n][1] for n in g if n in by_base] for g in exp['groups']]
        within = [(a, b) for g in groups for a, b in itertools.combinations(g, 2)]
        cross = [(a, b) for gi, gj in itertools.combinations(groups, 2) for a in gi for b in gj]
        w = [sim(a, b) for a, b in within]
        c = [sim(a, b) for a, b in cross]
        all_within += w
        all_cross += c
        fmt = lambda xs: ' '.join(f'{x:.3f}' for x in xs) or '-'
        print(f'{tag}/{sub:>2} within: [{fmt(w)}] cross: [{fmt(c)}]')
print(f'\nwithin: n={len(all_within)} min={min(all_within):.3f} median={np.median(all_within):.3f}')
print(f'cross : n={len(all_cross)} max={max(all_cross):.3f} median={np.median(all_cross):.3f}')
viol = sum(1 for c in all_cross for w in [0] if c >= min(all_within))
print(f'cross pairs >= min(within): {sum(1 for c in all_cross if c >= min(all_within))}/{len(all_cross)}')
# simple sweep: threshold t groups a pair if sim>=t; count satisfied cases
print('\nthreshold sweep over labeled pairs:')
for t in [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]:
    tp = sum(1 for w in all_within if w >= t)
    fp = sum(1 for c in all_cross if c >= t)
    print(f'  t={t:.2f}: must-link kept {tp}/{len(all_within)}, must-not-link violated {fp}/{len(all_cross)}')

# ---- B. random unrelated pairs (corpus sample) ----
corpus = [i for i, k in enumerate(keys) if '/data/photos/' in str(k)]
# timestamps via the dump: match by path suffix
ts = {}
for line in open(os.path.join(HERE, 'data/s23-hashes.jsonl')):
    r = json.loads(line)
    ts[os.path.basename(r['u'])] = r['ts']
random.seed(7)
sims = []
for _ in range(200000):
    a, b = random.sample(corpus, 2)
    ta = ts.get(os.path.basename(str(keys[a]))); tb = ts.get(os.path.basename(str(keys[b])))
    if ta is None or tb is None or abs(ta - tb) < 3 * 60000:
        continue
    sims.append(sim(a, b))
sims = np.array(sims)
print(f'\n== B. unrelated-pair (>3min) cosine distribution, n={len(sims)} ==')
for t in [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]:
    print(f'  P(sim>={t:.2f}) = {100 * float(np.mean(sims >= t)):.4f}%')
