/**
 * Canonical volume-qualified photo identity (m0.7 gate 1, P4#2) — PURE
 * helpers, no Expo/React Native imports, so db stores and Node tests can
 * share them. media.ts re-exports these for app callers.
 *
 * Every photo id in core/SQLite is `<volume>/<raw MediaStore id>`. Until
 * the multi-volume catalog refines ingestion, the legacy Expo query's
 * assets are primary external storage (autonomous, single-volume
 * assumption).
 */

export const PRIMARY_VOLUME = 'external_primary';

export function canonicalPhotoId(volumeName: string, rawId: string): string {
  return `${volumeName}/${rawId}`;
}

/** The raw MediaStore id of a canonical id (tolerant of legacy bare ids). */
export function rawIdOf(canonicalId: string): string {
  const slash = canonicalId.lastIndexOf('/');
  return slash < 0 ? canonicalId : canonicalId.slice(slash + 1);
}

/** The volume of a canonical id (bare legacy ids map to primary). */
export function volumeOf(canonicalId: string): string {
  const slash = canonicalId.lastIndexOf('/');
  return slash < 0 ? PRIMARY_VOLUME : canonicalId.slice(0, slash);
}
