# @afterglow/core — map

Pure TypeScript, zero platform APIs. Hard rules: no `Date.now()`/`Math.random()` (inject `at`/`Rng`); ESM imports carry `.js` extensions; apps consume the compiled `dist/` — **run `npm run build -w @afterglow/core` after any edit** or the apps keep using stale code. Tests mirror modules in `test/*.test.ts` (`npm test -w @afterglow/core`).

| File | Contents |
|---|---|
| types.ts | `MediaItem`, `Cluster`, `PhotoState` machine, `FLAG_TYPES` (delete/edit/move/review/rename/date), `Rng` |
| clustering.ts | `clusterByGap` time clustering; `MOMENTS_GAP_MS` (3 min) / `SESSIONS_GAP_MS` (30 min); `capCluster` even-sampling |
| similarity.ts | `dhash64` (caller supplies luma grid), `hammingDistance`, `refineClustersBySimilarity` (union-find, chain-linking, null-hash attaches to nearest timestamp) |
| deck.ts | `DeckSession` — the live mobile group-review model (m0.4+): alive/cursor decks, cull/undo/keepRest/markBest/makeSingle, staged culls → confirm → trash, `recordCompare` (DuelRecord), `reconsiderCandidates`, JSON `kind:'deck'`. Re-decides: `unstageCull` (culled→kept), `cullKept` (kept→culled); `to_edit`/`done` are app-side SQLite states, not here |
| cull.ts | Legacy pairwise duel-bracket `CullSession` (m0.1–m0.3) — exported but unused by apps; desktop may reuse |
| mix.ts | Playlist/mix engine: interleaves clusters with singles, avoids near repeats (desktop story engine) |
| retrospectives.ts | This-day-in-history / per-day / per-month selectors (desktop, roadmap v0.8) |
| flags.ts | Desktop flag-queue model: add/remove/list, (path,flagType) dedupe, versioned JSON round-trip |
| rng.ts | `mulberry32` seeded rng + `shuffled` |
| index.ts | Re-exports everything |
