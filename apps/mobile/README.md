# Afterglow Companion (Android)

Drive every phone photo to a reviewed end-state. Pick a review scope,
work through burst groups as a swipe deck (cull, keep, flag to-edit,
compare candidates full-screen), sweep the singles, then delete the staged
cull list to the system trash with one confirmation. Keepers that need
editing wait in an in-app queue that launches your editor; each day
converges to "done" on the inbox-zero progress views.

## The state machine

```
unreviewed ──group/single review─┬─▶ culled ─▶ (system trash) ─▶ trashed
                                 └─▶ kept ──┬─▶ to_edit ─▶ done
                                            └─(session finish)─▶ done
```

SQLite (`photos.state`) is the source of truth. Keepers you don't flag
converge to `done` when the session finishes; flagged keepers wait in the
edit queue until you mark them done. Photos already `to_edit`/`done`/
`trashed` are excluded when you start a new session over the same range.
**Staged culls survive session replacement** (m0.7): the cull list is a
durable global queue, so starting a new session silently banks your
keepers and carries your staged culls — nothing is ever lost or
re-earned. Every decision is reversible until the final cull
confirmation.

> **Pre-1.0 testers:** upgrades between 0.x releases reset the app's
> local database (review history, queues, settings). Your photos are
> never touched — only Afterglow's own bookkeeping starts fresh.

## Running it (dev build required — NOT Expo Go)

Media permissions, SQLite and the local Material You module don't work in
Expo Go. You need a development build on a real Android device:

```bash
cd apps/mobile
npx expo run:android        # device connected with USB debugging enabled
```

or build a dev client with EAS (`eas build --profile development
--platform android`) and then `npx expo start --dev-client`. Testers grab
the release APK from the latest `mobile-m*` GitHub Release.

## The flow

1. **Home** — grant photo access, pick a review scope: rolling ranges
   (Last day / 7 days / 30 days / 6 months / year; All time unlocks once
   the last year is clear) or your own named custom ranges ("Japan —
   Jan 31 to Mar 6"). Shows how many photos still need review, the edit
   queue, and per-day progress bars for the last week.
2. **Session start** — the app draws up to the session cap (default 50,
   configurable, oldest- or newest-first, optionally never splitting a
   group) and groups **similarity-first** (m0.7): photos of the same
   subject group together even days apart — time proximity only ever
   *helps* borderline pairs, never excludes. Strictness chips + a
   fine-tune slider live in Settings, with a separate "group by time
   only" legacy toggle. "Analyzing photos…" counts up while hashes build.
3. **Groups overview** — burst groups with thumbnail strips plus the
   singles bucket. Enter any group in any order, do singles first if you
   like, or let "Continue" walk you through linearly. A tap anywhere on a
   group card opens that group. **End session & apply** banks
   everything decided so far and jumps to the cull list.
4. **Group review (swipe deck)** — swipe through the group's photos. The
   big three are **Keep / Compare / Cull** (m0.7: Keep decides the current
   photo and advances; Cull has a 4 s undo); below them the queue row
   **Edit · Favourite · Organize · Share** feeds the in-app queues, and
   **Best** / **Not related** sit beneath. **Keep remaining (N)** finishes
   the group. Pinch to zoom right in the deck (double-tap resets zoom).
   As soon as the group is complete, review advances to the next
   unfinished group; reopening a completed group uses the same screen in
   re-decide mode.
5. **Compare** — two candidates full-screen: **tap anywhere to flip**
   between them (instant — flicker-comparing is the point) and pinch to
   zoom; the transform applies to both photos identically, so flipping
   while zoomed compares the exact same crop. Labels keep the photos'
   group numbers. **★ is better** stars the best-of-group; in a two-photo
   group it offers to cull the other (with "don't ask again", resettable
   in Settings). Every verdict is recorded as compare history.
6. **Singles** — the same freely scrollable deck, strip, zoom, compare,
   Keep/To edit/Cull controls, and “Keep remaining” shortcut as grouped photos.
7. **Cull list** — the durable global staging queue (m0.7): everything
   staged across sessions, including culls carried from replaced
   sessions. Tap any photo to change its verdict. On Android 11+ the
   system dialog moves the batch to Android's system trash in verified
   batches (recovery duration is controlled by the system gallery).
   Below Android 11, Afterglow does not offer a permanent-delete
   fallback.
8. **Favourites queue** — hearts from Deck, Singles, browse mode, and Compare
   collect here. Android 11+ applies or removes them from system gallery
   favourites in verified, retryable batches.
9. **Summary** — session totals plus a compact all-time card: unique photos
   reviewed/culled, edits completed, favourites applied, approximate storage
   reclaimed, and current/longest streaks. Finishing converges the remaining
   keepers to done.
10. **Edit queue** — every `to_edit` photo across all days, with two
    launch buttons (m0.7): **✎ Edit** first asks Android for write access
    to the photo (one system confirm; auto-approved once granted), then
    fires `ACTION_EDIT` so editors like Google Photos can save over the
    original — denying write access still opens the editor read-only and
    saves become a copy. **Gallery** opens the photo read-only in your
    viewer (Samsung Gallery style) whose own edit button takes over.
    Returning to the app asks whether to mark it done; **✓ Done** is
    always available manually.
11. **Share queue** — a persistent working set for multi-pass sharing:
    queue photos with Share during review, then send overlapping subsets
    to different people across repeated share sheets. ✓ badges count the
    passes each photo joined this cycle ("Select unshared" finds the
    rest); an optional label per pass ("Mum") lands in History. Clearing
    is explicit and keeps past share events.
12. **Organize queue** — "move to a different album": pick an existing
    album on primary storage (or create one under Pictures/), then one
    system confirm per batch moves the photos with verified results.
    Moves are repeatable — a photo can be moved again later.
13. **History** — a filterable feed of past decisions on photos still
    present (kept / staged / to-edit / favourite / organized / share
    sheets), newest first. Photos deleted outside Afterglow drop out.
14. **Progress** — per-day and global inbox-zero views: counts for
    unreviewed / in groups / kept / to edit / staged / done, a photo grid
    filterable by state, and a per-photo state editor for out-of-session
    fixes.

### Edit detection

On app open (Home, throttled to once a minute) every queued `to_edit`
photo is re-checked, two heuristics because Android editors differ:

- **In-place edits** (Samsung Gallery style): the asset's MediaStore
  `modificationTime` moved past the stored baseline → auto-marked done
  with an unobtrusive notice. When a content hash baseline exists it acts
  as tiebreaker, so metadata-only changes (favorite toggled, moved to an
  album) don't false-positive; baselines are hashed lazily in the
  background, a few per run.
- **Edited copies** (Google Photos / Snapseed style): photos written since
  the original entered the queue whose filename relates
  (`IMG_123-edit`, `IMG_123~2`, `IMG_123_1`, `IMG_123 (1)`,
  `edited-IMG_123`, same base + new extension) or whose creation time
  clones the original's (±2 s) → the copy is tracked as done and a prompt
  asks whether to keep or cull the original (cull goes through the same
  system trash dialog as everything else).

Both heuristics can miss — detection is a convenience layer, and manual
**Mark done** always works. The pure matching logic lives in
`src/lib/editDetection.ts` with unit tests (`npm test -w
afterglow-companion`).

Close the app mid-session and nothing is lost: the session — including
the deck cursor — is persisted to SQLite after every decision and resumes
from Home. Replacing an unfinished session is silent and lossless (m0.7):
kept and edit decisions bank automatically, and staged culls carry into
the durable global cull list, ready to confirm whenever you are.

## Architecture notes

- Group/staging/state logic is `@afterglow/core` (`DeckSession`,
  `clusterByGap`, `refineClustersBySimilarity`) — pure TS, tested in the
  core package. The older pairwise duel bracket (`CullSession`) remains
  exported in core but the app no longer uses it.
- `src/lib/media.ts` is the only MediaStore adapter
  (`expo-media-library/legacy`, deliberately — migrating to the new SDK
  query API is tracked in PLAN.md's trigger-based backlog) and
  contains the app's single delete call.
- SQLite (expo-sqlite async API) is the source of truth: `photos` keyed by
  the canonical volume-qualified MediaStore id (m0.7, lazy SHA-256 content
  hash as fallback identity), `duels` compare history, `sessions` with the
  serialized core snapshot, durable grouping/share/organize/trash-attempt
  tables, `photo_hashes` dHash cache, and a key/value `settings` table
  (source folders, similarity, sessions, scopes, accent). Schema changes ship as
  a fresh-baseline DDL: before v1, schema changes bump SCHEMA_VERSION and
  the open path destructively resets mismatched databases
  (`src/db/database.ts` — pre-v1 velocity policy).
- The needs-edit flag is app-side state (`photos.needs_edit`): core only
  knows kept/culled, and every state write remaps kept + flag → `to_edit`
  in one CASE expression, so the flag survives review, group completion
  and un-culling.
- `src/lib/edit.ts` + `editActions.ts` document the editor-launch
  decisions (m0.7): request MediaStore write access first, then
  `ACTION_EDIT` with read (+write once granted) grant flags; `Gallery`
  is a separate read-only `ACTION_VIEW` launch. Editor result codes are
  untrustworthy, so nothing auto-marks done.
- Rendering via `expo-image`; gestures via react-native-gesture-handler +
  reanimated 4 (compare flip/zoom and the deck's pinch-zoom overlay share
  the same clamp math). Theming derives semantic accent tokens from a
  preset or the Material You palette (local Expo module
  `modules/material-you-accent`).
- Pure logic modules in `src/lib/` are unit-tested with vitest; everything
  touching MediaStore/SQLite stays in thin typed adapters
  (`src/lib/detect.ts`, `src/db/store.ts`). See `AGENTS.md` for the
  per-file map.
