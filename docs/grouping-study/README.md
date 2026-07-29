# Grouping study tooling & label data

The evidence base and regression fixtures behind m0.8's grouping design
(`docs/Plan_m0.8.md`; product statements in PLAN.md). The study's full history
lives in git (deleted docs `Sessions_m0.8.md` / `Grouping_study_m0.8.md`).

## What is committed vs local

**Committed:** the scripts below, plus the frozen CI fixtures:
`labels-v1.json` (698 adjudicated hard pairs + 81 soft + 7 retired; the
product of four judged rounds and a validation round, all Tristan-verdicted)
and `embeddings-labeled-v1.json` (vectors for the 428 labeled photos,
base64 float32, model SHA-256 embedded). v1 is immutable — new judged
rounds produce v2 with a deliberate baseline re-pin. Per-round working
labels live in `data/` (gitignored) alongside the raw verdicts.

**Local only (`data/.gitignore`):** pulled photos (`data/photos/`, personal),
thumbnails, hash corpora (`s23-hashes.jsonl`, `s10e-hashes.jsonl`), embedding
matrices (`embeddings-*.npz`), judged-round HTML/manifests/verdicts.
Regenerable: hashes/benchmarks via the TEMP harness pattern preserved in
`harness/embbench-spike.ts` (copy to `apps/mobile/src/lib/spike.ts`, hook in
App.tsx per its header), photos via `adb pull`, embeddings via `embed.py`.

## Scripts

| Script | Purpose |
|---|---|
| `embed.py <model.tflite> <out.npz>` | MediaPipe embeddings for `data/photos/**` + curated set (venv from `requirements.txt` — pinned; freeze validates the versions) |
| `embed_torch.py <model> <out.npz>` | torch candidates (mobileclip_s1, dinov2_s14) for comparisons |
| `eval_embed.py <npz>` | label-pair separation + unrelated-pair FP curve for one model |
| `eval_compare.py name=npz ...` | multi-model AUC/threshold-sweep comparison on all labels |
| `analyze.mjs` | dHash-era corpus analyses (histogram, config sweep) — kept for reference |
| `sheet2.py <npz> <out.html>` | generate a judged round: proposed groups, cross-burst merges, borderline exclusions; skips already-judged sets |
| `fit_curve.mjs` | Gate-1 fit/re-pin harness: replays the built core engine over the frozen fixtures, fits the time-decay threshold curve, sweeps merge params, prints kept/violations/largest per variant |
| `score_device.mjs <jsonl>` | Gate-2 recalibration scorer: engine replay + drift stats for DEVICE-computed labeled-photo vectors vs the fixture baseline (captures in `data/*-vectors-cap1024.jsonl`, gitignored) |

## Running a judged round

1. Pull any new photos into `data/photos/` (preserve `<storage-relative>` paths).
2. `embed.py` → refresh the npz.
3. `sheet2.py` → HTML; Tristan verdicts in the browser (✓ endorses the shown
   decision), Export → save JSON as `data/verdicts_roundN.json`.
4. Convert verdicts to `data/roundN-labels.json` (see round-2 conversion in git
   history), append to the label set, and re-pin the core regression baseline
   (`Plan_m0.8.md` — Grouping regression suite).
