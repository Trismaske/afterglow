#!/usr/bin/env python3
"""Phase A: compare candidate embeddings on the combined label set.

Usage: venv/bin/python eval_compare.py <name=npz> [<name=npz> ...]
Labels: curated expected.json cases (hard) + data/round1-labels.json (hard + soft).
Per model: AUC over hard pairs, threshold sweep, unrelated-pair FP rate,
and soft-pair leaning alignment.
"""
import sys, os, json, glob, itertools, random
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- labels (by basename) ----
hard, soft = [], []  # (a, b, rel) / (a, b, lean)
for dir_ in ["In Group But Shouldn't Be", 'Not In Group']:
    for f in glob.glob(f'/home/tristan/PhoneSync/{dir_}/*/expected.json'):
        exp = json.load(open(f))
        soft_case = 'Not In Group/4' in f  # aspirational per Tristan
        groups = exp['groups']
        for g in groups:
            for a, b in itertools.combinations(g, 2):
                (soft if soft_case else hard).append((a, b, 'link') if not soft_case else (a, b, 'join'))
        for gi, gj in itertools.combinations(groups, 2):
            for a in gi:
                for b in gj:
                    hard.append((a, b, 'apart'))
r1 = json.load(open(os.path.join(HERE, 'data/round1-labels.json')))
hard += [(h['a'], h['b'], h['rel']) for h in r1['hard']]
soft += [(s['a'], s['b'], s['lean']) for s in r1['soft'] if s['lean']]
# dedupe, hard wins over soft
seen = {}
for a, b, rel in hard:
    seen[frozenset((a, b))] = rel
hard = [(sorted(k)[0], sorted(k)[1], rel) for k, rel in seen.items()]
soft = [(a, b, l) for a, b, l in soft if frozenset((a, b)) not in seen]
links = sum(1 for _, _, r in hard if r == 'link')
print(f'labels: {len(hard)} hard ({links} link / {len(hard) - links} apart), {len(soft)} soft')

ts = {}
for line in open(os.path.join(HERE, 'data/s23-hashes.jsonl')):
    r = json.loads(line)
    ts[os.path.basename(r['u'])] = r['ts']

def auc(pos, neg):
    """Mann-Whitney AUC: P(random link-sim > random apart-sim)."""
    allv = sorted((v, 1) for v in pos) + sorted((v, 0) for v in neg)
    allv.sort()
    rank_sum, r = 0.0, 1
    i = 0
    while i < len(allv):
        j = i
        while j < len(allv) and allv[j][0] == allv[i][0]:
            j += 1
        avg_rank = (r + r + (j - i) - 1) / 2
        rank_sum += avg_rank * sum(1 for k in range(i, j) if allv[k][1] == 1)
        r += j - i
        i = j
    n1, n0 = len(pos), len(neg)
    return (rank_sum - n1 * (n1 + 1) / 2) / (n1 * n0)

for arg in sys.argv[1:]:
    name, npz = arg.split('=')
    data = np.load(os.path.join(HERE, npz), allow_pickle=False)
    keys, vecs = [str(k) for k in data['keys']], data['vecs']
    by_base = {}
    for i, k in enumerate(keys):
        rank = 0 if '/DCIM/Camera/' in k else (1 if '/data/photos/' in k else 2)
        b = os.path.basename(k)
        if b not in by_base or rank < by_base[b][0]:
            by_base[b] = (rank, i)
    def sim(a, b):
        ia, ib = by_base.get(a), by_base.get(b)
        if ia is None or ib is None:
            return None
        return float(np.dot(vecs[ia[1]], vecs[ib[1]]))
    pos = [s for a, b, r in hard if r == 'link' and (s := sim(a, b)) is not None]
    neg = [s for a, b, r in hard if r == 'apart' and (s := sim(a, b)) is not None]
    print(f'\n== {name} (dim {vecs.shape[1]}) — pairs scored: {len(pos)} link, {len(neg)} apart ==')
    print(f'AUC = {auc(pos, neg):.4f} | link median {np.median(pos):.3f} | apart median {np.median(neg):.3f}')
    print('  thr   link-kept  apart-violated')
    for t in np.arange(0.30, 0.96, 0.05):
        print(f'  {t:.2f}   {sum(1 for s in pos if s >= t):4d}/{len(pos)}   {sum(1 for s in neg if s >= t):3d}/{len(neg)}')
    # unrelated-pair FP over corpus
    corpus = [i for i, k in enumerate(keys) if '/data/photos/' in k and os.path.basename(k) in ts]
    random.seed(7)
    sims = []
    for _ in range(150000):
        a, b = random.sample(corpus, 2)
        if abs(ts[os.path.basename(keys[a])] - ts[os.path.basename(keys[b])]) < 180000:
            continue
        sims.append(float(np.dot(vecs[a], vecs[b])))
    sims = np.array(sims)
    print('  unrelated-pair FP: ' + ' '.join(
        f'P(>={t:.2f})={100 * float(np.mean(sims >= t)):.3f}%' for t in (0.5, 0.6, 0.7, 0.8)))
    js = [s for a, b, l in soft if l == 'join' and (s := sim(a, b)) is not None]
    ap = [s for a, b, l in soft if l == 'apart' and (s := sim(a, b)) is not None]
    if js and ap:
        print(f'  soft pairs: lean-join median {np.median(js):.3f} vs lean-apart median {np.median(ap):.3f}')
