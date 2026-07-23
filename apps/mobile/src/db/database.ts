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
 * Migrations use `PRAGMA user_version`. Each schema step and its version
 * bump share one exclusive transaction, so a crash can never advertise a
 * half-applied migration.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { EMPTY_RESOLVER, migrateToV8, type LegacyIdentityResolver } from './migrationV8';

export const DATABASE_NAME = 'afterglow.db';

/**
 * MIGRATIONS[n] upgrades user_version n → n+1. Append-only: never edit a
 * shipped migration, add a new one.
 */
export const MIGRATIONS: readonly string[] = [
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
  // 5 → 6: m0.6 durable favourite/edit metrics. Favourite intent is a
  // small state machine so a user-confirmed MediaStore batch can be retried
  // and verified instead of optimistically painting a heart. Completion
  // timestamps give the lifetime dashboard exact, documented inputs.
  `
    ALTER TABLE photos ADD COLUMN favourite_state TEXT NOT NULL DEFAULT 'none'
      CHECK (favourite_state IN ('none', 'queued_apply', 'applied', 'queued_remove', 'error'));
    ALTER TABLE photos ADD COLUMN favourite_changed_at INTEGER;
    ALTER TABLE photos ADD COLUMN favourite_applied_at INTEGER;
    ALTER TABLE photos ADD COLUMN edit_completed_at INTEGER;
    ALTER TABLE photos ADD COLUMN reviewed_at INTEGER;
    ALTER TABLE photos ADD COLUMN culled_at INTEGER;
    CREATE INDEX IF NOT EXISTS idx_photos_favourite_state ON photos(favourite_state);
  `,
  // 6 → 7: retain the desired direction when a favourite operation fails.
  // `error` alone cannot distinguish retry-apply from retry-remove, especially
  // after a photo has historical favourite_applied_at data.
  `
    ALTER TABLE photos ADD COLUMN favourite_target INTEGER
      CHECK (favourite_target IS NULL OR favourite_target IN (0, 1));
  `,
];

/** Static-SQL portion of the schema (v1–v7). */
export const STATIC_SCHEMA_VERSION = MIGRATIONS.length;

/** Full schema version including the orchestrated v8 step (migrationV8.ts). */
export const SCHEMA_VERSION = STATIC_SCHEMA_VERSION + 1;

export interface MigrateOptions {
  /** Volume-aware legacy identity resolver (P5#1). Native on device; a
   * fake in tests; EMPTY_RESOLVER quarantines every legacy row and is only
   * correct for fresh installs. */
  resolver?: LegacyIdentityResolver;
  /** Clock injection — migration timestamps must be reproducible. */
  at?: number;
}

export async function migrateDatabase(
  db: SQLiteDatabase,
  options: MigrateOptions = {},
): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL');
  // C#3: declared foreign keys are meaningless unless enforcement is on —
  // every connection, not just migrating ones (this is the open path).
  await db.execAsync('PRAGMA foreign_keys = ON');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let current = row?.user_version ?? 0;
  if (!Number.isInteger(current) || current < 0 || current > SCHEMA_VERSION) {
    throw new Error(
      `Unsupported database schema version ${String(current)} (app supports ${SCHEMA_VERSION})`,
    );
  }
  while (current < STATIC_SCHEMA_VERSION) {
    const next = current + 1;
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync(MIGRATIONS[current]);
      await txn.execAsync(`PRAGMA user_version = ${next}`);
    });
    current++;
  }
  if (current < SCHEMA_VERSION) {
    // v8 is a two-phase orchestrated migration, not static SQL — see
    // migrationV8.ts for the protocol (P5#1, P6#1, P7#2, P4#4).
    await migrateToV8(db, options.resolver ?? EMPTY_RESOLVER, options.at ?? 0);
  }
}
