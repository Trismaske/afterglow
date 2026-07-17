import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_ORDER,
  DEFAULT_SESSION_CAP,
  MAX_SESSION_CAP,
  MIN_SESSION_CAP,
  parseReviewOrder,
  parseSessionCap,
  parseWholeGroups,
  serializeReviewOrder,
  serializeSessionCap,
  serializeWholeGroups,
  SESSION_CAP_CHOICES,
} from './sessionPrefs';

describe('parseSessionCap', () => {
  it('round-trips every offered choice', () => {
    for (const cap of SESSION_CAP_CHOICES) {
      expect(parseSessionCap(serializeSessionCap(cap))).toBe(cap);
    }
  });

  it('accepts any integer within the bounds', () => {
    expect(parseSessionCap('10')).toBe(MIN_SESSION_CAP);
    expect(parseSessionCap('500')).toBe(MAX_SESSION_CAP);
    expect(parseSessionCap('73')).toBe(73);
  });

  it('falls back to the default (50) for absent or invalid values', () => {
    expect(DEFAULT_SESSION_CAP).toBe(50);
    expect(parseSessionCap(null)).toBe(DEFAULT_SESSION_CAP);
    expect(parseSessionCap('')).toBe(DEFAULT_SESSION_CAP);
    expect(parseSessionCap('9')).toBe(DEFAULT_SESSION_CAP); // below min
    expect(parseSessionCap('501')).toBe(DEFAULT_SESSION_CAP); // above max
    expect(parseSessionCap('50.5')).toBe(DEFAULT_SESSION_CAP);
    expect(parseSessionCap('lots')).toBe(DEFAULT_SESSION_CAP);
  });
});

describe('parseWholeGroups', () => {
  it('defaults ON (unset / garbage)', () => {
    expect(parseWholeGroups(null)).toBe(true);
    expect(parseWholeGroups('')).toBe(true);
    expect(parseWholeGroups('yes')).toBe(true);
  });

  it("only '0' turns it off, and it round-trips", () => {
    expect(parseWholeGroups('0')).toBe(false);
    expect(parseWholeGroups(serializeWholeGroups(false))).toBe(false);
    expect(parseWholeGroups(serializeWholeGroups(true))).toBe(true);
  });
});

describe('parseReviewOrder', () => {
  it('defaults to oldest-first', () => {
    expect(DEFAULT_REVIEW_ORDER).toBe('oldest');
    expect(parseReviewOrder(null)).toBe('oldest');
    expect(parseReviewOrder('')).toBe('oldest');
    expect(parseReviewOrder('sideways')).toBe('oldest');
  });

  it('round-trips both orders', () => {
    expect(parseReviewOrder(serializeReviewOrder('newest'))).toBe('newest');
    expect(parseReviewOrder(serializeReviewOrder('oldest'))).toBe('oldest');
  });
});
