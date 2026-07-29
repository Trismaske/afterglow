/**
 * Habits copy (m0.8.2, pure) — the sentences the Habits tab may say,
 * refusals included, for the same reason `forecastCopy.ts` exists: a
 * wording rule that lives only in JSX is a wording rule nobody tests.
 *
 * House style, so the tab reads as one voice: durations are rounded to
 * the unit that matters ("2 days", "40 min", never "1.83 days"), and no
 * sentence states a rate the data cannot support.
 */
import type { Decisiveness, Milestone, RhythmGrid, SittingSummary, Turnaround } from './habits';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "2 pm", "midnight" — an hour a person would say out loud. */
export function hourLabel(hour: number): string {
  if (hour === 0) return 'midnight';
  if (hour === 12) return 'midday';
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

/** A duration at the coarsest unit that still says something. */
export function durationLabel(ms: number): string {
  // Tested on the boundary rather than on the rounded value: 30 s
  // rounds to "1 min", which claims a minute that did not pass.
  if (ms < 60_000) return 'under a minute';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(ms / 86_400_000);
  if (days < 14) return `${days} days`;
  const weeks = Math.round(days / 7);
  return `${weeks} week${weeks === 1 ? '' : 's'}`;
}

/** "You review most on Sunday evenings", or null while it is noise. */
export function rhythmLine(grid: RhythmGrid): string | null {
  if (grid.peakCell === null) return null;
  return `Most of your reviewing happens around ${hourLabel(grid.peakCell.hour)} on ${
    WEEKDAYS[grid.peakCell.weekday]
  }s.`;
}

/** "12 sittings · typically 34 photos over 4 min", or null when empty. */
export function sittingLine(summary: SittingSummary): string | null {
  if (summary.count === 0) return null;
  return (
    `${summary.count} sitting${summary.count === 1 ? '' : 's'} in your recent history · ` +
    `typically ${summary.medianPhotos} photo${summary.medianPhotos === 1 ? '' : 's'} ` +
    `over ${durationLabel(summary.medianDurationMs)}`
  );
}

/** The turnaround half of a queue row: what happens to work you queue. */
export function turnaroundLine(turnaround: Turnaround, noun: string): string {
  switch (turnaround.kind) {
    case 'no_history':
      return turnaround.waiting === 0
        ? 'nothing queued'
        : `${turnaround.waiting} queued · none finished yet`;
    case 'thin':
      return `${turnaround.waiting} queued · ${turnaround.finished} ${noun} finished so far`;
    case 'known':
      return (
        `${turnaround.waiting} queued · ` +
        // Only when it is unusual for you — see Turnaround.stalledMs.
        (turnaround.stalledMs === null ? '' : `oldest ${durationLabel(turnaround.stalledMs)} · `) +
        `usually done within ${durationLabel(turnaround.medianMs)}`
      );
  }
}

/**
 * Percentage points the two rates must differ by before the sentence
 * names a direction. One point is inside the rounding the sentence
 * itself prints at — "27% vs 26%, you are culling harder" claims a trend
 * out of a rounding artefact.
 */
export const DECISIVENESS_CLAIM_POINTS = 2;

/** "Culling harder lately: 38% of the last 900 vs 31% all-time." */
export function decisivenessLine(trend: Decisiveness): string | null {
  if (trend.kind === 'unknown') return null;
  const recent = Math.round(trend.recent * 100);
  const lifetime = Math.round(trend.lifetime * 100);
  const lead =
    Math.abs(recent - lifetime) < DECISIVENESS_CLAIM_POINTS
      ? 'Your standards have held steady'
      : recent > lifetime
        ? 'You are culling harder lately'
        : 'You are keeping more lately';
  return `${lead}: ${recent}% of the last ${trend.recentDecisions.toLocaleString()} decisions vs ${lifetime}% all-time.`;
}

/** "820 of 1,000 reviewed", or the plain total once past the top step. */
export function milestoneLine(item: Milestone): string {
  if (item.next === null) return `${item.value.toLocaleString()} ${item.label}`;
  return `${item.value.toLocaleString()} of ${item.next.toLocaleString()} ${item.label}`;
}

/** How far along the current milestone is, 0..1. */
export function milestoneProgress(item: Milestone): number {
  if (item.next === null || item.next <= 0) return 1;
  return Math.min(1, Math.max(0, item.value / item.next));
}
