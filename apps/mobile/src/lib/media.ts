/**
 * MediaStore adapter — maps expo-media-library assets into core MediaItems.
 *
 * Uses the SDK 57 *legacy* API (`expo-media-library/legacy`) deliberately:
 * the new class-based Query/Asset API landed in SDK 57 and the legacy
 * functions (`getAssetsAsync` paging, `deleteAssetsAsync` with the Android
 * system delete dialog) are the documented, battle-tested path. Revisit for
 * m0.2+ once the new API has settled.
 */
import * as MediaLibrary from 'expo-media-library/legacy';
import type { MediaItem } from '@afterglow/core';

/** A camera-roll photo: the core item plus MediaStore extras we persist. */
export interface LoadedPhoto {
  item: MediaItem;
  filename: string;
  modTime: number;
  width: number;
  height: number;
}

const PAGE_SIZE = 200;

function toLoadedPhoto(asset: MediaLibrary.Asset): LoadedPhoto {
  return {
    item: {
      id: asset.id,
      // Some sources report 0 creationTime; fall back to modification
      // time so clustering stays best-effort instead of lumping them
      // all at epoch.
      timestamp: asset.creationTime || asset.modificationTime || 0,
      uri: asset.uri,
      kind: 'photo',
    },
    filename: asset.filename,
    modTime: asset.modificationTime,
    width: asset.width,
    height: asset.height,
  };
}

/**
 * Page through the photos in [startMs, endMs], oldest first, optionally
 * restricted to one MediaStore album (bucket). `onPage` receives each
 * page and returns false to stop early — this is what keeps large scopes
 * (6 months / year / all time, m0.3.1) from ever materializing the whole
 * MediaStore in memory.
 */
export async function pagePhotosInRange(
  startMs: number,
  endMs: number,
  albumId: string | undefined,
  onPage: (page: LoadedPhoto[]) => boolean | Promise<boolean>,
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
      sortBy: [[MediaLibrary.SortBy.creationTime, true]],
    });
    const keepGoing = await onPage(page.assets.map(toLoadedPhoto));
    if (!keepGoing || !page.hasNextPage || !page.endCursor) break;
    after = page.endCursor;
  }
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
    const info = await MediaLibrary.getAssetInfoAsync(assetId);
    if (!info) return null;
    return {
      id: info.id,
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
          id: asset.id,
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
export async function getEditableContentUri(assetId: string): Promise<string> {
  try {
    return await MediaLibrary.getAssetContentUriAsync(assetId);
  } catch {
    return `content://media/external/images/media/${assetId}`;
  }
}

/**
 * Delete the given assets via the system flow. On Android 11+ this raises
 * the system confirmation dialog and moves photos to the system trash
 * (30-day recovery). Resolves `true` only if the deletion went through;
 * `false` means the user cancelled. THIS IS THE ONLY DELETION CALL IN THE
 * APP — nothing else may delete media. Reachable from exactly two explicit
 * user actions: the cull-list confirm button, and the "cull the original"
 * choice after an edited copy is detected (m0.3).
 */
export async function deleteAssets(assetIds: readonly string[]): Promise<boolean> {
  if (assetIds.length === 0) return true;
  try {
    return await MediaLibrary.deleteAssetsAsync([...assetIds]);
  } catch {
    // User cancellation surfaces as a rejection on some Android versions.
    return false;
  }
}
