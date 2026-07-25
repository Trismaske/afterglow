#!/usr/bin/env python3
"""Deterministically rebuild the frozen label fixtures from all judged inputs.

Usage: venv/bin/python freeze_labels.py
Inputs (all human-verdicted): curated expected.json cases, data/round{1..4}-labels.json,
data/verdicts_validation.json + data/validation-manifest.json (conflict/outlier/
interpreted adjudications), data/verdicts_adjudication.json + data/adjudication-manifest.json
(transitive-contradiction edge verdicts).
Outputs: labels-v1.json + embeddings-labeled-v1.json (committed fixtures).

Precedence (later wins): round labels < validation overrides < adjudication overrides.
Invariants enforced: unique unordered pair keys; hard/soft/retired disjoint
(hard wins over soft; retired excluded from both); transitivity audit printed.
"""
import json, os, glob, itertools, base64, hashlib, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
PHONESYNC = '/home/tristan/PhoneSync'
MODEL = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    HERE, '../../apps/mobile/modules/image-embedder/android/src/main/assets/mobilenet_v3_large.tflite')
if not os.path.exists(MODEL):
    sys.exit(f'model not found at {MODEL} — fetch it per apps/mobile/modules/image-embedder/README.md '
             f'or pass the path as the first argument')
# v1 is pinned to exactly this model; a v2 freeze changes this constant deliberately.
EXPECTED_MODEL_SHA = '11af3c560dfeed7737cb4c03c23bf52a8403020784192d4dea0b74862a12828d'
FROZEN_DATE = '2026-07-25'

def base(p):
    return os.path.basename(p)

# ---- 1. base entries: curated + rounds (round-4 interpreted corrections already
# baked into round4-labels.json via the validation round replacements below) ----
entries, soft_all = [], []
for dir_ in ["In Group But Shouldn't Be", 'Not In Group']:
    for f in glob.glob(f'{PHONESYNC}/{dir_}/*/expected.json'):
        if 'Not In Group/4' in f:
            continue  # aspirational case — soft by decision
        exp = json.load(open(f))
        for g in exp['groups']:
            for a, b in itertools.combinations(g, 2):
                entries.append((a, b, 'link'))
        for gi, gj in itertools.combinations(exp['groups'], 2):
            for a in gi:
                for b in gj:
                    entries.append((a, b, 'apart'))

# validation round replaced two interpreted round-4 sources; rebuild that set
val_verd = json.load(open('data/verdicts_validation.json'))
val_man = json.load(open('data/validation-manifest.json'))
if len(val_verd) != len(val_man):
    sys.exit(f'validation incomplete: {len(val_verd)}/{len(val_man)} verdicts — re-export from validation.html')
replaced_srcs, val_extra = set(), []
val_overrides, val_retired = {}, set()
for cid, v in val_verd.items():
    card = val_man[int(cid)]
    if card['type'] in ('conflict', 'outlier'):
        pair = frozenset(card['members'])
        if v['v'] == 'retire':
            val_retired.add(pair)
        elif v['v'] in ('link', 'apart'):
            val_overrides[pair] = v['v']
    elif card['type'] == 'interpreted' and v['v'] == 'wrong':
        src = card['note'].split('your ')[1].split(' note')[0]
        replaced_srcs.add(src)
        if int(cid) == 65:
            trio = ['20260509_125321.jpg', '20260509_125327.jpg', '20260509_125337.jpg']
            outs = ['20260509_123905.jpg', '20260509_125522.jpg']
            val_extra += [(a, b, 'link') for a, b in itertools.combinations(trio, 2)]
            val_extra += [(o, m, 'apart') for o in outs for m in trio]
            val_extra += [(outs[0], outs[1], 'apart')]
        elif int(cid) == 68:
            ms = sorted({m for g in card['partition'] for m in g})
            val_extra += [(a, b, 'link') for a, b in itertools.combinations(ms, 2)]
        else:
            sys.exit(f'unhandled interpreted correction card #{cid} — extend freeze_labels.py')

for rf in ('round1', 'round2', 'round3', 'round4'):
    r = json.load(open(f'data/{rf}-labels.json'))
    entries += [(h['a'], h['b'], h['rel']) for h in r['hard'] if h['src'] not in replaced_srcs]
    soft_all += [{'a': h['a'], 'b': h['b'], 'lean': h.get('lean')} for h in r['soft']]
entries += val_extra

# ---- 2. merge with precedence ----
final = {}
dropped_conflicts = set()
for a, b, rel in entries:
    k = frozenset((a, b))
    if k in final and final[k] != rel:
        dropped_conflicts.add(k)
    else:
        final[k] = rel
for k in dropped_conflicts:
    final.pop(k, None)
retired = set(val_retired)
for k, rel in val_overrides.items():
    final[k] = rel
    dropped_conflicts.discard(k)
for k in retired:
    final.pop(k, None)

adj_verd = json.load(open('data/verdicts_adjudication.json'))
adj_man = json.load(open('data/adjudication-manifest.json'))
if len(adj_verd) != len(adj_man):
    sys.exit(f'adjudication incomplete: {len(adj_verd)}/{len(adj_man)} verdicts')
for cid, v in adj_verd.items():
    e = adj_man[int(cid)]
    k = frozenset((e['a'], e['b']))
    if v['v'] in ('link', 'apart'):
        final[k] = v['v']
    elif v['v'] == 'retire':
        final.pop(k, None)
        retired.add(k)

unresolved = dropped_conflicts - set(val_overrides) - set(retired)
if unresolved:
    sys.exit(f'{len(unresolved)} pair conflicts lack adjudication — regenerate a validation sheet')

# ---- 3. soft: dedupe, merge leans, disjoint from hard/retired ----
soft_by_pair = {}
for s in soft_all:
    k = frozenset((s['a'], s['b']))
    if k in final or k in retired:
        continue
    prev = soft_by_pair.get(k)
    lean = s.get('lean')
    if prev is None:
        soft_by_pair[k] = lean
    elif prev != lean:
        soft_by_pair[k] = None  # disagreeing leans → no lean
soft_final = sorted(
    ({'a': sorted(k)[0], 'b': sorted(k)[1], 'lean': l} for k, l in soft_by_pair.items()),
    key=lambda s: (s['a'], s['b']))

pairs = sorted(({'a': sorted(k)[0], 'b': sorted(k)[1], 'rel': r} for k, r in final.items()),
               key=lambda p: (p['a'], p['b']))
links = sum(1 for p in pairs if p['rel'] == 'link')

# ---- 4. transitivity audit on the true final set ----
photos = sorted({p[x] for p in pairs for x in 'ab'})
parent = {p: p for p in photos}
def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x
for p in pairs:
    if p['rel'] == 'link':
        ra, rb = find(p['a']), find(p['b'])
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
contradictions = [p for p in pairs if p['rel'] == 'apart' and find(p['a']) == find(p['b'])]
deliberate = {frozenset((adj_man[int(c)]['a'], adj_man[int(c)]['b']))
              for c, v in adj_verd.items() if v['v'] == 'apart'}
unexplained = [p for p in contradictions if frozenset((p['a'], p['b'])) not in deliberate]
print(f'transitivity: {len(contradictions)} apart-in-component edges '
      f'({len(contradictions) - len(unexplained)} human-adjudicated as deliberate, {len(unexplained)} unexplained)')
if unexplained:
    sys.exit('unexplained transitive contradictions — adjudicate before freezing')

# ---- 5. build BOTH payloads, validate everything, then write atomically ----
model_sha = hashlib.sha256(open(MODEL, 'rb').read()).hexdigest()
if model_sha != EXPECTED_MODEL_SHA:
    sys.exit(f'model at {MODEL} hashes to {model_sha[:12]}…, but labels-v1 is pinned to '
             f'{EXPECTED_MODEL_SHA[:12]}… — wrong model file; v2 freezes update the pin deliberately')
data = np.load('data/embeddings-mnv3l.npz', allow_pickle=False)
keys, vecs = [str(k) for k in data['keys']], data['vecs']
if 'model_sha256' in data:
    npz_sha = str(data['model_sha256'])
    if npz_sha != model_sha:
        sys.exit(f'embedding archive was generated by model {npz_sha[:12]}…, '
                 f'but the pinned model is {model_sha[:12]}… — re-run embed.py')
else:
    sys.exit('embedding archive lacks model provenance — regenerate with the current embed.py')
DIM = int(data['dim']) if 'dim' in data else vecs.shape[1]
if vecs.ndim != 2 or vecs.shape[1] != DIM or DIM != 1280:
    sys.exit(f'unexpected embedding shape {vecs.shape} (expected N×1280) — wrong archive?')

by_base = {}
for i, k in enumerate(keys):
    rank = 0 if '/DCIM/Camera/' in k else (1 if '/data/photos/' in k else 2)
    b = base(k)
    if b not in by_base or rank < by_base[b][0]:
        by_base[b] = (rank, i)
ts = {}
for line in open('data/s23-hashes.jsonl'):
    r = json.loads(line)
    ts[base(r['u'])] = r['ts']
needed = sorted({p[x] for p in pairs for x in 'ab'} | {s[x] for s in soft_final for x in 'ab'})
fix, missing = {}, []
for name in needed:
    if name in by_base:
        v = vecs[by_base[name][1]].astype(np.float32)
        fix[name] = {'ts': ts.get(name), 'vec': base64.b64encode(v.tobytes()).decode()}
    else:
        missing.append(name)
if missing:
    sys.exit(f'missing embeddings for {missing} — re-run embed.py first (no fixtures written)')

adjudicated_apart = sorted(sorted(k) for k in deliberate)
labels_payload = {
    'version': 'labels-v1', 'frozen': FROZEN_DATE,
    'model': {'name': 'mediapipe mobilenet_v3_large float32', 'sha256': model_sha},
    'provenance': 'curated cases + judged rounds 1-4 + validation round + transitive-contradiction adjudication (all Tristan-verdicted)',
    'deliberate_nontransitive_apart': [{'a': a, 'b': b} for a, b in adjudicated_apart],
    'hard': pairs, 'soft': soft_final,
    'retired': [{'a': a, 'b': b} for a, b in sorted(sorted(k) for k in retired)],
}
embed_payload = {'version': 'labels-v1', 'dim': DIM, 'encoding': 'base64 float32 LE, L2-normalized',
                 'model_sha256': model_sha, 'photos': fix}
# write both temporaries first, then replace both — a failure mid-write
# leaves the committed pair untouched
outputs = (('labels-v1.json', labels_payload), ('embeddings-labeled-v1.json', embed_payload))
for path, payload in outputs:
    with open(path + '.tmp', 'w') as f:
        json.dump(payload, f, indent=1 if path.startswith('labels') else None)
for path, _ in outputs:
    os.replace(path + '.tmp', path)
print(f'labels-v1: {len(pairs)} hard ({links} link / {len(pairs) - links} apart), '
      f'{len(soft_final)} soft, {len(retired)} retired')
print(f'fixture: {len(fix)} photos, {os.path.getsize("embeddings-labeled-v1.json") // 1024} KB')
