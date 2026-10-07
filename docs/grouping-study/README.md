# Grouping study tooling & label data

This directory holds the evidence base and regression fixtures behind m0.8's grouping design (`docs/Plan_m0.8.md`, product statements in PLAN.md).
The study's full history lives in git (deleted docs `Sessions_m0.8.md` / `Grouping_study_m0.8.md`).

## What is committed vs local

**Committed:** the scripts below, plus the frozen CI fixtures.
`labels-v1.json` holds 698 adjudicated hard pairs, 81 soft, and 7 retired: the product of four judged rounds and a validation round, all Tristan-verdicted.
`embeddings-labeled-v1.json` holds vectors for the 428 labeled photos (base64 float32, model SHA-256 embedded).
`device-rounds-v1.json` holds the m0.9 phase-10 device fixture: every photo inside the judged S10e cards' merge windows (2 297, with the device vectors and hashes) and the 233 cards of rounds 1, 2, 3a and 3b as pairwise constraints, replayed by core's `device-rounds-v1 regression` suite at the group and the part level.
v1 is immutable. New judged rounds produce v2 with a deliberate baseline re-pin.
Per-round working labels live in `data/` (gitignored) alongside the raw verdicts.

**Local only (`data/.gitignore`):** pulled photos (`data/photos/`, personal), thumbnails, hash corpora (`s23-hashes.jsonl`, `s10e-hashes.jsonl`), embedding matrices (`embeddings-*.npz`), and judged-round HTML/manifests/verdicts.
All are regenerable:

- hashes/benchmarks via the TEMP harness pattern preserved in `harness/embbench-spike.ts` (copy to `apps/mobile/src/lib/spike.ts`, hook in App.tsx per its header)
- photos via `adb pull`
- embeddings via `embed.py`

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
| `sheet_device.py <afterglow.db> <photos-root> <out.html>` | m0.9 phase 10 round 1: a judged round over the DEVICE's own continuous groups and vectors (no recomputation) — the weakest-linked groups, random groups, and near-group singles; the DB comes off the phone through a DEBUG build installed over the release one (same package and key, the data stays): `adb exec-out run-as com.afterglow.companion cat files/SQLite/afterglow.db` (plus `-wal`/`-shm`), then the release build goes back on; the photos from a local copy keyed by basename |
| `export_device.py <afterglow.db> <out.jsonl>` | the device DB's present dated photos with their vectors and hashes, for the node replay |
| `device_labels.py <verdicts> <manifest> <out.json>` | round-1 verdicts and notes → must-link / cannot-link constraints (the split partitions transcribed in the script) |
| `replay_device.mjs <device.jsonl> <labels.json>` | the built engine over the device vectors, per candidate option set, scored against the constraints (the plain engine as the sanity line) plus the whole-library group counts |
| `parts_proposals.mjs <device.jsonl> <round2-manifest> <round1-manifest> <round1-verdicts> <out.json>` | a parts round's cards: the shipped parts rule over every round-2 group card plus up to 20 round-1 "ok" groups, each the engine's group over its maximal window |
| `sheet_device2.py <proposals.json> <photos-root> <out.html> [--round NAME]` | a parts round (2, 3b): proposed parts colour-coded, corrected by tapping photos between parts; Export emits the partition per card; `--round` keys the browser storage |
| `device_labels2.py <export.json> <round2-manifest.json> <out.json>` | round-2 export → constraints |
| `far_links.mjs <device.jsonl> [pairs.json]` | the far look-alikes: unit pairs (the engine's groups and singles over the device vectors) beyond the merge window within 24 h, counted by gap bucket and cosine bar; the pairs at ≥0.70 written for the round-3a sheet |
| `sheet_far.py <pairs.json> <photos-root> <out.html> [--min-sim 0.80] [--round NAME]` | a far-pair round (3a, 3c): one card per pair, A beside B with the cosines and the gap; join / apart / ambiguous |
| `select_far_round.py <far-pairs.json> <out-pairs.json> <out-files.txt> [--dry]` | round 3c's cards from the S23 pairs: the far bar's joins and a sample of its refusals within the hour, the beyond-the-hour band, controls; and the file list to pull (read-only) |
| `make_device_fixture.mjs <device.jsonl> <out.json> <labels.json>...` | the device fixture: the judged cards' whole merge windows with their vectors and every round's constraints, for core's regression suite; prints the score to pin |
| `inspect_device.mjs <device.jsonl> <basename>...` | one card on a device's vectors: the engine's groups and parts over the card's maximal window, and the named photos' pairwise cosines (Tristan's example folders) |
| `score_device.mjs <jsonl>` | Gate-2 recalibration scorer: engine replay + drift stats for DEVICE-computed labeled-photo vectors vs the fixture baseline (captures in `data/*-vectors-cap1024.jsonl`, gitignored) |

## Running a judged round

1. Pull any new photos into `data/photos/` (preserve `<storage-relative>` paths).
2. Run `embed.py` to refresh the npz.
3. Run `sheet2.py` to generate the HTML.
   Tristan verdicts in the browser (✓ endorses the shown decision).
   Use Export, then save the JSON as `data/verdicts_roundN.json`.
4. Convert the verdicts to `data/roundN-labels.json` (see the round-2 conversion in git history).
   Append them to the label set.
   Re-pin the core regression baseline (`Plan_m0.8.md`, "Grouping regression suite").
