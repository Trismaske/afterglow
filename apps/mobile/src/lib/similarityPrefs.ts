/**
 * Similarity-threshold setting (m0.4, rescaled in m0.5) — pure logic,
 * unit-tested; the Settings screen renders the steps and persists via
 * the settings table (m0.3.1, key/value).
 *
 * The threshold is the maximum Hamming distance (0–64) between two
 * photos' dHashes that still counts as "same moment" when refining time
 * clusters (core refineClustersBySimilarity). LOWER = stricter = more
 * splitting; HIGHER = looser = groups more photos together.
 *
 * m0.5 rescale (tester feedback: identical photos must group even on
 * Strictest): the whole five-step scale shifted looser — old Normal (12)
 * became the new Strictest, and the top end stays temporal-proximity-
 * dominant. Existing stored values need no migration: any int 0–64 stays
 * valid; off-step values just render as "Custom (N)" next to the m0.5
 * fine-tune slider.
 */

/** settings-table key for the persisted threshold. */
export const SIMILARITY_THRESHOLD_KEY = 'similarity_threshold';

/** Hamming distances are 0..64 bits. */
export const MAX_SIMILARITY_THRESHOLD = 64;

export const DEFAULT_SIMILARITY_THRESHOLD = 20;

export interface SimilarityStep {
  value: number;
  label: string;
  hint: string;
}

/** The stepped control shown in Settings, strictest → loosest. */
export const SIMILARITY_STEPS: readonly SimilarityStep[] = [
  { value: 12, label: 'Strictest', hint: 'Only near-identical shots stay grouped' },
  { value: 16, label: 'Strict', hint: 'Tight bursts stay grouped; scene changes split' },
  { value: 20, label: 'Normal', hint: 'Shots of the same scene stay grouped' },
  { value: 26, label: 'Loose', hint: 'Groups more photos together' },
  { value: 32, label: 'Loosest', hint: 'Splits only clearly unrelated photos' },
] as const;

/**
 * Parse a persisted threshold. Any integer 0..64 is accepted (forward
 * compatibility if the steps ever change); absent or garbage values fall
 * back to the default.
 */
export function parseSimilarityThreshold(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_SIMILARITY_THRESHOLD;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SIMILARITY_THRESHOLD) {
    return DEFAULT_SIMILARITY_THRESHOLD;
  }
  return n;
}

export function serializeSimilarityThreshold(threshold: number): string {
  return String(threshold);
}

/** The step whose value is nearest the given threshold (ties → stricter). */
export function nearestStep(threshold: number): SimilarityStep {
  let best = SIMILARITY_STEPS[0];
  for (const step of SIMILARITY_STEPS) {
    if (Math.abs(step.value - threshold) < Math.abs(best.value - threshold)) best = step;
  }
  return best;
}

/** The step matching the threshold exactly, or null (off-preset → "Custom"). */
export function exactStep(threshold: number): SimilarityStep | null {
  return SIMILARITY_STEPS.find((s) => s.value === threshold) ?? null;
}

/**
 * Label for the current threshold: the preset name when it sits on a
 * chip, otherwise "Custom (N)" (the m0.5 fine-tune slider can pick any
 * of the 65 raw values).
 */
export function thresholdLabel(threshold: number): string {
  return exactStep(threshold)?.label ?? `Custom (${threshold})`;
}
