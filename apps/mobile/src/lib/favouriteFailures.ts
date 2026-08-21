/**
 * Why a favourite batch failed, in words a human can act on (m0.8.7,
 * Errors_design §4.2/D4) — pure, unit-tested; the impure partner is
 * FavouritesQueueScreen's batch loop, which renders this as one dialog.
 *
 * Same rule as lib/organizeFailures.ts (the reference implementation):
 * classify from facts WE own, never by reading Android's error text.
 * This boundary's owned fact is the richest of the four —
 * `unverifiedIds` from our own verify-after re-read names exactly which
 * photos Android would not confirm — so tier 1 is the partial-success
 * sentence the old copy could not express: "N were applied; Android did
 * not confirm M."
 *
 * Three tiers, always in this order:
 *   1. a cause we can PROVE from our data  → the partial-success counts
 *   2. anything else                       → an honest generic line
 *   3. always, last                        → Android's own words, VERBATIM
 */
import { plural } from './format';

/** One failed batch, as the apply loop already holds it. */
export interface FavouriteFailure {
  /** How many photos the batch sent. Our data. */
  batchSize: number;
  /** Our verify-after read: the photos Android would not confirm (the
   * whole batch when the attempt itself threw). Our data. */
  unverifiedCount: number;
  /** The direction we sent — the sentences name the operation. */
  favourite: boolean;
  /** Whatever rode back with the failure. Platform text is quoted
   * VERBATIM in tier 3 and nowhere else; our own authored verify
   * sentence (VERIFY_SENTINEL) is recognised and not misattributed to
   * Android. */
  error?: string;
}

/**
 * The apply pipeline's own sentence for "the request ran but the re-read
 * did not report the new state". OURS, not Android's —
 * `applyFavouriteBatch` writes this exact literal, and both sides carry
 * a note to change together. Comparing it is safe because we author it;
 * quoting it as "Android said" would be a misattribution.
 */
export const VERIFY_SENTINEL =
  'Android did not report the requested favourite state for every photo.';

export interface FavouriteFailureReport {
  title: string;
  body: string;
}

export function describeFavouriteFailure(failure: FavouriteFailure): FavouriteFailureReport {
  const applied = failure.batchSize - failure.unverifiedCount;
  const verb = failure.favourite ? 'favourite' : 'favourite removal';
  const lines: string[] = [];

  if (applied > 0) {
    // TIER 1 (D4): the partial-success counts, from our own verify —
    // singular and plural asserted for BOTH counts in the tests.
    lines.push(
      `${plural(applied, verb)} ${applied === 1 ? 'was' : 'were'} applied; ` +
        `Android did not confirm ${plural(failure.unverifiedCount, 'photo')}.`,
    );
  } else {
    // TIER 2: nothing confirmed — honest and generic.
    lines.push(
      `Android did not confirm ${failure.unverifiedCount === 1 ? 'the' : 'any of the'} ` +
        `${plural(failure.unverifiedCount, `${verb} change`)}.`,
    );
  }
  lines.push(
    `The unconfirmed ${failure.unverifiedCount === 1 ? 'one stays' : 'ones stay'} queued and ` +
      `${failure.unverifiedCount === 1 ? 'retries' : 'retry'} on the next apply.`,
  );

  // TIER 3: verbatim, unparsed, last — but only PLATFORM text. Our own
  // verify sentence is already what tier 1/2 explains.
  const raw = failure.error?.trim();
  if (raw && raw !== VERIFY_SENTINEL) {
    lines.push(`Android said:\n• ${raw}`);
  }

  return {
    title:
      applied > 0
        ? `Partly applied — ${plural(failure.unverifiedCount, 'photo')} unconfirmed`
        : 'Favourite changes need retry',
    body: lines.join('\n\n'),
  };
}
