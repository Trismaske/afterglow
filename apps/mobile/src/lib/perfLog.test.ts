import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { perfAggregate, setPerfLogging } from './perfLog';

describe('perfAggregate (m0.8.7 shape rule: per-page lines settle into one)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setPerfLogging(true);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits ONE summary line with count, range, median and items after quiet', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    perfAggregate('timeline browse pages', 30, 40);
    perfAggregate('timeline browse pages', 10, 40);
    perfAggregate('timeline browse pages', 20, 40);
    expect(log).not.toHaveBeenCalled(); // nothing lands per sample
    vi.advanceTimersByTime(10_000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[perf] timeline browse pages: 3 samples, 10–30 ms (median 20, 120 items)',
    );
  });

  it('a fresh sample within the quiet window keeps accumulating', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    perfAggregate('k', 5);
    vi.advanceTimersByTime(9_000);
    perfAggregate('k', 7);
    vi.advanceTimersByTime(9_000);
    expect(log).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(log).toHaveBeenCalledWith('[perf] k: 2 samples, 5–7 ms (median 7)');
  });

  it('does nothing when perf logging is off', () => {
    setPerfLogging(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    perfAggregate('k', 5);
    vi.advanceTimersByTime(20_000);
    expect(log).not.toHaveBeenCalled();
    setPerfLogging(true);
  });
});
