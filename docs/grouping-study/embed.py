#!/usr/bin/env python3
"""Phase A: compute MediaPipe image embeddings for pulled corpus photos + curated set.

Usage: venv/bin/python embed.py <model.tflite> <out.npz>
Embeds every .jpg under data/photos/ and ~/PhoneSync (curated), EXIF-oriented,
L2-normalized. Keys are absolute file paths.
"""
import sys, glob, os
import numpy as np
from PIL import Image, ImageOps
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL, OUT = sys.argv[1], sys.argv[2]

paths = sorted(
    glob.glob(os.path.join(HERE, 'data/photos/**/*.jpg'), recursive=True)
    + [p for p in glob.glob('/home/tristan/PhoneSync/**/*.jpg', recursive=True) if '/.st' not in p]
)
options = vision.ImageEmbedderOptions(
    base_options=mp_python.BaseOptions(model_asset_path=MODEL),
    l2_normalize=True, quantize=False)
embedder = vision.ImageEmbedder.create_from_options(options)

keys, vecs = [], []
for i, path in enumerate(paths):
    try:
        img = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
        img.thumbnail((512, 512))  # embedder resizes to 224 anyway; cap decode cost
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(img))
        emb = embedder.embed(mp_img).embeddings[0].embedding
        keys.append(path)
        vecs.append(np.asarray(emb, dtype=np.float32))
    except Exception as e:
        print(f'SKIP {path}: {e}', file=sys.stderr)
    if (i + 1) % 200 == 0:
        print(f'{i + 1}/{len(paths)}', flush=True)

import hashlib
import PIL
model_sha = hashlib.sha256(open(MODEL, 'rb').read()).hexdigest()
np.savez_compressed(OUT, keys=np.array(keys), vecs=np.stack(vecs),
                    model_sha256=np.array(model_sha), dim=np.array(vecs[0].shape[0]),
                    mediapipe_version=np.array(mp.__version__),
                    pillow_version=np.array(PIL.__version__))
print(f'wrote {OUT}: {len(keys)} embeddings, dim {vecs[0].shape[0]}, '
      f'model {model_sha[:12]}, mediapipe {mp.__version__}, pillow {PIL.__version__}')
