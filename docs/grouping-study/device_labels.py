#!/usr/bin/env python3
"""Round-1 device verdicts → pairwise constraints (m0.9 phase 10).

Usage: venv/bin/python device_labels.py <verdict.json> <manifest.json> <out.json>

Each judged card becomes must-link and cannot-link pairs over photo ids:
  group / ok ........ every member pair must link (extra members are fine —
                      the product errs inclusive, so a correct group that
                      grows is not a violation)
  group / split ..... Tristan's partition (transcribed below from the
                      notes): pairs within a part must link, pairs across
                      parts must not; a part named "single" is alone
  excluded / join ... the single must link with every member
  excluded / ok ..... the single must link with none
  excluded / split .. a partition, as for groups
  ambiguous ......... skipped
"""
import sys, json, os, itertools
VERDICT, MANIFEST, OUT = sys.argv[1:4]
v = json.load(open(VERDICT)); m = json.load(open(MANIFEST))

# Partitions by card number, as lists of parts of basenames; the part
# 'REST' stands for every member not named; a one-photo part is a single.
PARTS = {
  0: [['20220513_183212.jpg'], ['REST']],
  7: [['20210822_103954.jpg', '20210822_104004.jpg'], ['REST']],
  9: [['20210306_191518.jpg', '20210306_191523.jpg'], ['20210306_191537.jpg', '20210306_191540.jpg'], ['REST']],
  10: [['20221230_203315.jpg'], ['REST']],
  13: [['20210822_105312.jpg', '20210822_105342.jpg'], ['REST']],
  14: [['20220322_190757.jpg', '20220322_190747.jpg'], ['REST']],
  22: [['20210311_191322.jpg'], ['REST']],
  23: [['20220423_162356.jpg', '20220423_162357.jpg'], ['20220423_162443.jpg'], ['REST']],
  27: [['20210821_075625.jpg'], ['20210821_075708.jpg'], ['REST']],
  31: [['20210319_184756.jpg'], ['REST']],
  32: [['20220720_122903.jpg'], ['20220720_122654.jpg', '20220720_122656.jpg'], ['REST']],
  34: [['20211119_192200.jpg', '20211119_192146.jpg'], ['REST']],
  # 37: the note names 20220716_162434.jpg, which is not on the card (a
  # typo for one of its four members) — left unconstrained for round 2.
  43: [['20210322_170100.jpg'], ['REST']],
  55: [['20220716_162426.jpg', '20220716_162434.jpg'], ['REST']],
  61: [['20220717_123846.jpg'], ['REST']],
  64: [['20211211_194309.jpg', '20211211_194325.jpg'], ['REST']],
  # exclusion cards judged 'split': the single is a member here too
  73: [['20220720_122415.jpg', '20220720_122418.jpg'], ['20220720_122654.jpg', '20220720_122656.jpg'], ['20220720_121227.jpg'], ['REST']],
  76: [['20220717_131436.jpg', '20220717_131445.jpg'], ['20220717_130257.jpg'], ['REST']],
}
# #27: "should be singles or in their own group" → both readings allowed;
# scoring them apart from REST is what matters, so each is its own part
# and the pair between them is left unconstrained (see below).
UNCONSTRAINED_PAIRS = {27: [('20210821_075625.jpg', '20210821_075708.jpg')]}

def base(u): return os.path.basename(u)
cards = []
for k in sorted(v, key=int):
    n = int(k); val = v[k]; c = m[n]
    members = c['members']
    byname = {base(u): u for u in members}
    must, cannot = [], []
    verdict = val['v']
    if verdict == 'ambiguous':
        continue
    if c['type'] == 'group' and verdict == 'ok':
        must = list(itertools.combinations(members, 2))
    elif c['type'] == 'excluded' and verdict == 'join':
        s = c['excluded']; must = [(s, u) for u in members if u != s]
    elif c['type'] == 'excluded' and verdict == 'ok':
        s = c['excluded']; cannot = [(s, u) for u in members if u != s]
    elif n in PARTS:
        named = {x for part in PARTS[n] for x in part if x != 'REST'}
        unknown = named - set(byname)
        if unknown:
            raise SystemExit(f'card {n}: names not in card: {unknown}')
        parts = [[byname[x] for x in part] if part != ['REST'] else [u for u in members if base(u) not in named]
                 for part in PARTS[n]]
        parts = [p for p in parts if p]
        skip = {tuple(sorted((byname[a], byname[b]))) for a, b in UNCONSTRAINED_PAIRS.get(n, [])}
        for part in parts:
            must += list(itertools.combinations(part, 2))
        for pa, pb in itertools.combinations(parts, 2):
            for a in pa:
                for b in pb:
                    if tuple(sorted((a, b))) not in skip:
                        cannot.append((a, b))
    else:
        print(f'card {n} ({c["type"]}/{verdict}) has no transcription — skipped')
        continue
    cards.append({'card': n, 'type': c['type'], 'verdict': verdict, 'members': members,
                  'must': must, 'cannot': cannot, 'note': val.get('note', '')})
json.dump({'source': 'data/verdicts_device_round1.json over data/device-round1-manifest.json (S10e, v26, 2026-10-05)', 'cards': cards}, open(OUT, 'w'), indent=1)
kinds = {}
for c in cards: kinds[(c['type'], c['verdict'])] = kinds.get((c['type'], c['verdict']), 0) + 1
print('cards with constraints:', len(cards), kinds)
print('must pairs:', sum(len(c['must']) for c in cards), 'cannot pairs:', sum(len(c['cannot']) for c in cards))
