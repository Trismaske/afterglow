# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code. (SDK 57 / RN 0.86 / React 19.2; `expo-media-library/legacy` is used deliberately.)

# Afterglow Companion — map

Expo dev-client Android app (Expo Go won't do — media permissions + local module). `App.tsx` → SQLiteProvider → ThemeProvider (`theme.tsx`) → ReviewProvider → React Navigation stack over bottom tabs (`navigation.ts` = route param types; tabs **Home · Edit · Favourite · Share · Organize**, count-badged — the bar exists only on those five surfaces, full-screen review lives in the parent stack). **Run every `npx expo`/gradle command from `apps/mobile`**; `android/` is gitignored prebuild output (`npx expo prebuild --platform android`), versions live in `app.json` (`version`, `android.versionCode`).

## State model (the thing to understand first)

**SQLite is the ONLY review state (m0.8 — sessions are gone).** The continuous scan (`scan/scanRunner.ts`) pages MediaStore newest→oldest on app open, embeds + hashes each merge window natively (`lib/embeddings.ts` → `modules/image-embedder`), groups it with core `groupByEmbedding`, and lands groups in the durable tables (`db/store.ts writeContinuousGroups`, honoring the regroup boundary: reviewed groups and user-ejected singles are never rewritten — `lib/regroupBoundary.ts`, re-checked inside the write transaction). `review/ReviewContext.tsx` reads the queue (`listReviewGroups`/`listSinglesFeed` — the singles feed keeps staged culls badged; `loadGroup` fetches a completed group for browse/re-decide) and writes decisions directly (`applyReviewDecisions`, one awaited transaction each; no snapshot, no persistence queue): keep = `done` at swipe, cull stages the durable global cull queue, to-edit flags + queues, active-verdict tap clears to `unreviewed`; `reviewed_at` first-stamps on any verdict. Un-staging a cull re-decide lands on `done` (CullList "Restore" lands on `unreviewed`). Startup recovery (interrupted trash/share batches) runs once per process in the provider. m0.7 hardening that survives unchanged: trash-attempt lifecycle (`db/trashStore.ts` + `lib/trashFlow.ts`: prepare/reserve → launching → tri-state verify, at-most-once credit), edit-lifecycle coherence (cycle-keyed detection/completion, copy-match resolution, `db/store.ts` CASE writes), share (`db/shareStore.ts`) and organize (`db/organizeStore.ts`) durable queues. Both removal affordances use the local Android 11+ `modules/media-store-actions` trash request; never add a permanent-delete fallback. Settings are key/value rows parsed with fallback-to-default (pattern: `comparePrefs.ts` / `accentTheme.ts`).

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
| dailyGoal.ts / groupingPrefs.ts      | m0.8 gate 4 (pure): presentational daily goal (chips, ring progress, goal-reached streaks) / 5-step grouping strictness → engine baseThreshold |
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

Home (goal ring + streaks + continue-reviewing over live queue counts, scan-status line with corpus stats + reclaimable estimate, queue cards, gate-5 day layout: 3 recent days + 2 older unreviewed + expandable older-days indicator, History/Settings title-row icons, edit detection on focus, scan kick once permission lands) · Groups (the review queue: group cards + singles bucket, whole-card navigation, decision badges) · Deck/Singles (one scrollable review deck over the DB-backed groups; gate 5: culled photos stay badged in the live deck and feed — Cull re-tap un-culls, no undo banner; big three Keep/Compare/Cull + queue row Edit·Favourite·Organize·Share, singles auto-advance, automatic next-group advance, pinch-zoom overlay with double-tap reset, Compare-with picker over alive photos, inline organize album picker, time-attached badge; completed groups — even out-of-queue via `loadGroup` — reopen in browse/re-decide mode, where a stage tap opens the standard viewer) · Compare (A/B flip, sync zoom + double-tap reset, group/singles labels, verdicts) · CullList (the durable GLOBAL cull queue, re-decide/restore, confirm → ReviewContext.confirmStagedCulls loops the trash-attempt lifecycle in bounded batches) · EditQueue (two buttons: write-request-first "Edit here" + read-only "View only"; matrix via failure alert) · FavouritesQueue (verified one-transaction batched gallery apply/remove) · ShareQueue (multi-pass grid, ✓ pass badges, labels, explicit clear) · OrganizeQueue (targets, batched verified moves) · History (two-stream keyset feed: photo decisions + share events; tap a photo row → PhotoViewer) · Summary (daily + lifetime stats, goal-based streaks) · Progress/DayProgress (state browsing; DayProgress also lists the day's groups — completed included — reopening the deck in browse mode) · Settings (source, accent, reset confirmations, about) · SourcePicker (saves trigger a rescan). Components: PhotoViewer (m0.8 gate 5 — THE standard full-screen viewer: paging, pinch-zoom, per-photo decision-detail panel incl. time-attached/superseded-organize facts, hosts the state editor; used by deck browse, progress grids, History, and all queue screens — share via long-press), DecisionBadge (incl. gate-5 `time` kind), GoalRing, ReDecideSheet, BigButton, StateProgressBar, EditDiagnosticsSheet (gate-0 matrix driver), progress/* (grid, view, state editor, stateMeta).

## Verify

`npm run typecheck -w afterglow-companion`; `npm test -w afterglow-companion`; bundle proof `npx expo export --platform android` (from apps/mobile); native proof `npx expo prebuild --platform android --clean --no-install && cd android && ./gradlew :app:assembleDebug`. Device/emulator workflow + gesture checks: docs/DEVELOPMENT.md; on-device/Samsung acceptance checklist lives in the current release plan's gates (docs/Plan_<version>.md). Release APK: `cd android && ./gradlew assembleRelease` (debug-keystore signed — do not change signing).
