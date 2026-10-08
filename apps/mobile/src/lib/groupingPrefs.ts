/**
 * Grouping strictness (m0.8 gate 4): ONE simplified control replacing the
 * m0.7 dHash chips/slider. Each step maps to the embedding engine's base
 * cosine threshold around the calibrated 0.50 default (Plan_m0.8.md
 * decision 8); the time-decay bonus and merge stages are untouched. The
 * range mirrors the calibrated band (0.42 is the curve's 60 s floor;
 * 0.58 sits at the near-instant link floor) — the committed regression
 * suite pins the DEFAULT, and the control cannot stray past the band the
 * judged rounds measured.
 */

export const GROUPING_STRICTNESS_KEY = 'grouping_strictness';
/** Settings key: the grouping rules version (core GROUPING_RULES_VERSION)
 * the last COMPLETE full pass grouped under. A different current version
 * is a full pass (m0.9 phase 10): a rule change regroups everything. */
export const GROUPING_RULES_KEY = 'grouping_rules';

export interface StrictnessStep {
  id: string;
  label: string;
  baseThreshold: number;
}

export const STRICTNESS_STEPS: readonly StrictnessStep[] = [
  { id: 'loosest', label: 'Loosest', baseThreshold: 0.42 },
  { id: 'looser', label: 'Looser', baseThreshold: 0.46 },
  { id: 'default', label: 'Default', baseThreshold: 0.5 },
  { id: 'stricter', label: 'Stricter', baseThreshold: 0.54 },
  { id: 'strictest', label: 'Strictest', baseThreshold: 0.58 },
];

export function parseStrictness(raw: string | null): StrictnessStep {
  return STRICTNESS_STEPS.find((s) => s.id === raw) ?? STRICTNESS_STEPS[2];
}

export function serializeStrictness(step: StrictnessStep): string {
  return step.id;
}
