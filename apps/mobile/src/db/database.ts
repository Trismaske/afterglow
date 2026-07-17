/**
 * SQLite schema + migrations (expo-sqlite SDK 57 async API).
 *
 * SQLite is the source of truth for photo state, keyed by MediaStore asset
 * id with a lazy content hash as fallback identity (PLAN.md). The active
 * review session — including mid-bracket duel state — is persisted as a
 * versioned core `CullSession` snapshot so it survives app restarts.
 */
import type { SQLiteDatabase } from 'expo-sqlite';

export const DATABASE_NAME = 'afterglow.db';

const SCHEMA_VERSION = 1;

export async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;
  if (current < 1) {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS photos (
        asset_id     TEXT PRIMARY KEY,
        uri          TEXT NOT NULL,
        taken_at     INTEGER NOT NULL,
        state        TEXT NOT NULL DEFAULT 'unreviewed',
        group_id     TEXT,
        session_day  TEXT,
        mod_time     INTEGER,
        content_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS duels (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        group_id   TEXT NOT NULL,
        winner_id  TEXT NOT NULL,
        loser_id   TEXT NOT NULL,
        kept_both  INTEGER NOT NULL,
        at         INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        label           TEXT NOT NULL,
        range_start     INTEGER NOT NULL,
        range_end       INTEGER NOT NULL,
        snapshot        TEXT NOT NULL,
        reclaimed_bytes INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        completed_at    INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_photos_state ON photos(state);
      CREATE INDEX IF NOT EXISTS idx_duels_session ON duels(session_id);
    `);
  }
  await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
