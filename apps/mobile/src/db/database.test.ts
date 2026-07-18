import { MIGRATIONS, SCHEMA_VERSION, migrateDatabase } from './database';
import { describe, expect, it } from 'vitest';

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

describe('migrateDatabase', () => {
  it('applies a fresh schema one atomic step at a time', async () => {
    const db = new FakeDatabase(0);
    await migrateDatabase(db as never);
    expect(db.version).toBe(SCHEMA_VERSION);
    expect(db.transactions).toBe(SCHEMA_VERSION);
    expect(db.applied).toEqual(MIGRATIONS.map((_, index) => index));
  });

  it('upgrades the shipped v5 schema without replaying old migrations', async () => {
    const db = new FakeDatabase(5);
    await migrateDatabase(db as never);
    expect(db.version).toBe(SCHEMA_VERSION);
    expect(db.applied).toEqual([5, 6]);
  });

  it('upgrades the intermediate v6 schema with the favourite target migration', async () => {
    const db = new FakeDatabase(6);
    await migrateDatabase(db as never);
    expect(db.version).toBe(SCHEMA_VERSION);
    expect(db.applied).toEqual([6]);
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
