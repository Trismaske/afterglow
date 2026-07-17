/**
 * The ONE exit path. Every input signal (mouse move, key, click) funnels
 * through this arbiter; nothing else in the renderer may leave the show.
 * Since v0.5 `onExit` doesn't necessarily quit the app: on a manual launch
 * it returns to the settings screen, in --show/screensaver mode it quits.
 *
 * Mouse-move threshold: the first mousemove after arming only records a
 * baseline position (Chromium can emit a synthetic move on window show, and
 * a nudged desk jiggles the mouse a little); we exit only once the pointer
 * has moved more than `moveThresholdPx` (default 24 CSS px) away from that
 * baseline.
 *
 * v0.2 hook: pass `isExemptKey` to let flag keys (D/E/M/R/N/T), nav arrows
 * and O/Q/S through without exiting.
 */

export interface ExitArbiterOptions {
  /** Pointer displacement from baseline (CSS px) that triggers exit. */
  moveThresholdPx?: number;
  /** Keys that must NOT exit (v0.2 flag keys). Return true to exempt. */
  isExemptKey?: (key: string) => boolean;
  /** Called exactly once, with a human-readable reason. */
  onExit: (reason: string) => void;
}

export const DEFAULT_MOVE_THRESHOLD_PX = 24;

export interface ExitArbiter {
  /**
   * Start reacting to input (call when the show / message screen is up).
   * Re-arming starts a fresh session: the fired latch and the pointer
   * baseline reset, so a settings → show round-trip (v0.5 manual mode) can
   * fire again.
   */
  arm(): void;
  /** Stop reacting (first-run screen needs clicks to work). */
  disarm(): void;
  pointerMoved(x: number, y: number): void;
  keyDown(key: string): void;
  pointerDown(): void;
  readonly fired: boolean;
}

export function createExitArbiter(opts: ExitArbiterOptions): ExitArbiter {
  const threshold = opts.moveThresholdPx ?? DEFAULT_MOVE_THRESHOLD_PX;
  let armed = false;
  let fired = false;
  let baseline: { x: number; y: number } | null = null;

  function fire(reason: string): void {
    if (!armed || fired) return;
    fired = true;
    opts.onExit(reason);
  }

  return {
    arm() {
      armed = true;
      fired = false;
      baseline = null;
    },
    disarm() {
      armed = false;
      baseline = null;
    },
    pointerMoved(x: number, y: number) {
      if (!armed || fired) return;
      if (baseline === null) {
        baseline = { x, y };
        return;
      }
      if (Math.hypot(x - baseline.x, y - baseline.y) > threshold) {
        fire('mouse-move');
      }
    },
    keyDown(key: string) {
      if (!armed || fired) return;
      if (opts.isExemptKey?.(key)) return;
      fire(`key:${key}`);
    },
    pointerDown() {
      fire('click');
    },
    get fired() {
      return fired;
    },
  };
}
