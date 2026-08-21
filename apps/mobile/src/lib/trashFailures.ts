/**
 * Why a trash run failed, in words a human can act on (m0.8.7,
 * Errors_design §4.1) — pure, unit-tested; the impure partner is
 * CullListScreen's confirm flow, which renders this as one dialog.
 *
 * This boundary was "closest to done": the hard tier-1 distinction —
 * consent DECLINED versus the platform REFUSING — already ships as our
 * own `cancelled`/`failed` statuses with their own headings, and the
 * tri-state verify already converges already-gone photos before any
 * failure could claim them. What was missing is the three-tier SHAPE on
 * the failed branch: the old copy interpolated Android's error into our
 * own sentence, blurring who said what. Here our reading (the counts we
 * verified, the honest refusal line) sits above Android's words, which
 * are quoted verbatim and last.
 */
import { plural } from './format';

export interface TrashFailure {
  /** Photos this run VERIFIED as moved before the failure. Our data. */
  trashedCount: number;
  /** Staged culls remaining after the run. Our data. */
  remaining: number;
  /** Members whose verification stayed genuinely unknown. Our data. */
  unresolvedCount: number;
  /** Whatever rode back with the failure — Android's words, verbatim in
   * tier 3 and nowhere else. */
  error?: string;
}

export interface TrashFailureReport {
  title: string;
  body: string;
}

export function describeTrashFailure(failure: TrashFailure): TrashFailureReport {
  const lines: string[] = [];

  // TIER 1 where we hold proof: the verified progress counts.
  if (failure.trashedCount > 0) {
    lines.push(
      `${plural(failure.trashedCount, 'photo')} ${failure.trashedCount === 1 ? 'was' : 'were'} ` +
        `already moved to trash; ${failure.remaining} remain staged.`,
    );
  }

  // TIER 2: the honest refusal line — no cause invented.
  lines.push(
    failure.trashedCount > 0
      ? 'Android refused to move the rest. Your culls remain staged.'
      : 'Android refused to move the photos to trash. Your culls remain staged.',
  );

  if (failure.unresolvedCount > 0) {
    lines.push(
      `${plural(failure.unresolvedCount, 'photo')} could not be verified and may already be ` +
        `in the system trash.`,
    );
  }

  // TIER 3: verbatim, unparsed, last.
  const raw = failure.error?.trim();
  if (raw) lines.push(`Android said:\n• ${raw}`);

  return {
    title: failure.trashedCount > 0 ? 'Partly moved to trash' : 'Could not move photos to trash',
    body: lines.join('\n\n'),
  };
}
