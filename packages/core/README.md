# @afterglow/core

The shared brain of Afterglow Desktop and Afterglow for Android.
Pure TypeScript: no filesystem, no platform APIs, and no `Date.now()` / `Math.random()` defaults.
Callers always inject timestamps (`at`) and randomness (`rng`), so everything is deterministic and testable.
Both apps map their native media (file paths, MediaStore rows) into `MediaItem[]` through their own adapters.

Built output lives in `dist/` (`npm run build -w @afterglow/core`).
Apps import from `@afterglow/core`.

## Exports

### `types.ts`
| Export | What | Consumed by |
|---|---|---|
| `MediaItem`, `MediaKind` | One photo/video: `{ id, timestamp, uri, kind }` | everything |
| `Cluster` | Time-proximate group, items sorted ascending | both apps |
| `PhotoState`, `PHOTO_STATES` | The mobile verdicts: `unreviewed`, `kept`, `culled`, `trashed` (persisted app-side in SQLite; see docs/STATE_MODEL.md) | mobile |
| `DuelRecord` | One stored compare outcome (m0.1+ duel history, mined by later features) | mobile |
| `FlagType`, `FLAG_TYPES` | Desktop flags: `delete \| edit \| move \| review \| rename \| date` | desktop |
| `Rng` | Injected random source `() => number` in `[0, 1)` | everything random |

### `rng.ts`
| Export | What |
|---|---|
| `mulberry32(seed)` | Tiny seedable PRNG (determinism in tests and reproducible mixes) |
| `shuffled(arr, rng)` | Fisher–Yates into a new array |
| `pickOne(arr, rng)` | Uniform pick, throws on empty |

### `clustering.ts` — desktop story engine, mobile cull groups
| Export | What |
|---|---|
| `clusterByGap(items, { gapMs })` | Sort by timestamp; a gap **>** `gapMs` starts a new cluster. Every item lands in exactly one cluster (singletons included — callers filter by size) |
| `clusterMoments(items, gapMs?)` | Preset: 3-minute gap (`MOMENTS_GAP_MS`) |
| `clusterSessions(items, gapMs?)` | Preset: 30-minute gap (`SESSIONS_GAP_MS`) |
| `capCluster(cluster, cap)` | Even sampling down to `cap` (keeps first + last, preserves order) |
| `DEFAULT_CLUSTER_CAP` | 8 |

### `similarity.ts` — mobile group refinement
| Export | What |
|---|---|
| `dhash64(lumaGrid)` | 64-bit dHash as a 16-char hex string; caller supplies the 9×8 luma grid |
| `hammingDistance(a, b)` | Bit distance between two hashes (throws on malformed input) |
| `refineClustersBySimilarity(clusters, hashes, threshold)` | Splits time clusters into connected components of ≤-threshold neighbors (chain-linking keeps drifting bursts together; null hashes attach to the nearest-by-timestamp neighbor) |

### `mix.ts` — desktop story engine

`createMix({ items, clusters?, weights?, avoidRepeatWindow?, clusterCap?, rng })` returns `{ next(): MediaItem }`, an endless slideshow stream.
The stream plays clusters consecutively (capped/sampled) and interleaves random singles per `weights` (`{ cluster, single }`, default 1:1).
It never repeats an item within `avoidRepeatWindow` picks (clamped to `items.length - 1`, default 20).
It never runs dry (cluster epochs reshuffle).
Under a seeded `rng`, the stream is fully deterministic.

### `retrospectives.ts` — desktop, roadmap v0.8
| Export | What |
|---|---|
| `thisDayInHistory(items, { month, day, toleranceDays? })` | Photos on this calendar day across all years (± tolerance, year-wrap aware) |
| `onePerDayOfMonth(items, { year, month, rng })` | One random photo per day of a month |
| `onePerMonthOfYear(items, { year, rng })` | One random photo per month of a year |

All date math uses local naive time (PLAN.md: EXIF timestamps are best-effort local).

### `flags.ts` — desktop flag capture (organizer actions: roadmap v0.7)

Immutable functions over a serializable `FlagQueueState`:

- `createFlagQueue()`
- `addFlag(state, { path, flagType, at, note? })` (deduped by `(path, flagType)`)
- `removeFlag(state, path, flagType)`
- `listFlags(state, flagType?)`
- `flagQueueToJSON(state)` / `flagQueueFromJSON(json)` (versioned, malformed entries are dropped)

### `grouping.ts` — mobile cull grouping (the m0.8 embedding engine)

`groupByEmbedding(items, options)` builds the cull groups behind mobile review, and later desktop organizer culling (v0.7+).
A group is a de-duplication aid: visually similar photos that could substitute for each other.
Core never touches image bytes.
Callers inject an embedding lookup (`vecOf`, L2-normalized MediaPipe MobileNetV3-large vectors) and a dHash lookup (`hashOf`).

The pipeline:

1. Burst gate: gap-based time clustering (`BURST_GAP_MS`, 3 minutes).
2. Greedy centroid linkage within each burst (`LINK_BASE_THRESHOLD` cosine 0.50, relaxed by a time-decay bonus for gaps ≤ 60 s via `effectiveLinkThreshold`).
3. Adjacent-burst merge ≤ 15 minutes, only when both groups are internally tight and their centroids agree (`ADJACENT_MERGE_*` constants).
4. dHash near-duplicate floor: a within-burst pair at Hamming ≤ `NEAR_DUP_MAX_BITS` (8/64) is force-linked and annotated in `nearDupPairs`.

Types: `EmbedGroupingOptions`, `EmbedGroup`, `NearDupPair`.
The constants are fitted by `docs/grouping-study/fit_curve.mjs`.
The labels-v1 human-judged baseline is pinned in `test/grouping.test.ts`.

## Testing

```
npm run typecheck -w @afterglow/core
npm test -w @afterglow/core
npm run build -w @afterglow/core
```
