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
 * - No `type`: per the SDK 57 docs, omitting it lets Android infer the
 *   exact MIME type from the content provider, which matches more editor
 *   intent filters than a hardcoded `image/*`.
 *
 * The returned promise resolves when the user comes back to Afterglow.
 * Editors are inconsistent about result codes (most return Canceled even
 * after saving), so callers must not treat the result as "was it edited" —
 * that's what the manual "Mark done" button and m0.3's edit detection are
 * for.
 */
import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';

const ACTION_EDIT = 'android.intent.action.EDIT';
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const FLAG_GRANT_WRITE_URI_PERMISSION = 0x00000002;

export type LaunchEditorResult = 'returned' | 'unsupported' | 'failed';

/**
 * Fire ACTION_EDIT for a content URI and wait for the user to return.
 * 'failed' usually means no installed app handles ACTION_EDIT for images.
 */
export async function launchEditor(contentUri: string): Promise<LaunchEditorResult> {
  if (Platform.OS !== 'android') return 'unsupported';
  try {
    await IntentLauncher.startActivityAsync(ACTION_EDIT, {
      data: contentUri,
      flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_GRANT_WRITE_URI_PERMISSION,
    });
    return 'returned';
  } catch {
    return 'failed';
  }
}
