import { describe, expect, it, vi } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getLifetimeStats } from './store';

describe('getLifetimeStats', () => {
  it('returns unique-photo event totals plus verified-trash reclaimed bytes', async () => {
    const getFirstAsync = vi
      .fn()
      .mockResolvedValueOnce({ reviewed: 31, culled: 8, editsCompleted: 5, favouritesApplied: 7 })
      .mockResolvedValueOnce({ total: 12_345 });
    const db = { getFirstAsync } as unknown as SQLiteDatabase;

    await expect(getLifetimeStats(db)).resolves.toEqual({
      reviewed: 31,
      culled: 8,
      editsCompleted: 5,
      favouritesApplied: 7,
      reclaimedBytes: 12_345,
    });
    expect(String(getFirstAsync.mock.calls[0]?.[0])).toContain('reviewed_at IS NOT NULL');
    expect(String(getFirstAsync.mock.calls[0]?.[0])).toContain('favourite_applied_at IS NOT NULL');
    // Reclaimed bytes come from the verified member rows, not sessions.
    expect(String(getFirstAsync.mock.calls[1]?.[0])).toContain('trash_batch_members');
  });

  it('normalizes an empty database to zeroes', async () => {
    const db = {
      getFirstAsync: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ total: null }),
    } as unknown as SQLiteDatabase;

    await expect(getLifetimeStats(db)).resolves.toEqual({
      reviewed: 0,
      culled: 0,
      editsCompleted: 0,
      favouritesApplied: 0,
      reclaimedBytes: 0,
    });
  });
});
