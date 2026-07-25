#!/usr/bin/env python3
"""Phase A: embed the study photos with the torch-based candidates.

Usage: venv/bin/python embed_torch.py <model> <out.npz>
  model ∈ tinyclip39 | mobileclip_s1 | dinov2_s14
Photos: data/photos/** + ~/PhoneSync/**, deduped by basename
(preference: DCIM/Camera original > other pulled copy > PhoneSync copy).
"""
import sys, glob, os
import numpy as np
import torch
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL, OUT = sys.argv[1], sys.argv[2]
torch.set_num_threads(os.cpu_count() or 8)

paths = sorted(
    glob.glob(os.path.join(HERE, 'data/photos/**/*.jpg'), recursive=True)
    + [p for p in glob.glob('/home/tristan/PhoneSync/**/*.jpg', recursive=True) if '/.st' not in p]
)
best = {}
for p in paths:
    rank = 0 if '/DCIM/Camera/' in p else (1 if '/data/photos/' in p else 2)
    b = os.path.basename(p)
    if b not in best or rank < best[b][0]:
        best[b] = (rank, p)
paths = sorted(p for _, p in best.values())
print(f'{len(paths)} unique photos')

if MODEL == 'dinov2_s14':
    net = torch.hub.load('facebookresearch/dinov2', 'dinov2_vits14')
    net.eval()
    from torchvision import transforms
    tf = transforms.Compose([
        transforms.Resize(256), transforms.CenterCrop(224), transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
    encode = lambda batch: net(batch)
else:
    import open_clip
    if MODEL == 'tinyclip39':
        net, _, tf = open_clip.create_model_and_transforms(
            'hf-hub:wkcn/TinyCLIP-ViT-39M-16-Text-19M-YFCC15M')
    else:
        net, _, tf = open_clip.create_model_and_transforms('MobileCLIP-S1', pretrained='datacompdr')
    net.eval()
    encode = lambda batch: net.encode_image(batch)

keys, vecs = [], []
batch_paths, batch_tensors = [], []
def flush():
    global batch_paths, batch_tensors
    if not batch_tensors:
        return
    with torch.no_grad():
        out = encode(torch.stack(batch_tensors))
    out = torch.nn.functional.normalize(out, dim=-1).cpu().numpy().astype(np.float32)
    keys.extend(batch_paths)
    vecs.extend(out)
    batch_paths, batch_tensors = [], []

for i, path in enumerate(paths):
    try:
        img = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
        batch_paths.append(path)
        batch_tensors.append(tf(img))
    except Exception as e:
        print(f'SKIP {path}: {e}', file=sys.stderr)
    if len(batch_tensors) >= 16:
        flush()
    if (i + 1) % 200 == 0:
        print(f'{i + 1}/{len(paths)}', flush=True)
flush()
np.savez_compressed(OUT, keys=np.array(keys), vecs=np.stack(vecs))
print(f'wrote {OUT}: {len(keys)} embeddings, dim {vecs[0].shape[0]}')
