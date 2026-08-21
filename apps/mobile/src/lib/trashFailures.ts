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
  /** Where the run failed — OUR pipeline stage (codex m0.8.7 r1), never
   * a reading of the error: 'prepare' failed before Android was asked,
   * 'dispatch' is the native request, 'bookkeeping' failed after the
   * dialog. Absent = dispatch (the historical shape). */
  stage?: 'prepare' | 'dispatch' | 'bookkeeping';
  /** Whatever rode back with the failure — quoted verbatim in tier 3 and
   * nowhere else, attributed to Android ONLY on a dispatch failure. */
  error?: string;
  /** False when the CALLER rolled the verdict back after the failure
   * (the edited-copy prompt) — the "remain staged" claims would then be
   * lies, so the caller supplies its own outcome line instead (codex
   * m0.8.7 r2). Default true: the cull-list flow, where staying staged
   * is exactly what happens. */
  stillStaged?: boolean;
}

export interface TrashFailureReport {
  title: string;
  body: string;
}

export function describeTrashFailure(failure: TrashFailure): TrashFailureReport {
  const lines: string[] = [];

  const stillStaged = failure.stillStaged ?? true;
  // TIER 1 where we hold proof: the verified progress counts.
  if (failure.trashedCount > 0) {
    lines.push(
      `${plural(failure.trashedCount, 'photo')} ${failure.trashedCount === 1 ? 'was' : 'were'} ` +
        `already moved to trash${stillStaged ? `; ${failure.remaining} remain staged` : ''}.`,
    );
  }

  // TIER 2: the honest line for OUR stage fact — no cause invented, and
  // Afterglow's own failures never wear Android's name.
  const stage = failure.stage ?? 'dispatch';
  if (stage === 'prepare') {
    // The run may span several batches: with verified progress above,
    // "nothing was moved" would contradict tier 1 (codex m0.8.7 r3).
    lines.push(
      failure.trashedCount > 0
        ? `Afterglow could not prepare the next batch — Android was not asked again, and nothing further was moved.${stillStaged ? ' The rest of your culls remain staged.' : ''}`
        : `Afterglow could not prepare the batch — Android was never asked, and nothing was moved.${stillStaged ? ' Your culls remain staged.' : ''}`,
    );
  } else if (stage === 'bookkeeping') {
    lines.push(
      `Afterglow could not record the outcome after the system dialog.${stillStaged ? ' Anything Android verified as moved is counted above; everything else remains staged.' : ''}`,
    );
  } else {
    lines.push(
      failure.trashedCount > 0
        ? `Android refused to move the rest.${stillStaged ? ' Your culls remain staged.' : ''}`
        : `Android refused to move the photos to trash.${stillStaged ? ' Your culls remain staged.' : ''}`,
    );
  }

  if (failure.unresolvedCount > 0) {
    lines.push(
      `${plural(failure.unresolvedCount, 'photo')} could not be verified and may already be ` +
        `in the system trash.`,
    );
  }

  // TIER 3: verbatim, unparsed, last — attributed to Android only when
  // Android actually spoke (the dispatch stage).
  const raw = failure.error?.trim();
  if (raw) lines.push(stage === 'dispatch' ? `Android said:\n• ${raw}` : `Details:\n• ${raw}`);

  return {
    title: failure.trashedCount > 0 ? 'Partly moved to trash' : 'Could not move photos to trash',
    body: lines.join('\n\n'),
  };
}
