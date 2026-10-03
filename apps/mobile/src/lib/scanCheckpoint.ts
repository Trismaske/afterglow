/**
 * The full pass's enumeration checkpoint (m0.9 phase 9, pure). A full
 * pass walks newest→oldest and closes merge windows in order, so after
 * each closed DATED window the pass knows one durable fact: every dated
 * row captured at or after that window's oldest member is landed. The
 * runner persists that boundary (one tiny settings write per window —
 * after the window's own transaction commits), and a later pass over
 * the same scope that finds it resumes BELOW it instead of re-walking
 * the ~6.5 min (S23, 27k) it already covered. The S23 evidence that
 * decided this: an hour of re-embedding received in fragments, each
 * session restarting the enumeration at 0% while every window
 * underneath had persisted (docs/Plan_m0.9.md, phase 9).
 *
 * What a resumed pass does with the checkpoint (the runner):
 *   - pages ONE range [0, boundary) for the dated walk, plus the rows
 *     changed ABOVE the boundary since the checkpoint's generations
 *     (the camera did not stop between sessions) as delta ranges, plus
 *     the undated tail by ids (no bounded range can reach it);
 *   - reconciles unseen rows through the ids-only enumeration (its own
 *     walk covered only the lower part), and counts as the full pass.
 *
 * SCOPE, NOT FINGERPRINT: the key binds sources, strictness and model —
 * never the volume generations, which move with every capture; a
 * checkpoint keyed on them would be discarded by exactly the activity
 * it exists to survive. A forced pass (settings apply, reset) discards
 * the checkpoint: its full walk is the point.
 *
 * The boundary only ever DECREASES within one scope: a resumed pass
 * walks the above-boundary delta ranges first (they are newer), and a
 * checkpoint taken from one of those windows would move the boundary
 * back up — `advance` refuses it.
 */

import type { FullPassReason } from './scanProgress';

export const SCAN_CHECKPOINT_KEY = 'scan_checkpoint';
const REASONS: readonly FullPassReason[] = [
  'first',
  'resume',
  'weekly',
  'forced',
  'model',
  'storage',
  'loss',
  'dates',
  'cost',
  'inconsistent',
  'unavailable',
];

export interface ScanCheckpoint {
  /** `checkpointScope` of the pass that wrote it. */
  scope: string;
  /** Every dated row with taken_at >= boundary is landed. */
  boundary: number;
  /** The pass's enumeration counter at the checkpoint — the resumed
   * pass continues the count from here. */
  scanned: number;
  /** The scope-relevant volume generations the interrupted pass started
   * from (`<volume>|<version>` keys): changes since them above the
   * boundary are what the resume re-pages. */
  generations: Record<string, number>;
  /** Why the interrupted pass was full (Tristan, 2026-10-03): the
   * resumed pass shows THIS reason with a "resumed" marker, because the
   * user may never have seen it before the interruption; absent on a
   * checkpoint written without one → "Resuming last scan". */
  reason?: FullPassReason;
}

export function checkpointScope(args: {
  roots: readonly { volume: string; dir: string }[] | null;
  strictness: string | null;
  modelSha: string;
}): string {
  const roots =
    args.roots === null
      ? '*'
      : args.roots
          .map((root) => `${root.volume}:${root.dir}`)
          .sort()
          .join(',');
  return `src:${roots}|strict:${args.strictness ?? 'default'}|model:${args.modelSha}`;
}

/** The stored JSON, validated field by field; anything malformed is no
 * checkpoint (the pass starts from the top, as before). */
export function parseCheckpoint(raw: string | null): ScanCheckpoint | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.scope !== 'string') return null;
  if (typeof v.boundary !== 'number' || !Number.isFinite(v.boundary)) return null;
  if (typeof v.scanned !== 'number' || !Number.isFinite(v.scanned) || v.scanned < 0) return null;
  if (typeof v.generations !== 'object' || v.generations === null) return null;
  const generations: Record<string, number> = {};
  for (const [key, gen] of Object.entries(v.generations as Record<string, unknown>)) {
    if (typeof gen !== 'number' || !Number.isFinite(gen)) return null;
    generations[key] = gen;
  }
  const reason = REASONS.find((r) => r === v.reason);
  return {
    scope: v.scope,
    boundary: v.boundary,
    scanned: v.scanned,
    generations,
    ...(reason ? { reason } : {}),
  };
}

/**
 * May this pass resume from the checkpoint? Same scope, and the SAME
 * volume set — every scope-relevant volume mounted now has a generation
 * the checkpoint started from (a volume it never saw has no "since" to
 * re-page from), and every volume the checkpoint covered is mounted now
 * (codex r6: a card ejected since would let the resumed pass finish the
 * other volumes, stamp the full pass and spend the checkpoint with the
 * card's lower part never walked). Either difference discards it.
 */
export function canResume(
  checkpoint: ScanCheckpoint | null,
  args: { scope: string; generationKeys: readonly string[] },
): checkpoint is ScanCheckpoint {
  if (checkpoint === null || checkpoint.scope !== args.scope) return false;
  if (args.generationKeys.length === 0) return false;
  const covered = Object.keys(checkpoint.generations);
  if (covered.length !== args.generationKeys.length) return false;
  return args.generationKeys.every((key) => key in checkpoint.generations);
}

/**
 * The checkpoint after one closed dated window, or null when the window
 * does not advance it (a window above the current boundary — the
 * resumed pass's delta ranges — or a window with no members).
 */
export function advance(
  current: ScanCheckpoint | null,
  args: {
    scope: string;
    generations: Record<string, number>;
    /** The closed window's members' capture times. */
    windowTimesMs: readonly number[];
    scanned: number;
    reason: FullPassReason;
  },
): ScanCheckpoint | null {
  if (args.windowTimesMs.length === 0) return null;
  const boundary = Math.min(...args.windowTimesMs);
  if (current !== null && boundary >= current.boundary) return null;
  return {
    scope: args.scope,
    boundary,
    scanned: args.scanned,
    generations: args.generations,
    reason: args.reason,
  };
}

/** The changed rows a resume must re-page: dated, not trashed, captured
 * at or above the boundary (below it the main range walks them; undated
 * rows ride the ids tail; trashed ones reconcile by id). */
export function changesAboveBoundary<T extends { dateTakenMs: number | null; isTrashed: boolean }>(
  rows: readonly T[],
  boundary: number,
): T[] {
  return rows.filter(
    (row) => !row.isTrashed && row.dateTakenMs !== null && row.dateTakenMs >= boundary,
  );
}
