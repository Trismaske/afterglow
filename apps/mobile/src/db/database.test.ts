/**
 * Migration-RUNNER ordering tests over a string-matching fake (C#4: this
 * fake is deliberately NOT the migration proof — real-SQL validation lives
 * in migrations.real.test.ts / migrationV8.real.test.ts; this file only
 * pins that the static runner applies steps one atomic transaction at a
 * time and hands off to the orchestrated v8 step exactly once).
 */
import { MIGRATIONS, SCHEMA_VERSION, STATIC_SCHEMA_VERSION, migrateDatabase } from './database';
import { migrateToV8 } from './migrationV8';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./migrationV8', async (importOriginal) => {
  const original = await importOriginal<typeof import('./migrationV8')>();
  return { ...original, migrateToV8: vi.fn().mockResolvedValue({}) };
});

class FakeDatabase {
  version: number;
  transactions = 0;
  applied: number[] = [];
  failMigration: number | null = null;

  constructor(version: number) {
    this.version = version;
  }

  async execAsync(): Promise<void> {}

  async getFirstAsync(): Promise<{ user_version: number }> {
    return { user_version: this.version };
  }

  async withExclusiveTransactionAsync(
    callback: (transaction: { execAsync: (sql: string) => Promise<void> }) => Promise<void>,
  ): Promise<void> {
    this.transactions++;
    let pendingVersion = this.version;
    await callback({
      execAsync: async (sql: string) => {
        const migration = MIGRATIONS.indexOf(sql);
        if (migration >= 0) {
          if (migration === this.failMigration) throw new Error('injected migration failure');
          this.applied.push(migration);
          return;
        }
        const match = /^PRAGMA user_version = (\d+)$/.exec(sql);
        if (match) pendingVersion = Number(match[1]);
      },
    });
    this.version = pendingVersion;
  }
}

describe('migrateDatabase (runner ordering)', () => {
  it('applies the static schema one atomic step at a time, then v8 once', async () => {
    const db = new FakeDatabase(0);
    await migrateDatabase(db as never);
    expect(db.version).toBe(STATIC_SCHEMA_VERSION);
    expect(db.transactions).toBe(STATIC_SCHEMA_VERSION);
    expect(db.applied).toEqual(MIGRATIONS.map((_, index) => index));
    expect(vi.mocked(migrateToV8)).toHaveBeenCalledTimes(1);
  });

  it('upgrades the shipped v5 schema without replaying old migrations', async () => {
    const db = new FakeDatabase(5);
    await migrateDatabase(db as never);
    expect(db.applied).toEqual([5, 6]);
  });

  it('does not advance user_version when a migration fails', async () => {
    const db = new FakeDatabase(5);
    db.failMigration = 5;
    await expect(migrateDatabase(db as never)).rejects.toThrow('injected migration failure');
    expect(db.version).toBe(5);
  });

  it('rejects databases created by a newer incompatible app', async () => {
    const db = new FakeDatabase(SCHEMA_VERSION + 1);
    await expect(migrateDatabase(db as never)).rejects.toThrow('Unsupported database schema');
  });
});
