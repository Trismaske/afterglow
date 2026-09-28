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
import type { StoredMediaKind } from './mediaIdentity';
import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { requestMediaWriteAccess } from '../../modules/media-store-actions';
import { ACTION_EDIT, ACTION_VIEW, launchMimeType } from './editActions';

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
  kind: StoredMediaKind,
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
      type: launchMimeType(kind),
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
export async function launchViewer(
  contentUri: string,
  kind: StoredMediaKind,
): Promise<ViewLaunchResult> {
  if (Platform.OS !== 'android') return { outcome: 'unsupported' };
  if (!contentUri.startsWith('content://')) {
    return {
      outcome: 'failed',
      stage: 'resolve',
      error: 'The selected asset did not resolve to a content URI.',
      uri: contentUri,
    };
  }
  const params = {
    data: contentUri,
    type: launchMimeType(kind),
    flags: FLAG_GRANT_READ_URI_PERMISSION,
  };
  // A VIDEO reaches Samsung Gallery only by name (F37, measured on the
  // S10e and S23 2026-09-28): Gallery's external viewer declares a VIEW
  // filter for content video/* WITHOUT the DEFAULT category, so no
  // implicit chooser lists it, yet the explicit component opens the
  // clip in Gallery's own player with its edit and favourite controls.
  // Absent Gallery (any other phone) the launch throws and the implicit
  // chooser takes over, exactly as for a photo. A Gallery that opens and
  // then declines the item returns like a closed viewer — the same
  // result the chooser's own viewers give, which no caller can tell from
  // a viewing, so the "Done editing?" question follows either way.
  if (kind === 'video') {
    try {
      await IntentLauncher.startActivityAsync(ACTION_VIEW, {
        ...params,
        packageName: SAMSUNG_GALLERY_PACKAGE,
        className: SAMSUNG_GALLERY_EXTERNAL_VIEWER,
      });
      return { outcome: 'returned' };
    } catch (error) {
      console.log(`[edit] Samsung Gallery viewer unavailable, chooser instead: ${message(error)}`);
    }
  }
  try {
    await IntentLauncher.startActivityAsync(ACTION_VIEW, params);
    return { outcome: 'returned' };
  } catch (error) {
    return { outcome: 'failed', stage: 'dispatch', error: message(error), uri: contentUri };
  }
}

const SAMSUNG_GALLERY_PACKAGE = 'com.sec.android.gallery3d';
const SAMSUNG_GALLERY_EXTERNAL_VIEWER =
  'com.samsung.android.gallery.app.activity.external.GalleryExternalActivity';
