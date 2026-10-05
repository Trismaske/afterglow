#!/usr/bin/env python3
"""Phase-10 contact sheet (m0.9): the DEVICE's actual continuous groups.

Usage: venv/bin/python sheet_device.py <afterglow.db> <photos-root> <out.html> [--cards 80]

Unlike sheet.py, nothing is recomputed here: the groups are the app's own
(photo_group_assignments over the continuous run), the vectors are the
device embedder's (photo_embeddings, float32 L2-normalised), and the
sheet asks the one question the study could never ask before — does what
the phone actually grouped look right? Cards:
  - group: a device group, members in capture order, the weakest internal
    cosine (device vectors) and the time span; time-attached members are
    marked (they joined on time alone, the engine's lower bar)
  - excluded: a present single within 15 min of a group whose cosine to
    the group's centroid is 0.40 or better — should it have joined?
The weakest 40 groups, 25 random groups and the best 15 exclusions make
one judged round (~80 cards); verdicts persist in localStorage and Export
emits the JSON. Thumbnails come from <photos-root>/<basename>; a photo
whose file is not there (a synthetic seed) is skipped with its card.
"""
import sys, os, json, html, sqlite3, random, struct
import numpy as np
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
DB, ROOT, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
MAX_CARDS = int(sys.argv[sys.argv.index('--cards') + 1]) if '--cards' in sys.argv else 80
ADJ_MS = 15 * 60 * 1000
BORDER_LO = 0.40
random.seed(10)

con = sqlite3.connect(DB)
rows = con.execute(
    """SELECT p.asset_id, p.uri, p.taken_at, p.kind, a.group_id, a.time_attached
         FROM photos p LEFT JOIN photo_group_assignments a ON a.photo_id = p.asset_id
        WHERE p.is_present = 1 AND p.day IS NOT NULL ORDER BY p.taken_at"""
).fetchall()
vec_of = {}
for asset_id, blob in con.execute('SELECT asset_id, vec FROM photo_embeddings'):
    v = np.frombuffer(blob, dtype=np.float32)
    vec_of[asset_id] = v
print(f'present dated rows: {len(rows)}; vectors: {len(vec_of)}')

def local_path(uri):
    return os.path.join(ROOT, os.path.basename(uri))

photos = {}
groups = {}
singles = []
missing_file = set()
for asset_id, uri, taken_at, kind, group_id, time_attached in rows:
    if kind != 'photo':
        continue
    if not os.path.exists(local_path(uri)):
        missing_file.add(asset_id)
    photos[asset_id] = {'uri': uri, 'ts': taken_at, 'ta': time_attached}
    if group_id is None:
        singles.append(asset_id)
    else:
        groups.setdefault(group_id, []).append(asset_id)
# A group with a member whose file is not here is dropped WHOLE (codex):
# a card must show the device's group as it is, never a shrunken one.
dropped = {g for g, m in groups.items() if any(x in missing_file for x in m)}
groups = {g: m for g, m in groups.items() if len(m) >= 2 and g not in dropped}
singles = [s for s in singles if s not in missing_file]
print(f'groups dropped for a missing file: {len(dropped)}')
print(f'photos with files: {len(photos)}; device groups (>=2 with files): {len(groups)}; singles: {len(singles)}')

def cos(a, b):
    va, vb = vec_of.get(a), vec_of.get(b)
    return None if va is None or vb is None else float(np.dot(va, vb))

cards = []
for gid, members in groups.items():
    sims = [s for i, a in enumerate(members) for b in members[i + 1:] for s in [cos(a, b)] if s is not None]
    cards.append({
        'type': 'group', 'group_id': gid, 'members': members,
        'weakest': min(sims) if sims else None,
        'span_s': (photos[members[-1]]['ts'] - photos[members[0]]['ts']) / 1000,
        'time_attached': [m for m in members if photos[m]['ta']],
    })
group_cards = sorted([c for c in cards if c['weakest'] is not None], key=lambda c: c['weakest'])
weakest = group_cards[:40]
rest = [c for c in group_cards[40:]]
random_pick = random.sample(rest, min(25, len(rest)))

excluded = []
centroids = {}
for gid, members in groups.items():
    vs = [vec_of[m] for m in members if m in vec_of]
    if vs:
        c = np.mean(vs, axis=0); c /= np.linalg.norm(c); centroids[gid] = c
for s in singles:
    if s not in vec_of:
        continue
    ts = photos[s]['ts']
    best, best_sim = None, -1.0
    for gid, members in groups.items():
        if gid not in centroids:
            continue
        near = min(abs(photos[m]['ts'] - ts) for m in members)
        if near > ADJ_MS:
            continue
        sim = float(np.dot(vec_of[s], centroids[gid]))
        if sim > best_sim:
            best, best_sim = gid, sim
    if best is not None and best_sim >= BORDER_LO:
        excluded.append({'type': 'excluded', 'group_id': best, 'members': groups[best] + [s], 'excluded': s,
                         'weakest': best_sim, 'span_s': None, 'time_attached': []})
excluded.sort(key=lambda c: -c['weakest'])
chosen = weakest + random_pick + excluded[:15]
chosen = chosen[:MAX_CARDS]
print(f'cards: {len(chosen)} (weakest {len(weakest)}, random {len(random_pick)}, exclusions {min(15, len(excluded))} of {len(excluded)})')

thumb_dir = os.path.join(HERE, 'data/thumbs-device')
os.makedirs(thumb_dir, exist_ok=True)
def thumb(asset_id):
    src = local_path(photos[asset_id]['uri'])
    out = os.path.join(thumb_dir, os.path.basename(src) + '.jpg')
    if not os.path.exists(out):
        img = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
        img.thumbnail((256, 256))
        img.save(out, quality=80)
    return os.path.relpath(out, os.path.dirname(os.path.abspath(OUT)))

def clock(ts):
    import datetime
    return datetime.datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d %H:%M:%S')

html_cards = []
for n, card in enumerate(chosen):
    imgs = []
    for m in card['members']:
        cls = ' excluded' if card.get('excluded') == m else (' attached' if m in card['time_attached'] else '')
        label = f"{os.path.basename(photos[m]['uri'])}<br>{clock(photos[m]['ts'])}"
        imgs.append(f'<figure class="p{cls}"><img src="{html.escape(thumb(m))}" loading="lazy"><figcaption>{label}</figcaption></figure>')
    if card['type'] == 'group':
        head = (f"group #{card['group_id']} · {len(card['members'])} photos · weakest link {card['weakest']:.3f}"
                f" · span {card['span_s']:.0f} s" + (f" · {len(card['time_attached'])} time-attached (blue)" if card['time_attached'] else ''))
    else:
        head = f"excluded single (red) beside group #{card['group_id']} · cosine to centroid {card['weakest']:.3f} — should it join?"
    html_cards.append(f'''<div class="card" data-id="{n}">
<h3>#{n} — {head}</h3>
<div class="imgs">{''.join(imgs)}</div>
<div class="verdict" data-id="{n}">
<button data-v="ok">✓ correct</button>
<button data-v="wrong">✗ wrong</button>
<button data-v="split">needs split</button>
<button data-v="join">should join</button>
<button data-v="ambiguous">ambiguous</button>
<input type="text" placeholder="note (optional)" class="note">
</div></div>''')

page = f'''<!doctype html><meta charset="utf-8"><title>Phase 10 — the device's groups</title>
<style>
body{{font-family:sans-serif;background:#111;color:#ddd;margin:1rem}}
.card{{border:1px solid #333;border-radius:8px;padding:.6rem;margin:.8rem 0}}
.imgs{{display:flex;flex-wrap:wrap;gap:.4rem}}
figure{{margin:0}} figcaption{{font-size:.6rem;color:#888}}
img{{height:160px;border-radius:4px}}
.excluded img{{outline:3px solid #e5484d}} .attached img{{outline:3px solid #4a7bd0}}
.verdict button{{margin:.2rem;padding:.3rem .6rem}} .verdict .picked{{background:#2f6f3f;color:#fff}}
#export{{width:100%;height:8rem}}
h3{{margin:.2rem 0;font-size:.85rem;color:#aaa}}
</style>
<h1>Phase 10 — the device's own groups · {len(chosen)} cards</h1>
<p>Cards #0–{len(weakest)-1}: the weakest-linked groups · #{len(weakest)}–{len(weakest)+len(random_pick)-1}: random groups · the rest: singles that sat near a group. ✓ correct = the grouping shown is right · ✗ wrong / needs split / should join as applicable. Verdicts persist in this browser; Export, then paste the JSON back.</p>
{''.join(html_cards)}
<h2>Export</h2><button onclick="doExport()">Export verdicts</button><textarea id="export"></textarea>
<script>
const K='grouping-device-round1';
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
with open(OUT.replace('.html', '-manifest.json'), 'w') as f:
    json.dump([{**c, 'members': [photos[m]['uri'] for m in c['members']],
                'excluded': photos[c['excluded']]['uri'] if c.get('excluded') else None,
                'time_attached': [photos[m]['uri'] for m in c['time_attached']]} for c in chosen], f, indent=1)
print(f'wrote {OUT} + manifest')
