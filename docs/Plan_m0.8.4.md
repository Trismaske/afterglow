# m0.8.4 — drop Android ≤ 10

**Status:** decision-complete and spike-verified, not implemented. Every open call was settled in the 2026-07-30/31 grilling (§11 is empty), and every load-bearing claim was measured on the S10e (API 31), the S23 (API 36) and an API 30 emulator rather than reasoned. Ready-to-apply patches for the three biggest pieces are in the session scratchpad.
**Audience:** the implementing agent and Tristan.
**Deliverable:** an APK whose declared floor is Android 11 (API 30), with every branch that existed only to accommodate a lower floor deleted.

This is a deletion release, plus one deliberate exception.
§4 ships no new capability and must ship **no behaviour change** on any device that can install it. §10 — day labels always carrying the year — is the single visible change, admitted on its own merits and kept in its own section so the distinction survives review.

---

## 1. Overview

### What changes

The app declares `minSdkVersion 30`.
Android then refuses to install it below API 30 (`INSTALL_FAILED_OLDER_SDK`), so the floor becomes a platform-enforced fact rather than a claim in a README.

Every branch whose only purpose was to serve a device below that floor is deleted: version gates in TypeScript and Kotlin, the pre-API-30 album-catalog fallback, the pre-API-29 merged-collection URI shape, the API 24–27 bitmap decode fallback, and the helper chain that existed only to feed the catalog fallback.

### What does not change

No behaviour on any Android 11+ device.
Every deleted branch is already on its modern arm at API 30 — verified site by site in §4.
The only path whose behaviour changes is the album catalog on a device with **no native module**, which is a configuration that already cannot scan (§5.2).

`targetSdkVersion` and `compileSdkVersion` do not move — but they are now **pinned** at their current 36 rather than left following Expo's default (D8, §3.1).

Not in scope: the schema, the state model, and every queue. The rescued-date defect found during this release's spikes was deliberately scoped OUT and lives fully designed in `docs/Feedback_m0.8.x.md`, scheduled into m0.8.6 ("A D15-rescued photo's date does not reach the Progress library scope").

One small addition that is **not** legacy removal rides along: day labels always carrying the year (§10). It is one line plus tests for a pure function, it touches nothing §4 touches, and it is what makes the parked defect's eventual fix verifiable by eye.

### Why now

The shipped floor is `minSdkVersion 24` — Expo's default, applied because nothing in the repo sets one (`expo-modules-core/expo-module-gradle-plugin/.../ProjectConfiguration.kt:74`, `?: 24`).

Below Android 11 the product's core loop cannot run.
`modules/media-store-actions` gates its trash request at API 30, so culling, favourites and organize moves are all unavailable; there is no native album catalog, no MediaStore generations (so no unchanged-library skip and no delta scan — a full multi-minute pass on every open), and below API 29 no canonical per-volume content URIs.

So the current floor lets a device install an app that cannot do its job, and the legacy code paths serving that device were never testable: the oldest device Tristan owns is the S10e at API 31.

---

## 2. Agreed decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | The floor | **`minSdkVersion 30`**, verified on an API 30 emulator | 30 is the feature-driven floor — every capability the app needs lands exactly there, so 31 would exclude working devices for nothing. The one-API-level untested band (no hardware below API 31) is closed by adding an API 30 AVD pass to this release's gate, rather than by raising the floor above the honest one. |
| D2 | Mechanism | **`expo-build-properties`** plugin in `apps/mobile/app.json` | The official Expo mechanism; a dev-time dependency with no runtime cost. It writes `android.minSdkVersion=30` into `android/gradle.properties`, which `expo-root-project` feeds to `rootProject.ext.minSdkVersion` — consumed both by `android/app/build.gradle:93` and by every local Expo module (`ProjectConfiguration.kt:74`), so the Kotlin gates become provably dead, not merely unreachable. A hand-rolled ~20-line config plugin was rejected: it saves one dev dependency and costs us ownership of Expo's gradle.properties format at every SDK bump. |
| D8 | The whole SDK envelope | **Pin all three**: `minSdkVersion 30`, `compileSdkVersion 36`, `targetSdkVersion 36` | See §3.1. Nothing in the repo sets any of them today — 36/36 are Expo SDK 57's defaults, which move silently on every `expo` upgrade. Pinning is also what *buys* the upgrade notification (§3.2) and removes three per-build Gradle warnings. |
| D3 | The `expo` album-catalog fallback | **Delete it; the module-absent case throws; the picker's failure copy names the real cause** | At floor 30 the fallback serves only a shell with no native module, which already cannot scan (`getMountedVolumes()` throws at `scanRunner.ts:713`). Throwing is not a new failure path — `resolveSources` already rejects on any unreadable album — and all 17 call sites already fail closed with keep-last (§5.2). Returning an empty catalog was rejected: it would make the default-source probe conclude `DCIM/Camera` is absent and silently broaden scope to every folder, the exact fail-open `sourceCatalog.ts:243-249` exists to prevent. |
| D4 | The `unsupported` status | **Keep the status; retarget the copy** | `MediaStoreActionStatus`'s `unsupported` currently means "pre-Android-11 **or** module missing". At floor 30 only the second half survives, so every string naming Android 11 becomes false and must be rewritten. The status itself stays: it is threaded through the durable trash and organize state machines (`trashStore.ts:403,454,471`, `organizeStore.ts:239`), and the module-absent case is what the documented query-fails-open / scan-fails-closed asymmetry rests on (`mountedVolumes.ts` header). Making the module mandatory via `requireNativeModule` was rejected as a wide refactor of durable state that contradicts that contract. |
| D5 | `MaterialYouAccentModule`'s API 31 gate | **Keep** | Android 11 is inside the new floor and has no `system_accent1_*` resources. The gate is live, not legacy. It returns null and the accent falls back — nothing to fix. |
| D6 | `ImageEmbedderModule`'s API 28 gate | **Delete** | `SDK_INT >= P` is unconditionally true at floor 30, so the API 24–27 `BitmapFactory` arm is dead. It takes the module's `androidx.exifinterface` dependency with it (its only consumer, and currently declared twice). |
| D7 | `android:requestLegacyExternalStorage="true"` | **Leave — conditional on `targetSdkVersion ≥ 30`** | Injected unconditionally by the `expo-media-library` config plugin (`withMediaLibrary.js:17`), so removing it means writing a plugin to fight another plugin. Android honours the attribute **only below `targetSdk` 30**, so at target 36 it is inert. That conditionality is the point: the attribute is dormant, not absent, and lowering `targetSdk` below 30 would re-arm legacy external storage under an architecture that assumes scoped storage. D8 is what keeps it dormant. |

---

## 3. Mechanism: how the floor gets into the APK

`apps/mobile/android` is gitignored prebuild output, so the floor cannot be edited into Gradle — it must come from `app.json`.

Add the dev dependency and the plugin entry:

```jsonc
// apps/mobile/package.json — devDependencies
"expo-build-properties": "~57.0.8"
```

```jsonc
// apps/mobile/app.json — expo.plugins
[
  "expo-build-properties",
  { "android": { "minSdkVersion": 30, "compileSdkVersion": 36, "targetSdkVersion": 36 } }
]
```

### 3.1 Why all three are pinned, and how they differ

| | Controls | In this app |
|---|---|---|
| `minSdkVersion` 30 | The floor — the lowest API the package installer accepts | Blocks install below Android 11 |
| `compileSdkVersion` 36 | Which API symbols exist at compile time. No runtime effect | Lets the native modules reference API 33+ constants |
| `targetSdkVersion` 36 | Which platform behaviour changes apply at runtime; Android shims anything introduced after it | Declares "tested on Android 16" — every restriction up to API 36 applies with no shims |

**The rule this release adopts:** `minSdkVersion` is the lowest API the feature set can work on *and* we can test; `targetSdkVersion` is the highest API we have actually run a release build on.
Both are claims that must be true, which is what §9's gate list exists to make true — API 30 on an emulator (the floor), API 31 on the S10e, API 36 on the S23 (the target). Floor, span, ceiling, each with a device behind it.

Measured 2026-07-30 over wireless ADB: S23 `R5CW20KBA2W` = SM-S918B, Android 16, **API 36**; S10e `RF8M72Q4FGE` = SM-G970F, Android 12, **API 31**.

**`minSdk` and `targetSdk` are not two ends of one squeezable dial.**
Raising `minSdk` deletes things — untestable devices and the code that served them, which is all of m0.8.4.
Lowering `targetSdk` deletes nothing: it asks Android to emulate older behaviour through compatibility shims, which are implicit, OEM-variable, and withdrawn over time. Hidden behaviour would go up, not down.

Two app-specific floors under `targetSdk`, both measured here:

- **Below 30**, `android:requestLegacyExternalStorage="true"` becomes live again (D7) — legacy storage semantics under an architecture built entirely on scoped storage.
- **Below 34**, selected-photos access changes shape. `app.json` declares `READ_MEDIA_VISUAL_USER_SELECTED` and `MediaStoreActionsModule.kt:661-664` reasons about Android 14 access being "granted-but-partial"; `hasFullImagesAccess()` exists only because of it.

Today's effective values are already 36/36, so pinning changes no behaviour. It changes what happens *next time* (§3.2), and it silences three warnings Gradle currently emits on every build — `Property 'minSdkVersion' is not defined. Using default value: '24'`, one per undefined property (`expo-modules-core/.../Warnings.kt`).

### 3.2 What happens on an Expo upgrade

`expo-build-properties@57.0.8` **throws** — it does not warn — when a pinned version falls below Expo's own minimum (`plugin/build/pluginConfig.js:230-270`, message: `` `android.minSdkVersion` needs to be at least version N. ``).
SDK 57's declared minimums are `minSdk 21`, `compileSdk 31`, `targetSdk 31`.
The check runs inside `expo prebuild`, which is a step in `mobile-release.yml` on every tag and runs locally before every native build — so a future Expo SDK raising its minimum past our pin **fails the build**, naming the field and the required version.

That notification exists **only because we pin**. Unpinned there is nothing to compare against: `ProjectConfiguration.kt:72-77` silently substitutes the new default and no error, warning, or diff mentions it.

The gap, stated rather than papered over: this catches Expo's *minimum* overtaking our pin, not Expo's *default* moving ahead of a pin that is still legal (Expo defaulting `targetSdk` to 37 while we sit at 36 throws nothing). No tooling covers that. **Any `expo` major upgrade must revisit this block** — a deliberate step, recorded here because nothing automates it.

### 3.3 The chain

Verified in the installed package and the generated project:

1. `expo-build-properties` writes `android.minSdkVersion=30` into `android/gradle.properties` at prebuild (`plugin/build/android.js:18-22`).
2. `expo-root-project` reads gradle.properties into `rootProject.ext`.
3. `android/app/build.gradle:93` reads `rootProject.ext.minSdkVersion` for the app module.
4. Every local Expo module reads the same value (`ProjectConfiguration.kt:74`), so `media-store-actions`, `image-embedder` and `material-you-accent` all compile at 30.
5. The merged manifest gains `<uses-sdk android:minSdkVersion="30"/>`.

Consequence worth stating: because step 4 raises the modules' own floor, Android Lint stops requiring `@RequiresApi(R)` on `MediaStoreActionContract.createIntent` — the annotation is removed because it is satisfied by the module's floor, not because we suppressed anything.

---

## 4. Deletion scope

Counts and line numbers are measured at `HEAD` on 2026-07-30 and must be re-verified before editing — several are inside comment blocks that move.

### 4.1 TypeScript version gates (9 sites)

| Site | Today | After |
|---|---|---|
| `modules/media-store-actions/index.ts:117` (`available`) | `android && Version >= 30 && native != null` | `android && native != null` |
| `modules/media-store-actions/index.ts:264` (`imageDetailsAvailable`) | `android && Version >= 29 && native != null` | deleted — identical to `available()` |
| `src/lib/media.ts:417` (`LEGACY_MERGED_COLLECTION`) | `android && Version < 29` | deleted |
| `src/screens/CullListScreen.tsx:50` (`systemTrashSupported`) | `android && Version >= 30` | deleted, with the branches it guards |
| `src/screens/FavouritesQueueScreen.tsx:71` (`supported`) | `android && Version >= 30` | deleted, with the banner at `:155` |
| `src/screens/CompareScreen.tsx:709` | wraps the favourite `ActionChip` | chip renders unconditionally |
| `src/screens/DeckScreen.tsx:846` | gates the best-of-group favourite hand-off offer | offer follows `shouldOfferFavouriteHandoff` alone |
| `src/screens/DeckScreen.tsx:1205` | wraps the favourite `ActionChip` (group deck) | chip renders unconditionally |
| `src/screens/DeckScreen.tsx:1312` | wraps the favourite `ActionChip` (singles deck) | chip renders unconditionally |

**The predicate collapse.** With `available()` reduced, it becomes textually identical to `diagnosticsAvailable()`. Four exported capability predicates — `mediaStoreActionsAvailable`, `imageDetailsAvailable`, `exifReadAvailable`, `diagnosticsAvailable` — all reduce to the same expression. Collapse them to one internal `available()` and one export, `mediaStoreActionsAvailable()`, and repoint the three call sites (`media.ts:296`, `media.ts:456`, `scanRunner.ts:1057`).

This also removes a real inconsistency: today `sourceCatalog.buildCatalog` gates on `mediaStoreActionsAvailable()` (version **and** module) while the call it makes, `listImageAlbums()`, gates on `diagnosticsAvailable()` (module only) — so on API 29 the catalog took the slow fallback while the native walk would have answered.

### 4.2 Kotlin version gates

Ten removable sites, all in `modules/media-store-actions/android/.../`:

| Site | Gate | Action |
|---|---|---|
| `MediaStoreActionsModule.kt:192` | `if (SDK_INT >= R)` wrapping the `mediaGenerations` loop | unwrap |
| `MediaStoreActionsModule.kt:231-233` | `mediaChangedSince` early throw | delete |
| `MediaStoreActionsModule.kt:301-319` | `listMountedVolumes` — the API 24–28 `StorageManager` arm | delete the ternary and its else-branch; keep the `MediaStore.getExternalVolumeNames` line |
| `MediaStoreActionsModule.kt:336-338` | `countImagesByVolume` early throw | delete |
| `MediaStoreActionsModule.kt:363-367` | `listImageAlbums` volume-set ternary (`setOf("external")` else-arm) | collapse to `getExternalVolumeNames` |
| `MediaStoreActionsModule.kt:504-508` | `moveToRelativePath` "Requires Android 11" early return | delete |
| `MediaStoreActionsModule.kt:651-653` | `launch()` early return | delete |
| `MediaStoreActionsModule.kt:676` | `mediaPresenceOf` early return | delete |
| `MediaStoreActionsModule.kt:706` | `queryFlag` early return | delete |
| `MediaStoreActionContract.kt:37` | `@RequiresApi(Build.VERSION_CODES.R)` | delete, with the import at `:13` |

Two Kotlin version checks in the same module **stay**:

- `MediaStoreActionsModule.kt:127` — `sdkInt` is a reported *field* of the gate-0 diagnostics, not a gate. It still distinguishes API 30 from 36 and stays useful.
- `MediaStoreActionsModule.kt:667` — `hasFullImagesAccess` picks `READ_MEDIA_IMAGES` at 33+ and `READ_EXTERNAL_STORAGE` below. Android 11 and 12 are inside the new floor, so this is live.

`ImageEmbedderModule.kt:75-116` — delete the API 24–27 `BitmapFactory` + EXIF-rotation arm (~33 lines) and the `if (SDK_INT >= P)` wrapper, leaving the `ImageDecoder` path as the body. Sweep the now-unused `BitmapFactory`, `Matrix`, `ExifInterface` and `Build` imports, and remove `androidx.exifinterface` from `modules/image-embedder/android/build.gradle` — the decode fallback is its only consumer, and it is currently declared on two consecutive lines.

`MaterialYouAccentModule.kt:18` — unchanged (D5).

**The whole of §4.2 is MEASURED, not reasoned** (2026-07-31 spike; patch at `scratchpad/spike-c-kotlin-deletions.patch`, +24/−110 excluding config and lockfile). Gates: typecheck clean, **714/46 unchanged**, lint clean, `assembleRelease` succeeded in 4m19s, `aapt` reported `sdkVersion:'30'`, and `gradle.properties` carried all three pins with **zero** "Property 'minSdkVersion' is not defined" warnings.

**`lintVitalRelease` passes with zero `NewApi` findings across all four modules.** With `@RequiresApi(R)` deleted, that is the direct proof of §3.3's chain — the modules' own floor really is 30, so these branches are provably dead rather than merely unreachable.

Device verification walked the S10e **twice — once before installing, once after** — so every row is a comparison, not an assertion: mount eject/remount and its banner, the generation skip string, per-volume tripwires (including while ejected), the delta pass, the trash dialog, a favourite batch, an organize move, and the folder picker with both volumes tagged. All identical. The after-run additionally culled an **SD-card** photo, so the tripwire tracked `0a91-e18d: 6 → 5` — a stronger cross-volume result than the baseline produced. S23 (API 36) and the API 30 emulator both passed their shorter walks.

One deliberately induced failure confirmed the m0.8.3 contract still holds: remounting the card mid-scan produced `[scan] failed: storage volumes changed mid-scan … pass aborted; the next open rescans`, and the next launch recovered with both volumes tracked.

**Five sweep corrections this measured that the list above did not name:**

1. **`MediaStoreActionContract.kt` strands a second import.** Removing `@RequiresApi` also orphans `import android.os.Build` (`:8`) — nothing else in that file uses `Build`. Both imports go, or Kotlin warns.
2. **Do NOT sweep `Bitmap` from `ImageEmbedderModule.kt`.** `BitmapFactory`, `Matrix`, `ExifInterface` and `Build` all die, but `android.graphics.Bitmap` stays — it is the return type of `decode`/`decodeInner` and the parameter of `dhashOf`. Named because the temptation to over-sweep is real.
3. **Do NOT sweep `androidx.exifinterface` from `media-store-actions`.** Both duplicate lines go from `image-embedder/android/build.gradle`, but `media-store-actions/android/build.gradle` keeps its own `androidx.exifinterface:exifinterface:1.4.1` — still the sole dependency behind D15's `readExifDateTimeOriginal`. Two modules, two declarations, only one is dead.
4. **`listMountedVolumes`' doc comment is part of the deletion.** It describes the API 24-28 `StorageManager` arm and the `IllegalStateException("mounted volume without a UUID")` that lived inside it. Left as-is it would document a throw that no longer exists — review class 41 in miniature. The patch carries rewritten wording.
5. **Nothing else became unused** — repo-wide greps for `StorageManager`, `MEDIA_MOUNTED_READ_ONLY` and `setOf("external")` return nothing outside the deleted code. The one surviving `'external'` is `mediaIdentity.ts:68`, which is §4.4's scope.

### 4.3 The album-catalog fallback and its dead helper chain

Delete `src/lib/sourceCatalog.ts:185-254` (the `MediaLibrary.getAlbumsAsync` probe path), the `MediaLibrary` import, and the header paragraph describing it.
`buildCatalog` becomes: available → native walk; unavailable → throw a named error.

**The sweep this triggers.** The fallback was the sole production caller of a four-link chain in `src/lib/sources.ts`:

| Symbol | Only production caller | After |
|---|---|---|
| `sourceDirOfUri` (`sources.ts:134`) | `sourceCatalog.ts:223` | dead — delete |
| `dirOfUri` (`sources.ts:108`) | `sourceDirOfUri` | dead — delete |
| `storageRelativeDir` (`sources.ts:128`) | `sourceDirOfUri` | dead — delete |
| `STORAGE_PREFIX` (`sources.ts:120`) | `storageRelativeDir` | dead — delete |

`foldAlbumsToDirs` is **not** affected: it folds `relativePath` straight from the native bucket rows and touches none of the four.

Their tests go with them — `src/lib/sources.test.ts` lines **61-104** (`dirOfUri`, `storageRelativeDir`, `sourceDirOfUri`), **8 `it` cases** across ~44 lines. Counted twice: the first count said 7 by stopping at line 99 and clipping `sourceDirOfUri`'s case, and the spike caught it by measuring 714 → 706.

`src/lib/mediaIdentity.ts:25` says "Legacy primary aliases (**the STORAGE_PREFIX variants in sources.ts**)". That reference dangles the moment this sweep lands, so reword it in the same change — §4.4 already establishes that `mediaIdentity.ts` becomes the only place those shapes are parsed.

**Device-verified, S10e (API 31), 2026-07-30** — the native cursor walk as sole catalog path is complete and no slower:

- `[perf] source catalog (native): 643 buckets in 277ms`, against a 642 buckets / 264 ms pre-deletion baseline.
- Both volumes present and correctly tagged: `DCIM [SD card] 6` alongside untagged internal rows, plus 110 further SD-tagged rows on a scroll sweep.
- The SD root was selected end to end — label became `DCIM (SD card)`, rescan logged `[scan] done: scanned 6, embedded 6 fresh`. The volume-qualified root that only the native walk can produce works all the way through ingestion.
- Selection change → rescan → counts move, and restore cleanly (`5 798` → `3` → `5 798`).
- Zero `[sources]` warnings and zero `ReactNativeJS:W`-or-worse records across the session.
- Gates all green; `assembleRelease` succeeded. Patch: `scratchpad/spike-b-delete-catalog-fallback.patch` (41 insertions / 185 deletions).

**Note:** `sourceCatalog.ts` itself has **no tests** — nothing in the repo imports it under test. The tests to delete are the pure-side ones above.

**A residual assumption deleted rather than answered.** The m0.8.3 grilling left one item unvetted: the fallback was corrected to derive *real* volumes from the probe uri (`sourceCatalog.ts:226-231`), against a plan that had wrongly claimed it could only produce primary-only entries. Deleting the fallback makes the question moot. It must not resurface.

### 4.4 The merged-collection URI shape

- `src/lib/mediaIdentity.ts:67-69` — drop the `legacyMergedCollection` parameter from `canonicalContentUri`; the volume always comes from the canonical id. Delete the doc paragraph at `:59-65`.
- `src/lib/media.ts:416-425` — delete `LEGACY_MERGED_COLLECTION` and the paragraph at `:405-409`; `getEditableContentUri` calls `canonicalContentUri(assetId)` with no second argument. (`getEditableContentUriDetailed` no longer exists — see §4.7.)
- `src/lib/mediaIdentity.test.ts:93-97` — delete the legacy-authority case.

`src/lib/mediaIdentity.test.ts:40` (the STORAGE_PREFIX-variant primary aliases) and the `volumeOfUriPath` branch it covers (`mediaIdentity.ts:36`) **stay**.

The deletion rule this release follows is *below the floor goes*. That branch is not version-gated at all — it is defensive path parsing, and an alias path would parse the same on Android 16 as on Android 7 — so it falls outside the rule.

Measured 2026-07-30 on the S10e: across 8 865 MediaStore rows spanning internal storage and the microSD, every `DATA` path is `/storage/emulated/N/…` or `/storage/<UUID>/…`. The alias branch never fires on hardware we own — but that is two Samsungs, not a survey, and the failure mode if an OEM does emit `/sdcard/…` is the whole library going invisible (parse returns null → fail-closed skip → withheld baselines). One regex line against that asymmetry is a trade worth keeping.
Note `sources.ts`'s separate `STORAGE_PREFIX` copy dies regardless in the §4.3 sweep; after this release `mediaIdentity.ts` is the only place these shapes are parsed.

### 4.5 Copy that names Android 11 (D4)

Every string below asserts a version fact the app's own floor contradicts.

**The wording rule (Tristan, 2026-07-30):** name the cause, promise no recovery, keep the deletion guarantee.
There *is* no user recovery — a module-absent build is an Expo Go shell, and reinstalling it changes nothing — so any "try again" or "reinstall" would be a false promise, which is worse than saying less. The only readable audience is a developer, so the cause is named plainly.

Agreed bodies (titles unchanged):

- `CullListScreen.tsx:123` and `HomeScreen.tsx:459` — *"Afterglow's media module is not available in this build, so nothing was changed. Afterglow never permanently deletes photos — your culls are still staged and untouched."*
- `FavouritesQueueScreen.tsx:129` — *"Afterglow's media module is not available in this build, so nothing was changed. The queued hearts are still waiting."*

The retained "never permanently deletes photos" clause is deliberate: once the floor rises that guarantee becomes unconditional (§7, `PLAN.md:99`), and the moment a removal fails is exactly when it is worth repeating.

The sites:

- `src/screens/CullListScreen.tsx:123` — the "System trash unavailable" alert body.
- `src/screens/CullListScreen.tsx:208` — the subtitle shown when culls are staged and trash is unsupported. With `systemTrashSupported` gone, this branch disappears entirely.
- `src/screens/FavouritesQueueScreen.tsx:129` — the "Gallery favourites unavailable" alert body.
- `src/screens/FavouritesQueueScreen.tsx:155` — the permanent `!supported` banner. Deleted with the predicate.
- `src/screens/HomeScreen.tsx:459` — the "System trash unavailable" alert body on the Home cull path.
- `src/screens/CullListScreen.tsx:23` — the header comment's "on Android 11+" framing.

Separately, `src/screens/SourcePickerScreen.tsx:367-369` hardcodes the cause of a catalog failure ("an album was unreadable"). After D3 it can also mean "the native media module is unavailable", so it must report the error it actually received.

### 4.6 Manifest and permissions — NOTHING CHANGES

**`WRITE_EXTERNAL_STORAGE` stays. Do not remove it. This was tried and measured to break the app.**

The plan originally called for removing it, on the reasoning that Android grants nothing for it from API 30 and the app calls no expo-media-library write API (only `getAssetsAsync`, `getAssetInfoAsync`, `getAlbumsAsync`, `usePermissions`). That reasoning is true about *Android* and false about *our dependency*:

`expo-media-library`'s `hasReadPermissions()` (`MediaLibraryModule.kt:377-381`) does this below API 33:

```kotlin
val permissions = arrayOf(READ_EXTERNAL_STORAGE, WRITE_EXTERNAL_STORAGE)
appContext.permissions?.hasGrantedPermissions(*permissions)?.not() ?: false
```

A vararg **AND**. Every read call routes through it via `requireSystemPermissions(false)`, so on API 30–32 the library refuses to read unless `WRITE_EXTERNAL_STORAGE` is *also* granted — and a permission absent from the manifest can never be granted (`pm grant` answers `SecurityException: Package … has not requested permission`).

**Measured on the S10e (API 31), 2026-07-30, clean install + real OS consent tap:**

| Build | Result |
|---|---|
| minSdk 30, `WRITE_EXTERNAL_STORAGE` blocked | Home renders, then `[scan] failed: … Missing MEDIA_LIBRARY permissions`. **0 photos, permanently.** |
| minSdk 30, `WRITE_EXTERNAL_STORAGE` kept (control) | `[scan] done: scanned 5795, embedded 5795 fresh, 1307 windows grouped`. Fully working. |

The failure is confined to API 30–32 — above 32 the `TIRAMISU` branch uses granular permissions only. That is precisely the band m0.8.4 chooses to keep, and it covers every device except the S23. Testing only on the S23 would have shipped this.

Two further measured facts that remove any residual case for the change: one OS dialog grants READ and WRITE together (same storage permission group on API ≤ 32), so keeping it costs the user no extra prompt, tap, or copy; and the `blockedPermissions` mechanism itself worked perfectly — `tools:node="remove"` stripped the plugin-injected permission from the merged manifest exactly as designed. **The tooling was right; the decision was wrong.**

So the whole permission surface is unchanged this release:

- `WRITE_EXTERNAL_STORAGE` (`maxSdkVersion="32"`) — stays, load-bearing for expo-media-library reads on API 30–32.
- `READ_EXTERNAL_STORAGE` (`maxSdkVersion="32"`) — stays; `READ_MEDIA_IMAGES` does not exist below API 33.
- `android:requestLegacyExternalStorage="true"` — stays (D7), inert while `targetSdk ≥ 30`.

This constraint disappears only at a floor of API 33, which contradicts D1 and would exclude the S10e — the only two-volume test device.

**Recorded outside this plan** (done 2026-07-30, since release plans are deleted when they ship and this constraint is permanent): the `src/lib/media.ts` header carries the full warning, and `apps/mobile/AGENTS.md`'s `media.ts` map row leads with it. `app.json` itself cannot hold a comment — it is strict JSON — which is exactly why the warning needs a home that a reader reaches first.

### 4.7 The vestigial `EditableContentUri` shape (spiked and measured)

Not Android-floor legacy — a leftover of **m0.8.3**, when URIs stopped being *resolved* and became *constructed*, collapsing a two-valued `source` to one. Admitted to this release because it is the same sweep, and because it is textbook inert plumbing: a field that is set and never read.

`EditableContentUri.source: 'canonical'` has **zero readers**. The one apparent consumer, `formatMatrixReport`, pushes a hardcoded literal (`editMatrix.ts:114`) and reads only `.uri`. `getEditableContentUriDetailed` has exactly one caller (`EditDiagnosticsSheet.tsx:63`), which used only `.uri`.

Delete: the `EditableContentUri` interface and `getEditableContentUriDetailed` (`media.ts`), `MatrixUriInfo` **collapsed entirely** — with `source` gone it is a one-field wrapper, so `formatMatrixReport` takes the uri string directly — and the sheet switched to `getEditableContentUri`.

**Scope correction from the spike: four files, not three.** `src/lib/editMatrix.test.ts` constructs the shape at three call sites (lines 67-70, 82, 89), so TypeScript's excess-property check fails if it is left alone. Benign — test count is unchanged and **no assertion changes**, only argument literals — but §9's "a changed assertion is a stop-and-investigate" rule is not tripped by it, and the implementer should expect the file in the diff.

Measured 2026-07-30: **net −19 lines**; `typecheck`, `lint`, `format:check` and the Metro export all clean; **714 tests in 46 files, identical to baseline**; `assembleRelease` succeeded (3m36s, `lintVitalRelease` clean). On the S10e all three surviving `getEditableContentUri` paths were verified end to end (edit-here → OS write consent → editor opened with the right file; share → chooser dispatched; organize → album assigned), and the diagnostics sheet itself was forced legitimately by disabling the only `ACTION_EDIT` handler — it opened and rendered its URI line correctly through the surviving function.

A ready-to-apply patch is at `scratchpad/spike-a-delete-editable-uri.mine-only.patch`.

**Deliberately NOT in this**: the vestigial `async` on the surviving `getEditableContentUri` (§11).

### 4.8 Size

| Area | Deleted |
|---|---|
| `sourceCatalog.ts` fallback + imports + header | ~76 |
| `sources.ts` dead helper chain | ~40 |
| `sources.test.ts` three describe blocks | ~38 |
| `media-store-actions/index.ts` predicate collapse + comments | ~35 |
| `MediaStoreActionsModule.kt` (10 sites) | ~45 |
| `ImageEmbedderModule.kt` decode fallback + imports + gradle | ~40 |
| Screens: 6 gates + the copy branches they guard | ~45 |
| `media.ts` + `mediaIdentity.ts` merged-collection shape | ~24 |
| `mediaIdentity.test.ts`, `MediaStoreActionContract.kt` | ~9 |
| §4.7 vestigial `EditableContentUri` shape (**measured**, not estimated) | 19 net |
| **Total deleted** | **~371** |
| Added (the `app.json` pin block, rewritten copy, floor assertions) | ~25 |
| **Net** | **≈ −330** |

An estimate from the site inventory, not a measured diff.
The real prize is not the line count: three recurring "what about legacy?" questions — *does this work below 30? below 29? below 28?* — stop existing for every future review.

---

## 5. True impact on Android 11+ devices

The claim this release rests on is that **nothing changes for a device that can install it**. Checked branch by branch.

### 5.1 Branches with provably zero behaviour change at API ≥ 30

Each of these is already on its modern arm at API 30, so deleting the other arm cannot be observed:

| Branch | Condition today | At API 30 |
|---|---|---|
| `available()` | `Version >= 30` | true |
| `imageDetailsAvailable()` | `Version >= 29` | true |
| `LEGACY_MERGED_COLLECTION` | `Version < 29` | false |
| `listMountedVolumes` | `SDK_INT >= Q` | true — MediaStore arm |
| `countImagesByVolume` | `SDK_INT >= Q` | true |
| `listImageAlbums` volume set | `SDK_INT >= Q` | true — `getExternalVolumeNames` |
| `mediaGenerations` | `SDK_INT >= R` | true |
| `mediaChangedSince` / `moveToRelativePath` / `launch` / `mediaPresenceOf` / `queryFlag` | `SDK_INT < R` early exit | never taken |
| `ImageEmbedder.decodeInner` | `SDK_INT >= P` | true — `ImageDecoder` |
| 6 screen gates | `Version >= 30` | true |

The scan-skip contract is unaffected in substance: an empty generations map still means "cannot prove unchanged" and still forbids a skip (`scanSkip.ts:17`). Only its stated *reason* narrows, from "API < 30 or unreadable volumes" to "unreadable volumes or module absent".

### 5.2 The one branch that does change: the album catalog without a native module

At floor 30, `mediaStoreActionsAvailable()` means only "the native module is present". Deleting the fallback therefore changes behaviour for module-absent shells — Expo Go and iOS — and nothing else.

That configuration is already non-functional: `scanRunner.ts:713` calls `getMountedVolumes()`, which throws when the module is absent, and the pass fails. Nothing can be ingested, so a folder catalog it could list is a catalog it could never scan.

The throw is also not a new path. `resolveSources` already rejects today whenever `listImageAlbums()` hits its all-volumes-or-none contract (`MediaStoreActionsModule.kt:408`) or a probe fails (`sourceCatalog.ts:248`). Before any caller sees it, `resolveSourcesWithRetry` retries 5× at 100 ms and never caches a failure (`sourceCatalog.ts:319-337`).

All 17 call sites were read; every one fails closed:

| Caller | On rejection |
|---|---|
| `HomeScreen.tsx:263` | `resolutionFailed` → corpus stats, ring and streaks skipped; last rendered values stand, never broadening to all folders |
| `ReviewContext.tsx:539,709` | falls back to `lastRootsRef`; skips the refresh entirely on cold start |
| `ProgressView.tsx:378,457` | returns early; previously rendered scope kept |
| `SettingsScreen.tsx:307,356` | `.catch(() => null)`; scan facts kept |
| `SummaryScreen.tsx:50` | returns early; placeholders / previous values kept |
| `StatsScreen.tsx:131` | `sourcesOrNull` returns null; tabs never load silently unscoped |
| `DayProgressScreen.tsx:58` | falls into the page's `failed` state — deliberately not a known-empty day |
| `SourcePickerScreen.tsx:116,252,284` | the only user-facing surface: failure line plus a **Retry** button |
| `scanRunner.ts:697,781` | pass fails → `phase: 'error'`, retried on next open |
| `detect.ts:158` | no local handler; caught at its only caller, `HomeScreen.tsx:520` (`.catch(() => null)`) |

Recovery, honestly stated: there is none in a module-absent shell, and there should not be — the fix is to run a dev-client or release build, not to retry. The *recoverable* cause of the same failure (a transient unreadable album on a real device) still recovers through the 5× retry and the picker's Retry button, both untouched.

### 5.3 Risk concentration

The Kotlin edits land in `listMountedVolumes`, `listImageAlbums`, `countImagesByVolume` and `mediaGenerations` — precisely the m0.8.3 mount and per-volume scan contract.
`docs/REVIEW_CLASSES.md` classes 34-40 are that cycle's own defect family, and class 25 ("a fallback inside a fix re-opening the hole it closes") is the shape most likely to bite an edit that removes fallbacks.
This is why §9 keeps the full device matrix rather than a light pass.

---

## 6. Blocking Android ≤ 10 from installing

This is the release's actual contract. Four steps: declare, verify, guard, tell.

### 6.1 Declare — the platform does the blocking

Add the `expo-build-properties` plugin per §3.
The merged manifest then carries `<uses-sdk android:minSdkVersion="30"/>`, and no further code is involved:

- **Sideload / `adb install`** on API ≤ 29 fails with `INSTALL_FAILED_OLDER_SDK`. The package installer refuses before any app code runs.
- **Play Store**, if distribution ever happens, derives listing eligibility from `minSdkVersion` automatically — the app is simply not offered to those devices.
- **Existing installs** are not affected. Android does not uninstall an app when a floor rises; it only blocks the *update*. There are no such installs — no tester has a device below API 31.

There is deliberately no in-app version check, and none is possible: once the manifest floor ships, no code of ours can run on a device below it. A JavaScript check would be dead from its first commit, and a second source of truth that can drift from the manifest.

Surfacing the floor in Settings → About (`SettingsScreen.tsx:828`) was considered and rejected for the same reason — anyone who can open Settings has already cleared it.

### 6.2 Verify — on the artifact, not the input

The floor must be asserted on the final APK, because the manifest is what devices read.

```bash
"$ANDROID_HOME"/build-tools/*/aapt dump badging <apk> | grep sdkVersion
# measured on the spike build: sdkVersion:'30'  /  targetSdkVersion:'36'
```

Locally this is `~/Android/Sdk/build-tools/35.0.0/aapt`.

**The block itself is measured, not inferred** (2026-07-30 spike, `afterglow-api29` emulator, API 29):

```
adb: failed to install …: Failure [INSTALL_FAILED_OLDER_SDK: Failed parse during
installPackageLI: … Requires newer sdk version #30 (current version is #29)]
```

And the floor is functional, not merely declared (`afterglow-api30` emulator, API 30):
`[scan] done: scanned 6, embedded 6 fresh, 3 windows grouped`, with the native album catalog and the MediaPipe embedder both working on x86_64.

### 6.3 Guard — so the floor cannot silently regress

**Both gates** (Tristan, 2026-07-30), cheap, at different levels:

1. **Input gate**, in `scripts/release-preflight.mjs` (already the first step of `mobile-release.yml`): assert `app.json` declares the `expo-build-properties` plugin with `android.minSdkVersion >= 30`, alongside the existing version and `versionCode` checks. It is strictly redundant in CI — its whole value is failing **locally, before a tag is pushed**, where the artifact gate can only fail after.
2. **Artifact gate**, an unconditional step in `.github/workflows/mobile-release.yml` between "Build release APK" and "Name and verify the APK": run the `aapt dump badging` check above and fail the job on anything but `30`.

The artifact gate is the one that proves the claim — a floor assertion is only valid on the merged final state, and it sees exactly the APK that gets uploaded.

**Why a workflow step rather than inside `release-artifacts.mjs`**, which is the tool that produces the mobile manifest and already reads the APK bytes: that script is shared with the desktop release and runs on Windows (`release-artifacts.mjs:12`), so giving it an Android SDK dependency would couple the desktop path to `aapt` on a platform that lacks it. Parsing Android's binary XML in pure Node to avoid `aapt` is ~100 lines of binary-format handling for one integer. The step is unconditional, fires on every `mobile-m*` tag, cannot be skipped without editing the workflow, and runs on the artifact just built — which is what the invariant rule is protecting. (The global `AGENTS.md` rule was clarified on 2026-07-30 to say exactly this: an unconditional CI step on the artifact satisfies it; a manual or optional step does not.)

**Both gates are WRITTEN AND PROVEN** (2026-07-31 spike, in an isolated worktree). Ready-to-apply patch: `scratchpad/spike-d-floor-assertions.patch` (2 files, +56/−1, applies cleanly to `initial`).

Gate 1, proven in both directions plus its parse edge:

| Case | Result |
|---|---|
| No `expo-build-properties` entry (today's `app.json`) | FAIL — names the exact entry to add |
| Plugin present, `minSdkVersion: 30` | PASS — `versionCode 11, minSdkVersion 30` |
| `minSdkVersion: 29` | FAIL |
| Plugin present as a **bare string** (no config) | FAIL — the mixed string/pair shape is parsed defensively |

Desktop path unaffected (`desktop-v0.5.0` passes, a wrong tag still fails), and the existing monotonic `versionCode` check still fires.

Gate 2, run byte-identically to CI by extracting the `run:` block out of the YAML:

| Case | Result |
|---|---|
| minSdk-30 APK | exit 0, `sdkVersion:'30'` |
| minSdk-24 APK | exit 1, error naming the expected value and where to fix it |
| `ANDROID_HOME` wrong or unset | exit 1 — **fails loudly rather than passing unverified** |
| APK missing | exit 1 via `pipefail` |

Two findings worth carrying into implementation:

- **Gate 1 checks the declaration, not the installation.** `expo-build-properties` is absent from `apps/mobile/package.json` today, and declaring the plugin without installing it would pass gate 1. This is not silent — `expo prebuild` fails with an unresolved-plugin error — so the check was deliberately left out as scope creep on an already-loud failure. Just remember `npm install -w afterglow-companion -D expo-build-properties` alongside the `app.json` edit.
- **Gate 1's "strictly redundant" claim holds only while the floor lives in `app.json`.** If it ever moved (a custom config plugin, a `gradle.properties` override in a prebuild hook), gate 1 would keep passing while the artifact changed. That is precisely why gate 2, on the built APK, is the one carrying the invariant — and why it is not optional.

### 6.4 Tell — testers and the roadmap

A blocked install is only actionable if the tester learns why.
`adb install` prints `INSTALL_FAILED_OLDER_SDK`, but the on-device package installer shows a generic "App not installed" — so without a stated requirement the failure reads as a broken build, not a decision.

`apps/mobile/README.md` gains one compat statement **on the download path** — beside line 187, "Testers grab the release APK from the latest `mobile-m*` GitHub Release" — reading: **Afterglow requires Android 11 or later**, with the reason in a sentence (Android's system trash, which every removal in the app goes through, does not exist below it).
The two passages describing below-Android-11 behaviour (~lines 234-236 and the `media-store-actions` note at ~311-313) are rewritten to state the floor instead of a fallback.

**README only** (Tristan, 2026-07-30). Adding the requirement to the GitHub Release page (a `body:` line in `mobile-release.yml`, which currently emits auto-generated commit notes only) was considered and dropped: he is the sole tester and owns no device below API 31, so the README statement is the whole audience. Revisit if the tester group grows.

Version markers that tell testers what a release changed are the documented exception to "docs describe now, not the journey", so this one belongs in the README.

---

## 7. Docs and roadmap edits

| File | Edit |
|---|---|
| `PLAN.md:99` | The trash invariant, restated as unconditional — see §7.1 for the agreed wording. |
| `PLAN.md:178-179` | The m0.8.4 entry already exists and already names the decision. Update it to the settled floor, mechanism and scope once implemented. |
| `PLAN.md:181` | m0.9 is already rescoped to Videos (+ per-ABI splits, visual group vet). **No edit needed** — it was already done in commit `2febe5b`. |
| `apps/mobile/README.md` | §6.4. |
| `apps/mobile/AGENTS.md` | Two map rows carry legacy claims: `sources.ts / sourceCatalog.ts` ("the pre-API-30 expo fallback yields primary-only entries" — doubly wrong once deleted, since m0.8.3 had already corrected the primary-only claim) and the `media-store-actions` description of the API 24+ mounted-volume arm. Also drop `sourceDirOfUri` from any helper listing. |
| `docs/TODO.md` | **No legacy edits** — swept for legacy-conditioned entries and found none; the two "permanent delete" hits are about a *user* deleting outside the app, not our floor. Two entries were **added** from this release's spikes, both already applied: "Capture-time truth" gained the ARW mtime-dating finding, and **the rescued-date defect was written up fully designed and scoped out of this release as "A D15-rescued photo's date does not reach the Progress library scope" — since promoted into m0.8.6 (`docs/Feedback_m0.8.x.md`)**. |
| `docs/STATE_MODEL.md` | No edit — it contains no version claims. |
| `docs/REVIEW_CLASSES.md` | **Done 2026-07-30** — classes 41-43 added under a new "Deletions and dual sources" heading: a dead branch left behind a raised floor, an inert-looking declaration a dependency treats as load-bearing, and two engines behind one screen. Applied ahead of implementation deliberately: they are lessons already learned, and 41 and 42 guide this release's own work. |
| `handoff-m0.8.4-drop-legacy-android.md` | **Already deleted** (Tristan, 2026-07-31) — it existed only to carry a session boundary, and this plan supersedes it. Its one wrong claim is corrected here: it said the catalog fallback's deletion takes "its tests" with it, but `sourceCatalog.ts` has none (§4.3). |

### 7.1 The trash invariant, restated as unconditional (agreed wording)

Today the invariant is stated **with its reason attached**: no permanent-delete fallback *because* below API 30 there is no system trash. Raising the floor evaporates that reason, so deleting the legacy clause alone would leave a bare prohibition whose justification is gone. Six sites carry the qualifier; all six change together, and they must not be applied before the code lands or the docs would describe a floor the app does not have.

**`PLAN.md:99`** — replace the tail `…on Android 11+; below API 30, permanent delete behind unmissable warnings (m0.8 — no system trash exists there).` with:

> …→ batch move into the **system trash** (recovery duration is gallery-managed; one system dialog per bounded batch). **Afterglow never permanently deletes a photo** — the Android 11 floor guarantees a system trash exists, so the invariant is unconditional and there is no fallback to design.

This also kills the m0.9 roadmap item that promised the fallback.

**`apps/mobile/README.md:234-236`** — replace `On Android 11+ the system dialog moves batches… Below Android 11 there is no permanent-delete fallback — deliberately.` with:

> One final confirmation moves batches to the system trash with verified results, dialog by dialog until done. Afterglow never permanently deletes a photo.

**Strip the now-redundant "Android 11+" from our own mechanism** at `README.md:313`, `apps/mobile/AGENTS.md:13`, `apps/mobile/AGENTS.md:113`, `CLAUDE.md:30`, and — found by the §4.2 spike, and missing from the first draft of this list — two Kotlin comments that hedge our own mechanism the same way: `MediaStoreActionsModule.kt:163` ("createWriteRequest approval probe (Android 11+)") and `MediaStoreActionContract.kt:42-44` ("the documented Android 11+ mechanism"). The qualifier is true but redundant once the floor is the floor, and leaving it invites exactly the dead question ("so what happens below?") this release exists to delete.

**Counter-example, keep it:** `mediaGenerations`' own "(API 30+)" is a statement about the *MediaStore API*, not a hedge about us. Same words, opposite meaning — the test is whether the sentence describes the platform or excuses our own behaviour.

**`apps/mobile/AGENTS.md:68` is the exception**: *"Deletions arrive as trashed rows (Android 11+ gallery deletes set `IS_TRASHED`…)"* describes **other apps'** behaviour and explains why the delta scan can see deletions at all. Keep the explanation, drop only the version prefix — it teaches a mechanism rather than hedging ours.

---

## 8. Implementation phases

Each phase lands with its tests and its doc edits.
Phases 1-4 are independent of each other and can land in any order; phase 5 must come after all of them, then 6, then 7 last.

**Phase 1 — raise the floor.**
`expo-build-properties` dev dependency plus the `app.json` plugin entry with all three pins (§3). Nothing else: the permission surface is unchanged (§4.6).
Proof: `npx expo prebuild --platform android --clean --no-install`, then check `android/gradle.properties` and the merged manifest, then `aapt dump badging`.
Nothing is deleted in this phase — it stands alone, so a floor problem is never entangled with a deletion problem.

**This phase is already proven** by the 2026-07-30 gate-0 spike: `gradle.properties` carried all three pins, the merged manifest carried `<uses-sdk android:minSdkVersion="30" android:targetSdkVersion="36"/>`, `assembleRelease` succeeded (6m54s, `lintVitalRelease` clean — nothing tripped over the raised module floor), API 29 refused the install, and API 30 ran a complete scan. Re-run it as written; treat any deviation as a real regression.

**Phase 2 — Kotlin.**
The ten gate sites, the contract's `@RequiresApi`, and the image-embedder decode fallback with its gradle dependency (§4.2).
Proof: `npx expo prebuild --platform android --no-install && cd android && ./gradlew :app:assembleRelease`.

**Also already proven** (2026-07-31, §4.2): patch at `scratchpad/spike-c-kotlin-deletions.patch`, all gates green, `lintVitalRelease` clean with zero `NewApi` findings, and a before/after device walk on the S10e showing no behavioural difference on any edited path. Note phases 1 and 2 were spiked **together**, because deleting `@RequiresApi(R)` only lints once the floor is 30 — they can still land as separate commits, but phase 2 cannot be verified before phase 1 exists.

**Phase 3 — the TypeScript module boundary.**
The predicate collapse in `modules/media-store-actions/index.ts`, the merged-collection shape in `media.ts` / `mediaIdentity.ts`, and their tests (§4.1, §4.4).

**Phase 4 — the catalog fallback and its sweep.**
`sourceCatalog.ts`, the `sources.ts` dead chain, the `sources.test.ts` blocks, and the SourcePicker copy fix (§4.3, §4.5).
Largest single deletion; kept apart from phase 3 so the sweep is reviewable on its own.

**Phase 5 — screens and copy.**
The six screen gates and every string in §4.5.

**Phase 6 — the year in day labels (§10).**
One line in `lib/dates.ts` plus the first tests `labelForDayKey` has ever had.
Deliberately its own phase and deliberately last before the release plumbing: it is the only hunk in this release that changes what a user sees, so it must be reviewable without any deletion in the same diff.

**Phase 7 — release plumbing and docs.**
The two floor assertions (§6.3), all of §7, and the version bump: `apps/mobile/app.json` to `0.8.4` with `versionCode` 11, and `apps/mobile/package.json` to `0.8.4`.
Then `node scripts/release-preflight.mjs mobile mobile-m0.8.4` from the repo root.

---

## 9. Testing strategy

Mapped onto the existing tiers; no parallel scheme.

**Unit (`npm test -w afterglow-companion`).**
Baseline is 714 tests in 46 files, all passing.

The **legacy sweep (§4) removes tests and adds none**: the deleted cases assert behaviour of interfaces that no longer exist, and testing that a removed interface stays unsupported is explicitly not something we do.

**The legacy sweep (§4) adds no tests, and that is a property of it, not an oversight**: nothing in §4 changes behaviour on any device that can install the build, so there is no new behaviour to pin. A test appearing in a §4 hunk is a signal to stop and check, not diligence.

**§10 does add tests**, because it does change behaviour: `labelForDayKey` (`lib/dates.ts:65`) is pure and currently untested, and gets coverage for the year being present on every absolute day including this year's, with `Today` / `Yesterday` / `Unknown day` unchanged.

**Expect exactly 705 tests in 46 files.** Nine cases go, measured not estimated: **eight** in `sources.test.ts` (the `dirOfUri`, `storageRelativeDir` and `sourceDirOfUri` describes, §4.3 — the spike measured 714 → 706 for that deletion alone) and one in `mediaIdentity.test.ts` (the legacy merged authority, §4.4). Both files keep their other blocks, so the **file count must stay 46** — a drop to 45 means a whole file was emptied, which nothing in this plan calls for, and needs investigating rather than accepting.

§4.7 removes **no** tests: `editMatrix.test.ts` changes three argument literals and keeps every assertion (measured — 714/46 held during the spike, before §4.3/§4.4 land).

Every remaining test must pass unchanged — a *changed assertion* anywhere is the signal that a deletion altered behaviour rather than removing a dead arm, and is a stop-and-investigate, not a fix-the-test. Changed *argument literals* (as in §4.7) are not that signal.

**Repo gates.**
`npm run lint`, `npm run format:check`, `npm run typecheck -w afterglow-companion`, and the Metro bundle proof `npx expo export --platform android` from `apps/mobile`.
TypeScript is load-bearing here: the collapsed predicates and the dropped `canonicalContentUri` parameter surface every missed call site as a compile error.

**Native proof.**
`npx expo prebuild --platform android --clean --no-install && cd android && ./gradlew :app:assembleRelease`, from `apps/mobile`.
Then the §6.2 `aapt` check on the produced APK.

**API 30 emulator pass (new, and the reason D1 chose 30).**
The AVD already exists from the gate-0 spike: `afterglow-api30` (`system-images;android-30;google_apis;x86_64`, Pixel 5 profile, 8 GB data). Provisioning cost ~10 min and 3.4 GB; boot is under a minute on KVM.

This is the band no hardware covers, and the floor is dishonest without it. **Cover:** app opens and acquires permission through the real consent dialog; a scan completes; the folder picker lists albums; a cull reaches the system trash dialog; a favourite batch applies.

**Explicitly NOT covered here — use a phone:** anything about capture-time grouping. Photos pushed to an emulator index with `datetaken` NULL (a known quirk, `docs/DEVELOPMENT.md:164`, confirmed on API 30 in the spike), so every seeded photo is undated at MediaStore level. Two consequences: emulator grouping is unrepresentative, and every seeded photo falls into the D15 EXIF rescue — the spike measured `exif rescue: 6 of 6 undated photos got real dates`, which is a genuine exercise of that path but not a grouping test.

If any covered item fails on API 30, the floor is 31 and D1 was wrong — say so rather than papering over it.

**RAW policy at the floor (Tristan, 2026-07-30).**
`apps/mobile/README.md`'s RAW table is scoped to *"measured on real hardware (Samsung S23 / Android 16, 2026-07)"* — API 36 only. m0.8.4 is the release that declares Android 11 supported, so "DNG/NEF/ARW fully reviewable, CR3 invisible" is currently an unclaimed band. Same argument that put the API 30 pass in this list.

Run on **both** targets, using the existing corpus at `/sdcard/DCIM/SpikeRAW/` on the S23 (NEF, ARW, JPG, 3× CR3):

- **S10e (API 31, real Samsung codecs)** — the authoritative instrument. A failure here is a real regression.
- **API 30 emulator** — covers the exact floor, but is **confirm-only**: an AOSP x86_64 image does not carry Samsung's codec set, so a decode failure there is ambiguous evidence about real Android 11 hardware while a success is strong.

Three checks: MediaStore indexes NEF/ARW/JPG and not CR3; the scan embeds the NEF and ARW (no gap between `scanned` and `embedded`); the NEF picks up its real capture date through the D15 EXIF rescue.

**API 30 emulator: all three CONFIRMED** (2026-07-30), and it is the strong kind of result — a decode failure would have been ambiguous, a success is not.

- Indexing: image count 6 → 9. `image/x-nikon-nef` and `image/x-sony-arw` indexed as images; all three CR3s land in the files table with `media_type=0` (MEDIA_TYPE_NONE), so the README's "invisible to the app" claim now holds at the floor too. That is a MIME-classification fact, not a codec fact, so it generalises off the emulator cleanly.
- Decode: `[scan] done: scanned 9, embedded 3 fresh` — 3 new photos, 3 persisted vectors, zero gap, no `DECODE_FAILED` anywhere. Both RAWs also render full-size in the viewer. AOSP x86_64 Android 11 decodes NEF and ARW without vendor codecs.
- Rescue: the NEF arrives `datetaken=NULL`, `[scan] exif rescue: 1 of 1 undated photos got real dates`, and Progress files it under August 2024 — its true `DateTimeOriginal`.

**S10e (API 31): all three CONFIRMED too** (2026-07-30), identical to the emulator — NEF/ARW/JPG `media_type=1`, all three CR3s `media_type=0`, `scanned 5798, embedded 3 fresh` with no `DECODE_FAILED`, and the rescued NEF filed under Aug 2024 (Home's day row reads `17 Aug, 0/1 reviewed`). Real Samsung codecs decode NEF and ARW.

**But the ARW's date is wrong on the emulator AND the S10e — and right on the S23.** The app inherits whatever MediaStore says, verbatim, and **the D15 rescue cannot help, because it only runs on rows MediaStore reports as undated and this row carries a date, just a wrong one.** Two of three devices — both inside the newly supported band — put it 18¼ hours out. Root cause (MediaStore dates an ARW by file mtime, not EXIF) and the full table are in `docs/TODO.md` ("Capture-time truth"); not this release's work.

**S23 (API 36) also confirms the rescue premise itself:** `datetaken` is NULL for the NEF even after a fresh `scan_volume`, so Android 16 does not extract NEF capture dates either. The README's claim is not version-contingent.

**Known hole:** the corpus contains no DNG, so the README's "DNG (incl. Samsung Expert RAW) — Fully supported" row remains a single-device (S23 / Android 16) measurement, untouched by either target. Either source a DNG or narrow the README's wording to the formats actually verified — do not leave it implied.

**Defect surfaced and scoped OUT** (reproduces on the shipped build, so neither created nor cured here): a D15-rescued photo shows its *modification* time on the Progress library grid and is missing from its own capture-month filter. Fully investigated on API 30, 31 and 36 during these spikes, with an agreed six-change fix — designed in `docs/Feedback_m0.8.x.md` and scheduled into m0.8.6 ("A D15-rescued photo's date does not reach the Progress library scope") rather than admitted here, so this release stays a pure deletion.

**Device matrix (S23 `R5CW20KBA2W`, S10e `RF8M72Q4FGE` with the microSD, volume `0a91-e18d`).**
Full matrix, not a light pass — §5.3 explains why. The edits land in the m0.8.3 mount/scan contract, and the S10e is the only device that exercises a second volume at all.
Targeted checks beyond the standard walk:
- Folder picker lists albums on both volumes with correct volume tags (the native walk is now the only catalog path).
- Eject and remount the microSD: the Home unreachable banner, its counts, and the live mount-broadcast reload still behave (`listMountedVolumes` was edited).
- A scan runs, skips on a second open (generations), and takes a delta after a new photo (`mediaGenerations`, `mediaChangedSince`, `countImagesByVolume` were all edited).
- A cull batch reaches the system trash; a favourite batch applies; an organize move completes — the three paths whose `SDK_INT < R` early returns were deleted.
- The favourite chip renders in the group deck, the singles deck and Compare (four ungated sites).

**UI gate.** `node scripts/mobile-ui-gate.mjs` from the repo root, against an installed **release** build (`docs/MOBILE_UI_GATE.md`), plus the standing human acceptance pass.

**Regression pin.** The floor's own regression protection is §6.3's two assertions, not a test — a unit test cannot observe the manifest.

---

## 10. Day labels always carry the year (scope addition — NOT legacy removal)

Kept in its own section for the same reason the rescued-date defect was: everything in §4 is "below the floor goes", and this is not that. A reviewer must be able to see why it is in the diff.

**The problem.** Home listed two rows both reading `17 Aug` — one 2024, one 2025 — with nothing to tell them apart. The timeline's group and singles cards, DayProgress headings, the Edit queue and PhotoViewer are all yearless too; only the Progress histogram and its filter chip ever print a year.

**The change.** `labelForDayKey` (`lib/dates.ts:65`) is the single chokepoint for every one of those surfaces, so one pure edit fixes them all: add `year: 'numeric'` to `DAY_FORMAT` (`:91`, currently `{ month: 'short', day: 'numeric' }`) **unconditionally**. Every absolute day reads `17 Aug 2024`, this year's included.

`Today`, `Yesterday` and `Unknown day` are unaffected — they are relative or absent labels, not formatted dates, and return before `formatDay` is reached (`:66-70`).

A conditional "only when the year differs from now" was considered and **rejected as the more confusing option**: a label whose format changes with the calendar makes the reader work out which rule is in force, and "17 Aug" next January would silently mean something different than it does today.

**Scope is exactly this.** `formatDay` and `DAY_FORMAT` have no consumers outside `dates.ts` (verified repo-wide), so nothing else shifts. Freebie: `formatDay` is exported with no external caller and can become private in the same edit.

**Why it is here and not parked with the defect** (Tristan, 2026-07-30): it is independent of that defect, one line plus tests, and it is what makes the parked fix verifiable by eye anywhere except Progress. Deferring it would mean shipping the defect's fix later with no way to eyeball it.

**Tests.** `labelForDayKey` has no coverage today; it is pure, so it gets some — year present on an absolute day in a past year, year present on an absolute day in the current year, and `Today` / `Yesterday` / `Unknown day` unchanged.

## 11. Autonomous decisions

**This list is empty. Every planning-stage call was put to Tristan in the 2026-07-30 grilling and answered.**
Nothing in this plan is an unvetted assumption; implement against the sections above.

**Vetted and settled into the design:** the floor and its API 30 emulator gate (D1); the mechanism (D2); the full SDK pin and the min/target rule (D8, §3.1); D7's dependence on `targetSdk ≥ 30`; the catalog fallback and its dead helper chain, device-verified (D3, §4.3); the `unsupported` status and its three agreed strings (D4, §4.5); the STORAGE_PREFIX alias branch, kept with the measurement behind it (§4.4); the image-embedder gate (D6); the `EditableContentUri` deletion, spiked at −19 lines (§4.7); no in-app version check and README-only tester messaging (§6.1, §6.4); both floor assertions (§6.3); the trash invariant wording (§7.1); `REVIEW_CLASSES` 41-43 (applied); and the year in day labels (§10).

**Deliberately deferred, seen not missed:** the vestigial `async` on `getEditableContentUri`. It does no async work, but 6 call sites `await` it — two inside `Promise.all(ids.map(…))` — so removing it is a wide mechanical diff across the queue screens for no behavioural gain, and it is not legacy of any kind.

*(That deferral originally bundled the `EditableContentUri.source` deletion under the same "seven call sites" justification. Wrong: the shape had exactly ONE call site and measured −19 lines, so it was un-bundled, spiked, and moved into scope as §4.7.)*

**REJECTED by measurement** (2026-07-30 gate-0 spike): removing `WRITE_EXTERNAL_STORAGE`.
It is load-bearing for `expo-media-library` reads on API 30–32, and its removal leaves the app permanently unable to scan on Android 11/12 — §4.6 carries the evidence and the control experiment. Recorded rather than deleted so nobody re-proposes it from the same plausible reasoning.

**Scoped out:** the rescued-date read-source defect, fully designed, now scheduled into m0.8.6 as "A D15-rescued photo's date does not reach the Progress library scope" (`docs/Feedback_m0.8.x.md`); and ARW capture dates coming from file mtime rather than EXIF, appended to "Capture-time truth". Both were found by this release's spikes; neither is legacy removal.

---

## 12. Human acceptance pass — the m0.8.4 checklist

Everything automatable is already green (§9's gates, both floor assertions, the UI gate on both phones, the three-target device walk). This section is only what **you** have to judge: the OS consent flows automation deliberately cancels, frame-level latency, and taste.

**State of the devices right now.** All three targets already carry release `0.8.4` (versionCode 11) with a fully scanned corpus and permission granted, so you can start at step 2 unless you want the cold-start check. The UI gate has already made real decisions on both phones' corpora (keeps, culls, edit flags, queue intents) — that is expected and disposable.

`S23 = 192.168.10.32:44687` · `S10e = 192.168.10.137:34287` · emulator `emulator-5554` (API 30).
Wireless ADB ports change on reconnect — re-derive with `scripts/android-device.sh discover` if a serial is dead, and never `adb kill-server`/`disconnect`.

### 12.1 The floor — do this once, on the S10e (5 min)

The one thing no automated gate can prove is that a **real user upgrade** works, because CI only ever installs onto a clean device.

- [ ] With 0.8.4 already installed, confirm the app opens and the library total matches what it showed before (the floor rise must not have reset anything).
- [ ] `adb -s $S10E install -r <the 0.8.4 APK>` a second time — an in-place reinstall over itself must succeed, not `INSTALL_FAILED_*`.
- [ ] Settings → About shows `0.8.4`.

There is deliberately **no in-app floor check to test**: below API 30 no code of ours can run, so anything you could see has already cleared the floor (§6.1).

### 12.2 The three OS consent flows (both phones)

The gate cancels or avoids all three, so these are the highest-value manual steps. Each was walked once by me on each device — you are judging *feel and wording*, not whether it works.

**Cull → system trash**
- [ ] Stage 2-3 culls in a deck, open Cull list. Subtitle reads `N staged · tap any photo to change its decision` with **no** "requires Android 11" line anywhere.
- [ ] Tap `Trash N photos` → the app's own confirm names the count and says recovery is gallery-controlled → `MOVE TO TRASH` → Android's sheet.
- [ ] **Cancel** Android's sheet: the photos must still be staged and the copy must say nothing was touched.
- [ ] Repeat and **Allow**: the count drops, the Home cull row disappears, and the photos are in your gallery's Recently Deleted / Bin.

**Favourite batch**
- [ ] Queue 2 hearts from the deck, open the Favourite queue. The permanent `Gallery favourites require Android 11 or later` banner is **gone** — check the screen looks right without it, since that line used to sit between the intro and the list.
- [ ] `Apply N favourites` → the queue drains and the hearts show in your gallery. **Android does not prompt for this** — measured on all three targets, and not a bug: `createFavoriteRequest` lets the platform decide whether to ask, and Afterglow verifies every `IS_FAVORITE` flag afterwards rather than trusting the result. The destructive path is the one that must prompt, and it does.

**Organize move**
- [ ] Queue one photo **from `DCIM/Camera`**, assign an album, `Move 1 to albums` → consent → the row leaves the queue, the photo is in that album in your gallery, and you get a **toast, not a dialog**.
- [ ] Now the failure path (§13, the release's second admitted exception): queue a **WhatsApp** photo, assign an album, Move, approve consent. You should get a dialog naming the cause in plain words, with Android's own message quoted underneath. Judge whether that dialog would tell you what to do if you had not just read this plan.

### 12.3 The one visible change (either phone, 2 min)

- [ ] Home's day rows read `28 Jul 2026`, not `28 Jul`. Same on the timeline overview's group/singles cards, DayProgress's heading, the Edit queue and the photo viewer.
- [ ] `Today`, `Yesterday` and `Unknown day` are **unchanged** — no year appended to those.
- [ ] Judge the width: the year is ~5 characters on every day row, and Home's rows also carry `0/35 reviewed · 0%`. If anything now wraps or truncates at a size that matters to you, that is the call to make here.

### 12.4 External media — S10e only (10 min)

This is where m0.8.4's Kotlin deletions concentrate (`listMountedVolumes`, `countImagesByVolume`, `mediaGenerations`), so it gets the longest manual look. Measured green today; you are confirming it feels right.

- [ ] Settings → Photo source: SD rows carry the `SD card` tag, internal rows do not.
- [ ] With **All folders** selected, physically eject the card (or `adb -s $S10E shell sm unmount public:179,1`). **Without touching the app**, Home's banner appears: `SD card not mounted — N photos waiting on it`, and the library total drops by exactly N.
- [ ] Press the banner → it lands in Settings.
- [ ] Remount. The banner clears and the total returns — again without you navigating.
- [ ] Open the folder picker while ejected: persisted SD roots are greyed with their tracked counts, not missing.

### 12.5 Known, not yours to report

Seen during the device walk, already parked — please do not spend time on them:

- **A move can still be refused outright.** Photos under `Android/media/<pkg>/` (WhatsApp) can never be moved by Android. m0.8.4 makes the app say so (§13); what remains is that the queue accepts them at all, which costs a wasted consent tap — `docs/TODO.md`, "Organize accepts photos Android will never let it move".
- **An ARW's date can be wrong.** MediaStore dates ARW by file mtime, not EXIF. `docs/TODO.md`, "Capture-time truth"; the README's RAW table now says so.
- **A rescued (NEF) photo shows its modification time in Progress.** Pre-existing, fully designed, deliberately out of this release. `docs/TODO.md`.

### 12.6 Frame-level latency — only if something feels slow

Do not run this speculatively; it exists for when a tap *feels* wrong. `docs/MOBILE_UI_GATE.md` has the method (`screenrecord` → `ffmpeg` frames). m0.8.1 reference: edit/favourite/share chips ≤ 100 ms, cull→advance ≤ 200 ms.

m0.8.4 deletes branches and adds none on any hot path, so a regression here would be surprising — which is exactly why it is worth one honest look at the deck rather than a stopwatch.


---

## 13. Admitted exception — a failed organize move explains itself

§4's discipline is that this release changes no behaviour, and §10 was admitted as the single visible exception. **This is the second, and it gets the same treatment: its own section, its own commit, so a reviewer sees why it is in the diff.**

**Why it was allowed in.** The m0.8.4 device walk hit a move that failed with nothing but a red badge and *"retried on the next move"* — retry forever, no reason given. The app already had Android's explanation and threw it away, because `photo_actions` has no column for it. Deferring was the first instinct; it did not survive Tristan's question *"do we need to persist it?"* — no, because error rows stay queued and the next Move regenerates the same message, so a dialog raised from the run is the whole fix rather than half of one. That removed the schema bump, the destructive reset, and the ~30-minute re-embed that had made deferring look sensible.

**The design: classify from facts we own, never from Android's error text.**
Matching `"Primary directory … not allowed"` would stop matching the first time a vendor reworded it, and a diagnosis that silently degrades to nothing is worse than one that never claimed to know. So `lib/organizeFailures.ts` reads the photo's OWN uri (`Android/media/<pkg>` ⇒ another app owns it) and our OWN `unsupported` status. Three tiers, always in order:

1. a cause we can prove from our data → specific, actionable copy
2. anything else → an honest generic line
3. **always, last** → Android's own words, verbatim and unparsed

Tier 3 is what makes tiers 1-2 safe to be wrong: our reading sits above the ground truth, never instead of it. It is also what makes a tester's screenshot diagnosable. The one message string we compare is `"verification failed"` — ours, not Android's, and the Kotlin carries a note to change both sides together.

If a future Android permits what tier 1 forbids, the move simply succeeds and the copy stops appearing — a rule that goes quiet when it becomes wrong rather than one that starts lying.

**Measured on the S10e, 2026-07-31.** The dialog reads:

> **Could not move 1 photo**
> 1 photo lives in another app's own storage (com.whatsapp). Android does not let Afterglow move files out of another app's folder, so it will keep failing — remove it from the queue.
>
> Android said:
> • IllegalArgumentException: Changing ownership from …/Android/media/com.whatsapp/… to …/DCIM/Table Mountain Lapse/… not allowed

Android's own words — which the classifier never reads — independently confirm the diagnosis: *changing ownership*. Success path re-verified in the same session: a `DCIM/Camera` photo moved, the queue drained, and **no dialog appeared** (it is failure-only; the toast still carries the clean and declined paths).

**The device pass earned its keep.** The first build shipped *"1 photo live in another app's own storage"* — the plural sentence had a test, the singular one did not. All four cause lines had the same bug. Fixed, and every line now has singular AND plural coverage.

25 tests, 720 → 725. A `[organize] move failed:` field-diagnostic line rides along, on in every build until v1 like `[scan]` and `[perf]` — the one place a cause survives after the dialog is dismissed.

---

## 14. Acceptance-pass round (Tristan, 2026-07-31)

§12 found three things. One was my documentation being wrong, one was a copy bug, and one was a rule nobody had ever vetted. All three are fixed; the release is now honestly "deletion, plus §10, §13 and this".

### 14.1 The trash cancel heading said less than the app knew

`CullListScreen` had three body cases and two headings, so a plain cancel — where nothing was attempted and the body says so plainly — shared **"Nothing confirmed moved"** with the genuinely ambiguous case. The heading is what a reader takes in first, so the hedge is what landed. Three truths now get three headings; a clean cancel reads **"Cancelled — nothing moved"**.

### 14.2 Favourites do not prompt, and that is correct

Not a bug — **§12.2's checklist line was wrong and has been corrected.** `createFavoriteRequest` lets the platform decide whether to ask, and it asked on none of the three targets. What matters is that Afterglow never trusts the outcome: `applyFavouriteBatch` re-reads every `IS_FAVORITE` flag and only drains the queue on a match. The destructive path is the one that must prompt, and it does.

### 14.3 The album allow-list was an unvetted assumption — and Android's rule is real

`ORGANIZE_ROOTS = ['DCIM/', 'Pictures/']` was tagged `(autonomous)` in m0.7 and never reached Tristan. It refused an ordinary "move this to Downloads" with copy that read like Android's rule rather than ours.

**Both halves of that turned out to matter, in opposite directions:**

- The restriction was *right*. Measured in-app on the S10e: `IllegalArgumentException: Primary directory Download not allowed for content://media/external_primary/images/media/143737; allowed directories are [DCIM, Pictures]`. The photo was not moved.
- The *architecture* was wrong. A hand-copy of Android's rule is a second source of truth that drifts, and it was stated to the user as though it were ours.

**Decision (Tristan): Android is the only authority.** So `validateOrganizeTarget` no longer consults an allow-list — it checks only what is genuinely ours (the volume, path sanity) — and a refusal is explained by §13's dialog in Android's own words. That is exactly what happened above: no tier-1 rule existed for this case, and tier 3 carried the entire answer, allow-list included.

**Plus the filter Tristan asked for.** `androidAllowsImagesIn` mirrors the measured allow-list for the **picker only**, so the app stops offering targets the next step refuses. Being a convenience rather than an authority is what makes the duplication safe: if Android widens the rule this filter is merely stale — it can hide an option that would have worked, but can never block a move the platform allows, because nothing downstream reads it.

Unplanned bonus: `Android/media/<pkg>` albums fail the same prefix test, so **WhatsApp Images (871) and CACHE_IMAGE (800) also left the picker** — the ownership refusal from §13 can no longer be reached from the destination side at all.

### 14.4 Three plural bugs

Found by the sweep behind `REVIEW_CLASSES.md` 46: `SettingsScreen.tsx:217-218` ("1 photos kept" / "1 photos removed") and `ShareQueueScreen.tsx:218` ("Clear all 1 photos"). Fixed.

### 14.5 Re-verification

727 tests in 47 files; typecheck, lint, format clean. Release APK rebuilt (`sdkVersion:'30'` / `targetSdkVersion:'36'`, versionCode 11) and installed on all three targets. **Both UI gates re-run and PASSED**, 28/28 each, zero failure screenshots. Downloads confirmed absent from the picker and legal albums confirmed still present, on device.