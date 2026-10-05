#!/usr/bin/env python3
"""Phase-10 parts rounds (m0.9, rounds 2 and 3b): the engine's part proposals, corrected by tapping.

Usage: venv/bin/python sheet_device2.py <proposals.json> <photos-root> <out.html> [--round NAME]

--round names the round (default "round2"): the page title and the
browser-storage key, so two rounds never share verdicts.

Every card shows a device group with the engine's proposed partition
colour-coded (parts_proposals.mjs). Tapping a photo moves it to the
next part (A → B → C … → new part → single); "✓ proposal is right"
accepts the colours as shown. The exported JSON carries the final
partition per card, which device_labels2.py turns into constraints.
Exclusion cards show the single beside its group with the cosine and the
gap: tap it into part A to say "should join".
"""
import sys, os, json, html
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
PROPOSALS, ROOT, OUT = sys.argv[1:4]
ROUND = sys.argv[sys.argv.index('--round') + 1] if '--round' in sys.argv else 'round2'
data = json.load(open(PROPOSALS))
cards = data['cards']
COLORS = ['#4a7bd0', '#d0a04a', '#4ad08a', '#d04a7b', '#8a4ad0', '#4ad0d0', '#d0d04a', '#d07a4a']

thumb_dir = os.path.join(HERE, 'data/thumbs-device')
os.makedirs(thumb_dir, exist_ok=True)
def thumb(uri):
    src = os.path.join(ROOT, os.path.basename(uri))
    out = os.path.join(thumb_dir, os.path.basename(src) + '.jpg')
    if not os.path.exists(out):
        img = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
        img.thumbnail((256, 256))
        img.save(out, quality=80)
    return os.path.relpath(out, os.path.dirname(os.path.abspath(OUT)))

html_cards = []
manifest = []
for n, card in enumerate(cards):
    part_of = {}
    for pi, part in enumerate(card['parts']):
        for u in part:
            part_of[u] = pi
    members = [u for part in card['parts'] for u in part]
    members.sort(key=lambda u: os.path.basename(u))
    if any(not os.path.exists(os.path.join(ROOT, os.path.basename(u))) for u in members):
        print(f'card {n} skipped: a photo is not in {ROOT}')
        continue
    imgs = []
    for u in members:
        pi = part_of[u]
        imgs.append(f'<figure class="p" data-uri="{html.escape(u)}" data-part="{pi}"><img src="{html.escape(thumb(u))}" loading="lazy"><figcaption><span class="tag"></span>{html.escape(os.path.basename(u))}</figcaption></figure>')
    if card['kind'] == 'exclusion':
        head = f"single beside a group · cosine {card['sim']:.2f} · {card['gap_s']:.0f} s away — tap the single into A to join"
    else:
        origin = {'split-card': 'a split card', 'large-group': 'a large group', 'ok-group': 'a group judged ok'}[card['kind']]
        moved = ' · membership moved since' if card.get('moved') else ''
        head = f"{origin} (round {card.get('round', 1)} #{card['card']}) · {len(members)} photos · engine proposes {len(card['parts'])} part(s) at {data['threshold']}{moved}"
    html_cards.append(f'''<div class="card" data-id="{n}">
<h3>#{n} — {head}</h3>
<div class="imgs">{''.join(imgs)}</div>
<div class="verdict" data-id="{n}">
<button data-v="ok">✓ proposal is right</button>
<button data-v="edited">✎ as I tapped it</button>
<button data-v="whole">one group, no parts</button>
<button data-v="ambiguous">ambiguous</button>
<input type="text" placeholder="note (optional)" class="note">
</div></div>''')
    manifest.append({'id': n, **card})

page = f'''<!doctype html><meta charset="utf-8"><title>Phase 10 — {ROUND}, parts</title>
<style>
body{{font-family:sans-serif;background:#111;color:#ddd;margin:1rem}}
.card{{border:1px solid #333;border-radius:8px;padding:.6rem;margin:.8rem 0}}
.imgs{{display:flex;flex-wrap:wrap;gap:.4rem}}
figure{{margin:0;cursor:pointer}} figcaption{{font-size:.6rem;color:#888}}
img{{height:150px;border-radius:4px;outline:4px solid var(--c)}}
.tag{{display:inline-block;min-width:1.1rem;padding:0 .2rem;margin-right:.3rem;border-radius:3px;background:var(--c);color:#000;font-weight:700;text-align:center}}
.verdict button{{margin:.2rem;padding:.3rem .6rem}} .verdict .picked{{background:#2f6f3f;color:#fff}}
#export{{width:100%;height:8rem}}
h3{{margin:.2rem 0;font-size:.85rem;color:#aaa}}
</style>
<h1>Phase 10 — {ROUND} · {len(cards)} cards · parts at {data['threshold']}</h1>
<p>Colours are the engine's proposed parts. <b>Tap a photo</b> to move it to the next part (A → B → … → a new part → single, then back to A). Then pick a verdict: ✓ if the colours were right as shown, ✎ if you tapped a correction (the tapped partition is what counts), "one group" if the parts should not exist. Verdicts and taps persist in this browser; Export, then paste the JSON back.</p>
{''.join(html_cards)}
<h2>Export</h2><button onclick="doExport()">Export</button><textarea id="export"></textarea>
<script>
const COLORS={json.dumps(COLORS)};
const K='grouping-device-{ROUND}';
const state=JSON.parse(localStorage.getItem(K)||'{{}}');
const letter=i=>i<0?'·':String.fromCharCode(65+i);
function paint(card){{
  const id=card.dataset.id; const parts=state[id]?.parts||{{}};
  card.querySelectorAll('figure').forEach(f=>{{
    const p=parts[f.dataset.uri]!==undefined?parts[f.dataset.uri]:Number(f.dataset.part);
    f.style.setProperty('--c', p<0?'#555':COLORS[p%COLORS.length]);
    f.querySelector('.tag').textContent=letter(p);
  }});
}}
document.querySelectorAll('.card').forEach(card=>{{
  const id=card.dataset.id;
  state[id]??={{parts:{{}},v:null,note:''}};
  const figs=[...card.querySelectorAll('figure')];
  // seed the parts from the proposal so the export is complete
  figs.forEach(f=>{{ if(state[id].parts[f.dataset.uri]===undefined) state[id].parts[f.dataset.uri]=Number(f.dataset.part); }});
  figs.forEach(f=>f.onclick=()=>{{
    const cur=state[id].parts[f.dataset.uri];
    const used=new Set(Object.values(state[id].parts).filter(x=>x>=0));
    const max=used.size?Math.max(...used):-1;
    const alone=figs.filter(g=>state[id].parts[g.dataset.uri]===cur).length===1;
    let next;
    if(cur<0) next=0; else if(cur<max) next=cur+1; else if(!alone) next=max+1; else next=-1;
    state[id].parts[f.dataset.uri]=next; localStorage.setItem(K,JSON.stringify(state)); paint(card);
  }});
  const v=card.querySelector('.verdict');
  if(state[id].v){{ const b=v.querySelector(`[data-v="${{state[id].v}}"]`); if(b) b.classList.add('picked'); }}
  v.querySelector('.note').value=state[id].note||'';
  v.querySelectorAll('button').forEach(b=>b.onclick=()=>{{
    v.querySelectorAll('button').forEach(x=>x.classList.remove('picked')); b.classList.add('picked');
    state[id].v=b.dataset.v; state[id].note=v.querySelector('.note').value; localStorage.setItem(K,JSON.stringify(state));
  }});
  v.querySelector('.note').onchange=e=>{{ state[id].note=e.target.value; localStorage.setItem(K,JSON.stringify(state)); }};
  paint(card);
}});
localStorage.setItem(K,JSON.stringify(state));
function doExport(){{document.getElementById('export').value=JSON.stringify(state,null,1);}}
</script>'''
open(OUT, 'w').write(page)
json.dump(manifest, open(OUT.replace('.html', '-manifest.json'), 'w'), indent=1)
print(f'wrote {OUT} ({len(cards)} cards) + manifest')
