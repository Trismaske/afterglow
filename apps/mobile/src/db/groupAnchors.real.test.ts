/**
 * The group anchors (v25, m0.9 phase 8) on real SQLite: every audited
 * membership writer leaves the stored anchors equal to the aggregate
 * they cache (auditGroupAnchors), publishes on the membership signal
 * exactly when it changed the browse structure, and the two group
 * reads walk idx_groups_anchor when the reach filter collapses — while
 * a card out still orders by the newest REACHABLE member.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase, withWriteTransaction } from './database';
import {
  applyReviewDecisions,
  auditGroupAnchors,
  collapseReach,
  ejectNotRelated,
  fetchBrowseGroupsPage,
  listReviewGroups,
  repairGroupMembership,
  updatePhotoUri,
  writeContinuousGroups,
  type ContinuousPhotoUpsert,
} from './store';
import { commitOrganizeOutcomes } from './organizeStore';
import {
  markBatchLaunching,
  prepareTrashBatch,
  reconcileExternallyRemoved,
  resolveTrashBatch,
} from './trashStore';
import { forgetVolume } from './volumeLifecycle';
import { membershipVersion } from './membershipSignal';
import { foreignKeyCheck, openTestDb, type TestDb } from './testDb';

const open: TestDb[] = [];
const AT = 1_800_000_000_000;
const T = AT - 3_600_000;
const SD = '0a91-e18d';

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

function upsert(
  rawId: string,
  takenAt: number,
  volume = 'external_primary',
): ContinuousPhotoUpsert {
  return {
    assetId: `${volume}/${rawId}`,
    uri: `file:///${volume}/dcim/${rawId}.jpg`,
    takenAt,
    modTime: takenAt,
    fileGeneration: null,
    kind: 'photo',
    mimeType: 'image/jpeg',
    displayName: null,
    width: null,
    height: null,
    durationMs: null,
    fileMtime: takenAt,
    day: '2027-01-15',
    volumeName: volume,
    rawId,
    sizeBytes: 1_000,
  };
}
const id = (rawId: string, volume = 'external_primary'): string => `${volume}/${rawId}`;

function anchorOf(d: TestDb, groupId: number): number | null {
  const row = d.raw.prepare('SELECT anchor FROM photo_groups WHERE id = ?').get(groupId) as
    { anchor: number | null } | undefined;
  return row === undefined ? null : row.anchor;
}
function groupOf(d: TestDb, assetId: string): number | null {
  const row = d.raw
    .prepare('SELECT group_id FROM photo_group_assignments WHERE photo_id = ?')
    .get(assetId) as { group_id: number | null } | undefined;
  return row?.group_id ?? null;
}

/** Two groups and two singles, the scan's way. */
async function seed(d: TestDb): Promise<{ a: number; b: number }> {
  await writeContinuousGroups(
    asExpo(d),
    {
      photos: [
        upsert('a1', T + 900),
        upsert('a2', T + 800),
        upsert('a3', T + 700),
        upsert('b1', T + 500),
        upsert('b2', T + 400),
        upsert('s1', T + 600),
        upsert('s2', T + 300),
      ],
      groups: [
        {
          members: [id('a1'), id('a2'), id('a3')],
          timeAttached: [],
          parts: [[id('a1'), id('a2'), id('a3')]],
        },
        { members: [id('b1'), id('b2')], timeAttached: [], parts: [[id('b1'), id('b2')]] },
      ],
      singles: [id('s1'), id('s2')],
    },
    AT,
  );
  return { a: groupOf(d, id('a1'))!, b: groupOf(d, id('b1'))! };
}

const absent = async () => 'absent' as const;

async function trashViaBatch(d: TestDb, assetId: string, at: number): Promise<void> {
  await applyReviewDecisions(asExpo(d), [[assetId, 'culled']], at);
  const batch = await prepareTrashBatch(
    asExpo(d),
    [{ photoId: assetId, measuredBytes: 1_000 }],
    at,
  );
  await markBatchLaunching(asExpo(d), batch!.batchId, at + 1);
  await resolveTrashBatch(asExpo(d), {
    batchId: batch!.batchId,
    verify: absent,
    dialog: 'applied',
    at: at + 2,
  });
}

describe('the anchor write-through across the audited membership writers', () => {
  it('a scan window writes the anchors it lands; an identical re-scan window changes and publishes nothing', async () => {
    const d = await fresh();
    const v0 = membershipVersion();
    const { a, b } = await seed(d);
    expect(anchorOf(d, a)).toBe(T + 900);
    expect(anchorOf(d, b)).toBe(T + 500);
    expect(await auditGroupAnchors(asExpo(d))).toEqual([]);
    expect(membershipVersion()).toBe(v0 + 1);
    // The identical window: no assignment written, no anchor moved.
    const changed = await writeContinuousGroups(
      asExpo(d),
      {
        photos: [upsert('a1', T + 900), upsert('a2', T + 800), upsert('a3', T + 700)],
        groups: [
          {
            members: [id('a1'), id('a2'), id('a3')],
            timeAttached: [],
            parts: [[id('a1'), id('a2'), id('a3')]],
          },
        ],
        singles: [],
      },
      AT + 1,
    );
    expect(changed).toBe(false);
    expect(membershipVersion()).toBe(v0 + 1);
    expect(await auditGroupAnchors(asExpo(d))).toEqual([]);
  });

  it('a window that moves a member in time (the EXIF rescue) moves the anchor of an otherwise identical group', async () => {
    const d = await fresh();
    const { a } = await seed(d);
    const v0 = membershipVersion();
    const changed = await writeContinuousGroups(
      asExpo(d),
      {
        photos: [upsert('a1', T + 950), upsert('a2', T + 800), upsert('a3', T + 700)],
        groups: [
          {
            members: [id('a1'), id('a2'), id('a3')],
            timeAttached: [],
            parts: [[id('a1'), id('a2'), id('a3')]],
          },
        ],
        singles: [],
      },
      AT + 1,
    );
    expect(changed).toBe(true);
    expect(membershipVersion()).toBe(v0 + 1);
    expect(anchorOf(d, a)).toBe(T + 950);
    expect(await auditGroupAnchors(asExpo(d))).toEqual([]);
  });

  it('a window that only moves a row to another path (an organize move) or re-dates it publishes too', async () => {
    const d = await fresh();
    await seed(d);
    const v0 = membershipVersion();
    const moved = await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          { ...upsert('s1', T + 600), uri: 'file:///external_primary/Pictures/Trips/s1.jpg' },
        ],
        groups: [],
        singles: [id('s1')],
      },
      AT + 1,
    );
    expect(moved).toBe(true);
    expect(membershipVersion()).toBe(v0 + 1);
    const redated = await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          {
            ...upsert('s1', T + 600),
            uri: 'file:///external_primary/Pictures/Trips/s1.jpg',
            day: null,
          },
        ],
        groups: [],
        singles: [id('s1')],
      },
      AT + 2,
    );
    expect(redated).toBe(true);
    expect(membershipVersion()).toBe(v0 + 2);
  });

  it('a window that re-versions a row (an in-place edit) or lands its clip publishes; a plain refresh does not (codex r3)', async () => {
    const d = await fresh();
    await seed(d);
    const v0 = membershipVersion();
    const same = await writeContinuousGroups(
      asExpo(d),
      { photos: [upsert('s1', T + 600)], groups: [], singles: [id('s1')] },
      AT + 1,
    );
    expect(same).toBe(false);
    expect(membershipVersion()).toBe(v0);
    const edited = await writeContinuousGroups(
      asExpo(d),
      {
        photos: [{ ...upsert('s1', T + 600), fileGeneration: 77 }],
        groups: [],
        singles: [id('s1')],
      },
      AT + 2,
    );
    expect(edited).toBe(true);
    expect(membershipVersion()).toBe(v0 + 1);
    // The known generation survives a pass without one: no change.
    const carried = await writeContinuousGroups(
      asExpo(d),
      { photos: [upsert('s1', T + 600)], groups: [], singles: [id('s1')] },
      AT + 3,
    );
    expect(carried).toBe(false);
    const clip = await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          {
            ...upsert('s1', T + 600),
            fileGeneration: 77,
            motionVideoOffset: 1_000,
            motionVideoLength: 2_000,
            factsCheckedVersion: 77,
          },
        ],
        groups: [],
        singles: [id('s1')],
      },
      AT + 4,
    );
    expect(clip).toBe(true);
    expect(membershipVersion()).toBe(v0 + 2);
  });

  it('resolving a trash batch whose member was already reconciled absent publishes nothing (codex r3)', async () => {
    const d = await fresh();
    await seed(d);
    await applyReviewDecisions(asExpo(d), [[id('s2'), 'culled']], AT + 1);
    const batch = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: id('s2'), measuredBytes: 1 }],
      AT + 1,
    );
    await markBatchLaunching(asExpo(d), batch!.batchId, AT + 2);
    await reconcileExternallyRemoved(asExpo(d), [id('s2')], AT + 3);
    const v0 = membershipVersion();
    await resolveTrashBatch(asExpo(d), {
      batchId: batch!.batchId,
      verify: absent,
      dialog: 'applied',
      at: AT + 4,
    });
    expect(membershipVersion()).toBe(v0);
    expect(await auditGroupAnchors(asExpo(d))).toEqual([]);
  });

  it('the two direct uri writers publish only when the uri actually changed (codex r2)', async () => {
    const d = await fresh();
    await seed(d);
    const v0 = membershipVersion();
    await updatePhotoUri(asExpo(d), id('s1'), 'file:///external_primary/dcim/s1.jpg'); // unchanged
    expect(membershipVersion()).toBe(v0);
    await updatePhotoUri(asExpo(d), id('s1'), 'file:///external_primary/Pictures/s1.jpg');
    expect(membershipVersion()).toBe(v0 + 1);
    await commitOrganizeOutcomes(
      asExpo(d),
      [
        {
          photoId: id('s2'),
          status: 'moved',
          message: 'ok',
          newData: '/storage/emulated/0/Pictures/Trips/s2.jpg',
          volumeName: 'external_primary',
          relativePath: 'Pictures/Trips/',
        },
      ],
      AT + 1,
    );
    expect(membershipVersion()).toBe(v0 + 2);
    // The same outcome again moves nothing.
    await commitOrganizeOutcomes(
      asExpo(d),
      [
        {
          photoId: id('s2'),
          status: 'moved',
          message: 'ok',
          newData: '/storage/emulated/0/Pictures/Trips/s2.jpg',
          volumeName: 'external_primary',
          relativePath: 'Pictures/Trips/',
        },
      ],
      AT + 2,
    );
    expect(membershipVersion()).toBe(v0 + 2);
  });

  it('"not related" ejecting the newest member drops the anchor to the next; ejecting from a pair dissolves it', async () => {
    const d = await fresh();
    const { a, b } = await seed(d);
    const v0 = membershipVersion();
    await ejectNotRelated(asExpo(d), [id('a1')], AT + 1, a);
    expect(anchorOf(d, a)).toBe(T + 800);
    expect(membershipVersion()).toBe(v0 + 1);
    await ejectNotRelated(asExpo(d), [id('b2')], AT + 2, b);
    expect(anchorOf(d, b)).toBeNull(); // the group is gone
    expect(groupOf(d, id('b1'))).toBeNull();
    expect(membershipVersion()).toBe(v0 + 2);
    expect(await auditGroupAnchors(asExpo(d))).toEqual([]);
    // Ejecting an already-single photo records nothing structural.
    await ejectNotRelated(asExpo(d), [id('s1')], AT + 3);
    expect(membershipVersion()).toBe(v0 + 2);
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('the trash confirmation, external-removal reconciliation and the scan restore transition move the anchor with presence', async () => {
    const d = await fresh();
    const { a } = await seed(d);
    let v = membershipVersion();
    await trashViaBatch(d, id('a1'), AT + 1);
    expect(anchorOf(d, a)).toBe(T + 800);
    expect(membershipVersion()).toBe(v + 1);
    expect(await auditGroupAnchors(asExpo(d))).toEqual([]);
    v = membershipVersion();
    await reconcileExternallyRemoved(asExpo(d), [id('a2')], AT + 10);
    expect(anchorOf(d, a)).toBeNull(); // one present member left: dissolved
    expect(groupOf(d, id('a3'))).toBeNull();
    expect(membershipVersion()).toBe(v + 1);
    // Re-reporting a known tombstone changes nothing.
    await reconcileExternallyRemoved(asExpo(d), [id('a2')], AT + 11);
    expect(membershipVersion()).toBe(v + 1);
    // Gallery restores both: the next window regroups them and the
    // anchor returns with the presence flip.
    const changed = await writeContinuousGroups(
      asExpo(d),
      {
        photos: [upsert('a1', T + 900), upsert('a2', T + 800), upsert('a3', T + 700)],
        groups: [
          {
            members: [id('a1'), id('a2'), id('a3')],
            timeAttached: [],
            parts: [[id('a1'), id('a2'), id('a3')]],
          },
        ],
        singles: [],
      },
      AT + 20,
    );
    expect(changed).toBe(true);
    const regrouped = groupOf(d, id('a1'))!;
    expect(anchorOf(d, regrouped)).toBe(T + 900);
    expect(await auditGroupAnchors(asExpo(d))).toEqual([]);
  });

  it('"Forget this card" tombstones (keep) or erases the card members of a mixed group and the anchor follows', async () => {
    const d = await fresh();
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          upsert('m1', T + 900, SD),
          upsert('m2', T + 800),
          upsert('m3', T + 700),
          upsert('n1', T + 600, SD),
          upsert('n2', T + 500),
          upsert('n3', T + 400),
        ],
        groups: [
          {
            members: [id('m1', SD), id('m2'), id('m3')],
            timeAttached: [],
            parts: [[id('m1', SD), id('m2'), id('m3')]],
          },
          {
            members: [id('n1', SD), id('n2'), id('n3')],
            timeAttached: [],
            parts: [[id('n1', SD), id('n2'), id('n3')]],
          },
        ],
        singles: [],
      },
      AT,
    );
    const m = groupOf(d, id('m2'))!;
    const n = groupOf(d, id('n2'))!;
    const v0 = membershipVersion();
    await forgetVolume(asExpo(d), SD, 'keep', AT + 1);
    expect(anchorOf(d, m)).toBe(T + 800);
    expect(anchorOf(d, n)).toBe(T + 500);
    expect(membershipVersion()).toBe(v0 + 1);
    expect(await auditGroupAnchors(asExpo(d))).toEqual([]);
    // Erasing the tombstones deletes the rows (assignments cascade) but
    // changes no structure — they were already absent — so nothing
    // publishes; the audit still holds.
    await forgetVolume(asExpo(d), SD, 'erase', AT + 2);
    expect(await auditGroupAnchors(asExpo(d))).toEqual([]);
    expect(foreignKeyCheck(d)).toEqual([]);
    expect(membershipVersion()).toBe(v0 + 1);
    // A card with nothing on it publishes nothing either.
    await forgetVolume(asExpo(d), SD, 'keep', AT + 3);
    expect(membershipVersion()).toBe(v0 + 1);
  });

  it('the audit names a drifted anchor and refuses a present-but-trashed row', async () => {
    const d = await fresh();
    const { a } = await seed(d);
    d.raw.prepare('UPDATE photo_groups SET anchor = ? WHERE id = ?').run(T + 1, a);
    expect(await auditGroupAnchors(asExpo(d))).toEqual([
      { groupId: a, stored: T + 1, expected: T + 900 },
    ]);
    expect(await auditGroupAnchors(asExpo(d), [a])).toHaveLength(1);
    await withWriteTransaction(asExpo(d), async (txn) => {
      expect(await repairGroupMembership(txn, [a])).toBe(1);
    });
    expect(await auditGroupAnchors(asExpo(d))).toEqual([]);
    d.raw.prepare("UPDATE photos SET state = 'trashed' WHERE asset_id = ?").run(id('s1'));
    await expect(auditGroupAnchors(asExpo(d))).rejects.toThrow(/presence invariant/);
  });
});

describe('the group reads over the anchor', () => {
  it('the browse page and the pending read walk idx_groups_anchor when the reach filter is collapsed', async () => {
    const d = await fresh();
    await seed(d);
    const browse = d.raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT g.id, g.anchor FROM photo_groups g
          WHERE g.anchor IS NOT NULL AND g.anchor <= ? AND (g.anchor < ? OR g.id < ?)
          ORDER BY g.anchor DESC, g.id DESC LIMIT 40`,
      )
      .all(T, T, 1) as { detail: string }[];
    const browsePlan = browse.map((r) => r.detail).join(' | ');
    expect(browsePlan).toMatch(/idx_groups_anchor/);
    expect(browsePlan).not.toMatch(/TEMP B-TREE/);
    const pending = d.raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT g.id, g.anchor FROM photo_groups g
          WHERE g.anchor IS NOT NULL AND EXISTS (
            SELECT 1 FROM photo_group_assignments a CROSS JOIN photos p
            WHERE a.group_id = g.id AND p.asset_id = a.photo_id
              AND p.state = 'unreviewed' AND p.is_present = 1)
          ORDER BY g.anchor DESC, g.id DESC LIMIT 40`,
      )
      .all() as { detail: string }[];
    const pendingPlan = pending.map((r) => r.detail).join(' | ');
    expect(pendingPlan).toMatch(/idx_groups_anchor/);
    expect(pendingPlan).not.toMatch(/TEMP B-TREE/);
  });

  it('collapseReach folds a mounted set covering every present photo into no filter, and keeps one that does not', async () => {
    const d = await fresh();
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [upsert('p1', T + 100), upsert('c1', T + 900, SD)],
        groups: [],
        singles: [id('p1'), id('c1', SD)],
      },
      AT,
    );
    expect(await collapseReach(asExpo(d), ['external_primary', SD])).toBeNull();
    expect(await collapseReach(asExpo(d), ['external_primary'])).toEqual(['external_primary']);
    expect(await collapseReach(asExpo(d), null)).toBeNull();
    expect(await collapseReach(asExpo(d), [])).toEqual([]);
    // A tombstoned card member no longer holds the filter open.
    await forgetVolume(asExpo(d), SD, 'keep', AT + 1);
    expect(await collapseReach(asExpo(d), ['external_primary'])).toBeNull();
  });

  it('with a card out, both reads order a mixed group by its newest REACHABLE member and name the hidden one', async () => {
    const d = await fresh();
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          upsert('m1', T + 900, SD),
          upsert('m2', T + 100),
          upsert('m3', T + 90),
          upsert('n1', T + 500),
          upsert('n2', T + 400),
        ],
        groups: [
          {
            members: [id('m1', SD), id('m2'), id('m3')],
            timeAttached: [],
            parts: [[id('m1', SD), id('m2'), id('m3')]],
          },
          { members: [id('n1'), id('n2')], timeAttached: [], parts: [[id('n1'), id('n2')]] },
        ],
        singles: [],
      },
      AT,
    );
    const all = await fetchBrowseGroupsPage(asExpo(d), null, null, undefined, 10);
    expect(all.map((g) => g.anchor)).toEqual([T + 900, T + 500]);
    const cardOut = await fetchBrowseGroupsPage(
      asExpo(d),
      null,
      ['external_primary'],
      undefined,
      10,
    );
    expect(cardOut.map((g) => [g.anchor, g.unreachableCount])).toEqual([
      [T + 500, 0],
      [T + 100, 1],
    ]);
    expect(cardOut[1].members.map((m) => m.asset_id)).toEqual([id('m2'), id('m3')]);
    // The keyset past the first card-out page continues on the same key.
    const rest = await fetchBrowseGroupsPage(
      asExpo(d),
      null,
      ['external_primary'],
      { anchor: T + 500, groupId: cardOut[0].groupId },
      10,
    );
    expect(rest.map((g) => g.anchor)).toEqual([T + 100]);
    const pendingAll = await listReviewGroups(asExpo(d), 10, null, null);
    expect(pendingAll.map((g) => g.members[0].asset_id)).toEqual([id('m1', SD), id('n1')]);
    const pendingOut = await listReviewGroups(asExpo(d), 10, null, ['external_primary']);
    expect(pendingOut.map((g) => [g.members[0].asset_id, g.unreachableCount])).toEqual([
      [id('n1'), 0],
      [id('m2'), 1],
    ]);
  });
});
