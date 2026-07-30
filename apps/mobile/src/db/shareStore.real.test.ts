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
      `INSERT INTO photos (asset_id, uri, taken_at, day, is_present, volume_name, raw_id)
       VALUES (?, 'content://x', ?, '2026-07-20', ?, 'external_primary', ?)`,
    )
    .run(id, AT, present, id);
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
    // A confirmed pass is COMPLETION EVIDENCE on the action too (v18):
    // share is the one action whose success is an event about a batch,
    // and without this stamp every "ever shared" reader — the Habits
    // turnaround row above all — would say no share ever finished.
    // The row STAYS queued: multi-pass sharing is the feature.
    const actions = d.raw
      .prepare(
        `SELECT photo_id, state, resolved_at FROM photo_actions
          WHERE kind = 'share' ORDER BY photo_id`,
      )
      .all() as { photo_id: string; state: string; resolved_at: number | null }[];
    expect(actions).toEqual([
      { photo_id: 'p1', state: 'queued', resolved_at: AT + 11 },
      { photo_id: 'p2', state: 'queued', resolved_at: null },
    ]);
    // A FAILED pass leaves no evidence, and re-promoting an ALREADY
    // opened batch is a no-op — the guard is the batch's own state, so
    // no stamp moves for a send that did not happen twice.
    await promoteShareBatch(asExpo(d), b1, AT + 999);
    expect(
      (
        d.raw
          .prepare("SELECT resolved_at FROM photo_actions WHERE photo_id = 'p1' AND kind = 'share'")
          .get() as { resolved_at: number }
      ).resolved_at,
    ).toBe(AT + 11);
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

  it('culling the last LIVE shared photo ends the cycle — the next queue starts fresh', async () => {
    // Verdict writes never touch this module, so the cull leaves the old
    // cycle open with a retained (non-live) row; the next add must close
    // it and mint a fresh cycle, or the new queue inherits pass history.
    const d = await fresh();
    insertPhoto(d, 'p1');
    insertPhoto(d, 'p2');
    await addToShareQueue(asExpo(d), 'p1', AT);
    const b1 = await createShareBatch(asExpo(d), ['p1'], AT + 10);
    await promoteShareBatch(asExpo(d), b1, AT + 11);
    d.raw.prepare("UPDATE photos SET state = 'culled' WHERE asset_id = 'p1'").run();
    await addToShareQueue(asExpo(d), 'p2', AT + 20);
    const cycles = d.raw.prepare('SELECT COUNT(*) AS n FROM share_cycles').get() as { n: number };
    expect(cycles.n).toBe(2);
    const queue = await getShareQueue(asExpo(d));
    expect(queue.map((r) => r.photo_id)).toEqual(['p2']);
    expect(queue[0].pass_count).toBe(0);
  });

  it('a staged cull SURVIVES the clear, and un-staging restores its queue place', async () => {
    // STATE_MODEL's restore promise outranks the sweep (grilling Q12):
    // the clear takes exactly the live rows it counted and the screen
    // showed; the hidden retained row rides through and resurfaces when
    // the photo is un-staged.
    const d = await fresh();
    insertPhoto(d, 'p1');
    insertPhoto(d, 'p2');
    await addToShareQueue(asExpo(d), 'p1', AT);
    await addToShareQueue(asExpo(d), 'p2', AT + 1);
    d.raw.prepare("UPDATE photos SET state = 'culled' WHERE asset_id = 'p1'").run();
    const result = await clearShareQueue(asExpo(d), AT + 10);
    expect(result.cleared).toBe(1); // p2 — exactly what the screen showed
    const rows = d.raw
      .prepare("SELECT photo_id, state FROM photo_actions WHERE kind = 'share'")
      .all() as { photo_id: string; state: string }[];
    expect(rows).toEqual([{ photo_id: 'p1', state: 'queued' }]);
    d.raw.prepare("UPDATE photos SET state = 'kept' WHERE asset_id = 'p1'").run();
    const queue = await getShareQueue(asExpo(d));
    expect(queue.map((r) => r.photo_id)).toEqual(['p1']);
  });

  it('clear removes an ERRORED never-sent row, exactly like clearQueue', async () => {
    // The delete leg must cover state IN ('queued','error'): an errored
    // row that never resolved matches neither a 'queued'-only delete nor
    // the resolved-row demote, so it survived a clear and the queue
    // never read as empty.
    const d = await fresh();
    insertPhoto(d, 'p1');
    await addToShareQueue(asExpo(d), 'p1', AT);
    d.raw
      .prepare("UPDATE photo_actions SET state = 'error' WHERE photo_id = 'p1' AND kind = 'share'")
      .run();
    const result = await clearShareQueue(asExpo(d), AT + 20);
    expect(result.cleared).toBe(1);
    const rows = d.raw
      .prepare("SELECT COUNT(*) AS n FROM photo_actions WHERE kind = 'share'")
      .get() as { n: number };
    expect(rows.n).toBe(0);
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

  it('a partial clear leaves the cycle OPEN while hidden unreachable rows stay queued (V2)', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    d.raw
      .prepare(
        `INSERT INTO photos (asset_id, uri, taken_at, day, is_present, volume_name, raw_id)
         VALUES ('0a91-e18d/s1', 'content://x', ${AT}, '2026-07-20', 1, '0a91-e18d', 's1')`,
      )
      .run();
    await addToShareQueue(asExpo(d), 'p1', AT);
    await addToShareQueue(asExpo(d), '0a91-e18d/s1', AT + 1);
    // Card out: the clear sees only p1 (reach-scoped) and is bounded to
    // the rendered rows — the SD row survives, so its cycle must too.
    const result = await clearShareQueue(asExpo(d), AT + 10, ['external_primary'], ['p1']);
    expect(result.cleared).toBe(1);
    const cycle = d.raw
      .prepare('SELECT ended_at FROM share_cycles ORDER BY id DESC LIMIT 1')
      .get() as { ended_at: number | null };
    expect(cycle.ended_at).toBeNull();
    const queue = await getShareQueue(asExpo(d));
    expect(queue.map((r) => r.photo_id)).toEqual(['0a91-e18d/s1']);
  });

  it('a displayed-ids bound past the SQL variable floor clears in chunks (U2)', async () => {
    const d = await fresh();
    const ids: string[] = [];
    const insert = d.raw.prepare(
      `INSERT INTO photos (asset_id, uri, taken_at, day, is_present, volume_name, raw_id)
       VALUES (?, 'content://x', ${AT}, '2026-07-20', 1, 'external_primary', ?)`,
    );
    const queue = d.raw.prepare(
      `INSERT INTO photo_actions (photo_id, kind, state, queued_at)
       VALUES (?, 'share', 'queued', ${AT})`,
    );
    for (let i = 0; i < 1100; i += 1) {
      const id = `bulk${i}`;
      ids.push(id);
      insert.run(id, id);
      queue.run(id);
    }
    d.raw.prepare(`INSERT INTO share_cycles (started_at) VALUES (${AT})`).run();
    const result = await clearShareQueue(asExpo(d), AT + 10, null, ids);
    expect(result.cleared).toBe(1100);
    const left = d.raw
      .prepare("SELECT COUNT(*) AS n FROM photo_actions WHERE kind = 'share'")
      .get() as { n: number };
    expect(left.n).toBe(0);
  });

  it('remove-one keeps the rest of the queue', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    insertPhoto(d, 'p2');
    await addToShareQueue(asExpo(d), 'p1', AT);
    await addToShareQueue(asExpo(d), 'p2', AT);
    await removeFromShareQueue(asExpo(d), 'p1', AT + 1);
    const queue = await getShareQueue(asExpo(d));
    expect(queue.map((r) => r.photo_id)).toEqual(['p2']);
    // The queue is not empty, so the cycle stays open.
    const open = d.raw
      .prepare('SELECT COUNT(*) AS n FROM share_cycles WHERE ended_at IS NULL')
      .get() as { n: number };
    expect(open.n).toBe(1);
  });

  it('removing the last queued photo ends the cycle — a requeue starts at zero passes', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    await addToShareQueue(asExpo(d), 'p1', AT);
    // One completed pass in this cycle.
    const batchId = await createShareBatch(asExpo(d), ['p1'], AT + 1);
    await promoteShareBatch(asExpo(d), batchId, AT + 2);
    expect((await getShareQueue(asExpo(d)))[0].pass_count).toBe(1);
    // Emptying the queue by removal (not explicit clear) ends the cycle.
    await removeFromShareQueue(asExpo(d), 'p1', AT + 3);
    const open = d.raw
      .prepare('SELECT COUNT(*) AS n FROM share_cycles WHERE ended_at IS NULL')
      .get() as { n: number };
    expect(open.n).toBe(0);
    // Requeue: fresh cycle, badge starts at zero; History keeps the event.
    await addToShareQueue(asExpo(d), 'p1', AT + 4);
    const queue = await getShareQueue(asExpo(d));
    expect(queue[0].pass_count).toBe(0);
    expect(await countNeverShared(asExpo(d))).toBe(1);
  });
});
