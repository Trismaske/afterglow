/**
 * Editor-launch fallback chain (m0.5, Samsung bug) — pure logic, unit-
 * tested. Some devices (notably Samsung with Gallery updated via the
 * store) resolve NO activity for ACTION_EDIT on MediaStore URIs. Instead
 * of dead-ending with an error, fall back to ACTION_VIEW: the default
 * viewer (Samsung Gallery, Google Photos, …) opens and its edit button
 * is one tap away. Only when BOTH intents fail does the caller show an
 * error — reworded in m0.5 to drop the confusing "or enable" phrase.
 *
 * The impure Android binding (expo-intent-launcher, Platform check)
 * lives in edit.ts; this module only sequences injected launchers so
 * the decision logic is testable without React Native.
 */

export const ACTION_EDIT = 'android.intent.action.EDIT';
export const ACTION_VIEW = 'android.intent.action.VIEW';

/** Toast shown the moment the viewer fallback fires. */
export const VIEWER_FALLBACK_TOAST = 'Opened in viewer — use its edit button';

/** Error copy when neither an editor nor a viewer could open the photo. */
export const NO_EDITOR_TITLE = 'Could not open the photo';
export const NO_EDITOR_MESSAGE =
  'No installed app could edit or even view this photo. Install a photo editor or gallery app and try again.';

/**
 * Outcome of one launch attempt chain:
 * - 'returned': ACTION_EDIT launched; the user came back from the editor.
 * - 'viewer':   ACTION_EDIT resolved nothing; ACTION_VIEW launched and the
 *               user came back from the viewer.
 * - 'failed':   neither intent resolved an activity.
 */
export type FallbackOutcome = 'returned' | 'viewer' | 'failed';

/**
 * Fire ACTION_EDIT; on failure fall back to ACTION_VIEW on the same URI.
 * `launch(action)` must reject when Android resolves no activity for the
 * intent, and resolve when the user returns to the app.
 * `onViewerLaunch` fires as soon as the fallback intent is dispatched —
 * the right moment for a toast (it overlays the opening viewer).
 */
export async function launchWithViewerFallback(
  launch: (action: string) => Promise<unknown>,
  onViewerLaunch?: () => void,
): Promise<FallbackOutcome> {
  try {
    await launch(ACTION_EDIT);
    return 'returned';
  } catch {
    try {
      const returned = launch(ACTION_VIEW);
      // An unresolvable intent rejects immediately, so a toast fired here
      // only ever races the error in the no-viewer-at-all case.
      onViewerLaunch?.();
      await returned;
      return 'viewer';
    } catch {
      return 'failed';
    }
  }
}
