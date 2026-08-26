import { describe, expect, it } from 'vitest';
import { parseCompareAfterCull, parseCompareAfterKeep, serializeComparePref } from './comparePrefs';

describe('compare prompt preferences (per-direction, m0.8.8 D8)', () => {
  it('round-trips every after-keep state', () => {
    for (const pref of ['ask', 'cull', 'leave'] as const) {
      expect(parseCompareAfterKeep(serializeComparePref(pref))).toBe(pref);
    }
  });

  it('round-trips every after-cull state', () => {
    for (const pref of ['ask', 'keep', 'leave'] as const) {
      expect(parseCompareAfterCull(serializeComparePref(pref))).toBe(pref);
    }
  });

  it('treats absence, garbage, and the retired tri-state encoding as ask', () => {
    for (const parse of [parseCompareAfterKeep, parseCompareAfterCull]) {
      expect(parse(null)).toBe('ask');
      expect(parse('what')).toBe('ask');
      expect(parse('1')).toBe('ask'); // the retired m0.8.2 auto-cull encoding
      expect(parse('keep_both')).toBe('ask');
    }
    // The directions do not accept each other's verdicts.
    expect(parseCompareAfterKeep('keep')).toBe('ask');
    expect(parseCompareAfterCull('cull')).toBe('ask');
  });
});
