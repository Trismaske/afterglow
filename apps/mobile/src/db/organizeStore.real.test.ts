/**
 * Organize queue contracts on real SQLite (gate 3: R#6, N#8, C#7):
 * validated primary-only targets, durable retryable intents,
 * already-at-target repair, post-move uri refresh, repeatability.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  commitOrganizeOutcomes,
  getOrganizeQueue,
  newAlbumPath,
  queueOrganize,
  unqueueOrganize,
  validateOrganizeTarget,
} from './organizeStore';
import { openTestDb, type TestDb } from './testDb';

const open: TestDb[] = [];
const AT = 1_800_000_000_000;

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

function insertPhoto(d: TestDb, id: string, volume: string | null = 'external_primary'): void {
  d.raw
    .prepare(
      `INSERT INTO photos (asset_id, uri, taken_at, day, volume_name)
       VALUES (?, 'file:///dcim/x.jpg', ?, '2026-07-20', ?)`,
    )
    .run(id, AT, volume);
}

describe('target validation', () => {
  it('accepts primary-volume DCIM/Pictures paths and rejects the rest', () => {
    expect(
      validateOrganizeTarget({ volumeName: 'external_primary', relativePath: 'Pictures/Trips/' }),
    ).toBeNull();
    expect(
      validateOrganizeTarget({ volumeName: 'external_primary', relativePath: 'DCIM/Camera/' }),
    ).toBeNull();
    expect(validateOrganizeTarget({ volumeName: 'sd-1234', relativePath: 'Pictures/X/' })).toMatch(
      /primary storage/,
    );
    expect(
      validateOrganizeTarget({ volumeName: 'external_primary', relativePath: 'Download/X/' }),
    ).toMatch(/DCIM/);
    expect(
      validateOrganizeTarget({ volumeName: 'external_primary', relativePath: 'Pictures/../X/' }),
    ).toMatch(/not valid/);
  });

  it('newAlbumPath builds validated Pictures paths and rejects bad names', () => {
    expect(newAlbumPath('Japan 2026')).toBe('Pictures/Japan 2026/');
    expect(newAlbumPath('  ')).toBeNull();
    expect(newAlbumPath('a/b')).toBeNull();
  });
});

describe('queue lifecycle', () => {
  it('queues present primary photos, rejects SD sources, supports unqueue', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    insertPhoto(d, 'sd1', 'sd-1234');
    const target = { volumeName: 'external_primary', relativePath: 'Pictures/Trips/' };
    expect(await queueOrganize(asExpo(d), 'p1', target, AT)).toBeNull();
    expect(await queueOrganize(asExpo(d), 'sd1', target, AT)).toMatch(/removable storage/);
    let queue = await getOrganizeQueue(asExpo(d));
    expect(queue.map((r) => r.photo_id)).toEqual(['p1']);
    expect(queue[0].organize_path).toBe('Pictures/Trips/');
    await unqueueOrganize(asExpo(d), 'p1', AT + 1);
    queue = await getOrganizeQueue(asExpo(d));
    expect(queue).toEqual([]);
  });

  it('change-target is just re-queueing with a new path', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    await queueOrganize(
      asExpo(d),
      'p1',
      { volumeName: 'external_primary', relativePath: 'Pictures/A/' },
      AT,
    );
    await queueOrganize(
      asExpo(d),
      'p1',
      { volumeName: 'external_primary', relativePath: 'Pictures/B/' },
      AT + 1,
    );
    const queue = await getOrganizeQueue(asExpo(d));
    expect(queue[0].organize_path).toBe('Pictures/B/');
  });
});

describe('commitOrganizeOutcomes', () => {
  it('moved → applied with uri refresh and last-applied bookkeeping (N#8)', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    await queueOrganize(
      asExpo(d),
      'p1',
      { volumeName: 'external_primary', relativePath: 'Pictures/Trips/' },
      AT,
    );
    await commitOrganizeOutcomes(
      asExpo(d),
      [
        {
          photoId: 'p1',
          status: 'moved',
          message: 'verified',
          newData: '/storage/emulated/0/Pictures/Trips/x.jpg',
        },
      ],
      AT + 5,
    );
    const row = d.raw
      .prepare(
        `SELECT organize_state, organize_applied_path, organize_path, uri, activity_at
         FROM photos WHERE asset_id = 'p1'`,
      )
      .get() as Record<string, unknown>;
    expect(row.organize_state).toBe('applied');
    expect(row.organize_applied_path).toBe('Pictures/Trips/');
    expect(row.organize_path).toBeNull();
    expect(row.uri).toBe('file:///storage/emulated/0/Pictures/Trips/x.jpg');
    expect(row.activity_at).toBe(AT + 5);
    // Repeatable (N#8): a new queue starts a fresh intent.
    expect(
      await queueOrganize(
        asExpo(d),
        'p1',
        { volumeName: 'external_primary', relativePath: 'Pictures/Other/' },
        AT + 10,
      ),
    ).toBeNull();
    const queue = await getOrganizeQueue(asExpo(d));
    expect(queue[0].organize_path).toBe('Pictures/Other/');
  });

  it("'already' completes the repair without a move (retry recognition)", async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    await queueOrganize(
      asExpo(d),
      'p1',
      { volumeName: 'external_primary', relativePath: 'Pictures/Trips/' },
      AT,
    );
    await commitOrganizeOutcomes(
      asExpo(d),
      [{ photoId: 'p1', status: 'already', message: 'already at target' }],
      AT + 5,
    );
    const row = d.raw
      .prepare("SELECT organize_state, uri FROM photos WHERE asset_id = 'p1'")
      .get() as Record<string, unknown>;
    expect(row.organize_state).toBe('applied');
    expect(row.uri).toBe('file:///dcim/x.jpg'); // no newData → uri untouched
  });

  it('error keeps the durable target for retry', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    await queueOrganize(
      asExpo(d),
      'p1',
      { volumeName: 'external_primary', relativePath: 'Pictures/Trips/' },
      AT,
    );
    await commitOrganizeOutcomes(
      asExpo(d),
      [{ photoId: 'p1', status: 'error', message: 'boom' }],
      AT + 5,
    );
    const queue = await getOrganizeQueue(asExpo(d));
    expect(queue).toHaveLength(1); // error rows stay in the queue view
    expect(queue[0].organize_path).toBe('Pictures/Trips/'); // target survived
  });
});
