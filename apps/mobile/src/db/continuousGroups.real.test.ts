/**
 * Continuous-grouping persistence on real SQLite (m0.8 gate 2):
 * writeContinuousGroups owns the single 'continuous' run, upserts photo
 * rows without ever touching review state, replaces assignments for
 * rebuilt groups, and leaves frozen photos' assignments alone (the
 * runner's regroup boundary decides who is frozen — here we prove the
 * write path honors whatever plan it is handed).
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
    expect(assignments.get(id('3'))).toEqual({ groupId: null, userSingle: false });
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
    await db.runAsync(
      "UPDATE photos SET state = 'culled', needs_edit = 1 WHERE asset_id = ?",
      id('1'),
    );

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
      needs_edit: number;
      taken_at: number;
      mod_time: number;
      uri: string;
    }>('SELECT state, needs_edit, taken_at, mod_time, uri FROM photos WHERE asset_id = ?', id('1'));
    expect(row).toEqual({
      state: 'culled',
      needs_edit: 1,
      taken_at: AT - 100,
      mod_time: AT + 5,
      uri: 'file:///dcim/1-v2.jpg',
    });
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

  it('preserves the edit-detection mod_time baseline for to_edit rows', async () => {
    const d = await fresh();
    const db = asExpo(d);
    await writeContinuousGroups(
      db,
      { photos: [upsert('1'), upsert('2')], groups: [], singles: [id('1'), id('2')] },
      AT,
    );
    await db.runAsync(
      "UPDATE photos SET state = 'to_edit', to_edit_at = ? WHERE asset_id = ?",
      AT,
      id('1'),
    );

    // The rescan sees a NEWER modificationTime (the pending in-place edit);
    // the to_edit baseline must survive, the plain row must refresh.
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
    // original (to_edit) + a copy row the scan inserted before detection ran.
    await writeContinuousGroups(
      db,
      { photos: [upsert('orig'), upsert('copy')], groups: [], singles: [id('orig'), id('copy')] },
      AT,
    );
    await db.runAsync(
      "UPDATE photos SET state = 'to_edit', to_edit_at = ?, activity_at = ? WHERE asset_id = ?",
      AT,
      AT,
      id('orig'),
    );

    // The scan-only copy row is NOT detection-tracked; the reviewed one is.
    const tracked = await getDetectionTrackedAssets(db, [id('orig'), id('copy')]);
    expect(tracked.has(id('orig'))).toBe(true);
    expect(tracked.has(id('copy'))).toBe(false);

    // Detection records the match and flips the scan-only row to done.
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
    expect(copyRow).toEqual({ state: 'done', reviewed_at: AT + 20 });
    // And it is now detection-tracked (no re-prompt on later runs).
    const after = await getDetectionTrackedAssets(db, [id('copy')]);
    expect(after.has(id('copy'))).toBe(true);
  });

  it('a user-ejected single is never regrouped by a later scan write', async () => {
    const d = await fresh();
    const db = asExpo(d);
    const { makePhotoSingles } = await import('./store');
    await writeContinuousGroups(
      db,
      {
        photos: [upsert('1'), upsert('2'), upsert('3')],
        groups: [{ members: [id('1'), id('2'), id('3')], timeAttached: [] }],
        singles: [],
      },
      AT,
    );
    // The user ejects photo 3 ("not related").
    await makePhotoSingles(db, [id('3')]);

    // A warm rescan recomputes the same 3-photo group; the write-side
    // revalidation must keep 3 out (the runner's stale plan included it).
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
      user_single: number;
    }>('SELECT photo_id, group_id, user_single FROM photo_group_assignments ORDER BY photo_id');
    expect(rows[0].group_id).not.toBeNull();
    expect(rows[0].group_id).toEqual(rows[1].group_id);
    expect(rows[2]).toEqual({ photo_id: id('3'), group_id: null, user_single: 1 });
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
      "UPDATE photos SET state = 'to_edit', to_edit_at = ?, activity_at = ? WHERE asset_id = ?",
      AT,
      AT,
      id('orig'),
    );
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

  it('leaves untouched photos assignments intact (frozen plan omission)', async () => {
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

    // The window included the photos but the plan froze them: row upserts
    // only, no group/single writes.
    await writeContinuousGroups(
      db,
      { photos: [upsert('1'), upsert('2')], groups: [], singles: [] },
      AT + 10,
    );
    const after = await getGroupAssignments(db, [id('1'), id('2')]);
    expect(after).toEqual(before);
  });
});
