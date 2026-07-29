/**
 * Habits copy (m0.8.2). The sentences are tested because the rules that
 * keep them honest — no rate without completions, no "peak" without a
 * sample — live in the wording as much as in the math.
 */
import { describe, expect, it } from 'vitest';
import { rhythmGrid, MIN_DECISIONS_FOR_RHYTHM, milestone } from './habits';
import {
  decisivenessLine,
  durationLabel,
  hourLabel,
  milestoneLine,
  milestoneProgress,
  rhythmLine,
  sittingLine,
  turnaroundLine,
} from './habitsCopy';

describe('hourLabel', () => {
  it('says the hour the way a person would', () => {
    expect(hourLabel(0)).toBe('midnight');
    expect(hourLabel(9)).toBe('9 am');
    expect(hourLabel(12)).toBe('midday');
    expect(hourLabel(20)).toBe('8 pm');
    expect(hourLabel(23)).toBe('11 pm');
  });
});

describe('durationLabel', () => {
  it('picks the coarsest unit that still says something', () => {
    expect(durationLabel(20_000)).toBe('under a minute');
    expect(durationLabel(4 * 60_000)).toBe('4 min');
    expect(durationLabel(90 * 60_000)).toBe('2 hours');
    expect(durationLabel(2 * 86_400_000)).toBe('2 days');
    expect(durationLabel(21 * 86_400_000)).toBe('3 weeks');
  });

  it('never prints a fractional day', () => {
    // 43.9 hours is "2 days": below 36 hours the hour is the useful unit,
    // above it the day is, and "1.83 days" is useful to nobody.
    expect(durationLabel(1.83 * 86_400_000)).toBe('2 days');
    expect(durationLabel(30 * 3_600_000)).toBe('30 hours');
  });
});

describe('rhythmLine', () => {
  it('names the peak once there is a pattern to name', () => {
    const grid = rhythmGrid([{ weekday: 0, hour: 20, count: MIN_DECISIONS_FOR_RHYTHM }]);
    expect(rhythmLine(grid)).toBe('Most of your reviewing happens around 8 pm on Sundays.');
  });

  it('says nothing at all below the floor', () => {
    expect(rhythmLine(rhythmGrid([{ weekday: 0, hour: 20, count: 3 }]))).toBeNull();
  });
});

describe('sittingLine', () => {
  it('describes typical sittings, or nothing when there are none', () => {
    expect(sittingLine({ count: 12, medianPhotos: 34, medianDurationMs: 4 * 60_000 })).toBe(
      '12 sittings in your recent history · typically 34 photos over 4 min',
    );
    expect(sittingLine({ count: 0, medianPhotos: 0, medianDurationMs: 0 })).toBeNull();
  });

  it('drops the duration when the typical sitting is a single photo', () => {
    // A one-photo median (splitSittings retains isolated decisions as
    // one-photo sittings) has a 0 ms span — "over under a minute" would
    // dress a figure around nothing.
    expect(sittingLine({ count: 1, medianPhotos: 1, medianDurationMs: 0 })).toBe(
      '1 sitting in your recent history · typically a single photo at a time',
    );
  });
});

describe('turnaroundLine', () => {
  it('does not invent a completion rate out of nothing', () => {
    expect(turnaroundLine({ kind: 'no_history', waiting: 0 }, 'edits')).toBe('nothing queued');
    expect(turnaroundLine({ kind: 'no_history', waiting: 7 }, 'edits')).toBe(
      '7 queued · none finished yet',
    );
  });

  it('states the sample while it is still thin', () => {
    expect(turnaroundLine({ kind: 'thin', waiting: 3, finished: 2 }, 'moves')).toBe(
      '3 queued · 2 moves finished so far',
    );
  });

  it('states the typical turnaround, and stays quiet about a normal wait', () => {
    // m0.8.2: no completion RATE — the queues drain, so any rate reads
    // ~100% for everyone. The median is what actually varies.
    expect(
      turnaroundLine(
        {
          kind: 'known',
          waiting: 12,
          finished: 18,
          medianMs: 2 * 86_400_000,
          stalledMs: null,
        },
        'edits',
      ),
    ).toBe('12 queued · usually done within 2 days');
  });

  it('names the oldest wait only when it has outlasted the typical one', () => {
    expect(
      turnaroundLine(
        {
          kind: 'known',
          waiting: 3,
          finished: 18,
          medianMs: 2 * 86_400_000,
          stalledMs: 9 * 86_400_000,
        },
        'edits',
      ),
    ).toBe('3 queued · oldest 9 days · usually done within 2 days');
  });
});

describe('decisivenessLine', () => {
  it('names the direction the standards moved', () => {
    expect(
      decisivenessLine({
        kind: 'known',
        recent: 0.38,
        lifetime: 0.31,
        delta: 0.07,
        recentDecisions: 900,
      }),
    ).toBe(
      `You are culling harder lately: 38% of the last ${(900).toLocaleString()} decisions vs 31% all-time.`,
    );
    expect(
      decisivenessLine({
        kind: 'known',
        recent: 0.2,
        lifetime: 0.31,
        delta: -0.11,
        recentDecisions: 40,
      }),
    ).toContain('You are keeping more lately');
    expect(
      decisivenessLine({
        kind: 'known',
        recent: 0.3,
        lifetime: 0.3,
        delta: 0,
        recentDecisions: 40,
      }),
    ).toContain('held steady');
  });

  it('does not claim a trend out of a rounding artefact', () => {
    // 27% vs 26% is one point — inside what the sentence itself rounds to.
    const line = decisivenessLine({
      kind: 'known',
      recent: 0.274,
      lifetime: 0.264,
      delta: 0.01,
      recentDecisions: 1_679,
    });
    expect(line).toContain('held steady');
    expect(line).toContain('27% of the last');
    expect(line).toContain('26% all-time');
  });

  it('says nothing when there is nothing to compare', () => {
    expect(decisivenessLine({ kind: 'unknown' })).toBeNull();
  });
});

describe('milestones', () => {
  it('counts toward the next round number, then stops counting', () => {
    // The separator is the DEVICE's (the S10e prints "1 000"), so the
    // expectation must go through the same formatter, never a literal.
    expect(milestoneLine(milestone('photos reviewed', 820))).toBe(
      `820 of ${(1000).toLocaleString()} photos reviewed`,
    );
    expect(milestoneProgress(milestone('photos reviewed', 820))).toBeCloseTo(0.82, 5);
    expect(milestoneLine(milestone('culled', 250_000))).toBe(
      `${(250_000).toLocaleString()} culled`,
    );
    expect(milestoneProgress(milestone('culled', 250_000))).toBe(1);
  });
});
