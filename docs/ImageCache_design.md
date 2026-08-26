# Image-cache growth: the requirement and the investigation

**Status:** requirement captured 2026-08-26 (Tristan, at the m0.8.8 ship) — an URGENT input into m0.9's final scoping, which already carries the related `content://` thumbnail work.
This doc holds the requirement, the measured findings, and the design tensions; it retires into the release plan that implements it.

## The alarm, measured

On the S23 (27,466-photo library, 100% full — 522 MB free, an APK install FAILED for space):

- One fresh install plus ONE device-pass session — the first scan, browsing, and **fewer than 100 photos reviewed** — grew the app's on-device footprint such that resetting it reclaimed **~1.5 GB** (578 MB → 2.1 GB free; the delta bundles data + cache + install churn, so the split is *derived*, not measured — the pre-reset breakdown was destroyed by the reset itself).
- On the S10e (6.9k library), **measured post-reset regrowth after a single session**: 353 MB app data + 285 MB cache (`dumpsys diskstats`).
- The *justified* durable cost at 27k photos is ~200 MB: embeddings are exactly 140.6 MB (1280 × float32 × 27,466), plus the photo/group/action tables and indexes.

Everything above that line is caches and logs regrowing without bound or lifecycle. A gigabyte-plus from barely using the app, on devices that are full in real life, is not acceptable.

## What the investigation established (expo-image 57 / Glide, read from the installed source)

1. **The view path disk-caches through Glide** with the default AUTOMATIC strategy (decoded RESULTS for local files) unless `cachePolicy` is `none`/`memory` (`ExpoImageViewWrapper.kt:438-446`). Every grid square, strip thumb, and view-size pager decode lands in the cache, keyed by uri — 27k thumbnails of demand.
2. **Nothing configures the Android disk cache size** — expo-image's `AppGlideModule` sets only logging (`ExpoImageAppGlideModule.kt`), so Glide's default ~250 MB LRU cap applies. The S10e's measured 285 MB "cache" bucket is consistent with that cap plus journal slack and other `cacheDir` tenants.
3. **JS-side cache control on Android is nearly all-or-nothing**: `Image.clearDiskCache()` nukes everything; `Image.configureCache()` is **iOS-only**. There is no supported per-key eviction.
4. **A per-key primitive may exist by the back door**: `Image.getCachePathAsync(cacheKey)` returns the cached file's path, and the `cacheKey` prop / `writeToCacheAsync`/`readFromCacheAsync` support explicit keys — deleting the returned file directly is a plausible targeted purge. UNVERIFIED (spike: does Glide's DiskLruCache tolerate external deletion as a clean miss?).
5. **The Glide cap means Glide may not even be the bulk.** If its LRU holds ~250 MB, the S23's remaining ~GB lived elsewhere — the prime suspect is **SQLite WAL bloat**: the initial scan writes heavily while long-running reads (the Everything filter's measured 68–179 s pages, see TODO "Everything livelocks behind the initial full scan") starve checkpoints, and a starved WAL grows without bound. UNVERIFIED (a force-stop probe was inconclusive — `diskstats` lags; spike below).

## The requirement (Tristan)

The image cache must be **bounded and review-lifecycle-aware**, not grow-until-manual-cleanup:

- When a group is **fully decided**, the cached images for its photos are very unlikely to be needed again — purge them when the user leaves the group.
- Re-browsing a decided group simply rebuilds its cache entries on demand (decode cost, no correctness cost).
- The steady-state cache should stay small on a device where review is keeping up.

## Design tensions to settle at scoping (do not skip these)

1. **Measure before mechanism.** If the bulk is WAL, the fix is checkpoint discipline (`PRAGMA wal_checkpoint(TRUNCATE)` after scan sessions and on app background), which is cheap, safe, and entirely different from cache eviction. If the bulk is Glide, eviction policy matters. The composition spike below decides which fix carries the gigabyte.
2. **The cache is uri-keyed and CROSS-SURFACE.** A group-lifecycle purge evicts thumbnails that Timeline, History, and the Progress grids still render for decided photos — those surfaces would re-decode on every visit. Quantify that cost before adopting per-group purge as the shape; a byte-budget approach (like the zoom pipeline's D7 retention) may fit the requirement with less collateral.
3. **The m0.9 `content://` thumbnail work overlaps structurally** (TODO "Hi-res group entry shows a black stage for ~5 s"): serving grids/strips from MediaStore's OS-owned thumbnails removes most of our duplicate cache demand at the source AND fixes the hi-res load stall. If m0.9 lands it, the lifecycle purge may only need to cover the large view-size pager entries. Decide the two together — the requirement here may be mostly satisfied by that work plus a WAL fix, with explicit purging as the remainder.

## Spikes (each small, each unblocks a decision)

1. **Cache composition audit** on a scanned device: break the app's storage into DB main file, WAL, Glide cache dir, diag sink, everything else (via `run-as` on a debuggable build, or a temporary in-app `[perf]` line walking its own dirs — the sink is the diagnostics API). This assigns the gigabyte.
2. **WAL behavior**: measure WAL size during and after an initial scan; verify whether checkpoint starvation occurs under concurrent reads, and whether `wal_checkpoint(TRUNCATE)` at scan-end/background reclaims it.
3. **Per-key eviction**: set an explicit `cacheKey` on one surface, delete the `getCachePathAsync` file, confirm Glide treats it as a clean miss across restarts.

## Candidate mechanisms, ranked by leverage (pending the spikes)

1. `content://` thumbnails for grids/strips (m0.9, already scoped) — removes the demand instead of managing it.
2. WAL checkpoint discipline at scan-end and app-background — if spike 2 confirms, likely the single biggest reclaim.
3. Lifecycle purge for large entries (pager-size decodes) via the explicit-`cacheKey` + file-delete primitive — the targeted form of the requirement.
4. Periodic global `clearDiskCache()` at safe moments (e.g. unit advance with everything decided) — the blunt fallback if per-key eviction fails the spike.
