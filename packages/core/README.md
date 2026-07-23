# @afterglow/core

The shared brain of Afterglow Desktop and Afterglow Companion. Pure
TypeScript: no filesystem, no platform APIs, and no `Date.now()` /
`Math.random()` defaults — timestamps (`at`) and randomness (`rng`) are
always injected, so everything is deterministic and testable. Both apps map
their native media (file paths, MediaStore rows) into `MediaItem[]` through
their own adapters.

Built output lives in `dist/` (`npm run build -w @afterglow/core`); apps
import from `@afterglow/core`.

## Exports

### `types.ts`
| Export | What | Consumed by |
|---|---|---|
| `MediaItem`, `MediaKind` | One photo/video: `{ id, timestamp, uri, kind }` | everything |
| `Cluster` | Time-proximate group, items sorted ascending | both apps |
| `PhotoState`, `PHOTO_STATES` | Mobile state machine: `unreviewed → kept/culled → confirmed → trashed`, plus `to_edit`/`done` (app-side states persisted in SQLite) | mobile |
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
`createMix({ items, clusters?, weights?, avoidRepeatWindow?, clusterCap?, rng })`
returns `{ next(): MediaItem }` — an endless slideshow stream that plays
clusters consecutively (capped/sampled), interleaves random singles per
`weights` (`{ cluster, single }`, default 1:1), never repeats an item within
`avoidRepeatWindow` picks (clamped to `items.length - 1`, default 20), and
never runs dry (cluster epochs reshuffle). Fully deterministic under a
seeded `rng`.

### `retrospectives.ts` — desktop, roadmap v0.8
| Export | What |
|---|---|
| `thisDayInHistory(items, { month, day, toleranceDays? })` | Photos on this calendar day across all years (± tolerance, year-wrap aware) |
| `onePerDayOfMonth(items, { year, month, rng })` | One random photo per day of a month |
| `onePerMonthOfYear(items, { year, rng })` | One random photo per month of a year |

All date math uses local naive time (PLAN.md: EXIF timestamps are
best-effort local).

### `flags.ts` — desktop flag capture (organizer actions: roadmap v0.7)
Immutable functions over a serializable `FlagQueueState`:
`createFlagQueue()`, `addFlag(state, { path, flagType, at, note? })` (deduped
by `(path, flagType)`), `removeFlag(state, path, flagType)`,
`listFlags(state, flagType?)`, `flagQueueToJSON(state)` /
`flagQueueFromJSON(json)` (versioned; malformed entries are dropped).

### `deck.ts` — mobile group review (the live session model)
`DeckSession.create({ groups, singles? })` — the swipe-deck model the
Companion drives. Per group it tracks members, alive (undecided) photos, a
cursor, completion and a starred best.

- **Decisions:** `cull(id)` stages a photo; `undoCull(id)` restores it into
  the deck; `keepRest(groupId)` completes the group keeping every alive
  member; `cullKept(id)` / `unstageCull(id)` are the re-decide transitions
  (reversible until confirm); `markBest` stars a photo; `makeSingle(id)`
  ejects a photo to the singles queue.
- **Compares:** `recordCompare(...)` stores a `DuelRecord`;
  `reconsiderCandidates(groupId)` — kept photos that lost a compare and
  never won one (excluding the best) — is retained analysis for future
  consumers and does not interrupt the current mobile flow.
- **Singles:** `nextSingle()` / `decideSingle(id, action)` with
  `SingleAction = 'keep' | 'cull'` — `to_edit` is layered on top by the
  mobile app's SQLite states, not core.
- **Staged culls:** `stagedCulls()`, `confirmAll()` (`culled → confirmed`,
  returns ids), then the app deletes and calls `markTrashed(ids)` (atomic —
  a bad id mutates nothing).
- **Persistence:** `toJSON()` / `DeckSession.fromJSON(json)` — versioned
  JSON (`kind: 'deck'`), survives app restarts mid-review.

### `cull.ts` — legacy pairwise duel bracket
`CullSession` (m0.1–m0.3's mechanic: duels advance winners bracket-style
until a group best emerges, `autoCullCandidates` hints). Exported and
tested but no longer used by the apps; kept for potential desktop
burst-culling reuse.

## Testing

```
npm run typecheck -w @afterglow/core
npm test -w @afterglow/core
npm run build -w @afterglow/core
```
