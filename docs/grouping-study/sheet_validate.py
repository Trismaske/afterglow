#!/usr/bin/env python3
"""Validation round: audit the label set before it becomes a CI fixture.

Cards:
  A. conflict     — pairs labeled both link and apart across rounds → adjudicate
  B. outlier      — must-links with lowest sim / must-not-links with highest sim → re-confirm
  C. interpreted  — round-4 partitions/splits encoded from Claude's reading of notes → confirm
  D. transitivity — link-connected components containing an apart pair → inspect

Usage: venv/bin/python sheet_validate.py data/embeddings-mnv3l.npz data/validation.html
Verdicts: for pair cards "same group" / "separate" / "retire (ambiguous)";
for partition cards ✓ as-shown / wrong (note). Export JSON as usual.
"""
import sys, os, json, glob, html, itertools
import numpy as np
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
NPZ, OUT = sys.argv[1], sys.argv[2]
N_OUTLIERS = 20  # per direction

data = np.load(NPZ, allow_pickle=False)
keys, vecs = [str(k) for k in data['keys']], data['vecs']
by_base = {}
for i, k in enumerate(keys):
    rank = 0 if '/DCIM/Camera/' in k else (1 if '/data/photos/' in k else 2)
    b = os.path.basename(k)
    if b not in by_base or rank < by_base[b][0]:
        by_base[b] = (rank, i, k)

# ---- load all labels with provenance ----
entries = []  # (a, b, rel, src)
for dir_ in ["In Group But Shouldn't Be", 'Not In Group']:
    for f in glob.glob(f'/home/tristan/PhoneSync/{dir_}/*/expected.json'):
        if 'Not In Group/4' in f:
            continue
        case = f.split('PhoneSync/')[1].rsplit('/expected', 1)[0]
        exp = json.load(open(f))
        for g in exp['groups']:
            for a, b in itertools.combinations(g, 2):
                entries.append((a, b, 'link', f'curated:{case}'))
        for gi, gj in itertools.combinations(exp['groups'], 2):
            for a in gi:
                for b in gj:
                    entries.append((a, b, 'apart', f'curated:{case}'))
for rf in ('round1', 'round2', 'round3', 'round4'):
    r = json.load(open(os.path.join(HERE, f'data/{rf}-labels.json')))
    entries += [(h['a'], h['b'], h['rel'], h['src']) for h in r['hard']]

by_pair = {}
for a, b, rel, src in entries:
    by_pair.setdefault(frozenset((a, b)), []).append((rel, src))

def sim(a, b):
    ia, ib = by_base.get(a), by_base.get(b)
    if ia is None or ib is None:
        return None
    return float(np.dot(vecs[ia[1]], vecs[ib[1]]))

cards = []
# A. conflicts
for pair, votes in by_pair.items():
    rels = {r for r, _ in votes}
    if len(rels) > 1:
        a, b = sorted(pair)
        s = sim(a, b)
        cards.append({'type': 'conflict', 'members': [a, b], 'sim': s or 0,
                      'note': ' vs '.join(f'{r} ({src})' for r, src in votes)})
# B. outliers among non-conflicted
clean = {p: v[0][0] for p, v in by_pair.items() if len({r for r, _ in v}) == 1}
links = sorted(((sim(*sorted(p)), p) for p, r in clean.items() if r == 'link' and sim(*sorted(p)) is not None))
aparts = sorted(((sim(*sorted(p)), p) for p, r in clean.items() if r == 'apart' and sim(*sorted(p)) is not None), reverse=True)
for s, p in links[:N_OUTLIERS]:
    a, b = sorted(p)
    cards.append({'type': 'outlier', 'members': [a, b], 'sim': s,
                  'note': f'labeled SAME GROUP but similarity is very low ({s:.3f}) — confirm?'})
for s, p in aparts[:N_OUTLIERS]:
    a, b = sorted(p)
    cards.append({'type': 'outlier', 'members': [a, b], 'sim': s,
                  'note': f'labeled SEPARATE but similarity is very high ({s:.3f}) — confirm?'})
# C. interpreted round-4 conversions: show encoded partitions
r4 = json.load(open(os.path.join(HERE, 'data/round4-labels.json')))
by_src = {}
for h in r4['hard']:
    by_src.setdefault(h['src'], []).append(h)
INTERPRETED_SRCS = {f'r4#{i}' for i in (0, 2, 3, 4, 6, 7, 12, 30, 44)}  # reconstructed partitions/splits only
for src, hs in sorted(by_src.items()):
    if src not in INTERPRETED_SRCS:
        continue  # direct verdicts need no confirmation
    # reconstruct partition groups from link edges
    photos = sorted({h['a'] for h in hs} | {h['b'] for h in hs})
    parent = {p: p for p in photos}
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for h in hs:
        if h['rel'] == 'link':
            ra, rb = find(h['a']), find(h['b'])
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)
    groups = {}
    for p in photos:
        groups.setdefault(find(p), []).append(p)
    cards.append({'type': 'interpreted', 'partition': sorted(groups.values()), 'sim': 0,
                  'note': f'encoded from your {src} note — bars separate the groups I recorded'})
# D. transitivity: link-components containing an apart pair
photos_all = sorted({x for p in clean for x in p})
parent = {p: p for p in photos_all}
def find2(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x
for p, r in clean.items():
    if r == 'link':
        a, b = sorted(p)
        ra, rb = find2(a), find2(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
tcount = 0
for p, r in clean.items():
    if r == 'apart' and tcount < 10:
        a, b = sorted(p)
        if find2(a) == find2(b):
            s = sim(a, b)
            cards.append({'type': 'transitivity', 'members': [a, b], 'sim': s or 0,
                          'note': 'labeled SEPARATE but link-chained together through other labeled pairs — which wins?'})
            tcount += 1
print(f'cards: {len(cards)} (' + ', '.join(f'{t}={sum(1 for c in cards if c["type"]==t)}' for t in ('conflict', 'outlier', 'interpreted', 'transitivity')) + ')')

thumb_dir = os.path.join(HERE, 'data/thumbs')
os.makedirs(thumb_dir, exist_ok=True)
def thumb(name):
    ent = by_base.get(name)
    if ent is None:
        return ''
    out = os.path.join(thumb_dir, name + '.jpg')
    if not os.path.exists(out):
        img = ImageOps.exif_transpose(Image.open(ent[2])).convert('RGB')
        img.thumbnail((256, 256))
        img.save(out, quality=80)
    return os.path.relpath(out, os.path.dirname(os.path.abspath(OUT)))

def fig(name):
    return f'<figure><img src="{html.escape(thumb(name))}" loading="lazy"><figcaption>{html.escape(name)}</figcaption></figure>'

rows = []
for n, card in enumerate(cards):
    if card['type'] == 'interpreted':
        imgs = '<div class="sep"></div>'.join(''.join(fig(m) for m in g) for g in card['partition'])
        buttons = '<button data-v="ok">✓ as shown</button><button data-v="wrong">✗ wrong (note!)</button>'
    else:
        imgs = ''.join(fig(m) for m in card['members'])
        buttons = ('<button data-v="link">same group</button>'
                   '<button data-v="apart">separate</button>'
                   '<button data-v="retire">retire (ambiguous)</button>')
    rows.append(f'''<div class="card"><h3>#{n} — {card['type']} · sim {card['sim']:.3f} · {html.escape(card['note'])}</h3>
<div class="imgs">{imgs}</div>
<div class="verdict" data-id="{n}">{buttons}
<input type="text" placeholder="note (optional)" class="note"></div></div>''')

page = f'''<!doctype html><meta charset="utf-8"><title>Grouping labels — validation round</title>
<style>body{{font-family:sans-serif;background:#111;color:#ddd;margin:1rem}}
.card{{border:1px solid #333;border-radius:8px;padding:.6rem;margin:.8rem 0}}
.imgs{{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}}
figure{{margin:0}} figcaption{{font-size:.6rem;color:#888}} img{{height:170px;border-radius:4px}}
.sep{{width:6px;height:130px;background:#4a6;border-radius:3px}}
.verdict button{{margin:.2rem;padding:.3rem .6rem}} .verdict .picked{{background:#2f6f3f;color:#fff}}
#export{{width:100%;height:8rem}} h3{{margin:.2rem 0;font-size:.85rem;color:#aaa}}</style>
<h1>Label validation · {len(cards)} cards</h1>
<p>These are the labels most likely to be wrong (conflicts, statistical outliers, my interpretations, chain contradictions). Your verdict here is FINAL for the CI fixture — "retire" removes the pair rather than forcing a call.</p>
{''.join(rows)}
<h2>Export</h2><button onclick="doExport()">Export verdicts</button><textarea id="export"></textarea>
<script>
const K='grouping-validation';
const state=JSON.parse(localStorage.getItem(K)||'{{}}');
document.querySelectorAll('.verdict').forEach(v=>{{
  const id=v.dataset.id;
  if(state[id]) {{ const b=v.querySelector(`[data-v="${{state[id].v}}"]`); if(b) b.classList.add('picked');
    v.querySelector('.note').value=state[id].note||''; }}
  v.querySelectorAll('button').forEach(b=>b.onclick=()=>{{
    v.querySelectorAll('button').forEach(x=>x.classList.remove('picked'));
    b.classList.add('picked');
    state[id]={{v:b.dataset.v,note:v.querySelector('.note').value}};
    localStorage.setItem(K,JSON.stringify(state));
  }});
  v.querySelector('.note').onchange=e=>{{ if(state[id]) {{ state[id].note=e.target.value; localStorage.setItem(K,JSON.stringify(state)); }} }};
}});
function doExport(){{document.getElementById('export').value=JSON.stringify(state,null,1);}}
</script>'''
with open(OUT, 'w') as f:
    f.write(page)
with open(OUT.replace('.html', '-manifest.json'), 'w') as f:
    json.dump([{k: v for k, v in c.items()} for c in cards], f, indent=1)
print(f'wrote {OUT} + manifest')
