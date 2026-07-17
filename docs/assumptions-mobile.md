# Assumptions — mobile train

Judgment calls made while building Afterglow Companion, per version.
Merged into `ASSUMPTIONS.md` at the end of the build.

## m0.1

1. **`expo-media-library/legacy` import, deliberately.** SDK 57 introduced a
   new class-based Query/Asset API and deprecated `getAssetsAsync` /
   `deleteAssetsAsync` — but the legacy module is still shipped, documented,
   and is the battle-tested path for cursor paging and the Android system
   delete dialog. All MediaStore access goes through
   `src/lib/media.ts`; migrating to the new API is one file. Revisit in m0.2+.
2. **Cull-group gap = core `MOMENTS_GAP_MS` (3 minutes).** Clusters with ≥ 2
   photos become duel groups; 1-photo clusters go to the singles bucket. Not
   yet user-configurable (m0.1 scope).
3. **Duel presentation: two photos stacked vertically**, one tap per decision
   ("✕ Cull" stages that photo and the other wins; "★ Better" keeps both and
   advances that photo). Long-press a photo to inspect it fullscreen.
   The full-screen A/B flip + synchronized zoom is m0.3 per PLAN.md.
4. **Linear review flow.** One big "Continue" button drives duels
   group-by-group (core's `nextPair()` order = chronological), then singles,
   then the cull list. Jumping into an arbitrary group is not supported in
   m0.1 (core drives brackets in order); the Groups screen is an overview.
5. **Singles use big Keep/Cull buttons, not swipes** — buttons are unambiguous
   with two-handed hotel-bed ergonomics; swipe gestures are optional polish
   later (PLAN.md allows this).
6. **Delete-path correctness:** `deleteAssets()` in `src/lib/media.ts` is the
   only call in the app that deletes media, reachable only from the cull-list
   confirm button. An in-app Alert confirms first (this matters on
   Android < 11 where there is no system dialog); on Android 11+ the system
   dialog is the real gate and moves the batch to the system trash (~30-day
   recovery). `deleteAssetsAsync` returning false / throwing is treated as
   "user cancelled": the batch is rolled back from `confirmed` to `culled` by
   rewriting the core session snapshot (core deliberately has no un-confirm;
   the versioned snapshot format is the escape hatch).
7. **Session persistence:** the whole core `CullSession` (including
   mid-bracket state) is serialized into `sessions.snapshot` after every
   decision, alongside per-photo state updates and the duel record, in one
   exclusive SQLite transaction. Restart → Home offers "Resume". One active
   session at a time; starting a new one abandons (not deletes) the old one
   after an explicit confirm.
8. **Content-hash fallback identity is lazy and best-effort:** SHA-256 via
   expo-crypto, computed in the background only for photos staged as culls
   (never 200 hashes for a day's load). Failures are silently ignored —
   MediaStore id remains the primary key (PLAN.md).
9. **Storage reclaimed is approximate:** summed `File.size` (new
   expo-file-system API) of staged culls, measured just before deletion; 0
   for unreadable files. Labeled "approximate" in the UI.
10. **Timestamps:** `creationTime` from MediaStore, falling back to
    `modificationTime` when creationTime is 0/missing (WhatsApp-style files);
    clustering is best-effort local time per PLAN.md risks.
11. **Permissions:** `expo-media-library` config plugin with
    `granularPermissions: ["photo"]` → READ_MEDIA_IMAGES on Android 13+,
    READ_EXTERNAL_STORAGE on older; runtime request via `usePermissions({
    granularPermissions: ['photo'] })`. Deletion needs no extra permission —
    Android 11+ uses the system delete-request dialog. iOS strings included
    but untested (Android-first).
12. **Testers need a dev build** (`npx expo run:android` or an EAS dev
    build) — media permissions and expo-dev-client don't work in Expo Go.
    Documented in `apps/mobile/README.md`.
13. **No mobile unit-test runner in m0.1.** Decision logic lives in
    @afterglow/core (tested there); app-side lib modules are thin and typed.
    Verification = `tsc --noEmit` + `expo export --platform android` (Metro
    bundle). No device/emulator on the build machine, so the first on-device
    run is on the user's phone.
14. **Abandoned sessions keep their photo state rows** (`photos.state`
    reflects the last decision made). m0.2's full state machine will decide
    how stale `unreviewed`/`kept` rows are reconciled on the next scan of the
    same day.
15. **Added a minimal mobile CI workflow** (`.github/workflows/mobile-ci.yml`:
    typecheck + Metro export on PR/push) even though the roadmap doesn't
    mention mobile CI — it mirrors the verification gate and costs ~2 min.
16. **Mobile docs live in `apps/mobile/README.md`**, with only a short
    pointer section in the root README (the root file was concurrently being
    edited by the desktop train; the pointer hunk was staged independently).

## m0.2

1. **`to_edit`/`done` live in SQLite, not in core.** Core's `CullSession`
   still only knows unreviewed/kept/culled/confirmed/trashed; the needs-edit
   flag is an app-side column (`photos.needs_edit`) and every state write
   remaps kept + flag → `to_edit` via a CASE expression in
   `persistDecision`/`setNeedsEdit`. This keeps core untouched (shared,
   prebuilt, other train may be using it) and matches PLAN.md's "SQLite is
   the source of truth for photo state". Core's `SingleAction` widening to
   `'to_edit'` is left for whenever core is next opened up.
2. **Convergence rule:** photos the user kept but did not flag become
   `done` when the session *finishes* (Summary → Finish runs kept → done
   for the session's photos). Abandoned sessions leave rows `kept`, which
   counts as "still converging" in the progress views and gets re-reviewed
   next session.
3. **Session re-scan reconciliation (m0.1 #14 resolved):** starting a new
   session over a range now *excludes* photos already `to_edit`, `done` or
   `trashed`; interim states (`unreviewed`, `kept`, `culled` from an
   abandoned session) are re-included and reset to `unreviewed` (a staged
   cull from an abandoned session must be re-earned — safer than carrying a
   stale delete list into a new bracket). Home shows "N already handled".
4. **m0.1 data migration:** schema v2 turns every existing `kept` row into
   `done` (m0.1 had no finish-time convergence step, so `kept` was its
   terminal keeper state). If an unfinished m0.1 session is resumed after
   the upgrade, its keeper rows briefly read `done` in progress views until
   the session rewrites them — cosmetic only, and the session snapshot
   (authoritative for review flow) is unaffected.
5. **Migration runner:** append-only array of SQL batches, `MIGRATIONS[n]`
   moves `PRAGMA user_version` n → n+1; each batch runs in one `execAsync`
   with the version bump as its last statement. `day` (local `YYYY-MM-DD`
   from `taken_at`) is backfilled with SQLite `date(..., 'localtime')`; new
   rows compute it in JS — both are device-local time.
6. **ACTION_EDIT decisions** (per m0.2 spec, "document what you land on"):
   raw action string `android.intent.action.EDIT` (SDK 57's ActivityAction
   enum only covers settings screens; `startActivityAsync` accepts
   `ActivityAction | string`); `data` = the asset's `content://` URI from
   legacy `getAssetContentUriAsync` (fallback: constructed
   `content://media/external/images/media/<id>`); `flags = 0x1 | 0x2`
   (FLAG_GRANT_READ_URI_PERMISSION | FLAG_GRANT_WRITE_URI_PERMISSION) so
   the editor can save over the original; `type` omitted — the SDK 57 docs
   say Android then infers the exact MIME from the content provider, which
   matches more editor intent filters than hardcoding `image/*`.
7. **Editor result codes are ignored as a signal.** Most editors return
   Canceled even after saving, so returning from the editor only triggers a
   "Mark done?" prompt — never an automatic transition. Manual "Mark done"
   is always available (PLAN.md risk mitigation); real edit detection is
   m0.3.
8. **Needs-edit flag semantics in duels:** the ✎ toggle on a duel card
   flags the *photo*, not the decision. If the photo is later culled the
   flag is moot (culled wins); if it is un-culled from the cull list it
   comes back as `to_edit`, not plain kept — the CASE remap makes this hold
   everywhere without special-casing.
9. **Day-progress accounting:** a day's true total = MediaStore count +
   `trashed` rows (trashed photos have left MediaStore). MediaStore photos
   never tracked in SQLite count as unreviewed; `done` in the bar/rows =
   `done` + `trashed` ("everything converges to done" includes culls).
   "In duels" = unreviewed rows with a `group_id`.
10. **Home shows the last 7 days** (days with zero photos are hidden);
    per-day MediaStore totals come from one `getAssetsAsync({first: 1})`
    `totalCount` read per day, refreshed on screen focus.
11. **`photos.session_day` (the free-text session label) is retained but
    superseded** by the new `day` column for anything day-scoped; dropping
    a column needs a table rebuild and isn't worth it in a v2 migration.
