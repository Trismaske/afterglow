# Afterglow Companion (Android)

Drive every phone photo to a reviewed end-state. m0.1 shipped the
trip-ready culler: pick a day, duel through burst groups two photos at a
time, sweep the singles, review the staged cull list, and delete the batch
to the system trash with one confirmation. m0.2 adds the full state
machine: flag keepers as "needs edit" anywhere, work the in-app edit queue
(fires `ACTION_EDIT` into your editor of choice), and watch each day
converge to done on the inbox-zero progress views.

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
3. **Duel** — the signature mechanic. Two photos from the group, stacked.
   Tap **✕ Cull** on the weaker shot (stages it for deletion), or **★
   Better** to keep both and advance that one. Winners duel on until a
   group best emerges. Tap **✎ needs edit** on either photo to send it to
   the edit queue if it survives. Long-press any photo to inspect it
   fullscreen. Every outcome is recorded as duel history.
4. **Singles** — one photo at a time: **Cull**, **To edit**, or **Keep**.
5. **Cull list** — everything staged, as a grid. Tap any photo to restore
   it. The single delete button is the only thing in the app that deletes
   anything: on Android 11+ the system dialog moves the batch to the
   system trash (recoverable ~30 days).
6. **Summary** — photos reviewed, keepers, culls, approximate storage
   reclaimed, and how many keepers joined the edit queue. Finishing the
   session converges the remaining keepers to done.
7. **Edit queue** — every `to_edit` photo across all days (thumbnail +
   taken date). **✎ Edit** fires an `ACTION_EDIT` intent with the photo's
   `content://` URI and read+write grant flags, opening your editor of
   choice; when you come back the app asks whether to mark it done.
   **✓ Mark done** is always available manually — edit *detection* is
   m0.3.
8. **Day progress** — the inbox-zero view for one day: counts for
   unreviewed / in duels / kept / to edit / staged cull / done, with a
   segmented progress bar that fills as the day converges.

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
