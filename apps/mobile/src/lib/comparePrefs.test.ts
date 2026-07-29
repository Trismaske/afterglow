import { describe, expect, it } from 'vitest';
import { parseCompareDuelPref, serializeCompareDuelPref } from './comparePrefs';

describe('compare duel preference (tri-state, m0.8.2)', () => {
  it('round-trips all three states', () => {
    for (const pref of ['ask', 'cull', 'keep_both'] as const) {
      expect(parseCompareDuelPref(serializeCompareDuelPref(pref))).toBe(pref);
    }
  });

  it('maps the legacy boolean encoding and garbage to safe values', () => {
    expect(parseCompareDuelPref('1')).toBe('cull'); // legacy auto-cull
    expect(parseCompareDuelPref('0')).toBe('ask'); // legacy off
    expect(parseCompareDuelPref(null)).toBe('ask');
    expect(parseCompareDuelPref('what')).toBe('ask');
  });
});
