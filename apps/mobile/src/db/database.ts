/**
 * SQLite schema (expo-sqlite SDK 57 async API) — m0.7 fresh baseline.
 *
 * PRE-V1 VELOCITY POLICY (Tristan, 2026-07-23): until v1.0 there are no
 * upgrade migrations. The schema ships as ONE fresh baseline DDL; opening
 * a database whose `user_version` doesn't match SCHEMA_VERSION performs a
 * DESTRUCTIVE RESET (drop everything, recreate). The v7→v8 two-phase
 * identity-migration protocol built for the original plan — occurrence-
 * scoped resolution, legacy quarantine, transitive snapshot rewriting —
 * is parked in git history (commit cd4a902) and revives for the v1
 * upgrade story.
 *
 * SQLite is the source of truth for photo state. Canonical identity is
 * volume-qualified (`<volume>/<raw id>`; P4#2) — the identity columns are
 * nullable until the ingestion-boundary change flips `asset_id` to the
 * canonical key and tightens them. `photos.group_id` is deprecated: the
 * durable grouping relations (grouping_runs / photo_groups /
 * photo_group_assignments) become the membership truth in gate 2.
 *
 * Foreign keys are declared AND enforced (`PRAGMA foreign_keys = ON` on
 * every open; C#3). Schema-level invariants: one current group assignment
 * per photo (assignments PK), one grouping run per session (partial
 * unique), one active session (partial unique), one live trash
 * reservation per photo (reservations PK), and at most one absence-
 * terminal trash outcome per (photo, generation) (partial unique; P8#4).
 */
import type { SQLiteDatabase } from 'expo-sqlite';

export const DATABASE_NAME = 'afterglow.db';

/** Bump on ANY schema change before v1 — the open path resets mismatches. */
export const SCHEMA_VERSION = 8;

export const BASELINE_DDL = `
  CREATE TABLE photos (
    asset_id             TEXT PRIMARY KEY,
    uri                  TEXT NOT NULL,
    taken_at             INTEGER NOT NULL,
    state                TEXT NOT NULL DEFAULT 'unreviewed'
      CHECK (state IN ('unreviewed', 'kept', 'to_edit', 'done', 'culled', 'trashed')),
    group_id             TEXT,
    session_day          TEXT,
    mod_time             INTEGER,
    content_hash         TEXT,
    day                  TEXT,
    needs_edit           INTEGER NOT NULL DEFAULT 0,
    to_edit_at           INTEGER,
    favourite_state      TEXT NOT NULL DEFAULT 'none'
      CHECK (favourite_state IN ('none', 'queued_apply', 'applied', 'queued_remove', 'error')),
    favourite_changed_at INTEGER,
    favourite_applied_at INTEGER,
    edit_completed_at    INTEGER,
    reviewed_at          INTEGER,
    culled_at            INTEGER,
    favourite_target     INTEGER
      CHECK (favourite_target IS NULL OR favourite_target IN (0, 1)),

    -- Canonical volume-qualified identity (P4#2); tightened to NOT NULL
    -- with the ingestion boundary.
    volume_name          TEXT,
    raw_id               TEXT,
    content_uri          TEXT,

    -- Presence + feed ordering + trash generation (C#1, N#3, C#7, P8#4)
    is_present           INTEGER NOT NULL DEFAULT 1 CHECK (is_present IN (0, 1)),
    activity_at          INTEGER,
    trash_generation     INTEGER NOT NULL DEFAULT 0,

    -- Organize intents (item E; durable target + last applied, N#8)
    organize_state       TEXT NOT NULL DEFAULT 'none'
      CHECK (organize_state IN ('none', 'queued', 'applied', 'error')),
    organize_volume      TEXT,
    organize_path        TEXT,
    organize_changed_at  INTEGER,
    organize_applied_at  INTEGER,
    organize_applied_volume TEXT,
    organize_applied_path   TEXT
  );
  CREATE INDEX idx_photos_state ON photos(state);
  CREATE INDEX idx_photos_day ON photos(day);
  CREATE INDEX idx_photos_favourite_state ON photos(favourite_state);
  CREATE INDEX idx_photos_activity ON photos(activity_at DESC, asset_id DESC);
  CREATE INDEX idx_photos_present_state ON photos(is_present, state);
  CREATE INDEX idx_photos_organize ON photos(organize_state)
    WHERE organize_state <> 'none';

  CREATE TABLE duels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    group_id   TEXT NOT NULL,
    winner_id  TEXT NOT NULL,
    loser_id   TEXT NOT NULL,
    kept_both  INTEGER NOT NULL,
    at         INTEGER NOT NULL
  );
  CREATE INDEX idx_duels_session ON duels(session_id);

  CREATE TABLE sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    label           TEXT NOT NULL,
    range_start     INTEGER NOT NULL,
    range_end       INTEGER NOT NULL,
    snapshot        TEXT NOT NULL,
    reclaimed_bytes INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    completed_at    INTEGER,
    finished        INTEGER NOT NULL DEFAULT 0
  );
  -- One active session, enforced in the schema (C#3).
  CREATE UNIQUE INDEX idx_sessions_one_active ON sessions((1))
    WHERE completed_at IS NULL;

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE photo_hashes (
    asset_id TEXT PRIMARY KEY,
    hash     TEXT NOT NULL,
    mod_time INTEGER NOT NULL
  );

  -- Durable grouping: runs / groups / assignments (N#1, C#3)
  CREATE TABLE grouping_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    provenance  TEXT NOT NULL DEFAULT 'session' CHECK (provenance IN ('session')),
    created_at  INTEGER NOT NULL,
    scope       TEXT
  );
  CREATE UNIQUE INDEX idx_grouping_runs_one_per_session
    ON grouping_runs(session_id) WHERE session_id IS NOT NULL;

  CREATE TABLE photo_groups (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER NOT NULL REFERENCES grouping_runs(id) ON DELETE CASCADE,
    best_photo_id TEXT,
    UNIQUE (run_id, id),
    FOREIGN KEY (id, best_photo_id)
      REFERENCES photo_group_assignments(group_id, photo_id)
      DEFERRABLE INITIALLY DEFERRED
  );

  CREATE TABLE photo_group_assignments (
    photo_id TEXT PRIMARY KEY REFERENCES photos(asset_id) ON DELETE CASCADE,
    run_id   INTEGER NOT NULL REFERENCES grouping_runs(id) ON DELETE CASCADE,
    group_id INTEGER,
    UNIQUE (group_id, photo_id),
    FOREIGN KEY (run_id, group_id) REFERENCES photo_groups(run_id, id)
  );
  CREATE INDEX idx_assignments_group ON photo_group_assignments(group_id);
  CREATE INDEX idx_assignments_run ON photo_group_assignments(run_id);

  -- Scan-keyed day index with fence + coverage (N#4, P4#3, P5#5)
  CREATE TABLE day_index_scans (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    source_fingerprint        TEXT NOT NULL,
    volume_set                TEXT NOT NULL,
    volume_generations_start  TEXT,
    volume_generations_end    TEXT,
    coverage                  TEXT NOT NULL CHECK (coverage IN ('full', 'limited')),
    status                    TEXT NOT NULL
      CHECK (status IN ('in_progress', 'complete', 'failed')),
    started_at                INTEGER NOT NULL,
    completed_at              INTEGER
  );
  CREATE TABLE day_index (
    scan_id     INTEGER NOT NULL REFERENCES day_index_scans(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,
    photo_count INTEGER NOT NULL,
    PRIMARY KEY (scan_id, day)
  );

  -- Share queue: cycles / queue / batches / members (N#5, R#7, C#10)
  CREATE TABLE share_cycles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER
  );
  CREATE TABLE share_queue (
    photo_id  TEXT PRIMARY KEY REFERENCES photos(asset_id) ON DELETE CASCADE,
    cycle_id  INTEGER NOT NULL REFERENCES share_cycles(id),
    queued_at INTEGER NOT NULL
  );
  CREATE TABLE share_batches (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id     INTEGER NOT NULL REFERENCES share_cycles(id),
    attempted_at INTEGER NOT NULL,
    opened_at    INTEGER,
    label        TEXT,
    state        TEXT NOT NULL CHECK (state IN ('launching', 'sheet_opened', 'error'))
  );
  CREATE TABLE share_batch_members (
    batch_id INTEGER NOT NULL REFERENCES share_batches(id) ON DELETE CASCADE,
    photo_id TEXT NOT NULL REFERENCES photos(asset_id),
    PRIMARY KEY (batch_id, photo_id)
  );

  -- Durable trash lifecycle (P6#4, P7#4, P8#3, P8#4)
  CREATE TABLE trash_batches (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    state                    TEXT NOT NULL CHECK (state IN
      ('preparing', 'launching', 'verified', 'verified_partial', 'cancelled', 'error')),
    launched_from_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    created_at               INTEGER NOT NULL,
    dispatched_at            INTEGER,
    verified_at              INTEGER
  );
  CREATE TABLE trash_batch_members (
    batch_id         INTEGER NOT NULL REFERENCES trash_batches(id) ON DELETE CASCADE,
    photo_id         TEXT NOT NULL REFERENCES photos(asset_id),
    trash_generation INTEGER NOT NULL,
    measured_bytes   INTEGER NOT NULL DEFAULT 0,
    outcome          TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN
      ('pending', 'trashed', 'absent_after_interrupted_launch', 'still_present', 'unknown')),
    PRIMARY KEY (batch_id, photo_id)
  );
  CREATE UNIQUE INDEX idx_trash_terminal_per_generation
    ON trash_batch_members(photo_id, trash_generation)
    WHERE outcome IN ('trashed', 'absent_after_interrupted_launch');
  CREATE TABLE trash_reservations (
    photo_id         TEXT PRIMARY KEY REFERENCES photos(asset_id) ON DELETE CASCADE,
    batch_id         INTEGER NOT NULL REFERENCES trash_batches(id) ON DELETE CASCADE,
    trash_generation INTEGER NOT NULL
  );
  CREATE INDEX idx_trash_reservations_batch ON trash_reservations(batch_id);

  -- Durable edited-copy relationship so "Decide later" can resume (C#12)
  CREATE TABLE edit_copy_matches (
    original_id TEXT NOT NULL REFERENCES photos(asset_id) ON DELETE CASCADE,
    copy_id     TEXT NOT NULL REFERENCES photos(asset_id) ON DELETE CASCADE,
    state       TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'resolved', 'dismissed')),
    detected_at INTEGER NOT NULL,
    PRIMARY KEY (original_id, copy_id)
  );
`;

/**
 * Open-path schema guarantee. Fresh database → create the baseline.
 * Matching version → no-op. ANY other version → destructive reset
 * (pre-v1 policy; the old data is deliberately discarded).
 */
export async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL');
  // C#3: declared foreign keys mean nothing unless enforcement is on —
  // every connection, not only migrating ones (this is the open path).
  await db.execAsync('PRAGMA foreign_keys = ON');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current === SCHEMA_VERSION) return;
  await db.withExclusiveTransactionAsync(async (txn) => {
    if (current !== 0) await dropEverything(txn);
    await txn.execAsync(BASELINE_DDL);
    await txn.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/** Drop every user table (indexes/triggers fall with their tables). */
async function dropEverything(db: SQLiteDatabase): Promise<void> {
  // FK enforcement would order-constrain the drops; it is re-checked by
  // tests after the baseline is rebuilt.
  await db.execAsync('PRAGMA defer_foreign_keys = ON');
  const tables = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  for (const table of tables) {
    await db.execAsync(`DROP TABLE IF EXISTS "${table.name}"`);
  }
}
