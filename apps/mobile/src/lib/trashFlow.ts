/**
 * One durable trash attempt (m0.7 item H): prepare/reserve → launching →
 * system consent dialog → tri-state verify → outcomes + C#7 cleanup, over
 * an explicit member list. The impure orchestration shared by the
 * cull-list confirm loop (review/ReviewContext.confirmStagedCulls) and the
 * edited-copy "Cull original" affordance (Home) — every removal path runs
 * the same crash-safe lifecycle. 'skipped' means nothing could be
 * reserved (a live attempt already holds every given photo).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  markBatchLaunching,
  prepareTrashBatch,
  resolveTrashBatch,
  type PrepareTrashBatchOptions,
  type TrashMemberInput,
} from '../db/trashStore';
import { trashAssets, verifyTrashedTriState } from './media';
import { mountedVolumeSet } from './mountedVolumes';

export interface TrashAttemptResult {
  status: 'applied' | 'cancelled' | 'unsupported' | 'failed' | 'skipped';
  /** Where a 'failed' run failed — OUR pipeline fact, not a reading of
   * the error (Errors_design D2; codex m0.8.7 r1): 'prepare' failed
   * before Android was asked (nothing dispatched), 'dispatch' is the
   * native request itself, 'bookkeeping' failed AFTER the dialog (the
   * moves may be real; Afterglow could not record them). */
  stage?: 'prepare' | 'dispatch' | 'bookkeeping';
  error?: string;
  /** Every member this attempt actually reserved and dispatched. */
  attemptedIds: string[];
  /** Members verified gone (trashed / absent after interrupted launch). */
  trashedIds: string[];
  /** Members whose verification came back genuinely UNKNOWN — possibly in
   * system trash. Cancelled/still-present members are NOT here. */
  unknownIds: string[];
  /** Verified bytes credited by this attempt (at-most-once, P8#3). */
  creditedBytes: number;
  /** Fresh goal work the stage-to-culled transition produced (see
   * PreparedTrashBatch.freshDecisions) — the CALLER must route a
   * non-zero count into the goal counter. */
  freshDecisions: number;
}

export async function runTrashAttempt(
  db: SQLiteDatabase,
  members: readonly TrashMemberInput[],
  options: PrepareTrashBatchOptions = {},
): Promise<TrashAttemptResult> {
  let batch;
  try {
    batch = await prepareTrashBatch(db, members, Date.now(), options);
  } catch (error) {
    // Nothing was reserved — a transient preparation failure is an
    // ordinary 'failed' result, never a rejection (callers alert and
    // continue).
    return {
      status: 'failed',
      stage: 'prepare',
      error: error instanceof Error ? error.message : String(error),
      attemptedIds: [],
      trashedIds: [],
      unknownIds: [],
      creditedBytes: 0,
      freshDecisions: 0,
    };
  }
  if (!batch) {
    return {
      status: 'skipped',
      attemptedIds: [],
      trashedIds: [],
      unknownIds: [],
      creditedBytes: 0,
      freshDecisions: 0,
    };
  }
  const ids = batch.members.map((m) => m.photoId);
  // Whether the native request was actually invoked — the outer catch's
  // stage must not claim "after the system dialog" for a failure that
  // happened before Android was asked (codex m0.8.7 r2/r3): a rejected
  // launch marker, a uri-resolution failure, or an absent module are all
  // pre-dispatch facts, even when a LATER resolution step also rejects.
  let dispatched = false;
  try {
    await markBatchLaunching(db, batch.batchId, Date.now());
    const dialog = await trashAssets(ids);
    dispatched =
      dialog.status !== 'unsupported' &&
      !(dialog.status === 'failed' && dialog.stage === 'prepare');
    const status =
      dialog.status === 'applied'
        ? ('applied' as const)
        : dialog.status === 'cancelled'
          ? ('cancelled' as const)
          : dialog.status === 'unsupported'
            ? ('unsupported' as const)
            : ('failed' as const);
    // A FAILED native request may still have dispatched the system dialog
    // before rejecting — resolving with 'failed' would skip verification
    // and force still_present, silently discarding real ambiguity.
    // Verify conservatively like an interrupted launch instead:
    // authoritative absence converges (uncredited), everything else stays
    // staged with honest unknowns.
    // One mounted snapshot for this resolution (final cycle O2): the
    // membership repair must not dissolve a group whose other member is
    // waiting on an ejected card.
    const mountedVolumes = await mountedVolumeSet();
    const resolved =
      status === 'failed'
        ? await resolveTrashBatch(db, {
            batchId: batch.batchId,
            verify: verifyTrashedTriState,
            dialog: 'applied',
            interrupted: true,
            at: Date.now(),
            mountedVolumes,
          })
        : await resolveTrashBatch(db, {
            batchId: batch.batchId,
            verify: verifyTrashedTriState,
            dialog: status,
            at: Date.now(),
            mountedVolumes,
          });
    return {
      status,
      stage: dialog.status === 'failed' ? (dialog.stage ?? 'dispatch') : undefined,
      error: dialog.status === 'failed' ? dialog.error : undefined,
      attemptedIds: ids,
      trashedIds: ids.filter(
        (id) =>
          resolved.outcomes[id] === 'trashed' ||
          resolved.outcomes[id] === 'absent_after_interrupted_launch',
      ),
      unknownIds: ids.filter((id) => resolved.outcomes[id] === 'unknown'),
      creditedBytes: resolved.creditedBytes,
      freshDecisions: batch.freshDecisions,
    };
  } catch (error) {
    // The batch was durably prepared but a later step rejected (transient
    // SQLite/bridge failure). Startup recovery has usually already run
    // this process, so release the batch NOW like recovery would —
    // conservative interrupted resolution, absence uncredited — or the
    // reservation would block these photos until the next app launch.
    // The fallback's outcomes are REAL results and must reach the
    // caller: verified-gone members need live reconciliation, and
    // unknown members must keep their ambiguity (a caller treating them
    // as untouched could unstage a photo already in system trash).
    const message = error instanceof Error ? error.message : String(error);
    try {
      const recovered = await resolveTrashBatch(db, {
        batchId: batch.batchId,
        verify: verifyTrashedTriState,
        dialog: 'applied',
        interrupted: true,
        at: Date.now(),
        mountedVolumes: await mountedVolumeSet(),
      });
      return {
        status: 'failed',
        stage: dispatched ? 'bookkeeping' : 'prepare',
        error: message,
        attemptedIds: ids,
        trashedIds: ids.filter(
          (id) =>
            recovered.outcomes[id] === 'trashed' ||
            recovered.outcomes[id] === 'absent_after_interrupted_launch',
        ),
        unknownIds: ids.filter((id) => recovered.outcomes[id] === 'unknown'),
        creditedBytes: recovered.creditedBytes,
        freshDecisions: batch.freshDecisions,
      };
    } catch {
      // Release failed too — next launch's recovery handles the batch;
      // everything stays maximally ambiguous.
      return {
        status: 'failed',
        stage: dispatched ? 'bookkeeping' : 'prepare',
        error: message,
        attemptedIds: ids,
        trashedIds: [],
        unknownIds: ids,
        creditedBytes: 0,
        freshDecisions: batch.freshDecisions,
      };
    }
  }
}
