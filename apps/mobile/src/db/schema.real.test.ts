/**
 * Fresh-baseline schema proof on real SQLite (gate 1: C#3, C#4, P8#4,
 * pre-v1 velocity policy). The baseline DDL executes against a real
 * engine; schema-level invariants — enforced FKs, one live reservation,
 * one continuous grouping run, per-generation trash terminality, and the
 * v18 verdict vocabulary — are proven by attempting to violate them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { SCHEMA_VERSION, migrateDatabase, withWriteTransaction } from './database';
import { foreignKeyCheck, openTestDb, userVersion, type TestDb } from './testDb';

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

function insertPhoto(d: TestDb, assetId: string): void {
  d.raw
    .prepare(
      `INSERT INTO photos (asset_id, uri, taken_at, day)
       VALUES (?, 'content://x', ?, '2026-07-01')`,
    )
    .run(assetId, AT);
}

describe('fresh baseline', () => {
  it('creates the full baseline schema at SCHEMA_VERSION with clean FKs', async () => {
    const d = await fresh();
    expect(userVersion(d)).toBe(SCHEMA_VERSION);
    const tables = d.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      'photos',
      'photo_actions',
      'duels',
      'settings',
      'photo_hashes',
      'grouping_runs',
      'photo_groups',
      'photo_group_assignments',
      'day_index_scans',
      'day_index',
      'share_cycles',
      'share_batches',
      'share_batch_members',
      'trash_batches',
      'trash_batch_members',
      'trash_reservations',
      'edit_copy_matches',
    ]) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('is a no-op when the version already matches', async () => {
    const d = await fresh();
    insertPhoto(d, 'external_primary/1');
    await migrateDatabase(asExpo(d));
    const n = d.raw.prepare('SELECT COUNT(*) AS n FROM photos').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('destructively resets any older schema version (pre-v1 policy)', async () => {
    const d = openTestDb();
    open.push(d);
    // Simulate an m0.6-era database: v7-ish shape at user_version 7.
    d.raw.exec(`
      CREATE TABLE photos (asset_id TEXT PRIMARY KEY, uri TEXT, taken_at INTEGER, state TEXT);
      CREATE TABLE old_junk (x INTEGER);
      PRAGMA user_version = 7;
    `);
    d.raw.prepare("INSERT INTO photos VALUES ('legacy', 'file://x', 1, 'kept')").run();
    await migrateDatabase(asExpo(d));
    expect(userVersion(d)).toBe(SCHEMA_VERSION);
    const tables = d.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).not.toContain('old_junk');
    const n = d.raw.prepare('SELECT COUNT(*) AS n FROM photos').get() as { n: number };
    expect(n.n).toBe(0); // legacy data deliberately discarded
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('a failure mid-reset leaves the old version so the reset retries', async () => {
    const d = openTestDb();
    open.push(d);
    d.raw.exec('CREATE TABLE photos (asset_id TEXT PRIMARY KEY); PRAGMA user_version = 5;');
    d.failAfter(3);
    await expect(migrateDatabase(asExpo(d))).rejects.toThrow('injected failure');
    expect(userVersion(d)).toBe(5);
    await migrateDatabase(asExpo(d));
    expect(userVersion(d)).toBe(SCHEMA_VERSION);
  });
});

describe('schema invariants', () => {
  it('enforces foreign keys on the open path', async () => {
    const d = await fresh();
    expect(() =>
      d.raw
        .prepare(
          `INSERT INTO photo_actions (photo_id, kind, state, queued_at)
           VALUES ('ghost', 'edit', 'queued', 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('allows exactly one live trash reservation per photo', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    d.raw.prepare("INSERT INTO trash_batches (state, created_at) VALUES ('preparing', ?)").run(AT);
    d.raw.prepare('INSERT INTO trash_reservations VALUES (?, 1, 0)').run('p1');
    expect(() =>
      d.raw.prepare('INSERT INTO trash_reservations VALUES (?, 1, 0)').run('p1'),
    ).toThrow(/UNIQUE|PRIMARY/);
  });

  it('permits one absence-terminal trash outcome per generation, retries and re-trash allowed', async () => {
    const d = await fresh();
    insertPhoto(d, 'p9');
    for (const state of ['error', 'verified', 'verified'] as const) {
      d.raw.prepare('INSERT INTO trash_batches (state, created_at) VALUES (?, ?)').run(state, AT);
    }
    d.raw.prepare("INSERT INTO trash_batch_members VALUES (1, 'p9', 0, 10, 'unknown')").run();
    d.raw.prepare("INSERT INTO trash_batch_members VALUES (2, 'p9', 0, 10, 'trashed')").run();
    expect(() =>
      d.raw
        .prepare(
          "INSERT INTO trash_batch_members VALUES (3, 'p9', 0, 10, 'absent_after_interrupted_launch')",
        )
        .run(),
    ).toThrow(/UNIQUE/);
    // Next generation (post-restore) may terminally complete again (P8#4).
    d.raw.prepare("INSERT INTO trash_batch_members VALUES (3, 'p9', 1, 10, 'trashed')").run();
  });

  it('enforces one grouping assignment per photo and ONE continuous run', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    d.raw
      .prepare("INSERT INTO grouping_runs (provenance, created_at) VALUES ('continuous', ?)")
      .run(AT);
    // The schema allows exactly one scan-owned run (m0.8: sessions gone).
    expect(() =>
      d.raw.prepare('INSERT INTO grouping_runs (created_at) VALUES (?)').run(AT),
    ).toThrow(/UNIQUE/);
    d.raw.prepare('INSERT INTO photo_groups (run_id) VALUES (1)').run();
    d.raw
      .prepare(
        "INSERT INTO photo_group_assignments (photo_id, run_id, group_id) VALUES ('p1', 1, 1)",
      )
      .run();
    // Second current assignment for the same photo: impossible.
    expect(() =>
      d.raw
        .prepare(
          "INSERT INTO photo_group_assignments (photo_id, run_id, group_id) VALUES ('p1', 1, NULL)",
        )
        .run(),
    ).toThrow(/UNIQUE|PRIMARY/);
  });

  it('best-of-group must be an assigned member (deferred composite FK)', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    d.raw
      .prepare("INSERT INTO grouping_runs (provenance, created_at) VALUES ('continuous', ?)")
      .run(AT);
    d.raw.exec('BEGIN');
    d.raw.prepare('INSERT INTO photo_groups (run_id, best_photo_id) VALUES (1, ?)').run('p1');
    d.raw
      .prepare(
        "INSERT INTO photo_group_assignments (photo_id, run_id, group_id) VALUES ('p1', 1, 1)",
      )
      .run();
    d.raw.exec('COMMIT'); // deferred FK satisfied by commit time
    // A best that is NOT a member fails at commit.
    insertPhoto(d, 'p2');
    d.raw.exec('BEGIN');
    d.raw.prepare('INSERT INTO photo_groups (run_id, best_photo_id) VALUES (1, ?)').run('p2');
    expect(() => d.raw.exec('COMMIT')).toThrow(/FOREIGN KEY/);
    d.raw.exec('ROLLBACK');
  });
});

describe('the verdict column (v18)', () => {
  it('accepts exactly the four verdicts and refuses the retired ones', async () => {
    const d = await fresh();
    for (const state of ['unreviewed', 'kept', 'culled', 'trashed']) {
      d.raw
        .prepare(
          `INSERT INTO photos (asset_id, uri, taken_at, state)
           VALUES (?, 'content://x', ?, ?)`,
        )
        .run(`ok/${state}`, AT, state);
    }
    // 'to_edit' is a pending ACTION now, and 'done' is spelled 'kept'.
    for (const state of ['to_edit', 'done', 'confirmed']) {
      expect(() =>
        d.raw
          .prepare(
            `INSERT INTO photos (asset_id, uri, taken_at, state)
             VALUES (?, 'content://x', ?, ?)`,
          )
          .run(`bad/${state}`, AT, state),
      ).toThrow(/CHECK/);
    }
  });
});

describe('withWriteTransaction (m0.8.1 session pragmas)', () => {
  it('arms busy_timeout and foreign_keys inside the transaction', async () => {
    const d = await fresh();
    d.raw.exec('PRAGMA busy_timeout = 0');
    let seen: { busy: number; fk: number } | null = null;
    await withWriteTransaction(asExpo(d), async (txn) => {
      const busy = await txn.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
      const fk = await txn.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys');
      seen = { busy: Number(busy?.timeout), fk: Number(fk?.foreign_keys) };
    });
    expect(seen).toEqual({ busy: 30_000, fk: 1 });
  });

  it('commits whole and rolls back whole around the pragma dance', async () => {
    const d = await fresh();
    await withWriteTransaction(asExpo(d), async (txn) => {
      await txn.runAsync("INSERT INTO settings (key, value) VALUES ('a', '1')");
    });
    expect(d.raw.prepare("SELECT value FROM settings WHERE key = 'a'").get()).toEqual({
      value: '1',
    });
    await expect(
      withWriteTransaction(asExpo(d), async (txn) => {
        await txn.runAsync("INSERT INTO settings (key, value) VALUES ('b', '2')");
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(d.raw.prepare("SELECT value FROM settings WHERE key = 'b'").get()).toBeUndefined();
  });
});
