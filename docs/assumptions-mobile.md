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
