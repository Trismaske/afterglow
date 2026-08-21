/**
 * Why a share dispatch failed (m0.8.7, Errors_design §4.3) — pure,
 * unit-tested; the impure partner is ShareQueueScreen's dispatch flow.
 *
 * This boundary resolves at DISPATCH, never at the sheet, so the design
 * expected tiers 2+3 only — compliant, not exempt (D1). Implementation
 * found exactly one provable tier-1 cause: the failure STAGE is our own
 * fact, because our pipeline resolves content uris BEFORE handing
 * anything to Android. A failure in that first stage is ours to name
 * ("could not prepare the photos"); only a failure after handoff is a
 * dispatch refusal. Android's words ride verbatim and last either way.
 */
import { plural } from './format';

export interface ShareFailure {
  /** How many photos the batch held. Our data. */
  count: number;
  /** Where it failed — OUR pipeline stage, not a reading of the error:
   * 'prepare' = resolving content uris (before Android was involved);
   * 'dispatch' = the platform share sheet itself. */
  stage: 'prepare' | 'dispatch';
  /** Whatever rode back — verbatim in tier 3 and nowhere else. */
  error?: string;
}

export interface ShareFailureReport {
  title: string;
  body: string;
}

export function describeShareFailure(failure: ShareFailure): ShareFailureReport {
  const lines: string[] = [];
  if (failure.stage === 'prepare') {
    // TIER 1: proven by the stage — Android never saw the batch.
    lines.push(
      `${plural(failure.count, 'photo')} could not be prepared for sharing — the share sheet ` +
        `was never opened. Nothing was sent, and the queue is unchanged.`,
    );
  } else {
    // TIER 2: honest and generic — a dispatch refusal has no cause we
    // can prove from our own facts.
    lines.push(
      `Android could not open the share sheet for ${plural(failure.count, 'photo')}. ` +
        `Nothing was sent, and the queue is unchanged.`,
    );
  }
  const raw = failure.error?.trim();
  if (raw) lines.push(`Android said:\n• ${raw}`);
  return { title: 'Share failed', body: lines.join('\n\n') };
}
