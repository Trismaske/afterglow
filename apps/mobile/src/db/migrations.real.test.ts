/**
 * Real-SQLite migration tests (m0.7 gate 1, C#4). The shipped MIGRATIONS
 * array executes against an actual SQLite engine: a representative v7
 * fixture is built by running the real SQL, then inspected. The v8
 * migration tests extend this file as gate 1 lands.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION, migrateDatabase } from './database';
import { foreignKeyCheck, openTestDb, userVersion, type TestDb } from './testDb';
import type { SQLiteDatabase } from 'expo-sqlite';

const open: TestDb[] = [];

function db(): TestDb {
  const d = openTestDb();
  open.push(d);
  return d;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

/** The adapter satisfies the slice of SQLiteDatabase that migrateDatabase uses. */
function asExpo(d: TestDb): SQLiteDatabase {
  return d as unknown as SQLiteDatabase;
}

describe('shipped migrations on real SQLite', () => {
  it('applies 0 → v7 cleanly and reports the version', async () => {
    const d = db();
    await migrateDatabase(asExpo(d));
    const version = userVersion(d);
    expect(version).toBe(SCHEMA_VERSION);
    const tables = d.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining(['photos', 'duels', 'sessions', 'settings', 'photo_hashes']),
    );
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('every migration step is individually valid SQL', async () => {
    const d = db();
    let version = 0;
    for (const step of MIGRATIONS) {
      expect(() => {
        d.raw.exec('BEGIN EXCLUSIVE');
        d.raw.exec(step);
        version += 1;
        d.raw.exec(`PRAGMA user_version = ${version}`);
        d.raw.exec('COMMIT');
      }).not.toThrow();
    }
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('m0.2 backfill derives day from taken_at and settles m0.1 kept rows', async () => {
    const d = db();
    // Build v1, insert m0.1-era data, then migrate the rest of the way.
    d.raw.exec('BEGIN EXCLUSIVE');
    d.raw.exec(MIGRATIONS[0]);
    d.raw.exec('PRAGMA user_version = 1');
    d.raw.exec('COMMIT');
    const takenAt = Date.UTC(2026, 0, 15, 12, 0, 0);
    d.raw
      .prepare(
        "INSERT INTO photos (asset_id, uri, taken_at, state) VALUES ('a1', 'file:///x/a1.jpg', ?, 'kept')",
      )
      .run(takenAt);
    await migrateDatabase(asExpo(d));
    const row = d.raw.prepare("SELECT day, state FROM photos WHERE asset_id = 'a1'").get() as {
      day: string;
      state: string;
    };
    expect(row.state).toBe('done');
    expect(row.day).toMatch(/^2026-01-1[45]$/); // localtime of the runner
  });

  it('a failure inside one migration step leaves the previous version intact', async () => {
    const d = db();
    // Apply v1 normally, then inject a failure into the next step's transaction.
    d.raw.exec('BEGIN EXCLUSIVE');
    d.raw.exec(MIGRATIONS[0]);
    d.raw.exec('PRAGMA user_version = 1');
    d.raw.exec('COMMIT');
    d.failAfter(2); // withExclusiveTransactionAsync ticks once, execAsync of step ticks second
    await expect(migrateDatabase(asExpo(d))).rejects.toThrow('injected failure');
    const version = userVersion(d);
    expect(version).toBe(1);
    // Recovery: running again completes.
    await migrateDatabase(asExpo(d));
    expect(userVersion(d)).toBe(SCHEMA_VERSION);
  });

  it('rejects a database from a newer schema', async () => {
    const d = db();
    d.raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    await expect(migrateDatabase(asExpo(d))).rejects.toThrow('Unsupported database schema');
  });
});
