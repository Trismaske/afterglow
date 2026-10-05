#!/usr/bin/env python3
"""Phase-10 round 3c (m0.9): pick the S23 far pairs a judged round shows.

Usage: venv/bin/python select_far_round.py <far-pairs.json> <out-pairs.json> <out-files.txt> [--dry]

Bands over far_links.mjs's pairs (units formed at the 15-minute window,
no far bar), each pair carrying the centroid cosine, the best and the
mean member pair:
  A. 15–60 min apart: every pair the shipped far bar joins (best member
     pair ≥ 0.85) plus a random 25 it refuses (0.78–0.85) — does the bar
     sit right on the S23?
  B. 1–24 h apart, mean member pair ≥ 0.85 — the band beyond the hour
     (PLAN.md backlog): would a far tier there ever earn its keep?
  C. 15–60 min apart, best member pair 0.70–0.78, a random 15 — the
     control below the bar.
The pairs JSON feeds sheet_far.py; the files list is what to pull from
the phone (read-only) so the sheet has thumbnails.
"""
import sys, json, random, os
PAIRS, OUT, FILES = sys.argv[1:4]
dry = '--dry' in sys.argv
random.seed(23)
pairs = json.load(open(PAIRS))
MIN = 60
A_join = [p for p in pairs if 15 * MIN < p['gap_s'] <= 60 * MIN and p['best'] >= 0.85]
A_refused_pool = [p for p in pairs if 15 * MIN < p['gap_s'] <= 60 * MIN and 0.78 <= p['best'] < 0.85]
A = A_join + random.sample(A_refused_pool, min(25, len(A_refused_pool)))
B = [p for p in pairs if 60 * MIN < p['gap_s'] <= 24 * 60 * MIN and p['mean'] >= 0.85]
C_pool = [p for p in pairs if 15 * MIN < p['gap_s'] <= 60 * MIN and 0.70 <= p['best'] < 0.78]
C = random.sample(C_pool, min(15, len(C_pool)))
print(f'band A (15–60 min): {len(A_join)} the bar joins (best ≥ 0.85) + {len(A) - len(A_join)} of {len(A_refused_pool)} it refuses (0.78–0.85) · band B (1–24 h, mean ≥ 0.85): {len(B)} · band C controls: {len(C)} of {len(C_pool)}')
if dry:
    sys.exit(0)
chosen = []
seen = set()
for band, rows in (('A', A), ('B', B), ('C', C)):
    for p in rows:
        key = (tuple(p['a']), tuple(p['b']))
        if key in seen:
            continue
        seen.add(key)
        chosen.append({**p, 'band': band})
chosen.sort(key=lambda p: -p['sim'])
json.dump(chosen, open(OUT, 'w'), indent=1)
files = sorted({os.path.basename(u) for p in chosen for u in p['a'] + p['b']})
open(FILES, 'w').write('\n'.join(files) + '\n')
print(f'{len(chosen)} cards, {len(files)} files → {OUT}, {FILES}')
