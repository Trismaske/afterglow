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

/**
 * Load every photo whose creation time falls inside [startMs, endMs],
 * oldest first, paging through MediaStore.
 */
export async function loadPhotosInRange(startMs: number, endMs: number): Promise<LoadedPhoto[]> {
  const photos: LoadedPhoto[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await MediaLibrary.getAssetsAsync({
      first: PAGE_SIZE,
      after,
      createdAfter: startMs,
      createdBefore: endMs,
      mediaType: MediaLibrary.MediaType.photo,
      sortBy: [[MediaLibrary.SortBy.creationTime, true]],
    });
    for (const asset of page.assets) {
      photos.push({
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
      });
    }
    if (!page.hasNextPage || !page.endCursor) break;
    after = page.endCursor;
  }
  return photos;
}

/**
 * How many photos MediaStore has in [startMs, endMs] — one cheap query
 * (first: 1) reading PagedInfo.totalCount, no asset paging.
 */
export async function countPhotosInRange(startMs: number, endMs: number): Promise<number> {
  const page = await MediaLibrary.getAssetsAsync({
    first: 1,
    createdAfter: startMs,
    createdBefore: endMs,
    mediaType: MediaLibrary.MediaType.photo,
  });
  return page.totalCount;
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
 * APP — nothing else may delete media.
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
