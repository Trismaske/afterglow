/**
 * Continuous-grouping persistence on real SQLite (m0.8 gate 2):
 * writeContinuousGroups owns the single 'continuous' run, upserts photo
 * rows without ever touching review state, lands the engine's groups as
 * membership truth (v22 — no freeze), refuses to regroup a "not
 * related" pair, and projects the pass's IS_FAVORITE observations (F20).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  getGroupAssignments,
  getGroupMembers,
  writeContinuousGroups,
  type ContinuousPhotoUpsert,
} from './store';
import { getPhotoActions, queueAction } from './actions';
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

function upsert(rawId: string, takenAt = AT - 3_600_000): ContinuousPhotoUpsert {
  return {
    assetId: `external_primary/${rawId}`,
    uri: `file:///dcim/${rawId}.jpg`,
    takenAt,
    modTime: takenAt,
    day: '2027-01-15',
    volumeName: 'external_primary',
    rawId,
    sizeBytes: 1_000,
  };
}

const id = (rawId: string): string => `external_primary/${rawId}`;

describe('writeContinuousGroups', () => {
  it('writes groups + singles into one continuous run and keeps FKs clean', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2'), upsert('3')],
        groups: [{ members: [id('1'), id('2')], timeAttached: [] }],
        singles: [id('3')],
      },
      AT,
    );

    const runs = await db.getAllAsync<{ id: number; provenance: string }>(
      'SELECT id, provenance FROM grouping_runs',
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].provenance).toBe('continuous');

    const assignments = await getGroupAssignments(db, [id('1'), id('2'), id('3')]);
    expect(assignments.get(id('1'))).toEqual(assignments.get(id('2')));
    expect(assignments.get(id('1'))!.groupId).not.toBeNull();
    expect(assignments.get(id('3'))).toEqual({
      groupId: null,
      timeAttached: false,
    });
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('reuses the continuous run across windows (schema allows only one)', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2')],
        groups: [{ members: [id('1'), id('2')], timeAttached: [] }],
        singles: [],
      },
      AT,
    );
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('3'), upsert('4')],
        groups: [{ members: [id('3'), id('4')], timeAttached: [] }],
        singles: [],
      },
      AT + 1,
    );
    const runs = await db.getAllAsync('SELECT id FROM grouping_runs');
    expect(runs).toHaveLength(1);
    const assignments = await getGroupAssignments(db, [id('1'), id('3')]);
    expect(assignments.get(id('1'))!.groupId).not.toEqual(assignments.get(id('3'))!.groupId);
  });

  it('never touches an existing row review state or queue flags', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2')],
        groups: [{ members: [id('1'), id('2')], timeAttached: [] }],
        singles: [],
      },
      AT,
    );
    await db.runAsync("UPDATE photos SET state = 'culled' WHERE asset_id = ?", id('1'));
    await queueAction(db, id('1'), 'edit', AT);

    // Rescan upserts the same photo with fresh metadata.
    const changed = {
      ...upsert('1'),
      takenAt: AT - 100,
      modTime: AT + 5,
      uri: 'file:///dcim/1-v2.jpg',
    };
    await writeContinuousGroups(
      db,
      { photos: [changed, upsert('2')], groups: [], singles: [id('2')] },
      AT + 10,
    );

    const row = await db.getFirstAsync<{
      state: string;
      taken_at: number;
      mod_time: number;
      uri: string;
    }>('SELECT state, taken_at, mod_time, uri FROM photos WHERE asset_id = ?', id('1'));
    expect(row).toEqual({
      state: 'culled',
      taken_at: AT - 100,
      // The queued edit is LIVE even on a staged cull (m0.8.7, F21), so
      // the upsert preserves its detection baseline instead of
      // refreshing mod_time — refreshing would silently lose the edit
      // detection the user is waiting on.
      mod_time: AT - 3_600_000,
      uri: 'file:///dcim/1-v2.jpg',
    });
    // The queued edit is a separate layer, and the scan may not touch it.
    expect((await getPhotoActions(db, id('1'))).map((a) => [a.kind, a.state])).toEqual([
      ['edit', 'queued'],
    ]);
  });

  it('rebuilding moves assignments; a group left under 2 members dissolves', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2'), upsert('3')],
        groups: [{ members: [id('1'), id('2'), id('3')], timeAttached: [] }],
        singles: [],
      },
      AT,
    );
    const before = await getGroupAssignments(db, [id('1')]);
    const oldGroup = before.get(id('1'))!.groupId!;

    // The rescan regroups: 1+2 stay together, 3 leaves as a single.
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2'), upsert('3')],
        groups: [{ members: [id('1'), id('2')], timeAttached: [] }],
        singles: [id('3')],
      },
      AT + 10,
    );
    const after = await getGroupAssignments(db, [id('1'), id('2'), id('3')]);
    expect(after.get(id('1'))).toEqual(after.get(id('2')));
    expect(after.get(id('3'))!.groupId).toBeNull();
    // The abandoned group is gone entirely (repair deleted it).
    const members = await getGroupMembers(db, [oldGroup]);
    expect(members.size === 0 || members.get(oldGroup)?.length === 2).toBe(true);
    const emptyGroups = await db.getAllAsync<{ id: number }>(
      `SELECT id FROM photo_groups WHERE NOT EXISTS
         (SELECT 1 FROM photo_group_assignments a WHERE a.group_id = photo_groups.id)`,
    );
    expect(emptyGroups).toEqual([]);
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('round-trips the time_attached badge and clears it on regroup', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2')],
        groups: [{ members: [id('1'), id('2')], timeAttached: [id('2')] }],
        singles: [],
      },
      AT,
    );
    const flags = await db.getAllAsync<{ photo_id: string; time_attached: number }>(
      'SELECT photo_id, time_attached FROM photo_group_assignments ORDER BY photo_id',
    );
    expect(flags).toEqual([
      { photo_id: id('1'), time_attached: 0 },
      { photo_id: id('2'), time_attached: 1 },
    ]);

    // The embedding landed: the rescan rewrites the group as a real match.
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2')],
        groups: [{ members: [id('1'), id('2')], timeAttached: [] }],
        singles: [],
      },
      AT + 10,
    );
    const cleared = await db.getFirstAsync<{ time_attached: number }>(
      'SELECT time_attached FROM photo_group_assignments WHERE photo_id = ?',
      id('2'),
    );
    expect(cleared).toEqual({ time_attached: 0 });
  });

  it('clears the time-attached badge when repairs dissolve a group', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2')],
        groups: [{ members: [id('1'), id('2')], timeAttached: [id('1'), id('2')] }],
        singles: [],
      },
      AT,
    );
    // The rescan reassigns 1 as a single; 2's group dissolves via repair —
    // a durable single must never keep the "grouped by time" badge.
    await writeContinuousGroups(
      db,
      { photos: [upsert('1'), upsert('2')], groups: [], singles: [id('1')] },
      AT + 10,
    );
    const rows = await db.getAllAsync<{ photo_id: string; group_id: null; time_attached: number }>(
      'SELECT photo_id, group_id, time_attached FROM photo_group_assignments ORDER BY photo_id',
    );
    expect(rows).toEqual([
      { photo_id: id('1'), group_id: null, time_attached: 0 },
      { photo_id: id('2'), group_id: null, time_attached: 0 },
    ]);
  });

  it('hash sources are isolated: manipulator reads never see native rows', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      { photos: [upsert('1'), upsert('2')], groups: [], singles: [id('1'), id('2')] },
      AT,
    );
    const { setPhotoHash, getPhotoHashes } = await import('./store');
    await setPhotoHash(db, id('1'), 'aaaaaaaaaaaaaaaa', 1, 'native');
    await setPhotoHash(db, id('2'), 'bbbbbbbbbbbbbbbb', 1, 'manipulator');
    const manipulator = await getPhotoHashes(db, [id('1'), id('2')], 'manipulator');
    expect([...manipulator.keys()]).toEqual([id('2')]);
    const native = await getPhotoHashes(db, [id('1'), id('2')], 'native');
    expect([...native.keys()]).toEqual([id('1')]);
    // A producer switch overwrites the row and its source.
    await setPhotoHash(db, id('1'), 'cccccccccccccccc', 2, 'manipulator');
    const after = await getPhotoHashes(db, [id('1')], 'native');
    expect(after.size).toBe(0);
  });

  it('preserves the edit-detection mod_time baseline for queued-edit rows', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      { photos: [upsert('1'), upsert('2')], groups: [], singles: [id('1'), id('2')] },
      AT,
    );
    await db.runAsync("UPDATE photos SET state = 'kept' WHERE asset_id = ?", id('1'));
    await queueAction(db, id('1'), 'edit', AT);

    // The rescan sees a NEWER modificationTime (the pending in-place edit);
    // the queued photo's baseline must survive, the plain row must refresh.
    await writeContinuousGroups(
      db,
      {
        photos: [
          { ...upsert('1'), modTime: AT + 999 },
          { ...upsert('2'), modTime: AT + 999 },
        ],
        groups: [],
        singles: [],
      },
      AT + 10,
    );
    const rows = await db.getAllAsync<{ asset_id: string; mod_time: number }>(
      'SELECT asset_id, mod_time FROM photos ORDER BY asset_id',
    );
    expect(rows).toEqual([
      { asset_id: id('1'), mod_time: AT - 3_600_000 }, // baseline kept
      { asset_id: id('2'), mod_time: AT + 999 }, // ordinary refresh
    ]);
  });

  it('scan-only rows stay eligible for edited-copy detection', async () => {
    const d = await fresh();
    const db = asExpo(d);
    const { getDetectionTrackedAssets, insertDetectedCopyWithMatch } = await import('./store');
    // original (kept, edit queued) + a copy row the scan inserted before
    // detection ran.
    await writeContinuousGroups(
      db,
      { photos: [upsert('orig'), upsert('copy')], groups: [], singles: [id('orig'), id('copy')] },
      AT,
    );
    await db.runAsync(
      "UPDATE photos SET state = 'kept', activity_at = ? WHERE asset_id = ?",
      AT,
      id('orig'),
    );
    await queueAction(db, id('orig'), 'edit', AT);

    // The scan-only copy row is NOT detection-tracked; the reviewed one is.
    const tracked = await getDetectionTrackedAssets(db, [id('orig'), id('copy')]);
    expect(tracked.has(id('orig'))).toBe(true);
    expect(tracked.has(id('copy'))).toBe(false);

    // Detection records the match and TRACKS the scan-only row without
    // deciding it: a copy is a new photo, so it joins the review queue
    // like any other, and only activity_at marks it as already seen.
    const recorded = await insertDetectedCopyWithMatch(
      db,
      id('orig'),
      {
        assetId: id('copy'),
        uri: 'file:///dcim/copy.jpg',
        takenAt: AT,
        modTime: AT,
        day: '2027-01-15',
      },
      AT + 20,
      AT,
    );
    expect(recorded).toBe(true);
    const copyRow = await db.getFirstAsync<{ state: string; reviewed_at: number }>(
      'SELECT state, reviewed_at FROM photos WHERE asset_id = ?',
      id('copy'),
    );
    expect(copyRow).toEqual({ state: 'unreviewed', reviewed_at: null });
    // And it is now detection-tracked (no re-prompt on later runs).
    const after = await getDetectionTrackedAssets(db, [id('copy')]);
    expect(after.has(id('copy'))).toBe(true);
  });

  it('an excluded pair is never regrouped by a later scan write', async () => {
    const d = await fresh();
    const db = asExpo(d);
    const { ejectNotRelated } = await import('./store');
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2'), upsert('3')],
        groups: [{ members: [id('1'), id('2'), id('3')], timeAttached: [] }],
        singles: [],
      },
      AT,
    );
    // The user ejects photo 3 ("not related") — pairs (3→1), (3→2) land.
    await ejectNotRelated(db, [id('3')], AT + 5);

    // A STALE plan (computed before the eject) regroups all three; the
    // write-transaction revalidation must skip the violating group whole
    // — 1 and 2 keep their group, 3 stays the single the eject made it.
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2'), upsert('3')],
        groups: [{ members: [id('1'), id('2'), id('3')], timeAttached: [] }],
        singles: [],
      },
      AT + 10,
    );
    const rows = await db.getAllAsync<{
      photo_id: string;
      group_id: number | null;
    }>('SELECT photo_id, group_id FROM photo_group_assignments ORDER BY photo_id');
    expect(rows[0].group_id).not.toBeNull();
    expect(rows[0].group_id).toEqual(rows[1].group_id);
    expect(rows[2]).toEqual({ photo_id: id('3'), group_id: null });

    // A later plan grouping only the unexcluded pair is welcome — the
    // exclusions constrain exactly the recorded pairs, nothing more.
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2')],
        groups: [{ members: [id('1'), id('2')], timeAttached: [] }],
        singles: [],
      },
      AT + 20,
    );
    const still = await getGroupAssignments(db, [id('1'), id('2')]);
    expect(still.get(id('1'))!.groupId).not.toBeNull();
    expect(still.get(id('1'))).toEqual(still.get(id('2')));
  });

  it('copy matching aborts when the guarded upsert lost its race', async () => {
    const d = await fresh();
    const db = asExpo(d);
    const { insertDetectedCopyWithMatch } = await import('./store');
    await writeContinuousGroups(
      db,
      { photos: [upsert('orig'), upsert('copy')], groups: [], singles: [id('orig'), id('copy')] },
      AT,
    );
    await db.runAsync(
      "UPDATE photos SET state = 'kept', activity_at = ? WHERE asset_id = ?",
      AT,
      id('orig'),
    );
    await queueAction(db, id('orig'), 'edit', AT);
    // The user reviews the copy row AFTER candidate filtering: it is no
    // longer scan-only when the transaction runs.
    await db.runAsync(
      "UPDATE photos SET state = 'culled', activity_at = ? WHERE asset_id = ?",
      AT + 5,
      id('copy'),
    );
    const recorded = await insertDetectedCopyWithMatch(
      db,
      id('orig'),
      {
        assetId: id('copy'),
        uri: 'file:///dcim/copy.jpg',
        takenAt: AT,
        modTime: AT,
        day: '2027-01-15',
      },
      AT + 20,
      AT,
    );
    expect(recorded).toBe(false);
    const matches = await db.getAllAsync('SELECT * FROM edit_copy_matches');
    expect(matches).toEqual([]);
    const copyRow = await db.getFirstAsync<{ state: string }>(
      'SELECT state FROM photos WHERE asset_id = ?',
      id('copy'),
    );
    expect(copyRow).toEqual({ state: 'culled' });
  });

  it('leaves assignments intact for photos the plan does not place', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2')],
        groups: [{ members: [id('1'), id('2')], timeAttached: [] }],
        singles: [],
      },
      AT,
    );
    const before = await getGroupAssignments(db, [id('1'), id('2')]);

    // Photos in `photos` but in neither `groups` nor `singles` are row
    // upserts only — the pair-skip path relies on exactly this.
    await writeContinuousGroups(
      db,
      { photos: [upsert('1'), upsert('2')], groups: [], singles: [] },
      AT + 10,
    );
    const after = await getGroupAssignments(db, [id('1'), id('2')]);
    expect(after).toEqual(before);
  });
});

describe('identical re-writes are no-ops (m0.8.1 stable group ids)', () => {
  it('re-landing an unchanged window keeps the SAME group id', async () => {
    const d = await fresh();
    const db = asExpo(d);
    const window = {
      photos: [upsert('1'), upsert('2'), upsert('3')],
      groups: [{ members: [id('1'), id('2')], timeAttached: [] }],
      singles: [id('3')],
    };
    await writeContinuousGroups(db, window, AT);
    const before = await getGroupAssignments(db, [id('1'), id('2'), id('3')]);
    await writeContinuousGroups(db, window, AT + 1000);
    const after = await getGroupAssignments(db, [id('1'), id('2'), id('3')]);
    expect(after.get(id('1'))!.groupId).toBe(before.get(id('1'))!.groupId);
    expect(after.get(id('3'))).toEqual(before.get(id('3')));
    const groups = await db.getAllAsync<{ id: number }>('SELECT id FROM photo_groups');
    expect(groups).toHaveLength(1);
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('a time-attached flag change still rewrites (the clock badge must clear)', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2')],
        groups: [{ members: [id('1'), id('2')], timeAttached: [id('2')] }],
        singles: [],
      },
      AT,
    );
    expect((await getGroupAssignments(db, [id('2')])).get(id('2'))!.timeAttached).toBe(true);
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2')],
        groups: [{ members: [id('1'), id('2')], timeAttached: [] }],
        singles: [],
      },
      AT + 1000,
    );
    expect((await getGroupAssignments(db, [id('2')])).get(id('2'))!.timeAttached).toBe(false);
  });

  it('a genuine membership change still produces a fresh group', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2'), upsert('3')],
        groups: [{ members: [id('1'), id('2')], timeAttached: [] }],
        singles: [id('3')],
      },
      AT,
    );
    const before = (await getGroupAssignments(db, [id('1')])).get(id('1'))!.groupId;
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2'), upsert('3')],
        groups: [{ members: [id('1'), id('2'), id('3')], timeAttached: [] }],
        singles: [],
      },
      AT + 1000,
    );
    const after = await getGroupAssignments(db, [id('1'), id('2'), id('3')]);
    expect(after.get(id('1'))!.groupId).not.toBe(before);
    expect(after.get(id('3'))!.groupId).toBe(after.get(id('1'))!.groupId);
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

describe('D15 rescue marker persistence (m0.8.3)', () => {
  function markerOf(d: TestDb, rawId: string): number | null {
    const row = d.raw
      .prepare('SELECT exif_checked_mod_time AS m FROM photos WHERE asset_id = ?')
      .get(id(rawId)) as { m: number | null };
    return row.m;
  }

  it('a completed read stamps the marker; a later pass without one RETAINS it', async () => {
    const d = await fresh();
    const db = asExpo(d);
    // Pass 1: the rescue completed a read at modTime — marker persists.
    await writeContinuousGroups(
      db,
      {
        photos: [{ ...upsert('1'), exifCheckedModTime: AT - 3_600_000 }],
        groups: [],
        singles: [id('1')],
      },
      AT,
    );
    expect(markerOf(d, '1')).toBe(AT - 3_600_000);
    // Pass 2: the rescue's REUSE path carries the stored marker
    // explicitly (Q3) — retained without a fresh read.
    await writeContinuousGroups(
      db,
      {
        photos: [{ ...upsert('1'), exifCheckedModTime: AT - 3_600_000 }],
        groups: [],
        singles: [id('1')],
      },
      AT + 1000,
    );
    expect(markerOf(d, '1')).toBe(AT - 3_600_000);
    // Pass 2b: an UNDATED pass without a completed read (failed read or
    // module absent) still retains the stored proof.
    await writeContinuousGroups(
      db,
      { photos: [{ ...upsert('1'), day: null }], groups: [], singles: [id('1')] },
      AT + 1500,
    );
    expect(markerOf(d, '1')).toBe(AT - 3_600_000);
    // Pass 3: content changed and a NEW read completed — marker advances.
    await writeContinuousGroups(
      db,
      {
        photos: [{ ...upsert('1'), modTime: AT, exifCheckedModTime: AT }],
        groups: [],
        singles: [id('1')],
      },
      AT + 2000,
    );
    expect(markerOf(d, '1')).toBe(AT);
  });

  it('a photo that never completed a read keeps a NULL marker (retry-eligible)', async () => {
    const d = await fresh();
    await writeContinuousGroups(
      asExpo(d),
      { photos: [upsert('1')], groups: [], singles: [id('1')] },
      AT,
    );
    expect(markerOf(d, '1')).toBeNull();
  });
});

describe('IS_FAVORITE projection (F20, m0.8.7)', () => {
  const favRow = (d: TestDb, rawId: string): Record<string, unknown> | undefined =>
    d.raw
      .prepare(
        "SELECT state, target, applied_target, resolved_at FROM photo_actions WHERE photo_id = ? AND kind = 'favourite'",
      )
      .get(id(rawId)) as Record<string, unknown> | undefined;

  it('a gallery heart lands as a CARRIED favourite; a cleared one clears it', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      {
        photos: [
          { ...upsert('1'), favourite: true },
          { ...upsert('2'), favourite: false },
        ],
        groups: [],
        singles: [id('1'), id('2')],
      },
      AT,
    );
    expect(favRow(d, '1')).toEqual({
      state: 'applied',
      target: null,
      applied_target: '1',
      resolved_at: AT,
    });
    // No prior action, no flag: nothing is invented for photo 2.
    expect(favRow(d, '2')).toBeUndefined();

    // The gallery clears the heart: the carried direction flips off, the
    // row (history) survives.
    await writeContinuousGroups(
      db,
      { photos: [{ ...upsert('1'), favourite: false }], groups: [], singles: [id('1')] },
      AT + 10,
    );
    expect(favRow(d, '1')).toMatchObject({ applied_target: '0' });
  });

  it('a QUEUED intent outranks the observation — never touched either way', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      { photos: [upsert('1'), upsert('2')], groups: [], singles: [id('1'), id('2')] },
      AT,
    );
    // 1 waits on an APPLY; the gallery still says un-favourited.
    await queueAction(db, id('1'), 'favourite', AT + 1, '1');
    // 2 waits on a REMOVE; the gallery still says favourited.
    await queueAction(db, id('2'), 'favourite', AT + 2, '0');
    await writeContinuousGroups(
      db,
      {
        photos: [
          { ...upsert('1'), favourite: false },
          { ...upsert('2'), favourite: true },
        ],
        groups: [],
        singles: [id('1'), id('2')],
      },
      AT + 10,
    );
    expect(favRow(d, '1')).toMatchObject({ state: 'queued', target: '1' });
    expect(favRow(d, '2')).toMatchObject({ state: 'queued', target: '0' });
  });

  it('a null flag (failed read) touches nothing', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      { photos: [{ ...upsert('1'), favourite: true }], groups: [], singles: [id('1')] },
      AT,
    );
    await writeContinuousGroups(
      db,
      { photos: [{ ...upsert('1'), favourite: null }], groups: [], singles: [id('1')] },
      AT + 10,
    );
    expect(favRow(d, '1')).toMatchObject({ applied_target: '1', resolved_at: AT });
  });

  it('projection never stamps activity_at — an observation is not app activity', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      { photos: [{ ...upsert('1'), favourite: true }], groups: [], singles: [id('1')] },
      AT,
    );
    const row = d.raw.prepare('SELECT activity_at FROM photos WHERE asset_id = ?').get(id('1')) as {
      activity_at: number | null;
    };
    expect(row.activity_at).toBeNull();
  });
});
