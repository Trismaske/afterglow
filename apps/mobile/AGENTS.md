# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code. (SDK 57 / RN 0.86 / React 19.2; `expo-media-library/legacy` is used deliberately.)

# Afterglow Companion — map

Expo dev-client Android app (Expo Go won't do — media permissions + local module). `App.tsx` → SQLiteProvider → ThemeProvider (`theme.tsx`) → React Navigation stack (`navigation.ts` = route param types). **Run every `npx expo`/gradle command from `apps/mobile`**; `android/` is gitignored prebuild output (`npx expo prebuild --platform android`), versions live in `app.json` (`version`, `android.versionCode`).

## State model (the thing to understand first)

Core `DeckSession` (see packages/core/CLAUDE.md) holds the in-flight review; `session/SessionContext.tsx` wraps it (start/resume/redecide/banking) and persists captured snapshots + per-photo states + duels through a FIFO retry barrier to SQLite via `db/store.ts` — **SQLite is the durable truth**, snapshots are disposable. `to_edit`/`done` are app-side SQLite states layered over core's `kept`. Active Keep/To edit/Cull tapped again always clears to unreviewed. m0.7: photo ids are canonical volume-qualified keys (`lib/mediaIdentity.ts`); the schema is a **fresh baseline** with destructive reset between 0.x versions (`db/database.ts`); session replacement is one atomic transaction with the **carry policy** (staged culls survive in the durable global cull queue — `db/store.ts replaceActiveSession` / `getStagedCulls`); trash runs through the durable attempt lifecycle (`db/trashStore.ts`: prepare/reserve → launching → tri-state verify, at-most-once credit); share (`db/shareStore.ts`: cycles, sheet-opened passes) and organize (`db/organizeStore.ts`: validated primary-only targets, verified RELATIVE_PATH moves) are durable queues. Both removal affordances use the local Android 11+ `modules/media-store-actions` trash request; never add a permanent-delete fallback. The same module owns batched favourite/unfavourite requests. Settings are key/value rows parsed with fallback-to-default (pattern: `similarityPrefs.ts` / `sessionPrefs.ts` / `comparePrefs.ts` / `accentTheme.ts`).

## src/lib/ (pure logic is unit-tested; impure partner files do the platform I/O)

| File(s)                              | Contents                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| media.ts / recentMedia.ts            | MediaStore → core `MediaItem` adapter, one ranged recent-days scan, and the single recoverable-trash wrapper |
| favourites.ts / favouriteState.ts    | Batched native favourite/unfavourite action + `IS_FAVORITE` verification / pure durable intent transitions   |
| reviewLoader.ts                      | Session draw: prefs-driven cap/order/don't-split-groups; returns chronological photos                        |
| sessionPrefs.ts / sessionSelect.ts   | Sessions settings parsing / pure cap+order+group-boundary selection                                          |
| scopes.ts / scopeStore.ts            | Default review-scope defs / store-backed named custom scopes (enable/disable/delete/reset)                   |
| similarityPrefs.ts                   | Similarity chips 12/16/20/26/32 (default 20), 0–64 threshold, labels                                         |
| similarityHashes.ts / dhashDecode.ts | dHash pipeline: expo-image-manipulator shrink (impure) / decode→luma→hash (pure)                             |
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

`session/persistenceQueue.ts` is the pure, failure-injected FIFO barrier used
by SessionContext. `modules/media-store-actions` is the Android 11+ native
trash/favourite boundary plus the gate-0 editor-launch diagnostics
(environment/permission probes, intent dispatch probes, `createWriteRequest`);
`modules/material-you-accent` reads the system tone.

## src/screens/ + components/

Home (scope chips, silent session start/replace, queue cards: edit/favourite/share/organize/History) · Groups (whole-card navigation, decision badges, End-session-&-apply) · Deck/Singles (one scrollable review deck, big three Keep/Compare/Cull + queue row Edit·Favourite·Organize·Share, singles auto-advance, automatic next-group advance, pinch-zoom overlay with double-tap reset, Compare-with picker, inline organize album picker) · Compare (A/B flip, sync zoom + double-tap reset, group/singles labels, verdicts) · CullList (the durable GLOBAL cull queue incl. carried culls, re-decide/restore, confirm → trash-attempt lifecycle) · EditQueue (two buttons: write-request-first Edit + read-only Gallery; matrix via failure alert) · FavouritesQueue (verified one-transaction batched gallery apply/remove) · ShareQueue (multi-pass grid, ✓ pass badges, labels, explicit clear) · OrganizeQueue (targets, batched verified moves) · History (activity_at keyset feed + share events) · Summary (session + lifetime stats) · Progress/DayProgress (state browsing) · Settings (source, similarity chips+slider, Sessions section, scope manager, accent, reset confirmations) · SourcePicker. Components: DecisionBadge, ReDecideSheet, FineSlider, BigButton, StateProgressBar, EditDiagnosticsSheet (gate-0 matrix driver), progress/* (grid, view, state editor, stateMeta).

## Verify

`npm run typecheck -w afterglow-companion`; `npm test -w afterglow-companion`; bundle proof `npx expo export --platform android` (from apps/mobile); native proof `npx expo prebuild --platform android --clean --no-install && cd android && ./gradlew :app:assembleDebug`. Device/emulator workflow + gesture checks: docs/DEVELOPMENT.md; on-device/Samsung acceptance checklist lives in the current release plan's gates (docs/Plan_YYYYMMDD.md). Release APK: `cd android && ./gradlew assembleRelease` (debug-keystore signed — do not change signing).
