/**
 * Similarity-threshold setting (m0.4) — pure logic, unit-tested; the
 * Settings screen renders the steps and persists via the settings table
 * (m0.3.1, key/value).
 *
 * The threshold is the maximum Hamming distance (0–64) between two
 * photos' dHashes that still counts as "same moment" when refining time
 * clusters (core refineClustersBySimilarity). LOWER = stricter = more
 * splitting; HIGHER = looser = groups more photos together. The classic
 * dHash duplicate cutoff is ~10 of 64, but Afterglow groups related
 * shots of a scene (not just duplicates), so Normal sits at 12 and the
 * scale extends looser on purpose.
 */

/** settings-table key for the persisted threshold. */
export const SIMILARITY_THRESHOLD_KEY = 'similarity_threshold';

/** Hamming distances are 0..64 bits. */
export const MAX_SIMILARITY_THRESHOLD = 64;

export const DEFAULT_SIMILARITY_THRESHOLD = 12;

export interface SimilarityStep {
  value: number;
  label: string;
  hint: string;
}

/** The stepped control shown in Settings, strictest → loosest. */
export const SIMILARITY_STEPS: readonly SimilarityStep[] = [
  { value: 4, label: 'Strictest', hint: 'Only near-identical shots stay grouped' },
  { value: 8, label: 'Strict', hint: 'Tight bursts stay grouped; scene changes split' },
  { value: 12, label: 'Normal', hint: 'Shots of the same scene stay grouped' },
  { value: 18, label: 'Loose', hint: 'Groups more photos together' },
  { value: 26, label: 'Loosest', hint: 'Splits only clearly unrelated photos' },
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
