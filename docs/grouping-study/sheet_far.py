#!/usr/bin/env python3
"""Phase-10 round 3a (m0.9): the far look-alikes — pairs of the device's
own units (groups or singles) that the merge window (15 min at the
time of round 3a) keeps
apart, one card per pair with A on the left and B on the right, the
centroid cosine and the gap in the heading. The verdict is binary: join
(one group for culling: the shots substitute for each other) or apart;
ambiguous is allowed. Verdicts persist in localStorage; Export emits the
JSON. Pairs come from far_links.mjs (<pairs.json>, sorted by cosine);
the sheet takes those at or above --min-sim (default 0.80) within 24 h.
Usage: venv/bin/python sheet_far.py <pairs.json> <photos-root> <out.html> [--min-sim 0.80] [--round NAME]

--round names the round (default "round3a"): the page title and the
browser-storage key, so two rounds never share verdicts. A pair carrying
`band`, `best` and `mean` (select_far_round.py) shows them in its heading.
"""
import sys, os, json, html, datetime
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
PAIRS, ROOT, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
MIN_SIM = float(sys.argv[sys.argv.index('--min-sim') + 1]) if '--min-sim' in sys.argv else 0.80
ROUND = sys.argv[sys.argv.index('--round') + 1] if '--round' in sys.argv else 'round3a'
pairs = [p for p in json.load(open(PAIRS)) if p['sim'] >= MIN_SIM]

def local_path(uri):
    return os.path.join(ROOT, os.path.basename(uri))

thumb_dir = os.path.join(HERE, 'data/thumbs-device')
os.makedirs(thumb_dir, exist_ok=True)
def thumb(uri):
    src = local_path(uri)
    out = os.path.join(thumb_dir, os.path.basename(src) + '.jpg')
    if not os.path.exists(out):
        img = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
        img.thumbnail((256, 256))
        img.save(out, quality=80)
    return os.path.relpath(out, os.path.dirname(os.path.abspath(OUT)))

cards = []
manifest = []
skipped = 0
for p in pairs:
    if not all(os.path.exists(local_path(u)) for u in p['a'] + p['b']):
        skipped += 1
        continue
    n = len(manifest)
    manifest.append({'card': n, 'sim': p['sim'], 'gap_s': p['gap_s'], 'a': p['a'], 'b': p['b'],
                     **{k: p[k] for k in ('band', 'best', 'mean') if k in p}})
    def figs(uris):
        return ''.join(
            f'<figure><img src="{html.escape(thumb(u))}" loading="lazy"><figcaption>{html.escape(os.path.basename(u))}</figcaption></figure>'
            for u in uris)
    gap = p['gap_s'] / 60
    gap_txt = f'{gap:.0f} min' if gap < 120 else f'{gap/60:.1f} h'
    cards.append(f'''<div class="card" data-id="{n}">
<h3>#{n} — centroid {p['sim']:.2f}{f" · best pair {p['best']:.2f} · mean pair {p['mean']:.2f}" if 'best' in p else ''} · gap {gap_txt} · A {len(p['a'])} photo(s) | B {len(p['b'])} photo(s){f" · band {p['band']}" if 'band' in p else ''}</h3>
<div class="pair"><div class="imgs">{figs(p['a'])}</div><div class="sep"></div><div class="imgs">{figs(p['b'])}</div></div>
<div class="verdict" data-id="{n}">
<button data-v="join">join — one group</button>
<button data-v="apart">apart</button>
<button data-v="ambiguous">ambiguous</button>
<input type="text" placeholder="note (optional)" class="note">
</div></div>''')

page = f'''<!doctype html><meta charset="utf-8"><title>Phase 10 {ROUND} — far look-alikes</title>
<style>
body{{font-family:sans-serif;background:#111;color:#ddd;margin:1rem}}
.card{{border:1px solid #333;border-radius:8px;padding:.6rem;margin:.8rem 0}}
.pair{{display:flex;gap:.6rem;align-items:flex-start}}
.imgs{{display:flex;flex-wrap:wrap;gap:.4rem}}
.sep{{width:4px;background:#e5484d;align-self:stretch;border-radius:2px}}
figure{{margin:0}} figcaption{{font-size:.6rem;color:#888}}
img{{height:150px;border-radius:4px}}
.verdict button{{margin:.2rem;padding:.3rem .6rem}} .verdict .picked{{background:#2f6f3f;color:#fff}}
#export{{width:100%;height:8rem}}
h3{{margin:.2rem 0;font-size:.85rem;color:#aaa}}
</style>
<h1>Phase 10 {ROUND} — far look-alikes · {len(cards)} cards</h1>
<p>Each card is two of the phone's units (A left, B right) beyond the merge window that the embedding finds alike. <b>join</b> = for culling they belong in one group (the shots substitute for each other) · <b>apart</b> = different moments, keep them separate even though they look alike. Cards are sorted by cosine, highest first. Verdicts persist in this browser; Export, then paste the JSON back.</p>
{''.join(cards)}
<h2>Export</h2><button onclick="doExport()">Export verdicts</button><textarea id="export"></textarea>
<script>
const K='grouping-device-{ROUND}';
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
open(OUT, 'w').write(page)
json.dump(manifest, open(OUT.replace('.html', '-manifest.json'), 'w'), indent=1)
print(f'{len(cards)} cards (pairs ≥ {MIN_SIM}: {len(pairs)}, {skipped} skipped for missing files) → {OUT}')
