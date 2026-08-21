/**
 * Why an editor (or viewer) launch failed (m0.8.7, Errors_design
 * §4.4/D2) — pure; the impure partner is EditQueueScreen, which runs one
 * `probeLaunch` after a dispatch failure and renders this as the dialog
 * that also offers the full permission matrix.
 *
 * D2's relationship, implemented: `editMatrix` stays the capability
 * probe the user drives deliberately, and it doubles as this
 * classifier's FACT SOURCE — the probe's result values ('no_handler',
 * 'security', …) are typed by OUR OWN Kotlin, so classifying on them is
 * classifying on our facts, never on Android's error text. The launch
 * STAGE (lib/edit.ts) is the other owned fact: a failure while WE
 * resolve the uri or request write access happened before any editor
 * was involved.
 */
import type { MatrixDispatch } from './editMatrix';
import type { EditLaunchStage } from './edit';

export interface EditLaunchFailure {
  operation: 'edit' | 'view';
  /** Where OUR pipeline failed (lib/edit.ts). */
  stage: EditLaunchStage;
  /** One post-failure probe of the same action (probeLaunch) — our
   * native module's own typed verdict. Undefined = the probe itself was
   * unavailable or rejected; nothing is claimed from it then. */
  probe?: MatrixDispatch['result'];
  /** Whatever rode back — verbatim in tier 3 and nowhere else. */
  error?: string;
}

export interface EditLaunchFailureReport {
  title: string;
  body: string;
}

export function describeEditLaunchFailure(failure: EditLaunchFailure): EditLaunchFailureReport {
  const noun = failure.operation === 'edit' ? 'editor' : 'viewer';
  const lines: string[] = [];

  if (failure.stage === 'resolve') {
    // TIER 1: our own resolve step found no content uri.
    lines.push(
      `This photo did not resolve to an Android content address, so no ${noun} could be ` +
        `offered it. A rescan usually repairs this.`,
    );
  } else if (failure.stage === 'write_request') {
    // TIER 1: MediaStore refused OUR write request — no editor involved.
    lines.push(
      'MediaStore refused write access for this photo before any editor was involved, so the ' +
        'launch stopped. The permission matrix below tests every path.',
    );
  } else if (failure.probe === 'no_handler') {
    // TIER 1 from the probe's typed verdict: nothing installed handles it.
    lines.push(
      `No installed app offers photo ${failure.operation === 'edit' ? 'editing' : 'viewing'} — ` +
        `Android found no ${noun} to open. Install or enable one, then retry.`,
    );
  } else if (failure.probe === 'security') {
    lines.push(
      `Android refused Afterglow permission to hand this photo to ${
        failure.operation === 'edit' ? 'an editor' : 'a viewer'
      }. The permission matrix below tests every path.`,
    );
  } else {
    // TIER 2: an honest generic line.
    lines.push(
      `Android could not open ${failure.operation === 'edit' ? 'an editor' : 'a viewer'} for this photo.`,
    );
  }

  // TIER 3: verbatim, unparsed, last.
  const raw = failure.error?.trim();
  if (raw) lines.push(`Android said:\n• ${raw}`);

  return { title: 'Could not open the photo', body: lines.join('\n\n') };
}
