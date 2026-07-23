/**
 * Real-SQLite test adapter (m0.7 gate 1, C#4). Wraps Node's built-in
 * `node:sqlite` (DatabaseSync) in the minimal expo-sqlite async surface
 * that database.ts / store.ts consume, so migration and store tests
 * execute REAL SQL — syntax, ALTER sequences, backfills, indexes, foreign
 * keys, and transactions — instead of matching strings (the old
 * FakeDatabase keeps only the migration-runner-ordering role; see
 * database.test.ts).
 *
 * Test-only: `node:sqlite` needs `--experimental-sqlite` on Node 22, which
 * the workspace test script passes via NODE_OPTIONS. This module must
 * never be imported from app code. The adapter is deliberately tiny —
 * anything store.ts starts using from expo-sqlite must be added here so
 * tests stay honest.
 *
 * Failure injection: `failAfter(n)` makes the n-th subsequent statement
 * throw before executing, inside whatever transaction is open — the gate-1
 * contract tests use it to prove every migration/replacement phase rolls
 * back whole (P4#4, N#2).
 */
import { DatabaseSync } from 'node:sqlite';

export interface TestDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: unknown[]): Promise<{ lastInsertRowId: number | bigint }>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  withExclusiveTransactionAsync(fn: (txn: TestDb) => Promise<void>): Promise<void>;
  /** Throw before executing the n-th statement from now (1 = next). */
  failAfter(n: number): void;
  /** The raw engine, for index/pragma inspection in tests. */
  raw: DatabaseSync;
  close(): void;
}

type SqlParam = string | number | bigint | null | Uint8Array;

export function openTestDb(path = ':memory:'): TestDb {
  const raw = new DatabaseSync(path);
  let failCountdown = -1;

  function tick(): void {
    if (failCountdown < 0) return;
    failCountdown -= 1;
    if (failCountdown === 0) {
      failCountdown = -1;
      throw new Error('injected failure');
    }
  }

  function normalizeParams(params: unknown[]): SqlParam[] {
    return params.map((p) => {
      if (typeof p === 'boolean') return p ? 1 : 0;
      if (p === undefined) return null;
      return p as SqlParam;
    });
  }

  const db: TestDb = {
    raw,
    failAfter(n) {
      failCountdown = n;
    },
    async execAsync(sql) {
      tick();
      raw.exec(sql);
    },
    async runAsync(sql, ...params) {
      tick();
      const result = raw.prepare(sql).run(...normalizeParams(params));
      return { lastInsertRowId: result.lastInsertRowid };
    },
    async getFirstAsync<T>(sql: string, ...params: unknown[]) {
      tick();
      return (raw.prepare(sql).get(...normalizeParams(params)) as T | undefined) ?? null;
    },
    async getAllAsync<T>(sql: string, ...params: unknown[]) {
      tick();
      return raw.prepare(sql).all(...normalizeParams(params)) as T[];
    },
    async withExclusiveTransactionAsync(fn) {
      tick();
      raw.exec('BEGIN EXCLUSIVE');
      try {
        await fn(db);
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      raw.close();
    },
  };
  return db;
}

/** Current PRAGMA user_version. */
export function userVersion(db: TestDb): number {
  return Number(
    (db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
  );
}

/** PRAGMA foreign_key_check — empty array means no violations. */
export function foreignKeyCheck(db: TestDb): unknown[] {
  return db.raw.prepare('PRAGMA foreign_key_check').all();
}
