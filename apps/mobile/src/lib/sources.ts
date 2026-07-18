/**
 * Photo-source (folder) targeting logic (m0.3.1) — pure TypeScript,
 * unit-tested. The impure catalog (MediaStore album listing + directory
 * probing) lives in sourceCatalog.ts.
 *
 * MECHANISM. Android MediaStore "albums" are buckets: one bucket per
 * directory, non-recursive. The legacy expo-media-library builds
 * `asset.uri` as `"file://" + DATA` — a raw, un-percent-encoded
 * filesystem path — so a bucket's directory is derivable from any one of
 * its assets. A photo-source selection is a set of storage-relative
 * directory ROOTS (e.g. "DCIM/Camera"); a bucket matches when its
 * directory equals a root or lies underneath one (recursive by path
 * prefix, case-insensitive — internal storage is case-sensitive ext4 but
 * FAT SD cards are not, and case-insensitive matching is the safer
 * default for both).
 *
 * Two matchers exist on purpose:
 *  - MediaStore side: exact storage-relative path-prefix matching over
 *    the probed bucket directories → a set of album ids to query.
 *  - SQLite side (photos.uri): a `%/<root>/%` LIKE containment match
 *    (SQLite LIKE is ASCII-case-insensitive by default). This is slightly
 *    looser — "Pictures" would also match a hypothetical
 *    ".../Foo/Pictures/..." — accepted, since roots come from the real
 *    on-device directory list and such collisions are contrived.
 *
 * Limits (documented, deliberate):
 *  - Empty directories have no bucket, so they can't be picked until
 *    they contain a photo.
 *  - iOS uses `ph://` asset URIs with no directory concept — everything
 *    degrades to "All folders" there (Android-first, per PLAN.md).
 */

export type PhotoSourceSetting = { mode: 'all' } | { mode: 'dirs'; dirs: string[] };

/** settings-table key for the persisted photo-source selection. */
export const PHOTO_SOURCES_KEY = 'photo_sources';

/** Default root when the user never picked one and such assets exist. */
export const DEFAULT_SOURCE_DIR = 'DCIM/Camera';

/** Parse the persisted setting; null for absent/garbage (→ use default). */
export function parsePhotoSourceSetting(raw: string | null): PhotoSourceSetting | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as { mode?: unknown; dirs?: unknown };
    if (p.mode === 'all') return { mode: 'all' };
    if (
      p.mode === 'dirs' &&
      Array.isArray(p.dirs) &&
      p.dirs.length > 0 &&
      p.dirs.every((d): d is string => typeof d === 'string' && d.length > 0)
    ) {
      return { mode: 'dirs', dirs: [...p.dirs] };
    }
    return null;
  } catch {
    return null;
  }
}

export function serializePhotoSourceSetting(setting: PhotoSourceSetting): string {
  return JSON.stringify(setting);
}

/**
 * Directory of a legacy-API asset uri ("file:///…/DCIM/Camera/IMG.jpg" →
 * "/…/DCIM/Camera"). The uri is a raw path with a file:// prefix — no
 * percent-decoding. Returns null when no directory can be derived (iOS
 * ph:// uris, malformed values).
 */
export function dirOfUri(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  const path = uri.slice('file://'.length);
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return null;
  return path.slice(0, slash);
}

/** Storage-volume prefixes stripped to get the user-facing relative dir. */
const STORAGE_PREFIX = /^\/(?:storage\/emulated\/\d+|storage\/[^/]+|sdcard|mnt\/sdcard)\//;

/**
 * "/storage/emulated/0/DCIM/Camera" → "DCIM/Camera" (also handles SD-card
 * volumes like "/storage/ABCD-1234/…"). Unrecognized prefixes are kept
 * as-is — matching still works because both sides derive dirs the same way.
 */
export function storageRelativeDir(absDir: string): string {
  const m = absDir.match(STORAGE_PREFIX);
  return m ? absDir.slice(m[0].length) : absDir.replace(/^\//, '');
}

/** Storage-relative directory of an asset uri, or null. */
export function sourceDirOfUri(uri: string): string | null {
  const dir = dirOfUri(uri);
  return dir === null ? null : storageRelativeDir(dir);
}

/** Is `dir` equal to or underneath `root`? Case-insensitive, whole-segment. */
export function isUnderRoot(dir: string, root: string): boolean {
  const d = dir.toLowerCase();
  const r = root.toLowerCase();
  return d === r || d.startsWith(`${r}/`);
}

export function isUnderAnyRoot(dir: string, roots: readonly string[]): boolean {
  return roots.some((root) => isUnderRoot(dir, root));
}

/** Album ids whose directory lies under any selected root. */
export function matchAlbumIds(
  albums: readonly { albumIds: readonly string[]; dir: string }[],
  roots: readonly string[],
): string[] {
  const ids: string[] = [];
  for (const album of albums) {
    if (isUnderAnyRoot(album.dir, roots)) ids.push(...album.albumIds);
  }
  return ids;
}

/** Escape LIKE wildcards for use with `ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * LIKE pattern matching photos.uri values under a root — containment
 * match on "/<root>/" (see module docs for why this is acceptable).
 */
export function sourceLikePattern(root: string): string {
  return `%/${escapeLike(root)}/%`;
}

/** "All folders" / "DCIM/Camera" / "DCIM/Camera +2 more". */
export function sourceLabel(setting: PhotoSourceSetting): string {
  if (setting.mode === 'all') return 'All folders';
  const [first, ...rest] = setting.dirs;
  return rest.length === 0 ? first : `${first} +${rest.length} more`;
}
