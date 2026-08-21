/**
 * Editor / gallery launch (m0.7 item A — mechanism selected by the gate-0
 * device matrix, run on the Samsung tester device and the emulator with
 * identical results):
 *
 * - Attaching FLAG_GRANT_WRITE_URI_PERMISSION without holding write access
 *   throws SecurityException AT DISPATCH on Android 16 (stock behavior,
 *   not OEM) — m0.6 attached it to both EDIT and VIEW, so both failed.
 * - After one MediaStore.createWriteRequest approval the same EDIT
 *   read+write intent dispatches fine. The request auto-approves without
 *   a dialog when the app already has write access.
 *
 * So `launchEditor` is write-request-first: request write access, then
 * dispatch ACTION_EDIT with read(+write when granted). Denial degrades to
 * read-only EDIT — editors then save a copy, which m0.3 edit detection
 * tracks. `launchViewer` is the explicit read-only ACTION_VIEW path ("Open
 * in gallery") — the viewer's own edit button uses its own write powers.
 *
 * Both promises resolve when the user returns to Afterglow. Editors are
 * inconsistent about result codes, so callers must never treat the result
 * as "was it edited" — that's manual Mark done + edit detection.
 */
import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { requestMediaWriteAccess } from '../../modules/media-store-actions';
import { ACTION_EDIT, ACTION_VIEW } from './editActions';

const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const FLAG_GRANT_WRITE_URI_PERMISSION = 0x00000002;

/** Where a launch failed — OUR pipeline stage, never a reading of the
 * error text (Errors_design §4.4): 'resolve' = the asset had no content
 * uri, 'write_request' = MediaStore refused write access before any
 * editor was involved, 'dispatch' = the intent itself. */
export type EditLaunchStage = 'resolve' | 'write_request' | 'dispatch';

export type EditLaunchResult =
  | { outcome: 'returned'; writeGranted: boolean }
  | { outcome: 'unsupported' }
  | { outcome: 'failed'; stage: EditLaunchStage; error: string; uri: string };

export type ViewLaunchResult =
  | { outcome: 'returned' }
  | { outcome: 'unsupported' }
  | { outcome: 'failed'; stage: EditLaunchStage; error: string; uri: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Write-request-first ACTION_EDIT. `onDispatch` fires the moment the
 * intent is accepted (toast hook), before the user's editor round-trip.
 */
export async function launchEditor(
  contentUri: string,
  onDispatch?: (writeGranted: boolean) => void,
): Promise<EditLaunchResult> {
  if (Platform.OS !== 'android') return { outcome: 'unsupported' };
  if (!contentUri.startsWith('content://')) {
    return {
      outcome: 'failed',
      stage: 'resolve',
      error: 'The selected asset did not resolve to a content URI.',
      uri: contentUri,
    };
  }
  // Gate-0 mechanism: obtain write access BEFORE attaching the write flag.
  // 'cancelled' (user denied) and 'unsupported' (pre-R) degrade to
  // read-only; the editor will save-as-copy and detection tracks it. A
  // REJECTION (no activity, MediaStore refuses the URI) is a failure —
  // the result union must hold so callers show the alert, not an
  // unhandled rejection.
  let writeGranted = false;
  try {
    const { status } = await requestMediaWriteAccess([contentUri]);
    writeGranted = status === 'applied';
  } catch (error) {
    return { outcome: 'failed', stage: 'write_request', error: message(error), uri: contentUri };
  }
  try {
    const pending = IntentLauncher.startActivityAsync(ACTION_EDIT, {
      data: contentUri,
      type: 'image/*',
      flags: FLAG_GRANT_READ_URI_PERMISSION | (writeGranted ? FLAG_GRANT_WRITE_URI_PERMISSION : 0),
    });
    onDispatch?.(writeGranted);
    await pending;
    return { outcome: 'returned', writeGranted };
  } catch (error) {
    return { outcome: 'failed', stage: 'dispatch', error: message(error), uri: contentUri };
  }
}

/** Read-only ACTION_VIEW — the "Open in gallery" button. */
export async function launchViewer(contentUri: string): Promise<ViewLaunchResult> {
  if (Platform.OS !== 'android') return { outcome: 'unsupported' };
  if (!contentUri.startsWith('content://')) {
    return {
      outcome: 'failed',
      stage: 'resolve',
      error: 'The selected asset did not resolve to a content URI.',
      uri: contentUri,
    };
  }
  try {
    await IntentLauncher.startActivityAsync(ACTION_VIEW, {
      data: contentUri,
      type: 'image/*',
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
    return { outcome: 'returned' };
  } catch (error) {
    return { outcome: 'failed', stage: 'dispatch', error: message(error), uri: contentUri };
  }
}
