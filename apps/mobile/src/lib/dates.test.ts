import { describe, expect, it } from 'vitest';
import { dayKey } from './dates';

describe('dayKey', () => {
  it('is lexicographically sortable (zero-padded)', () => {
    const jan5 = dayKey(new Date(2026, 0, 5).getTime());
    expect(jan5).toBe('2026-01-05');
  });
});
