/**
 * Store contract tests on real SQLite (m0.8 gate 3 — sessionless):
 * applyReviewDecisions verdict semantics (decision 2: keeps write done at
 * swipe, reviewed_at first-stamps, edit-cycle resets), durable user
 * ejection (ejectNotRelated pairs, v22), needs-edit cycle hardening, the favourite
 * batch commits, un-staging paths, and activity_at on every transition.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import { dayKey, rangeOfDayKey, UNDATED_DAY_KEY } from '../lib/dates';
import {
  applyRedecision,
  applyReviewDecisions,
  countReviewQueue,
  countStagedCulls,
  countUndatedAlive,
  getCorpusStats,
  getCoverageByDay,
  getDayReviewSummary,
  getLifetimeStats,
  getRecentDecisionStamps,
  getDaySummariesForDays,
  fetchBrowseGroupsPage,
  fetchBrowseSinglesPage,
  ejectNotRelated,
  getGridPhotosByFilter,
  getPhotoFacts,
  getRescuedPhotoPage,
  getStateRowsForAssets,
  getReviewedCountsByDay,
  getReviewGroup,
  getStagedCullBytes,
  getStagedCulls,
  getToEditPhotos,
  getStateCountsInScope,
  getUnreviewedDayRows,
  listGroupsForDay,
  listReviewGroups,
  listSinglesFeed,
  listSinglesForDeck,
  markEditDone,
  restoreCarriedCull,
  setNeedsEdit,
  unstageCullDirect,
  writeContinuousGroups,
  type ContinuousPhotoUpsert,
} from './store';
import { getFavouriteActionStates } from './actions';
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
    sizeBytes: 1_000,
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

/**
 * The photo's verdict row plus its edit cycle, which v18 moved into
 * `photo_actions`: "flagged" is a queued edit row, and that row's
 * `queued_at` IS the cycle key `to_edit_at` used to be. Projecting them
 * back into one shape keeps these tests about behaviour rather than
 * about which table a fact sits in.
 */
function stateOf(d: TestDb, rawId: string): Record<string, unknown> {
  return d.raw
    .prepare(
      `SELECT p.state, p.mod_time, p.content_hash, p.reviewed_at, p.culled_at,
              p.activity_at, p.decided_at,
              CASE WHEN e.state IN ('queued', 'error') THEN 1 ELSE 0 END AS needs_edit,
              CASE WHEN e.state IN ('queued', 'error') THEN e.queued_at END AS to_edit_at,
              e.resolved_at AS edit_completed_at
         FROM photos p
         LEFT JOIN photo_actions e ON e.photo_id = p.asset_id AND e.kind = 'edit'
        WHERE p.asset_id = ?`,
    )
    .get(id(rawId)) as Record<string, unknown>;
}

/** Queue an edit the way the review flow does. */
async function flagForEdit(d: TestDb, rawId: string, at: number): Promise<void> {
  await setNeedsEdit(asExpo(d), id(rawId), true, at);
}

describe("freshDecisions — the write counts the day's own work (m0.8.5, A3)", () => {
  it('counts a photo moving unreviewed to decided', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    const result = await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'kept'],
        [id('2'), 'culled'],
      ],
      AT + 100,
    );
    expect(result.freshDecisions).toBe(2);
    expect(result.appliedIds).toEqual([id('1'), id('2')]);
  });

  it('does NOT count a same-day re-decide', async () => {
    // The photo is already inside today's count; changing your mind
    // does not add a row to it.
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    const again = await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 200);
    expect(again.freshDecisions).toBe(0);
    expect(again.appliedIds).toEqual([id('1')]);
  });

  it('counts a photo ONCE per day, however often it is cleared and re-decided', async () => {
    // getReviewedCountsByDay counts one row per photo stamped that day,
    // and clearing deliberately keeps the stamp. Counting the re-decide
    // would put the celebration ahead of the ring.
    const d = await fresh();
    await seed(d, ['1']);
    const first = await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    const cleared = await applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 200);
    const redone = await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 300);
    expect([first.freshDecisions, cleared.freshDecisions, redone.freshDecisions]).toEqual([
      1, 0, 0,
    ]);
    const byDay = await getReviewedCountsByDay(asExpo(d), rangeOfDayKey(dayKey(AT)).startMs);
    expect(byDay.get(dayKey(AT))).toBe(1);
  });

  it('a photo decided on an EARLIER day is NOT fresh again today (gap 8)', async () => {
    // History is immutable: the first decision keeps its original day —
    // a re-decide moves no bar and credits no ring.
    const d = await fresh();
    await seed(d, ['1']);
    const yesterday = AT - 86_400_000;
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], yesterday);
    const again = await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT);
    expect(again.freshDecisions).toBe(0);
    const byDay = await getReviewedCountsByDay(asExpo(d), rangeOfDayKey(dayKey(yesterday)).startMs);
    expect(byDay.get(dayKey(yesterday))).toBe(1);
    expect(byDay.get(dayKey(AT))).toBeUndefined();
  });

  it('counts only the rows that committed in a mixed batch', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3']);
    await applyReviewDecisions(asExpo(d), [[id('2'), 'kept']], AT + 50);
    const batch = await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'kept'],
        [id('2'), 'kept'],
        [id('3'), 'kept'],
      ],
      AT + 100,
    );
    // Three rows applied, but one was already stamped today, so only
    // two are new work — exactly what the day's count rises by.
    expect(batch.appliedIds).toHaveLength(3);
    expect(batch.freshDecisions).toBe(2);
    const byDay = await getReviewedCountsByDay(asExpo(d), rangeOfDayKey(dayKey(AT)).startMs);
    expect(byDay.get(dayKey(AT))).toBe(3);
  });

  it('counts nothing for an action-only write', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    const result = await applyReviewDecisions(asExpo(d), [], AT + 100, {
      needsEditChanges: [{ assetId: id('1'), needsEdit: true }],
    });
    expect(result.freshDecisions).toBe(0);
  });

  it('agrees with the per-day counts the goal actually reads', async () => {
    // The count and the celebration must never disagree: one is the
    // running total the goal ring shows, the other arms the moment.
    const d = await fresh();
    await seed(d, ['1', '2', '3']);
    const dayStart = rangeOfDayKey(dayKey(AT)).startMs;
    const first = await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT);
    const second = await applyReviewDecisions(
      asExpo(d),
      [
        [id('2'), 'culled'],
        [id('3'), 'kept'],
      ],
      AT,
    );
    const byDay = await getReviewedCountsByDay(asExpo(d), dayStart);
    expect(first.freshDecisions + second.freshDecisions).toBe(byDay.get(dayKey(AT)) ?? 0);
  });

  it('a redecision rescuing an EARLIER day’s staged cull is applied but never fresh (gap 8)', async () => {
    // The rescue commits (appliedIds says so), but the photo's FIRST
    // decision happened yesterday — its history stays there.
    const d = await fresh();
    await seed(d, ['1']);
    const yesterday = AT - 86_400_000;
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], yesterday);
    const rescued = await applyRedecision(asExpo(d), id('1'), 'keep', AT);
    expect(rescued.freshDecisions).toBe(0);
    expect(rescued.appliedIds).toEqual([id('1')]);
    const byDay = await getReviewedCountsByDay(asExpo(d), rangeOfDayKey(dayKey(yesterday)).startMs);
    expect(byDay.get(dayKey(yesterday))).toBe(1);
  });

  it('counts an un-stage exactly like the redecision it mirrors (never fresh, gap 8)', async () => {
    // unstageCullDirect is the same culled → kept transition on another
    // path (state editor, trash rollback) — both photos already carry
    // their first stamps, so neither re-transition is fresh work.
    const d = await fresh();
    await seed(d, ['1', '2']);
    const yesterday = AT - 86_400_000;
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], yesterday);
    await applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 50);
    const laterDay = await unstageCullDirect(asExpo(d), id('1'), AT, true);
    expect(laterDay.freshDecisions).toBe(0);
    expect(laterDay.appliedIds).toEqual([id('1')]);
    const sameDay = await unstageCullDirect(asExpo(d), id('2'), AT + 100, true);
    expect(sameDay.freshDecisions).toBe(0);
    expect(sameDay.appliedIds).toEqual([id('2')]);
  });

  it('does NOT count a same-day redecision, and counts a stale sheet not at all', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 100);
    const sameDay = await applyRedecision(asExpo(d), id('1'), 'to_edit', AT + 200);
    expect(sameDay.freshDecisions).toBe(0);
    expect(sameDay.appliedIds).toEqual([id('1')]);
    // id('2') is still unreviewed: the guard refuses the verdict, and
    // the result must say so instead of crediting a write that did not
    // happen.
    const stale = await applyRedecision(asExpo(d), id('2'), 'keep', AT + 300);
    expect(stale.appliedIds).toEqual([]);
    expect(stale.freshDecisions).toBe(0);
  });
});

describe('applyReviewDecisions (decision 2)', () => {
  it('a keep writes done at swipe time and first-stamps reviewed_at', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    const row = stateOf(d, '1');
    expect(row.state).toBe('kept');
    expect(row.reviewed_at).toBe(AT + 100);
    expect(row.activity_at).toBe(AT + 100);
    // A re-decide keeps the FIRST review stamp (lifetime stats).
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 200);
    const after = stateOf(d, '1');
    expect(after.state).toBe('culled');
    expect(after.reviewed_at).toBe(AT + 100);
    expect(after.culled_at).toBe(AT + 200);
  });

  it('flagging an edit queues an action and leaves the verdict alone', async () => {
    // The whole point of v18: "to edit" stopped being a verdict, so the
    // keep and the pending edit are two independent facts.
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    await flagForEdit(d, '1', AT + 120);
    const row = stateOf(d, '1');
    expect(row.state).toBe('kept');
    expect(row.needs_edit).toBe(1);
    expect(row.to_edit_at).toBe(AT + 120);
    expect(row.reviewed_at).toBe(AT + 100);
  });

  it('an unreviewed photo can be flagged without gaining a verdict', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [], AT + 200, {
      needsEditChanges: [{ assetId: id('1'), needsEdit: true }],
    });
    expect(stateOf(d, '1')).toMatchObject({ state: 'unreviewed', needs_edit: 1 });
    // ...and keeping it later does not disturb the queued edit.
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 300);
    expect(stateOf(d, '1')).toMatchObject({ state: 'kept', needs_edit: 1 });
    // ...nor does taking the verdict back off. Layers are independent:
    // undoing a keep is not a statement about the pending edit.
    await applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 400);
    expect(stateOf(d, '1')).toMatchObject({ state: 'unreviewed', needs_edit: 1 });
  });

  it('clearing a verdict does NOT disturb a LIVE edit cycle', async () => {
    // The layers are independent, so clearing a verdict leaves the edit
    // queued — and wiping its detection baseline here would re-baseline
    // against the already-edited file, silently losing the auto-detection
    // the user is waiting on. The baseline belongs to the CYCLE.
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    await flagForEdit(d, '1', AT + 120);
    d.raw
      .prepare('UPDATE photos SET mod_time = ?, content_hash = ? WHERE asset_id = ?')
      .run(AT + 130, 'live-cycle-hash', id('1'));

    await applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 200);
    expect(stateOf(d, '1')).toMatchObject({
      state: 'unreviewed',
      needs_edit: 1,
      to_edit_at: AT + 120,
      mod_time: AT + 130,
      content_hash: 'live-cycle-hash',
    });

    // Staging then restoring a cull takes the same care.
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 300);
    await restoreCarriedCull(asExpo(d), id('1'), AT + 400);
    expect(stateOf(d, '1')).toMatchObject({
      state: 'unreviewed',
      mod_time: AT + 130,
      content_hash: 'live-cycle-hash',
    });

    // With NO edit queued, the reset still happens — that guarantee is
    // what stops a later re-flag reusing a dead cycle's evidence.
    await setNeedsEdit(asExpo(d), id('1'), false, AT + 500);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 550);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 600);
    expect(stateOf(d, '1')).toMatchObject({ mod_time: null, content_hash: null });
  });

  it('clearing a verdict resets the detection baseline and drops the edit', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    await flagForEdit(d, '1', AT + 120);
    d.raw.prepare('UPDATE photos SET content_hash = ? WHERE asset_id = ?').run('hash1', id('1'));
    await markEditDone(asExpo(d), id('1'), AT + 200);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 300);
    const row = stateOf(d, '1');
    expect(row.state).toBe('unreviewed');
    expect(row.needs_edit).toBe(0);
    expect(row.to_edit_at).toBeNull();
    expect(row.mod_time).toBeNull();
    expect(row.content_hash).toBeNull();
    // The completed edit stays on the record: it happened.
    expect(row.edit_completed_at).toBe(AT + 200);
  });

  it('records a duel with its group and favourite intents atomically', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    const gid = groupIdOf(d, '1');
    await applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 100, {
      duel: {
        groupId: String(gid),
        winnerId: id('1'),
        loserId: id('2'),
        keptBoth: false,
        at: AT + 100,
      },
      favouriteChanges: [{ assetId: id('1'), state: 'queued_apply', target: true }],
    });
    const duel = d.raw.prepare('SELECT * FROM duels').get() as Record<string, unknown>;
    // Pair-keyed (v22): the endpoints are the identity; no group column.
    expect(duel.winner_id).toBe(id('1'));
    expect(duel.loser_id).toBe(id('2'));
    expect(duel.kept_both).toBe(0);
    const fav = (await getFavouriteActionStates(asExpo(d), [id('1')])).get(id('1'));
    expect(fav).toEqual({ state: 'queued_apply', target: true });
    expect(stateOf(d, '2').state).toBe('culled');
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

describe('needs-edit cycle hardening (m0.7 carried over)', () => {
  it('re-flagging a completed edit re-queues it with a fresh detection baseline', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    await flagForEdit(d, '1', AT + 110);
    d.raw.prepare('UPDATE photos SET content_hash = ? WHERE asset_id = ?').run('hash1', id('1'));
    await markEditDone(asExpo(d), id('1'), AT + 200);
    await setNeedsEdit(asExpo(d), id('1'), true, AT + 300);
    const row = stateOf(d, '1');
    expect(row.state).toBe('kept'); // the verdict never moved
    expect(row.needs_edit).toBe(1);
    expect(row.to_edit_at).toBe(AT + 300);
    expect(row.mod_time).toBeNull();
    expect(row.content_hash).toBeNull();
  });

  it('cycle-guarded markEditDone refuses stale evidence from a superseded cycle', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    await flagForEdit(d, '1', AT + 100);
    await markEditDone(asExpo(d), id('1'), AT + 200);
    await setNeedsEdit(asExpo(d), id('1'), true, AT + 300); // fresh cycle
    expect(await markEditDone(asExpo(d), id('1'), AT + 400, AT + 100)).toBe(false);
    expect(stateOf(d, '1').needs_edit).toBe(1); // the fresh cycle survives
    expect(await markEditDone(asExpo(d), id('1'), AT + 500, AT + 300)).toBe(true);
  });
});

describe('ejectNotRelated ("not related" pairs, v22)', () => {
  const pairs = (d: TestDb): { ejected_id: string; partner_id: string }[] =>
    d.raw
      .prepare('SELECT ejected_id, partner_id FROM not_related ORDER BY ejected_id, partner_id')
      .all() as { ejected_id: string; partner_id: string }[];

  it('records pairs against the group, clears the assignment, dissolves the rump', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2']]);
    await ejectNotRelated(asExpo(d), [id('1')], AT + 100);
    expect(pairs(d)).toEqual([{ ejected_id: id('1'), partner_id: id('2') }]);
    const assignments = d.raw
      .prepare('SELECT photo_id, group_id FROM photo_group_assignments')
      .all() as { photo_id: string; group_id: number | null }[];
    expect(assignments).toHaveLength(3);
    // The ejected photo is a single; the one-member rump dissolved too —
    // but the PAIR, not a flag on the survivor, is what keeps them apart.
    expect(assignments.every((a) => a.group_id === null)).toBe(true);
    const groups = d.raw.prepare('SELECT COUNT(*) AS n FROM photo_groups').get() as { n: number };
    expect(groups.n).toBe(0);
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('ejecting from a 3-member group keeps the surviving pair grouped', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    await ejectNotRelated(asExpo(d), [id('1')], AT + 100);
    expect(pairs(d)).toEqual([
      { ejected_id: id('1'), partner_id: id('2') },
      { ejected_id: id('1'), partner_id: id('3') },
    ]);
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

  it('DISSOLVES pairs naming the newly-ejected photo as partner first (the A→B rule)', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    // Eject 1, then 2 — the design's double-ejection walk: 2's own
    // ejection revokes its standing as a proxy for the cluster, so
    // (1→2) dissolves and the two may reunite elsewhere, while 3 stays
    // protected from both.
    await ejectNotRelated(asExpo(d), [id('1')], AT + 100);
    await ejectNotRelated(asExpo(d), [id('2')], AT + 200);
    expect(pairs(d)).toEqual([
      { ejected_id: id('1'), partner_id: id('3') },
      { ejected_id: id('2'), partner_id: id('3') },
    ]);
  });

  it('returns the targeted-rescan anchors, undated flagged for direct fetch', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    d.raw.prepare('UPDATE photos SET day = NULL WHERE asset_id = ?').run(id('1'));
    const targets = await ejectNotRelated(asExpo(d), [id('1')], AT + 100);
    expect(targets).toEqual([{ assetId: id('1'), takenAtMs: AT - 3_600_000, undated: true }]);
  });

  it('clearNotRelated (un-eject) deletes only the photo OWN pairs and hands back its anchor', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2'], ['3']].filter((g) => g.length > 1) as string[][]);
    await ejectNotRelated(asExpo(d), [id('1')], AT + 100);
    // A pair naming 1 as PARTNER (someone else's judgment) must survive.
    d.raw
      .prepare('INSERT INTO not_related (ejected_id, partner_id, at) VALUES (?, ?, ?)')
      .run(id('3'), id('1'), AT + 101);
    const { clearNotRelated } = await import('./store');
    const result = await clearNotRelated(asExpo(d), id('1'));
    expect(result.cleared).toBe(1); // (1→2) gone
    expect(result.target).toEqual({ assetId: id('1'), takenAtMs: AT - 3_600_000, undated: false });
    const remaining = d.raw.prepare('SELECT ejected_id, partner_id FROM not_related').all() as {
      ejected_id: string;
      partner_id: string;
    }[];
    expect(remaining).toEqual([{ ejected_id: id('3'), partner_id: id('1') }]);
  });

  it('never pairs against a tombstoned member — the judgment is about visible photos', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    d.raw.prepare('UPDATE photos SET is_present = 0 WHERE asset_id = ?').run(id('3'));
    await ejectNotRelated(asExpo(d), [id('1')], AT + 100);
    expect(pairs(d)).toEqual([{ ejected_id: id('1'), partner_id: id('2') }]);
  });
});

describe('ejectNotRelated with an unreachable partner (plan §5)', () => {
  const SD = '0a91-e18d';
  const sdId = (rawId: string): string => `${SD}/${rawId}`;

  /** Cross-volume pair: primary/v1 grouped with sd/s1. */
  async function seedMixedPair(d: TestDb): Promise<number> {
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          upsert('v1'),
          {
            ...upsert('s1'),
            assetId: sdId('s1'),
            uri: `file:///storage/0A91-E18D/DCIM/s1.jpg`,
            volumeName: SD,
            rawId: 's1',
          },
        ],
        groups: [{ members: [id('v1'), sdId('s1')], timeAttached: [] }],
        singles: [],
      },
      AT,
    );
    const row = d.raw
      .prepare(`SELECT group_id FROM photo_group_assignments WHERE photo_id = ?`)
      .get(id('v1')) as { group_id: number };
    return row.group_id;
  }

  it('pairs record against the HIDDEN member too; its assignment defers (byte-for-byte)', async () => {
    const d = await fresh();
    const groupId = await seedMixedPair(d);
    await ejectNotRelated(asExpo(d), [id('v1')], AT + 100, groupId, ['external_primary']);
    // The judgment is about the group — unreachable members included
    // (vetted 2026-08-21): without the pair, the photo would regroup
    // with them on remount. The dissolution rule is the safety valve.
    const pair = d.raw.prepare('SELECT ejected_id, partner_id FROM not_related').get() as {
      ejected_id: string;
      partner_id: string;
    };
    expect(pair).toEqual({ ejected_id: id('v1'), partner_id: sdId('s1') });
    const ejected = d.raw
      .prepare('SELECT group_id FROM photo_group_assignments WHERE photo_id = ?')
      .get(id('v1')) as { group_id: number | null };
    expect(ejected.group_id).toBeNull();
    // The unseen partner keeps every byte (plan §5): the rump dissolve
    // defers while its card is out — remount re-windows it normally.
    const survivor = d.raw
      .prepare('SELECT group_id FROM photo_group_assignments WHERE photo_id = ?')
      .get(sdId('s1')) as { group_id: number | null };
    expect(survivor.group_id).toBe(groupId);
  });

  it('a REACHABLE partner rump dissolves to a plain single', async () => {
    const d = await fresh();
    const groupId = await seedMixedPair(d);
    await ejectNotRelated(asExpo(d), [id('v1')], AT + 100, groupId, ['external_primary', SD]);
    const survivor = d.raw
      .prepare('SELECT group_id FROM photo_group_assignments WHERE photo_id = ?')
      .get(sdId('s1')) as { group_id: number | null };
    expect(survivor.group_id).toBeNull();
  });
});

describe('reachability scopes live rows, never tombstoned facts (final cycle O3)', () => {
  const SD = '0a91-e18d';

  /** One primary live photo + one SD row per requested state, all on the
   * seed day. Tombstones are shaped exactly as their writers leave them:
   * trashed = removal cleanup, keep = Forget-keep. */
  async function seedDay(d: TestDb): Promise<void> {
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          upsert('live'),
          {
            ...upsert('sdTrashed'),
            assetId: `${SD}/sdTrashed`,
            uri: 'file:///storage/0A91-E18D/DCIM/t.jpg',
            volumeName: SD,
            rawId: 'sdTrashed',
          },
          {
            ...upsert('sdKeep'),
            assetId: `${SD}/sdKeep`,
            uri: 'file:///storage/0A91-E18D/DCIM/k.jpg',
            volumeName: SD,
            rawId: 'sdKeep',
          },
        ],
        groups: [],
        singles: [id('live'), `${SD}/sdTrashed`, `${SD}/sdKeep`],
      },
      AT,
    );
    // A verified trash tombstone (mechanism 1: state = trashed, absent).
    d.raw
      .prepare(
        `UPDATE photos SET state = 'trashed', is_present = 0 WHERE asset_id = '${SD}/sdTrashed'`,
      )
      .run();
    // A Forget-keep tombstone (mechanism 2: ordinary verdict, absent).
    d.raw
      .prepare(`UPDATE photos SET state = 'kept', is_present = 0 WHERE asset_id = '${SD}/sdKeep'`)
      .run();
  }

  it('day summaries keep counting a trashed fact after its volume unmounts', async () => {
    const d = await fresh();
    await seedDay(d);
    const map = await getDaySummariesForDays(asExpo(d), ['2026-07-20'], null, ['external_primary']);
    const day = map.get('2026-07-20')!;
    // live (reachable) + the trashed fact; the keep tombstone is not a
    // day population member anywhere.
    expect(day.tracked).toBe(2);
    expect(day.trashed).toBe(1);
    expect(day.done).toBe(1);
  });

  it('state-count chips keep the trashed figure after its volume unmounts', async () => {
    const d = await fresh();
    await seedDay(d);
    const counts = await getStateCountsInScope(asExpo(d), { day: '2026-07-20' }, null, [
      'external_primary',
    ]);
    expect(counts.trashed).toBe(1);
    expect(counts.unreviewed).toBe(1);
    expect(counts.tracked).toBe(2);
    expect(counts.rescued).toBe(0);
  });
});

describe('day summaries count D15-rescued rows for the union total (final cycle P4)', () => {
  it('a dated row wearing the rescue marker reports in `rescued`; trashed and unmarked rows do not', async () => {
    const d = await fresh();
    await seed(d, ['plain', 'rescued', 'rescuedTrashed']);
    d.raw
      .prepare('UPDATE photos SET exif_checked_mod_time = mod_time WHERE asset_id IN (?, ?)')
      .run(id('rescued'), id('rescuedTrashed'));
    d.raw
      .prepare("UPDATE photos SET state = 'trashed', is_present = 0 WHERE asset_id = ?")
      .run(id('rescuedTrashed'));
    const map = await getDaySummariesForDays(asExpo(d), ['2026-07-20']);
    const day = map.get('2026-07-20')!;
    expect(day.tracked).toBe(3);
    expect(day.rescued).toBe(1); // alive marked row only
    // The day page's chips carry the same figure (the analyzing line
    // subtracts it from the ingested-dated population, grilling Q8).
    const counts = await getStateCountsInScope(asExpo(d), { day: '2026-07-20' }, null);
    expect(counts.rescued).toBe(1);
  });
});

describe('rescue-marker provenance across re-ingestion (final cycle Q3)', () => {
  const marker = (d: TestDb): number | null =>
    (
      d.raw
        .prepare('SELECT exif_checked_mod_time AS m FROM photos WHERE asset_id = ?')
        .get(id('r1')) as { m: number | null }
    ).m;

  async function upsertR1(d: TestDb, fields: Partial<ContinuousPhotoUpsert>): Promise<void> {
    await writeContinuousGroups(
      asExpo(d),
      { photos: [{ ...upsert('r1'), ...fields }], groups: [], singles: [id('r1')] },
      AT,
    );
  }

  it('a MediaStore-dated re-ingestion clears the marker (Home union stays exact)', async () => {
    const d = await fresh();
    await upsertR1(d, { exifCheckedModTime: AT - 3_600_000 });
    expect(marker(d)).toBe(AT - 3_600_000);
    // MediaStore later supplies DATE_TAKEN: the row pages DATED, no
    // rescue ran, so the upsert carries a day and no marker.
    await upsertR1(d, { exifCheckedModTime: undefined });
    expect(marker(d)).toBeNull();
  });

  it('an undated pass without a completed read keeps the stored proof', async () => {
    const d = await fresh();
    await upsertR1(d, { exifCheckedModTime: AT - 3_600_000 });
    // Failed read / module absent: undated, no marker → proof survives.
    await upsertR1(d, { exifCheckedModTime: undefined, day: null, takenAt: AT - 3_600_000 });
    expect(marker(d)).toBe(AT - 3_600_000);
  });
});

describe('un-staging paths (decision 2)', () => {
  it('unstageCullDirect lands on kept, and a queued edit rides along', async () => {
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
    await setNeedsEdit(asExpo(d), id('2'), true, AT + 150);
    await unstageCullDirect(asExpo(d), id('1'), AT + 200, true);
    await unstageCullDirect(asExpo(d), id('2'), AT + 200, true);
    expect(stateOf(d, '1')).toMatchObject({ state: 'kept', needs_edit: 0 });
    expect(stateOf(d, '2')).toMatchObject({ state: 'kept', needs_edit: 1 });
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

// (The favourite batch commits moved to db/actions.real.test.ts with the
// unified action model — v18. Testing them here would test a removed interface.)

describe('activity_at transitions', () => {
  it('every decision write moves activity_at', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 500);
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
        [id('2'), 'kept'],
        [id('3'), 'kept'],
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
        [id('1'), 'kept'],
        [id('2'), 'culled'],
        [id('3'), 'kept'],
      ],
      AT + 1,
    );
    expect(await listReviewGroups(asExpo(d), 10)).toEqual([]);
    const group = await getReviewGroup(asExpo(d), gid);
    expect(group?.groupId).toBe(gid);
    expect(group?.members.map((m) => m.state).sort()).toEqual(['culled', 'kept', 'kept']);
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
        [id('1'), 'kept'],
        [id('2'), 'kept'],
      ],
      AT + 1,
    );
    const day18 = await listGroupsForDay(asExpo(d), '2026-07-18');
    expect(day18).toHaveLength(2);
    // Newest group first: the 05:00 pair before the completed 01:00 pair —
    // and members newest-first inside it (m0.8.2, Tristan's ordering).
    expect(day18[0].members.map((m) => m.asset_id)).toEqual([id('4'), id('3')]);
    expect(day18[1].members.every((m) => m.state === 'kept')).toBe(true);
    expect(await listGroupsForDay(asExpo(d), '2026-07-19')).toHaveLength(1);
    expect(await listGroupsForDay(asExpo(d), '2026-07-20')).toHaveLength(0);
  });

  it("listSinglesForDeck returns ONLY that day's singles, decided photos INCLUDED, chronological", async () => {
    const d = await fresh();
    await seedDays(
      d,
      [
        P('s1', '2026-07-18', 1),
        P('s2', '2026-07-18', 5),
        P('s3', '2026-07-18', 9),
        P('g1', '2026-07-18', 2),
        P('g2', '2026-07-18', 2),
        P('s9', '2026-07-19', 3),
      ],
      [['g1', 'g2']],
    );
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('s1'), 'culled'],
        [id('s2'), 'kept'],
      ],
      AT + 1,
    );
    const day18 = await listSinglesForDeck(asExpo(d), '2026-07-18');
    // NEWEST first (the singles decks' page order — Tristan's call); the
    // KEPT single stays in place badged (m0.8.2 group-deck parity) and
    // the staged cull rides along; neither the grouped pair nor the
    // 19th's single are here.
    expect(day18.map((m) => m.asset_id)).toEqual([id('s3'), id('s2'), id('s1')]);
    expect(day18.find((m) => m.asset_id === id('s1'))?.state).toBe('culled');
    expect(day18.find((m) => m.asset_id === id('s2'))?.state).toBe('kept');
    expect(day18.every((m) => m.day === '2026-07-18')).toBe(true);
    // A run's taken_at range narrows the same read (timeline run decks).
    // Bounds use P's own taken_at formula (hours 1..5 of the seeded day).
    const hourAt = (hour: number) => AT - 10 * 86_400_000 + hour * 3_600_000;
    const run = await listSinglesForDeck(asExpo(d), '2026-07-18', null, {
      from: hourAt(1),
      to: hourAt(5),
    });
    expect(run.map((m) => m.asset_id)).toEqual([id('s2'), id('s1')]);
    expect((await listSinglesForDeck(asExpo(d), '2026-07-19')).map((m) => m.asset_id)).toEqual([
      id('s9'),
    ]);
    expect(await listSinglesForDeck(asExpo(d), '2026-07-20')).toEqual([]);
  });

  it('a WHOLE-DAY deck read returns every single — no hidden page cap on a >500-photo day', async () => {
    // "Review this day" / keepAllSingles promise the entire day; the old
    // default LIMIT 500 silently truncated a bigger day. Run-range reads
    // are uncapped too (codex r10): the cull-wall continuation means a
    // legitimate run can exceed 500 rows, and a capped range read would
    // cut exactly the pending tail the run exists to reach.
    const d = await fresh();
    const base = AT - 10 * 86_400_000;
    await seedDays(
      d,
      Array.from({ length: 520 }, (_, i) => ({
        rawId: `b${i}`,
        day: '2026-07-18',
        takenAt: base + i * 1000,
      })),
    );
    const wholeDay = await listSinglesForDeck(asExpo(d), '2026-07-18');
    expect(wholeDay).toHaveLength(520);
    // Still newest-first, first to last.
    expect(wholeDay[0].asset_id).toBe(id('b519'));
    expect(wholeDay[519].asset_id).toBe(id('b0'));
    const run = await listSinglesForDeck(asExpo(d), '2026-07-18', null, {
      from: base,
      to: base + 519 * 1000,
    });
    expect(run).toHaveLength(520); // the range bounds it; no hidden cap
  });

  it('getUnreviewedDayRows counts pending per day, newest first, and drops finished days', async () => {
    const d = await fresh();
    await seedDays(d, [
      P('1', '2026-07-17', 1),
      P('2', '2026-07-17', 2),
      P('3', '2026-07-18', 1),
      P('4', '2026-07-19', 1),
    ]);
    await applyReviewDecisions(asExpo(d), [[id('4'), 'kept']], AT + 1);
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
  it('joins state, group membership, time-attached and ejection facts', async () => {
    const d = await fresh();
    await seedDays(
      d,
      [P0('1'), P0('2'), P0('3'), P0('4'), P0('5')],
      [
        ['1', '2', '3'],
        ['4', '5'],
      ],
      ['3'],
    );
    const gid = groupIdOf(d, '1');
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 1);
    await ejectNotRelated(asExpo(d), [id('4')], AT + 2);

    const kept = await getPhotoFacts(asExpo(d), id('1'));
    expect(kept).toMatchObject({
      state: 'kept',
      group_id: gid,
      time_attached: 0,
      not_related_count: 0,
    });
    expect(kept?.reviewed_at).toBe(AT + 1);

    const attached = await getPhotoFacts(asExpo(d), id('3'));
    expect(attached).toMatchObject({ time_attached: 1, group_id: gid });

    // The ejected photo's OWN pairs count; being someone else's partner
    // does not (5 shows 0 — the judgment belongs to 4).
    const ejected = await getPhotoFacts(asExpo(d), id('4'));
    expect(ejected).toMatchObject({ group_id: null, not_related_count: 1 });
    const partner = await getPhotoFacts(asExpo(d), id('5'));
    expect(partner).toMatchObject({ not_related_count: 0 });

    expect(await getPhotoFacts(asExpo(d), id('nope'))).toBeNull();
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('projects the favourite through its lifecycle — queued, carried, removed', async () => {
    // The viewer's facts must carry a VERIFIED favourite after the queue
    // empties (codex r2 G13), and the projection is directional: a
    // verified removal is no favourite at all.
    const d = await fresh();
    await seedDays(d, [P0('1')]);
    const { queueAction, resolveActions } = await import('./actions');
    await queueAction(asExpo(d), id('1'), 'favourite', AT + 10, '1');
    let facts = await getPhotoFacts(asExpo(d), id('1'));
    expect(facts).toMatchObject({ favourite_queued: 1, favourite_applied: 0 });
    await resolveActions(asExpo(d), [id('1')], 'favourite', AT + 20, '1');
    facts = await getPhotoFacts(asExpo(d), id('1'));
    expect(facts).toMatchObject({ favourite_queued: null, favourite_applied: 1 });
    // Verified un-favourite: resolved toward false — no heart anywhere.
    await queueAction(asExpo(d), id('1'), 'favourite', AT + 30, '0');
    await resolveActions(asExpo(d), [id('1')], 'favourite', AT + 40, '0');
    facts = await getPhotoFacts(asExpo(d), id('1'));
    expect(facts).toMatchObject({ favourite_queued: null, favourite_applied: 0 });
  });

  it('projects organize targets through queue, apply and re-queue (codex r7)', async () => {
    // The viewer shows the FULL album path, so the facts must carry the
    // raw encoded target for BOTH halves: the pending intent and the
    // last applied move.
    const d = await fresh();
    await seedDays(d, [P0('1')]);
    const { queueOrganize, setOrganizeTargets, commitOrganizeOutcomes } =
      await import('./organizeStore');
    // Target-less queue row (m0.8.2 F6): queued, no paths yet.
    expect(await queueOrganize(asExpo(d), id('1'), AT + 10)).toBeNull();
    let facts = await getPhotoFacts(asExpo(d), id('1'));
    expect(facts).toMatchObject({
      organize_queued: 1,
      organize_applied_at: null,
      organize_target: null,
      organize_applied_target: null,
    });
    // Album assigned: the encoded volume+path projects raw.
    expect(
      await setOrganizeTargets(
        asExpo(d),
        [id('1')],
        { volumeName: 'external_primary', relativePath: 'Pictures/Trips/' },
        AT + 20,
      ),
    ).toBeNull();
    facts = await getPhotoFacts(asExpo(d), id('1'));
    expect(facts?.organize_target).toBe('external_primary\nPictures/Trips/');
    // Applied: resolved_at lands and applied_target carries the album.
    await commitOrganizeOutcomes(
      asExpo(d),
      [
        {
          photoId: id('1'),
          status: 'moved',
          message: 'ok',
          volumeName: 'external_primary',
          relativePath: 'Pictures/Trips/',
        },
      ],
      AT + 30,
    );
    facts = await getPhotoFacts(asExpo(d), id('1'));
    expect(facts).toMatchObject({
      organize_queued: 0,
      organize_applied_at: AT + 30,
      organize_applied_target: 'external_primary\nPictures/Trips/',
    });
    // Superseded (applied + re-queued): both targets project — the
    // requeue prefill keeps the applied album as the pending one.
    expect(await queueOrganize(asExpo(d), id('1'), AT + 40)).toBeNull();
    facts = await getPhotoFacts(asExpo(d), id('1'));
    expect(facts).toMatchObject({
      organize_queued: 1,
      organize_applied_at: AT + 30,
      organize_target: 'external_primary\nPictures/Trips/',
      organize_applied_target: 'external_primary\nPictures/Trips/',
    });
  });

  it('projects the carried share once a pass resolved it (codex r7)', async () => {
    // The panel's carried line ("Was shared from the share queue.")
    // reads this — mirroring edit_completed_at for the edit pair.
    const d = await fresh();
    await seedDays(d, [P0('1')]);
    const {
      addToShareQueue,
      createShareBatch,
      markShareBatchShared,
      promoteShareBatch,
      removeFromShareQueue,
    } = await import('./shareStore');
    expect(await addToShareQueue(asExpo(d), id('1'), AT + 10)).toBe(true);
    let facts = await getPhotoFacts(asExpo(d), id('1'));
    expect(facts?.share_carried).toBe(0); // queued but never sent
    const batchId = await createShareBatch(asExpo(d), [id('1')], AT + 20);
    await promoteShareBatch(asExpo(d), batchId, AT + 20);
    await markShareBatchShared(asExpo(d), batchId, 'com.test/app', AT + 20);
    facts = await getPhotoFacts(asExpo(d), id('1'));
    expect(facts?.share_carried).toBe(1); // resolved while still queued
    await removeFromShareQueue(asExpo(d), id('1'), AT + 30);
    facts = await getPhotoFacts(asExpo(d), id('1'));
    expect(facts?.share_carried).toBe(1); // leaveQueue demotes, never forgets
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
        [id('3'), 'kept'],
        [id('4'), 'culled'],
      ],
      AT + 1,
    );
    const scope = { startMs: 0, endMs: AT * 2 };
    await setNeedsEdit(asExpo(d), id('3'), true, AT + 2);
    const all = await getGridPhotosByFilter(asExpo(d), scope, null, 'all', 10, 0);
    // Grouping rides along as an annotation on every row, whatever the
    // verdict — it is not a filter of its own.
    expect(
      all
        .filter((r) => Number(r.grouped) === 1)
        .map((r) => r.asset_id)
        .sort(),
    ).toEqual([id('1'), id('2')]);
    // Layer 2 filters carry the `act:` prefix so a verdict and an action
    // can never be confused for one another.
    expect(
      (await getGridPhotosByFilter(asExpo(d), scope, null, 'act:edit', 10, 0))[0].asset_id,
    ).toBe(id('3'));
    expect((await getGridPhotosByFilter(asExpo(d), scope, null, 'staged', 10, 0))[0].asset_id).toBe(
      id('4'),
    );
    // The flagged photo is still simply KEPT — the edit is a second layer.
    expect(
      (await getGridPhotosByFilter(asExpo(d), scope, null, 'kept', 10, 0)).map((r) => r.asset_id),
    ).toEqual([id('3')]);
    expect(await getGridPhotosByFilter(asExpo(d), scope, null, 'unreviewed', 10, 0)).toHaveLength(
      2,
    );
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
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 1);
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
  const CAMERA = [{ volume: 'external_primary', dir: 'DCIM/Camera' }];

  it('groups, singles feed, counts and day groups all honor the roots filter', async () => {
    const d = await fresh();
    await seedSourced(d);
    const groups = await listReviewGroups(asExpo(d), 10, CAMERA);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.asset_id).sort()).toEqual([id('c1'), id('c2')]);
    expect(await countReviewQueue(asExpo(d), CAMERA)).toEqual({
      grouped: 2,
      singles: 0,
      groups: 1,
    });
    expect(await listGroupsForDay(asExpo(d), '2026-07-20', CAMERA)).toHaveLength(1);
    // Singles: ejecting one member of each pair dissolves it (both become
    // singles) — the feed must list only the Camera two.
    await ejectNotRelated(asExpo(d), [id('c1'), id('w1')], AT + 100);
    const feed = await listSinglesFeed(asExpo(d), 10, CAMERA);
    expect(feed.map((m) => m.asset_id).sort()).toEqual([id('c1'), id('c2')]);
  });

  it('listGroupsForDay flags each member with in_source (codex r7)', async () => {
    // A MIXED group queues whole via its one in-source member; the
    // DayProgress CTA needs the per-member flag to keep an out-of-source
    // unreviewed member from qualifying the group as this day's work.
    const d = await fresh();
    const photo = (rawId: string, folder: string) => ({
      ...upsert(rawId),
      uri: `file:///storage/emulated/0/${folder}/${rawId}.jpg`,
    });
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [photo('m1', 'DCIM/Camera'), photo('m2', 'WhatsApp/Media')],
        groups: [{ members: [id('m1'), id('m2')], timeAttached: [] }],
        singles: [],
      },
      AT,
    );
    const [mixed] = await listGroupsForDay(asExpo(d), '2026-07-20', CAMERA);
    expect(mixed.members.find((m) => m.asset_id === id('m1'))?.in_source).toBe(1);
    expect(mixed.members.find((m) => m.asset_id === id('m2'))?.in_source).toBe(0);
    // Unfiltered (roots null): every member is in source by definition.
    const [unfiltered] = await listGroupsForDay(asExpo(d), '2026-07-20');
    expect(unfiltered.members.map((m) => m.in_source)).toEqual([1, 1]);
  });
});

describe('staged-cull reads honor the source axis (m0.8.7, F18 / gap 10)', () => {
  const CAMERA = [{ volume: 'external_primary', dir: 'DCIM/Camera' }];

  async function seedCulls(d: TestDb): Promise<void> {
    const photo = (rawId: string, folder: string) => ({
      ...upsert(rawId),
      uri: `file:///storage/emulated/0/${folder}/${rawId}.jpg`,
      sizeBytes: 1_000,
    });
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [photo('c1', 'DCIM/Camera'), photo('w1', 'WhatsApp/Media')],
        groups: [],
        singles: [id('c1'), id('w1')],
      },
      AT,
    );
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('c1'), 'culled'],
        [id('w1'), 'culled'],
      ],
      AT + 1,
    );
  }

  it('count, list and bytes all describe the same scoped set', async () => {
    const d = await fresh();
    await seedCulls(d);
    expect(await countStagedCulls(asExpo(d), null, CAMERA)).toBe(1);
    expect(
      (await getStagedCulls(asExpo(d), undefined, null, CAMERA)).map((r) => r.asset_id),
    ).toEqual([id('c1')]);
    expect((await getStagedCullBytes(asExpo(d), null, CAMERA)).scanned).toBe(1_000);
    // Null roots = All folders: both count.
    expect(await countStagedCulls(asExpo(d))).toBe(2);
    expect((await getStagedCullBytes(asExpo(d))).scanned).toBe(2_000);
  });

  it('getToEditPhotos honors the roots filter too', async () => {
    const d = await fresh();
    await seedCulls(d);
    // Un-stage both so they are live work, then queue edits.
    await unstageCullDirect(asExpo(d), id('c1'), AT + 10, true);
    await unstageCullDirect(asExpo(d), id('w1'), AT + 10, true);
    await setNeedsEdit(asExpo(d), id('c1'), true, AT + 20);
    await setNeedsEdit(asExpo(d), id('w1'), true, AT + 20);
    expect((await getToEditPhotos(asExpo(d), null, CAMERA)).map((r) => r.asset_id)).toEqual([
      id('c1'),
    ]);
    expect(await getToEditPhotos(asExpo(d))).toHaveLength(2);
  });
});

describe('countStagedCullsWithUnsentIntents (F21 point 3)', () => {
  it('counts photos whose queued share/edit rows would die with the confirm', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3']);
    const { queueAction, resolveActions } = await import('./actions');
    // 1: unsent share + unsent edit. 2: share SENT (resolved) then still
    // queued — not "unsent". 3: no intents.
    await queueAction(asExpo(d), id('1'), 'share', AT);
    await queueAction(asExpo(d), id('1'), 'edit', AT);
    await queueAction(asExpo(d), id('2'), 'share', AT);
    await resolveActions(asExpo(d), [id('2')], 'share', AT + 1);
    await queueAction(asExpo(d), id('2'), 'share', AT + 2); // re-queued, has proof
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'culled'],
        [id('2'), 'culled'],
        [id('3'), 'culled'],
      ],
      AT + 10,
    );
    const { countStagedCullsWithUnsentIntents } = await import('./store');
    expect(await countStagedCullsWithUnsentIntents(asExpo(d))).toEqual({ share: 1, edit: 1 });
  });
});

describe('atomic compare verdicts', () => {
  it('duel and loser verdict land in one write', async () => {
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
    });
    expect(stateOf(d, '2').state).toBe('culled');
    expect(d.raw.prepare('SELECT COUNT(*) AS n FROM duels').get()).toEqual({ n: 1 });
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

// -------------------------------------------- final-review round 2

describe('getDayReviewSummary (decision-day accounting)', () => {
  it('counts photos DECIDED that day whatever their capture day', async () => {
    const d = await fresh();
    // Captured on 2026-07-20 (seed default); decided "today" = 2026-07-25.
    await seed(d, ['1', '2', '3', '4']);
    const decidedAt = Date.UTC(2026, 6, 25, 12, 0, 0);
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'kept'],
        [id('2'), 'culled'],
        [id('3'), 'kept'],
      ],
      decidedAt,
    );
    const day = new Date(decidedAt).toISOString().slice(0, 10);
    const summary = await getDayReviewSummary(asExpo(d), day);
    expect(summary).toMatchObject({ reviewed: 3, kept: 2, staged: 1, trashed: 0 });
    expect(await getDayReviewSummary(asExpo(d), '2026-07-20')).toMatchObject({ reviewed: 0 });
  });
});

describe('corpus stats vs MediaStore denominator', () => {
  it('trashed rows (gone from MediaStore) leave the numerator', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 1);
    d.raw
      .prepare("UPDATE photos SET state = 'trashed', is_present = 0 WHERE asset_id = ?")
      .run(id('2'));
    expect((await getCorpusStats(asExpo(d))).reviewed).toBe(1);
  });
});

// -------------------------------------------- final-review round 3

describe('ejection records the judgment as pairs, not survivor flags (v22)', () => {
  it('the pair keeps both photos apart; the other member regroups freely', async () => {
    const d = await fresh();
    await seed(
      d,
      ['1', '2', '3', '4', '5'],
      [
        ['1', '2'],
        ['3', '4', '5'],
      ],
    );
    await ejectNotRelated(asExpo(d), [id('1')], AT + 100);
    await ejectNotRelated(asExpo(d), [id('3')], AT + 101);
    const rows = d.raw.prepare('SELECT photo_id, group_id FROM photo_group_assignments').all() as {
      photo_id: string;
      group_id: number | null;
    }[];
    const byId = new Map(rows.map((r) => [r.photo_id, r]));
    // The two-photo group dissolves whole; the pair (1→2) is the durable
    // judgment — no flag lands on the survivor.
    expect(byId.get(id('1'))?.group_id).toBeNull();
    expect(byId.get(id('2'))?.group_id).toBeNull();
    // The trio: survivors keep their (now pair) group.
    expect(byId.get(id('3'))?.group_id).toBeNull();
    expect(byId.get(id('4'))?.group_id).not.toBeNull();
    expect(byId.get(id('5'))?.group_id).toBe(byId.get(id('4'))?.group_id);
    const pairs = d.raw
      .prepare('SELECT ejected_id, partner_id FROM not_related ORDER BY ejected_id, partner_id')
      .all();
    expect(pairs).toEqual([
      { ejected_id: id('1'), partner_id: id('2') },
      { ejected_id: id('3'), partner_id: id('4') },
      { ejected_id: id('3'), partner_id: id('5') },
    ]);
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
        [id('c1'), 'kept'],
        [id('w1'), 'kept'],
      ],
      AT + 1,
    );
    expect(
      await getCorpusStats(asExpo(d), [{ volume: 'external_primary', dir: 'DCIM/Camera' }]),
    ).toEqual({ reviewed: 1 });
    expect(await getCorpusStats(asExpo(d))).toEqual({ reviewed: 2 });
  });
});

// -------------------------------------------- final-review round 4

describe('duels never pin membership — groups re-form freely (v22)', () => {
  it('a duel-carrying group is freely rewritten and the duel count never moves', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    const gid = groupIdOf(d, '1');
    // A verdict-free triage duel used to metadata-freeze the group.
    await applyReviewDecisions(asExpo(d), [], AT + 1, {
      duel: {
        groupId: String(gid),
        winnerId: id('1'),
        loserId: id('2'),
        keptBoth: true,
        at: AT + 1,
      },
    });
    // The next window computes a different split — it LANDS (grouping is
    // presentation), and the append-only duel row is untouched by it.
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: ['1', '2', '3'].map((r) => upsert(r)),
        groups: [{ members: [id('1'), id('2')], timeAttached: [] }],
        singles: [id('3')],
      },
      AT + 10,
    );
    expect(groupIdOf(d, '1')).toBe(groupIdOf(d, '2'));
    expect(groupIdOf(d, '1')).not.toBe(gid);
    expect(
      d.raw.prepare('SELECT group_id FROM photo_group_assignments WHERE photo_id = ?').get(id('3')),
    ).toEqual({ group_id: null });
    expect(d.raw.prepare('SELECT COUNT(*) AS n FROM duels').get()).toEqual({ n: 1 });
  });
});

describe('clearing a verdict resets the full edit-cycle baseline', () => {
  it('culled → unreviewed clears to_edit_at, mod_time and content_hash', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
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
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
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
    // The present survivor is a plain single again.
    const row = d.raw
      .prepare('SELECT group_id FROM photo_group_assignments WHERE photo_id = ?')
      .get(id('2')) as { group_id: number | null };
    expect(row).toMatchObject({ group_id: null });
    const feed = await listSinglesFeed(asExpo(d), 10);
    expect(feed.map((m) => m.asset_id)).toEqual([id('2')]);
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

// -------------------------------------------- final-review round 5

describe('applyGroupingSettingChange is a plain setting write (v22)', () => {
  it('writes or deletes the key and touches no assignment', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    const gid = groupIdOf(d, '1');
    const { applyGroupingSettingChange } = await import('./store');
    await applyGroupingSettingChange(asExpo(d), 'grouping_strictness', 'strict');
    expect(
      d.raw.prepare("SELECT value FROM settings WHERE key = 'grouping_strictness'").get(),
    ).toEqual({ value: 'strict' });
    // No reset rides the write any more — the forced rescan the caller
    // requests is what re-forms groups under the new setting.
    expect(groupIdOf(d, '1')).toBe(gid);
    await applyGroupingSettingChange(asExpo(d), 'grouping_strictness', null);
    expect(
      d.raw.prepare("SELECT value FROM settings WHERE key = 'grouping_strictness'").get(),
    ).toBeUndefined();
  });
});

// -------------------------------------------- final-review round 6

describe('applyRedecision (state-aware change of mind)', () => {
  it('Keep on a staged cull rescues it WITHOUT cancelling its edit', async () => {
    // culled -> kept must mean one thing whichever button gets you
    // there: unstageCullDirect has always carried the edit across, so
    // the re-decide sheet does too (m0.8.2 — this used to abandon it).
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 100);
    await flagForEdit(d, '1', AT + 150);
    await applyRedecision(asExpo(d), id('1'), 'keep', AT + 200);
    expect(stateOf(d, '1')).toMatchObject({
      state: 'kept',
      needs_edit: 1,
      to_edit_at: AT + 150,
    });

    // ...and the other route to the same transition still agrees.
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 300);
    await unstageCullDirect(asExpo(d), id('1'), AT + 400, true);
    expect(stateOf(d, '1')).toMatchObject({ state: 'kept', needs_edit: 1 });
  });

  it('Keep on a flagged staged cull lands on done, resolving its copy match', async () => {
    const d = await fresh();
    await seed(d, ['1', '9']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 200);
    d.raw
      .prepare(
        `INSERT INTO edit_copy_matches (original_id, copy_id, detected_at, state)
         VALUES (?, ?, ?, 'pending')`,
      )
      .run(id('1'), id('9'), AT + 250);
    await flagForEdit(d, '1', AT + 260);
    await applyRedecision(asExpo(d), id('1'), 'keep', AT + 300);
    expect(stateOf(d, '1')).toMatchObject({ state: 'kept', needs_edit: 1 });
    const match = d.raw
      .prepare('SELECT state FROM edit_copy_matches WHERE original_id = ?')
      .get(id('1')) as { state: string };
    expect(match.state).toBe('resolved'); // an explicit keep answers the prompt
  });

  it('To edit on a kept photo starts a FRESH cycle, never reusing stale evidence', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    await flagForEdit(d, '1', AT + 110);
    d.raw
      .prepare('UPDATE photos SET mod_time = 123, content_hash = ? WHERE asset_id = ?')
      .run('stale', id('1'));
    await markEditDone(asExpo(d), id('1'), AT + 200);
    await applyRedecision(asExpo(d), id('1'), 'to_edit', AT + 300);
    const row = stateOf(d, '1');
    expect(row).toMatchObject({
      state: 'kept',
      needs_edit: 1,
      to_edit_at: AT + 300,
      mod_time: null,
      content_hash: null,
    });
  });

  it('re-queuing an edit that is ALREADY queued restarts its cycle', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    await flagForEdit(d, '1', AT + 100);
    await applyRedecision(asExpo(d), id('1'), 'to_edit', AT + 200);
    // Deliberately NOT a no-op: an explicit "to edit" is the user saying
    // the edit has not happened yet, so detection must start from now
    // rather than from evidence gathered for the earlier attempt.
    expect(stateOf(d, '1')).toMatchObject({ to_edit_at: AT + 200, mod_time: null });
  });

  it('Keep preserves a LIVE edit cycle’s detection baseline', async () => {
    // The keep carries the queued edit across — and the baseline is that
    // cycle's detection evidence. Wiping it here re-baselined against
    // the already-edited file, so a completed edit was never detected
    // (the same guard applyReviewDecisions carries; unstageCullDirect
    // never touched the baseline).
    const d = await fresh();
    await seed(d, ['1']);
    await flagForEdit(d, '1', AT + 100);
    d.raw
      .prepare('UPDATE photos SET mod_time = 123, content_hash = ? WHERE asset_id = ?')
      .run('banked', id('1'));
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 200);
    await applyRedecision(asExpo(d), id('1'), 'keep', AT + 300);
    expect(stateOf(d, '1')).toMatchObject({
      state: 'kept',
      needs_edit: 1,
      mod_time: 123,
      content_hash: 'banked',
    });
  });

  it('a STALE restore or un-stage is a complete no-op — no copy match resolves', async () => {
    // Photo 1 is unreviewed (never culled): both culled→ transitions
    // match no row, so the pending edited-copy prompt must survive —
    // consuming it for a decision that did not happen is the bug
    // applyRedecision's guard pins, here on its two sibling paths.
    const d = await fresh();
    await seed(d, ['1', '9']);
    d.raw
      .prepare(
        `INSERT INTO edit_copy_matches (original_id, copy_id, detected_at, state)
         VALUES (?, ?, ?, 'pending')`,
      )
      .run(id('1'), id('9'), AT + 10);
    await restoreCarriedCull(asExpo(d), id('1'), AT + 100);
    await unstageCullDirect(asExpo(d), id('1'), AT + 200, true);
    const match = d.raw
      .prepare('SELECT state FROM edit_copy_matches WHERE original_id = ?')
      .get(id('1')) as { state: string };
    expect(match.state).toBe('pending');
    expect(stateOf(d, '1').state).toBe('unreviewed');
  });

  it('a full page of staged culls does not hide older pending singles', async () => {
    // The feed keeps decided singles in place, so the newest `limit`
    // singles can all be staged culls — without the unreviewed
    // continuation the timeline holds no pending unit while the counts
    // say otherwise, and every continue door dead-ends (codex r9).
    const d = await fresh();
    await seed(d, ['p1', 'p2', 'w1', 'w2', 'w3']);
    d.raw
      .prepare(
        `UPDATE photos SET state = 'culled', reviewed_at = 1, decided_at = 1, culled_at = 1
          WHERE asset_id IN (?, ?, ?)`,
      )
      .run(id('w1'), id('w2'), id('w3'));
    // Wall newest, pending oldest.
    d.raw.prepare('UPDATE photos SET taken_at = 900 WHERE asset_id = ?').run(id('w1'));
    d.raw.prepare('UPDATE photos SET taken_at = 800 WHERE asset_id = ?').run(id('w2'));
    d.raw.prepare('UPDATE photos SET taken_at = 700 WHERE asset_id = ?').run(id('w3'));
    d.raw.prepare('UPDATE photos SET taken_at = 600 WHERE asset_id = ?').run(id('p1'));
    d.raw.prepare('UPDATE photos SET taken_at = 500 WHERE asset_id = ?').run(id('p2'));
    const { listSinglesFeed } = await import('./store');
    const rows = await listSinglesFeed(asExpo(d), 3);
    expect(rows.map((r) => r.asset_id)).toEqual([id('w1'), id('w2'), id('w3'), id('p1'), id('p2')]);
    expect(rows.filter((r) => r.state === 'unreviewed').map((r) => r.asset_id)).toEqual([
      id('p1'),
      id('p2'),
    ]);
  });

  it('un-staging stamps reviewed_at when the cull path never did', async () => {
    // Belt and braces for the "reviewed_at first-stamps on any verdict"
    // rule: kept is a verdict, so a culled row that somehow reached this
    // transition unstamped leaves it stamped.
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 100);
    d.raw.prepare('UPDATE photos SET reviewed_at = NULL WHERE asset_id = ?').run(id('1'));
    await unstageCullDirect(asExpo(d), id('1'), AT + 200, true);
    expect(stateOf(d, '1')).toMatchObject({ state: 'kept', reviewed_at: AT + 200 });
  });
});

// -------------------------------------------- final-review round 15

describe('compare verdicts validate membership in the transaction', () => {
  it('aborts whole when the group was rebuilt out from under Compare', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2']]);
    const gid = groupIdOf(d, '1');
    // The group dissolves (ejection) before the compare verdict lands.
    await ejectNotRelated(asExpo(d), [id('1')], AT + 50);
    await expect(
      applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 100, {
        duel: {
          groupId: String(gid),
          winnerId: id('1'),
          loserId: id('2'),
          keptBoth: false,
          at: AT + 100,
        },
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
    // The Unknown-day pseudo-day rides along after the dated rows.
    expect(days).toEqual([
      { day: '2026-07-20', pending: 1 },
      { day: 'undated', pending: 1 },
    ]);
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
    await expect(ejectNotRelated(asExpo(d), [id('1')], AT + 100, staleGid)).rejects.toThrow(
      /changed while reviewing/,
    );
    // Nothing moved: the photo keeps its real group, no pair recorded.
    const row = d.raw
      .prepare('SELECT group_id FROM photo_group_assignments WHERE photo_id = ?')
      .get(id('1')) as { group_id: number | null };
    expect(row.group_id).not.toBeNull();
    expect(d.raw.prepare('SELECT COUNT(*) AS n FROM not_related').get()).toEqual({ n: 0 });
    // The matching id still works.
    await ejectNotRelated(asExpo(d), [id('1')], AT + 200, groupIdOf(d, '1'));
    expect(d.raw.prepare('SELECT COUNT(*) AS n FROM not_related').get()).toEqual({ n: 2 });
  });
});

// -------------------------------------------- final-review round 26

describe('decisions reject externally removed photos', () => {
  it('a single-photo decision on a reconciled row surfaces and saves nothing', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    const { reconcileExternallyRemoved } = await import('./trashStore');
    await reconcileExternallyRemoved(asExpo(d), [id('1')], AT + 50);
    await expect(applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100)).rejects.toThrow(
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
        [id('1'), 'kept'],
        [id('2'), 'kept'],
      ],
      AT + 100,
    );
    expect(stateOf(d, '2').state).toBe('kept');
    const gone = d.raw.prepare('SELECT state FROM photos WHERE asset_id = ?').get(id('1')) as {
      state: string;
    };
    expect(gone.state).toBe('trashed');
  });
});

// -------------------------------------------- final-review round 27

describe('stale actions against absent/regrouped photos reject', () => {
  it('a compare against an absent endpoint aborts whole', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    const gid = groupIdOf(d, '1');
    const { reconcileExternallyRemoved } = await import('./trashStore');
    await reconcileExternallyRemoved(asExpo(d), [id('1')], AT + 50);
    await expect(
      applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 100, {
        duel: {
          groupId: String(gid),
          winnerId: id('1'),
          loserId: id('2'),
          keptBoth: false,
          at: AT + 100,
        },
      }),
    ).rejects.toThrow(/changed while comparing/);
    expect(d.raw.prepare('SELECT COUNT(*) AS n FROM duels').get()).toEqual({ n: 0 });
  });

  it('a duel with a KEPT endpoint writes — kept members rejoin duels (F11)', async () => {
    // Compare eligibility is undecided-or-kept, so the in-transaction
    // guard must accept kept endpoints too; requiring 'unreviewed' made
    // every compare-with-a-kept-photo abort as "group changed". Member 3
    // is kept so the duel really is the whole table (alive = {2}).
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    const gid = groupIdOf(d, '1');
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'kept'],
        [id('3'), 'kept'],
      ],
      AT + 50,
    );
    await applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 100, {
      duel: {
        groupId: String(gid),
        winnerId: id('1'),
        loserId: id('2'),
        keptBoth: false,
        at: AT + 100,
      },
    });
    expect(d.raw.prepare('SELECT COUNT(*) AS n FROM duels').get()).toEqual({ n: 1 });
    expect(stateOf(d, '2').state).toBe('culled');
  });

  it('a verdict-writing duel aborts when an undecided member sits OUTSIDE the pair', async () => {
    // The whole-table claim (F15) is re-validated in the transaction: a
    // warm scan can add an undecided member between Compare's load and
    // the write, and a verdict would close a question the duel never
    // asked. Triage duels (no verdicts) make no such claim.
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    const gid = groupIdOf(d, '1');
    await expect(
      applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 100, {
        duel: {
          groupId: String(gid),
          winnerId: id('1'),
          loserId: id('2'),
          keptBoth: false,
          at: AT + 100,
        },
      }),
    ).rejects.toThrow(/changed while comparing/);
    // The same duel WITHOUT verdicts is triage and writes fine.
    await applyReviewDecisions(asExpo(d), [], AT + 200, {
      duel: {
        groupId: String(gid),
        winnerId: id('1'),
        loserId: id('2'),
        keptBoth: true,
        at: AT + 200,
      },
    });
    expect(d.raw.prepare('SELECT COUNT(*) AS n FROM duels').get()).toEqual({ n: 1 });
  });

  it('a duel against a STAGED-CULL endpoint still aborts', async () => {
    // Staged culls stay out of Compare on both endpoints (F11) — the
    // widened guard must not widen past kept.
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    const gid = groupIdOf(d, '1');
    await applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 50);
    await expect(
      applyReviewDecisions(asExpo(d), [], AT + 100, {
        duel: {
          groupId: String(gid),
          winnerId: id('1'),
          loserId: id('2'),
          keptBoth: true,
          at: AT + 100,
        },
      }),
    ).rejects.toThrow(/changed while comparing/);
    expect(d.raw.prepare('SELECT COUNT(*) AS n FROM duels').get()).toEqual({ n: 0 });
  });

  it('ejecting an absent member rejects', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    const gid = groupIdOf(d, '1');
    const { reconcileExternallyRemoved } = await import('./trashStore');
    await reconcileExternallyRemoved(asExpo(d), [id('1')], AT + 50);
    await expect(ejectNotRelated(asExpo(d), [id('1')], AT + 100, gid)).rejects.toThrow(
      /changed while reviewing/,
    );
  });

  it('requireGroupMembership rejects a keep-rest against a rebuilt group', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    const gid = groupIdOf(d, '1');
    await expect(
      applyReviewDecisions(
        asExpo(d),
        [
          [id('1'), 'kept'],
          [id('2'), 'kept'],
        ],
        AT + 100,
        { requireGroupMembership: { groupId: gid + 999, assetIds: [id('1'), id('2')] } },
      ),
    ).rejects.toThrow(/changed while reviewing/);
    expect(stateOf(d, '1').state).toBe('unreviewed');
  });
});

// -------------------------------------------- Unknown-day pseudo-day

describe('the Unknown-day pseudo-day', () => {
  async function seedUndated(d: TestDb): Promise<void> {
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          upsert('1'),
          { ...upsert('u1'), day: null },
          { ...upsert('u2'), day: null },
          { ...upsert('u3'), day: null },
        ],
        groups: [{ members: [id('u1'), id('u2')], timeAttached: [] }],
        singles: [id('1'), id('u3')],
      },
      AT,
    );
  }

  it('scope, summaries, groups, and counts all resolve the sentinel', async () => {
    const d = await fresh();
    await seedUndated(d);
    await applyReviewDecisions(asExpo(d), [[id('u3'), 'kept']], AT + 1);

    const counts = await getStateCountsInScope(asExpo(d), { day: UNDATED_DAY_KEY }, null);
    expect(counts.tracked).toBe(3);
    expect(counts.kept).toBe(1);

    const summaries = await getDaySummariesForDays(asExpo(d), [UNDATED_DAY_KEY, '2026-07-20']);
    expect(summaries.get(UNDATED_DAY_KEY)).toMatchObject({ tracked: 3, done: 1 });
    expect(summaries.get('2026-07-20')?.tracked).toBe(1);

    const groups = await listGroupsForDay(asExpo(d), UNDATED_DAY_KEY);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.asset_id).sort()).toEqual([id('u1'), id('u2')]);

    // The deck read resolves the sentinel too — 'u3' stays in the deck
    // badged through keep AND cull (m0.8.2 group-deck parity).
    expect(
      (await listSinglesForDeck(asExpo(d), UNDATED_DAY_KEY)).map((m) => [m.asset_id, m.state]),
    ).toEqual([[id('u3'), 'kept']]);
    await applyReviewDecisions(asExpo(d), [[id('u3'), 'culled']], AT + 2);
    expect((await listSinglesForDeck(asExpo(d), UNDATED_DAY_KEY)).map((m) => m.asset_id)).toEqual([
      id('u3'),
    ]);

    expect(await countUndatedAlive(asExpo(d))).toBe(3);

    const days = await getUnreviewedDayRows(asExpo(d));
    expect(days).toEqual([
      { day: '2026-07-20', pending: 1 },
      { day: UNDATED_DAY_KEY, pending: 2 },
    ]);
  });

  it('the open-ended corpus scope still counts undated rows (Stats/Progress library totals)', async () => {
    const d = await fresh();
    await seedUndated(d);
    await applyReviewDecisions(asExpo(d), [[id('u3'), 'kept']], AT + 1);

    // Undated photos have no `day` but DO have a taken_at (mtime
    // fallback), so the whole-corpus range covers them: 3 undated + the
    // dated photo. Stats and the "All photos" Progress page both count
    // this way — a `day IS NULL` exclusion here would understate both.
    const counts = await getStateCountsInScope(
      asExpo(d),
      { startMs: 0, endMs: Number.POSITIVE_INFINITY },
      null,
    );
    expect(counts).toMatchObject({
      tracked: 4,
      kept: 1,
      unreviewed: 3,
      grouped: { unreviewed: 2, kept: 0, staged: 0 },
    });
  });

  it('the DB-backed all/unreviewed grid filters page the pseudo-day', async () => {
    const d = await fresh();
    await seedUndated(d);
    const scope = { day: UNDATED_DAY_KEY };
    const all = await getGridPhotosByFilter(asExpo(d), scope, null, 'all', 10, 0);
    expect(all.map((r) => r.asset_id).sort()).toEqual([id('u1'), id('u2'), id('u3')]);
    // 'unreviewed' is the VERDICT, so grouped and ungrouped alike.
    const unreviewed = await getGridPhotosByFilter(asExpo(d), scope, null, 'unreviewed', 10, 0);
    expect(unreviewed.map((r) => r.asset_id).sort()).toEqual([id('u1'), id('u2'), id('u3')]);
    // Grouping is an ANNOTATION, not a filter (v18): the grid reports it
    // per row so the underline can span whichever verdicts hold it.
    expect(
      all
        .filter((r) => Number(r.grouped) === 1)
        .map((r) => r.asset_id)
        .sort(),
    ).toEqual([id('u1'), id('u2')]);
  });
});

// -------------------------------------------- exact reclaimable bytes (v14)

describe('exact reclaimable bytes', () => {
  it('sums scan-recorded sizes for staged culls and lists unsized rows', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3']);
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'culled'],
        [id('2'), 'culled'],
      ],
      AT + 1,
    );
    // One row predates v14 sizing (NULL) — it must surface for the stat
    // fallback instead of silently missing from the sum.
    d.raw.prepare('UPDATE photos SET size_bytes = NULL WHERE asset_id = ?').run(id('2'));
    const staged = await getStagedCullBytes(asExpo(d));
    // The sized row is summed in SQL; the unsized one comes back for the
    // caller's bounded stat fallback (never silently missing).
    expect(staged.scanned).toBe(1_000);
    expect(staged.unsized).toEqual(['file:///dcim/2.jpg']);
  });
});

function stateOf2(d: TestDb, rawId: string): Record<string, unknown> {
  return d.raw
    .prepare(
      'SELECT state, reviewed_at, decided_at, decided_first_at FROM photos WHERE asset_id = ?',
    )
    .get(id(rawId)) as Record<string, unknown>;
}

describe('decided_at (m0.8.1: the daily goal counts review ACTIONS)', () => {
  it('re-stamps on every verdict while reviewed_at keeps the first stamp', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    expect(stateOf2(d, '1')).toMatchObject({
      reviewed_at: AT + 100,
      decided_at: AT + 100,
      decided_first_at: AT + 100,
    });
    // A next-day re-decide moves decided_at but NOT reviewed_at — and NOT
    // decided_first_at (v22, STATS_ACCURACY gap 8): day-bucketed history
    // reads the immutable first stamp, so re-deciding an old photo can
    // never drain its original day.
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 90_000_000);
    expect(stateOf2(d, '1')).toMatchObject({
      reviewed_at: AT + 100,
      decided_at: AT + 90_000_000,
      decided_first_at: AT + 100,
    });
    // Clearing back to unreviewed keeps both stamps (the work happened).
    await applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 90_000_500);
    expect(stateOf2(d, '1')).toMatchObject({
      decided_at: AT + 90_000_000,
      decided_first_at: AT + 100,
    });
  });

  it('redecide and unstage paths re-stamp too, and the day counts follow decided_at', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 100);
    await applyReviewDecisions(asExpo(d), [[id('2'), 'kept']], AT + 100);
    await unstageCullDirect(asExpo(d), id('1'), AT + 90_000_000, true);
    await applyRedecision(asExpo(d), id('2'), 'keep', AT + 90_000_000);
    // decided_at moves; the first stamp holds on both re-decide paths.
    expect(stateOf2(d, '1')).toMatchObject({
      decided_at: AT + 90_000_000,
      decided_first_at: AT + 100,
    });
    expect(stateOf2(d, '2')).toMatchObject({
      decided_at: AT + 90_000_000,
      decided_first_at: AT + 100,
    });
    const counts = await getReviewedCountsByDay(asExpo(d), 0);
    // Both photos moved their stamps to the later day — the earlier day
    // holds no decided_at anymore (one row = its latest action day).
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe('decision-history scoping (vetted 2026-08-21)', () => {
  it('the map KEEPS a source scope for the intake chart; the habit readers are unscoped-only', async () => {
    // The contract split by purpose: achievement/habit stats (ring,
    // streaks, records, rhythm, sittings, decisiveness, the day summary)
    // read decision history UNSCOPED on both axes — narrowing a folder
    // selection or unmounting a card never rewrites what you did.
    // getReviewedCountsByDay keeps its roots parameter for exactly ONE
    // caller: the intake chart's decided series (gap 6), which must
    // describe the same population as its captured partner.
    const d = await fresh();
    const inSource = { ...upsert('c1'), uri: 'file:///storage/emulated/0/DCIM/Camera/c1.jpg' };
    const outSource = { ...upsert('w1'), uri: 'file:///storage/emulated/0/WhatsApp/Media/w1.jpg' };
    await writeContinuousGroups(
      asExpo(d),
      { photos: [inSource, outSource], groups: [], singles: [id('c1'), id('w1')] },
      AT,
    );
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('c1'), 'kept'],
        [id('w1'), 'kept'],
      ],
      AT,
    );
    const roots = [{ volume: 'external_primary', dir: 'DCIM/Camera' }];
    const scoped = await getReviewedCountsByDay(asExpo(d), 0, roots);
    const unscoped = await getReviewedCountsByDay(asExpo(d), 0);
    expect([...scoped.values()].reduce((a, b) => a + b, 0)).toBe(1);
    expect([...unscoped.values()].reduce((a, b) => a + b, 0)).toBe(2);

    // The habit readers take no scope at all — the whole library is the
    // only population they can describe.
    const day = dayKey(AT);
    expect((await getDayReviewSummary(asExpo(d), day)).reviewed).toBe(2);
    expect(await getRecentDecisionStamps(asExpo(d), 2000)).toHaveLength(2);

    // ...and the all-time record stays whole: narrowing your sources
    // must not rewrite work you actually finished.
    expect((await getLifetimeStats(asExpo(d))).reviewed).toBe(2);
  });
});

describe('getReviewedCountsByDay counts DECIDED-day, not capture-day (m0.8.1)', () => {
  it('counts a photo captured long ago but decided today', async () => {
    const d = await fresh();
    // Two photos with the SAME capture day column value...
    await seed(d, ['1', '2']);
    // ...and an ancient capture day on one of them, to prove the query
    // never groups or filters by photos.day. `AS day` used to shadow the
    // real column, so this photo vanished from the goal count entirely.
    d.raw.prepare('UPDATE photos SET day = ? WHERE asset_id = ?').run('2019-01-01', id('1'));
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT);
    await applyReviewDecisions(asExpo(d), [[id('2'), 'kept']], AT);
    const decidedDay = new Date(AT).toISOString().slice(0, 10);
    const counts = await getReviewedCountsByDay(asExpo(d), 0);
    // ONE bucket (the decided day), holding BOTH photos.
    expect(counts.size).toBe(1);
    expect([...counts.keys()][0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([...counts.values()][0]).toBe(2);
    // Sanity: the bucket is the decision date, not either capture date.
    expect([...counts.keys()][0]).not.toBe('2019-01-01');
    expect(decidedDay.length).toBe(10);
  });

  it('the epoch bound excludes older decisions only', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT);
    await applyReviewDecisions(asExpo(d), [[id('2'), 'kept']], AT + 90_000_000);
    expect((await getReviewedCountsByDay(asExpo(d), 0)).size).toBe(2);
    const laterOnly = await getReviewedCountsByDay(asExpo(d), AT + 1);
    expect([...laterOnly.values()].reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe('getDayReviewSummary keys on the FIRST stamp (m0.8.7, gap 8)', () => {
  it('a re-decided photo stays on its ORIGINAL day; today counts first decisions only', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    const dayStart = rangeOfDayKey(dayKey(AT)).startMs;
    // Photo 1: first decided five days ago, re-decided today — its
    // history stays on the original day (immutable first stamp).
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], dayStart - 5 * 86_400_000);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT);
    // Photo 2: decided today for the first time.
    await applyReviewDecisions(asExpo(d), [[id('2'), 'kept']], AT);
    const summary = await getDayReviewSummary(asExpo(d), dayKey(AT));
    expect(summary.reviewed).toBe(1);
    expect(summary.kept).toBe(1);
    expect(summary.staged).toBe(0);
    // Photo 1's day: the summary classifies by CURRENT verdict, so its
    // bucket follows the re-decide even though its DAY never moves.
    const earlier = await getDayReviewSummary(asExpo(d), dayKey(dayStart - 5 * 86_400_000));
    expect(earlier.reviewed).toBe(1);
    expect(earlier.staged).toBe(1);
    // ...and the ring's per-day counts agree for both days.
    const counts = await getReviewedCountsByDay(asExpo(d), 0);
    expect(counts.get(dayKey(AT))).toBe(1);
    expect(counts.get(dayKey(dayStart - 5 * 86_400_000))).toBe(1);
  });

  it('includes the last millisecond of the day', async () => {
    const d = await fresh();
    await seed(d, ['1']);
    const end = rangeOfDayKey(dayKey(AT)).endMs;
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], end);
    expect((await getDayReviewSummary(asExpo(d), dayKey(AT))).reviewed).toBe(1);
  });
});

describe('getCoverageByDay (m0.8.1 coverage goal)', () => {
  it('groups by capture day, counts pending, and keeps the undated bucket', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3', '4']);
    // Two capture days plus one undated photo.
    d.raw.prepare('UPDATE photos SET day = ? WHERE asset_id = ?').run('2026-07-19', id('3'));
    d.raw.prepare('UPDATE photos SET day = NULL WHERE asset_id = ?').run(id('4'));
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT);
    const rows = await getCoverageByDay(asExpo(d), null);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    expect(byDay.get('2026-07-20')).toMatchObject({ total: 2, pending: 1 });
    expect(byDay.get('2026-07-19')).toMatchObject({ total: 1, pending: 1 });
    expect(byDay.get(null)).toMatchObject({ total: 1, pending: 1 });
  });

  it('a sinceDay bound drops older days but NEVER the undated bucket', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    d.raw.prepare('UPDATE photos SET day = ? WHERE asset_id = ?').run('2020-01-01', id('1'));
    d.raw.prepare('UPDATE photos SET day = NULL WHERE asset_id = ?').run(id('2'));
    const rows = await getCoverageByDay(asExpo(d), '2026-07-01');
    expect(rows.map((r) => r.day)).toEqual([null]);
  });

  it('honours the photo-source scope', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    // Same uri convention as the source-scoped queue tests above: the
    // LIKE matches '%/DCIM/Camera/%'.
    const setUri = (rawId: string, folder: string) =>
      d.raw
        .prepare('UPDATE photos SET uri = ? WHERE asset_id = ?')
        .run(`file:///storage/emulated/0/${folder}/${rawId}.jpg`, id(rawId));
    setUri('1', 'DCIM/Camera');
    setUri('2', 'WhatsApp/Media');
    const scoped = await getCoverageByDay(asExpo(d), null, [
      { volume: 'external_primary', dir: 'DCIM/Camera' },
    ]);
    expect(scoped.reduce((sum, r) => sum + r.total, 0)).toBe(1);
    const all = await getCoverageByDay(asExpo(d), null, null);
    expect(all.reduce((sum, r) => sum + r.total, 0)).toBe(2);
  });

  it('a trashed photo is neither pending nor counted (it left MediaStore)', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    d.raw
      .prepare("UPDATE photos SET state = 'trashed', is_present = 0 WHERE asset_id = ?")
      .run(id('1'));
    const rows = await getCoverageByDay(asExpo(d), null);
    expect(rows.reduce((sum, r) => sum + r.total, 0)).toBe(1);
    expect(rows.reduce((sum, r) => sum + r.pending, 0)).toBe(1);
  });
});

describe('month scopes and the rescued-date pins (m0.8.6)', () => {
  /** The three populations of the defect: a dated photo, a D15-rescued
   * photo (real taken_at + day, exif marker set — MediaStore would call
   * it undated), and an honestly-undated photo whose mtime falls INSIDE
   * the month (day null, exif checked, nothing found). */
  const JULY_AT = new Date(2026, 6, 15, 12, 0, 0).getTime();
  async function seedMonth(d: TestDb): Promise<void> {
    const photos = [
      { ...upsert('dated', JULY_AT), day: '2026-07-15' },
      {
        ...upsert('rescued', JULY_AT + 3_600_000),
        day: '2026-07-15',
        exifCheckedModTime: JULY_AT,
      },
      { ...upsert('undated-gif', JULY_AT + 7_200_000), day: null, exifCheckedModTime: JULY_AT },
    ];
    await writeContinuousGroups(
      asExpo(d),
      { photos, groups: [], singles: photos.map((p) => p.assetId) },
      AT,
    );
  }

  it('pin 1: a month scope prints ONE population — chips exclude undated, include rescued', async () => {
    const d = await fresh();
    await seedMonth(d);
    const counts = await getStateCountsInScope(asExpo(d), { month: '2026-07' }, null);
    // The dated and the rescued photo; NEVER the undated one, whatever
    // month its mtime lands in (the S10e "delta of exactly five GIFs").
    expect(counts.tracked).toBe(2);
    expect(counts.unreviewed).toBe(2);
    expect(counts.rescued).toBe(1);
    // The grid pages the SAME predicate, so its population matches the
    // chips by construction.
    const grid = await getGridPhotosByFilter(
      asExpo(d),
      { month: '2026-07' },
      null,
      'unreviewed',
      10,
      0,
    );
    expect(grid.map((r) => r.asset_id).sort()).toEqual([id('dated'), id('rescued')]);
  });

  it('pin 2: the same photo renders under Unreviewed as under Kept — the engine cannot hide it', async () => {
    const d = await fresh();
    await seedMonth(d);
    const before = await getGridPhotosByFilter(
      asExpo(d),
      { month: '2026-07' },
      null,
      'unreviewed',
      10,
      0,
    );
    expect(before.some((r) => r.asset_id === id('rescued'))).toBe(true);
    await applyReviewDecisions(asExpo(d), [[id('rescued'), 'kept']], AT);
    const kept = await getGridPhotosByFilter(asExpo(d), { month: '2026-07' }, null, 'kept', 10, 0);
    expect(kept.map((r) => r.asset_id)).toEqual([id('rescued')]);
    const after = await getGridPhotosByFilter(
      asExpo(d),
      { month: '2026-07' },
      null,
      'unreviewed',
      10,
      0,
    );
    expect(after.some((r) => r.asset_id === id('rescued'))).toBe(false);
  });

  it('an undated photo lives in the Unknown-day pseudo-day and in NO month', async () => {
    const d = await fresh();
    await seedMonth(d);
    const undatedCounts = await getStateCountsInScope(asExpo(d), { day: UNDATED_DAY_KEY }, null);
    expect(undatedCounts.tracked).toBe(1);
    for (const month of ['2026-07', '2026-08']) {
      const grid = await getGridPhotosByFilter(asExpo(d), { month }, null, 'all', 10, 0);
      expect(grid.some((r) => r.asset_id === id('undated-gif'))).toBe(false);
    }
  });

  it('getRescuedPhotoPage streams only rescued rows, newest first, keyset-stable', async () => {
    const d = await fresh();
    await seedMonth(d);
    const page1 = await getRescuedPhotoPage(asExpo(d), null, null, undefined, 10);
    expect(page1.map((r) => r.asset_id)).toEqual([id('rescued')]);
    expect(page1[0].day).toBe('2026-07-15');
    // The keyset past the only row is empty, not a repeat.
    const page2 = await getRescuedPhotoPage(
      asExpo(d),
      null,
      null,
      { takenAt: page1[0].taken_at, assetId: page1[0].asset_id },
      10,
    );
    expect(page2).toEqual([]);
  });

  it('getStateRowsForAssets carries the DB date truth and the rescued marker', async () => {
    const d = await fresh();
    await seedMonth(d);
    const rows = await getStateRowsForAssets(asExpo(d), [
      id('dated'),
      id('rescued'),
      id('undated-gif'),
    ]);
    expect(rows.get(id('rescued'))).toMatchObject({
      day: '2026-07-15',
      rescued: true,
    });
    // Checked-but-nothing-found is NOT rescued: its day stays null and
    // the MediaStore copy must keep rendering (no rescued-stream twin).
    expect(rows.get(id('undated-gif'))).toMatchObject({ day: null, rescued: false });
    expect(rows.get(id('dated'))).toMatchObject({ day: '2026-07-15', rescued: false });
  });
});

describe('duels are an append-only event log (v22) — no verdict path deletes them', () => {
  async function seedDuelGroup(d: TestDb): Promise<number> {
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: ['1', '2', '3'].map((r) => upsert(r)),
        groups: [{ members: [id('1'), id('2'), id('3')], timeAttached: [] }],
        singles: [],
      },
      AT,
    );
    const groups = await listReviewGroups(asExpo(d), 10);
    const groupId = groups[0].groupId;
    // A triage keep leaves a duel row (the narrow claim, D7).
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 10, {
      duel: {
        groupId: String(groupId),
        winnerId: id('1'),
        loserId: id('2'),
        keptBoth: null,
        at: AT + 10,
      },
      duelClaimsWholeTable: false,
    });
    return groupId;
  }

  function duelCount(d: TestDb): number {
    return Number((d.raw.prepare('SELECT COUNT(*) AS n FROM duels').get() as { n: number }).n);
  }

  it('un-review keeps the Compare history — fully non-destructive, no confirm needed', async () => {
    const d = await fresh();
    await seedDuelGroup(d);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 20);
    expect(duelCount(d)).toBe(1);
    const facts = await getPhotoFacts(asExpo(d), id('1'));
    expect(facts?.state).toBe('unreviewed');
  });

  it('every restore path keeps the rows too', async () => {
    const d = await fresh();
    await seedDuelGroup(d);
    await applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 20);
    expect(await restoreCarriedCull(asExpo(d), id('2'), AT + 30)).toBe(true);
    expect(duelCount(d)).toBe(1);
    await applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 40);
    expect(await unstageCullDirect(asExpo(d), id('2'), AT + 50, true)).toMatchObject({
      appliedIds: [id('2')],
    });
    expect(duelCount(d)).toBe(1);
  });

  it('the lifetime count is stable across regrouping and re-mints', async () => {
    const d = await fresh();
    await seedDuelGroup(d);
    // Regroup into a different split, twice — the duel never notices.
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: ['1', '2', '3'].map((r) => upsert(r)),
        groups: [{ members: [id('2'), id('3')], timeAttached: [] }],
        singles: [id('1')],
      },
      AT + 100,
    );
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: ['1', '2', '3'].map((r) => upsert(r)),
        groups: [{ members: [id('1'), id('2'), id('3')], timeAttached: [] }],
        singles: [],
      },
      AT + 200,
    );
    expect(duelCount(d)).toBe(1);
    const row = d.raw.prepare('SELECT winner_id, loser_id FROM duels').get() as {
      winner_id: string;
      loser_id: string;
    };
    expect(row).toEqual({ winner_id: id('1'), loser_id: id('2') });
  });
});

describe('the browse timeline reads (m0.8.6 F2/D1: Everything)', () => {
  const T = AT - 3_600_000;
  async function seedBrowse(d: TestDb): Promise<void> {
    const photos = [
      upsert('g1a', T + 500),
      upsert('g1b', T + 490),
      upsert('s-kept', T + 400),
      upsert('s-culled', T + 300),
      upsert('s-open', T + 200),
      upsert('s-trashed', T + 100),
    ];
    await writeContinuousGroups(
      asExpo(d),
      {
        photos,
        groups: [{ members: [id('g1a'), id('g1b')], timeAttached: [] }],
        singles: [id('s-kept'), id('s-culled'), id('s-open'), id('s-trashed')],
      },
      AT,
    );
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('g1a'), 'kept'],
        [id('g1b'), 'kept'],
        [id('s-kept'), 'kept'],
        [id('s-culled'), 'culled'],
      ],
      AT + 10,
    );
    // A trashed row leaves the browse streams entirely.
    await asExpo(d).runAsync(
      "UPDATE photos SET state = 'trashed' WHERE asset_id = ?",
      id('s-trashed'),
    );
  }

  it('groups page includes fully-reviewed groups, newest-anchor first', async () => {
    const d = await fresh();
    await seedBrowse(d);
    const page = await fetchBrowseGroupsPage(asExpo(d), null, null, undefined, 10);
    expect(page.map((g) => g.members.map((m) => m.asset_id))).toEqual([[id('g1a'), id('g1b')]]);
    // The keyset past the only group is empty.
    const next = await fetchBrowseGroupsPage(
      asExpo(d),
      null,
      null,
      { anchor: page[0].members[0].taken_at, groupId: page[0].groupId },
      10,
    );
    expect(next).toEqual([]);
  });

  it('a mixed-source group orders by its WHOLE reachable group; source gates eligibility only (codex r5)', async () => {
    const d = await fresh();
    const CAMERA_ROOT = [{ volume: 'external_primary', dir: 'Camera' }];
    const at = (raw: string, dir: string, takenAt: number) => ({
      ...upsert(raw, takenAt),
      uri: `file:///dcim/${dir}/${raw}.jpg`,
    });
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          at('mix-in', 'Camera', T + 100),
          at('mix-out', 'Elsewhere', T + 900),
          at('pure-a', 'Camera', T + 500),
          at('pure-b', 'Camera', T + 490),
          at('foreign-a', 'Elsewhere', T + 800),
          at('foreign-b', 'Elsewhere', T + 790),
        ],
        groups: [
          { members: [id('mix-in'), id('mix-out')], timeAttached: [] },
          { members: [id('pure-a'), id('pure-b')], timeAttached: [] },
          { members: [id('foreign-a'), id('foreign-b')], timeAttached: [] },
        ],
        singles: [],
      },
      AT,
    );
    const page = await fetchBrowseGroupsPage(asExpo(d), CAMERA_ROOT, null, undefined, 10);
    // The mixed group is eligible (an in-source member) and ORDERS by
    // its whole-group newest (T+900, the out-of-source member) — ahead
    // of the pure T+500 group; the all-foreign group never appears.
    expect(page.map((g) => g.members.map((m) => m.asset_id))).toEqual([
      [id('mix-out'), id('mix-in')],
      [id('pure-a'), id('pure-b')],
    ]);
    expect(page[0].anchor).toBe(T + 900);
    // The card's displayed date IS the ordering key.
    expect(page[0].members[0].taken_at).toBe(page[0].anchor);
  });

  it('singles page includes every verdict except trashed, keyset-stable', async () => {
    const d = await fresh();
    await seedBrowse(d);
    const page = await fetchBrowseSinglesPage(asExpo(d), null, null, undefined, 2);
    expect(page.map((r) => r.asset_id)).toEqual([id('s-kept'), id('s-culled')]);
    const rest = await fetchBrowseSinglesPage(
      asExpo(d),
      null,
      null,
      { takenAt: page[1].taken_at, assetId: page[1].asset_id },
      10,
    );
    expect(rest.map((r) => r.asset_id)).toEqual([id('s-open')]);
  });
});
