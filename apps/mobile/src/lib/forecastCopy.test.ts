/**
 * Forecast copy (m0.8.2): the wording of every finish-line state, the
 * precision ladder in prose, and the goal line — including the two cases
 * where the honest output is NO date and no promise.
 */
import { describe, expect, it } from 'vitest';
import {
  forecastHeadline,
  formatEta,
  goalLine,
  projectionBasis,
  projectionLine,
  timeLine,
} from './forecastCopy';
import type { FinishLine, ForecastView } from './forecast';

/** Fixed local noon, so the day arithmetic cannot straddle a boundary. */
const AT = new Date(2026, 6, 27, 12, 0, 0).getTime();

/** Grouped number in the RUNNING locale. The copy uses toLocaleString so
 * a user sees their own separator; hardcoding "4,012" here would pass in
 * en-US and fail everywhere else — a test asserting the CI machine's
 * locale, not the app's behaviour. */
const n = (value: number): string => value.toLocaleString();

const growing = (over: Partial<Extract<FinishLine, { kind: 'growing' }>> = {}): FinishLine => ({
  kind: 'growing',
  remaining: 4012,
  pace: 62,
  intake: 74,
  growth: 12,
  breakEven: 74,
  goalDays: null,
  ...over,
});

const finishing = (over: Partial<Extract<FinishLine, { kind: 'finishing' }>> = {}): FinishLine => ({
  kind: 'finishing',
  remaining: 4012,
  pace: 100,
  intake: 10,
  net: 90,
  days: 45,
  goalDays: null,
  ...over,
});

describe('formatEta', () => {
  it('names a day when the projection is near', () => {
    expect(formatEta(9, AT)).toMatch(/Aug/);
    expect(formatEta(9, AT)).toMatch(/5/);
  });

  it('drops to a month once past the date horizon', () => {
    const text = formatEta(200, AT);
    expect(text).toMatch(/2027|2026/);
    expect(text).not.toMatch(/\b\d{1,2}\b\s\w{3}$/);
  });

  it('refuses a date entirely beyond ten years', () => {
    expect(formatEta(4000, AT)).toBe('more than ten years away');
  });
});

describe('forecastHeadline', () => {
  it('celebrates being caught up', () => {
    expect(forecastHeadline({ kind: 'caught_up' }, AT)).toBe(
      'All caught up — nothing left to review',
    );
  });

  it('falls back to the plain navigation subtitle without history', () => {
    // The Progress row still has to say what it is.
    expect(forecastHeadline({ kind: 'insufficient_history', decisions: 12 }, AT)).toBe(
      'All photos · state browsing',
    );
  });

  it('states the growth rate and NEVER a date while the backlog grows', () => {
    const text = forecastHeadline(growing(), AT);
    expect(text).toBe(`${n(4012)} photos left · gaining 12/day`);
    expect(text).not.toMatch(/≈|Aug|Sep|20\d\d/);
  });

  it('gives a date once reviewing outruns shooting', () => {
    expect(forecastHeadline(finishing({ days: 9 }), AT)).toMatch(
      new RegExp(`^${n(4012)} photos left · ≈ .+ at this pace$`),
    );
  });

  it('says so plainly rather than printing an absurd date', () => {
    expect(forecastHeadline(finishing({ days: 5000 }), AT)).toBe(
      `${n(4012)} photos left · over ten years at this pace`,
    );
  });

  it('keeps the singular honest', () => {
    expect(forecastHeadline(growing({ remaining: 1 }), AT)).toContain('1 photo left');
  });
});

describe('goalLine', () => {
  it('offers the goal as an escape when it outruns intake', () => {
    expect(goalLine(growing({ goalDays: 27 }), 200, AT)).toMatch(
      /^Hitting 200\/day would clear it by /,
    );
  });

  it('admits when even the goal cannot keep up, and names the pace that can', () => {
    expect(goalLine(growing({ goalDays: null }), 40, AT)).toBe(
      'Even 40/day would not keep up — you would need 74/day just to hold even',
    );
  });

  it('offers an improvement only when the goal actually beats the current pace', () => {
    expect(goalLine(finishing({ days: 45, goalDays: 20 }), 200, AT)).toMatch(/would bring that to/);
    // A goal slower than what you are already doing is not news.
    expect(goalLine(finishing({ days: 20, goalDays: 45 }), 50, AT)).toBeNull();
    expect(goalLine(finishing({ days: 20, goalDays: null }), 50, AT)).toBeNull();
  });

  it('adds nothing to the terminal states', () => {
    expect(goalLine({ kind: 'caught_up' }, 50, AT)).toBeNull();
    expect(goalLine({ kind: 'insufficient_history', decisions: 3 }, 50, AT)).toBeNull();
  });
});

describe('timeLine', () => {
  const view = (timeLeftMs: number | null): ForecastView => ({
    finish: finishing(),
    time:
      timeLeftMs === null
        ? { kind: 'unknown', reason: 'too_few' }
        : { kind: 'known', msPerPhoto: 3000 },
    timeLeftMs,
    projections: null,
  });

  it('says nothing while the rate is unknown', () => {
    expect(timeLine(view(null))).toBeNull();
  });

  it('uses minutes below an hour and hours above it', () => {
    expect(timeLine(view(25 * 60_000))).toBe('≈ 25 min of tapping left');
    expect(timeLine(view(3 * 3_600_000))).toBe('≈ 3 h of tapping left');
    expect(timeLine(view(3 * 3_600_000 + 40 * 60_000))).toBe('≈ 3 h 40 m of tapping left');
  });

  it('says nothing rather than "0 min"', () => {
    expect(timeLine(view(20_000))).toBeNull();
  });
});

describe('projectionLine', () => {
  it('renders a range with its bytes', () => {
    expect(projectionLine(1100, 1380, 'culls', { low: 3_800_000_000, high: 4_700_000_000 })).toBe(
      `≈ ${n(1100)}–${n(1380)} culls · ~3.8 GB–4.7 GB`,
    );
  });

  it('collapses a zero-width range to one number', () => {
    expect(projectionLine(150, 150, 'to edit')).toBe('≈ 150 to edit');
  });

  it('names an EMPTY history rather than predicting zero', () => {
    // m0.8.2: this row used to vanish. A missing row is indistinguishable
    // from a bug, and "≈ 0 favourites" reads as a prediction when it is
    // an absence of evidence.
    expect(projectionLine(0, 0, 'favourites')).toBe(
      'no favourites yet — none in your history to project from',
    );
    // Bytes are irrelevant when there is nothing to project.
    expect(projectionLine(0, 0, 'culls', { low: 0, high: 0 })).toBe(
      'no culls yet — none in your history to project from',
    );
  });

  it('still projects when only the TOP of the range is non-zero', () => {
    // A rare outcome the least-aggressive chunk never produced: the row
    // is a real projection, not an empty history.
    expect(projectionLine(0, 3, 'shares')).toBe('≈ 0–3 shares');
  });

  it('states its basis', () => {
    expect(projectionBasis(1200)).toBe(`From all ${n(1200)} decisions you have made.`);
  });
});
