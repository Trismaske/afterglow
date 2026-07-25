#!/usr/bin/env python3
"""Round-N contact sheet for the grouping quality study.

Usage: venv/bin/python sheet.py <embeddings.npz> <out.html> [--threshold 0.60]

Builds time clusters (3-min gap) over the pulled corpus, groups within each
cluster by centroid linkage at the threshold, and renders judgeable cards:
  - every proposed multi-photo group (weakest internal link first)
  - borderline exclusions (best-sim 0.40..threshold to an existing group)
Verdicts are stored in localStorage; the export box emits JSON to paste back.
Thumbnails are generated into data/thumbs/ (256 px).
"""
import sys, os, json, html
import numpy as np
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
NPZ, OUT = sys.argv[1], sys.argv[2]
THRESHOLD = float(sys.argv[sys.argv.index('--threshold') + 1]) if '--threshold' in sys.argv else 0.60
GAP_MS = 3 * 60 * 1000
BORDER_LO = 0.40
MAX_CARDS = 80

data = np.load(NPZ, allow_pickle=False)
keys, vecs = [str(k) for k in data['keys']], data['vecs']
idx_of = {k: i for i, k in enumerate(keys)}

# timestamps from the dump, matched by path suffix under data/photos/
ts_by_tail = {}
for line in open(os.path.join(HERE, 'data/s23-hashes.jsonl')):
    r = json.loads(line)
    tail = r['u'].replace('/storage/emulated/0/', '')
    ts_by_tail[tail] = r['ts']

photos = []  # (ts, key)
for k in keys:
    if '/data/photos/' not in k:
        continue
    tail = k.split('/data/photos/')[1]
    t = ts_by_tail.get(tail)
    if t is not None:
        photos.append((t, k))
photos.sort()
print(f'corpus photos with timestamps: {len(photos)}')

# ---- time clusters ----
clusters, cur = [], [photos[0]]
for prev, item in zip(photos, photos[1:]):
    if item[0] - prev[0] > GAP_MS:
        clusters.append(cur); cur = []
    cur.append(item)
clusters.append(cur)
multi = [c for c in clusters if len(c) >= 2]
print(f'time clusters: {len(clusters)}, with >=2 photos: {len(multi)}')

def centroid_groups(cluster):
    """Greedy centroid linkage within a time cluster."""
    groups = []  # list of [indices]
    for t, k in cluster:
        i = idx_of[k]
        best, best_sim = None, -1.0
        for g in groups:
            c = np.mean(vecs[g], axis=0)
            c /= np.linalg.norm(c)
            s = float(np.dot(vecs[i], c))
            if s > best_sim:
                best, best_sim = g, s
        if best is not None and best_sim >= THRESHOLD:
            best.append(i)
        else:
            groups.append([i])
    return groups

cards = []
for cluster in multi:
    groups = centroid_groups(cluster)
    for g in groups:
        if len(g) < 2:
            continue
        sims = [float(np.dot(vecs[a], vecs[b])) for x, a in enumerate(g) for b in g[x + 1:]]
        cards.append({'type': 'group', 'members': g, 'weakest': min(sims), 'cluster_size': len(cluster)})
    # borderline exclusions: singleton whose best sim to a multi-group is in band
    for g in groups:
        if len(g) != 1:
            continue
        i = g[0]
        for other in groups:
            if len(other) < 2:
                continue
            c = np.mean(vecs[other], axis=0); c /= np.linalg.norm(c)
            s = float(np.dot(vecs[i], c))
            if BORDER_LO <= s < THRESHOLD:
                cards.append({'type': 'excluded', 'members': other + [i], 'excluded': i, 'weakest': s, 'cluster_size': len(cluster)})

cards.sort(key=lambda c: c['weakest'])
cards = cards[:MAX_CARDS]
print(f'cards: {len(cards)}')

# ---- thumbnails ----
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
    for i in card['members']:
        k = keys[i]
        cls = ' excluded' if card.get('excluded') == i else ''
        label = os.path.basename(k)
        imgs.append(f'<figure class="p{cls}"><img src="{html.escape(thumb(k))}" loading="lazy"><figcaption>{html.escape(label)}</figcaption></figure>')
    kind = 'group' if card['type'] == 'group' else 'excluded photo (red) — should it join?'
    rows.append(f'''<div class="card" data-id="{n}">
<h3>#{n} — {kind} · weakest link {card['weakest']:.3f} · burst of {card['cluster_size']}</h3>
<div class="imgs">{''.join(imgs)}</div>
<div class="verdict" data-id="{n}">
<button data-v="ok">✓ correct</button>
<button data-v="wrong">✗ wrong</button>
<button data-v="split">needs split</button>
<button data-v="join">should join</button>
<button data-v="ambiguous">ambiguous</button>
<input type="text" placeholder="note (optional)" class="note">
</div></div>''')

page = f'''<!doctype html><meta charset="utf-8"><title>Grouping study — round 1 (t={THRESHOLD})</title>
<style>
body{{font-family:sans-serif;background:#111;color:#ddd;margin:1rem}}
.card{{border:1px solid #333;border-radius:8px;padding:.6rem;margin:.8rem 0}}
.imgs{{display:flex;flex-wrap:wrap;gap:.4rem}}
figure{{margin:0}} figcaption{{font-size:.6rem;color:#888}}
img{{height:160px;border-radius:4px}}
.excluded img{{outline:3px solid #e5484d}}
.verdict button{{margin:.2rem;padding:.3rem .6rem}} .verdict .picked{{background:#2f6f3f;color:#fff}}
#export{{width:100%;height:8rem}}
h3{{margin:.2rem 0;font-size:.85rem;color:#aaa}}
</style>
<h1>Grouping study — round 1 · centroid t={THRESHOLD} · {len(cards)} cards</h1>
<p>✓ correct = the card shows the right grouping · ✗ wrong / needs split / should join as applicable · verdicts persist in this browser; click Export and paste the JSON back to Claude.</p>
{''.join(rows)}
<h2>Export</h2><button onclick="doExport()">Export verdicts</button><textarea id="export"></textarea>
<script>
const K='grouping-round1';
const state=JSON.parse(localStorage.getItem(K)||'{{}}');
document.querySelectorAll('.verdict').forEach(v=>{{
  const id=v.dataset.id;
  if(state[id]) {{
    const b=v.querySelector(`[data-v="${{state[id].v}}"]`); if(b) b.classList.add('picked');
    v.querySelector('.note').value=state[id].note||'';
  }}
  v.querySelectorAll('button').forEach(b=>b.onclick=()=>{{
    v.querySelectorAll('button').forEach(x=>x.classList.remove('picked'));
    b.classList.add('picked');
    state[id]={{v:b.dataset.v,note:v.querySelector('.note').value}};
    localStorage.setItem(K,JSON.stringify(state));
  }});
  v.querySelector('.note').onchange=e=>{{
    if(state[id]) {{ state[id].note=e.target.value; localStorage.setItem(K,JSON.stringify(state)); }}
  }};
}});
function doExport(){{document.getElementById('export').value=JSON.stringify(state,null,1);}}
</script>'''
with open(OUT, 'w') as f:
    f.write(page)
# card manifest so verdict ids map back to files
with open(OUT.replace('.html', '-manifest.json'), 'w') as f:
    json.dump([{**c, 'members': [keys[i] for i in c['members']],
                'excluded': keys[c['excluded']] if 'excluded' in c else None} for c in cards], f, indent=1)
print(f'wrote {OUT} + manifest')
