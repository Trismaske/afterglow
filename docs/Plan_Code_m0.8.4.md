# m0.8.4 — code checklist

Companion to [Plan_m0.8.4.md](Plan_m0.8.4.md), which carries the reasoning and the spike evidence. This file is the action list only.

**Line numbers are as of the pre-implementation tree** (`initial` @ `3c72c14` plus this session's `media.ts` / `AGENTS.md` doc edits).
They are **HEAD-relative and do not compose**: within one file, work bottom-up or re-read after each edit.

Verbs: `DEL` remove · `ADD` insert · `MOD` change in place.

---

## Phase 1 — the floor

- ADD `apps/mobile/package.json:31-34` — `expo-build-properties: ~57.0.8` to `devDependencies` (`npm install -w afterglow-companion -D`).
- ADD `apps/mobile/app.json:32` — `["expo-build-properties", { "android": { "minSdkVersion": 30, "compileSdkVersion": 36, "targetSdkVersion": 36 } }]` to `expo.plugins`.

Permissions are **unchanged**. `WRITE_EXTERNAL_STORAGE` (`app.json:24`) is load-bearing below API 33 — removing it stops every read on Android 11/12.

## Phase 2 — Kotlin

`modules/media-store-actions/android/src/main/java/expo/modules/mediastoreactions/MediaStoreActionsModule.kt`

- MOD `192-207` — unwrap the `SDK_INT >= R` guard around the `mediaGenerations` loop.
- DEL `231-233` — `mediaChangedSince` API-30 early throw.
- MOD `289-297` — rewrite the `listMountedVolumes` doc: drop the API 24-28 arm and the UUID throw it describes.
- MOD `301-319` — keep `MediaStore.getExternalVolumeNames(context)`; drop the ternary and the `StorageManager` else-arm.
- DEL `336-338` — `countImagesByVolume` API-29 early throw.
- MOD `363-367` — collapse the volume-set ternary to `getExternalVolumeNames(context)`.
- DEL `504-508` — `moveToRelativePath` "Requires Android 11" early return.
- DEL `651-653` — `launch()` early return.
- DEL `676` — `mediaPresenceOf` early return.
- DEL `706` — `queryFlag` early return.
- KEEP `127` (`sdkInt` is a reported field) and `667` (`SDK_INT >= 33` picks the read permission).

`modules/media-store-actions/android/.../MediaStoreActionContract.kt`

- DEL `37` — `@RequiresApi(Build.VERSION_CODES.R)`.
- DEL `13` — `import androidx.annotation.RequiresApi`.
- DEL `8` — `import android.os.Build` (orphaned by the above).

`modules/image-embedder/android/src/main/java/expo/modules/imageembedder/ImageEmbedderModule.kt`

- MOD `75-116` — drop the `SDK_INT >= P` wrapper and the whole API 24-27 `BitmapFactory` + EXIF-rotation arm (`84-116`); the `ImageDecoder` body becomes the function.
- DEL `4, 6, 8, 11` — `BitmapFactory`, `Matrix`, `Build`, `ExifInterface` imports.
- KEEP `android.graphics.Bitmap` — return type of `decode`/`decodeInner`, parameter of `dhashOf`.

`modules/image-embedder/android/build.gradle`

- DEL `59-60` — both duplicate `androidx.exifinterface:exifinterface:1.3.7` lines.
- KEEP `media-store-actions/android/build.gradle:24` — its own `exifinterface` is live for D15.

`MaterialYouAccentModule.kt` — untouched (API 31 is inside the floor).

## Phase 3 — TS module boundary

`apps/mobile/modules/media-store-actions/index.ts`

- MOD `117` — `available()` → `Platform.OS === 'android' && native != null`.
- DEL `259-265` — `imageDetailsAvailable` and its doc.
- DEL `304-310` — `exifReadAvailable` and its doc.
- MOD `165-167` — `diagnosticsAvailable` now duplicates `available()`; keep one, repoint callers.
- MOD `268` — doc references `imageDetailsAvailable()`.
- MOD `284` — `'Requires Android 11'` → name the missing module.

`apps/mobile/src/lib/media.ts`

- MOD `27` — drop the `imageDetailsAvailable` import.
- MOD `307` — gate on `mediaStoreActionsAvailable()`.
- MOD `418-420` — drop the "Below Android 10 … one Platform check" sentences.
- DEL `427-428` — `LEGACY_MERGED_COLLECTION`.
- MOD `435` — `canonicalContentUri(assetId)`.

`apps/mobile/src/scan/scanRunner.ts`

- MOD `48, 1057` — `exifReadAvailable` → `mediaStoreActionsAvailable`.

`apps/mobile/src/lib/mediaIdentity.ts`

- DEL `59-65` — the `legacyMergedCollection` doc paragraph.
- MOD `67-68` — drop the parameter; volume always from the canonical id.
- MOD `25` — the comment cites "STORAGE_PREFIX variants in sources.ts", which phase 4 deletes.

`apps/mobile/src/lib/mediaIdentity.test.ts`

- DEL `93-104` — the legacy merged-authority case.

## Phase 4 — catalog fallback + sweep

`apps/mobile/src/lib/sourceCatalog.ts`

- DEL `185-254` — the `MediaLibrary.getAlbumsAsync` probe fallback.
- ADD `~184` — throw a named error when the module is absent (never return an empty catalog: it silently broadens scope to all folders).
- DEL `13` — `import * as MediaLibrary`.
- DEL `30` — the `sourceDirOfUri` import.
- MOD `6-10` — header describes the deleted fallback.

`apps/mobile/src/lib/sources.ts`

- DEL `134-137` — `sourceDirOfUri`.
- DEL `108-114` — `dirOfUri`.
- DEL `128-131` — `storageRelativeDir`.
- DEL `120-121` — `STORAGE_PREFIX`.
- KEEP `foldAlbumsToDirs` — folds `relativePath` directly, untouched.

`apps/mobile/src/lib/sources.test.ts`

- DEL `61-105` — the `dirOfUri` / `storageRelativeDir` / `sourceDirOfUri` describes (8 cases).
- MOD `3, 14, 17` — drop those imports.

`apps/mobile/src/screens/SourcePickerScreen.tsx`

- MOD `367-369` — failure copy hardcodes "an album was unreadable"; report the actual error.

## Phase 5 — screens and copy

- DEL `apps/mobile/src/screens/CullListScreen.tsx:50` — `systemTrashSupported`.
- MOD `apps/mobile/src/screens/CullListScreen.tsx:123` — alert body → media module unavailable, culls still staged.
- DEL `apps/mobile/src/screens/CullListScreen.tsx:208` — the `!systemTrashSupported` subtitle branch.
- MOD `apps/mobile/src/screens/CullListScreen.tsx:23` — header comment's "on Android 11+".
- DEL `apps/mobile/src/screens/FavouritesQueueScreen.tsx:71` — `supported`.
- MOD `apps/mobile/src/screens/FavouritesQueueScreen.tsx:129` — alert body → media module unavailable, hearts still queued.
- DEL `apps/mobile/src/screens/FavouritesQueueScreen.tsx:155` — the `!supported` banner.
- MOD `apps/mobile/src/screens/HomeScreen.tsx:459` — alert body, same wording as CullList.
- MOD `apps/mobile/src/screens/CompareScreen.tsx:709` — unwrap; favourite chip renders unconditionally.
- MOD `apps/mobile/src/screens/DeckScreen.tsx:846` — drop the version test from the best-of-group favourite offer.
- MOD `apps/mobile/src/screens/DeckScreen.tsx:1205` — unwrap the favourite chip.
- MOD `apps/mobile/src/screens/DeckScreen.tsx:1312` — unwrap the favourite chip.

## Phase 6 — the year in day labels (only user-visible change)

- MOD `apps/mobile/src/lib/dates.ts:91` — add `year: 'numeric'` to `DAY_FORMAT`.
- ADD `apps/mobile/src/lib/dates.test.ts` — first tests for `labelForDayKey`: year on a past-year day, year on a current-year day, `Today` / `Yesterday` / `Unknown day` unchanged.
- MOD `apps/mobile/src/lib/dates.ts:93` — `formatDay` has no external caller; may become private.

## Phase 7 — release plumbing and docs

- ADD `scripts/release-preflight.mjs:~35` — assert `expo-build-properties` present with `minSdkVersion >= 30` (patch: `spike-d-floor-assertions.patch`).
- ADD `.github/workflows/mobile-release.yml:~70` — `aapt dump badging` step asserting `sdkVersion:'30'`, between "Build release APK" and "Name and verify the APK".
- MOD `apps/mobile/app.json:5,21` — `version` → `0.8.4`, `versionCode` → `11`.
- MOD `apps/mobile/package.json:3` — `version` → `0.8.4`.
- MOD `PLAN.md:99` — trash invariant unconditional (exact wording: Plan §7.1).
- MOD `PLAN.md:178-179` — m0.8.4 entry → settled floor, mechanism, scope.
- MOD `apps/mobile/README.md:187` — add "requires Android 11 or later" on the download path.
- MOD `apps/mobile/README.md:234-236` — trash wording (exact: Plan §7.1).
- MOD `apps/mobile/README.md:313` — drop "Android 11+".
- MOD `apps/mobile/AGENTS.md:13, 113` — drop "Android 11+".
- MOD `apps/mobile/AGENTS.md:68` — keep the explanation, drop the version prefix.
- MOD `CLAUDE.md:30` — drop "Android 11+".
- MOD `MediaStoreActionsModule.kt:163` — drop "(Android 11+)" from the createWriteRequest comment.
- MOD `MediaStoreActionContract.kt:42-44` — drop "the documented Android 11+ mechanism".
- KEEP `mediaGenerations`' "(API 30+)" — a fact about MediaStore, not a hedge about us.
- MOD `apps/mobile/AGENTS.md` — `sources.ts / sourceCatalog.ts` and `media-store-actions` map rows describe deleted paths.

## Gates

- `npm run typecheck -w afterglow-companion` · `npm run lint` · `npm run format:check`
- `npm test -w afterglow-companion` → **705 tests / 46 files** (714 − 8 from `sources.test.ts` − 1 from `mediaIdentity.test.ts`), plus whatever phase 6 adds. A **changed assertion** is stop-and-investigate; a changed argument literal is not.
- `npx expo export --platform android` (from `apps/mobile`)
- `npx expo prebuild --platform android --clean --no-install && cd android && ./gradlew assembleRelease` (from `apps/mobile`) — `lintVitalRelease` must be clean with zero `NewApi`.
- `aapt dump badging <apk>` → `sdkVersion:'30'`, `targetSdkVersion:'36'`
- Devices: S10e API 31 (mount eject/remount, delta, trash, favourite, organize, both volumes in the picker), S23 API 36, emulator `afterglow-api30`, install refusal on `afterglow-api29`.
- `node scripts/mobile-ui-gate.mjs` (repo root) against a release build.

## Patches available

`spike-c-kotlin-deletions.patch` (phases 1-2) · `spike-b-delete-catalog-fallback.patch` (phase 4) · `spike-a-delete-editable-uri.mine-only.patch` (below) · `spike-d-floor-assertions.patch` (phase 7).

## Also in scope — vestigial `EditableContentUri` (Plan §4.7, measured −19)

- DEL `apps/mobile/src/lib/media.ts:422-425` — the `EditableContentUri` interface.
- DEL `apps/mobile/src/lib/media.ts:430-432` — `getEditableContentUriDetailed`.
- MOD `apps/mobile/src/lib/editMatrix.ts:44-47` — `MatrixUriInfo` collapses; `formatMatrixReport` takes the uri string.
- MOD `apps/mobile/src/lib/editMatrix.ts:109` — signature.
- MOD `apps/mobile/src/lib/editMatrix.test.ts:69, 82, 89` — argument literals only, no assertion changes.
- MOD `apps/mobile/src/components/EditDiagnosticsSheet.tsx:20, 28, 53, 63, 126` — use `getEditableContentUri`, hold a `string`.
- KEEP `editMatrix.ts:114` — the provenance line is a hardcoded literal, which is why `source` had zero readers.

## Explicitly NOT in scope

- `WRITE_EXTERNAL_STORAGE` — measured load-bearing (Plan §4.6).
- The `async` on `getEditableContentUri` — vestigial, 6 call sites, no gain.
- `mediaIdentity.ts:36` STORAGE_PREFIX aliases — defensive path parsing, not a version gate.
- `requestLegacyExternalStorage` — plugin-owned, inert while `targetSdk ≥ 30`.
- The rescued-date defect — `docs/Feedback_m0.8.x.md` (m0.8.6), "A D15-rescued photo's date does not reach the Progress library scope".
