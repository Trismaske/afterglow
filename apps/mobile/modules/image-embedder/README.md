# image-embedder

Local Expo module wrapping the MediaPipe Tasks Image Embedder
(MobileNetV3-large float32, L2-normalized) — the m0.8 similarity-grouping
feature chosen by the m0.8 grouping quality study (`docs/Plan_m0.8.md`; label
data and tooling in `docs/grouping-study/`).

The model file is not committed (11 MB). Fetch and verify it once — the
SHA-256 must match the pin in `docs/grouping-study/labels-v1.json` (a
different model would produce vectors incompatible with the frozen fixture):

```bash
curl -L --create-dirs -o android/src/main/assets/mobilenet_v3_large.tflite \
  https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_large/float32/latest/mobilenet_v3_large.tflite
echo "11af3c560dfeed7737cb4c03c23bf52a8403020784192d4dea0b74862a12828d  android/src/main/assets/mobilenet_v3_large.tflite" | sha256sum -c
```

`embed(uri)` → `{ decodeMs, inferMs, dim, vecB64 }`; `decodeVec` yields the
Float32Array. Cosine similarity = dot product (vectors are L2-normalized).
