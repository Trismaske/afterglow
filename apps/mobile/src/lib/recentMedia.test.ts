import { describe, expect, it } from 'vitest';
import { tallyPhotoDays } from './recentMedia';

describe('tallyPhotoDays', () => {
  it('counts timestamps by local calendar day', () => {
    const a = new Date(2026, 6, 18, 8).getTime();
    const b = new Date(2026, 6, 18, 22).getTime();
    const c = new Date(2026, 6, 17, 23).getTime();
    expect([...tallyPhotoDays([a, b, c])]).toEqual([
      ['2026-07-18', 2],
      ['2026-07-17', 1],
    ]);
  });
});
