/**
 * SQLite schema + migrations (expo-sqlite SDK 57 async API).
 *
 * SQLite is the source of truth for photo state, keyed by MediaStore asset
 * id with a lazy content hash as fallback identity (PLAN.md). The active
 * review session — including mid-deck state — is persisted as a versioned
 * core session snapshot (`DeckSession` since m0.4; the m0.1–m0.3 bracket
 * `CullSession` before that — those old snapshots are discarded on
 * resume) so it survives app restarts.
 *
 * Migrations: simple `PRAGMA user_version`-based runner. Each entry in
 * MIGRATIONS moves the schema from version (index) to (index + 1) and runs
 * exactly once, in order, inside the SQL batch below.
 */
import type { SQLiteDatabase } from 'expo-sqlite';

export const DATABASE_NAME = 'afterglow.db';

/**
 * MIGRATIONS[n] upgrades user_version n → n+1. Append-only: never edit a
 * shipped migration, add a new one.
 */
const MIGRATIONS: readonly string[] = [
  // 0 → 1: m0.1 baseline.
  `
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
  `,
  // 1 → 2: m0.2 full state machine.
  //  - `day`: local calendar day (YYYY-MM-DD) of taken_at, for day-scoped
  //    inbox-zero progress. Backfilled with SQLite localtime; new rows get
  //    it from JS (both are device-local time).
  //  - `needs_edit`: the user's "this keeper needs editing" flag. A kept
  //    photo with needs_edit = 1 is stored as state 'to_edit'.
  //  - m0.1 reconciliation: rows left 'kept' by m0.1 sessions are treated
  //    as reviewed-and-settled → 'done' (m0.2 sessions convert kept → done
  //    when the session finishes; m0.1 had no such step).
  `
    ALTER TABLE photos ADD COLUMN day TEXT;
    ALTER TABLE photos ADD COLUMN needs_edit INTEGER NOT NULL DEFAULT 0;
    UPDATE photos SET day = date(taken_at / 1000, 'unixepoch', 'localtime');
    UPDATE photos SET state = 'done' WHERE state = 'kept';
    CREATE INDEX IF NOT EXISTS idx_photos_day ON photos(day);
  `,
  // 2 → 3: m0.3 edit detection + streaks.
  //  - `to_edit_at`: when the photo entered the to-edit queue — the scan
  //    window for edited-copy detection. Backfilled with the photo's own
  //    mod time (a wider window than the true flag time; the matching
  //    heuristics tolerate that).
  //  - `sessions.finished`: 1 only when the user pressed Finish on the
  //    summary screen; abandoned sessions keep 0. Drives the review streak.
  //    Pre-m0.3 completed sessions can't be told apart from abandoned ones,
  //    so they optimistically count as finished.
  `
    ALTER TABLE photos ADD COLUMN to_edit_at INTEGER;
    UPDATE photos SET to_edit_at = COALESCE(mod_time, taken_at) WHERE state = 'to_edit';
    ALTER TABLE sessions ADD COLUMN finished INTEGER NOT NULL DEFAULT 0;
    UPDATE sessions SET finished = 1 WHERE completed_at IS NOT NULL;
  `,
  // 3 → 4: m0.3.1 settings (photo-source folder targeting). A generic
  // key/value table — the photo-source selection is a JSON blob under
  // 'photo_sources' (see src/lib/sources.ts); future small settings can
  // share the table without further migrations.
  `
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `,
  // 4 → 5: m0.4 perceptual-hash cache. One 64-bit dHash (16-char hex, see
  // @afterglow/core similarity.ts) per MediaStore asset; `mod_time` is the
  // asset's modificationTime when the hash was computed — a moved mod time
  // invalidates the entry (the photo was edited in place). Rows are never
  // aged out: 200k photos ≈ a few MB, and a stale row for a deleted asset
  // is simply never read again.
  `
    CREATE TABLE IF NOT EXISTS photo_hashes (
      asset_id TEXT PRIMARY KEY,
      hash     TEXT NOT NULL,
      mod_time INTEGER NOT NULL
    );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let current = row?.user_version ?? 0;
  while (current < SCHEMA_VERSION) {
    await db.execAsync(`${MIGRATIONS[current]}\nPRAGMA user_version = ${current + 1}`);
    current++;
  }
}
