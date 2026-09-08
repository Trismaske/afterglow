/**
 * Canonical volume-qualified photo identity (m0.7 gate 1, P4#2) — PURE
 * helpers, no Expo/React Native imports, so db stores and Node tests can
 * share them. media.ts re-exports these for app callers.
 *
 * Every photo id in core/SQLite is `<volume>/<raw MediaStore id>`. The
 * volume is REAL (m0.8.3, D7 mechanism D): parsed from the asset's uri
 * path by `volumeOfUriPath` below and validated against the mounted
 * volume set at scan-pass start — never assumed primary.
 */

export const PRIMARY_VOLUME = 'external_primary';

/**
 * Mechanism D (m0.8.3, D7): true volume identity from a legacy-API asset
 * uri ("file://" + raw MediaStore DATA path). Spike-A-verified shapes
 * (S10e, Android 12):
 *
 *   /storage/emulated/<N>/… → 'external_primary'  (any Android user N)
 *   /storage/<UUID>/…       → the lowercased UUID (MediaStore volume
 *                             names are the volume UUID, lowercased —
 *                             spike A2: volume_name '0a91-e18d' for the
 *                             card at /storage/0A91-E18D)
 *
 * Legacy primary aliases (`/sdcard/…`, `/mnt/sdcard/…`,
 * `/storage/self/primary/…`) map to primary —
 * defensive path parsing, not a version gate: an OEM emitting one of
 * those shapes would make the whole library unparseable, and a failed
 * parse is a fail-closed skip. Anything else — no file:// path, a relative path, a bare
 * /storage file — returns null: FAIL CLOSED. Callers skip such rows
 * loudly and must not advance any scan baseline over them; shape
 * validation beyond this parse is the caller's mounted-volume-set check
 * (a parsed volume not in the set is equally skipped).
 */
export function volumeOfUriPath(uri: string): string | null {
  const path = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  if (!path.startsWith('/')) return null;
  if (/^\/storage\/emulated\/\d+\//.test(path)) return PRIMARY_VOLUME;
  if (/^\/(?:sdcard|mnt\/sdcard|storage\/self\/primary)\//.test(path)) return PRIMARY_VOLUME;
  const m = path.match(/^\/storage\/([^/]+)\//);
  if (m && m[1] !== 'emulated' && m[1] !== 'self') return m[1].toLowerCase();
  return null;
}

export function canonicalPhotoId(volumeName: string, rawId: string): string {
  return `${volumeName}/${rawId}`;
}

/** Media kinds the data layer stores (m0.9 phase 4) — mirrors core's
 * `MediaKind`; duplicated here so this file stays import-free. Motion
 * photos are `'photo'` (their still is the row; the embedded video is a
 * fact ON the row, `motion_video_offset`). */
export type StoredMediaKind = 'photo' | 'video';

/** An item as every kind-aware action addresses it: the canonical id plus
 * the stored kind that picks its MediaStore collection. Built from rows
 * (every uri-bearing SELECT projects `kind`), never guessed. */
export interface MediaRef {
  id: string;
  kind: StoredMediaKind;
}

/**
 * The volume-qualified MediaStore content URI for a canonical id — THE
 * uri every action (trash, favourite, edit, share, presence, EXIF read)
 * addresses an item by (m0.8.3, codex r1). KIND-AWARE (m0.9 phase 4):
 * MediaStore's images and video collections are views over one files
 * table, so a raw id is unique across kinds on its volume, but each
 * collection only answers for its own kind — the stored kind picks the
 * collection, and every consumer passes it. Constructed, never resolved:
 * Expo's reverse lookup queries the MERGED external collection by raw
 * `_ID` alone, and raw ids can collide across volumes (measured, S10e
 * 2026-07-30: each volume's DB allocates independently and the id
 * ranges fully interleave — 0 live collisions that day, but a collision
 * is one insertion pattern away, not hash-grade rare), so a resolved uri
 * can silently address another volume's photo. Spike A6 proved the
 * volume-qualified shape resolves rows on the right volume and that a
 * wrong-volume uri does NOT resolve — fail-closed beats mis-addressed.
 */
export function canonicalContentUri(canonicalId: string, kind: StoredMediaKind): string {
  const collection = kind === 'video' ? 'video' : 'images';
  return `content://media/${volumeOf(canonicalId)}/${collection}/media/${rawIdOf(canonicalId)}`;
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
