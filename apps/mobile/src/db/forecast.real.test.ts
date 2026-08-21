/**
 * Forecast aggregates on real SQLite (m0.8.2): all-time base rates
 * sliced by NTILE, the bounded decision-stamp read, the remaining-pool
 * mean size, and the share proxy — including the case that motivated the
 * proxy's definition (a photo queued and then cleared without ever being
 * sent is NOT shared).
 *
 * Seeded from the SHARED 90-day fixture, so these queries and the pure
 * forecast tests provably describe the same photos. Expectations are
 * derived in JS from the same dataset — an independent implementation of
 * the same spec, not a copy of the SQL's output.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import { getForecastBaseRates, getRecentDecisionStamps, getRemainingPoolSize } from './store';
import { openTestDb, type TestDb } from './testDb';
import {
  buildReviewHistory,
  outcomeChunks,
  seedReviewHistory,
  type FixturePhoto,
} from '../__fixtures__/reviewHistory';

const open: TestDb[] = [];

function asExpo(d: TestDb): SQLiteDatabase {
  return d as unknown as SQLiteDatabase;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

async function fresh(): Promise<TestDb> {
  const d = openTestDb();
  open.push(d);
  d.raw.exec('PRAGMA foreign_keys = ON');
  await migrateDatabase(asExpo(d));
  return d;
}

/** Photos + their actions, from the fixture's own seeder. */
function seed(d: TestDb, photos: readonly FixturePhoto[]): void {
  seedReviewHistory(d.raw, photos, { shareBatches: false });
}

/** Photos + the share batch that makes the share proxy true. */
function seedWithShares(d: TestDb, photos: readonly FixturePhoto[], at: number): void {
  seedReviewHistory(d.raw, photos, { at });
}

describe('getForecastBaseRates', () => {
  it('slices the whole decision history and counts every outcome', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seedWithShares(d, history.photos, history.todayMs);

    const rates = await getForecastBaseRates(asExpo(d), null, null, 5);
    const expected = outcomeChunks(history, 5);

    expect(rates.decisions).toBe(history.decisionStamps.length);
    expect(rates.firstDecidedAt).toBe(history.decisionStamps[history.decisionStamps.length - 1]);
    expect(rates.chunks).toHaveLength(5);
    expect(rates.chunks.map((chunk) => chunk.total)).toEqual(expected.map((chunk) => chunk.total));
    expect(rates.chunks.map((chunk) => chunk.culled)).toEqual(
      expected.map((chunk) => chunk.culled),
    );
    expect(rates.chunks.map((chunk) => chunk.toEdit)).toEqual(
      expected.map((chunk) => chunk.toEdit),
    );
    expect(rates.chunks.map((chunk) => chunk.favourited)).toEqual(
      expected.map((chunk) => chunk.favourited),
    );
    expect(rates.chunks.map((chunk) => chunk.shared)).toEqual(
      expected.map((chunk) => chunk.shared),
    );
    expect(rates.chunks.map((chunk) => chunk.organized)).toEqual(
      expected.map((chunk) => chunk.organized),
    );
  });

  it('shows the drift the fixture simulates, chunk over chunk', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seed(d, history.photos);
    const rates = await getForecastBaseRates(asExpo(d), null, null, 5);
    const first = rates.chunks[0];
    const last = rates.chunks[rates.chunks.length - 1];
    // Cull rate climbs 0.20 -> 0.36 across the simulated history, which is
    // exactly the spread the projected range is meant to expose.
    expect(last.culled / last.total).toBeGreaterThan(first.culled / first.total);
  });

  it('counts nothing when nothing is decided', async () => {
    const d = await fresh();
    const history = buildReviewHistory();
    seed(
      d,
      history.photos
        .slice(0, 20)
        .map((photo) => ({ ...photo, decidedAt: null, state: 'unreviewed' as const })),
    );
    const rates = await getForecastBaseRates(asExpo(d), null, null, 5);
    expect(rates.decisions).toBe(0);
    expect(rates.firstDecidedAt).toBeNull();
    expect(rates.chunks).toEqual([]);
  });

  it('honours the source scope', async () => {
    const history = buildReviewHistory();
    const decided = history.photos.filter((photo) => photo.decidedAt !== null).slice(0, 40);
    const d = await fresh();
    // Half the photos live in a folder the user has not selected.
    seed(d, [
      ...decided.slice(0, 20),
      ...decided.slice(20).map((photo, i) => ({
        ...photo,
        assetId: `external_primary/excluded-${i}`,
        uri: `file:///storage/emulated/0/Pictures/Screenshots/S_${i}.jpg`,
      })),
    ]);
    const scoped = await getForecastBaseRates(
      asExpo(d),
      [{ volume: 'external_primary', dir: 'DCIM/Camera' }],
      null,
      5,
    );
    expect(scoped.decisions).toBe(20);
    const unscoped = await getForecastBaseRates(asExpo(d), null, null, 5);
    expect(unscoped.decisions).toBe(40);
  });
});

describe('the share proxy', () => {
  it('counts a photo that reached the share sheet', async () => {
    const history = buildReviewHistory();
    const decided = history.photos
      .filter((photo) => photo.decidedAt !== null && !photo.shared)
      .slice(0, 4);
    const d = await fresh();
    seedWithShares(d, [{ ...decided[0], shared: true }, ...decided.slice(1)], history.todayMs);
    const rates = await getForecastBaseRates(asExpo(d), null, null, 1);
    expect(rates.chunks[0].shared).toBe(1);
  });

  it('does NOT count a photo queued and cleared without being sent', async () => {
    const history = buildReviewHistory();
    const decided = history.photos
      .filter((photo) => photo.decidedAt !== null && !photo.shared)
      .slice(0, 4);
    const d = await fresh();
    // The photo DID sit in the share queue — that is the whole point: a
    // queue row is an intention, and intentions are not the proxy.
    seed(d, [
      {
        ...decided[0],
        actions: [
          {
            kind: 'share' as const,
            state: 'queued' as const,
            target: null,
            queuedAt: decided[0].decidedAt as number,
            resolvedAt: null,
          },
        ],
      },
      ...decided.slice(1),
    ]);
    // A batch that never opened the sheet is not a share (and clearing
    // the queue would have deleted the queue row entirely).
    d.raw.prepare('INSERT INTO share_cycles (id, started_at) VALUES (1, ?)').run(history.todayMs);
    d.raw
      .prepare(
        "INSERT INTO share_batches (id, cycle_id, attempted_at, state) VALUES (1, 1, ?, 'error')",
      )
      .run(history.todayMs);
    d.raw
      .prepare('INSERT INTO share_batch_members (batch_id, photo_id) VALUES (1, ?)')
      .run(decided[0].assetId);

    const rates = await getForecastBaseRates(asExpo(d), null, null, 1);
    expect(rates.chunks[0].shared).toBe(0);
  });
});

describe('getRecentDecisionStamps', () => {
  it('returns decided stamps newest first, bounded by the limit', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seed(d, history.photos);
    const stamps = await getRecentDecisionStamps(asExpo(d), 500);
    expect(stamps).toHaveLength(500);
    expect(stamps).toEqual(history.decisionStamps.slice(0, 500));
  });

  it('skips undecided photos entirely', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seed(
      d,
      history.photos.map((photo) => ({ ...photo, decidedAt: null, state: 'unreviewed' as const })),
    );
    expect(await getRecentDecisionStamps(asExpo(d), 500)).toEqual([]);
  });
});

describe('getRemainingPoolSize', () => {
  it('averages the sizes of photos still to review, not of past culls', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seed(d, history.photos);

    const pool = history.photos.filter((photo) => photo.decidedAt === null);
    const expectedMean = Math.round(
      pool.reduce((sum, photo) => sum + photo.sizeBytes, 0) / pool.length,
    );
    const result = await getRemainingPoolSize(asExpo(d), null);
    expect(result.sized).toBe(pool.length);
    expect(result.meanBytes).toBe(expectedMean);
  });

  it('reports how much of the pool is actually sized', async () => {
    const history = buildReviewHistory();
    const unreviewed = history.photos
      .filter((photo) => photo.decidedAt === null)
      .slice(0, 10)
      .map((photo, i) => ({ ...photo, sizeBytes: i < 4 ? photo.sizeBytes : (null as never) }));
    const d = await fresh();
    seed(d, unreviewed);
    const result = await getRemainingPoolSize(asExpo(d), null);
    // Six rows the scan has not sized yet contribute nothing to the mean.
    expect(result.sized).toBe(4);
    const sizedMean = Math.round(
      unreviewed.slice(0, 4).reduce((sum, photo) => sum + photo.sizeBytes, 0) / 4,
    );
    expect(result.meanBytes).toBe(sizedMean);
  });

  it('is empty when nothing is left to review', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seed(d, history.photos.filter((photo) => photo.decidedAt !== null).slice(0, 20));
    expect(await getRemainingPoolSize(asExpo(d), null)).toEqual({ sized: 0, meanBytes: 0 });
  });
});
