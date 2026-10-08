import { describe, expect, it } from 'vitest';
import {
  effectiveTextScale,
  HUGE_TEXT_SCALE,
  isHugeText,
  isLargeText,
  LARGE_TEXT_SCALE,
} from './textScale';

describe('isLargeText (the stack-instead-of-row threshold, relative to the width)', () => {
  it('stacks from 1.3 on a 360 dp phone and keeps rows below it', () => {
    expect(LARGE_TEXT_SCALE).toBe(1.3);
    expect(isLargeText(1.15, 360)).toBe(false);
    expect(isLargeText(1.3, 360)).toBe(true);
    expect(isLargeText(2, 360)).toBe(true);
    expect(isLargeText(0.85, 360)).toBe(false);
  });
  it('lets a wider phone hold more before stacking (the S23 at 411 dp)', () => {
    expect(effectiveTextScale(1.5, 411)).toBeCloseTo(1.314, 3);
    expect(isLargeText(1.3, 411)).toBe(false);
    expect(isLargeText(1.5, 411)).toBe(true);
  });
  it('drops labels only past the huge threshold', () => {
    expect(HUGE_TEXT_SCALE).toBe(1.6);
    expect(isHugeText(1.5, 360)).toBe(false);
    expect(isHugeText(1.8, 360)).toBe(true);
    expect(isHugeText(1.8, 411)).toBe(false);
    expect(isHugeText(2, 411)).toBe(true);
  });
  it('reads a Java-float 1.3 as the 1.3 step (the S10e miss)', () => {
    expect(isLargeText(1.2999999523162842, 360)).toBe(true);
    expect(effectiveTextScale(1.2999999523162842, 360)).toBe(1.3);
  });
  it('treats an unreadable scale or width as normal text', () => {
    expect(isLargeText(Number.NaN, 360)).toBe(false);
    expect(isLargeText(2, 0)).toBe(false);
  });
});
