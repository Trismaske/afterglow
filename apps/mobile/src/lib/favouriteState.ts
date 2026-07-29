import type { FavouriteIntentChange, FavouriteState } from '../db/store';

export interface FavouriteStatus {
  state: FavouriteState;
  target: boolean | null;
}

export const NO_FAVOURITE: FavouriteStatus = { state: 'none', target: null };

/**
 * m0.7 item F (#10): the best-of-group hand-off is WRITE-ONLY. It is
 * offered only when the photo is not already favourited (in any selected
 * or queued sense) — starring an already-favourited photo must never
 * prompt, and "Not now" is always a strict no-op.
 */
export function shouldOfferFavouriteHandoff(status: FavouriteStatus): boolean {
  return !isFavouriteSelected(status);
}

/**
 * What the heart should communicate, including queued/error intent.
 *
 * `applied` reads its DIRECTION, not merely its existence: a verified
 * REMOVAL is an applied favourite action whose target is false, and
 * treating it as selected left the heart filled on a photo the gallery
 * had just un-favourited — so the next tap queued a second removal. A
 * null target on an applied row is the degenerate case (no direction
 * ever recorded) and keeps the old benefit of the doubt.
 */
export function isFavouriteSelected(status: FavouriteStatus): boolean {
  if (status.state === 'applied') return status.target !== false;
  if (status.state === 'queued_apply') return true;
  if (status.state === 'error') return status.target === true;
  return false;
}

/**
 * The heart's badge WEIGHT (m0.8.2), on the same two-position rule the
 * other three actions use — but read from the status, because favourite
 * is the only action that can point backwards.
 *
 * - `live` — a favourite is waiting to be applied (or its attempt failed
 *   and is retryable). A queued REMOVAL is deliberately not live: the
 *   heart leaves the moment you ask for it to.
 * - `carried` — the gallery favourite is applied and still stands.
 * - `null` — no heart: never favourited, or verifiably un-favourited.
 */
export function favouriteBadgeWeight(status: FavouriteStatus): 'live' | 'carried' | null {
  if (status.state === 'queued_apply') return 'live';
  if (status.state === 'error') return status.target === true ? 'live' : null;
  if (status.state === 'applied') return status.target === false ? null : 'carried';
  return null;
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
