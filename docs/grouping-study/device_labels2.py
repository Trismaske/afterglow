#!/usr/bin/env python3
"""Round-2 export → pairwise constraints (m0.9 phase 10).

Usage: venv/bin/python device_labels2.py <export.json> <round2-manifest.json> <out.json>

The export holds, per card, the tapped partition (uri → part index, -1 =
single) and a verdict: 'ok' (the proposal as shown), 'edited' (the taps
count), 'whole' (one group, no parts), 'ambiguous' (skipped). Pairs in
one part must link; pairs across parts, and a single against everyone,
must not. 'whole' makes every pair a must-link.
"""
import sys, json, itertools
EXPORT, MANIFEST, OUT = sys.argv[1:4]
state = json.load(open(EXPORT)); manifest = json.load(open(MANIFEST))
cards = []
for c in manifest:
    st = state.get(str(c['id']))
    if not st or not st.get('v') or st['v'] == 'ambiguous':
        continue
    members = [u for part in c['parts'] for u in part]
    if st['v'] == 'whole':
        parts = {u: 0 for u in members}
    else:
        parts = {u: st['parts'].get(u, -1) for u in members}
    must, cannot = [], []
    for a, b in itertools.combinations(members, 2):
        pa, pb = parts[a], parts[b]
        if pa >= 0 and pa == pb:
            must.append((a, b))
        else:
            cannot.append((a, b))
    cards.append({'card': c['id'], 'kind': c['kind'], 'verdict': st['v'], 'members': members,
                  'parts': parts, 'must': must, 'cannot': cannot, 'note': st.get('note', '')})
json.dump({'source': f'{EXPORT} over {MANIFEST}', 'cards': cards}, open(OUT, 'w'), indent=1)
kinds = {}
for c in cards: kinds[(c['kind'], c['verdict'])] = kinds.get((c['kind'], c['verdict']), 0) + 1
print('cards:', len(cards), kinds, 'must', sum(len(c['must']) for c in cards), 'cannot', sum(len(c['cannot']) for c in cards))
