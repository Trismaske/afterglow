import {
  isMediaFavourite,
  setMediaFavourite,
  type MediaStoreActionStatus,
} from '../../modules/media-store-actions';
import { getEditableContentUri } from './media';

/** Conservative app cap per MediaStore consent request (P5#4) — the
 * platform throws above 2000 URIs, which would error the whole queue with
 * no way to drain it. Matches the trash/organize batch bound. */
export const FAVOURITE_BATCH_LIMIT = 500;

export interface FavouriteBatchResult {
  status: MediaStoreActionStatus | 'failed';
  unverifiedIds: string[];
  error?: string;
}

/**
 * Run one Android-owned favourite batch and verify every returned flag.
 * Callers only mark the durable queue applied when `status` is `applied`.
 */
export async function applyFavouriteBatch(
  assetIds: readonly string[],
  favourite: boolean,
): Promise<FavouriteBatchResult> {
  try {
    const pairs = await Promise.all(
      assetIds.map(async (id) => ({ id, uri: await getEditableContentUri(id) })),
    );
    const action = await setMediaFavourite(
      pairs.map((pair) => pair.uri),
      favourite,
    );
    if (action.status !== 'applied') return { status: action.status, unverifiedIds: [] };

    const flags = await Promise.all(pairs.map((pair) => isMediaFavourite(pair.uri)));
    const unverifiedIds = pairs
      .filter((_, index) => flags[index] !== favourite)
      .map((pair) => pair.id);
    if (unverifiedIds.length > 0) {
      return {
        status: 'failed',
        unverifiedIds,
        error: 'Android did not report the requested favourite state for every photo.',
      };
    }
    return { status: 'applied', unverifiedIds: [] };
  } catch (error) {
    return {
      status: 'failed',
      unverifiedIds: [...assetIds],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
