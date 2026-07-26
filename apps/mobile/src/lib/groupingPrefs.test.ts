/** Grouping-strictness setting (m0.8 gate 4): parse-with-fallback + band. */
import { describe, expect, it } from 'vitest';
import { parseStrictness, serializeStrictness, STRICTNESS_STEPS } from './groupingPrefs';

describe('grouping strictness', () => {
  it('round-trips every step and falls back to the calibrated default', () => {
    for (const step of STRICTNESS_STEPS) {
      expect(parseStrictness(serializeStrictness(step))).toBe(step);
    }
    expect(parseStrictness(null).baseThreshold).toBe(0.5);
    expect(parseStrictness('nonsense').baseThreshold).toBe(0.5);
  });

  it('stays inside the calibrated band, strictly increasing', () => {
    const thresholds = STRICTNESS_STEPS.map((s) => s.baseThreshold);
    expect(thresholds[0]).toBe(0.42);
    expect(thresholds[thresholds.length - 1]).toBe(0.58);
    for (let i = 1; i < thresholds.length; i++) {
      expect(thresholds[i]).toBeGreaterThan(thresholds[i - 1]);
    }
  });
});
