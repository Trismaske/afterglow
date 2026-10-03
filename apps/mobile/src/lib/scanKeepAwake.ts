/**
 * Keep the screen awake while a pass or its check runs in the FOREGROUND
 * (m0.9 phase 9, `expo-keep-awake`). A phone left on the charger with Afterglow
 * open then finishes its pass instead of being throttled or killed with
 * the screen — the S23's 27-minute session that ended without a trace
 * (docs/Plan_m0.9.md, phase 9) went exactly that way. Released at
 * done, idle, error, and whenever the app leaves the foreground: the
 * wake lock never outlives the work or the user's attention on it.
 * Background execution stays out of scope; this is its prerequisite.
 */
import { AppState } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { getScanStatus, subscribeScanStatus } from '../scan/scanRunner';

const TAG = 'afterglow-scan';

/** Follow the scan status and the app state for the process life;
 * returns the teardown. */
export function startScanKeepAwake(): () => void {
  let held = false;
  const sync = (): void => {
    // The check phase too (codex r5): the loss reconciliation runs
    // inside it, and a mass delete's probe-per-candidate walk is minutes.
    const phase = getScanStatus().phase;
    const want =
      (phase === 'scanning' || phase === 'checking') && AppState.currentState === 'active';
    if (want === held) return;
    held = want;
    const change = want ? activateKeepAwakeAsync(TAG) : deactivateKeepAwake(TAG);
    change.catch((error: unknown) => {
      // Loud, once per change: a wake lock that could not be taken only
      // costs the pass its guarantee against the screen timeout.
      console.warn(`[scan] keep-awake ${want ? 'activate' : 'release'} failed:`, String(error));
    });
  };
  const unsubscribe = subscribeScanStatus(sync);
  const appState = AppState.addEventListener('change', sync);
  sync();
  return () => {
    unsubscribe();
    appState.remove();
    if (held) void deactivateKeepAwake(TAG).catch(() => {});
  };
}
