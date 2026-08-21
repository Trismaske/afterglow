/**
 * Forecast copy (m0.8.2) — the sentences the forecast is allowed to say.
 *
 * Pure and unit-tested on purpose: the REFUSALS live in this file as much
 * as in the math. "No date exists" has to survive contact with a UI that
 * would rather show something, and the only way to keep that honest is to
 * make the wording a tested function rather than JSX written once and
 * never looked at again.
 *
 * The precision ladder (forecast.etaPrecision) is honoured here: a
 * fourteen-day projection names a day, a two-year one names a year. The
 * formatter never prints more precision than the estimate has.
 */
import { etaPrecision, type FinishLine, type ForecastView } from './forecast';
import { formatBytes, plural } from './format';

/** Round-trips through the same locale helpers the rest of the app uses. */
function dateAfter(days: number, at: number): Date {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return date;
}

/** "5 Aug", "November 2026" — precision matched to distance. */
export function formatEta(days: number, at: number): string {
  const date = dateAfter(days, at);
  switch (etaPrecision(days)) {
    case 'days':
    case 'date':
      return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    case 'month':
      return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    case 'beyond':
      return 'more than ten years away';
  }
}

/** Whole-number rate for copy: "62/day", never "61.7/day". */
function rate(perDay: number): string {
  return `${Math.round(perDay)}/day`;
}

function photos(n: number): string {
  return `${plural(n, 'photo')}`;
}

/**
 * The one-line headline — the Progress row's subtitle on Home, and the
 * lead sentence of the Stats Forecast tab.
 *
 * Every branch is a complete thought on its own: this string is rendered
 * with nothing else beside it.
 */
export function forecastHeadline(finish: FinishLine, at: number): string {
  switch (finish.kind) {
    case 'caught_up':
      return 'All caught up — nothing left to review';
    case 'insufficient_history':
      return 'All photos · state browsing';
    case 'growing':
      // No date: at this pace there is no day on which this ends.
      return `${photos(finish.remaining)} left · gaining ${rate(finish.growth)}`;
    case 'finishing':
      return etaPrecision(finish.days) === 'beyond'
        ? `${photos(finish.remaining)} left · over ten years at this pace`
        : `${photos(finish.remaining)} left · ≈ ${formatEta(finish.days, at)} at this pace`;
  }
}

/**
 * The second line: what the daily goal would change.
 *
 * Null when there is nothing useful to add — including the case that
 * matters most, where intake outruns even the goal and promising a date
 * for it would be the same lie in a different hat.
 */
export function goalLine(finish: FinishLine, goal: number, at: number): string | null {
  if (finish.kind === 'growing') {
    if (finish.goalDays === null)
      return `Even ${rate(goal)} would not keep up — you would need ${rate(finish.breakEven)} just to hold even`;
    return `Hitting ${rate(goal)} would clear it by ${formatEta(finish.goalDays, at)}`;
  }
  if (finish.kind === 'finishing' && finish.goalDays !== null && finish.goalDays < finish.days)
    return `Hitting ${rate(goal)} would bring that to ${formatEta(finish.goalDays, at)}`;
  return null;
}

/** "≈ 3 h 40 m of tapping left", or null while the rate is unknown. */
export function timeLine(view: ForecastView): string | null {
  if (view.timeLeftMs === null) return null;
  const minutes = Math.round(view.timeLeftMs / 60_000);
  if (minutes < 1) return null;
  if (minutes < 60) return `≈ ${minutes} min of tapping left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `≈ ${hours} h${rest > 0 ? ` ${rest} m` : ''} of tapping left`;
}

/** One projected-outcome line, e.g. "≈ 1,100–1,380 culls · ~3.8–4.7 GB". */
export function projectionLine(
  low: number,
  high: number,
  noun: string,
  bytes?: { low: number; high: number },
): string {
  // A projected ZERO is an absence of evidence, not a prediction — say so
  // rather than printing "≈ 0 favourites", and rather than dropping the
  // row (m0.8.2: a missing row is indistinguishable from a bug, and it
  // makes the card change shape depending on your habits).
  if (high <= 0) return `no ${noun} yet — none in your history to project from`;
  const count =
    low === high
      ? `≈ ${low.toLocaleString()}`
      : `≈ ${low.toLocaleString()}–${high.toLocaleString()}`;
  if (bytes === undefined) return `${count} ${noun}`;
  const size =
    bytes.low === bytes.high
      ? `~${formatBytes(bytes.low)}`
      : `~${formatBytes(bytes.low)}–${formatBytes(bytes.high)}`;
  return `${count} ${noun} · ${size}`;
}

/** How the projections describe their own basis (D3). */
export function projectionBasis(decisions: number): string {
  return `From all ${decisions.toLocaleString()} decisions you have made.`;
}
