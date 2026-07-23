/**
 * Trash-attempt lifecycle proof on real SQLite (gate 3: P6#4, P7#4, P8#3,
 * P8#4, P5#4, C#7). Death windows are simulated by driving the lifecycle
 * functions exactly as the interrupted process would find the rows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  lifetimeReclaimedBytes,
  markBatchLaunching,
  markPhotoRestored,
  prepareTrashBatch,
  recoverTrashBatches,
  resolveTrashBatch,
  TRASH_BATCH_LIMIT,
} from './trashStore';
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

function insertCull(d: TestDb, id: string, extras: Partial<Record<string, unknown>> = {}): void {
  d.raw
    .prepare(
      `INSERT INTO photos (asset_id, uri, taken_at, day, state, favourite_state, organize_state, needs_edit)
       VALUES (?, 'content://x', ?, '2026-07-20', 'culled', ?, ?, ?)`,
    )
    .run(
      id,
      AT,
      (extras.favourite_state as string) ?? 'none',
      (extras.organize_state as string) ?? 'none',
      (extras.needs_edit as number) ?? 0,
    );
}

const absent = async () => 'absent' as const;
const present = async () => 'present' as const;
const unknown = async () => 'unknown' as const;

describe('prepareTrashBatch', () => {
  it('reserves staged culls up to the batch limit, skipping live reservations', async () => {
    const d = await fresh();
    for (let i = 0; i < TRASH_BATCH_LIMIT + 20; i++) insertCull(d, `p${i}`);
    const first = await prepareTrashBatch(
      asExpo(d),
      Array.from({ length: TRASH_BATCH_LIMIT + 20 }, (_, i) => ({
        photoId: `p${i}`,
        measuredBytes: 10,
      })),
      null,
      AT,
    );
    expect(first!.members).toHaveLength(TRASH_BATCH_LIMIT);
    // The overflow can start its own batch; reserved photos are skipped.
    const second = await prepareTrashBatch(
      asExpo(d),
      Array.from({ length: TRASH_BATCH_LIMIT + 20 }, (_, i) => ({
        photoId: `p${i}`,
        measuredBytes: 10,
      })),
      null,
      AT,
    );
    expect(second!.members).toHaveLength(20);
  });

  it('only stages culled photos and returns null when nothing is eligible', async () => {
    const d = await fresh();
    d.raw
      .prepare(
        "INSERT INTO photos (asset_id, uri, taken_at, day, state) VALUES ('kept1', 'c://', ?, 'd', 'done')",
      )
      .run(AT);
    const batch = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: 'kept1', measuredBytes: 5 }],
      null,
      AT,
    );
    expect(batch).toBeNull();
  });
});

describe('resolveTrashBatch', () => {
  it('applied + absent → trashed with credit and the C#7 cleanup', async () => {
    const d = await fresh();
    insertCull(d, 'p1', {
      favourite_state: 'queued_apply',
      organize_state: 'queued',
      needs_edit: 1,
    });
    d.raw.prepare('INSERT INTO share_cycles (started_at) VALUES (?)').run(AT);
    d.raw
      .prepare("INSERT INTO share_queue (photo_id, cycle_id, queued_at) VALUES ('p1', 1, ?)")
      .run(AT);
    const batch = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: 'p1', measuredBytes: 111 }],
      null,
      AT,
    );
    await markBatchLaunching(asExpo(d), batch!.batchId, AT + 1);
    const result = await resolveTrashBatch(asExpo(d), {
      batchId: batch!.batchId,
      verify: absent,
      dialog: 'applied',
      at: AT + 2,
    });
    expect(result.outcomes.p1).toBe('trashed');
    expect(result.creditedBytes).toBe(111);
    expect(result.batchState).toBe('verified');
    const row = d.raw
      .prepare(
        'SELECT state, is_present, needs_edit, favourite_state, organize_state FROM photos WHERE asset_id = ?',
      )
      .get('p1') as Record<string, unknown>;
    expect(row.state).toBe('trashed');
    expect(row.is_present).toBe(0);
    expect(row.needs_edit).toBe(0);
    expect(row.favourite_state).toBe('none');
    expect(row.organize_state).toBe('none');
    const share = d.raw.prepare('SELECT COUNT(*) AS n FROM share_queue').get() as { n: number };
    expect(share.n).toBe(0);
    const reservations = d.raw.prepare('SELECT COUNT(*) AS n FROM trash_reservations').get() as {
      n: number;
    };
    expect(reservations.n).toBe(0);
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(111);
  });

  it('cancelled dialog releases members back to the cull queue', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    const batch = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: 'p1', measuredBytes: 50 }],
      null,
      AT,
    );
    const result = await resolveTrashBatch(asExpo(d), {
      batchId: batch!.batchId,
      verify: absent,
      dialog: 'cancelled',
      at: AT + 2,
    });
    expect(result.outcomes.p1).toBe('still_present');
    expect(result.creditedBytes).toBe(0);
    expect(result.batchState).toBe('cancelled');
    const row = d.raw.prepare('SELECT state FROM photos WHERE asset_id = ?').get('p1') as {
      state: string;
    };
    expect(row.state).toBe('culled'); // still staged, retryable
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(0);
  });

  it('unknown verification earns no credit and stays retryable', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    const batch = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: 'p1', measuredBytes: 50 }],
      null,
      AT,
    );
    await markBatchLaunching(asExpo(d), batch!.batchId, AT + 1);
    const result = await resolveTrashBatch(asExpo(d), {
      batchId: batch!.batchId,
      verify: unknown,
      dialog: 'applied',
      at: AT + 2,
    });
    expect(result.outcomes.p1).toBe('unknown');
    expect(result.creditedBytes).toBe(0);
    expect(result.batchState).toBe('verified_partial');
    // Retry: a new batch can be prepared (no terminal outcome, no live reservation).
    const retry = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: 'p1', measuredBytes: 50 }],
      null,
      AT + 3,
    );
    expect(retry!.members).toHaveLength(1);
  });
});

describe('recovery after process death (P8#3)', () => {
  it('an interrupted preparing batch is released without dispatch', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    await prepareTrashBatch(asExpo(d), [{ photoId: 'p1', measuredBytes: 10 }], null, AT);
    // Death here — no dispatch. Recovery releases everything.
    const recovered = await recoverTrashBatches(asExpo(d), absent, AT + 10);
    expect(recovered).toBe(1);
    const batch = d.raw.prepare('SELECT state FROM trash_batches').get() as { state: string };
    expect(batch.state).toBe('cancelled');
    const row = d.raw.prepare('SELECT state FROM photos WHERE asset_id = ?').get('p1') as {
      state: string;
    };
    expect(row.state).toBe('culled');
  });

  it('an interrupted launching batch with absence is repaired but UNCREDITED', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    const batch = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: 'p1', measuredBytes: 999 }],
      null,
      AT,
    );
    await markBatchLaunching(asExpo(d), batch!.batchId, AT + 1);
    // Death in the crash window; on restart the URI is absent.
    await recoverTrashBatches(asExpo(d), absent, AT + 10);
    const member = d.raw
      .prepare('SELECT outcome FROM trash_batch_members WHERE photo_id = ?')
      .get('p1') as { outcome: string };
    expect(member.outcome).toBe('absent_after_interrupted_launch');
    const row = d.raw
      .prepare('SELECT state, is_present FROM photos WHERE asset_id = ?')
      .get('p1') as Record<string, unknown>;
    expect(row.state).toBe('trashed'); // repaired
    expect(row.is_present).toBe(0);
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(0); // never credited
    // A second recovery pass cannot double-account (idempotent terminal).
    await recoverTrashBatches(asExpo(d), absent, AT + 20);
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(0);
  });

  it('an interrupted launching batch still present releases back to culled', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    const batch = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: 'p1', measuredBytes: 10 }],
      null,
      AT,
    );
    await markBatchLaunching(asExpo(d), batch!.batchId, AT + 1);
    await recoverTrashBatches(asExpo(d), present, AT + 10);
    const row = d.raw.prepare('SELECT state FROM photos WHERE asset_id = ?').get('p1') as {
      state: string;
    };
    expect(row.state).toBe('culled');
  });
});

describe('restore → re-trash generations (P8#4)', () => {
  it('a verified post-restore re-trash counts the next generation exactly once', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    const first = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: 'p1', measuredBytes: 100 }],
      null,
      AT,
    );
    await markBatchLaunching(asExpo(d), first!.batchId, AT + 1);
    await resolveTrashBatch(asExpo(d), {
      batchId: first!.batchId,
      verify: absent,
      dialog: 'applied',
      at: AT + 2,
    });
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(100);
    // Gallery restore: generation increments once, photo re-enters review.
    await markPhotoRestored(asExpo(d), 'p1', AT + 10);
    const gen = d.raw
      .prepare('SELECT trash_generation, state FROM photos WHERE asset_id = ?')
      .get('p1') as Record<string, unknown>;
    expect(gen.trash_generation).toBe(1);
    expect(gen.state).toBe('unreviewed');
    // Re-stage + re-trash: the new generation counts again.
    d.raw.prepare("UPDATE photos SET state = 'culled' WHERE asset_id = 'p1'").run();
    const second = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: 'p1', measuredBytes: 100 }],
      null,
      AT + 20,
    );
    await markBatchLaunching(asExpo(d), second!.batchId, AT + 21);
    await resolveTrashBatch(asExpo(d), {
      batchId: second!.batchId,
      verify: absent,
      dialog: 'applied',
      at: AT + 22,
    });
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(200);
  });
});
