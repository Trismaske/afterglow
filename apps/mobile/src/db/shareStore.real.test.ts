/**
 * Share-queue contract tests on real SQLite (gate 3: R#7, N#5, C#10, C#7):
 * cycle identity, pass-count badges from sheet_opened only, at-most-once
 * crash recovery, clear-keeps-events, and presence gating.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  addToShareQueue,
  clearShareQueue,
  countNeverShared,
  createShareBatch,
  failShareBatch,
  getShareQueue,
  labelShareBatch,
  promoteShareBatch,
  recentShareLabels,
  recoverShareBatches,
  removeFromShareQueue,
} from './shareStore';
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

function insertPhoto(d: TestDb, id: string, present = 1): void {
  d.raw
    .prepare(
      `INSERT INTO photos (asset_id, uri, taken_at, day, is_present)
       VALUES (?, 'content://x', ?, '2026-07-20', ?)`,
    )
    .run(id, AT, present);
}

describe('share queue + cycles', () => {
  it('dedups by photo, gates on presence, and mints one open cycle', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    insertPhoto(d, 'p2');
    insertPhoto(d, 'gone', 0);
    expect(await addToShareQueue(asExpo(d), 'p1', AT)).toBe(true);
    expect(await addToShareQueue(asExpo(d), 'p1', AT + 1)).toBe(false); // dedup
    expect(await addToShareQueue(asExpo(d), 'gone', AT + 2)).toBe(false); // absent
    expect(await addToShareQueue(asExpo(d), 'p2', AT + 3)).toBe(true);
    const cycles = d.raw.prepare('SELECT COUNT(*) AS n FROM share_cycles').get() as { n: number };
    expect(cycles.n).toBe(1);
    const queue = await getShareQueue(asExpo(d));
    expect(queue.map((r) => r.photo_id)).toEqual(['p1', 'p2']);
    expect(queue.every((r) => r.pass_count === 0)).toBe(true);
  });

  it('pass counts include only same-cycle sheet_opened batches (C#10)', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    insertPhoto(d, 'p2');
    await addToShareQueue(asExpo(d), 'p1', AT);
    await addToShareQueue(asExpo(d), 'p2', AT);
    // Pass 1: p1 only — dispatch confirmed.
    const b1 = await createShareBatch(asExpo(d), ['p1'], AT + 10);
    await promoteShareBatch(asExpo(d), b1, AT + 11);
    // Pass 2: both — dispatch FAILED (never badges).
    const b2 = await createShareBatch(asExpo(d), ['p1', 'p2'], AT + 20);
    await failShareBatch(asExpo(d), b2);
    const queue = await getShareQueue(asExpo(d));
    expect(queue.find((r) => r.photo_id === 'p1')?.pass_count).toBe(1);
    expect(queue.find((r) => r.photo_id === 'p2')?.pass_count).toBe(0);
    expect(await countNeverShared(asExpo(d))).toBe(1);
  });

  it('clear ends the cycle, keeps events, and a requeue starts a new cycle', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    await addToShareQueue(asExpo(d), 'p1', AT);
    const b1 = await createShareBatch(asExpo(d), ['p1'], AT + 10);
    await promoteShareBatch(asExpo(d), b1, AT + 11);
    await labelShareBatch(asExpo(d), b1, 'Mum');
    const result = await clearShareQueue(asExpo(d), AT + 20);
    expect(result).toEqual({ cleared: 1, neverShared: 0 });
    // Events survive the clear (R#7).
    const batches = d.raw.prepare('SELECT COUNT(*) AS n FROM share_batches').get() as { n: number };
    expect(batches.n).toBe(1);
    expect(await recentShareLabels(asExpo(d))).toEqual(['Mum']);
    // Requeue: a NEW cycle, so the old pass no longer badges.
    await addToShareQueue(asExpo(d), 'p1', AT + 30);
    const queue = await getShareQueue(asExpo(d));
    expect(queue[0].pass_count).toBe(0);
    const cycles = d.raw.prepare('SELECT COUNT(*) AS n FROM share_cycles').get() as { n: number };
    expect(cycles.n).toBe(2);
  });

  it('startup recovery reconciles crash-window launching rows to error (C#10)', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    await addToShareQueue(asExpo(d), 'p1', AT);
    await createShareBatch(asExpo(d), ['p1'], AT + 10);
    // Death before promotion. Recovery: error, no badge, sharable again.
    const recovered = await recoverShareBatches(asExpo(d));
    expect(recovered).toBe(1);
    const queue = await getShareQueue(asExpo(d));
    expect(queue[0].pass_count).toBe(0);
    const state = d.raw.prepare('SELECT state FROM share_batches').get() as { state: string };
    expect(state.state).toBe('error');
  });

  it('remove-one keeps the rest of the queue', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    insertPhoto(d, 'p2');
    await addToShareQueue(asExpo(d), 'p1', AT);
    await addToShareQueue(asExpo(d), 'p2', AT);
    await removeFromShareQueue(asExpo(d), 'p1');
    const queue = await getShareQueue(asExpo(d));
    expect(queue.map((r) => r.photo_id)).toEqual(['p2']);
  });
});
