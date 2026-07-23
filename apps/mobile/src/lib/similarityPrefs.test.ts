import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  exactStep,
  MAX_SIMILARITY_THRESHOLD,
  nearestStep,
  parseSimilarityThreshold,
  serializeSimilarityThreshold,
  SIMILARITY_STEPS,
  thresholdLabel,
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

  it('uses the m0.5 rescaled values (old Normal is the new Strictest)', () => {
    expect(SIMILARITY_STEPS.map((s) => s.value)).toEqual([12, 16, 20, 26, 32]);
  });

  it('defaults to the new Normal (20) as a selectable step', () => {
    expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(20);
    expect(SIMILARITY_STEPS.some((s) => s.value === DEFAULT_SIMILARITY_THRESHOLD)).toBe(true);
  });
});

describe('parseSimilarityThreshold', () => {
  it('round-trips every step through serialize/parse', () => {
    for (const step of SIMILARITY_STEPS) {
      expect(parseSimilarityThreshold(serializeSimilarityThreshold(step.value))).toBe(step.value);
    }
  });

  it('accepts integers 0..63; the retired 64 sentinel re-maps to 63 (R#8)', () => {
    expect(parseSimilarityThreshold('0')).toBe(0);
    expect(parseSimilarityThreshold('63')).toBe(63);
    expect(parseSimilarityThreshold('64')).toBe(63); // standing re-map policy
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
    expect(nearestStep(0).value).toBe(12);
    expect(nearestStep(13).value).toBe(12);
    expect(nearestStep(14).value).toBe(12); // tie 12 vs 16 → stricter
    expect(nearestStep(18).value).toBe(16); // tie 16 vs 20 → stricter
    expect(nearestStep(23).value).toBe(20); // tie 20 vs 26 → stricter
    expect(nearestStep(64).value).toBe(32);
  });

  it('re-maps m0.4-era stored values onto the new scale sensibly', () => {
    expect(nearestStep(4).value).toBe(12); // old Strictest
    expect(nearestStep(8).value).toBe(12); // old Strict
    expect(nearestStep(12).value).toBe(12); // old Normal → new Strictest
    expect(nearestStep(18).value).toBe(16); // old Loose
    expect(nearestStep(26).value).toBe(26); // old Loosest
  });
});

describe('exactStep / thresholdLabel', () => {
  it('finds a step only on exact values', () => {
    expect(exactStep(20)?.label).toBe('Normal');
    expect(exactStep(21)).toBeNull();
    expect(exactStep(0)).toBeNull();
  });

  it('labels off-preset values as Custom (N)', () => {
    expect(thresholdLabel(20)).toBe('Normal');
    expect(thresholdLabel(12)).toBe('Strictest');
    expect(thresholdLabel(21)).toBe('Custom (21)');
    expect(thresholdLabel(0)).toBe('Custom (0)');
  });
});
