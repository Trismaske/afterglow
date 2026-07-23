/**
 * MediaStore adapter — maps expo-media-library assets into core MediaItems.
 *
 * Uses the SDK 57 *legacy* API (`expo-media-library/legacy`) deliberately:
 * the new class-based Query/Asset API landed in SDK 57 and the legacy
 * functions (`getAssetsAsync` paging) are the documented, battle-tested path.
 * Destructive actions deliberately bypass the legacy delete API and use the
 * app's Android 11+ MediaStore trash-request module below.
 */
import * as MediaLibrary from 'expo-media-library/legacy';
import type { MediaItem } from '@afterglow/core';
import { trashMedia, type MediaStoreActionStatus } from '../../modules/media-store-actions';
import { tallyPhotoDays } from './recentMedia';

/**
 * Canonical volume-qualified identity (m0.7 gate 1, P4#2): every photo id
 * that leaves this adapter is `<volume>/<raw MediaStore id>`. This is THE
 * ingestion boundary (P5#1) — the legacy Expo asset's bare raw id never
 * reaches the core model or SQLite keys. Until the gate-3 native catalog
 * adds multi-volume awareness, everything the legacy Expo query returns is
 * primary external storage **(autonomous: single-volume assumption,
 * refined in gate 3)**.
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

/** A camera-roll photo: the core item plus MediaStore extras we persist.
 * `item.id` is the canonical volume-qualified id. */
export interface LoadedPhoto {
  item: MediaItem;
  rawId: string;
  volumeName: string;
  filename: string;
  modTime: number;
  width: number;
  height: number;
}

const PAGE_SIZE = 200;

function toLoadedPhoto(asset: MediaLibrary.Asset): LoadedPhoto {
  return {
    item: {
      id: canonicalPhotoId(PRIMARY_VOLUME, asset.id),
      // Some sources report 0 creationTime; fall back to modification
      // time so clustering stays best-effort instead of lumping them
      // all at epoch.
      timestamp: asset.creationTime || asset.modificationTime || 0,
      uri: asset.uri,
      kind: 'photo',
    },
    rawId: asset.id,
    volumeName: PRIMARY_VOLUME,
    filename: asset.filename,
    modTime: asset.modificationTime,
    width: asset.width,
    height: asset.height,
  };
}

/**
 * Page through the photos in [startMs, endMs], oldest first by default
 * (`descending` flips to newest first — m0.5 "newest first" sessions),
 * optionally restricted to one MediaStore album (bucket). `onPage`
 * receives each page and returns false to stop early — this is what
 * keeps large scopes (6 months / year / all time, m0.3.1) from ever
 * materializing the whole MediaStore in memory.
 */
export async function pagePhotosInRange(
  startMs: number,
  endMs: number,
  albumId: string | undefined,
  onPage: (page: LoadedPhoto[]) => boolean | Promise<boolean>,
  descending = false,
): Promise<void> {
  let after: string | undefined;
  for (;;) {
    const page = await MediaLibrary.getAssetsAsync({
      first: PAGE_SIZE,
      after,
      ...(albumId !== undefined ? { album: albumId } : {}),
      createdAfter: startMs,
      createdBefore: endMs,
      mediaType: MediaLibrary.MediaType.photo,
      sortBy: [[MediaLibrary.SortBy.creationTime, !descending]],
    });
    const keepGoing = await onPage(page.assets.map(toLoadedPhoto));
    if (!keepGoing || !page.hasNextPage || !page.endCursor) break;
    after = page.endCursor;
  }
}

/** One newest-first page of photos (progress grids, m0.4 stage 3). */
export interface DescendingPhotoPage {
  photos: LoadedPhoto[];
  /** Cursor for the next page; undefined when there is none. */
  endCursor: string | undefined;
  hasNext: boolean;
}

/**
 * Fetch one page of photos in [startMs, endMs], NEWEST first — the
 * building block for the progress photo grids' incremental loading
 * (progressPager.ts merges one such stream per source bucket). `after`
 * is the previous page's endCursor; undefined starts from the top.
 */
export async function fetchPhotoPageDesc(
  startMs: number,
  endMs: number,
  albumId: string | undefined,
  after: string | undefined,
  first: number,
): Promise<DescendingPhotoPage> {
  const page = await MediaLibrary.getAssetsAsync({
    first,
    after,
    ...(albumId !== undefined ? { album: albumId } : {}),
    createdAfter: startMs,
    createdBefore: endMs,
    mediaType: MediaLibrary.MediaType.photo,
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
  });
  return {
    photos: page.assets.map(toLoadedPhoto),
    endCursor: page.endCursor ?? undefined,
    hasNext: !!page.hasNextPage && !!page.endCursor,
  };
}

/**
 * How many photos MediaStore has in [startMs, endMs] — cheap `first: 1`
 * queries reading PagedInfo.totalCount, no asset paging. `albumIds`
 * restricts the count to those buckets (one query per bucket, summed);
 * null/undefined = all folders (single query). getAssetsAsync only
 * accepts a single album, hence the fan-out — the selected source is
 * typically one or two buckets.
 */
export async function countPhotosInRange(
  startMs: number,
  endMs: number,
  albumIds?: readonly string[] | null,
): Promise<number> {
  const buckets: (string | undefined)[] = albumIds ? [...albumIds] : [undefined];
  let total = 0;
  for (const album of buckets) {
    const page = await MediaLibrary.getAssetsAsync({
      first: 1,
      ...(album !== undefined ? { album } : {}),
      createdAfter: startMs,
      createdBefore: endMs,
      mediaType: MediaLibrary.MediaType.photo,
    });
    total += page.totalCount;
  }
  return total;
}

/**
 * Count photos per local day with one ranged scan per selected source bucket,
 * instead of one totalCount query per day. Paging is retained for unusually
 * busy weeks, but the common camera-roll case is a single MediaStore request.
 */
export async function countPhotosByDayInRange(
  startMs: number,
  endMs: number,
  albumIds?: readonly string[] | null,
): Promise<Map<string, number>> {
  const buckets: (string | undefined)[] = albumIds ? [...albumIds] : [undefined];
  const timestamps: number[] = [];
  const seen = new Set<string>();
  for (const album of buckets) {
    let after: string | undefined;
    for (;;) {
      const page = await MediaLibrary.getAssetsAsync({
        first: PAGE_SIZE,
        after,
        ...(album !== undefined ? { album } : {}),
        createdAfter: startMs,
        createdBefore: endMs,
        mediaType: MediaLibrary.MediaType.photo,
      });
      for (const asset of page.assets) {
        if (seen.has(asset.id)) continue;
        seen.add(asset.id);
        timestamps.push(asset.creationTime || asset.modificationTime || 0);
      }
      if (!page.hasNextPage || !page.endCursor) break;
      after = page.endCursor;
    }
  }
  return tallyPhotoDays(timestamps);
}

/** Live MediaStore details for one asset (edit detection, m0.3). */
export interface AssetDetails {
  id: string;
  filename: string;
  creationTime: number;
  modificationTime: number;
  uri: string;
  /** Readable file path when MediaStore exposes one (preferred for hashing). */
  localUri: string | null;
}

/**
 * Re-query one asset. Returns null when the asset no longer exists (or the
 * lookup fails) — callers treat that as "no detection signal".
 */
export async function getAssetDetails(assetId: string): Promise<AssetDetails | null> {
  try {
    // Accepts canonical volume-qualified ids; Expo wants the raw id.
    const info = await MediaLibrary.getAssetInfoAsync(rawIdOf(assetId));
    if (!info) return null;
    return {
      id: canonicalPhotoId(volumeOf(assetId), info.id),
      filename: info.filename,
      creationTime: info.creationTime,
      modificationTime: info.modificationTime,
      uri: info.uri,
      localUri: info.localUri ?? null,
    };
  } catch {
    return null;
  }
}

/** Candidate asset for edited-copy detection. */
export interface CandidateAsset {
  id: string;
  filename: string;
  creationTime: number;
  modificationTime: number;
  uri: string;
}

/**
 * Photos whose creationTime falls in [startMs, endMs] (endMs omitted =
 * open-ended), capped at `max` — candidate pool for edited-copy detection.
 * `albumIds` restricts the scan to the photo-source buckets (m0.3.1):
 * each bucket is paged newest-first up to `max`, then the union is
 * re-sorted and re-capped so the result is the newest `max` overall.
 */
export async function loadCandidatesCreatedBetween(
  startMs: number,
  endMs: number | undefined,
  max: number,
  albumIds?: readonly string[] | null,
): Promise<CandidateAsset[]> {
  const buckets: (string | undefined)[] = albumIds ? [...albumIds] : [undefined];
  const out: CandidateAsset[] = [];
  for (const album of buckets) {
    let loaded = 0;
    let after: string | undefined;
    while (loaded < max) {
      const page = await MediaLibrary.getAssetsAsync({
        first: Math.min(PAGE_SIZE, max - loaded),
        after,
        ...(album !== undefined ? { album } : {}),
        createdAfter: startMs,
        ...(endMs !== undefined ? { createdBefore: endMs } : {}),
        mediaType: MediaLibrary.MediaType.photo,
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      for (const asset of page.assets) {
        loaded++;
        out.push({
          id: canonicalPhotoId(PRIMARY_VOLUME, asset.id),
          filename: asset.filename,
          creationTime: asset.creationTime,
          modificationTime: asset.modificationTime,
          uri: asset.uri,
        });
      }
      if (!page.hasNextPage || !page.endCursor) break;
      after = page.endCursor;
    }
  }
  if (buckets.length > 1) {
    out.sort((a, b) => b.creationTime - a.creationTime);
    return out.slice(0, max);
  }
  return out;
}

/**
 * The `content://` URI for an asset — what ACTION_EDIT needs (external
 * editors can't be granted access to a raw `file://` path on modern
 * Android). Falls back to constructing the standard external-images URI
 * from the MediaStore id if the native lookup fails.
 */
/** How a content URI was obtained. The synthetic fallback shape matches the
 * URI in the captured Samsung editor failure, so gate-0 diagnostics must
 * know which path produced it. */
export interface EditableContentUri {
  uri: string;
  source: 'expo' | 'synthetic-fallback';
  resolveError?: string;
}

export async function getEditableContentUriDetailed(assetId: string): Promise<EditableContentUri> {
  // Accepts canonical volume-qualified ids; Expo wants the raw id.
  const rawId = rawIdOf(assetId);
  try {
    return { uri: await MediaLibrary.getAssetContentUriAsync(rawId), source: 'expo' };
  } catch (error) {
    return {
      uri: `content://media/${volumeOf(assetId)}/images/media/${rawId}`,
      source: 'synthetic-fallback',
      resolveError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getEditableContentUri(assetId: string): Promise<string> {
  return (await getEditableContentUriDetailed(assetId)).uri;
}

export interface TrashAssetsResult {
  status: MediaStoreActionStatus | 'failed';
  error?: string;
}

/**
 * Move assets to Android's recoverable system trash after the OS-owned
 * confirmation sheet. THIS IS THE ONLY MEDIA REMOVAL CALL IN THE APP.
 * There is deliberately no permanent-delete fallback below Android 11 or
 * when the native module is absent.
 */
export async function trashAssets(assetIds: readonly string[]): Promise<TrashAssetsResult> {
  if (assetIds.length === 0) return { status: 'applied' };
  try {
    const uris = await Promise.all(assetIds.map(getEditableContentUri));
    return await trashMedia(uris);
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
