/**
 * The JS-thread lag probe (m0.9 phase 8, prong 4). Every expo-sqlite
 * statement and every native round trip resolves on the JS thread, so a
 * thread held by synchronous work — an engine pass over a window, a
 * large commit — stretches every read in the app by the same wait; the
 * S23 stretched a ~1 s browse page into minutes that way while its
 * cores sat idle. This is the instrument that names it: a timer due
 * every TICK_MS measures how late it actually fired, and a lateness past
 * REPORT_FLOOR_MS is a sample on the `js thread lag` aggregate (one
 * summary line per quiet spell, lib/perfLog.ts). Quiet ticks allocate
 * nothing. Started once at app start (App.tsx); a release-build field
 * line like every other `[perf]` measurement.
 */
import { AppState } from 'react-native';
import { perfAggregate } from './perfLog';

const TICK_MS = 250;
/** A tick this late is starvation, not scheduling noise. */
const REPORT_FLOOR_MS = 50;

/** Start the probe; returns the stop. Only the FOREGROUND is measured:
 * Android pauses JS timers while the app is in the background or the
 * screen is off, and the first tick after a resume reports that whole
 * pause as lateness (the S23 logged one 47 s sample that way). */
export function startJsLagProbe(): () => void {
  let expected = Date.now() + TICK_MS;
  let active = AppState.currentState === 'active';
  const subscription = AppState.addEventListener('change', (next) => {
    active = next === 'active';
    expected = Date.now() + TICK_MS;
  });
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + TICK_MS;
    if (active && lag >= REPORT_FLOOR_MS) perfAggregate('js thread lag', lag);
  }, TICK_MS);
  return () => {
    clearInterval(timer);
    subscription.remove();
  };
}
