/**
 * Editor-launch intent constants + user-facing copy (m0.7 item A).
 *
 * m0.6's silent EDIT→VIEW fallback chain is retired: the gate-0 matrix
 * proved the real failure mode (an app with broad read access cannot
 * delegate a write grant it does not hold), and the tester wants explicit
 * control — so the edit queue offers two buttons instead:
 *
 *  - **Edit**  → write-request-first ACTION_EDIT (edit.ts): ask
 *    MediaStore.createWriteRequest for write access (auto-approved when
 *    already writable), then dispatch EDIT with read+write; denial falls
 *    back to EDIT read-only (the editor saves a copy, which edit
 *    detection picks up).
 *  - **Open in gallery** → ACTION_VIEW, read-only. The gallery's own edit
 *    button takes over with its own write powers (Samsung Gallery never
 *    registers as an EDIT handler, so this is the one-tap path for
 *    Gallery-preferring users).
 */

export const ACTION_EDIT = 'android.intent.action.EDIT';
export const ACTION_VIEW = 'android.intent.action.VIEW';

export const NO_EDITOR_TITLE = 'Could not open the photo';
export const NO_EDITOR_MESSAGE =
  'No installed app accepted the request. Try the other button, or install a photo editor or gallery app and try again.';
