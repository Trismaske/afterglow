/**
 * Store contract tests on real SQLite (m0.8 gate 3 — sessionless):
 * applyReviewDecisions verdict semantics (decision 2: keeps write done at
 * swipe, reviewed_at first-stamps, edit-cycle resets), durable user
 * ejection (makePhotoSingles), needs-edit cycle hardening, the favourite
 * batch commits, un-staging paths, and activity_at on every transition.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  applyReviewDecisions,
  getStagedCulls,
  makePhotoSingles,
  markEditDone,
  markFavouriteBatchApplied,
  markFavouriteBatchError,
  restoreCarriedCull,
  setNeedsEdit,
  unstageCullDirect,
  writeContinuousGroups,
  type ContinuousPhotoUpsert,
} from './store';
import { foreignKeyCheck, openTestDb, type TestDb } from './testDb';

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

const id = (rawId: string): string => `external_primary/${rawId}`;

function upsert(rawId: string, takenAt = AT - 3_600_000): ContinuousPhotoUpsert {
  return {
    assetId: id(rawId),
    uri: `file:///dcim/${rawId}.jpg`,
    takenAt,
    modTime: takenAt,
    day: '2026-07-20',
    volumeName: 'external_primary',
    rawId,
  };
}

/** Seed photos the m0.8 way: the continuous scan's window write. */
async function seed(d: TestDb, rawIds: string[], groups: string[][] = []): Promise<void> {
  await writeContinuousGroups(
    asExpo(d),
    {
      photos: rawIds.map((r) => upsert(r)),
      groups: groups.map((g) => ({ members: g.map(id), timeAttached: [] })),
      singles: rawIds.map(id).filter((a) => !groups.some((g) => g.map(id).includes(a))),
    },
    AT,
  );
}

function stateOf(d: TestDb, rawId: string): Record<string, unknown> {
  return d.raw
    .prepare(
      `SELECT state, needs_edit, to_edit_at, mod_time, content_hash,
              reviewed_at, culled_at, activity_at
       FROM photos WHERE asset_id = ?`,
    )
    .get(id(rawId)) as Record<string, unknown>;
}

describe('applyReviewDecisions (decision 2)', () => {
  it('a keep writes done at swipe time and first-stamps reviewed_at', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'done']], AT + 100);
    const row = stateOf(d, '1');
    expect(row.state).toBe('done');
    expect(row.reviewed_at).toBe(AT + 100);
    expect(row.activity_at).toBe(AT + 100);
    // A re-decide keeps the FIRST review stamp (lifetime stats).
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 200);
    const after = stateOf(d, '1');
    expect(after.state).toBe('culled');
    expect(after.reviewed_at).toBe(AT + 100);
    expect(after.culled_at).toBe(AT + 200);
  });

  it('to_edit is a reviewed verdict: flag, cycle stamp, reviewed_at', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'to_edit']], AT + 100);
    const row = stateOf(d, '1');
    expect(row.state).toBe('to_edit');
    expect(row.needs_edit).toBe(1);
    expect(row.to_edit_at).toBe(AT + 100);
    expect(row.reviewed_at).toBe(AT + 100);
  });

  it('a keep on a flagged photo lands on to_edit (flag survives)', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'to_edit']], AT + 100);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 150);
    // Flag again without a verdict, then keep: the keep must respect it.
    await applyReviewDecisions(asExpo(d), [], AT + 200, {
      needsEditChanges: [{ assetId: id('1'), needsEdit: true }],
    });
    await applyReviewDecisions(asExpo(d), [[id('1'), 'done']], AT + 300);
    expect(stateOf(d, '1').state).toBe('to_edit');
  });

  it('clearing a completed verdict resets the edit-cycle columns', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'to_edit']], AT + 100);
    d.raw.prepare('UPDATE photos SET content_hash = ? WHERE asset_id = ?').run('hash1', id('1'));
    await markEditDone(asExpo(d), id('1'), AT + 200);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 300);
    const row = stateOf(d, '1');
    expect(row.state).toBe('unreviewed');
    expect(row.needs_edit).toBe(0);
    expect(row.to_edit_at).toBeNull();
    expect(row.mod_time).toBeNull();
    expect(row.content_hash).toBeNull();
  });

  it('records a duel with its group and favourite intents atomically', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    await applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 100, {
      duel: { groupId: '7', winnerId: id('1'), loserId: id('2'), keptBoth: false, at: AT + 100 },
      favouriteChanges: [{ assetId: id('1'), state: 'queued_apply', target: true }],
    });
    const duel = d.raw.prepare('SELECT * FROM duels').get() as Record<string, unknown>;
    expect(duel.group_id).toBe('7');
    expect(duel.kept_both).toBe(0);
    const fav = d.raw
      .prepare('SELECT favourite_state, favourite_target FROM photos WHERE asset_id = ?')
      .get(id('1')) as Record<string, unknown>;
    expect(fav.favourite_state).toBe('queued_apply');
    expect(fav.favourite_target).toBe(1);
    expect(stateOf(d, '2').state).toBe('culled');
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

describe('needs-edit cycle hardening (m0.7 carried over)', () => {
  it('re-flagging a completed edit re-queues it with a fresh detection baseline', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'to_edit']], AT + 100);
    d.raw.prepare('UPDATE photos SET content_hash = ? WHERE asset_id = ?').run('hash1', id('1'));
    await markEditDone(asExpo(d), id('1'), AT + 200);
    await setNeedsEdit(asExpo(d), id('1'), true, AT + 300);
    const row = stateOf(d, '1');
    expect(row.state).toBe('to_edit');
    expect(row.needs_edit).toBe(1);
    expect(row.to_edit_at).toBe(AT + 300);
    expect(row.mod_time).toBeNull();
    expect(row.content_hash).toBeNull();
  });

  it('cycle-guarded markEditDone refuses stale evidence from a superseded cycle', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'to_edit']], AT + 100);
    await markEditDone(asExpo(d), id('1'), AT + 200);
    await setNeedsEdit(asExpo(d), id('1'), true, AT + 300); // fresh cycle
    expect(await markEditDone(asExpo(d), id('1'), AT + 400, AT + 100)).toBe(false);
    expect(stateOf(d, '1').state).toBe('to_edit'); // the fresh cycle survives
    expect(await markEditDone(asExpo(d), id('1'), AT + 500, AT + 300)).toBe(true);
  });
});

describe('makePhotoSingles (durable user ejection)', () => {
  it('marks user_single and dissolves the emptied group', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2']]);
    await makePhotoSingles(asExpo(d), [id('1'), id('2')]);
    const assignments = d.raw
      .prepare('SELECT photo_id, group_id, user_single FROM photo_group_assignments')
      .all() as { photo_id: string; group_id: number | null; user_single: number }[];
    expect(assignments).toHaveLength(3);
    expect(assignments.every((a) => a.group_id === null)).toBe(true);
    const marked = Object.fromEntries(assignments.map((a) => [a.photo_id, a.user_single]));
    expect(marked[id('1')]).toBe(1);
    expect(marked[id('2')]).toBe(1);
    expect(marked[id('3')]).toBe(0); // scan-made single, not user-ejected
    const groups = d.raw.prepare('SELECT COUNT(*) AS n FROM photo_groups').get() as { n: number };
    expect(groups.n).toBe(0);
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('ejecting from a 3-member group keeps the surviving pair grouped', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    await makePhotoSingles(asExpo(d), [id('1')]);
    const assignments = Object.fromEntries(
      (
        d.raw.prepare('SELECT photo_id, group_id FROM photo_group_assignments').all() as {
          photo_id: string;
          group_id: number | null;
        }[]
      ).map((a) => [a.photo_id, a.group_id]),
    );
    expect(assignments[id('1')]).toBeNull();
    expect(assignments[id('2')]).not.toBeNull();
    expect(assignments[id('2')]).toBe(assignments[id('3')]);
  });
});

describe('un-staging paths (decision 2)', () => {
  it('unstageCullDirect lands on done (to_edit when flagged)', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'culled'],
        [id('2'), 'culled'],
      ],
      AT + 100,
    );
    d.raw.prepare('UPDATE photos SET needs_edit = 1 WHERE asset_id = ?').run(id('2'));
    await unstageCullDirect(asExpo(d), id('1'), AT + 200, true);
    await unstageCullDirect(asExpo(d), id('2'), AT + 200, true);
    expect(stateOf(d, '1').state).toBe('done');
    expect(stateOf(d, '2').state).toBe('to_edit');
    expect(await getStagedCulls(asExpo(d))).toHaveLength(0);
  });

  it('restoreCarriedCull lands on unreviewed (back to the review pool)', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 100);
    await restoreCarriedCull(asExpo(d), id('1'), AT + 200);
    expect(stateOf(d, '1').state).toBe('unreviewed');
  });
});

describe('favourite batch commits', () => {
  function insertFav(d: TestDb, assetId: string, state: string, target: number | null): void {
    d.raw
      .prepare(
        `INSERT INTO photos (asset_id, uri, taken_at, day, state, favourite_state, favourite_target)
         VALUES (?, 'content://x', ?, '2026-07-20', 'done', ?, ?)`,
      )
      .run(assetId, AT, state, target);
  }

  it('apply commits queued_apply rows: applied, target cleared, applied_at stamped', async () => {
    const d = await fresh();
    insertFav(d, 'p1', 'queued_apply', 1);
    await markFavouriteBatchApplied(asExpo(d), ['p1'], true, AT + 5);
    const row = d.raw
      .prepare(
        'SELECT favourite_state, favourite_target, favourite_applied_at FROM photos WHERE asset_id = ?',
      )
      .get('p1') as Record<string, unknown>;
    expect(row.favourite_state).toBe('applied');
    expect(row.favourite_target).toBeNull();
    expect(row.favourite_applied_at).toBe(AT + 5);
  });

  it('remove commits queued_remove rows to none', async () => {
    const d = await fresh();
    insertFav(d, 'p1', 'queued_remove', 0);
    await markFavouriteBatchApplied(asExpo(d), ['p1'], false, AT + 5);
    const row = d.raw
      .prepare('SELECT favourite_state, favourite_target FROM photos WHERE asset_id = ?')
      .get('p1') as Record<string, unknown>;
    expect(row.favourite_state).toBe('none');
    expect(row.favourite_target).toBeNull();
  });

  it('a stale continuation cannot commit over a RETARGETED intent', async () => {
    const d = await fresh();
    insertFav(d, 'p1', 'queued_remove', 0);
    await markFavouriteBatchApplied(asExpo(d), ['p1'], true, AT + 5);
    const row = d.raw
      .prepare('SELECT favourite_state, favourite_target FROM photos WHERE asset_id = ?')
      .get('p1') as Record<string, unknown>;
    expect(row.favourite_state).toBe('queued_remove');
    expect(row.favourite_target).toBe(0);
  });

  it('error keeps the matching intent retryable; a retargeted one is untouched', async () => {
    const d = await fresh();
    insertFav(d, 'match', 'queued_apply', 1);
    insertFav(d, 'retargeted', 'queued_remove', 0);
    await markFavouriteBatchError(asExpo(d), ['match', 'retargeted'], true, AT + 5);
    const rows = Object.fromEntries(
      (
        d.raw.prepare('SELECT asset_id, favourite_state, favourite_target FROM photos').all() as {
          asset_id: string;
          favourite_state: string;
          favourite_target: number | null;
        }[]
      ).map((r) => [r.asset_id, r]),
    );
    expect(rows.match.favourite_state).toBe('error');
    expect(rows.match.favourite_target).toBe(1); // target survives for retry
    expect(rows.retargeted.favourite_state).toBe('queued_remove');
    expect(rows.retargeted.favourite_target).toBe(0);
  });
});

describe('activity_at transitions', () => {
  it('every decision write moves activity_at', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'done']], AT + 500);
    const row = d.raw.prepare('SELECT activity_at FROM photos WHERE asset_id = ?').get(id('1')) as {
      activity_at: number;
    };
    expect(row.activity_at).toBe(AT + 500);
  });
});
