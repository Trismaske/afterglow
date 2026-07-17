import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  MAX_SIMILARITY_THRESHOLD,
  nearestStep,
  parseSimilarityThreshold,
  serializeSimilarityThreshold,
  SIMILARITY_STEPS,
} from './similarityPrefs';

describe('SIMILARITY_STEPS', () => {
  it('is ordered strictest → loosest with unique values in range', () => {
    const values = SIMILARITY_STEPS.map((s) => s.value);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(MAX_SIMILARITY_THRESHOLD);
    }
  });

  it('includes the default as a selectable step', () => {
    expect(SIMILARITY_STEPS.some((s) => s.value === DEFAULT_SIMILARITY_THRESHOLD)).toBe(true);
  });
});

describe('parseSimilarityThreshold', () => {
  it('round-trips every step through serialize/parse', () => {
    for (const step of SIMILARITY_STEPS) {
      expect(parseSimilarityThreshold(serializeSimilarityThreshold(step.value))).toBe(step.value);
    }
  });

  it('accepts any integer 0..64, including the edges', () => {
    expect(parseSimilarityThreshold('0')).toBe(0);
    expect(parseSimilarityThreshold('64')).toBe(64);
    expect(parseSimilarityThreshold('33')).toBe(33);
  });

  it('falls back to the default for absent or invalid values', () => {
    expect(parseSimilarityThreshold(null)).toBe(DEFAULT_SIMILARITY_THRESHOLD);
    expect(parseSimilarityThreshold('')).toBe(DEFAULT_SIMILARITY_THRESHOLD);
    expect(parseSimilarityThreshold('-1')).toBe(DEFAULT_SIMILARITY_THRESHOLD);
    expect(parseSimilarityThreshold('65')).toBe(DEFAULT_SIMILARITY_THRESHOLD);
    expect(parseSimilarityThreshold('12.5')).toBe(DEFAULT_SIMILARITY_THRESHOLD);
    expect(parseSimilarityThreshold('loose')).toBe(DEFAULT_SIMILARITY_THRESHOLD);
    expect(parseSimilarityThreshold('NaN')).toBe(DEFAULT_SIMILARITY_THRESHOLD);
  });
});

describe('nearestStep', () => {
  it('returns exact matches', () => {
    for (const step of SIMILARITY_STEPS) {
      expect(nearestStep(step.value)).toBe(step);
    }
  });

  it('snaps in-between values to the nearest step, ties toward stricter', () => {
    expect(nearestStep(0).value).toBe(4);
    expect(nearestStep(5).value).toBe(4);
    expect(nearestStep(10).value).toBe(8); // tie 8 vs 12 → stricter
    expect(nearestStep(15).value).toBe(12); // tie 12 vs 18 → stricter
    expect(nearestStep(64).value).toBe(26);
  });
});
