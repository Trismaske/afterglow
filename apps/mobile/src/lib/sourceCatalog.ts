/**
 * Photo-source catalog + selection resolution (m0.3.1) — the impure side
 * of sources.ts. Talks to MediaStore (album/bucket listing, one-asset
 * directory probes) and SQLite (the persisted selection).
 *
 * Android buckets are per-directory and carry no path, only a display
 * name ("Camera") — so each bucket's directory is probed with one
 * `first: 1` asset query and derived from that asset's raw `file://`
 * uri. The probe also yields the bucket's photo count (totalCount) for
 * free, which the picker displays. ~1 cheap query per bucket; a device
 * typically has a few dozen buckets, and results are cached for 60 s
 * (invalidated when the picker saves).
 */
import * as MediaLibrary from 'expo-media-library/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  DEFAULT_SOURCE_DIR,
  isUnderAnyRoot,
  matchAlbumIds,
  parsePhotoSourceSetting,
  PHOTO_SOURCES_KEY,
  sourceDirOfUri,
  sourceLabel,
  type PhotoSourceSetting,
} from './sources';
import { getSetting } from '../db/store';

/** One selectable photo directory (bucket(s) sharing a relative path). */
export interface SourceDir {
  /** Storage-relative directory, e.g. "DCIM/Camera". */
  dir: string;
  /** Bucket ids for this dir — usually one; two when the same relative
   * path exists on two storage volumes (internal + SD card). */
  albumIds: string[];
  /** Photos in these buckets (non-recursive, like the buckets). */
  photoCount: number;
}

const CATALOG_TTL_MS = 60_000;

let catalogCache: { at: number; dirs: SourceDir[] } | null = null;

/** Drop the cached catalog (picker saves, pull-to-refresh style paths). */
export function invalidateSourceCatalog(): void {
  catalogCache = null;
}

/**
 * Every photo directory on the device, derived from MediaStore buckets,
 * sorted by path. Buckets whose directory can't be derived (no photo
 * asset, non-file uri) are skipped — they contribute no photos anyway.
 */
export async function listSourceDirs(force = false): Promise<SourceDir[]> {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.dirs;
  }
  const albums = await MediaLibrary.getAlbumsAsync();
  const byDir = new Map<string, SourceDir>();
  for (const album of albums) {
    try {
      const page = await MediaLibrary.getAssetsAsync({
        first: 1,
        album: album.id,
        mediaType: MediaLibrary.MediaType.photo,
      });
      const asset = page.assets[0];
      if (!asset || page.totalCount === 0) continue;
      const dir = sourceDirOfUri(asset.uri);
      if (dir === null) continue;
      const existing = byDir.get(dir.toLowerCase());
      if (existing) {
        existing.albumIds.push(album.id);
        existing.photoCount += page.totalCount;
      } else {
        byDir.set(dir.toLowerCase(), { dir, albumIds: [album.id], photoCount: page.totalCount });
      }
    } catch {
      // One unreadable bucket must not sink the whole catalog.
    }
  }
  const dirs = [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  catalogCache = { at: Date.now(), dirs };
  return dirs;
}

/** The resolved photo-source selection, ready to filter queries with. */
export interface ResolvedSources {
  setting: PhotoSourceSetting;
  /** True when nothing is persisted and the default applied. */
  isDefault: boolean;
  /** Bucket ids to query — null = all folders (no filter). */
  albumIds: string[] | null;
  /** Selected roots for DB-side uri matching — null = all folders. */
  roots: string[] | null;
  /** "DCIM/Camera" / "All folders" / "DCIM/Camera +2 more". */
  label: string;
}

/**
 * Resolve the persisted selection against the live catalog. Unset (or
 * unparseable) setting → the default: "DCIM/Camera" when any bucket
 * lives under it, otherwise "All folders". The default stays dynamic
 * until the user saves an explicit choice in the picker.
 */
export async function resolveSources(db: SQLiteDatabase): Promise<ResolvedSources> {
  const stored = parsePhotoSourceSetting(await getSetting(db, PHOTO_SOURCES_KEY));
  if (stored?.mode === 'all') {
    return {
      setting: stored,
      isDefault: false,
      albumIds: null,
      roots: null,
      label: sourceLabel(stored),
    };
  }
  const dirs = await listSourceDirs();
  if (stored) {
    return {
      setting: stored,
      isDefault: false,
      albumIds: matchAlbumIds(dirs, stored.dirs),
      roots: stored.dirs,
      label: sourceLabel(stored),
    };
  }
  const hasCamera = dirs.some((d) => isUnderAnyRoot(d.dir, [DEFAULT_SOURCE_DIR]));
  if (hasCamera) {
    const setting: PhotoSourceSetting = { mode: 'dirs', dirs: [DEFAULT_SOURCE_DIR] };
    return {
      setting,
      isDefault: true,
      albumIds: matchAlbumIds(dirs, setting.dirs),
      roots: setting.dirs,
      label: sourceLabel(setting),
    };
  }
  const setting: PhotoSourceSetting = { mode: 'all' };
  return { setting, isDefault: true, albumIds: null, roots: null, label: sourceLabel(setting) };
}
