/**
 * Gate-0 editor-launch diagnostic matrix — pure sequencing + report
 * formatting (m0.7 item A / plan gate 0). The matrix exists to PROVE the
 * Samsung `SecurityException` failure mode before any fix is chosen:
 *
 *   1. environment probe (uid/package, checkUriPermission read+write,
 *      openInputStream proof, visible handlers) — impure side in
 *      modules/media-store-actions;
 *   2. dispatch probes in order: VIEW read-only → EDIT read-only →
 *      EDIT read+write;
 *   3. if ANY dispatch threw a SecurityException, request
 *      MediaStore.createWriteRequest approval, then re-probe EDIT
 *      read+write — testing Android's documented delegation path instead
 *      of re-granting a permission Afterglow may not hold.
 *
 * A dispatch probe resolves the moment Android accepts or rejects the
 * intent; whether an app actually opened is an observation the tester
 * records per step (dispatch success does not prove the target drew a
 * screen). The impure driver is components/EditDiagnosticsSheet.tsx; this
 * module never touches React Native so the branch logic stays unit-tested.
 */

import { ACTION_EDIT, ACTION_VIEW } from './editActions';

export type MatrixStepId =
  'view_read' | 'edit_read' | 'edit_readwrite' | 'write_request' | 'edit_readwrite_after_grant';

/** What one dispatch (or consent) probe reported. */
export interface MatrixDispatch {
  result:
    'launched' | 'security' | 'no_handler' | 'error' | 'unsupported' | 'approved' | 'cancelled';
  message: string;
}

export interface MatrixRecord {
  step: MatrixStepId;
  dispatch: MatrixDispatch;
  /** Did the tester see an app open? Only meaningful after `launched`. */
  observedOpen?: boolean;
}

export const MATRIX_PROBES: Record<
  Exclude<MatrixStepId, 'write_request'>,
  { action: string; withWrite: boolean; title: string }
> = {
  view_read: { action: ACTION_VIEW, withWrite: false, title: 'VIEW, read-only grant' },
  edit_read: { action: ACTION_EDIT, withWrite: false, title: 'EDIT, read-only grant' },
  edit_readwrite: { action: ACTION_EDIT, withWrite: true, title: 'EDIT, read+write grant' },
  edit_readwrite_after_grant: {
    action: ACTION_EDIT,
    withWrite: true,
    title: 'EDIT, read+write — after createWriteRequest approval',
  },
};

export const WRITE_REQUEST_TITLE = 'MediaStore.createWriteRequest approval';

function record(records: readonly MatrixRecord[], step: MatrixStepId): MatrixRecord | undefined {
  return records.find((r) => r.step === step);
}

/** True when any completed dispatch probe hit a SecurityException. */
export function sawSecurityFailure(records: readonly MatrixRecord[]): boolean {
  return records.some((r) => r.dispatch.result === 'security');
}

/**
 * The next step to run, or null when the matrix is complete.
 * Order: view_read → edit_read → edit_readwrite; the write-request branch
 * runs only when some dispatch already failed with SecurityException, and
 * the after-grant re-probe runs only when the user approved the request.
 */
export function nextMatrixStep(records: readonly MatrixRecord[]): MatrixStepId | null {
  if (!record(records, 'view_read')) return 'view_read';
  if (!record(records, 'edit_read')) return 'edit_read';
  if (!record(records, 'edit_readwrite')) return 'edit_readwrite';
  if (!sawSecurityFailure(records)) return null;
  const writeRequest = record(records, 'write_request');
  if (!writeRequest) return 'write_request';
  if (writeRequest.dispatch.result !== 'approved') return null;
  if (!record(records, 'edit_readwrite_after_grant')) return 'edit_readwrite_after_grant';
  return null;
}

function stepTitle(step: MatrixStepId): string {
  return step === 'write_request' ? WRITE_REQUEST_TITLE : MATRIX_PROBES[step].title;
}

function observedLabel(r: MatrixRecord): string {
  if (r.dispatch.result !== 'launched') return '';
  if (r.observedOpen === undefined) return ' (observation not recorded)';
  return r.observedOpen ? ' (an app opened)' : ' (dispatch accepted but NOTHING opened)';
}

/**
 * The full plain-text report — selectable/shareable so the Samsung tester
 * can send it back verbatim. `env` is the native environment probe, given
 * as label/value lines so this stays decoupled from the native shape.
 * `uri` is the content URI under test — m0.8.3: always the CONSTRUCTED
 * canonical volume-qualified uri (media.ts), there is no resolution path
 * left, which is why the report's provenance line is a constant.
 */
export function formatMatrixReport(
  env: readonly (readonly [string, string])[],
  uri: string,
  records: readonly MatrixRecord[],
): string {
  const lines: string[] = ['Afterglow editor-launch matrix (m0.7 gate 0)', ''];
  lines.push(`URI: ${uri}`);
  lines.push('URI source: constructed canonical volume-qualified uri');
  lines.push('');
  for (const [label, value] of env) lines.push(`${label}: ${value}`);
  lines.push('');
  for (const r of records) {
    lines.push(
      `${stepTitle(r.step)}: ${r.dispatch.result} — ${r.dispatch.message}${observedLabel(r)}`,
    );
  }
  const pending = nextMatrixStep(records);
  lines.push('');
  lines.push(
    pending === null ? 'Matrix complete.' : `Matrix incomplete — next step: ${stepTitle(pending)}.`,
  );
  return lines.join('\n');
}
