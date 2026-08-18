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
 * volume-qualified (`<volume>/<raw id>`; P4#2) with REAL volume identity
 * stamped at ingestion (m0.8.3, D7) — volume_name/raw_id are NOT NULL.
 * Group membership truth lives in the durable grouping relations
 * (grouping_runs / photo_groups / photo_group_assignments).
 *
 * Foreign keys are declared AND enforced (`PRAGMA foreign_keys = ON` on
 * every open; C#3). Schema-level invariants: one current group assignment
 * per photo (assignments PK), one continuous grouping run (partial
 * unique), one live trash reservation per photo (reservations PK), and
 * at most one absence-terminal trash outcome per (photo, generation)
 * (partial unique; P8#4). m0.8 gate 3: sessions are gone — photos.state
 * plus the grouping tables ARE the review model.
 */
import type { SQLiteDatabase } from 'expo-sqlite';

export const DATABASE_NAME = 'afterglow.db';

/** Bump on ANY schema change before v1 — the open path resets mismatches. */
export const SCHEMA_VERSION = 21;

export const BASELINE_DDL = `
  CREATE TABLE photos (
    asset_id             TEXT PRIMARY KEY,
    uri                  TEXT NOT NULL,
    taken_at             INTEGER NOT NULL,
    -- The VERDICT, and only the verdict (v18, docs/STATE_MODEL.md).
    -- 'to_edit' left: a flagged photo is KEPT with a pending edit, which
    -- lives in photo_actions. 'done' became 'kept' so the button's verb
    -- and the stored value are one word. 'confirmed' was never written.
    state                TEXT NOT NULL DEFAULT 'unreviewed'
      CHECK (state IN ('unreviewed', 'kept', 'culled', 'trashed')),
    mod_time             INTEGER,
    content_hash         TEXT,
    day                  TEXT,
    -- File size at last scan (v14): NULL until scanned post-migration.
    -- Powers the EXACT reclaimable-bytes sum (vetted: no estimates).
    size_bytes           INTEGER,
    reviewed_at          INTEGER,
    -- Last verdict action (v15): RE-stamps on every keep/cull/to-edit,
    -- unlike reviewed_at's first-stamp — the daily goal counts today's
    -- reviewing WORK (re-decides included), not first-ever reviews.
    decided_at           INTEGER,
    culled_at            INTEGER,

    -- Canonical volume-qualified identity (P4#2). v20: NOT NULL — every
    -- ingestion path stamps the REAL volume (m0.8.3, D7 mechanism D);
    -- reachability scoping and the per-volume scan key on this column.
    volume_name          TEXT NOT NULL,
    raw_id               TEXT NOT NULL,
    -- D15 EXIF rescue marker (v20): the MediaStore mod_time at which the
    -- photo's header was LAST successfully read for DateTimeOriginal
    -- (found or honestly absent). NULL = never completed — a failed read
    -- stays retry-eligible. Deliberately its own column: mod_time above
    -- is owned by edit detection (reset/preserved by edit cycles), so it
    -- cannot double as the rescue's once-per-content version.
    exif_checked_mod_time INTEGER,

    -- Presence + feed ordering + trash generation (C#1, N#3, C#7, P8#4)
    is_present           INTEGER NOT NULL DEFAULT 1 CHECK (is_present IN (0, 1)),
    activity_at          INTEGER,
    trash_generation     INTEGER NOT NULL DEFAULT 0
  );

  -- PENDING ACTIONS (v18) — layer 2 of docs/STATE_MODEL.md, one shape for
  -- all four. This replaces three different column groups on photos
  -- (needs_edit flag + 2 stamps; a 5-value favourite enum + target + 2
  -- stamps; a 4-value organize enum + target + applied target) and the
  -- share_queue table, which each had their own store, their own counts
  -- and their own bugs.
  --
  -- Queue membership is state = 'queued' — never "queued_at set and
  -- resolved_at null", which conflated "waiting" with "never actioned".
  -- resolved_at is the PERMANENT record that the action happened, and
  -- it survives the queue being cleared: it is what makes base rates,
  -- turnaround times and the forecast possible.
  CREATE TABLE photo_actions (
    photo_id    TEXT NOT NULL REFERENCES photos(asset_id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('edit', 'favourite', 'organize', 'share')),
    state       TEXT NOT NULL CHECK (state IN ('queued', 'applied', 'error')),
    -- Per-kind payload: organize packs volume + relative path (newline
    -- separated, see actions.ts); favourite is '1'/'0' for apply/remove;
    -- edit and share carry none.
    target      TEXT,
    -- What the LAST applied run actually achieved (organize's real
    -- destination, which can differ from the requested one).
    applied_target TEXT,
    queued_at   INTEGER NOT NULL,
    resolved_at INTEGER,
    PRIMARY KEY (photo_id, kind)
  );
  -- Both hot reads: the tab badges count queued rows per kind, and the
  -- queue screens list them.
  CREATE INDEX idx_actions_kind_state ON photo_actions(kind, state);

  CREATE INDEX idx_photos_state ON photos(state);
  CREATE INDEX idx_photos_day ON photos(day);
  CREATE INDEX idx_photos_activity ON photos(activity_at DESC, asset_id DESC);
  CREATE INDEX idx_photos_present_state ON photos(is_present, state);
  -- The daily goal's per-day counts and the Stats/Summary day summary both
  -- range-scan decided_at; measured 42.9 ms (SCAN photos) -> 28.4 ms
  -- (covering index). Partial: only decided rows are ever queried.
  -- (Deliberately NO index on taken_at: measured +116 ms of scan writes
  -- and the planner still prefers idx_photos_present_state for every
  -- ORDER BY taken_at read, so it never pays for itself.)
  CREATE INDEX idx_photos_decided ON photos(decided_at) WHERE decided_at IS NOT NULL;

  -- Compare history (m0.1+, mined by later features; m0.8: sessions are
  -- gone — a duel belongs to its group).
  CREATE TABLE duels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   TEXT NOT NULL,
    winner_id  TEXT NOT NULL,
    loser_id   TEXT NOT NULL,
    -- NULL = a verdict-free TRIAGE duel (3+ alive): history only,
    -- excluded from the kept-both statistic (v19).
    kept_both  INTEGER,
    at         INTEGER NOT NULL
  );

  -- The regroup boundary asks 'does this group carry duels?' twice per
  -- scan window; without this the EXISTS scanned every duel per group,
  -- growing with the user's whole compare history.
  CREATE INDEX idx_duels_group ON duels(group_id);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- m0.8: hashes carry their producer — the manipulator (session flow,
  -- JPEG-round-trip 9x8) and the native module (scan, box-averaged full
  -- decode) resample differently, so cross-source Hamming comparisons
  -- would blur the ≤8/64 near-dup floor. The scan trusts only 'native'
  -- rows; the manipulator path retires with sessions at gate 3.
  CREATE TABLE photo_hashes (
    asset_id TEXT PRIMARY KEY,
    hash     TEXT NOT NULL,
    mod_time INTEGER NOT NULL,
    source   TEXT NOT NULL DEFAULT 'manipulator' CHECK (source IN ('manipulator', 'native'))
  );

  -- m0.8 continuous-scan embeddings (gate 2): one current vector per
  -- asset, keyed like photo_hashes (stale when mod_time moves). vec is
  -- little-endian float32 bytes (1280 dims, L2-normalized). The embedding
  -- model's SHA-256 lives in settings ('embedding_model_sha256'); a model
  -- swap clears this table in one explicit re-embed event. No FK — the
  -- scan embeds photos before any review row exists for them.
  CREATE TABLE photo_embeddings (
    asset_id TEXT PRIMARY KEY,
    mod_time INTEGER NOT NULL,
    vec      BLOB NOT NULL
  );

  -- Durable grouping: the single scan-owned continuous run + groups +
  -- one current assignment per photo (m0.8 gate 3: sessions are gone).
  CREATE TABLE grouping_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provenance  TEXT NOT NULL DEFAULT 'continuous' CHECK (provenance IN ('continuous')),
    created_at  INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_grouping_runs_one_continuous
    ON grouping_runs((1)) WHERE provenance = 'continuous';

  CREATE TABLE photo_groups (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER NOT NULL REFERENCES grouping_runs(id) ON DELETE CASCADE,
    UNIQUE (run_id, id)
  );

  CREATE TABLE photo_group_assignments (
    photo_id TEXT PRIMARY KEY REFERENCES photos(asset_id) ON DELETE CASCADE,
    run_id   INTEGER NOT NULL REFERENCES grouping_runs(id) ON DELETE CASCADE,
    group_id INTEGER,
    -- m0.8: grouped by TIME because the embedding was unavailable (the UI
    -- badges these; the scan rewrites them once the embedding lands).
    time_attached INTEGER NOT NULL DEFAULT 0 CHECK (time_attached IN (0, 1)),
    -- m0.8: the USER ejected this photo to singles ('not related') — the
    -- scan must never regroup it (singles are never promoted, settled
    -- contract); only a user decision or regroup-everything opt-in clears it.
    user_single INTEGER NOT NULL DEFAULT 0 CHECK (user_single IN (0, 1)),
    UNIQUE (group_id, photo_id),
    FOREIGN KEY (run_id, group_id) REFERENCES photo_groups(run_id, id)
  );
  CREATE INDEX idx_assignments_group ON photo_group_assignments(group_id);
  -- (run_id, group_id), NOT run_id alone: there is exactly ONE continuous
  -- run, so a run_id-only index matches every assignment row — and the FK
  -- "(run_id, group_id) -> photo_groups(run_id, id)" made SQLite re-scan
  -- the whole assignments table on EVERY group delete (repairGroupMembership
  -- runs per scan window). Measured 54.5 ms -> 2.15 ms per 50 deletes.
  CREATE INDEX idx_assignments_run_group ON photo_group_assignments(run_id, group_id);
  -- (idx_assignments_run is deliberately absent: run_id alone matches
  -- every row, so it only ever misled the planner.)

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

  -- Share EVENT LOG: cycles / batches / members (N#5, R#7, C#10).
  --
  -- v18: share_queue is gone — queue membership is a photo_actions row
  -- like every other action. What stays is the log, because "these six
  -- photos went to Mum together" is a fact about a BATCH, not a photo,
  -- and three behaviours need it: per-cycle pass badges, next-pass
  -- auto-selection of the not-yet-sent, and History's share stream.
  --
  -- The queue row no longer carries a cycle_id: at most one cycle is
  -- open (ended_at IS NULL), so a photo's pass count is its batches in
  -- THAT cycle. One less thing to keep consistent.
  CREATE TABLE share_cycles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER
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
 *
 * v18 removed the ADDITIVE v13→v17 path entirely. That path existed to
 * spare validated review data and 27k embeddings when a migration only
 * added nullable columns — but v18 rewrites the state vocabulary itself
 * ('done' → 'kept', 'to_edit' and 'confirmed' gone) and moves four
 * action models into one table. There is no additive spelling of that,
 * and a half-migrated verdict column is worse than a rescan.
 */

export async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL');
  // C#3: declared foreign keys mean nothing unless enforcement is on —
  // every connection, not only migrating ones (this is the open path).
  // Transaction-scoped connections get theirs in withWriteTransaction.
  await db.execAsync('PRAGMA foreign_keys = ON');
  // Writer collisions WAIT instead of failing: the scan, queue reads,
  // and user decisions run on separate connections (see
  // withWriteTransaction), and SQLite's default busy timeout of 0 turns
  // any overlap into an instant "database is locked".
  await db.execAsync('PRAGMA busy_timeout = 30000');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current === SCHEMA_VERSION) {
    // Keep the query planner's stats fresh. SQLite's recommended
    // open-path call: cheap, and a no-op unless a table changed enough to
    // warrant re-analysis. Missing stats are what let the planner pick a
    // quadratic order for the review-queue EXISTS (14 s reads).
    await db.execAsync('PRAGMA optimize');
    return;
  }
  await db.withExclusiveTransactionAsync(async (txn) => {
    if (current !== 0) await dropEverything(txn);
    await txn.execAsync(BASELINE_DDL);
    await txn.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/**
 * EVERY store-layer transaction goes through here (m0.8.1). expo-sqlite's
 * withExclusiveTransactionAsync opens a FRESH connection per transaction
 * (its internal Transaction subclass passes useNewConnection), and SQLite
 * session pragmas are per-connection — so those transactions ran with
 * foreign_keys OFF (C#3 silently unenforced inside the very transactions
 * that write) and busy_timeout 0, where any writer collision with a
 * concurrent scan window surfaced instantly as "database is locked"
 * (device-observed: a favourite toggle failing loudly mid-scan on the
 * S23). PRAGMA foreign_keys is a no-op while a transaction is open, so
 * the wrapper closes the implicit deferred BEGIN (nothing has run — the
 * ROLLBACK discards an empty transaction), arms the session pragmas, and
 * re-opens the transaction, all on the transaction's private connection
 * before any statement takes the WAL write lock.
 *
 * The open-path migration transactions above deliberately stay on the
 * raw call: they run before anything can contend, and dropEverything
 * relies on unenforced-FK drop ordering (defer_foreign_keys).
 */
async function withSessionTransaction(
  db: SQLiteDatabase,
  begin: 'BEGIN IMMEDIATE' | 'BEGIN',
  task: (txn: SQLiteDatabase) => Promise<void>,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.execAsync(
      `ROLLBACK; PRAGMA busy_timeout = 30000; PRAGMA foreign_keys = ON; ${begin}`,
    );
    await task(txn);
  });
}

/** Store-layer WRITE transaction. BEGIN IMMEDIATE takes the WAL write
 * lock up front (waiting out contention under busy_timeout): a deferred
 * transaction that reads before writing — the validate-then-update shape
 * of every decision write — would instead hit an unwaitable
 * SQLITE_BUSY_SNAPSHOT whenever the scan committed in between. */
export async function withWriteTransaction(
  db: SQLiteDatabase,
  task: (txn: SQLiteDatabase) => Promise<void>,
): Promise<void> {
  await withSessionTransaction(db, 'BEGIN IMMEDIATE', task);
}

/** Store-layer READ-SNAPSHOT transaction (the queue reads): deferred, so
 * WAL readers run concurrently with the scan's writer instead of
 * serializing behind it — a snapshot needs consistency, never the lock. */
export async function withReadTransaction(
  db: SQLiteDatabase,
  task: (txn: SQLiteDatabase) => Promise<void>,
): Promise<void> {
  await withSessionTransaction(db, 'BEGIN', task);
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
