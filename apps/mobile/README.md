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
`trashed` are excluded when you start a new session over the same range —
interim states (`unreviewed`/`kept`/`culled` from an abandoned session)
get re-reviewed. Every decision is reversible until the final cull
confirmation.

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
   group), clusters by time proximity, then refines groups by perceptual
   similarity (dHash; strictness chips + fine-tune slider in Settings)
   while "Analyzing photos…" counts up.
3. **Groups overview** — burst groups with thumbnail strips plus the
   singles bucket. Enter any group in any order, do singles first if you
   like, or let "Continue" walk you through linearly. A tap anywhere on a
   group card opens that group. **End session & apply** banks
   everything decided so far and jumps to the cull list.
4. **Group review (swipe deck)** — swipe through the group's photos:
   **Cull** (4 s undo), **Keep rest** to finish the group, **To edit** to flag
   an edit, **Best** to star the best, "Not related" to eject a photo to the
   singles bucket. Pinch to zoom right in the deck; **Compare** opens a
   picker of the group's other photos. As soon as the group is complete,
   review advances to the next unfinished group; there is no second-pass
   reconsider screen.
5. **Compare** — two candidates full-screen: **tap anywhere to flip**
   between them (instant — flicker-comparing is the point) and pinch to
   zoom; the transform applies to both photos identically, so flipping
   while zoomed compares the exact same crop. Labels keep the photos'
   group numbers. **★ is better** stars the best-of-group; in a two-photo
   group it offers to cull the other (with "don't ask again", resettable
   in Settings). Every verdict is recorded as compare history.
6. **Singles** — the same freely scrollable deck, strip, zoom, compare,
   Keep/To edit/Cull controls, and “Keep remaining” shortcut as grouped photos.
7. **Cull list** — everything staged, as a grid. Tap any photo to change
   its verdict (restore, keep, to-edit). On Android 11+ the system dialog
   moves the batch to Android's system trash (recovery duration is controlled
   by the system gallery). Below Android 11, Afterglow does not offer a
   permanent-delete fallback.
8. **Favourites queue** — hearts from Deck, Singles, browse mode, and Compare
   collect here. Android 11+ applies or removes them from system gallery
   favourites in verified, retryable batches.
9. **Summary** — session totals plus a compact all-time card: unique photos
   reviewed/culled, edits completed, favourites applied, approximate storage
   reclaimed, and current/longest streaks. Finishing converges the remaining
   keepers to done.
10. **Edit queue** — every `to_edit` photo across all days. **✎ Edit**
    fires an `ACTION_EDIT` intent with the photo's `content://` URI and
    read+write grant flags; if no editor answers, it falls back to
    opening the photo in your viewer/gallery (whose edit button is one
    tap away). Returning to the app asks whether to mark it done;
    **✓ Mark done** is always available manually.
11. **Progress** — per-day and global inbox-zero views: counts for
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
from Home. Replacing an unfinished session banks its kept photos first;
only staged culls must be re-earned (a stale delete list is never carried
into a new session).

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
  MediaStore asset id (lazy SHA-256 content hash as fallback identity),
  `duels` compare history, `sessions` with the serialized core snapshot,
  `photo_hashes` dHash cache, and a key/value `settings` table (source
  folders, similarity, sessions, scopes, accent). Schema changes ship as
  append-only `PRAGMA user_version` migrations (`src/db/database.ts`).
- The needs-edit flag is app-side state (`photos.needs_edit`): core only
  knows kept/culled, and every state write remaps kept + flag → `to_edit`
  in one CASE expression, so the flag survives review, group completion
  and un-culling.
- `src/lib/edit.ts` + `editFallback.ts` document the editor-launch
  decisions: raw `ACTION_EDIT` string, `content://` URI, read+write grant
  flags, explicit `image/*` MIME, `ACTION_VIEW` fallback.
  Editor result codes are untrustworthy, so nothing auto-marks done.
- Rendering via `expo-image`; gestures via react-native-gesture-handler +
  reanimated 4 (compare flip/zoom and the deck's pinch-zoom overlay share
  the same clamp math). Theming derives semantic accent tokens from a
  preset or the Material You palette (local Expo module
  `modules/material-you-accent`).
- Pure logic modules in `src/lib/` are unit-tested with vitest; everything
  touching MediaStore/SQLite stays in thin typed adapters
  (`src/lib/detect.ts`, `src/db/store.ts`). See `AGENTS.md` for the
  per-file map.
