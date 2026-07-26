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
  applyRedecision,
  applyReviewDecisions,
  countReviewQueue,
  getCorpusStats,
  getDayReviewSummary,
  getDaySummariesForDays,
  getGridPhotosByFilter,
  getPhotoFacts,
  getReviewGroup,
  getStagedCulls,
  getUnreviewedDayRows,
  listGroupsForDay,
  listReviewGroups,
  listSinglesFeed,
  makePhotoSingles,
  markEditDone,
  markFavouriteBatchApplied,
  markFavouriteBatchError,
  resetUnreviewedGroups,
  restoreCarriedCull,
  setGroupBest,
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

// ------------------------------------------------------------- gate 5

/** Seed with explicit days/timestamps (the gate-5 day queries need more
 * than the default single-day corpus). */
async function seedDays(
  d: TestDb,
  photos: { rawId: string; day: string; takenAt: number }[],
  groups: string[][] = [],
  timeAttached: string[] = [],
): Promise<void> {
  await writeContinuousGroups(
    asExpo(d),
    {
      photos: photos.map((p) => ({
        ...upsert(p.rawId, p.takenAt),
        day: p.day,
      })),
      groups: groups.map((g) => ({
        members: g.map(id),
        timeAttached: timeAttached.filter((t) => g.includes(t)).map(id),
      })),
      singles: photos
        .map((p) => id(p.rawId))
        .filter((a) => !groups.some((g) => g.map(id).includes(a))),
    },
    AT,
  );
}

function groupIdOf(d: TestDb, rawId: string): number {
  const row = d.raw
    .prepare('SELECT group_id FROM photo_group_assignments WHERE photo_id = ?')
    .get(id(rawId)) as { group_id: number };
  return Number(row.group_id);
}

describe('gate 5: singles feed + completed-group browse', () => {
  it('listSinglesFeed keeps staged culls in the feed, drops done/to_edit', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3', '4']);
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'culled'],
        [id('2'), 'done'],
        [id('3'), 'to_edit'],
      ],
      AT + 1,
    );
    const feed = await listSinglesFeed(asExpo(d), 10);
    expect(feed.map((m) => m.asset_id).sort()).toEqual([id('1'), id('4')].sort());
    expect(feed.find((m) => m.asset_id === id('1'))?.state).toBe('culled');
  });

  it('getReviewGroup returns a COMPLETED group the queue no longer lists', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    const gid = groupIdOf(d, '1');
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'done'],
        [id('2'), 'culled'],
        [id('3'), 'done'],
      ],
      AT + 1,
    );
    expect(await listReviewGroups(asExpo(d), 10)).toEqual([]);
    const group = await getReviewGroup(asExpo(d), gid);
    expect(group?.groupId).toBe(gid);
    expect(group?.members.map((m) => m.state).sort()).toEqual(['culled', 'done', 'done']);
    expect(await getReviewGroup(asExpo(d), gid + 999)).toBeNull();
  });
});

describe('gate 5: day queries', () => {
  const P = (rawId: string, day: string, hour: number) => ({
    rawId,
    day,
    takenAt: AT - 10 * 86_400_000 + hour * 3_600_000,
  });

  it("listGroupsForDay returns the day's groups, completed included, newest first", async () => {
    const d = await fresh();
    await seedDays(
      d,
      [
        P('1', '2026-07-18', 1),
        P('2', '2026-07-18', 1),
        P('3', '2026-07-18', 5),
        P('4', '2026-07-18', 5),
        P('5', '2026-07-19', 2),
        P('6', '2026-07-19', 2),
      ],
      [
        ['1', '2'],
        ['3', '4'],
        ['5', '6'],
      ],
    );
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'done'],
        [id('2'), 'done'],
      ],
      AT + 1,
    );
    const day18 = await listGroupsForDay(asExpo(d), '2026-07-18');
    expect(day18).toHaveLength(2);
    // Newest group first: the 05:00 pair before the completed 01:00 pair.
    expect(day18[0].members.map((m) => m.asset_id)).toEqual([id('3'), id('4')]);
    expect(day18[1].members.every((m) => m.state === 'done')).toBe(true);
    expect(await listGroupsForDay(asExpo(d), '2026-07-19')).toHaveLength(1);
    expect(await listGroupsForDay(asExpo(d), '2026-07-20')).toHaveLength(0);
  });

  it('getUnreviewedDayRows counts pending per day, newest first, and drops finished days', async () => {
    const d = await fresh();
    await seedDays(d, [
      P('1', '2026-07-17', 1),
      P('2', '2026-07-17', 2),
      P('3', '2026-07-18', 1),
      P('4', '2026-07-19', 1),
    ]);
    await applyReviewDecisions(asExpo(d), [[id('4'), 'done']], AT + 1);
    const rows = await getUnreviewedDayRows(asExpo(d));
    expect(rows).toEqual([
      { day: '2026-07-18', pending: 1 },
      { day: '2026-07-17', pending: 2 },
    ]);
  });

  it('getDaySummariesForDays returns exactly the requested days', async () => {
    const d = await fresh();
    await seedDays(d, [P('1', '2026-07-17', 1), P('2', '2026-07-18', 1), P('3', '2026-07-19', 1)]);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 1);
    const map = await getDaySummariesForDays(asExpo(d), ['2026-07-17', '2026-07-19']);
    expect([...map.keys()].sort()).toEqual(['2026-07-17', '2026-07-19']);
    expect(map.get('2026-07-17')).toMatchObject({ tracked: 1, staged: 1, done: 0 });
  });
});

describe('gate 5: getPhotoFacts', () => {
  it('joins state, group membership, best, time-attached and ejection facts', async () => {
    const d = await fresh();
    await seedDays(d, [P0('1'), P0('2'), P0('3'), P0('4')], [['1', '2', '3']], ['3']);
    const gid = groupIdOf(d, '1');
    await setGroupBest(asExpo(d), gid, id('1'));
    await applyReviewDecisions(asExpo(d), [[id('1'), 'done']], AT + 1);
    await makePhotoSingles(asExpo(d), [id('4')]);

    const best = await getPhotoFacts(asExpo(d), id('1'));
    expect(best).toMatchObject({
      state: 'done',
      group_id: gid,
      is_best: 1,
      time_attached: 0,
      user_single: 0,
    });
    expect(best?.reviewed_at).toBe(AT + 1);

    const attached = await getPhotoFacts(asExpo(d), id('3'));
    expect(attached).toMatchObject({ time_attached: 1, group_id: gid, is_best: 0 });

    const ejected = await getPhotoFacts(asExpo(d), id('4'));
    expect(ejected).toMatchObject({ group_id: null, user_single: 1 });

    expect(await getPhotoFacts(asExpo(d), id('nope'))).toBeNull();
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

function P0(rawId: string) {
  return { rawId, day: '2026-07-20', takenAt: AT - 3_600_000 };
}

// -------------------------------------------- final-review regressions

describe('grid filters (schema-v13 regression)', () => {
  it('every DB-backed filter queries without the removed group_id column', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3', '4'], [['1', '2']]);
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('3'), 'to_edit'],
        [id('4'), 'culled'],
      ],
      AT + 1,
    );
    const scope = { startMs: 0, endMs: AT * 2 };
    const inGroup = await getGridPhotosByFilter(asExpo(d), scope, null, 'in_group', 10, 0);
    expect(inGroup.map((r) => r.asset_id).sort()).toEqual([id('1'), id('2')]);
    expect(inGroup.every((r) => Number(r.grouped) === 1)).toBe(true);
    expect(
      (await getGridPhotosByFilter(asExpo(d), scope, null, 'to_edit', 10, 0))[0].asset_id,
    ).toBe(id('3'));
    expect((await getGridPhotosByFilter(asExpo(d), scope, null, 'staged', 10, 0))[0].asset_id).toBe(
      id('4'),
    );
    expect(await getGridPhotosByFilter(asExpo(d), scope, null, 'done', 10, 0)).toEqual([]);
  });
});

describe('scan reconciles externally restored photos', () => {
  it('a trashed row seen again by the scan returns to review with a generation bump', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    d.raw
      .prepare(
        "UPDATE photos SET state = 'trashed', is_present = 0, trash_generation = 1 WHERE asset_id = ?",
      )
      .run(id('1'));
    await seed(d, ['1', '2']); // the next scan window sees the restored photo
    const row = d.raw
      .prepare('SELECT state, is_present, trash_generation FROM photos WHERE asset_id = ?')
      .get(id('1')) as Record<string, unknown>;
    expect(row).toMatchObject({ state: 'unreviewed', is_present: 1, trash_generation: 2 });
  });
});

describe('corpus stats count current verdicts', () => {
  it('a cleared verdict returns the photo to the pending pool', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'done']], AT + 1);
    expect((await getCorpusStats(asExpo(d))).reviewed).toBe(1);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 2);
    expect((await getCorpusStats(asExpo(d))).reviewed).toBe(0);
  });
});

describe('source-scoped queue reads', () => {
  async function seedSourced(d: TestDb): Promise<void> {
    const photo = (rawId: string, folder: string) => ({
      ...upsert(rawId),
      uri: `file:///storage/emulated/0/${folder}/${rawId}.jpg`,
    });
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          photo('c1', 'DCIM/Camera'),
          photo('c2', 'DCIM/Camera'),
          photo('w1', 'WhatsApp/Media'),
          photo('w2', 'WhatsApp/Media'),
        ],
        groups: [
          { members: [id('c1'), id('c2')], timeAttached: [] },
          { members: [id('w1'), id('w2')], timeAttached: [] },
        ],
        singles: [],
      },
      AT,
    );
  }
  const CAMERA = ['DCIM/Camera'];

  it('groups, singles feed, counts and day groups all honor the roots filter', async () => {
    const d = await fresh();
    await seedSourced(d);
    const groups = await listReviewGroups(asExpo(d), 10, CAMERA);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.asset_id).sort()).toEqual([id('c1'), id('c2')]);
    expect(await countReviewQueue(asExpo(d), CAMERA)).toEqual({ grouped: 2, singles: 0 });
    expect(await listGroupsForDay(asExpo(d), '2026-07-20', CAMERA)).toHaveLength(1);
    // Singles: ejecting one member of each pair dissolves it (both become
    // singles) — the feed must list only the Camera two.
    await makePhotoSingles(asExpo(d), [id('c1'), id('w1')]);
    const feed = await listSinglesFeed(asExpo(d), 10, CAMERA);
    expect(feed.map((m) => m.asset_id).sort()).toEqual([id('c1'), id('c2')]);
  });
});

describe('atomic compare verdicts', () => {
  it('duel, loser verdict, and the star land in one write', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    const gid = groupIdOf(d, '1');
    await applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 1, {
      duel: {
        groupId: String(gid),
        winnerId: id('1'),
        loserId: id('2'),
        keptBoth: false,
        at: AT + 1,
      },
      setBest: { groupId: gid, assetId: id('1') },
    });
    expect(stateOf(d, '2').state).toBe('culled');
    const best = d.raw.prepare('SELECT best_photo_id FROM photo_groups WHERE id = ?').get(gid) as {
      best_photo_id: string;
    };
    expect(best.best_photo_id).toBe(id('1'));
    expect(d.raw.prepare('SELECT COUNT(*) AS n FROM duels').get()).toEqual({ n: 1 });
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

// -------------------------------------------- final-review round 2

describe('resetUnreviewedGroups spares mixed groups', () => {
  it('only fully-unreviewed groups and plain singles reset', async () => {
    const d = await fresh();
    // g1 mixed (one done member), g2 fully unreviewed, s single, e ejected.
    await seed(
      d,
      ['1', '2', '3', '4', 's', 'e'],
      [
        ['1', '2'],
        ['3', '4'],
      ],
    );
    await makePhotoSingles(asExpo(d), [id('e')]);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'done']], AT + 1);
    await resetUnreviewedGroups(asExpo(d));
    const rows = d.raw
      .prepare('SELECT photo_id, group_id, user_single FROM photo_group_assignments')
      .all() as { photo_id: string; group_id: number | null; user_single: number }[];
    const byId = new Map(rows.map((r) => [r.photo_id, r]));
    // Mixed group survives whole; its unreviewed member keeps membership.
    expect(byId.get(id('1'))?.group_id).not.toBeNull();
    expect(byId.get(id('2'))?.group_id).toBe(byId.get(id('1'))?.group_id);
    // Fully-unreviewed group and the plain single reset (assignments gone).
    expect(byId.has(id('3'))).toBe(false);
    expect(byId.has(id('4'))).toBe(false);
    expect(byId.has(id('s'))).toBe(false);
    // The user-ejected single is untouchable.
    expect(byId.get(id('e'))).toMatchObject({ group_id: null, user_single: 1 });
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

describe('getDayReviewSummary (decision-day accounting)', () => {
  it('counts photos DECIDED that day whatever their capture day', async () => {
    const d = await fresh();
    // Captured on 2026-07-20 (seed default); decided "today" = 2026-07-25.
    await seed(d, ['1', '2', '3', '4']);
    const decidedAt = Date.UTC(2026, 6, 25, 12, 0, 0);
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'done'],
        [id('2'), 'culled'],
        [id('3'), 'to_edit'],
      ],
      decidedAt,
    );
    const day = new Date(decidedAt).toISOString().slice(0, 10);
    const summary = await getDayReviewSummary(asExpo(d), day);
    expect(summary).toMatchObject({ reviewed: 3, done: 1, staged: 1, trashed: 0 });
    expect(await getDayReviewSummary(asExpo(d), '2026-07-20')).toMatchObject({ reviewed: 0 });
  });
});

describe('corpus stats vs MediaStore denominator', () => {
  it('trashed rows (gone from MediaStore) leave the numerator', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'done']], AT + 1);
    d.raw
      .prepare("UPDATE photos SET state = 'trashed', is_present = 0 WHERE asset_id = ?")
      .run(id('2'));
    expect((await getCorpusStats(asExpo(d))).reviewed).toBe(1);
  });
});

// -------------------------------------------- final-review round 3

describe('pair ejection is durable for BOTH photos', () => {
  it('the survivor of a dissolved pair becomes a user single too', async () => {
    const d = await fresh();
    await seed(
      d,
      ['1', '2', '3', '4', '5'],
      [
        ['1', '2'],
        ['3', '4', '5'],
      ],
    );
    await makePhotoSingles(asExpo(d), [id('1'), id('3')]);
    const rows = d.raw
      .prepare('SELECT photo_id, group_id, user_single FROM photo_group_assignments')
      .all() as { photo_id: string; group_id: number | null; user_single: number }[];
    const byId = new Map(rows.map((r) => [r.photo_id, r]));
    // The pair: ejected AND survivor are durable singles.
    expect(byId.get(id('1'))).toMatchObject({ group_id: null, user_single: 1 });
    expect(byId.get(id('2'))).toMatchObject({ group_id: null, user_single: 1 });
    // The trio: survivors keep their (now pair) group, not user_single.
    expect(byId.get(id('3'))).toMatchObject({ group_id: null, user_single: 1 });
    expect(byId.get(id('4'))?.group_id).not.toBeNull();
    expect(byId.get(id('4'))?.user_single).toBe(0);
    expect(byId.get(id('5'))?.group_id).toBe(byId.get(id('4'))?.group_id);
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

describe('corpus stats honor the source scope', () => {
  it('groups and verdicts count only in-source photos', async () => {
    const d = await fresh();
    const photo = (rawId: string, folder: string) => ({
      ...upsert(rawId),
      uri: `file:///storage/emulated/0/${folder}/${rawId}.jpg`,
    });
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          photo('c1', 'DCIM/Camera'),
          photo('c2', 'DCIM/Camera'),
          photo('w1', 'WhatsApp/Media'),
          photo('w2', 'WhatsApp/Media'),
        ],
        groups: [
          { members: [id('c1'), id('c2')], timeAttached: [] },
          { members: [id('w1'), id('w2')], timeAttached: [] },
        ],
        singles: [],
      },
      AT,
    );
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('c1'), 'done'],
        [id('w1'), 'done'],
      ],
      AT + 1,
    );
    expect(await getCorpusStats(asExpo(d), ['DCIM/Camera'])).toEqual({
      groupsFound: 1,
      reviewed: 1,
    });
    expect(await getCorpusStats(asExpo(d))).toEqual({ groupsFound: 2, reviewed: 2 });
  });
});

// -------------------------------------------- final-review round 4

describe('group-level metadata freezes regroup rewrites', () => {
  it('a starred all-unreviewed group survives a window rewrite intact', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    const gid = groupIdOf(d, '1');
    await setGroupBest(asExpo(d), gid, id('2'));
    // The next window computes a DIFFERENT split — the starred group must
    // freeze whole (in-transaction revalidation), not be rebuilt.
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: ['1', '2', '3'].map((r) => upsert(r)),
        groups: [{ members: [id('1'), id('2')], timeAttached: [] }],
        singles: [id('3')],
      },
      AT + 10,
    );
    expect(groupIdOf(d, '1')).toBe(gid);
    expect(groupIdOf(d, '3')).toBe(gid);
    const best = d.raw.prepare('SELECT best_photo_id FROM photo_groups WHERE id = ?').get(gid) as {
      best_photo_id: string;
    };
    expect(best.best_photo_id).toBe(id('2'));
  });
});

describe('clearing a verdict resets the full edit-cycle baseline', () => {
  it('culled → unreviewed clears to_edit_at, mod_time and content_hash', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'to_edit']], AT + 100);
    d.raw
      .prepare('UPDATE photos SET mod_time = 123, content_hash = ? WHERE asset_id = ?')
      .run('h', id('1'));
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 200);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 300);
    const row = stateOf(d, '1');
    expect(row).toMatchObject({
      state: 'unreviewed',
      to_edit_at: null,
      mod_time: null,
      content_hash: null,
      needs_edit: 0,
    });
  });

  it('restoreCarriedCull resets the baseline and can preserve pending matches', async () => {
    const d = await fresh();
    await seed(d, ['1', '9']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'to_edit']], AT + 100);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 200);
    d.raw
      .prepare(
        `INSERT INTO edit_copy_matches (original_id, copy_id, detected_at, state)
         VALUES (?, ?, ?, 'pending')`,
      )
      .run(id('1'), id('9'), AT + 250);
    await restoreCarriedCull(asExpo(d), id('1'), AT + 300, false);
    const row = stateOf(d, '1');
    expect(row).toMatchObject({ state: 'unreviewed', to_edit_at: null, mod_time: null });
    const match = d.raw
      .prepare('SELECT state FROM edit_copy_matches WHERE original_id = ?')
      .get(id('1')) as { state: string };
    expect(match.state).toBe('pending'); // tap-to-clear answers nothing
  });
});

describe('absent members dissolve their groups', () => {
  it('a pair whose member went absent stops queueing as a 1-photo group', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    const { reconcileExternallyRemoved } = await import('./trashStore');
    await reconcileExternallyRemoved(asExpo(d), [id('1')], AT + 100);
    const groups = await listReviewGroups(asExpo(d), 10);
    expect(groups).toEqual([]);
    // The present survivor is a plain single again (not user-ejected).
    const row = d.raw
      .prepare('SELECT group_id, user_single FROM photo_group_assignments WHERE photo_id = ?')
      .get(id('2')) as { group_id: number | null; user_single: number };
    expect(row).toMatchObject({ group_id: null, user_single: 0 });
    const feed = await listSinglesFeed(asExpo(d), 10);
    expect(feed.map((m) => m.asset_id)).toEqual([id('2')]);
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

// -------------------------------------------- final-review round 5

describe('strictness reset spares metadata groups', () => {
  it('an all-unreviewed group with a starred best survives the reset', async () => {
    const d = await fresh();
    await seed(
      d,
      ['1', '2', '3', '4'],
      [
        ['1', '2'],
        ['3', '4'],
      ],
    );
    const starred = groupIdOf(d, '1');
    await setGroupBest(asExpo(d), starred, id('1'));
    await resetUnreviewedGroups(asExpo(d));
    // The starred group keeps membership + star; the plain one reset.
    expect(groupIdOf(d, '1')).toBe(starred);
    expect(groupIdOf(d, '2')).toBe(starred);
    const best = d.raw
      .prepare('SELECT best_photo_id FROM photo_groups WHERE id = ?')
      .get(starred) as { best_photo_id: string };
    expect(best.best_photo_id).toBe(id('1'));
    const plain = d.raw
      .prepare('SELECT group_id FROM photo_group_assignments WHERE photo_id = ?')
      .get(id('3'));
    expect(plain).toBeUndefined();
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

// -------------------------------------------- final-review round 6

describe('applyRedecision (state-aware change of mind)', () => {
  it('Keep on a flagged to_edit photo lands on done with the flag cleared', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'to_edit']], AT + 100);
    await applyRedecision(asExpo(d), id('1'), 'keep', AT + 200);
    const row = stateOf(d, '1');
    expect(row).toMatchObject({ state: 'done', needs_edit: 0, to_edit_at: null, mod_time: null });
  });

  it('Keep on a flagged staged cull lands on done, resolving its copy match', async () => {
    const d = await fresh();
    await seed(d, ['1', '9']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'to_edit']], AT + 100);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 200);
    d.raw
      .prepare(
        `INSERT INTO edit_copy_matches (original_id, copy_id, detected_at, state)
         VALUES (?, ?, ?, 'pending')`,
      )
      .run(id('1'), id('9'), AT + 250);
    await applyRedecision(asExpo(d), id('1'), 'keep', AT + 300);
    expect(stateOf(d, '1')).toMatchObject({ state: 'done', needs_edit: 0 });
    const match = d.raw
      .prepare('SELECT state FROM edit_copy_matches WHERE original_id = ?')
      .get(id('1')) as { state: string };
    expect(match.state).toBe('resolved'); // an explicit keep answers the prompt
  });

  it('To edit on a done photo starts a FRESH cycle, never reusing stale evidence', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'to_edit']], AT + 100);
    d.raw
      .prepare('UPDATE photos SET mod_time = 123, content_hash = ? WHERE asset_id = ?')
      .run('stale', id('1'));
    await markEditDone(asExpo(d), id('1'), AT + 200);
    await applyRedecision(asExpo(d), id('1'), 'to_edit', AT + 300);
    const row = stateOf(d, '1');
    expect(row).toMatchObject({
      state: 'to_edit',
      needs_edit: 1,
      to_edit_at: AT + 300,
      mod_time: null,
      content_hash: null,
    });
  });

  it('is a no-op for the already-active target state', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'to_edit']], AT + 100);
    await applyRedecision(asExpo(d), id('1'), 'to_edit', AT + 200);
    expect(stateOf(d, '1').to_edit_at).toBe(AT + 100); // in-progress cycle untouched
  });
});

// -------------------------------------------- final-review round 7

describe('best-star hygiene', () => {
  it('culling the starred photo clears the star; a compare winner may replace it', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    const gid = groupIdOf(d, '1');
    await setGroupBest(asExpo(d), gid, id('2'));
    // Compare verdict: loser 2 culled, winner 1 starred — one transaction.
    await applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 100, {
      setBest: { groupId: gid, assetId: id('1') },
    });
    const best = d.raw.prepare('SELECT best_photo_id FROM photo_groups WHERE id = ?').get(gid) as {
      best_photo_id: string | null;
    };
    expect(best.best_photo_id).toBe(id('1'));
    // A plain cull of the star (no replacement) leaves NO best.
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 200);
    const after = d.raw.prepare('SELECT best_photo_id FROM photo_groups WHERE id = ?').get(gid) as {
      best_photo_id: string | null;
    };
    expect(after.best_photo_id).toBeNull();
  });

  it('an externally removed best is orphaned even while its assignment remains', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    const gid = groupIdOf(d, '1');
    await setGroupBest(asExpo(d), gid, id('1'));
    const { reconcileExternallyRemoved } = await import('./trashStore');
    await reconcileExternallyRemoved(asExpo(d), [id('1')], AT + 100);
    // Two present members remain — the group survives, the star clears.
    const best = d.raw.prepare('SELECT best_photo_id FROM photo_groups WHERE id = ?').get(gid) as {
      best_photo_id: string | null;
    };
    expect(best.best_photo_id).toBeNull();
    expect(await getReviewGroup(asExpo(d), gid)).not.toBeNull();
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

// -------------------------------------------- final-review round 15

describe('compare verdicts validate membership in the transaction', () => {
  it('aborts whole when the group was rebuilt out from under Compare', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2']]);
    const gid = groupIdOf(d, '1');
    // The group dissolves (ejection) before the compare verdict lands.
    await makePhotoSingles(asExpo(d), [id('1')]);
    await expect(
      applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 100, {
        duel: {
          groupId: String(gid),
          winnerId: id('1'),
          loserId: id('2'),
          keptBoth: false,
          at: AT + 100,
        },
        setBest: { groupId: gid, assetId: id('1') },
      }),
    ).rejects.toThrow(/changed while comparing/);
    // NOTHING committed: no duel, loser still unreviewed.
    expect(d.raw.prepare('SELECT COUNT(*) AS n FROM duels').get()).toEqual({ n: 0 });
    expect(stateOf(d, '2').state).toBe('unreviewed');
  });
});

// -------------------------------------------- final-review round 16

describe('undated photos carry no day', () => {
  it('day surfaces exclude a NULL-day photo while review includes it', async () => {
    const d = await fresh();
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [upsert('1'), { ...upsert('u'), day: null }],
        groups: [],
        singles: [id('1'), id('u')],
      },
      AT,
    );
    const days = await getUnreviewedDayRows(asExpo(d));
    expect(days).toEqual([{ day: '2026-07-20', pending: 1 }]);
    const summaries = await getDaySummariesForDays(asExpo(d), ['2026-07-20']);
    expect(summaries.get('2026-07-20')?.tracked).toBe(1);
    // The undated photo still reviews via the queue.
    const feed = await listSinglesFeed(asExpo(d), 10);
    expect(feed.map((m) => m.asset_id).sort()).toEqual([id('1'), id('u')]);
  });
});

describe('ejection validates the displayed group', () => {
  it('aborts whole when the group was rebuilt since render', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    const staleGid = groupIdOf(d, '1') + 999;
    await expect(makePhotoSingles(asExpo(d), [id('1')], staleGid)).rejects.toThrow(
      /changed while reviewing/,
    );
    // Nothing moved: the photo keeps its real group, no survivor frozen.
    const row = d.raw
      .prepare('SELECT group_id, user_single FROM photo_group_assignments WHERE photo_id = ?')
      .get(id('1')) as { group_id: number | null; user_single: number };
    expect(row.group_id).not.toBeNull();
    expect(row.user_single).toBe(0);
    // The matching id still works.
    await makePhotoSingles(asExpo(d), [id('1')], groupIdOf(d, '1'));
    expect(
      (
        d.raw
          .prepare('SELECT user_single FROM photo_group_assignments WHERE photo_id = ?')
          .get(id('1')) as { user_single: number }
      ).user_single,
    ).toBe(1);
  });
});

// -------------------------------------------- final-review round 26

describe('decisions reject externally removed photos', () => {
  it('a single-photo decision on a reconciled row surfaces and saves nothing', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    const { reconcileExternallyRemoved } = await import('./trashStore');
    await reconcileExternallyRemoved(asExpo(d), [id('1')], AT + 50);
    await expect(applyReviewDecisions(asExpo(d), [[id('1'), 'done']], AT + 100)).rejects.toThrow(
      /no longer available/,
    );
    // The trashed convergence survives — the scan restore path stays open.
    const row = d.raw
      .prepare('SELECT state, is_present FROM photos WHERE asset_id = ?')
      .get(id('1')) as { state: string; is_present: number };
    expect(row).toMatchObject({ state: 'trashed', is_present: 0 });
  });

  it('a batch keep skips reconciled members and applies the rest', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    const { reconcileExternallyRemoved } = await import('./trashStore');
    await reconcileExternallyRemoved(asExpo(d), [id('1')], AT + 50);
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'done'],
        [id('2'), 'done'],
      ],
      AT + 100,
    );
    expect(stateOf(d, '2').state).toBe('done');
    const gone = d.raw.prepare('SELECT state FROM photos WHERE asset_id = ?').get(id('1')) as {
      state: string;
    };
    expect(gone.state).toBe('trashed');
  });
});
