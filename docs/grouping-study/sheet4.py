#!/usr/bin/env python3
"""Round-2 contact sheet: validates the inclusive config (t=0.55 within bursts
+ adjacent-burst centroid merge ≤15 min at ≥0.65) against round-1's t=0.60.

Cards shown (deduped by basename; sets already judged in round 1 are skipped):
  - cross-burst merges produced by the new adjacent rule (new card type)
  - groups whose membership changed vs t=0.60 (the 0.55–0.60 inclusion band)
  - borderline exclusions 0.35–0.55
Usage: venv/bin/python sheet2.py data/embeddings-mnv3l.npz data/round2.html
"""
import sys, os, json, html
import numpy as np
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
NPZ, OUT = sys.argv[1], sys.argv[2]
T_IN, T_OLD, ADJ_MS, T_ADJ = 0.45, 0.55, 15 * 60 * 1000, 0.65
GAP_MS, BORDER_LO, MAX_CARDS = 3 * 60 * 1000, 0.30, 70

data = np.load(NPZ, allow_pickle=False)
keys, vecs = [str(k) for k in data['keys']], data['vecs']
by_base = {}
for i, k in enumerate(keys):
    rank = 0 if '/DCIM/Camera/' in k else (1 if '/data/photos/' in k else 2)
    b = os.path.basename(k)
    if b not in by_base or rank < by_base[b][0]:
        by_base[b] = (rank, i, k)
ts = {}
for line in open(os.path.join(HERE, 'data/s23-hashes.jsonl')):
    r = json.loads(line)
    ts[os.path.basename(r['u'])] = r['ts']
photos = sorted((ts[b], i, k) for b, (rk, i, k) in by_base.items()
                if b in ts and '/data/photos/' in k)
print(f'unique corpus photos: {len(photos)}')

def clusterize(items):
    out, cur = [], [items[0]]
    for prev, item in zip(items, items[1:]):
        if item[0] - prev[0] > GAP_MS:
            out.append(cur); cur = []
        cur.append(item)
    out.append(cur)
    return out

def centroid_groups(cluster, t):
    groups = []
    for item in cluster:
        best, best_sim = None, -1.0
        for g in groups:
            c = np.mean(vecs[[x[1] for x in g]], axis=0)
            c /= np.linalg.norm(c)
            s = float(np.dot(vecs[item[1]], c))
            if s > best_sim:
                best, best_sim = g, s
        if best is not None and best_sim >= t:
            best.append(item)
        else:
            groups.append([item])
    return groups

clusters = clusterize(photos)
stage1, stage1_old = [], []
for c in clusters:
    stage1 += centroid_groups(c, T_IN)
    stage1_old += centroid_groups(c, T_OLD)

# adjacent merges over stage1 groups
cents = []
for g in stage1:
    ids = [i for _, i, _ in g]
    c = np.mean(vecs[ids], axis=0); c /= np.linalg.norm(c)
    cents.append({'t0': min(x[0] for x in g), 't1': max(x[0] for x in g), 'c': c, 'g': g})
cents.sort(key=lambda x: x['t0'])
merges = []
for a in range(len(cents)):
    for b in range(a + 1, len(cents)):
        gap = cents[b]['t0'] - cents[a]['t1']
        if gap > ADJ_MS:
            break
        if gap <= GAP_MS:
            continue
        s = float(np.dot(cents[a]['c'], cents[b]['c']))
        if s >= T_ADJ:
            merges.append({'members': cents[a]['g'] + cents[b]['g'], 'sim': s,
                           'split_at': len(cents[a]['g'])})

# judged sets from round 1 (skip identical membership)
import glob as _glob
judged = set()
for mf in sorted(_glob.glob(os.path.join(HERE, 'data/*-manifest.json'))):
    stem = os.path.basename(mf).replace('-manifest.json', '')
    for cand in (f'data/verdicts_{stem}.json', f'data/verdict_{stem}.json'):
        vp = os.path.join(HERE, cand)
        if not os.path.exists(vp):
            continue
        verd = json.load(open(vp))
        man = json.load(open(mf))
        for cid in verd:
            card = man[int(cid)]
            members = card.get('members') or [p for g in card.get('partition', []) for p in g]
            judged.add(frozenset(os.path.basename(p) for p in members))
        break

old_sets = {frozenset(os.path.basename(k) for _, _, k in g) for g in stage1_old if len(g) >= 2}
cards = []
for m in merges:
    names = frozenset(os.path.basename(k) for _, _, k in m['members'])
    if names not in judged:
        cards.append({'type': 'adjmerge', 'members': m['members'], 'weakest': m['sim'],
                      'note': f'two bursts merged (centroid sim {m["sim"]:.3f})'})
for g in stage1:
    if len(g) < 2:
        continue
    names = frozenset(os.path.basename(k) for _, _, k in g)
    if names in judged or names in old_sets:
        continue  # unchanged vs round 1 / t=0.60 — already validated
    sims = [float(np.dot(vecs[a[1]], vecs[b[1]])) for x, a in enumerate(g) for b in g[x + 1:]]
    cards.append({'type': 'group', 'members': g, 'weakest': min(sims),
                  'note': 'new/changed at t=0.55'})
# borderline exclusions
for c in clusters:
    groups = centroid_groups(c, T_IN)
    for g in groups:
        if len(g) != 1:
            continue
        for other in groups:
            if len(other) < 2:
                continue
            cn = np.mean(vecs[[x[1] for x in other]], axis=0)
            cn /= np.linalg.norm(cn)
            s = float(np.dot(vecs[g[0][1]], cn))
            if BORDER_LO <= s < T_IN:
                names = frozenset(os.path.basename(k) for _, _, k in other + g)
                if names not in judged:
                    cards.append({'type': 'excluded', 'members': other + g,
                                  'excluded': g[0], 'weakest': s, 'note': ''})
cards.sort(key=lambda c: (0 if c['type'] == 'adjmerge' else 1, c['weakest']))
cards = cards[:MAX_CARDS]
print(f'cards: {len(cards)} (adjmerge {sum(1 for c in cards if c["type"]=="adjmerge")}, '
      f'group {sum(1 for c in cards if c["type"]=="group")}, '
      f'excluded {sum(1 for c in cards if c["type"]=="excluded")})')

thumb_dir = os.path.join(HERE, 'data/thumbs')
os.makedirs(thumb_dir, exist_ok=True)
def thumb(key):
    name = os.path.basename(key)
    out = os.path.join(thumb_dir, name + '.jpg')
    if not os.path.exists(out):
        img = ImageOps.exif_transpose(Image.open(key)).convert('RGB')
        img.thumbnail((256, 256))
        img.save(out, quality=80)
    return os.path.relpath(out, os.path.dirname(os.path.abspath(OUT)))

rows = []
for n, card in enumerate(cards):
    imgs = []
    for j, (t, i, k) in enumerate(card['members']):
        cls = ''
        if card.get('excluded') and card['excluded'][1] == i:
            cls = ' excluded'
        sep = '<div class="sep"></div>' if card['type'] == 'adjmerge' and j == next(
            (m['split_at'] for m in merges if m['members'] is card['members']), -1) else ''
        imgs.append(sep + f'<figure class="p{cls}"><img src="{html.escape(thumb(k))}" loading="lazy">'
                          f'<figcaption>{html.escape(os.path.basename(k))}</figcaption></figure>')
    title = {'adjmerge': 'cross-burst MERGE — one group?',
             'group': 'group (new at t=0.45)',
             'excluded': 'excluded photo (red) — should it join?'}[card['type']]
    rows.append(f'''<div class="card"><h3>#{n} — {title} · key sim {card['weakest']:.3f} · {html.escape(card.get('note') or '')}</h3>
<div class="imgs">{''.join(imgs)}</div>
<div class="verdict" data-id="{n}">
<button data-v="ok">✓ correct</button><button data-v="wrong">✗ wrong</button>
<button data-v="split">needs split</button><button data-v="join">should join</button>
<button data-v="ambiguous">ambiguous</button>
<input type="text" placeholder="note (optional)" class="note"></div></div>''')

page = f'''<!doctype html><meta charset="utf-8"><title>Grouping study — round 4 (t=0.45 + adjacent merge)</title>
<style>body{{font-family:sans-serif;background:#111;color:#ddd;margin:1rem}}
.card{{border:1px solid #333;border-radius:8px;padding:.6rem;margin:.8rem 0}}
.imgs{{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}}
figure{{margin:0}} figcaption{{font-size:.6rem;color:#888}} img{{height:160px;border-radius:4px}}
.excluded img{{outline:3px solid #e5484d}} .sep{{width:6px;height:120px;background:#4a6;border-radius:3px}}
.verdict button{{margin:.2rem;padding:.3rem .6rem}} .verdict .picked{{background:#2f6f3f;color:#fff}}
#export{{width:100%;height:8rem}} h3{{margin:.2rem 0;font-size:.85rem;color:#aaa}}</style>
<h1>Round 4 · the 0.45–0.55 inclusion band (threshold decider) · {len(cards)} cards</h1>
<p>Cross-burst MERGE cards: the green bar separates the two bursts — ✓ correct if they belong together as one group, ✗ wrong if the merge is bad. Group/excluded cards: same rules as round 1. Export and paste the JSON back.</p>
{''.join(rows)}
<h2>Export</h2><button onclick="doExport()">Export verdicts</button><textarea id="export"></textarea>
<script>
const K='grouping-round4';
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
    json.dump([{'type': c['type'], 'weakest': c['weakest'],
                'members': [k for _, _, k in c['members']],
                'excluded': (c['excluded'][2] if c.get('excluded') else None)} for c in cards], f, indent=1)
print(f'wrote {OUT} + manifest')
