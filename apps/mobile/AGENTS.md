# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code. (SDK 57 / RN 0.86 / React 19.2; `expo-media-library/legacy` is used deliberately.)

# Afterglow Companion — map

Expo dev-client Android app (Expo Go won't do — media permissions + local module). `App.tsx` → SQLiteProvider → ThemeProvider (`theme.tsx`) → React Navigation stack (`navigation.ts` = route param types). **Run every `npx expo`/gradle command from `apps/mobile`**; `android/` is gitignored prebuild output (`npx expo prebuild --platform android`), versions live in `app.json` (`version`, `android.versionCode`).

## State model (the thing to understand first)

**SQLite is the ONLY review state (m0.8 — sessions are gone).** The continuous scan (`scan/scanRunner.ts`) pages MediaStore newest→oldest on app open, embeds + hashes each merge window natively (`lib/embeddings.ts` → `modules/image-embedder`), groups it with core `groupByEmbedding`, and lands groups in the durable tables (`db/store.ts writeContinuousGroups`, honoring the regroup boundary: reviewed groups and user-ejected singles are never rewritten — `lib/regroupBoundary.ts`, re-checked inside the write transaction). `review/ReviewContext.tsx` reads the queue (`listReviewGroups`/`listUnreviewedSingles`) and writes decisions directly (`applyReviewDecisions`, one awaited transaction each; no snapshot, no persistence queue): keep = `done` at swipe, cull stages the durable global cull queue, to-edit flags + queues, active-verdict tap clears to `unreviewed`; `reviewed_at` first-stamps on any verdict. Un-staging a cull re-decide lands on `done` (CullList "Restore" lands on `unreviewed`). Startup recovery (interrupted trash/share batches) runs once per process in the provider. m0.7 hardening that survives unchanged: trash-attempt lifecycle (`db/trashStore.ts` + `lib/trashFlow.ts`: prepare/reserve → launching → tri-state verify, at-most-once credit), edit-lifecycle coherence (cycle-keyed detection/completion, copy-match resolution, `db/store.ts` CASE writes), share (`db/shareStore.ts`) and organize (`db/organizeStore.ts`) durable queues. Both removal affordances use the local Android 11+ `modules/media-store-actions` trash request; never add a permanent-delete fallback. Settings are key/value rows parsed with fallback-to-default (pattern: `comparePrefs.ts` / `accentTheme.ts`).

## src/lib/ (pure logic is unit-tested; impure partner files do the platform I/O)

| File(s)                              | Contents                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| media.ts / recentMedia.ts            | MediaStore → core `MediaItem` adapter, one ranged recent-days scan, and the single recoverable-trash wrapper |
| favourites.ts / favouriteState.ts    | Batched native favourite/unfavourite action + `IS_FAVORITE` verification / pure durable intent transitions   |
| embeddings.ts                        | m0.8 embedding+hash backfill (impure): image-embedder module → per-photo photo_embeddings (+ photo_hashes via same-decode `withDhash`, source 'native'); adaptive 2–4 workers from measured decode/infer EMAs; engine-death detection |
| scanWindows.ts / regroupBoundary.ts  | m0.8 continuous scan (pure): newest→oldest merge-window accumulator / decision-5 freeze + window reconcile    |
| edit.ts / editActions.ts             | Write-request-first ACTION_EDIT + read-only ACTION_VIEW launches (impure) / intent constants + copy (pure)   |
| mediaIdentity.ts                     | Canonical volume-qualified photo ids `<volume>/<raw id>` (pure; media.ts re-exports)                         |
| editMatrix.ts                        | Gate-0 editor-launch diagnostic matrix: probe sequencing, write-request branch, shareable report (pure)      |
| detect.ts / editDetection.ts         | Edit detection on Home focus (MediaStore+SQLite wiring) / pure decision heuristics                           |
| sources.ts / sourceCatalog.ts        | Photo-source folder targeting (pure) / MediaStore album catalog + persisted selection                        |
| dates.ts                             | Day/range scope date math, local time                                                                        |
| progress.ts / progressPager.ts       | Progress/state-bar logic / newest-first k-way merged pager                                                   |
| groupFlow.ts                         | Automatic next-unfinished-group routing after a group is completed                                           |
| hash.ts                              | Lazy content-hash fallback identity (only for staged culls)                                                  |
| comparePrefs.ts                      | "Don't ask again" compare-cull confirmation flag                                                             |
| accentTheme.ts                       | Accent setting + token derivation (Material You via modules/material-you-accent)                             |
| format.ts / toast.ts                 | Bytes/labels formatting; ToastAndroid wrapper                                                                |

`scan/scanRunner.ts` is the m0.8 continuous-scan
orchestrator (single-flight per process, Home starts it once permission
lands): merged newest→oldest paging → merge windows → embed (cache-aware) →
core `groupByEmbedding` → regroup boundary → `writeContinuousGroups` into the
one 'continuous' grouping run; exports the observable `ScanStatus` (gate-4
Home surface). `db/embeddingStore.ts` owns photo_embeddings (BLOB float32
vectors keyed by asset id + mod_time) and the model-SHA pin whose mismatch
triggers the destructive re-embed event. `modules/media-store-actions` is the
Android 11+ native trash/favourite boundary plus the gate-0 editor-launch
diagnostics (environment/permission probes, intent dispatch probes,
`createWriteRequest`); `modules/material-you-accent` reads the system tone;
`modules/image-embedder` is the MediaPipe MobileNetV3-large embedder
(`embed(uri, decodeCap)`, pinned `MODEL_SHA256`).

## src/screens/ + components/

Home (continue-reviewing CTA over the live queue counts, queue cards: edit/favourite/cull/share/organize/History, recent-day rows, edit detection on focus, scan kick once permission lands) · Groups (the review queue: group cards + singles bucket, whole-card navigation, decision badges) · Deck/Singles (one scrollable review deck over the DB-backed groups, big three Keep/Compare/Cull + queue row Edit·Favourite·Organize·Share, singles auto-advance, automatic next-group advance, pinch-zoom overlay with double-tap reset, Compare-with picker, inline organize album picker; completed groups reopen in browse/re-decide mode) · Compare (A/B flip, sync zoom + double-tap reset, group/singles labels, verdicts) · CullList (the durable GLOBAL cull queue, re-decide/restore, confirm → ReviewContext.confirmStagedCulls loops the trash-attempt lifecycle in bounded batches) · EditQueue (two buttons: write-request-first Edit + read-only Gallery; matrix via failure alert) · FavouritesQueue (verified one-transaction batched gallery apply/remove) · ShareQueue (multi-pass grid, ✓ pass badges, labels, explicit clear) · OrganizeQueue (targets, batched verified moves) · History (two-stream keyset feed: photo decisions + share events; tap a photo row → StateEditorSheet) · Summary (daily + lifetime stats) · Progress/DayProgress (state browsing) · Settings (source, accent, reset confirmations, about) · SourcePicker (saves trigger a rescan). Components: DecisionBadge, ReDecideSheet, BigButton, StateProgressBar, EditDiagnosticsSheet (gate-0 matrix driver), progress/* (grid, view, state editor, stateMeta).

## Verify

`npm run typecheck -w afterglow-companion`; `npm test -w afterglow-companion`; bundle proof `npx expo export --platform android` (from apps/mobile); native proof `npx expo prebuild --platform android --clean --no-install && cd android && ./gradlew :app:assembleDebug`. Device/emulator workflow + gesture checks: docs/DEVELOPMENT.md; on-device/Samsung acceptance checklist lives in the current release plan's gates (docs/Plan_<version>.md). Release APK: `cd android && ./gradlew assembleRelease` (debug-keystore signed — do not change signing).
