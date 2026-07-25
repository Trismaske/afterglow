# image-embedder

Local Expo module wrapping the MediaPipe Tasks Image Embedder
(MobileNetV3-large float32, L2-normalized) — the m0.8 similarity-grouping
feature chosen by the m0.8 grouping quality study (`docs/Plan_m0.8.md`; label
data and tooling in `docs/grouping-study/`).

The model file is not committed (11 MB). Fetch it once:

```bash
curl -L -o android/src/main/assets/mobilenet_v3_large.tflite \
  https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_large/float32/latest/mobilenet_v3_large.tflite
```

`embed(uri)` → `{ decodeMs, inferMs, dim, vecB64 }`; `decodeVec` yields the
Float32Array. Cosine similarity = dot product (vectors are L2-normalized).
