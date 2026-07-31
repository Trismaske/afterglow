/**
 * Photo-source (folder) targeting logic (m0.3.1) — pure TypeScript,
 * unit-tested. The impure catalog (the MediaStore album listing) lives
 * in sourceCatalog.ts.
 *
 * MECHANISM. Android MediaStore "albums" are buckets: one bucket per
 * directory, non-recursive, each carrying its own RELATIVE_PATH (the
 * native cursor walk reads it directly — see sourceCatalog.ts). A
 * photo-source selection is a set of storage-relative
 * directory ROOTS (e.g. "DCIM/Camera"); a bucket matches when its
 * directory equals a root or lies underneath one (recursive by path
 * prefix, case-insensitive — internal storage is case-sensitive ext4 but
 * FAT SD cards are not, and case-insensitive matching is the safer
 * default for both).
 *
 * A root is VOLUME-QUALIFIED (m0.8.3, D4): `{ volume, dir }`, so the same
 * relative path on internal storage and an SD card is two distinct,
 * separately-pickable sources.
 *
 * Two matchers exist on purpose:
 *  - MediaStore side: exact storage-relative path-prefix matching over
 *    the listed bucket directories, WITHIN the root's volume → a set of
 *    album ids to query. The ids are bare BUCKET_IDs queried against the
 *    merged collection; a bucket id is Android's hash of the bucket's
 *    lowercased absolute path, and two volumes' paths differ by their
 *    mount prefix — so cross-volume aliasing needs a 32-bit hash
 *    collision. Accepted looseness, same tier as the LIKE containment
 *    below; the DB side stays volume-exact regardless (stamped
 *    volume_name), so a collision could only nudge MediaStore-side
 *    counts, where every mismatch falls back to a full pass.
 *  - SQLite side: `volume_name = ? AND uri LIKE '%/<root.dir>/%'` per
 *    root (SQLite LIKE is ASCII-case-insensitive by default). The LIKE
 *    half is slightly looser — "Pictures" would also match a
 *    hypothetical ".../Foo/Pictures/..." — accepted, since roots come
 *    from the real on-device directory list and such collisions are
 *    contrived.
 *
 * Limits (documented, deliberate):
 *  - Empty directories have no bucket, so they can't be picked until
 *    they contain a photo.
 *  - iOS uses `ph://` asset URIs with no directory concept — everything
 *    degrades to "All folders" there (Android-first, per PLAN.md).
 */
import { PRIMARY_VOLUME } from './mediaIdentity';

/** One volume-qualified source root (m0.8.3, D4). */
export interface SourceRoot {
  /** MediaStore volume name ('external_primary', or a lowercased UUID). */
  volume: string;
  /** Storage-relative directory, e.g. "DCIM/Camera". */
  dir: string;
}

export type PhotoSourceSetting = { mode: 'all' } | { mode: 'dirs'; dirs: SourceRoot[] };

/** settings-table key for the persisted photo-source selection. */
export const PHOTO_SOURCES_KEY = 'photo_sources';

/** Default root when the user never picked one and such assets exist. */
export const DEFAULT_SOURCE_DIR = 'DCIM/Camera';

/** Parse the persisted setting; null for absent/garbage (→ use default).
 * The pre-m0.8.3 path-only shape (`dirs: string[]`) parses as garbage on
 * purpose — it carries no volume and is not migrated (the v20 destructive
 * reset covers it; the default re-applies). */
export function parsePhotoSourceSetting(raw: string | null): PhotoSourceSetting | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as { mode?: unknown; dirs?: unknown };
    if (p.mode === 'all') return { mode: 'all' };
    if (p.mode === 'dirs' && Array.isArray(p.dirs) && p.dirs.length > 0) {
      const dirs: SourceRoot[] = [];
      for (const entry of p.dirs) {
        const root = entry as { volume?: unknown; dir?: unknown };
        if (
          typeof root !== 'object' ||
          root === null ||
          typeof root.volume !== 'string' ||
          root.volume.length === 0 ||
          typeof root.dir !== 'string' ||
          root.dir.length === 0
        ) {
          return null;
        }
        dirs.push({ volume: root.volume, dir: root.dir });
      }
      return { mode: 'dirs', dirs };
    }
    return null;
  } catch {
    return null;
  }
}

export function serializePhotoSourceSetting(setting: PhotoSourceSetting): string {
  return JSON.stringify(setting);
}

/** Is `dir` equal to or underneath `rootDir`? Case-insensitive, whole-segment. */
export function isUnderRoot(dir: string, rootDir: string): boolean {
  const d = dir.toLowerCase();
  const r = rootDir.toLowerCase();
  return d === r || d.startsWith(`${r}/`);
}

/** Does any root cover this (volume, dir)? Volumes must match exactly —
 * a root on the SD card never includes the same path on primary. */
export function isUnderAnyRoot(volume: string, dir: string, roots: readonly SourceRoot[]): boolean {
  return roots.some((root) => root.volume === volume && isUnderRoot(dir, root.dir));
}

/** Album ids whose (volume, directory) lies under any selected root. */
export function matchAlbumIds(
  albums: readonly { albumIds: readonly string[]; volume: string; dir: string }[],
  roots: readonly SourceRoot[],
): string[] {
  const ids: string[] = [];
  for (const album of albums) {
    if (isUnderAnyRoot(album.volume, album.dir, roots)) ids.push(...album.albumIds);
  }
  return ids;
}

/** Stable identity for a root — picker selection keys, dedup. */
export function rootKey(root: SourceRoot): string {
  return `${root.volume}|${root.dir.toLowerCase()}`;
}

/**
 * Matched album ids GROUPED BY VOLUME (m0.8.3 phase 2): the per-volume
 * scan tripwires need MediaStore counts scoped exactly like the tracked
 * counts, and a bucket belongs to one volume — so a volume's in-scope
 * MediaStore population is the sum over ITS buckets. Volumes whose roots
 * matched no bucket still get an entry ([]) so the tripwire reads them
 * as 0 rather than skipping them.
 */
export function matchAlbumIdsByVolume(
  albums: readonly { albumIds: readonly string[]; volume: string; dir: string }[],
  roots: readonly SourceRoot[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const root of roots) out[root.volume] ??= [];
  for (const album of albums) {
    if (isUnderAnyRoot(album.volume, album.dir, roots)) {
      (out[album.volume] ??= []).push(...album.albumIds);
    }
  }
  return out;
}

/** One selectable photo directory: bucket(s) sharing a (volume, relative
 * path). m0.8.3 (D4): the catalog stops erasing volume identity — the
 * same relative path on internal storage and an SD card is TWO entries. */
export interface SourceDir {
  /** MediaStore volume name ('external_primary' or a lowercased UUID). */
  volume: string;
  /** Storage-relative directory, e.g. "DCIM/Camera". */
  dir: string;
  /** Bucket ids for this (volume, dir) — usually one. */
  albumIds: string[];
  /** Photos in these buckets (non-recursive, like the buckets). */
  photoCount: number;
}

/**
 * Fold the raw native bucket list into catalog entries keyed by
 * (volume, dir) — the pure half of buildCatalog (sourceCatalog.ts).
 * Empty and zero-count buckets are skipped; two buckets sharing a
 * (volume, dir) merge; dir casing follows the first bucket seen.
 */
export function foldAlbumsToDirs(
  albums: readonly {
    volumeName: string;
    bucketId: string;
    relativePath: string;
    photoCount: number;
  }[],
): SourceDir[] {
  const byDir = new Map<string, SourceDir>();
  for (const album of albums) {
    const dir = album.relativePath.replace(/\/+$/, '');
    if (dir === '' || album.photoCount === 0) continue;
    const key = rootKey({ volume: album.volumeName, dir });
    const existing = byDir.get(key);
    if (existing) {
      existing.albumIds.push(album.bucketId);
      existing.photoCount += album.photoCount;
    } else {
      byDir.set(key, {
        volume: album.volumeName,
        dir,
        albumIds: [album.bucketId],
        photoCount: album.photoCount,
      });
    }
  }
  return [...byDir.values()].sort(
    (a, b) => a.dir.localeCompare(b.dir) || a.volume.localeCompare(b.volume),
  );
}

/** Escape LIKE wildcards for use with `ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * LIKE pattern matching photos.uri values under a root's dir —
 * containment match on "/<dir>/" (see module docs for why this is
 * acceptable). Always paired with a `volume_name = ?` term (m0.8.3, D4).
 */
export function sourceLikePattern(rootDir: string): string {
  return `%/${escapeLike(rootDir)}/%`;
}

/** The user-facing tag for a root's volume — non-primary roots wear it
 * in the picker and source labels (D4). One generic name: the app knows
 * volumes, not card brands. */
export function volumeTag(volume: string): string | null {
  return volume === PRIMARY_VOLUME ? null : 'SD card';
}

/** One root's display name: "DCIM/Camera", "DCIM/100MSDCF (SD card)". */
export function rootLabel(root: SourceRoot): string {
  const tag = volumeTag(root.volume);
  return tag === null ? root.dir : `${root.dir} (${tag})`;
}

/** "All folders" / "DCIM/Camera" / "DCIM/100MSDCF (SD card) +2 more". */
export function sourceLabel(setting: PhotoSourceSetting): string {
  if (setting.mode === 'all') return 'All folders';
  const [first, ...rest] = setting.dirs;
  const label = rootLabel(first);
  return rest.length === 0 ? label : `${label} +${rest.length} more`;
}
