/**
 * The scan's one honest status line (m0.9 phase 9, pure): Home's line
 * under the CTA and Settings' Library-scan row render THIS, so the two
 * surfaces can never disagree about what the scan is doing or why.
 *
 * Every pass names itself: a full pass carries the reason it is full
 * (`FullPassReason` — the runner decides it where it decides the pass,
 * never silently), a delta names its size in changed items (M9: "items",
 * since videos count), a targeted pass says it is regrouping. A RESUMED
 * pass (an interrupted full pass picked up at its checkpoint) states the
 * work left AT ITS START — computed from durable state (present rows
 * without an embedding), a fixed figure for the pass beside the moving
 * walk percent — never the enumeration counter, which restarts with
 * every session and lied on the S23 for a week ("0%" three times over
 * an hour of persisted work). Fixed, not decremented (codex r5): the
 * run's embed count and the durable set are different populations (a
 * re-embedded edit counts in one, a landed video in the other).
 *
 * Nothing renders for the 'checking' phase: the skip check is one
 * native generation read, and a line that said "Scanning…" for it on
 * every foreground return was the complaint (F27).
 */
import { plural } from './format';

/** Why a pass is full rather than a delta. The runner logs each at the
 * decision site; the line names it for the user. */
export type FullPassReason =
  /** No baseline yet — the first pass over this library (or after Forget). */
  | 'first'
  /** An interrupted full pass picked up at its checkpoint. */
  | 'resume'
  /** The periodic reconciliation (FULL_PASS_MAX_AGE_MS). */
  | 'weekly'
  /** A settings apply or reset asked for it. */
  | 'forced'
  /** The Settings row's own "Rescan library". */
  | 'manual'
  /** The embedding model changed; every vector is recomputed. */
  | 'model'
  /** The grouping rules changed (core GROUPING_RULES_VERSION); every group re-forms. */
  | 'rules'
  /** A storage volume the baseline never saw, or one without generation evidence. */
  | 'storage'
  /** Tracked items left MediaStore with no trace and the id walk could not explain it. */
  | 'loss'
  /** Changed items moved their capture time; both windows re-form. */
  | 'dates'
  /** The delta's cost model preferred the full walk. */
  | 'cost'
  /** The post-delta count check found the library inconsistent. */
  | 'inconsistent'
  /** The change query itself failed. */
  | 'unavailable';

/** The slice of the runner's status the line reads. */
export interface ScanProgress {
  phase: 'idle' | 'checking' | 'scanning' | 'done' | 'error';
  kind: 'full' | 'delta' | 'targeted' | null;
  reason: FullPassReason | null;
  scanned: number;
  embedded: number;
  total: number | null;
  /** A delta's size: changed items it is landing (trashed ones excluded). */
  changed: number | null;
  /** A resumed pass: items still to analyze at pass start (durable). */
  remaining: number | null;
  /** This full pass resumed an interrupted one at its checkpoint; the
   * reason is the interrupted pass's own, carried by the checkpoint. */
  resumed: boolean;
}

/**
 * The leading words for a full pass, by reason — Tristan's wording
 * (2026-10-03), the one table for the sink's `[scan] full pass: …` line
 * to be read against:
 *
 * | reason         | user-facing words                  |
 * |----------------|------------------------------------|
 * | first          | Initial scan                       |
 * | resume         | Resuming last scan (no carried reason) |
 * | weekly         | Weekly full scan                   |
 * | forced         | Rescanning · settings changed      |
 * | manual         | Rescanning · manually triggered    |
 * | model          | Rescanning · model changed         |
 * | rules          | Rescanning · grouping changed      |
 * | storage        | Scanning new storage               |
 * | loss           | Reconciling deletions              |
 * | dates          | Rescanning · dates changed         |
 * | cost           | Rescanning · many changes          |
 * | inconsistent   | Rescanning · counts disagreed      |
 * | unavailable    | Rescanning · delta check failed    |
 *
 * A resumed pass shows the reason the interrupted pass carried, with a
 * "resumed" marker (the user may never have seen it before the
 * interruption); 'resume' itself is the fallback for a checkpoint
 * written without one.
 */
export function fullPassLabel(reason: FullPassReason | null): string {
  switch (reason) {
    case 'resume':
      return 'Resuming last scan';
    case 'weekly':
      return 'Weekly full scan';
    case 'forced':
      return 'Rescanning · settings changed';
    case 'manual':
      return 'Rescanning · manually triggered';
    case 'model':
      return 'Rescanning · model changed';
    case 'rules':
      return 'Rescanning · grouping changed';
    case 'storage':
      return 'Scanning new storage';
    case 'loss':
      return 'Reconciling deletions';
    case 'dates':
      return 'Rescanning · dates changed';
    case 'cost':
      return 'Rescanning · many changes';
    case 'inconsistent':
      return 'Rescanning · counts disagreed';
    case 'unavailable':
      return 'Rescanning · delta check failed';
    case 'first':
    case null:
      return 'Initial scan';
  }
}

/**
 * The line for a RUNNING scan, or null when nothing should render (idle,
 * checking, done). The error line stays with its surface (Home words it
 * as a retry promise).
 */
export function scanProgressLine(status: ScanProgress): string | null {
  if (status.phase !== 'scanning') return null;
  const { scanned, embedded, total } = status;
  if (status.kind === 'targeted') return `Regrouping ${plural(Math.max(scanned, 1), 'item')}`;
  if (status.kind === 'delta') {
    const head = `Checking ${plural(status.changed ?? 0, 'changed item')}`;
    return embedded > 0 ? `${head} · ${embedded.toLocaleString()} analyzed` : head;
  }
  const label = fullPassLabel(status.reason);
  if (status.resumed && total !== null && total > 0) {
    const pct = Math.min(100, Math.round((scanned / total) * 100));
    const head = status.reason === 'resume' ? label : `${label} · resumed`;
    // The work left is named only while there is some (Tristan's S23
    // pass: "0 of 33 188 items to analyze" read as nothing done); an
    // already-analyzed library shows the walk instead.
    if (status.remaining !== null && status.remaining > 0) {
      return `${head} ${pct}% · ${status.remaining.toLocaleString()} of ${plural(total, 'item')} to analyze`;
    }
    return `${head} ${pct}% · ${Math.min(scanned, total).toLocaleString()} of ${plural(total, 'item')}`;
  }
  if (total !== null && total > 0) {
    const pct = Math.min(100, Math.round((scanned / total) * 100));
    return `${label} ${pct}% · ${Math.min(scanned, total).toLocaleString()} of ${plural(total, 'item')}`;
  }
  return `${label}… ${scanned.toLocaleString()} seen · ${embedded.toLocaleString()} analyzed`;
}
