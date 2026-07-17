# Assumptions — core train

Judgment calls made while building `@afterglow/core`, per version. Merged
into `ASSUMPTIONS.md` at the end of the build.

## core-0.1.0

1. **`clusterByGap` returns singleton clusters too** — every input item lands
   in exactly one cluster. Callers filter by size for their own notion of
   "group" (e.g. mobile cull groups use `items.length >= 2`). This keeps the
   cluster/singles split a caller decision instead of baking a threshold into
   core.
2. **Gap semantics:** a gap of *exactly* `gapMs` stays in the cluster; only
   strictly-greater gaps split. Identical timestamps are tie-broken by id so
   clustering is fully deterministic.
3. **Cluster ids** are `"<startTimestamp>:<firstItemId>"` — stable across
   re-clustering of the same library, no rng/counter involved.
4. **`capCluster` even sampling** always keeps the first and last item and
   samples interior shots evenly (`cap === 1` picks the middle shot).
5. **Extra module `rng.ts`** (`mulberry32`, `shuffled`, `pickOne`) beyond the
   planned file list — both apps and the tests need a seedable rng; core
   itself never defaults to `Math.random`/`Date.now` (rng and `at` are
   required parameters wherever relevant).
6. **Mix engine internals:** cluster playback order is an rng-shuffled epoch
   (reshuffled when exhausted); random singles are drawn uniformly from the
   *non-recent* portion of the full pool rather than via a strict shuffle
   bag — same guarantees (no repeat within the window, never runs dry, fully
   deterministic under a seeded rng) with simpler state. `avoidRepeatWindow`
   is clamped to `items.length - 1`; a cluster whose sampled run is entirely
   inside the repeat window is skipped that turn (falls back to a single).
   Defaults: weights 1:1, window 20, cluster cap 8.
7. **Retrospectives use local naive time** (PLAN.md: EXIF timestamps are
   best-effort local). A Feb 29 target rolls to Mar 1 in non-leap years (JS
   Date overflow); `toleranceDays` handles Dec/Jan year wraparound.
8. **Flag queue dedupe keeps the original entry** — re-flagging the same
   (path, flagType) is a no-op and the first `at` wins. `flagQueueFromJSON`
   drops malformed entries instead of throwing the whole queue away (a
   corrupt line shouldn't lose a session's flags).
9. **Cull bracket rules:**
   - A `keepBoth` loser leaves the bracket and becomes `kept` immediately;
     bracket survivors flip `unreviewed → kept` when the group completes.
   - Odd rounds give the leftover photo a **bye** into the next round; a bye
     is not a "win", so it doesn't shield a photo from
     `autoCullCandidates()` (which is: kept, never won a duel, not the group
     best).
   - A 1-photo group auto-completes (its photo is best and kept, no duels).
   - `markTrashed` validates the whole batch before mutating (atomic), so a
     bad id can't leave a half-trashed batch.
   - Singles may be decided out of order (`decideSingle` takes an id);
     `nextSingle()` is just "first still-unreviewed".
   - Duplicate photo ids across groups/singles and duplicate group ids are
     rejected at `create()` — silent aliasing would corrupt states.
10. **`SingleAction = 'keep' | 'cull'`** is a plain string union; m0.2 widens
    it with `'to_edit'` — additive and non-breaking for callers.
11. **Relative imports carry `.js` extensions** so the compiled `dist/` is
    valid Node ESM as-is (bundlers are happy either way).
12. **`PhotoState` already declares `to_edit` and `done`** even though m0.1
    never produces them — apps can persist states now without a core type
    bump later.
