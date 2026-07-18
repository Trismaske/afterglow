# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code. (SDK 57 / RN 0.86 / React 19.2; `expo-media-library/legacy` is used deliberately.)

# Afterglow Companion — map

Expo dev-client Android app (Expo Go won't do — media permissions + local module). `App.tsx` → SQLiteProvider → ThemeProvider (`theme.tsx`) → React Navigation stack (`navigation.ts` = route param types). **Run every `npx expo`/gradle command from `apps/mobile`**; `android/` is gitignored prebuild output (`npx expo prebuild --platform android`), versions live in `app.json` (`version`, `android.versionCode`).

## State model (the thing to understand first)

Core `DeckSession` (see packages/core/CLAUDE.md) holds the in-flight review; `session/SessionContext.tsx` wraps it (start/resume/redecide/banking) and persists snapshots + per-photo states + duels to SQLite via `db/store.ts` — **SQLite is the durable truth**, snapshots are disposable. `to_edit`/`done` are app-side SQLite states layered over core's `kept`. Decisions are reversible until the cull-list confirm; the only delete path is `MediaLibrary.deleteAssetsAsync` behind that confirm. Settings are key/value rows parsed with fallback-to-default (pattern: `similarityPrefs.ts` / `sessionPrefs.ts` / `comparePrefs.ts` / `accentTheme.ts`).

## src/lib/ (pure logic is unit-tested; impure partner files do the platform I/O)

| File(s) | Contents |
|---|---|
| media.ts | MediaStore → core `MediaItem` adapter (legacy API, paged range queries, asc/desc) |
| reviewLoader.ts | Session draw: prefs-driven cap/order/don't-split-groups; returns chronological photos |
| sessionPrefs.ts / sessionSelect.ts | Sessions settings parsing / pure cap+order+group-boundary selection |
| scopes.ts / scopeStore.ts | Default review-scope defs / store-backed named custom scopes (enable/disable/delete/reset) |
| similarityPrefs.ts | Similarity chips 12/16/20/26/32 (default 20), 0–64 threshold, labels |
| similarityHashes.ts / dhashDecode.ts | dHash pipeline: expo-image-manipulator shrink (impure) / decode→luma→hash (pure) |
| edit.ts / editFallback.ts | ACTION_EDIT launch (impure) / EDIT→VIEW fallback chain + copy (pure) |
| detect.ts / editDetection.ts | Edit detection on Home focus (MediaStore+SQLite wiring) / pure decision heuristics |
| sources.ts / sourceCatalog.ts | Photo-source folder targeting (pure) / MediaStore album catalog + persisted selection |
| dates.ts | Day/range scope date math, local time |
| progress.ts / progressPager.ts | Progress screens logic / newest-first k-way merged pager |
| hash.ts | Lazy content-hash fallback identity (only for staged culls) |
| comparePrefs.ts | "Don't ask again" compare-cull confirmation flag |
| accentTheme.ts | Accent setting + token derivation (Material You via modules/material-you-accent) |
| format.ts / toast.ts | Bytes/labels formatting; ToastAndroid wrapper |

## src/screens/ + components/

Home (scope chips, session start/replace dialog, progress entry) · Groups (group list, open any group, re-decide, End-session-&-apply) · Deck (swipe deck per group, pinch-zoom overlay, Compare-with picker) · Compare (A/B flip, sync zoom, group-number labels, better/cull verdicts) · Singles (swipe keep/toss/to-edit) · CullList (staged culls, re-decide, confirm → system trash) · Reconsider (compare-loss hints) · EditQueue (to-edit list, ACTION_EDIT + viewer fallback) · Summary · Progress/DayProgress (state browsing) · Settings (source, similarity chips+slider, Sessions section, scope manager, accent, reset confirmations) · SourcePicker. Components: ReDecideSheet, FineSlider, BigButton, StateProgressBar, progress/* (grid, view, state editor, stateMeta).

## Verify

`npm run typecheck -w afterglow-companion`; `npm test -w afterglow-companion`; bundle proof `npx expo export --platform android` (from apps/mobile). Device/emulator workflow + gesture checks: docs/DEVELOPMENT.md; on-device checklist lives in docs/assumptions-mobile.md (m0.5 section). Release APK: `cd android && ./gradlew assembleRelease` (debug-keystore signed — do not change signing).
