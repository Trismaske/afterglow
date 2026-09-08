/**
 * Image cache identity (m0.9 phase 3, item 3): every decoded-pixel cache
 * in the app keys by asset id AND the row's image version
 * (COALESCE(file_generation, file_mtime), database.ts v23), so an
 * in-place edit can never serve pre-edit pixels past the next scan.
 *
 * TWO carriers, one version, because expo-image has two key paths
 * (verified in its Android source, records/SourceMap.kt): a remote URL
 * takes the `cacheKey` prop (GlideUrlWithCustomCacheKey), but a LOCAL
 * `file://` URI becomes a raw string model — Glide keys it by the URI
 * text alone and `cacheKey` is silently ignored. So:
 *
 * - `imageCacheKey` — the retention key for OS thumbnails (ours) and the
 *   `recyclingKey` for expo-image views (a new key resets the recycled
 *   view instead of keeping its pixels).
 * - `versionedUri` — the file URI with the version as a query string:
 *   `Uri.getPath()` drops the query when the file is opened, Glide's key
 *   keeps it, so an edited photo is a fresh decode. The S23 stage stayed
 *   on a pre-edit picture until this (2026-09-08).
 */

export function imageCacheKey(assetId: string, version: number): string {
  return `${assetId}:${version}`;
}

export function versionedUri(uri: string, version: number): string {
  return `${uri}${uri.includes('?') ? '&' : '?'}v=${version}`;
}
