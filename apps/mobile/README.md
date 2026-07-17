# Afterglow Companion (Android)

Drive every phone photo to a reviewed end-state. m0.1 shipped the
trip-ready culler: pick a day, duel through burst groups two photos at a
time, sweep the singles, review the staged cull list, and delete the batch
to the system trash with one confirmation. m0.2 adds the full state
machine: flag keepers as "needs edit" anywhere, work the in-app edit queue
(fires `ACTION_EDIT` into your editor of choice), and watch each day
converge to done on the inbox-zero progress views. m0.3 adds detection &
compare polish: automatic edit detection on app open (in-place edits
auto-mark done; edited copies are spotted and you choose the original's
fate), auto-cull hints after each bracket ("you kept N — reconsider these
M?"), and a rebuilt duel compare — full-screen A/B flip with synchronized
pinch-zoom.

## The state machine (m0.2)

```
unreviewed ──duel/single review──┬─▶ culled ─▶ (system delete) ─▶ trashed
                                 └─▶ kept ──┬─▶ to_edit ─▶ done
                                            └─(session finish)─▶ done
```

SQLite (`photos.state`) is the source of truth. Keepers you don't flag
converge to `done` when the session finishes; flagged keepers wait in the
edit queue until you mark them done. Photos already `to_edit`/`done`/
`trashed` are excluded when you start a new session over the same range —
interim states (`unreviewed`/`kept`/`culled` from an abandoned session)
get re-reviewed.

## Running it (dev build required — NOT Expo Go)

Media permissions and the dev client don't work in Expo Go. You need a
development build on a real Android device:

```bash
cd apps/mobile
npx expo run:android        # device connected with USB debugging enabled
```

or build a dev client with EAS (`eas build --profile development
--platform android`) and then `npx expo start --dev-client`.

## The flow

1. **Home** — grant photo access, pick a scope: Today / Yesterday / custom
   date range. Shows how many photos still need review (already-handled
   ones are skipped), the edit queue, and per-day progress bars for the
   last week — tap a day for its full breakdown.
2. **Session overview** — burst groups (photos ≤ 3 min apart) with
   thumbnail strips, plus the singles bucket. One button continues the
   review wherever it left off.
3. **Duel** — the signature mechanic, now a full-screen A/B compare (m0.3).
   Both candidates render stacked; **tap anywhere to flip** between A and B
   (instant, no crossfade — flicker-comparing is the point) and **pinch to
   zoom**: the transform applies to both photos identically, so flipping
   while zoomed compares the exact same crop for sharpness/eyes checks.
   The A/B badge and chips show which is on screen. Tap **✕ Cull** to
   stage the visible shot (the other wins), or **★ is better** to keep
   both and advance the visible one. Winners duel on until a group best
   emerges; every outcome is recorded as duel history.
4. **Reconsider** (m0.3) — when a bracket completes and some keepers never
   won a duel, a second pass asks "you kept N — reconsider these M?" with
   one-tap **Cull**/**Keep** per photo. Undecided photos stay kept.
   Needs-edit-flagged photos are exempt.
5. **Singles** — one photo at a time: **Cull**, **To edit**, or **Keep**.
6. **Cull list** — everything staged, as a grid. Tap any photo to restore
   it. On Android 11+ the system dialog moves the batch to the system
   trash (recoverable ~30 days).
7. **Summary** — photos reviewed, keepers, culls, approximate storage
   reclaimed (this session and all-time), your review streak, and how many
   keepers joined the edit queue. Finishing the session converges the
   remaining keepers to done.
8. **Edit queue** — every `to_edit` photo across all days (thumbnail +
   taken date). **✎ Edit** fires an `ACTION_EDIT` intent with the photo's
   `content://` URI and read+write grant flags, opening your editor of
   choice; when you come back the app asks whether to mark it done.
   **✓ Mark done** is always available manually.
9. **Day progress** — the inbox-zero view for one day: counts for
   unreviewed / in duels / kept / to edit / staged cull / done, with a
   segmented progress bar that fills as the day converges.

### Edit detection (m0.3)

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

Close the app mid-session and nothing is lost: the whole session —
including a half-finished duel bracket — is persisted to SQLite after
every decision and resumes from Home.

## Architecture notes

- All bracket/staging/state logic is `@afterglow/core` (`CullSession`,
  `clusterByGap`) — pure TS, tested in the core package.
- `src/lib/media.ts` is the only MediaStore adapter (SDK 57
  `expo-media-library/legacy` — see `docs/assumptions-mobile.md` #1) and
  contains the app's single delete call.
- SQLite (expo-sqlite async API) is the source of truth: `photos` keyed by
  MediaStore asset id (lazy SHA-256 content hash as fallback identity),
  `duels` history, `sessions` with the serialized core snapshot. Schema
  changes ship as append-only `PRAGMA user_version` migrations
  (`src/db/database.ts`).
- The needs-edit flag is app-side state (`photos.needs_edit`): core only
  knows kept/culled, and every state write remaps kept + flag → `to_edit`
  in one CASE expression, so the flag survives duels, bracket completion
  and un-culling.
- `src/lib/edit.ts` documents the ACTION_EDIT decisions: raw action string
  (SDK 57 ships no constant), `content://` URI via
  `getAssetContentUriAsync`, flags `FLAG_GRANT_READ_URI_PERMISSION |
  FLAG_GRANT_WRITE_URI_PERMISSION`, MIME type omitted so Android infers it
  from the content provider. Editor result codes are untrustworthy, so
  nothing auto-marks done.
- Rendering via `expo-image` (`contentFit`, recycling keys) for fast
  thumbnails.
- The duel compare is react-native-gesture-handler (`Gesture.Pinch`/
  `Pan`/`Tap` composed) + reanimated 4 shared values. Both photos sit in
  one transformed container with an opacity flip, so the zoom state is
  naturally shared — no per-image sync needed. The worklets Babel plugin
  is auto-configured by `babel-preset-expo` (SDK 57).
- Duel history has one durable source of truth: the `duels` SQLite table
  (append-only archive across sessions). The core snapshot's `duelHistory`
  is in-session working state that drives `autoCullCandidates()`; both are
  written in the same transaction, and for the active session the snapshot
  wins.
- Pure heuristics (`src/lib/editDetection.ts`, `src/lib/dates.ts`) are
  unit-tested with vitest; everything touching MediaStore/SQLite stays in
  thin typed adapters (`src/lib/detect.ts`, `src/db/store.ts`).
