/**
 * Optimistic-patch parity suite (m0.8.1 responsiveness fix): every
 * lib/reviewPatch.ts action must predict EXACTLY what a full queue
 * re-read returns after the corresponding db/store.ts write — the
 * patch is what the UI shows the instant a decision commits, and any
 * divergence would flicker once the reconciling refresh lands.
 *
 * Method: seed a real database (the scan's window write), snapshot the
 * queue the way ReviewContext.commitRefresh does, run the REAL SQL
 * write, then diff { groups, singles, counts, flag/favourite maps } of
 * applyLocalAction(before) against a fresh re-read.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  applyRedecision,
  applyReviewDecisions,
  getNeedsEditAssets,
  ejectNotRelated,
  readReviewQueue,
  restoreCarriedCull,
  unstageCullDirect,
  writeContinuousGroups,
  type ContinuousPhotoUpsert,
} from './store';
import { applyLocalAction, type LocalAction, type ReviewSnapshot } from '../lib/reviewPatch';
import { getFavouriteActionStates } from './actions';
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

const id = (rawId: string): string => `external_primary/${rawId}`;

function upsert(rawId: string, takenAt: number): ContinuousPhotoUpsert {
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

/** Seed via the scan's window write; distinct taken_at per raw id keeps
 * feed ordering meaningful (later position in `rawIds` = newer photo). */
async function seed(d: TestDb, rawIds: string[], groups: string[][] = []): Promise<void> {
  await writeContinuousGroups(
    asExpo(d),
    {
      photos: rawIds.map((r, i) => upsert(r, AT - 3_600_000 + i * 60_000)),
      groups: groups.map((g) => ({ members: g.map(id), timeAttached: [] })),
      singles: rawIds.map(id).filter((a) => !groups.some((g) => g.map(id).includes(a))),
    },
    AT,
  );
}

/** Snapshot the queue exactly the way ReviewContext.commitRefresh does. */
async function snapshot(d: TestDb): Promise<ReviewSnapshot> {
  const queue = await readReviewQueue(asExpo(d), 100, 500);
  const ids = [
    ...queue.groups.flatMap((g) => g.members.map((m) => m.asset_id)),
    ...queue.singles.map((m) => m.asset_id),
  ];
  const [needsEdit, favourites] = await Promise.all([
    getNeedsEditAssets(asExpo(d), ids),
    getFavouriteActionStates(asExpo(d), ids),
  ]);
  return { ...queue, needsEdit, favourites };
}

/** Comparable projection: the flag/favourite maps are restricted to ids
 * the arrays hold (the context legitimately retains entries for photos
 * that left the page; commitRefresh rebuilds them wholesale), and a
 * missing favourite entry equals the 'none' default. */
function project(s: ReviewSnapshot) {
  const ids = new Set([
    ...s.groups.flatMap((g) => g.members.map((m) => m.asset_id)),
    ...s.singles.map((m) => m.asset_id),
  ]);
  return {
    groups: s.groups,
    singles: s.singles,
    counts: s.counts,
    needsEdit: [...s.needsEdit].filter((a) => ids.has(a)).sort(),
    favourites: [...ids]
      .sort()
      .map((a) => [a, s.favourites.get(a) ?? { state: 'none', target: null }]),
  };
}

/** Run the SQL write and assert the pure patch predicted the re-read. */
async function expectParity(
  d: TestDb,
  before: ReviewSnapshot,
  action: LocalAction,
  write: () => Promise<unknown>,
): Promise<ReviewSnapshot> {
  const patched = applyLocalAction(before, action);
  await write();
  const reread = await snapshot(d);
  expect(project(patched)).toEqual(project(reread));
  return reread;
}

describe('reviewPatch parity with db/store.ts', () => {
  it('keep on a group member: kept, counts drop, group stays while others pend', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    const before = await snapshot(d);
    await expectParity(d, before, { kind: 'verdict', assetId: id('1'), verdict: 'kept' }, () =>
      applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100),
    );
  });

  it('a keep on an already-flagged photo lands on kept, flag intact', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    await applyReviewDecisions(asExpo(d), [], AT + 50, {
      needsEditChanges: [{ assetId: id('1'), needsEdit: true }],
    });
    const before = await snapshot(d);
    await expectParity(d, before, { kind: 'verdict', assetId: id('1'), verdict: 'kept' }, () =>
      applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100),
    );
  });

  it('cull on a group member: culled, it stays in place badged', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    const before = await snapshot(d);
    await expectParity(d, before, { kind: 'verdict', assetId: id('2'), verdict: 'culled' }, () =>
      applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 200),
    );
  });

  it('the deck "To edit" keeps AND queues in one transaction', async () => {
    // The deck sends both layers in ONE write; a patch that predicted
    // only the verdict would flash the photo as a plain keeper until the
    // refresh landed — and a WRITE that sent only the verdict would drop
    // the edit entirely, which is the bug this pins.
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    const before = await snapshot(d);
    const after = await expectParity(
      d,
      before,
      { kind: 'verdict', assetId: id('1'), verdict: 'kept', queueEdit: true },
      () =>
        applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100, {
          needsEditChanges: [{ assetId: id('1'), needsEdit: true }],
        }),
    );
    expect(after.needsEdit.has(id('1'))).toBe(true);
  });

  it('clearing a verdict leaves a queued edit queued (both layers)', async () => {
    // The layers are independent: undoing a keep says nothing about the
    // edit you still want. The patch has to agree with the SQL on that.
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 50, {
      needsEditChanges: [{ assetId: id('1'), needsEdit: true }],
    });
    const before = await snapshot(d);
    expect(before.needsEdit.has(id('1'))).toBe(true);
    const after = await expectParity(
      d,
      before,
      { kind: 'verdict', assetId: id('1'), verdict: 'unreviewed' },
      () => applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 200),
    );
    expect(after.needsEdit.has(id('1'))).toBe(true);
  });

  it('to_edit sets the flag; clearing back to unreviewed resets it', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    let before = await snapshot(d);
    before = await expectParity(
      d,
      before,
      { kind: 'verdict', assetId: id('1'), verdict: 'kept' },
      () => applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100),
    );
    await expectParity(
      d,
      before,
      { kind: 'verdict', assetId: id('1'), verdict: 'unreviewed' },
      () => applyReviewDecisions(asExpo(d), [[id('1'), 'unreviewed']], AT + 200),
    );
  });

  it('flag toggle moves a done single out of and back into the feed edge states', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3']);
    let before = await snapshot(d);
    // Keep single 1 (leaves the feed), then flag it (state done → to_edit
    // outside the queue — arrays untouched, only the flag map moves).
    before = await expectParity(
      d,
      before,
      { kind: 'verdict', assetId: id('1'), verdict: 'kept' },
      () => applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100),
    );
    before = await expectParity(
      d,
      before,
      { kind: 'flag', assetId: id('1'), needsEdit: true },
      () =>
        applyReviewDecisions(asExpo(d), [], AT + 200, {
          needsEditChanges: [{ assetId: id('1'), needsEdit: true }],
        }),
    );
    await expectParity(d, before, { kind: 'flag', assetId: id('1'), needsEdit: false }, () =>
      applyReviewDecisions(asExpo(d), [], AT + 300, {
        needsEditChanges: [{ assetId: id('1'), needsEdit: false }],
      }),
    );
  });

  it('flag toggle on an unreviewed group member keeps its state', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    const before = await snapshot(d);
    await expectParity(d, before, { kind: 'flag', assetId: id('1'), needsEdit: true }, () =>
      applyReviewDecisions(asExpo(d), [], AT + 100, {
        needsEditChanges: [{ assetId: id('1'), needsEdit: true }],
      }),
    );
  });

  it('favourite intents round-trip: queue-apply, cancel, queue-remove', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    let before = await snapshot(d);
    const steps: { state: 'queued_apply' | 'none' | 'queued_remove'; target: boolean | null }[] = [
      { state: 'queued_apply', target: true },
      { state: 'none', target: null },
    ];
    for (const step of steps) {
      const intent = { assetId: id('1'), state: step.state, target: step.target };
      before = await expectParity(d, before, { kind: 'favourite', intent }, () =>
        applyReviewDecisions(asExpo(d), [], AT + 100, { favouriteChanges: [intent] }),
      );
    }
  });

  it('redecide keep rescues a staged cull and keeps its queued edit', async () => {
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 100, {
      needsEditChanges: [{ assetId: id('1'), needsEdit: true }],
    });
    const before = await snapshot(d);
    expect(before.needsEdit.has(id('1'))).toBe(true);
    const after = await expectParity(
      d,
      before,
      { kind: 'redecide', assetId: id('1'), target: 'keep' },
      () => applyRedecision(asExpo(d), id('1'), 'keep', AT + 200),
    );
    expect(after.needsEdit.has(id('1'))).toBe(true);
  });

  it('redecide on an unreviewed member is a stale-sheet no-op in BOTH layers', async () => {
    // The SQL guards on state IN ('culled','kept') and matches no row —
    // the patch must refuse identically, or the deck shows a phantom
    // kept until the reconciling refresh reverts it.
    const d = await fresh();
    await seed(d, ['1', '2'], [['1', '2']]);
    const before = await snapshot(d);
    await expectParity(d, before, { kind: 'redecide', assetId: id('1'), target: 'keep' }, () =>
      applyRedecision(asExpo(d), id('1'), 'keep', AT + 200),
    );
  });

  it('unstage lands on done (feed exit) or to_edit when flagged', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'culled']], AT + 100);
    await applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 100);
    await applyReviewDecisions(asExpo(d), [], AT + 150, {
      needsEditChanges: [{ assetId: id('2'), needsEdit: true }],
    });
    let before = await snapshot(d);
    before = await expectParity(d, before, { kind: 'unstage', assetId: id('1') }, () =>
      unstageCullDirect(asExpo(d), id('1'), AT + 200, true),
    );
    await expectParity(d, before, { kind: 'unstage', assetId: id('2') }, () =>
      unstageCullDirect(asExpo(d), id('2'), AT + 300, true),
    );
  });

  it('restore keeps a queued edit on the photo it returns to the pool', async () => {
    // The patch used to clear the flag here while the SQL kept it — the
    // deck would show the edit badge vanish, then reappear on refresh.
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    await applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 100, {
      needsEditChanges: [{ assetId: id('2'), needsEdit: true }],
    });
    const before = await snapshot(d);
    expect(before.needsEdit.has(id('2'))).toBe(true);
    const after = await expectParity(d, before, { kind: 'restore', assetId: id('2') }, () =>
      restoreCarriedCull(asExpo(d), id('2'), AT + 200),
    );
    expect(after.needsEdit.has(id('2'))).toBe(true);
  });

  it('restore returns a staged cull to the unreviewed pool', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    await applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 100);
    const before = await snapshot(d);
    await expectParity(d, before, { kind: 'restore', assetId: id('2') }, () =>
      restoreCarriedCull(asExpo(d), id('2'), AT + 200),
    );
  });

  it('compare-cull: loser culled and the duel recorded in one transaction', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2', '3']]);
    // Member 3 is kept first: a verdict-writing duel claims the whole
    // table, so every alive member must be an endpoint (F15).
    await applyReviewDecisions(asExpo(d), [[id('3'), 'kept']], AT + 50);
    const before = await snapshot(d);
    const groupId = before.groups[0]!.groupId;
    await expectParity(
      d,
      before,
      { kind: 'duel', groupId, winnerId: id('1'), loserId: id('2'), mode: 'cull' },
      () =>
        applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 100, {
          duel: {
            groupId: String(groupId),
            winnerId: id('1'),
            loserId: id('2'),
            keptBoth: false,
            at: AT + 100,
          },
        }),
    );
  });

  it('compare keep-both (F15): BOTH kept in one transaction; the group leaves the queue', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2']]);
    const before = await snapshot(d);
    const groupId = before.groups[0]!.groupId;
    const after = await expectParity(
      d,
      before,
      { kind: 'duel', groupId, winnerId: id('1'), loserId: id('2'), mode: 'keepBoth' },
      () =>
        applyReviewDecisions(
          asExpo(d),
          [
            [id('1'), 'kept'],
            [id('2'), 'kept'],
          ],
          AT + 100,
          {
            duel: {
              groupId: String(groupId),
              winnerId: id('1'),
              loserId: id('2'),
              keptBoth: true,
              at: AT + 100,
            },
          },
        ),
    );
    // Both decided → the pair leaves the queue entirely.
    expect(after.groups.some((g) => g.groupId === groupId)).toBe(false);
  });

  it("triage 'Keep this one' (D7): a targeted keep on the winner, no whole-table claim", async () => {
    const d = await fresh();
    // Member 3 stays undecided — the duel is NOT the whole table, and the
    // narrow claim must let the keep through where the whole-table guard
    // would have thrown.
    await seed(d, ['1', '2', '3', '4'], [['1', '2', '3']]);
    const before = await snapshot(d);
    const groupId = before.groups[0]!.groupId;
    const after = await expectParity(
      d,
      before,
      { kind: 'duel', groupId, winnerId: id('1'), loserId: id('2'), mode: 'keepWinner' },
      () =>
        applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100, {
          duel: {
            groupId: String(groupId),
            winnerId: id('1'),
            loserId: id('2'),
            keptBoth: null,
            at: AT + 100,
          },
          duelClaimsWholeTable: false,
        }),
    );
    // The winner alone is kept; the loser and the outsider stay open,
    // so the group stays queued.
    const group = after.groups.find((g) => g.groupId === groupId)!;
    expect(group.members.find((m) => m.asset_id === id('1'))!.state).toBe('kept');
    expect(group.members.find((m) => m.asset_id === id('2'))!.state).toBe('unreviewed');
    expect(group.members.find((m) => m.asset_id === id('3'))!.state).toBe('unreviewed');
  });

  it('a verdict-carrying duel WITHOUT the narrow opt-out still claims the whole table', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3', '4'], [['1', '2', '3']]);
    const before = await snapshot(d);
    const groupId = before.groups[0]!.groupId;
    // Member 3 is an undecided outsider: the whole-table revalidation
    // must reject the claim (fail-closed default).
    await expect(
      applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100, {
        duel: {
          groupId: String(groupId),
          winnerId: id('1'),
          loserId: id('2'),
          keptBoth: null,
          at: AT + 100,
        },
      }),
    ).rejects.toThrow(/group changed while comparing/);
  });

  it('make-single ejects into feed order; a 2-member group dissolves whole', async () => {
    const d = await fresh();
    await seed(
      d,
      ['1', '2', '3', '4', '5', '6'],
      [
        ['1', '2', '3'],
        ['4', '5'],
      ],
    );
    let before = await snapshot(d);
    const trio = before.groups.find((g) => g.members.some((m) => m.asset_id === id('1')))!;
    before = await expectParity(
      d,
      before,
      { kind: 'makeSingle', assetId: id('2'), groupId: trio.groupId },
      () => ejectNotRelated(asExpo(d), [id('2')], AT + 100, trio.groupId),
    );
    const pair = before.groups.find((g) => g.members.some((m) => m.asset_id === id('4')))!;
    await expectParity(
      d,
      before,
      { kind: 'makeSingle', assetId: id('4'), groupId: pair.groupId },
      () => ejectNotRelated(asExpo(d), [id('4')], AT + 100, pair.groupId),
    );
  });

  it('keep-many finishes a group: it leaves the queue and counts empty', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3', '4'], [['1', '2', '3']]);
    const before = await snapshot(d);
    await expectParity(d, before, { kind: 'keepMany', assetIds: [id('1'), id('2'), id('3')] }, () =>
      applyReviewDecisions(
        asExpo(d),
        [
          [id('1'), 'kept'],
          [id('2'), 'kept'],
          [id('3'), 'kept'],
        ],
        AT + 100,
      ),
    );
  });

  it('the last unreviewed member deciding drops the group from the queue', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3'], [['1', '2']]);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 100);
    const before = await snapshot(d);
    await expectParity(d, before, { kind: 'verdict', assetId: id('2'), verdict: 'culled' }, () =>
      applyReviewDecisions(asExpo(d), [[id('2'), 'culled']], AT + 200),
    );
  });
});
