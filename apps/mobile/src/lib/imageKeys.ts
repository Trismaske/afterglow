/**
 * Image cache keys (m0.9 phase 3, item 3): every decoded-pixel cache in
 * the app — Glide's disk cache behind expo-image, the OS-thumbnail
 * retention — keys by asset id AND the row's image version
 * (COALESCE(file_generation, file_mtime), see database.ts v23), so an
 * in-place edit can never serve pre-edit pixels past the next scan.
 * Pure; one function so the two caches can never disagree on shape.
 */

export function imageCacheKey(assetId: string, version: number): string {
  return `${assetId}:${version}`;
}
