/**
 * Photo-source catalog + selection resolution (m0.3.1) — the impure side
 * of sources.ts. Talks to MediaStore (album/bucket listing, one-asset
 * directory probes) and SQLite (the persisted selection).
 *
 * The catalog (API 30+) comes from ONE native cursor walk
 * (media-store-actions listImageAlbums: bucket → relative path + count).
 * Below API 30 the expo fallback probes each bucket with a `first: 1`
 * asset query and derives the directory from the asset's file uri.
 * Results are cached 10 min with a single-flighted cold build
 * (invalidated when the picker saves).
 */
import * as MediaLibrary from 'expo-media-library/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  listImageAlbums,
  mediaStoreActionsAvailable,
  type VolumeAlbum,
} from '../../modules/media-store-actions';
import { invalidatePhotoCounts } from './media';
import { perfLog } from './perfLog';
import {
  DEFAULT_SOURCE_DIR,
  foldAlbumsToDirs,
  isUnderAnyRoot,
  matchAlbumIds,
  matchAlbumIdsByVolume,
  parsePhotoSourceSetting,
  PHOTO_SOURCES_KEY,
  sourceDirOfUri,
  sourceLabel,
  type PhotoSourceSetting,
  type SourceDir,
  type SourceRoot,
} from './sources';
import { PRIMARY_VOLUME, volumeOfUriPath } from './mediaIdentity';
import { getSetting } from '../db/store';

// The catalog entry shape + its pure fold live in sources.ts (the pure
// side of this pair); re-exported here for the existing consumers.
export type { SourceDir } from './sources';

/** 10 min (m0.8.1, was 60 s): the catalog is consulted by EVERY screen
 * loader via resolveSources, and a cold rebuild costs one MediaStore
 * probe per bucket — the recurring "screens load slowly" cost on older
 * devices. The picker force-refreshes and saves invalidate explicitly;
 * a brand-new album appearing in the DEFAULT-source resolution within
 * 10 min is acceptable staleness. */
const CATALOG_TTL_MS = 600_000;

let catalogCache: { at: number; dirs: SourceDir[] } | null = null;
/** In-flight cold build, shared by concurrent callers (m0.8.1): the
 * startup refresh, the Home loaders, and the scan all resolve sources
 * within the same second — without single-flight each ran its OWN full
 * catalog build (3× the cost, device-observed). */
let catalogBuild: Promise<SourceDir[]> | null = null;

/** Short-lived memo + single-flight for the RESOLVED selection (m0.8.1):
 * a single Home focus resolved sources twice, DayProgress twice, and cold
 * start four times — each re-reading the setting and re-walking
 * matchAlbumIds over the whole bucket catalog (~900 on the S10e). The
 * window only needs to span one burst of loaders; picker saves invalidate
 * explicitly, and the settings flows use refreshScoped with explicit
 * roots, so a stale read can never leave an old scope actionable. */
const RESOLVED_TTL_MS = 5_000;
let resolvedCache: { at: number; value: ResolvedSources } | null = null;
let resolvedInFlight: Promise<ResolvedSources> | null = null;

/**
 * Cache generation. Nulling the caches is not enough on its own: a build
 * or resolution already IN FLIGHT still lands afterwards, and its
 * `.then` would happily repopulate the cache with the selection the user
 * has just replaced — so saving a new source could be silently undone by
 * a request that started before the save. Every writer captures this
 * counter first and only commits if it is still current.
 */
let cacheGeneration = 0;

/** Drop the cached catalog (picker saves, pull-to-refresh style paths). */
export function invalidateSourceCatalog(): void {
  cacheGeneration += 1;
  catalogCache = null;
  albumsCache = null;
  albumsInFlight = null;
  resolvedCache = null;
  resolvedInFlight = null;
  invalidatePhotoCounts();
}

/**
 * Every photo directory on the device, derived from MediaStore buckets,
 * sorted by path. Buckets whose directory can't be derived (no photo
 * asset, non-file uri) are skipped — they contribute no photos anyway.
 *
 * Fast path (API 30+): ONE native cursor walk (`listImageAlbums`)
 * returns every bucket's relative path + count — the expo fallback
 * costs one MediaStore probe PER bucket (an S10e with 895 buckets spent
 * 35 s here; the native walk is a few hundred ms).
 */
export async function listSourceDirs(force = false): Promise<SourceDir[]> {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.dirs;
  }
  if (!force && catalogBuild) return catalogBuild;
  if (force) {
    // Fence AND clear down to the raw album cache (codex r4+r5): a
    // rebuild over the same stale bucket list would only launder its
    // staleness, and an ORDINARY build already in flight must not land
    // after this forced one and repopulate the caches it bypassed. The
    // bump happens BEFORE the build captures its generation, so the
    // forced result itself still commits.
    cacheGeneration += 1;
    catalogCache = null;
    albumsCache = null;
    albumsInFlight = null;
    resolvedCache = null;
    resolvedInFlight = null;
  }
  const build = buildCatalog();
  catalogBuild = build;
  // Every sharer sees the SAME rejection (fail-closed: callers keep
  // their last-known scope); the side chain only prevents an
  // unhandled-rejection warning and clears the slot for a fresh retry.
  void build
    .catch(() => {})
    .finally(() => {
      if (catalogBuild === build) catalogBuild = null;
    });
  return build;
}

/** The raw native bucket list, cached + single-flighted (m0.8.1): the
 * album pickers each ran their OWN full cursor walk per open while the
 * catalog cached the identical call. */
const ALBUMS_TTL_MS = 60_000;
let albumsCache: { at: number; albums: VolumeAlbum[] } | null = null;
let albumsInFlight: Promise<VolumeAlbum[]> | null = null;

export async function listImageAlbumsCached(force = false): Promise<VolumeAlbum[]> {
  if (force) {
    // Bump the generation, not just the caches: an ORDINARY query
    // already in flight would otherwise land after this forced one and
    // repopulate every cache with the stale bucket set the force exists
    // to bypass (codex r5) — same fence as invalidateSourceCatalog.
    cacheGeneration += 1;
    albumsCache = null;
    albumsInFlight = null;
  }
  if (albumsCache && Date.now() - albumsCache.at < ALBUMS_TTL_MS) return albumsCache.albums;
  if (albumsInFlight) return albumsInFlight;
  const pending = listImageAlbums();
  const generation = cacheGeneration;
  albumsInFlight = pending;
  void pending
    .then((albums) => {
      if (generation !== cacheGeneration) return; // invalidated mid-flight
      albumsCache = { at: Date.now(), albums };
    })
    .catch(() => {})
    .finally(() => {
      if (albumsInFlight === pending) albumsInFlight = null;
    });
  return pending;
}

async function buildCatalog(): Promise<SourceDir[]> {
  const started = Date.now();
  // Captured BEFORE any await: a picker save landing mid-build must not
  // be overwritten by this build's result (see cacheGeneration).
  const generation = cacheGeneration;
  const commit = (dirs: SourceDir[]): SourceDir[] => {
    if (generation === cacheGeneration) catalogCache = { at: Date.now(), dirs };
    return dirs;
  };
  if (mediaStoreActionsAvailable()) {
    // A forced listSourceDirs cleared the album cache before this build,
    // so the plain call is fresh exactly when freshness was demanded.
    const albums = await listImageAlbumsCached();
    // Keyed by (volume, dir) — m0.8.3 D4: volume identity is preserved,
    // so DCIM/Camera on primary and on the SD card stay two entries.
    const dirs = commit(foldAlbumsToDirs(albums));
    perfLog(() => `source catalog (native): ${albums.length} buckets in ${Date.now() - started}ms`);
    return dirs;
  }
  const albums = await MediaLibrary.getAlbumsAsync();
  let failedProbes = 0;
  // Probe buckets CONCURRENTLY (m0.8.1, was sequential): each probe is
  // one first:1 MediaStore query; dozens of buckets in series took
  // multiple seconds per cold rebuild on older devices. Results are
  // folded in the ORIGINAL album order so dir aggregation stays
  // deterministic.
  const PROBE_CONCURRENCY = 6;
  const probes: ({ albumId: string; uri: string; totalCount: number } | null | 'failed')[] =
    new Array(albums.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, albums.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= albums.length) return;
        try {
          const page = await MediaLibrary.getAssetsAsync({
            first: 1,
            album: albums[index].id,
            mediaType: MediaLibrary.MediaType.photo,
          });
          const asset = page.assets[0];
          probes[index] =
            asset && page.totalCount > 0
              ? { albumId: albums[index].id, uri: asset.uri, totalCount: page.totalCount }
              : null;
        } catch {
          probes[index] = 'failed';
        }
      }
    }),
  );
  const probedAlbums: Parameters<typeof foldAlbumsToDirs>[0][number][] = [];
  for (const probe of probes) {
    if (probe === null) continue;
    if (probe !== 'failed') {
      const dir = sourceDirOfUri(probe.uri);
      // SAME volume identity as ingestion (codex r1): the probe asset's
      // uri parses under mechanism D exactly like the scan's assets, so
      // a legacy device's SD bucket gets its real volume — a
      // primary-labeled root over UUID-stamped rows would silently
      // empty every dir-scoped read. A bucket whose uri parses to no
      // volume is skipped, matching the adapter skipping its photos.
      const volume = volumeOfUriPath(probe.uri);
      if (dir === null || volume === null) continue;
      probedAlbums.push({
        volumeName: volume,
        bucketId: probe.albumId,
        relativePath: `${dir}/`,
        photoCount: probe.totalCount,
      });
    } else {
      // One unreadable bucket must not sink the whole catalog.
      failedProbes += 1;
    }
  }
  if (failedProbes > 0) {
    // ANY failed probe makes the catalog incomplete — if the missing
    // bucket is DCIM/Camera, the unset-default resolution would conclude
    // Camera does not exist and silently broaden to "all folders". Fail
    // so callers keep their last-known scope (never cached).
    throw new Error(`source catalog incomplete — ${failedProbes} album probes failed`);
  }
  const dirs = commit(foldAlbumsToDirs(probedAlbums));
  // Field diagnostic (once per cold rebuild): this is the shared cost of
  // every screen's source resolution — regressions show up here first.
  perfLog(() => `source catalog: ${albums.length} buckets probed in ${Date.now() - started}ms`);
  return dirs;
}

/** The resolved photo-source selection, ready to filter queries with. */
export interface ResolvedSources {
  setting: PhotoSourceSetting;
  /** True when nothing is persisted and the default applied. */
  isDefault: boolean;
  /** Bucket ids to query — null = all folders (no filter). */
  albumIds: string[] | null;
  /** The same matched buckets grouped per volume (m0.8.3 phase 2) — the
   * per-volume scan tripwires' MediaStore-count scope. Null = all
   * folders (per-volume counts come from the native counter instead). */
  albumIdsByVolume: Record<string, string[]> | null;
  /** Selected volume-qualified roots for DB-side matching — null = all
   * folders. */
  roots: SourceRoot[] | null;
  /** "DCIM/Camera" / "All folders" / "DCIM/100MSDCF (SD card) +2 more". */
  label: string;
}

/**
 * Resolve the persisted selection against the live catalog. Unset (or
 * unparseable) setting → the default: "DCIM/Camera" when any bucket
 * lives under it, otherwise "All folders". The default stays dynamic
 * until the user saves an explicit choice in the picker.
 */
export async function resolveSources(
  db: SQLiteDatabase,
  options?: {
    /** Bypass BOTH caches down to the raw bucket walk. The scan resolves
     * fresh before an actual pass (codex r4): a ten-minute-old catalog
     * can miss a brand-new bucket under a recursive root, and a pass
     * that then advances the generation baseline would claim it verified
     * photos it never enumerated. Costs one native catalog walk — paid
     * only when a pass actually runs, never on the skip path. */
    fresh?: boolean;
  },
): Promise<ResolvedSources> {
  const fresh = options?.fresh === true;
  if (!fresh) {
    if (resolvedCache && Date.now() - resolvedCache.at < RESOLVED_TTL_MS)
      return resolvedCache.value;
    if (resolvedInFlight) return resolvedInFlight;
  }
  const pending = resolveSourcesWithRetry(db, fresh);
  const generation = cacheGeneration;
  resolvedInFlight = pending;
  void pending
    .then((value) => {
      if (generation !== cacheGeneration) return; // invalidated mid-flight
      resolvedCache = { at: Date.now(), value };
    })
    .catch(() => {})
    .finally(() => {
      if (resolvedInFlight === pending) resolvedInFlight = null;
    });
  return pending;
}

/** Transient catalog failures RETRY before anyone falls back (Tristan's
 * call): a busy provider usually answers on the second ask, and going
 * straight to keep-last is not trying hard enough. Failures are never
 * cached, so plain re-attempts are safe; the retries live INSIDE the
 * single flight, so concurrent callers share one retrying resolution. */
const RESOLVE_ATTEMPTS = 5;
const RESOLVE_RETRY_MS = 100;

async function resolveSourcesWithRetry(
  db: SQLiteDatabase,
  force: boolean,
): Promise<ResolvedSources> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RESOLVE_RETRY_MS));
    try {
      return await resolveSourcesUncached(db, force);
    } catch (error) {
      lastError = error;
    }
  }
  console.warn(`[sources] resolution failed after ${RESOLVE_ATTEMPTS} attempts`);
  throw lastError;
}

async function resolveSourcesUncached(db: SQLiteDatabase, force = false): Promise<ResolvedSources> {
  const stored = parsePhotoSourceSetting(await getSetting(db, PHOTO_SOURCES_KEY));
  if (stored?.mode === 'all') {
    return {
      setting: stored,
      isDefault: false,
      albumIds: null,
      albumIdsByVolume: null,
      roots: null,
      label: sourceLabel(stored),
    };
  }
  const dirs = await listSourceDirs(force);
  if (stored) {
    return {
      setting: stored,
      isDefault: false,
      albumIds: matchAlbumIds(dirs, stored.dirs),
      albumIdsByVolume: matchAlbumIdsByVolume(dirs, stored.dirs),
      roots: stored.dirs,
      label: sourceLabel(stored),
    };
  }
  // The default source resolves against the PRIMARY volume (plan §2) —
  // an SD card's DCIM/Camera must not satisfy the probe.
  const defaultRoot: SourceRoot = { volume: PRIMARY_VOLUME, dir: DEFAULT_SOURCE_DIR };
  const hasCamera = dirs.some((d) => isUnderAnyRoot(d.volume, d.dir, [defaultRoot]));
  if (hasCamera) {
    const setting: PhotoSourceSetting = { mode: 'dirs', dirs: [defaultRoot] };
    return {
      setting,
      isDefault: true,
      albumIds: matchAlbumIds(dirs, setting.dirs),
      albumIdsByVolume: matchAlbumIdsByVolume(dirs, setting.dirs),
      roots: setting.dirs,
      label: sourceLabel(setting),
    };
  }
  const setting: PhotoSourceSetting = { mode: 'all' };
  return {
    setting,
    isDefault: true,
    albumIds: null,
    albumIdsByVolume: null,
    roots: null,
    label: sourceLabel(setting),
  };
}
