# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before you write any code.
(SDK 57 / RN 0.86 / React 19.2. `expo-media-library/legacy` is deliberate.)

# Afterglow for Android — map

Expo dev-client Android app (Expo Go does not work: media permissions + local modules).
**Run every `npx expo`/gradle command from `apps/mobile`.**
`android/` is gitignored prebuild output (`npx expo prebuild --platform android`).
Versions live in `app.json` (`version`, `android.versionCode`).
SDK pins (`app.json` → `expo-build-properties`: minSdk 30, compileSdk 36, targetSdk 36): minSdk is the lowest API the feature set works on AND we can test, targetSdk the highest API a release build actually ran on. Floor, span, ceiling, each with a device behind it.
Never lower targetSdk below 30 (it re-arms the plugin-injected `requestLegacyExternalStorage`) or below 34 (selected-photos access changes shape).
Revisit the pin block on EVERY Expo major upgrade: `expo-build-properties` errors only when Expo's minimum overtakes a pin, never when Expo's default moves past a still-legal one.

`App.tsx` → SQLiteProvider → ThemeProvider (`theme.tsx`) → ReviewProvider → React Navigation stack over bottom tabs.
`navigation.ts` holds the route param types.
Tabs: **Edit · Favourite · Home · Organize · Share**, count-badged, Home as the raised center circle (`components/MainTabBar.tsx`).
`backBehavior="initialRoute"` makes Android back always exit THROUGH Home, never a queue tab (m0.8.2, F1).
The bar exists only on those five surfaces.
Full-screen review lives in the parent stack.

**File headers are the documentation.**
This map only routes: the tables name each file's role, and the owning file's header or function docs carry the rules, invariants, and rationale.
Read the header before the body.

## The state model

**Read [docs/STATE_MODEL.md](../../docs/STATE_MODEL.md) FIRST**: one verdict per photo, any number of independent actions in `photo_actions`, annotations that are never states.
SQLite is the ONLY review state (sessions are gone).
The continuous scan (`scan/scanRunner.ts`, its header is the scan contract) lands groups in the durable tables.
`review/ReviewContext.tsx` (its header is the decision-write contract) reads the queue and writes verdicts.
Queue membership, `leaveQueue`, and `resolved_at` permanence: `db/actions.ts`.
The trash-attempt lifecycle: `db/trashStore.ts` + `lib/trashFlow.ts`.
Both removal affordances use the local `modules/media-store-actions` trash request.
**Never add a permanent-delete fallback.**
**`WRITE_EXTERNAL_STORAGE` in app.json is LOAD-BEARING — never remove it** (`lib/media.ts` header).

## src/lib/ (pure logic is unit-tested; impure partner files do the platform I/O)

| File(s)                                                | Role                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| media.ts                                               | MediaStore → core `MediaItem` adapter, the app's ONE trash wrapper, volume-qualified ingestion |
| mediaIdentity.ts                                       | Canonical `<volume>/<rawId>` photo ids, uri-path → volume parse                               |
| mountedVolumes.ts                                      | Burst-cached mounted-volume set: "reachability is scope, not state"                           |
| volumeScan.ts                                          | Per-volume scan-contract math: baselines, tripwires, invariants                               |
| scanWindows.ts                                         | Merge-window accumulator                                                                      |
| deltaScan.ts                                           | Delta-scan range derivation + the delta-vs-full cost model                                    |
| scanSkip.ts                                            | Unchanged-library scan-skip fingerprint                                                       |
| embeddings.ts                                          | Embedding + dHash backfill (impure) over modules/image-embedder                               |
| dates.ts                                               | Day math, `UNDATED_DAY_KEY`, the EXIF date rescue's pure half                                 |
| detect.ts / editDetection.ts                           | Edit detection on Home focus: impure wiring / pure heuristics                                 |
| edit.ts / editActions.ts                               | Editor + viewer launches / intent constants + copy                                            |
| editMatrix.ts                                          | Gate-0 editor-launch diagnostic matrix                                                        |
| favourites.ts / favouriteState.ts                      | Batched native favourite apply + verification / intent transitions + badge weights            |
| organizeFailures.ts                                    | Organize-failure classification: three tiers, from facts we own                               |
| sources.ts / sourceCatalog.ts                          | Volume-qualified source roots / the native album catalog                                      |
| timeline.ts                                            | The merged review timeline: units, truncation, pending-only routing                           |
| deckUnit.ts                                            | The deck's unit identity + the Deck route's param round trip (L4)                             |
| progress.ts / progressPager.ts                         | Progress/state-bar logic + `groupedUnderlineRuns` / newest-first k-way merged pager           |
| reviewPatch.ts                                         | Optimistic queue patches, SQL-parity tested                                                   |
| photoBadges.ts                                         | The badge set a photo wears, each action at a live or carried weight                          |
| dailyGoal.ts / coverageGoal.ts / groupingPrefs.ts      | The count goal / the independent coverage goal / grouping strictness                          |
| stats.ts / statsLoad.ts                                | Stats chart geometry / ONE loader per Stats tab                                               |
| habits.ts / habitsCopy.ts                              | The Habits tab's descriptive math / its sentences                                             |
| libraryInsights.ts                                     | The Progress page's math: capture histogram, frontier, storage, burst tax                     |
| forecast.ts / forecastCopy.ts                          | The forward-looking math, refusals included / every sentence the forecast may say             |
| comparePrefs.ts / zoomTarget.ts                        | Tri-state duel preference / double-tap zoom math (impure partner: `components/useDoubleTapZoom`) |
| stripScroll.ts                                         | Keeping the deck's thumbnail strip on the current photo (F7)                                  |
| diagLog.ts / diagShape.ts                              | On-device diagnostics: the console/crash hook wiring / its pure line shaping + suppressor     |
| hash.ts / concurrency.ts / format.ts / toast.ts / accentTheme.ts | Content-hash fallback id, bounded-parallel map, formatting, toasts, accent tokens   |

`src/db/`: `database.ts` (schema + the fresh-baseline destructive reset), `store.ts` (verdict writes + queue reads), `actions.ts` (the one four-action queue shape), `trashStore.ts`, `shareStore.ts`, `organizeStore.ts`, `embeddingStore.ts` (the model-SHA pin), `volumeLifecycle.ts` ("Forget this card").
`src/scan/scanRunner.ts` is the continuous-scan orchestrator.
Its header carries the whole scan contract: pipeline, unchanged-library skip, delta scan, per-volume rules, and the D15 EXIF date rescue.
`modules/`: media-store-actions (trash/favourite/write requests, gate-0 probes, the EXIF header read), image-embedder (MediaPipe MobileNetV3-large, pinned `MODEL_SHA256`), material-you-accent, diag-log (the rotating on-device diagnostics sink).

## Gestures: virtual detectors only (Gesture Handler 3)

Use the hook API (`usePinchGesture`/`usePanGesture`/`useTapGesture`/`useNativeGesture`, composed with `useSimultaneousGestures`).
The `Gesture.X()` builder is deprecated in v3, and cross-component relations are config fields (`simultaneousWith`, `requireToFail`).
**Never use the plain `GestureDetector` in this app.**
In v3 it is a HOST component, and both review surfaces put something under it that cannot survive an inserted host view (the pager's native scroll, the zoom overlay's animated `pointerEvents`).
Wrap each stage in ONE `InterceptingGestureDetector` with no gesture of its own, and attach every gesture through a `VirtualGestureDetector`.
**Write gesture callbacks INLINE in the config object.**
An extracted or memoized callback silently becomes a JS-thread callback: that is the SIGSEGV documented at the top of `screens/DeckScreen.tsx`, whose header also holds the full detector rationale.

## src/screens/ + components/

One line each.
The screen file's header is the contract.

- **Home**: goal ring + streaks, the forecast-headline Progress row, day sections, scan status, unreachable-volume banners.
- **Timeline** (`TimelineScreen.tsx`): the merged timeline of unit cards, three filters (m0.8.6, F2) — Unfinished (the pending feed), Everything (a separate DB-paged browse read), Unreviewed only (a display subset). The last filter choice is remembered.
- **Deck** (`DeckScreen.tsx`): ONE unified deck over groups and day-scoped singles runs, on ONE route. The unit is state and advances in place (m0.8.5, L4) — the SCREEN and its chrome never remount per unit, while the pager FlatList is deliberately keyed per unit: a reused native scroll view carries offsets and momentum no event reliably reports, and discarding it with the unit is what keeps the stage, badge and controls in agreement.
- **Compare**: A/B flip with synchronized zoom. Whole-table duels decide, all others triage.
- **CullList**: the durable global cull queue. Confirm loops the trash-attempt lifecycle.
- **EditQueue / FavouritesQueue / ShareQueue / OrganizeQueue**: the four action queues (the M5 rule governs bulk writes).
- **History**: the two-stream keyset feed.
- **Stats**: Activity · Forecast · Habits, one loader per tab.
- **Summary**: daily + lifetime stats, goal-based streaks.
- **Progress/DayProgress**: one shared `ProgressView` over a `{kind:'library'}` or `{kind:'day'}` target.
- **Settings**: source, goals, accent, the Library scan row, forget-card, resets.
- **SourcePicker**: volume-tagged rows. Saves trigger a rescan.

Components: `MainTabBar`, `ActionChip`, `DiagErrorBoundary`, `Ghost`, `GoalCelebration`, `AlbumPicker`, `QueueGrid` (the shared selection language), `UnitCard`, `QueueViewer` + `useQueueRows` (the queue-screen shell), `useDoubleTapZoom`, `useExternalRefresh` (foreground + volume-mount reloads), `PhotoViewer` (THE standard viewer, hosts the state editor), `DecisionBadge` + `BadgeCluster`, `GoalRing`, `ReDecideSheet`, `BigButton`, `StateProgressBar`, `EditDiagnosticsSheet`, `progress/*`.

## Verify

`npm run typecheck -w afterglow-companion`.
`npm test -w afterglow-companion`.
Bundle proof: `npx expo export --platform android` (from apps/mobile).
Native proof: `npx expo prebuild --platform android --clean --no-install && cd android && ./gradlew :app:assembleDebug`.
Field diagnostics, ON IN EVERY BUILD until v1: `[scan] done|delta done|library unchanged`, plus `[scan] delta: … cost N vs budget M` (the delta-vs-full decision), the count-tripwire lines (plain `console.log`), and the `[perf]` lines (`source catalog`, `first queue refresh`, `stats tab …`, via `lib/perfLog.ts`; the timeline per-page timing aggregates per session).
Every console line ALSO persists to the on-device rotating sink (m0.8.7, `lib/diagLog.ts` over `modules/diag-log`): 50 MB as ten 5 MB segments under the app's external-files `diag/` dir, pullable with `adb pull /sdcard/Android/data/<pkg>/files/diag`.
Console IS the diagnostics API — faults and timings only, never user behavior; a global error hook and the provider-stack `DiagErrorBoundary` record crashes that used to vanish.
m0.8.2 ungated the `[perf]` lines: every on-device pass runs a RELEASE build (the UI gate needs one), and a timing from a dev bundle is not a claim about the app, so dev-only tripwires were armed in the build nobody ships.
v1 re-gates or adds a Settings toggle (docs/TODO.md, "Re-gate the `[perf]` logs at v1").
Pre-release UI gate: `node scripts/mobile-ui-gate.mjs` against an installed RELEASE build on a test device (docs/MOBILE_UI_GATE.md).
The gate relaunches the app through the launcher intent, which a dev-client build answers with its "connect to a server" screen, so every step fails.
Device/emulator workflow + gesture checks: docs/DEVELOPMENT.md.
The standing human acceptance pass (frame-level latency, the OS consent flows the gate cannot drive, and visual taste) lives in docs/MOBILE_UI_GATE.md.
A release-specific gate list belongs in that release's plan when one exists.
Release APK: `cd android && ./gradlew assembleRelease` (debug-keystore signed, do not change signing).
