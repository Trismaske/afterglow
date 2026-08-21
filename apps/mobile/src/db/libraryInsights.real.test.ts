/**
 * Library-insight aggregates on real SQLite (m0.8.2): the capture
 * histogram grouped on the indexed `day` key, the backlog frontier, the
 * storage breakdown, and the burst stats — whose keep rate counts only
 * FULLY decided groups.
 *
 * Seeded from the shared 90-day fixture; expectations are derived from
 * the same dataset in JS, independently of the SQL.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  getPhotoTimestamps,
  getBacklogFrontier,
  getBurstStats,
  getCaptureHistogram,
  getLifetimeStats,
  getStorageBreakdown,
} from './store';
import { openTestDb, type TestDb } from './testDb';
import {
  buildReviewHistory,
  seedReviewHistory,
  type FixtureAction,
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

function seed(
  d: TestDb,
  photos: readonly FixturePhoto[],
  undatedIds: readonly string[] = [],
): void {
  seedReviewHistory(d.raw, photos, { undatedIds, shareBatches: false });
}

/** Put photos into groups without going through the scan's write path. */
function seedGroups(d: TestDb, groups: readonly (readonly string[])[]): void {
  d.raw
    .prepare("INSERT INTO grouping_runs (id, provenance, created_at) VALUES (1, 'continuous', 0)")
    .run();
  const group = d.raw.prepare('INSERT INTO photo_groups (id, run_id) VALUES (?, 1)');
  const assign = d.raw.prepare(
    'INSERT INTO photo_group_assignments (photo_id, run_id, group_id) VALUES (?, 1, ?)',
  );
  d.raw.exec('BEGIN');
  groups.forEach((members, i) => {
    group.run(i + 1);
    for (const id of members) assign.run(id, i + 1);
  });
  d.raw.exec('COMMIT');
}

/** Reviewed = carries a verdict (docs/STATE_MODEL.md layer 1). */
const REVIEWED = new Set(['kept', 'culled', 'trashed']);

describe('getCaptureHistogram', () => {
  it('buckets by capture month with each month reviewed share', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seed(d, history.photos);

    const rows = await getCaptureHistogram(asExpo(d), null);

    // Independent derivation over the same dataset (present rows only).
    const expected = new Map<string, { total: number; reviewed: number }>();
    for (const photo of history.photos) {
      if (photo.state === 'trashed') continue;
      const key = photo.day.slice(0, 7);
      const bucket = expected.get(key) ?? { total: 0, reviewed: 0 };
      bucket.total += 1;
      if (REVIEWED.has(photo.state)) bucket.reviewed += 1;
      expected.set(key, bucket);
    }
    expect(rows).toHaveLength(expected.size);
    for (const row of rows) {
      const want = expected.get(row.month as string);
      expect(want).toBeDefined();
      expect(row.total).toBe(want?.total);
      expect(row.reviewed).toBe(want?.reviewed);
    }
  });

  it('gives undated photos their own null-month bucket', async () => {
    const history = buildReviewHistory();
    const undatedIds = history.photos.slice(0, 7).map((photo) => photo.assetId);
    const d = await fresh();
    seed(d, history.photos, undatedIds);
    const rows = await getCaptureHistogram(asExpo(d), null);
    const undated = rows.find((row) => row.month === null);
    // Some of the seven may be trashed, which leaves MediaStore.
    const present = history.photos.slice(0, 7).filter((photo) => photo.state !== 'trashed').length;
    expect(undated?.total).toBe(present);
  });

  it('is ordered oldest month first', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seed(d, history.photos);
    const months = (await getCaptureHistogram(asExpo(d), null)).map((row) => row.month);
    expect(months).toEqual([...months].sort());
  });
});

describe('getBacklogFrontier', () => {
  it('reports how far back verdicts reach and where the backlog starts', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seed(d, history.photos);

    const frontier = await getBacklogFrontier(asExpo(d), null);
    const present = history.photos.filter((photo) => photo.state !== 'trashed');
    const reviewedDays = present.filter((photo) => REVIEWED.has(photo.state)).map((p) => p.day);
    const pendingDays = present.filter((photo) => photo.state === 'unreviewed').map((p) => p.day);
    expect(frontier.reviewedBackTo).toBe(reviewedDays.sort()[0]);
    expect(frontier.oldestUnreviewedDay).toBe(pendingDays.sort()[0]);
  });

  it('holds its four-group parameter order under BOTH scopes (src + reach twice + src)', async () => {
    // Class-2 pin (REVIEW_CLASSES): the query interpolates the source
    // clause twice and the reach clause twice — a drifted spread order
    // binds days into volume slots silently.
    const history = buildReviewHistory();
    const d = await fresh();
    seed(d, history.photos);
    const roots = [{ volume: 'external_primary', dir: 'DCIM' }];
    const scoped = await getBacklogFrontier(asExpo(d), roots, ['external_primary']);
    // The fixture's uris all live under DCIM on the primary volume, so a
    // correctly-bound scoped read equals the unscoped one.
    const unscoped = await getBacklogFrontier(asExpo(d), null, null);
    expect(scoped).toEqual(unscoped);
  });

  it('counts undated photos still waiting', async () => {
    const history = buildReviewHistory();
    const pending = history.photos.filter((photo) => photo.state === 'unreviewed').slice(0, 5);
    const d = await fresh();
    seed(
      d,
      pending,
      pending.map((photo) => photo.assetId),
    );
    const frontier = await getBacklogFrontier(asExpo(d), null);
    expect(frontier.undatedPending).toBe(5);
    expect(frontier.oldestUnreviewedDay).toBeNull();
  });

  it('is all-null on an empty library', async () => {
    const d = await fresh();
    expect(await getBacklogFrontier(asExpo(d), null)).toEqual({
      reviewedBackTo: null,
      oldestUnreviewedDay: null,
      undatedPending: 0,
    });
  });
});

describe('getStorageBreakdown', () => {
  it('sums scan-recorded bytes per state', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seed(d, history.photos);

    const storage = await getStorageBreakdown(asExpo(d), null);
    const present = history.photos.filter((photo) => photo.state !== 'trashed');
    const sum = (predicate: (photo: FixturePhoto) => boolean) =>
      present.filter(predicate).reduce((total, photo) => total + photo.sizeBytes, 0);
    expect(storage.sized).toBe(present.length);
    expect(storage.unsized).toBe(0);
    expect(storage.bytes.kept).toBe(sum((p) => p.state === 'kept'));
    expect(storage.bytes.staged).toBe(sum((p) => p.state === 'culled'));
    expect(storage.bytes.unreviewed).toBe(sum((p) => p.state === 'unreviewed'));
  });

  it('counts rows the scan has not sized instead of treating them as zero', async () => {
    const history = buildReviewHistory();
    const photos = history.photos.slice(0, 6).map((photo, i) => ({
      ...photo,
      state: 'unreviewed' as const,
      sizeBytes: i < 2 ? photo.sizeBytes : (null as never),
    }));
    const d = await fresh();
    seed(d, photos);
    const storage = await getStorageBreakdown(asExpo(d), null);
    expect(storage.sized).toBe(2);
    expect(storage.unsized).toBe(4);
    expect(storage.bytes.unreviewed).toBe(photos[0].sizeBytes + photos[1].sizeBytes);
  });
});

describe('getLifetimeStats', () => {
  it('counts unique photos per lifetime event and verified reclaimed bytes', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seed(d, history.photos);
    // One verified trash member — reclaimed bytes come from the trash
    // lifecycle's measurements, never from photos.size_bytes.
    const trashed = history.photos.find((photo) => photo.state === 'trashed')!;
    d.raw.prepare("INSERT INTO trash_batches (state, created_at) VALUES ('verified', 1)").run();
    d.raw
      .prepare("INSERT INTO trash_batch_members VALUES (1, ?, 0, 4096, 'trashed')")
      .run(trashed.assetId);

    const stats = await getLifetimeStats(asExpo(d));
    const decided = history.photos.filter((photo) => photo.decidedAt !== null);
    const resolved = (kind: FixtureAction['kind']) =>
      history.photos.filter((photo) =>
        photo.actions.some((action) => action.kind === kind && action.resolvedAt !== null),
      ).length;
    expect(stats.reviewed).toBe(decided.length);
    expect(stats.culled).toBe(
      decided.filter((photo) => photo.state === 'culled' || photo.state === 'trashed').length,
    );
    // "Ever completed", which is why it survives the queue being emptied.
    expect(stats.editsCompleted).toBe(resolved('edit'));
    // The favourites figure is retired (m0.8.7, gap 2) — a library fact
    // under an all-time heading; the event log revives the true count.
    expect(stats.reclaimedBytes).toBe(4096);
  });

  it('normalizes an empty database to zeroes', async () => {
    const d = await fresh();
    expect(await getLifetimeStats(asExpo(d))).toEqual({
      reviewed: 0,
      culled: 0,
      editsCompleted: 0,
      reclaimedBytes: 0,
    });
  });
});

describe('getBurstStats', () => {
  it('counts grouped photos and their groups', async () => {
    const history = buildReviewHistory();
    const photos = history.photos.filter((p) => p.state !== 'trashed').slice(0, 12);
    const d = await fresh();
    seed(d, photos);
    seedGroups(d, [
      photos.slice(0, 4).map((p) => p.assetId),
      photos.slice(4, 7).map((p) => p.assetId),
    ]);
    const stats = await getBurstStats(asExpo(d), null);
    expect(stats.photosInGroups).toBe(7);
    expect(stats.groups).toBe(2);
  });

  it('is empty when nothing is grouped', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seed(d, history.photos.slice(0, 5));
    expect(await getBurstStats(asExpo(d), null)).toEqual({
      photosInGroups: 0,
      groups: 0,
    });
  });
});

describe('getPhotoTimestamps (delta-scan planning)', () => {
  /** Photos at fixed minute offsets, so ranges and walks are exact. */
  function seedAt(d: TestDb, offsetsMin: readonly number[]): number {
    const base = 1_800_000_000_000;
    const insert = d.raw.prepare(
      "INSERT INTO photos (asset_id, uri, taken_at, state, is_present, volume_name, raw_id) VALUES (?, ?, ?, 'unreviewed', 1, 'external_primary', ?)",
    );
    offsetsMin.forEach((min, i) => {
      insert.run(`p${i}`, `file:///DCIM/Camera/p${i}.jpg`, base + min * 60_000, `p${i}`);
    });
    return base;
  }

  it('returns every tracked timestamp ASCENDING, whatever the insert order', async () => {
    const d = await fresh();
    const base = seedAt(d, [30, 0, 20, 10]);
    expect(await getPhotoTimestamps(asExpo(d))).toEqual([
      base,
      base + 10 * 60_000,
      base + 20 * 60_000,
      base + 30 * 60_000,
    ]);
  });

  it('ignores photos MediaStore no longer has', async () => {
    const d = await fresh();
    const base = seedAt(d, [0, 10]);
    d.raw.prepare('UPDATE photos SET is_present = 0 WHERE asset_id = ?').run('p1');
    expect(await getPhotoTimestamps(asExpo(d))).toEqual([base]);
  });

  it('honors the source scope, like every other corpus read', async () => {
    const d = await fresh();
    const base = seedAt(d, [0, 10]);
    d.raw
      .prepare("UPDATE photos SET uri = 'file:///Pictures/WhatsApp/p1.jpg' WHERE asset_id = ?")
      .run('p1');
    expect(
      await getPhotoTimestamps(asExpo(d), [{ volume: 'external_primary', dir: 'DCIM/Camera' }]),
    ).toEqual([base]);
    expect(await getPhotoTimestamps(asExpo(d), null)).toHaveLength(2);
  });

  it('is empty, not null, on an empty library', async () => {
    const d = await fresh();
    expect(await getPhotoTimestamps(asExpo(d))).toEqual([]);
  });
});
