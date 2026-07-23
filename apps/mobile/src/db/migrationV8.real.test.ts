/**
 * v7 → v8 migration proof on real SQLite (gate 1: C#3, C#4, P4#4, P5#1,
 * P6#1, P7#2). Fixtures are built by executing the SHIPPED v1–v7 SQL, then
 * upgraded through the real two-phase protocol with a fake volume-aware
 * identity resolver.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { MIGRATIONS, migrateDatabase } from './database';
import {
  canonicalKey,
  migrateToV8,
  occurrenceKey,
  type IdentityMap,
  type IdentityResolution,
  type LegacyIdentityResolver,
} from './migrationV8';
import { foreignKeyCheck, openTestDb, userVersion, type TestDb } from './testDb';

const open: TestDb[] = [];
const AT = 1_800_000_000_000;

function asExpo(d: TestDb): SQLiteDatabase {
  return d as unknown as SQLiteDatabase;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

/** A v7 database built by the real shipped migrations. */
function v7(): TestDb {
  const d = openTestDb();
  open.push(d);
  d.raw.exec('PRAGMA foreign_keys = ON');
  let version = 0;
  for (const step of MIGRATIONS) {
    d.raw.exec('BEGIN EXCLUSIVE');
    d.raw.exec(step);
    version += 1;
    d.raw.exec(`PRAGMA user_version = ${version}`);
    d.raw.exec('COMMIT');
  }
  return d;
}

function insertPhoto(
  d: TestDb,
  assetId: string,
  fields: Partial<{
    uri: string;
    state: string;
    groupId: string | null;
    takenAt: number;
    reviewedAt: number | null;
  }> = {},
): void {
  d.raw
    .prepare(
      `INSERT INTO photos (asset_id, uri, taken_at, state, group_id, day, reviewed_at)
       VALUES (?, ?, ?, ?, ?, date(? / 1000, 'unixepoch', 'localtime'), ?)`,
    )
    .run(
      assetId,
      fields.uri ?? `file:///dcim/${assetId}.jpg`,
      fields.takenAt ?? AT - 86_400_000,
      fields.state ?? 'unreviewed',
      fields.groupId ?? null,
      fields.takenAt ?? AT - 86_400_000,
      fields.reviewedAt ?? null,
    );
}

function insertSession(
  d: TestDb,
  snapshot: unknown,
  fields: Partial<{ createdAt: number; completedAt: number | null }> = {},
): number {
  const result = d.raw
    .prepare(
      `INSERT INTO sessions (label, range_start, range_end, snapshot, created_at, completed_at)
       VALUES ('t', 0, 1, ?, ?, ?)`,
    )
    .run(JSON.stringify(snapshot), fields.createdAt ?? AT - 3_600_000, fields.completedAt ?? null);
  return Number(result.lastInsertRowid);
}

/** Fake native resolver: an explicit occurrence table drives resolution. */
function resolver(entries: Record<string, IdentityResolution | 'unknown'>): LegacyIdentityResolver {
  return {
    async resolve(occurrences): Promise<IdentityMap> {
      const map: IdentityMap = new Map();
      for (const o of occurrences) {
        const hit = entries[occurrenceKey(o)];
        if (hit) map.set(occurrenceKey(o), hit);
      }
      return map;
    },
  };
}

const primary = (rawId: string): IdentityResolution => ({
  volumeName: 'external_primary',
  rawId,
  contentUri: `content://media/external_primary/images/media/${rawId}`,
});
const sdcard = (rawId: string): IdentityResolution => ({
  volumeName: 'sd-1234',
  rawId,
  contentUri: `content://media/sd-1234/images/media/${rawId}`,
});

describe('fresh install', () => {
  it('creates the full v8 schema with enforced FKs and version 8', async () => {
    const d = openTestDb();
    open.push(d);
    d.raw.exec('PRAGMA foreign_keys = ON');
    await migrateDatabase(asExpo(d), { at: AT });
    expect(userVersion(d)).toBe(8);
    const tables = d.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      'grouping_runs',
      'photo_groups',
      'photo_group_assignments',
      'day_index_scans',
      'day_index',
      'share_cycles',
      'share_queue',
      'share_batches',
      'share_batch_members',
      'trash_batches',
      'trash_batch_members',
      'trash_reservations',
      'reclaimed_legacy',
      'edit_copy_matches',
    ]) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
    expect(foreignKeyCheck(d)).toEqual([]);
    const fkOn = d.raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fkOn.foreign_keys).toBe(1);
  });

  it('enforces one live trash reservation and one active session', async () => {
    const d = openTestDb();
    open.push(d);
    d.raw.exec('PRAGMA foreign_keys = ON');
    await migrateDatabase(asExpo(d), { at: AT });
    insertPhotoV8(d, 'external_primary/1');
    d.raw.prepare("INSERT INTO trash_batches (state, created_at) VALUES ('preparing', ?)").run(AT);
    d.raw
      .prepare(
        'INSERT INTO trash_reservations (photo_id, batch_id, trash_generation) VALUES (?, 1, 0)',
      )
      .run('external_primary/1');
    expect(() =>
      d.raw
        .prepare(
          'INSERT INTO trash_reservations (photo_id, batch_id, trash_generation) VALUES (?, 1, 0)',
        )
        .run('external_primary/1'),
    ).toThrow(/UNIQUE|PRIMARY/);
    d.raw
      .prepare(
        "INSERT INTO sessions (label, range_start, range_end, snapshot, created_at) VALUES ('a', 0, 1, '{}', ?)",
      )
      .run(AT);
    expect(() =>
      d.raw
        .prepare(
          "INSERT INTO sessions (label, range_start, range_end, snapshot, created_at) VALUES ('b', 0, 1, '{}', ?)",
        )
        .run(AT),
    ).toThrow(/UNIQUE|idx_sessions_one_active/);
  });

  it('prevents a second terminal trash outcome for one generation but allows retries', async () => {
    const d = openTestDb();
    open.push(d);
    d.raw.exec('PRAGMA foreign_keys = ON');
    await migrateDatabase(asExpo(d), { at: AT });
    insertPhotoV8(d, 'external_primary/9');
    d.raw.prepare("INSERT INTO trash_batches (state, created_at) VALUES ('error', ?)").run(AT);
    d.raw.prepare("INSERT INTO trash_batches (state, created_at) VALUES ('verified', ?)").run(AT);
    // Retryable non-terminal outcomes may repeat across batches:
    d.raw
      .prepare("INSERT INTO trash_batch_members VALUES (1, 'external_primary/9', 0, 10, 'unknown')")
      .run();
    d.raw
      .prepare("INSERT INTO trash_batch_members VALUES (2, 'external_primary/9', 0, 10, 'trashed')")
      .run();
    // A second absence-terminal for the same generation is impossible:
    d.raw.prepare("INSERT INTO trash_batches (state, created_at) VALUES ('verified', ?)").run(AT);
    expect(() =>
      d.raw
        .prepare(
          "INSERT INTO trash_batch_members VALUES (3, 'external_primary/9', 0, 10, 'absent_after_interrupted_launch')",
        )
        .run(),
    ).toThrow(/UNIQUE/);
    // The next generation may terminally complete again (restore → re-trash).
    d.raw
      .prepare("INSERT INTO trash_batch_members VALUES (3, 'external_primary/9', 1, 10, 'trashed')")
      .run();
  });
});

function insertPhotoV8(d: TestDb, assetId: string): void {
  d.raw
    .prepare(
      `INSERT INTO photos (asset_id, uri, taken_at, state, day, identity_status)
       VALUES (?, 'content://x', ?, 'unreviewed', '2026-07-01', 'canonical')`,
    )
    .run(assetId, AT);
}

describe('v7 → v8 identity migration', () => {
  it('rewrites resolvable photos to canonical volume-qualified keys', async () => {
    const d = v7();
    insertPhoto(d, '101', { uri: 'file:///dcim/a.jpg', reviewedAt: AT - 500 });
    const stats = await migrateToV8(
      asExpo(d),
      resolver({
        [occurrenceKey({ rawId: '101', storedUri: 'file:///dcim/a.jpg' })]: primary('101'),
      }),
      AT,
    );
    expect(stats.resolvedPhotos).toBe(1);
    const row = d.raw
      .prepare(
        'SELECT asset_id, volume_name, raw_id, content_uri, identity_status, activity_at FROM photos',
      )
      .get() as Record<string, unknown>;
    expect(row.asset_id).toBe(canonicalKey('external_primary', '101'));
    expect(row.volume_name).toBe('external_primary');
    expect(row.raw_id).toBe('101');
    expect(row.identity_status).toBe('canonical');
    expect(row.activity_at).toBe(AT - 500); // greatest event timestamp
    expect(foreignKeyCheck(d)).toEqual([]);
    expect(userVersion(d)).toBe(8);
  });

  it('quarantines unresolvable rows as non-present legacy-unknown', async () => {
    const d = v7();
    insertPhoto(d, '202', { state: 'culled' });
    const stats = await migrateToV8(asExpo(d), resolver({}), AT);
    expect(stats.quarantined).toBe(1);
    const row = d.raw
      .prepare('SELECT asset_id, identity_status, is_present, state FROM photos')
      .get() as Record<string, unknown>;
    expect(String(row.asset_id)).toMatch(/^legacy-unknown\/202\//);
    expect(row.identity_status).toBe('legacy-unknown');
    expect(row.is_present).toBe(0);
    // Unowned legacy cull was conservatively reset (P4#1):
    expect(row.state).toBe('unreviewed');
  });

  it('same raw id on two volumes: two snapshots resolve to two photos rows (P7#2)', async () => {
    const d = v7();
    // One v7 photos row exists for raw id 42 (the primary-volume photo).
    insertPhoto(d, '42', { uri: 'file:///dcim/primary.jpg' });
    // Historical session A saw raw 42 with the primary URI; session B saw
    // raw 42 with the SD URI (no photos row of its own — v7 PK collision).
    insertSession(
      d,
      {
        kind: 'deck',
        items: [{ id: '42', uri: 'file:///dcim/primary.jpg', timestamp: AT - 900_000 }],
        states: { '42': 'kept' },
      },
      { createdAt: AT - 900_000, completedAt: AT - 890_000 },
    );
    const sdSession = insertSession(
      d,
      {
        kind: 'deck',
        items: [{ id: '42', uri: 'file:///sdcard/dcim/sd.jpg', timestamp: AT - 800_000 }],
        states: { '42': 'culled' },
      },
      { createdAt: AT - 800_000, completedAt: AT - 790_000 },
    );
    d.raw
      .prepare(
        'INSERT INTO duels (session_id, group_id, winner_id, loser_id, kept_both, at) VALUES (?, ?, ?, ?, 0, ?)',
      )
      .run(sdSession, 'g1', '42', '42', AT - 795_000);

    const stats = await migrateToV8(
      asExpo(d),
      resolver({
        [occurrenceKey({ rawId: '42', storedUri: 'file:///dcim/primary.jpg' })]: primary('42'),
        [occurrenceKey({ rawId: '42', storedUri: 'file:///sdcard/dcim/sd.jpg' })]: sdcard('42'),
      }),
      AT,
    );
    // Two materialized rows — the inherited primary + the synthesized SD parent.
    const rows = d.raw
      .prepare('SELECT asset_id FROM photos ORDER BY asset_id')
      .all()
      .map((r) => (r as { asset_id: string }).asset_id);
    expect(rows).toEqual(['external_primary/42', 'sd-1234/42']);
    expect(stats.synthesizedParents).toBe(1);
    // Each snapshot references its own asset; duels follow their session.
    const snapshots = d.raw
      .prepare('SELECT snapshot FROM sessions ORDER BY id')
      .all()
      .map((r) => JSON.parse((r as { snapshot: string }).snapshot) as { items: { id: string }[] });
    expect(snapshots[0].items[0].id).toBe('external_primary/42');
    expect(snapshots[1].items[0].id).toBe('sd-1234/42');
    const duel = d.raw.prepare('SELECT winner_id FROM duels').get() as { winner_id: string };
    expect(duel.winner_id).toBe('sd-1234/42');
    // The staged state of the SD asset never transferred to the primary row.
    const states = d.raw.prepare('SELECT asset_id, state FROM photos ORDER BY asset_id').all() as {
      asset_id: string;
      state: string;
    }[];
    expect(states.find((r) => r.asset_id === 'external_primary/42')?.state).not.toBe('culled');
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('discards ambiguous hash rows and rekeys unambiguous ones (P6#1)', async () => {
    const d = v7();
    insertPhoto(d, '7', { uri: 'file:///dcim/seven.jpg' });
    d.raw.prepare("INSERT INTO photo_hashes VALUES ('7', 'aa00aa00aa00aa00', 1)").run();
    d.raw.prepare("INSERT INTO photo_hashes VALUES ('8', 'bb00bb00bb00bb00', 1)").run();
    // Raw id 8 appears twice on different volumes → ambiguous owner.
    insertSession(d, {
      kind: 'deck',
      items: [
        { id: '8', uri: 'file:///a/8.jpg' },
        { id: '8', uri: 'file:///b/8.jpg' },
      ],
      states: {},
    });
    const stats = await migrateToV8(
      asExpo(d),
      resolver({
        [occurrenceKey({ rawId: '7', storedUri: 'file:///dcim/seven.jpg' })]: primary('7'),
        [occurrenceKey({ rawId: '8', storedUri: 'file:///a/8.jpg' })]: primary('8'),
        [occurrenceKey({ rawId: '8', storedUri: 'file:///b/8.jpg' })]: sdcard('8'),
      }),
      AT,
    );
    expect(stats.discardedHashes).toBe(1);
    const hashes = d.raw
      .prepare('SELECT asset_id FROM photo_hashes')
      .all()
      .map((r) => (r as { asset_id: string }).asset_id);
    expect(hashes).toEqual(['external_primary/7']);
  });

  it('normalizes legacy groups: >=2 members grouped, one-member becomes single (P4#4)', async () => {
    const d = v7();
    insertPhoto(d, '1', { groupId: 'g-a', uri: 'file:///p/1.jpg' });
    insertPhoto(d, '2', { groupId: 'g-a', uri: 'file:///p/2.jpg' });
    insertPhoto(d, '3', { groupId: 'g-b', uri: 'file:///p/3.jpg' }); // makeSingle survivor
    const stats = await migrateToV8(
      asExpo(d),
      resolver({
        [occurrenceKey({ rawId: '1', storedUri: 'file:///p/1.jpg' })]: primary('1'),
        [occurrenceKey({ rawId: '2', storedUri: 'file:///p/2.jpg' })]: primary('2'),
        [occurrenceKey({ rawId: '3', storedUri: 'file:///p/3.jpg' })]: primary('3'),
      }),
      AT,
    );
    expect(stats.legacyGroups).toBe(1);
    expect(stats.legacySingles).toBe(1);
    const assignments = d.raw
      .prepare('SELECT photo_id, group_id FROM photo_group_assignments ORDER BY photo_id')
      .all() as { photo_id: string; group_id: number | null }[];
    expect(assignments).toHaveLength(3);
    const survivor = assignments.find((a) => a.photo_id === 'external_primary/3');
    expect(survivor?.group_id).toBeNull();
    const grouped = assignments.filter((a) => a.group_id !== null);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].group_id).toBe(grouped[1].group_id);
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('keeps active-snapshot-owned staged culls and abandons stale sessions (P4#1, P4#4)', async () => {
    const d = v7();
    insertPhoto(d, '10', { state: 'culled', uri: 'file:///p/10.jpg' });
    insertPhoto(d, '11', { state: 'culled', uri: 'file:///p/11.jpg' }); // orphan
    // Two unfinished sessions — anomalous v7 state; newest valid survives.
    insertSession(d, { kind: 'deck', items: [], states: {} }, { createdAt: AT - 500_000 });
    insertSession(
      d,
      {
        kind: 'deck',
        items: [{ id: '10', uri: 'file:///p/10.jpg' }],
        states: { '10': 'culled' },
      },
      { createdAt: AT - 100_000 },
    );
    const stats = await migrateToV8(
      asExpo(d),
      resolver({
        [occurrenceKey({ rawId: '10', storedUri: 'file:///p/10.jpg' })]: primary('10'),
        [occurrenceKey({ rawId: '11', storedUri: 'file:///p/11.jpg' })]: primary('11'),
      }),
      AT,
    );
    expect(stats.abandonedSessions).toBe(1);
    expect(stats.resetCulls).toBe(1);
    const states = Object.fromEntries(
      (
        d.raw.prepare('SELECT asset_id, state FROM photos').all() as {
          asset_id: string;
          state: string;
        }[]
      ).map((r) => [r.asset_id, r.state]),
    );
    expect(states['external_primary/10']).toBe('culled'); // owned by the surviving snapshot
    expect(states['external_primary/11']).toBe('unreviewed'); // orphan reset
    const active = d.raw
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE completed_at IS NULL')
      .get() as { n: number };
    expect(active.n).toBe(1);
  });

  it('banks the v7 reclaimed-bytes aggregate exactly once (P7#4)', async () => {
    const d = v7();
    d.raw
      .prepare(
        "INSERT INTO sessions (label, range_start, range_end, snapshot, reclaimed_bytes, created_at, completed_at) VALUES ('x', 0, 1, '{}', 12345, ?, ?)",
      )
      .run(AT - 10, AT - 5);
    await migrateToV8(asExpo(d), resolver({}), AT);
    const legacy = d.raw.prepare('SELECT source, bytes FROM reclaimed_legacy').all();
    expect(legacy).toEqual([{ source: 'v7-sessions', bytes: 12345 }]);
  });

  it('a failure inside phase B leaves the database at v7 and retryable', async () => {
    const d = v7();
    insertPhoto(d, '55', { uri: 'file:///p/55.jpg' });
    const res = resolver({
      [occurrenceKey({ rawId: '55', storedUri: 'file:///p/55.jpg' })]: primary('55'),
    });
    d.failAfter(6); // somewhere inside the exclusive transaction
    await expect(migrateToV8(asExpo(d), res, AT)).rejects.toThrow('injected failure');
    expect(userVersion(d)).toBe(7);
    // Retry completes and no raw id remains in any live relation.
    const stats = await migrateToV8(asExpo(d), res, AT);
    expect(stats.resolvedPhotos).toBe(1);
    expect(userVersion(d)).toBe(8);
    const raw = d.raw
      .prepare("SELECT COUNT(*) AS n FROM photos WHERE asset_id NOT LIKE '%/%'")
      .get() as { n: number };
    expect(raw.n).toBe(0);
  });
});
