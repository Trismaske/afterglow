/**
 * The per-volume scan contract's DB half on real SQLite (m0.8.3 phase 2,
 * plan §4): the store reads the scan runner drives its reconciliation
 * with must EXCLUDE an unmounted volume's rows entirely (invariants
 * 2 + 6), and a pass over the mounted remainder must leave the ejected
 * volume's rows BYTE-FOR-BYTE intact (invariant 3's zero-row-change
 * test — here at the store layer; the physical-eject run is the manual
 * device matrix's job).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  countReviewQueue,
  countStagedCulls,
  countTrackedByVolume,
  getCoverageByDay,
  getGroupAssignments,
  getPresentAssetIds,
  getReviewGroup,
  listSinglesFeed,
  writeContinuousGroups,
  type ContinuousPhotoUpsert,
} from './store';
import { reconcileExternallyRemoved } from './trashStore';
import { openTestDb, type TestDb } from './testDb';

const open: TestDb[] = [];
const AT = 1_800_000_000_000;
const PRIMARY = 'external_primary';
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

function photo(volume: string, rawId: string, takenAt = AT - 3_600_000): ContinuousPhotoUpsert {
  return {
    assetId: `${volume}/${rawId}`,
    uri:
      volume === PRIMARY
        ? `file:///storage/emulated/0/DCIM/Camera/${rawId}.jpg`
        : `file:///storage/0A91-E18D/DCIM/100MSDCF/${rawId}.jpg`,
    takenAt,
    modTime: takenAt,
    day: '2027-01-15',
    volumeName: volume,
    rawId,
    sizeBytes: 1_000,
  };
}

/** Every photos row + assignment for a volume, as comparable JSON. */
function volumeSnapshot(d: TestDb, volume: string): string {
  const photos = d.raw
    .prepare('SELECT * FROM photos WHERE volume_name = ? ORDER BY asset_id')
    .all(volume);
  const assignments = d.raw
    .prepare(
      `SELECT a.* FROM photo_group_assignments a
        JOIN photos p ON p.asset_id = a.photo_id
       WHERE p.volume_name = ? ORDER BY a.photo_id`,
    )
    .all(volume);
  return JSON.stringify({ photos, assignments });
}

/** Seed a mixed library: primary singles, an SD single, and a
 * CROSS-VOLUME group (D9: groups may span volumes). */
async function seedMixed(d: TestDb): Promise<void> {
  await writeContinuousGroups(
    asExpo(d),
    {
      photos: [photo(PRIMARY, 'p1'), photo(PRIMARY, 'p2'), photo(SD, 'sd1'), photo(SD, 'sd2')],
      groups: [{ members: [`${PRIMARY}/p1`, `${SD}/sd1`], timeAttached: [] }],
      singles: [`${PRIMARY}/p2`, `${SD}/sd2`],
    },
    AT,
  );
}

describe('unmounted volumes are outside every reconciliation read (invariants 2 + 6)', () => {
  it('getPresentAssetIds scoped to mounted volumes returns no ejected rows', async () => {
    const d = await fresh();
    await seedMixed(d);
    // Card in: both volumes' rows are candidates.
    const all = await getPresentAssetIds(asExpo(d), null, [PRIMARY, SD]);
    expect(all.sort()).toEqual([`${SD}/sd1`, `${SD}/sd2`, `${PRIMARY}/p1`, `${PRIMARY}/p2`].sort());
    // Card out: the SD rows are not candidates — never probed, never
    // eligible for an absence conclusion.
    const mountedOnly = await getPresentAssetIds(asExpo(d), null, [PRIMARY]);
    expect(mountedOnly.sort()).toEqual([`${PRIMARY}/p1`, `${PRIMARY}/p2`].sort());
    // Nothing mounted at all (SD-only source, card out): zero candidates,
    // not an SQL error.
    expect(await getPresentAssetIds(asExpo(d), null, [])).toEqual([]);
  });

  it('countTrackedByVolume answers per volume, so tripwires never mix volumes', async () => {
    const d = await fresh();
    await seedMixed(d);
    expect(await countTrackedByVolume(asExpo(d))).toEqual({ [PRIMARY]: 2, [SD]: 2 });
  });
});

describe('eject → pass over the mounted remainder → zero SD row changes (invariant 3)', () => {
  it('a primary-only follow-up pass leaves every SD row and assignment byte-for-byte', async () => {
    const d = await fresh();
    await seedMixed(d);
    const before = volumeSnapshot(d, SD);

    // The scan with the card OUT: pages return only primary photos; the
    // cross-volume group {p1, sd1} is FROZEN by the regroup boundary
    // (unreachable member), so the runner's plan re-writes only what it
    // fully sees — here p2 re-windowed with a new primary photo p3.
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [photo(PRIMARY, 'p2'), photo(PRIMARY, 'p3', AT - 3_500_000)],
        groups: [{ members: [`${PRIMARY}/p2`, `${PRIMARY}/p3`], timeAttached: [] }],
        singles: [],
      },
      AT + 1000,
    );
    // A real deletion concluded on the MOUNTED volume (invariant 6 allows
    // it there) must still not touch the ejected volume's rows.
    await reconcileExternallyRemoved(asExpo(d), [`${PRIMARY}/p3`], AT + 2000);

    expect(volumeSnapshot(d, SD)).toBe(before);
    // And the ejected rows are still present-tracked (unmounted ≠ deleted).
    expect(await countTrackedByVolume(asExpo(d))).toMatchObject({ [SD]: 2 });
  });

  it('a REAL deletion of a mixed group’s mounted member defers the dissolve while the card is out (codex phase-2)', async () => {
    const d = await fresh();
    await seedMixed(d);
    // p1 (primary, mounted) is genuinely deleted while sd1's card is out.
    // The membership repair must NOT clear sd1's assignment — the group
    // still holds an unreachable member, so the dissolve waits for a
    // pass that can see the whole group.
    await reconcileExternallyRemoved(asExpo(d), [`${PRIMARY}/p1`], AT + 1000, [PRIMARY]);
    const sd1 = (await getGroupAssignments(asExpo(d), [`${SD}/sd1`])).get(`${SD}/sd1`);
    expect(sd1?.groupId).not.toBeNull();
    // The deleted member itself is reconciled normally.
    expect(await getPresentAssetIds(asExpo(d), null, [PRIMARY])).toEqual([`${PRIMARY}/p2`]);

    // Remount (mounted set now covers both volumes): the same repair
    // dissolves the now-fully-visible rump group — deferred, not lost.
    const d2 = await fresh();
    await seedMixed(d2);
    await reconcileExternallyRemoved(asExpo(d2), [`${PRIMARY}/p1`], AT + 1000, [PRIMARY, SD]);
    const sd1After = (await getGroupAssignments(asExpo(d2), [`${SD}/sd1`])).get(`${SD}/sd1`);
    expect(sd1After?.groupId).toBeNull();
  });
});

describe('reachability is scope, not state (m0.8.3 phase 3, §5)', () => {
  it('queues, counts, coverage and the cull queue exclude unreachable photos; null mounted scopes nothing', async () => {
    const d = await fresh();
    await seedMixed(d);
    d.raw
      .prepare("UPDATE photos SET state = 'culled', culled_at = ? WHERE asset_id = ?")
      .run(AT, `${SD}/sd2`);

    // Card out: the SD single leaves the feed, the SD staged cull leaves
    // the queue, the counts and the day coverage shrink.
    expect((await listSinglesFeed(asExpo(d), 10, null, [PRIMARY])).map((r) => r.asset_id)).toEqual([
      `${PRIMARY}/p2`,
    ]);
    expect(await countStagedCulls(asExpo(d), [PRIMARY])).toBe(0);
    const counts = await countReviewQueue(asExpo(d), null, [PRIMARY]);
    expect(counts.grouped + counts.singles).toBe(2); // p1 (grouped) + p2
    const coverage = await getCoverageByDay(asExpo(d), null, null, [PRIMARY]);
    expect(coverage.find((r) => r.day === '2027-01-15')?.total).toBe(2);

    // Unknowable mounted set (null): no predicate — everything shows.
    expect((await listSinglesFeed(asExpo(d), 10, null, null)).length).toBe(2);
    expect(await countStagedCulls(asExpo(d), null)).toBe(1);
  });

  it('a partially-reachable group shows only reachable members and NAMES the hidden count', async () => {
    const d = await fresh();
    await seedMixed(d);
    const groupId = (await getGroupAssignments(asExpo(d), [`${PRIMARY}/p1`])).get(
      `${PRIMARY}/p1`,
    )!.groupId!;
    const cardOut = await getReviewGroup(asExpo(d), groupId, [PRIMARY]);
    expect(cardOut?.members.map((m) => m.asset_id)).toEqual([`${PRIMARY}/p1`]);
    expect(cardOut?.unreachableCount).toBe(1);
    // Remount: whole group, nothing hidden.
    const cardIn = await getReviewGroup(asExpo(d), groupId, [PRIMARY, SD]);
    expect(cardIn?.members).toHaveLength(2);
    expect(cardIn?.unreachableCount).toBe(0);
  });
});

describe('grow-only appends (m0.8.3 grilling): unreachable-frozen groups accept new members', () => {
  /** Cross-volume group {p1(primary), s1(SD)}; the SD card is out. */
  async function seedFrozenGroup(d: TestDb): Promise<number> {
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [photo(PRIMARY, 'p1'), photo(SD, 's1')],
        groups: [{ members: [`${PRIMARY}/p1`, `${SD}/s1`], timeAttached: [] }],
        singles: [],
      },
      AT,
    );
    const assignment = (await getGroupAssignments(asExpo(d), [`${PRIMARY}/p1`])).get(
      `${PRIMARY}/p1`,
    )!;
    return assignment.groupId!;
  }

  it('appends a new photo without touching any existing member row', async () => {
    const d = await fresh();
    const groupId = await seedFrozenGroup(d);
    const before = d.raw
      .prepare('SELECT * FROM photo_group_assignments WHERE photo_id = ?')
      .get(`${SD}/s1`);
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [photo(PRIMARY, 'p2', AT - 3_500_000)],
        groups: [],
        singles: [],
        appends: [{ groupId, members: [`${PRIMARY}/p2`], timeAttached: [] }],
      },
      AT + 100,
      { mountedVolumes: [PRIMARY] },
    );
    const assignments = await getGroupAssignments(asExpo(d), [
      `${PRIMARY}/p1`,
      `${PRIMARY}/p2`,
      `${SD}/s1`,
    ]);
    expect(assignments.get(`${PRIMARY}/p2`)!.groupId).toBe(groupId);
    expect(assignments.get(`${PRIMARY}/p1`)!.groupId).toBe(groupId);
    // The unreachable member's row is byte-for-byte identical.
    const after = d.raw
      .prepare('SELECT * FROM photo_group_assignments WHERE photo_id = ?')
      .get(`${SD}/s1`);
    expect(after).toEqual(before);
  });

  it('a target that got REVIEWED mid-flight degrades the append to a single', async () => {
    const d = await fresh();
    const groupId = await seedFrozenGroup(d);
    d.raw.prepare("UPDATE photos SET state = 'kept' WHERE asset_id = ?").run(`${PRIMARY}/p1`);
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [photo(PRIMARY, 'p2', AT - 3_500_000)],
        groups: [],
        singles: [],
        appends: [{ groupId, members: [`${PRIMARY}/p2`], timeAttached: [] }],
      },
      AT + 100,
      { mountedVolumes: [PRIMARY] },
    );
    const assignment = (await getGroupAssignments(asExpo(d), [`${PRIMARY}/p2`])).get(
      `${PRIMARY}/p2`,
    )!;
    expect(assignment.groupId).toBeNull();
    // The reviewed group itself is untouched.
    const members = d.raw
      .prepare('SELECT COUNT(*) AS n FROM photo_group_assignments WHERE group_id = ?')
      .get(groupId) as { n: number };
    expect(members.n).toBe(2);
  });
});
