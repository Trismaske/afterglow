# @afterglow/core — map

Pure TypeScript, zero platform APIs.
Hard rules: no `Date.now()`/`Math.random()` (inject `at`/`Rng`), and ESM imports carry `.js` extensions.
The apps consume the compiled `dist/`.
**After any edit, run `npm run build -w @afterglow/core`**, or the apps keep stale code.
Tests mirror modules in `test/*.test.ts` (`npm test -w @afterglow/core`).

| File | Contents |
|---|---|
| types.ts | `MediaItem`, `Cluster`, `PhotoState` verdicts (`unreviewed`/`kept`/`culled`/`trashed`), `DuelRecord` compare history, `FLAG_TYPES` (delete/edit/move/review/rename/date), `Rng` |
| clustering.ts | `clusterByGap` time clustering; `MOMENTS_GAP_MS` (3 min) / `SESSIONS_GAP_MS` (30 min); `capCluster` even-sampling |
| similarity.ts | `dhash64` (caller supplies luma grid), `hammingDistance`, `refineClustersBySimilarity` (union-find, chain-linking, null-hash attaches to nearest timestamp; desktop v0.7 candidate) |
| grouping.ts | m0.8 embedding cull grouping (`groupByEmbedding`): burst gate → greedy centroid linkage with per-gap time-decay threshold (`effectiveLinkThreshold`) → tight-only adjacent-burst merge → dHash near-dup floor + `nearDupPairs` annotation. L2-normalized Float32Array vectors via injected `vecOf`. Constants fitted by docs/grouping-study/fit_curve.mjs; labels-v1 baseline pinned in test/grouping.test.ts |
| mix.ts | Playlist/mix engine: interleaves clusters with singles, avoids near repeats (desktop story engine) |
| retrospectives.ts | This-day-in-history / per-day / per-month selectors (desktop, roadmap v0.8) |
| flags.ts | Desktop flag-queue model: add/remove/list, (path,flagType) dedupe, versioned JSON round-trip |
| rng.ts | `mulberry32` seeded rng + `shuffled` + `pickOne` |
| index.ts | Re-exports everything |
