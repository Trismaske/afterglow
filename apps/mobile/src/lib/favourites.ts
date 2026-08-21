import {
  isMediaFavourite,
  setMediaFavourite,
  type MediaStoreActionStatus,
} from '../../modules/media-store-actions';
import { getEditableContentUri } from './media';
import { VERIFY_SENTINEL } from './favouriteFailures';

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
 *
 * createFavoriteRequest lets the PLATFORM decide whether to ask the user,
 * and no consent dialog appears on any tested API (30/31/36 — m0.8.4
 * acceptance pass). That is correct: the destructive path (trash) is the
 * one that must prompt, and the verify-after re-read below is what makes
 * the silent apply honest.
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
      // The classifier recognises this exact sentence (VERIFY_SENTINEL,
      // lib/favouriteFailures.ts) so it is never quoted as Android's.
      return { status: 'failed', unverifiedIds, error: VERIFY_SENTINEL };
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
