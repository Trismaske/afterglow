/**
 * Launch the user's photo editor of choice for one photo, via Android's
 * implicit ACTION_EDIT intent (expo-intent-launcher, SDK 57).
 *
 * Decisions (documented per m0.2 spec):
 * - Action is the raw string `android.intent.action.EDIT` —
 *   `startActivityAsync` accepts `ActivityAction | string` and SDK 57 ships
 *   no ACTION_EDIT constant (its enum is settings screens only).
 * - `data` is the photo's `content://` MediaStore URI (never `file://`,
 *   which external apps can't be granted access to on modern Android).
 * - `flags` = FLAG_GRANT_READ_URI_PERMISSION | FLAG_GRANT_WRITE_URI_PERMISSION
 *   (0x1 | 0x2) so the editor can both read the photo and save over it.
 * - `type: image/*`: explicit MIME matching is more reliable on Samsung
 *   builds whose editor intent filter does not resolve from data alone.
 *
 * m0.5 (Samsung bug): when ACTION_EDIT resolves no activity, fall back to
 * ACTION_VIEW on the same URI (the default viewer's edit button is one tap
 * away) before ever surfacing an error — the chain lives in
 * editFallback.ts (pure, unit-tested). Both intents get the same grant
 * flags so the viewer's built-in editor can save over the photo too.
 *
 * The returned promise resolves when the user comes back to Afterglow.
 * Editors are inconsistent about result codes (most return Canceled even
 * after saving), so callers must not treat the result as "was it edited" —
 * that's what the manual "Mark done" button and m0.3's edit detection are
 * for.
 */
import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { launchWithViewerFallback } from './editFallback';

const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const FLAG_GRANT_WRITE_URI_PERMISSION = 0x00000002;

/** `outcome: viewer` means the ACTION_VIEW fallback ran. */
export type LaunchEditorResult =
  | { outcome: 'returned' | 'viewer' }
  | { outcome: 'unsupported' }
  | { outcome: 'failed'; editError: string; viewError: string; uri: string };

/**
 * Fire ACTION_EDIT (falling back to ACTION_VIEW) for a content URI and
 * wait for the user to return. `outcome: failed` means no installed app handles
 * either intent for this photo. `onViewerLaunch` fires the moment the
 * viewer fallback is dispatched — the caller's toast hook.
 */
export async function launchEditor(
  contentUri: string,
  onViewerLaunch?: () => void,
): Promise<LaunchEditorResult> {
  if (Platform.OS !== 'android') return { outcome: 'unsupported' };
  if (!contentUri.startsWith('content://')) {
    return {
      outcome: 'failed',
      editError: 'The selected asset did not resolve to a content URI.',
      viewError: 'Viewer launch was not attempted.',
      uri: contentUri,
    };
  }
  const result = await launchWithViewerFallback(
    (action) =>
      IntentLauncher.startActivityAsync(action, {
        data: contentUri,
        type: 'image/*',
        flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_GRANT_WRITE_URI_PERMISSION,
      }),
    onViewerLaunch,
  );
  return result.outcome === 'failed' ? { ...result, uri: contentUri } : result;
}
