# image-embedder

Local Expo module that wraps the MediaPipe Tasks Image Embedder (MobileNetV3-large float32, L2-normalized).
The m0.8 grouping quality study chose it for the m0.8 similarity-grouping feature (`docs/Plan_m0.8.md`).
Label data and tooling live in `docs/grouping-study/`.

The model file is not committed (11 MB).
Fetch and verify it once.
The SHA-256 must match the pin in `docs/grouping-study/labels-v1.json`, because a different model would produce vectors incompatible with the frozen fixture:

```bash
curl -L --create-dirs -o android/src/main/assets/mobilenet_v3_large.tflite \
  https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_large/float32/1/mobilenet_v3_large.tflite
echo "11af3c560dfeed7737cb4c03c23bf52a8403020784192d4dea0b74862a12828d  android/src/main/assets/mobilenet_v3_large.tflite" | sha256sum -c
```

API:

- `embed(uri, decodeCap?, withDhash?)` → `{ decodeMs, inferMs, dim, vecB64, dhashHex }`.
- `decodeVec` yields the Float32Array. `decodeVecBytes` yields the raw bytes for BLOB storage.
- Cosine similarity = dot product, because the vectors are L2-normalized.
- `decodeCap` bounds the decoded long edge (default `DEFAULT_DECODE_CAP` = 1024, measured cap-invariant for speed, so the fidelity-maximal setting stays).
- `withDhash` also returns the photo's 64-bit dHash from the SAME decode (exact lib/dhashDecode.ts semantics in Kotlin). This dHash is the corpus scan's hash source.
- `dhash(uri)` computes the dHash alone, with a bounded decode.
- `MODEL_SHA256` re-exports the pin above. It MUST change with the bundled asset. The app compares it against the stored pin and re-embeds everything on a mismatch.
