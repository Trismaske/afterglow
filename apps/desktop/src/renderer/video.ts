/**
 * Video slide advance logic (v0.4), kept pure so it is unit-testable
 * without a DOM: a video slide ends at the video's natural end, at the
 * per-video duration cap, or immediately on a playback error — whichever
 * fires first, and exactly once.
 *
 * The slideshow wires a VideoWatch to one <video> element per slide:
 * `ended()` / `error()` are called from the element's event handlers, the
 * cap timer runs internally, and `cancel()` detaches everything when the
 * slide is torn down for any other reason (stop, settings screen).
 */

export type VideoAdvanceReason = 'ended' | 'cap' | 'error';

export interface VideoWatchDeps {
  /**
   * Per-video duration cap in ms (already clamped by main). 0 or less (v0.5
   * "play full length") disables the cap: only ended/error/cancel apply.
   */
  capMs: number;
  /** Fired exactly once with why the slide should advance. */
  onAdvance: (reason: VideoAdvanceReason) => void;
  /** Injectable timers for tests; defaults to the globals. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface VideoWatch {
  /** The <video> fired 'ended'. */
  ended(): void;
  /** The <video> fired 'error' mid-playback. */
  error(): void;
  /** Tear down without advancing (slide replaced / show stopped). */
  cancel(): void;
}

/** Start watching a playing video; the cap timer (if any) starts immediately. */
export function createVideoWatch(deps: VideoWatchDeps): VideoWatch {
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fire = (reason: VideoAdvanceReason): void => {
    if (done) return;
    done = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    deps.onAdvance(reason);
  };

  if (deps.capMs > 0) {
    timer = setTimer(() => fire('cap'), deps.capMs);
  }

  return {
    ended: () => fire('ended'),
    error: () => fire('error'),
    cancel: () => {
      done = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
