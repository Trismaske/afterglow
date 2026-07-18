import type { FavouriteIntentChange, FavouriteState } from '../db/store';

export interface FavouriteStatus {
  state: FavouriteState;
  target: boolean | null;
}

export const NO_FAVOURITE: FavouriteStatus = { state: 'none', target: null };

/** What the heart should communicate, including queued/error intent. */
export function isFavouriteSelected(status: FavouriteStatus): boolean {
  if (status.state === 'applied' || status.state === 'queued_apply') return true;
  if (status.state === 'error') return status.target === true;
  return false;
}

/**
 * Toggle intent without lying about gallery state. Cancelling a not-yet-run
 * queue restores the known state; an ambiguous failed operation queues the
 * opposite direction so the next verified batch converges deterministically.
 */
export function nextFavouriteIntent(
  assetId: string,
  status: FavouriteStatus,
): FavouriteIntentChange {
  if (isFavouriteSelected(status)) {
    if (status.state === 'queued_apply') return { assetId, state: 'none', target: null };
    return { assetId, state: 'queued_remove', target: false };
  }
  if (status.state === 'queued_remove') return { assetId, state: 'applied', target: null };
  return { assetId, state: 'queued_apply', target: true };
}
