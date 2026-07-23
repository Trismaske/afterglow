/**
 * Store contract tests on real SQLite (gate 1): carry-policy session
 * replacement (N#2, P4#1, item H), durable grouping at session creation
 * with intersected-leftover repair (item C, N#1), canonical identity
 * columns at ingestion (P4#2), activity_at on every transition (N#3,
 * C#7), and the durable global cull queue.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  createSession,
  getStagedCulls,
  persistDecision,
  replaceActiveSession,
  type NewSessionInput,
} from './store';
import { foreignKeyCheck, openTestDb, type TestDb } from './testDb';
import type { LoadedPhoto } from '../lib/media';

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

let photoCounter = 0;
function photo(
  rawId: string,
  groupId: string | null,
  takenAt = AT - 3_600_000,
): NewSessionInput['photos'][number] {
  photoCounter += 1;
  const loaded: LoadedPhoto = {
    item: {
      id: `external_primary/${rawId}`,
      timestamp: takenAt,
      uri: `file:///dcim/${rawId}.jpg`,
      kind: 'photo',
    },
    rawId,
    volumeName: 'external_primary',
    filename: `${rawId}.jpg`,
    modTime: takenAt,
    width: 100,
    height: 100,
  };
  return { ...loaded, groupId, day: '2026-07-20' };
}

function sessionInput(
  photos: NewSessionInput['photos'],
  fields: Partial<NewSessionInput> = {},
): NewSessionInput {
  const states: Record<string, string> = {};
  for (const p of photos) states[p.item.id] = 'unreviewed';
  return {
    label: 'test',
    rangeStart: 0,
    rangeEnd: AT,
    snapshot: JSON.stringify({ kind: 'deck', states }),
    photos,
    createdAt: AT,
    ...fields,
  };
}

describe('createSession', () => {
  it('writes identity columns and durable grouping rows', async () => {
    const d = await fresh();
    const id = await createSession(
      asExpo(d),
      sessionInput([photo('1', 'g0'), photo('2', 'g0'), photo('3', null)]),
    );
    const rows = d.raw
      .prepare('SELECT asset_id, volume_name, raw_id, activity_at FROM photos ORDER BY asset_id')
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows[0].asset_id).toBe('external_primary/1');
    expect(rows[0].volume_name).toBe('external_primary');
    expect(rows[0].raw_id).toBe('1');
    expect(rows[0].activity_at).toBe(AT);
    const run = d.raw
      .prepare('SELECT id, session_id, provenance FROM grouping_runs')
      .get() as Record<string, unknown>;
    expect(run.session_id).toBe(id);
    expect(run.provenance).toBe('session');
    const assignments = d.raw
      .prepare('SELECT photo_id, group_id FROM photo_group_assignments ORDER BY photo_id')
      .all() as { photo_id: string; group_id: number | null }[];
    expect(assignments).toHaveLength(3);
    expect(assignments[0].group_id).not.toBeNull(); // g0 member
    expect(assignments[1].group_id).toBe(assignments[0].group_id);
    expect(assignments[2].group_id).toBeNull(); // durable single
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('re-grouping repairs intersected leftovers: dissolved pair, cleared best', async () => {
    const d = await fresh();
    await createSession(asExpo(d), sessionInput([photo('1', 'gA'), photo('2', 'gA')]));
    // Star photo 1 as best of the old group.
    const oldGroup = d.raw.prepare('SELECT id FROM photo_groups').get() as { id: number };
    d.raw
      .prepare('UPDATE photo_groups SET best_photo_id = ? WHERE id = ?')
      .run('external_primary/1', oldGroup.id);
    d.raw.prepare('UPDATE sessions SET completed_at = ?').run(AT);
    // A later session redraws photo 1 into a different group; photo 2 is
    // left behind — its old group must dissolve and it becomes a single.
    await createSession(
      asExpo(d),
      sessionInput([photo('1', 'gB'), photo('9', 'gB')], { createdAt: AT + 10 }),
    );
    const assignments = Object.fromEntries(
      (
        d.raw.prepare('SELECT photo_id, group_id FROM photo_group_assignments').all() as {
          photo_id: string;
          group_id: number | null;
        }[]
      ).map((a) => [a.photo_id, a.group_id]),
    );
    expect(assignments['external_primary/2']).toBeNull(); // survivor → single
    expect(assignments['external_primary/1']).not.toBeNull();
    expect(assignments['external_primary/1']).toBe(assignments['external_primary/9']);
    const oldGroupRows = d.raw
      .prepare('SELECT COUNT(*) AS n FROM photo_groups WHERE id = ?')
      .get(oldGroup.id) as { n: number };
    expect(oldGroupRows.n).toBe(0); // dissolved (and its best marker with it)
    expect(foreignKeyCheck(d)).toEqual([]);
  });
});

describe('replaceActiveSession (carry policy)', () => {
  it('banks keepers, carries staged culls, abandons the old session — atomically', async () => {
    const d = await fresh();
    const first = await createSession(
      asExpo(d),
      sessionInput([photo('1', null), photo('2', null), photo('3', null)]),
    );
    // Decisions: 1 kept, 2 staged cull (persisted like the live app does).
    await persistDecision(
      asExpo(d),
      first,
      JSON.stringify({
        kind: 'deck',
        states: {
          'external_primary/1': 'kept',
          'external_primary/2': 'culled',
          'external_primary/3': 'unreviewed',
        },
      }),
      [
        ['external_primary/1', 'kept'],
        ['external_primary/2', 'culled'],
      ],
      AT + 100,
    );
    // Replacement draws photo 3 plus a new photo (2 is carried, not drawn).
    const second = await replaceActiveSession(
      asExpo(d),
      sessionInput([photo('3', null), photo('4', null)], { createdAt: AT + 200 }),
      AT + 200,
    );
    expect(second).not.toBe(first);
    const states = Object.fromEntries(
      (
        d.raw.prepare('SELECT asset_id, state FROM photos').all() as {
          asset_id: string;
          state: string;
        }[]
      ).map((r) => [r.asset_id, r.state]),
    );
    expect(states['external_primary/1']).toBe('done'); // banked keeper
    expect(states['external_primary/2']).toBe('culled'); // carried, untouched
    expect(states['external_primary/3']).toBe('unreviewed');
    const active = d.raw.prepare('SELECT id FROM sessions WHERE completed_at IS NULL').all() as {
      id: number;
    }[];
    expect(active).toEqual([{ id: second }]);
    // The durable global cull queue still owns photo 2.
    const culls = await getStagedCulls(asExpo(d));
    expect(culls.map((c) => c.asset_id)).toEqual(['external_primary/2']);
  });

  it('a redrawn staged cull keeps its culled state (carry, badged later)', async () => {
    const d = await fresh();
    const first = await createSession(asExpo(d), sessionInput([photo('1', null)]));
    await persistDecision(
      asExpo(d),
      first,
      JSON.stringify({ kind: 'deck', states: { 'external_primary/1': 'culled' } }),
      [['external_primary/1', 'culled']],
      AT + 100,
    );
    await replaceActiveSession(
      asExpo(d),
      sessionInput([photo('1', null), photo('2', null)], { createdAt: AT + 200 }),
      AT + 200,
    );
    const row = d.raw
      .prepare("SELECT state FROM photos WHERE asset_id = 'external_primary/1'")
      .get() as { state: string };
    expect(row.state).toBe('culled'); // the draw never resets a staged cull
  });

  it('rolls the whole replacement back on failure — the old session stays active', async () => {
    const d = await fresh();
    const first = await createSession(asExpo(d), sessionInput([photo('1', null)]));
    await persistDecision(
      asExpo(d),
      first,
      JSON.stringify({ kind: 'deck', states: { 'external_primary/1': 'kept' } }),
      [['external_primary/1', 'kept']],
      AT + 100,
    );
    d.failAfter(4); // inside the replacement transaction
    await expect(
      replaceActiveSession(
        asExpo(d),
        sessionInput([photo('5', null)], { createdAt: AT + 200 }),
        AT + 200,
      ),
    ).rejects.toThrow('injected failure');
    // Old session still active; keeper NOT banked (rollback covered it).
    const active = d.raw.prepare('SELECT id FROM sessions WHERE completed_at IS NULL').all() as {
      id: number;
    }[];
    expect(active).toEqual([{ id: first }]);
    const row = d.raw
      .prepare("SELECT state FROM photos WHERE asset_id = 'external_primary/1'")
      .get() as { state: string };
    expect(row.state).toBe('kept');
  });
});

describe('activity_at transitions', () => {
  it('every decision write moves activity_at', async () => {
    const d = await fresh();
    const id = await createSession(asExpo(d), sessionInput([photo('1', null)]));
    await persistDecision(
      asExpo(d),
      id,
      JSON.stringify({ kind: 'deck', states: { 'external_primary/1': 'kept' } }),
      [['external_primary/1', 'kept']],
      AT + 500,
    );
    const row = d.raw
      .prepare("SELECT activity_at FROM photos WHERE asset_id = 'external_primary/1'")
      .get() as { activity_at: number };
    expect(row.activity_at).toBe(AT + 500);
  });
});
