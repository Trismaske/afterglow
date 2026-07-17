import { describe, expect, it } from 'vitest';
import { createVideoWatch, type VideoAdvanceReason } from '../src/renderer/video';

/** Minimal deterministic fake timer: fires on demand, tracks clears. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      pending.delete(handle as unknown as number);
    },
    /** Fire every currently-pending timer (the watch only ever sets one). */
    fireAll: () => {
      for (const { fn } of [...pending.values()]) fn();
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

function watchWith(capMs = 30_000) {
  const timers = fakeTimers();
  const reasons: VideoAdvanceReason[] = [];
  const watch = createVideoWatch({
    capMs,
    onAdvance: (reason) => reasons.push(reason),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { timers, reasons, watch };
}

describe('createVideoWatch', () => {
  it('advances once with "ended" when the video ends before the cap', () => {
    const { timers, reasons, watch } = watchWith();
    watch.ended();
    expect(reasons).toEqual(['ended']);
    expect(timers.pendingCount).toBe(0); // cap timer cleared
    // late/dup events never double-advance
    watch.ended();
    watch.error();
    timers.fireAll();
    expect(reasons).toEqual(['ended']);
  });

  it('advances once with "cap" when the duration cap fires first', () => {
    const { timers, reasons, watch } = watchWith(5000);
    timers.fireAll(); // the cap timer
    expect(reasons).toEqual(['cap']);
    watch.ended(); // 'ended' arriving after the cap is ignored
    expect(reasons).toEqual(['cap']);
  });

  it('advances once with "error" on playback failure', () => {
    const { timers, reasons, watch } = watchWith();
    watch.error();
    expect(reasons).toEqual(['error']);
    expect(timers.pendingCount).toBe(0);
    watch.ended();
    expect(reasons).toEqual(['error']);
  });

  it('cancel() tears down without advancing', () => {
    const { timers, reasons, watch } = watchWith();
    watch.cancel();
    expect(timers.pendingCount).toBe(0);
    watch.ended();
    watch.error();
    timers.fireAll();
    expect(reasons).toEqual([]);
  });

  it('a zero/negative cap still schedules (clamped to 0ms) and fires as cap', () => {
    const { timers, reasons } = watchWith(-5);
    timers.fireAll();
    expect(reasons).toEqual(['cap']);
  });
});
