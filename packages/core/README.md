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
| `Cluster` | Time-proximate group, items sorted ascending | desktop v0.3, mobile m0.1 |
| `PhotoState`, `PHOTO_STATES` | Mobile state machine: `unreviewed → kept/culled → confirmed → trashed`, plus `to_edit`/`done` (adopted in m0.2) | mobile m0.1+ |
| `FlagType`, `FLAG_TYPES` | Desktop flags: `delete \| edit \| move \| review` | desktop v0.2 |
| `Rng` | Injected random source `() => number` in `[0, 1)` | everything random |

### `rng.ts`
| Export | What |
|---|---|
| `mulberry32(seed)` | Tiny seedable PRNG (determinism in tests and reproducible mixes) |
| `shuffled(arr, rng)` | Fisher–Yates into a new array |
| `pickOne(arr, rng)` | Uniform pick, throws on empty |

### `clustering.ts` — desktop v0.3 (story engine), mobile m0.1 (cull groups)
| Export | What |
|---|---|
| `clusterByGap(items, { gapMs })` | Sort by timestamp; a gap **>** `gapMs` starts a new cluster. Every item lands in exactly one cluster (singletons included — callers filter by size) |
| `clusterMoments(items, gapMs?)` | Preset: 3-minute gap (`MOMENTS_GAP_MS`) |
| `clusterSessions(items, gapMs?)` | Preset: 30-minute gap (`SESSIONS_GAP_MS`) |
| `capCluster(cluster, cap)` | Even sampling down to `cap` (keeps first + last, preserves order) |
| `DEFAULT_CLUSTER_CAP` | 8 |

### `mix.ts` — desktop v0.3
`createMix({ items, clusters?, weights?, avoidRepeatWindow?, clusterCap?, rng })`
returns `{ next(): MediaItem }` — an endless slideshow stream that plays
clusters consecutively (capped/sampled), interleaves random singles per
`weights` (`{ cluster, single }`, default 1:1), never repeats an item within
`avoidRepeatWindow` picks (clamped to `items.length - 1`, default 20), and
never runs dry (cluster epochs reshuffle). Fully deterministic under a
seeded `rng`.

### `retrospectives.ts` — desktop v0.7
| Export | What |
|---|---|
| `thisDayInHistory(items, { month, day, toleranceDays? })` | Photos on this calendar day across all years (± tolerance, year-wrap aware) |
| `onePerDayOfMonth(items, { year, month, rng })` | One random photo per day of a month |
| `onePerMonthOfYear(items, { year, rng })` | One random photo per month of a year |

All date math uses local naive time (PLAN.md: EXIF timestamps are
best-effort local).

### `flags.ts` — desktop v0.2 (capture) / v0.6 (organizer)
Immutable functions over a serializable `FlagQueueState`:
`createFlagQueue()`, `addFlag(state, { path, flagType, at, note? })` (deduped
by `(path, flagType)`), `removeFlag(state, path, flagType)`,
`listFlags(state, flagType?)`, `flagQueueToJSON(state)` /
`flagQueueFromJSON(json)` (versioned; malformed entries are dropped).

### `cull.ts` — mobile m0.1 (the signature mechanic)
`CullSession.create({ groups, singles? })` — groups are `CullGroup`s
(`Cluster` is assignable); everything starts `unreviewed`.

- **Duels:** `nextPair()` peeks the current duel; `decideDuel(decision, at)`
  takes `{ cull: loserId }` (loser staged for culling) or
  `{ keepBoth: true, winner: id }` (both kept, winner advances). Winners
  advance bracket-style (byes handled) until a group best emerges —
  `groupBest(groupId)`, `isGroupComplete(groupId)`. Always n−1 duels per
  n-photo group.
- **History:** every outcome is a `DuelRecord { groupId, winnerId, loserId,
  keptBoth, at }` via the `duelHistory` getter.
- **Auto-cull hints (m0.3):** `autoCullCandidates(groupId)` — kept photos
  that never won a duel (excluding the best).
- **Singles:** `nextSingle()` / `decideSingle(id, action)` with
  `SingleAction = 'keep' | 'cull'` (m0.2 widens with `'to_edit'`).
- **Staged culls:** `stagedCulls()`, `unstageCull(id)` (restores to `kept`,
  never back into the bracket), `confirmAll()` (`culled → confirmed`,
  returns ids), then the app deletes and calls `markTrashed(ids)`.
- **Queries:** `getState(id)`, `isComplete()`, `summary()`.
- **Persistence:** `toJSON()` / `CullSession.fromJSON(json)` — plain JSON,
  survives app restarts mid-bracket.

## Testing

```
npm run typecheck -w @afterglow/core
npm test -w @afterglow/core
npm run build -w @afterglow/core
```
