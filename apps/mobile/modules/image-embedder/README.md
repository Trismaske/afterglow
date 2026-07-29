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
  https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_large/float32/1/mobilenet_v3_large.tflite
echo "11af3c560dfeed7737cb4c03c23bf52a8403020784192d4dea0b74862a12828d  android/src/main/assets/mobilenet_v3_large.tflite" | sha256sum -c
```

`embed(uri, decodeCap?, withDhash?)` → `{ decodeMs, inferMs, dim, vecB64,
dhashHex }`; `decodeVec` yields the Float32Array (`decodeVecBytes` the raw
bytes for BLOB storage). Cosine similarity = dot product (vectors are
L2-normalized). `decodeCap` bounds the decoded long edge (default
`DEFAULT_DECODE_CAP` = 1024 — measured cap-invariant for speed, so the
fidelity-maximal setting stays). `withDhash` also returns the photo's
64-bit dHash from the SAME decode (exact lib/dhashDecode.ts semantics in
Kotlin) — the corpus scan's hash source; `dhash(uri)` computes it alone
with a bounded decode. `MODEL_SHA256` re-exports the pin above — it MUST
change with the bundled asset; the app compares it against the stored pin
and re-embeds everything on mismatch.
