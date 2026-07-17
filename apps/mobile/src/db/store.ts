/**
 * Persistence operations over the schema in database.ts.
 * All multi-statement writes run in exclusive transactions.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import type { DuelRecord, PhotoState } from '@afterglow/core';
import type { LoadedPhoto } from '../lib/media';

export interface SessionRow {
  id: number;
  label: string;
  range_start: number;
  range_end: number;
  snapshot: string;
  reclaimed_bytes: number;
  created_at: number;
  completed_at: number | null;
}

/** The most recent unfinished session, if any (m0.1: one active at a time). */
export async function getActiveSession(db: SQLiteDatabase): Promise<SessionRow | null> {
  return db.getFirstAsync<SessionRow>(
    'SELECT * FROM sessions WHERE completed_at IS NULL ORDER BY created_at DESC LIMIT 1',
  );
}

/** Mark every unfinished session as ended (used when starting fresh). */
export async function abandonActiveSessions(db: SQLiteDatabase, at: number): Promise<void> {
  await db.runAsync('UPDATE sessions SET completed_at = ? WHERE completed_at IS NULL', at);
}

export interface NewSessionInput {
  label: string;
  rangeStart: number;
  rangeEnd: number;
  snapshot: string;
  photos: readonly (LoadedPhoto & { groupId: string | null })[];
  createdAt: number;
}

/** Create a session and upsert its photo rows. Returns the session id. */
export async function createSession(db: SQLiteDatabase, input: NewSessionInput): Promise<number> {
  let sessionId = -1;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const result = await txn.runAsync(
      `INSERT INTO sessions (label, range_start, range_end, snapshot, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      input.label,
      input.rangeStart,
      input.rangeEnd,
      input.snapshot,
      input.createdAt,
    );
    sessionId = Number(result.lastInsertRowId);
    for (const photo of input.photos) {
      await txn.runAsync(
        `INSERT INTO photos (asset_id, uri, taken_at, state, group_id, session_day, mod_time)
         VALUES (?, ?, ?, 'unreviewed', ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET
           uri = excluded.uri,
           state = 'unreviewed',
           group_id = excluded.group_id,
           session_day = excluded.session_day,
           mod_time = excluded.mod_time`,
        photo.item.id,
        photo.item.uri,
        photo.item.timestamp,
        photo.groupId,
        input.label,
        photo.modTime,
      );
    }
  });
  return sessionId;
}

/**
 * Persist one review decision atomically: the new session snapshot, the
 * photo states that changed, and (for duels) the duel record.
 */
export async function persistDecision(
  db: SQLiteDatabase,
  sessionId: number,
  snapshot: string,
  changedStates: readonly [assetId: string, state: PhotoState][],
  duel?: DuelRecord,
): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('UPDATE sessions SET snapshot = ? WHERE id = ?', snapshot, sessionId);
    for (const [assetId, state] of changedStates) {
      await txn.runAsync('UPDATE photos SET state = ? WHERE asset_id = ?', state, assetId);
    }
    if (duel) {
      await txn.runAsync(
        `INSERT INTO duels (session_id, group_id, winner_id, loser_id, kept_both, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        sessionId,
        duel.groupId,
        duel.winnerId,
        duel.loserId,
        duel.keptBoth ? 1 : 0,
        duel.at,
      );
    }
  });
}

/** Record bytes reclaimed by the confirmed delete batch. */
export async function addReclaimedBytes(
  db: SQLiteDatabase,
  sessionId: number,
  bytes: number,
): Promise<void> {
  await db.runAsync(
    'UPDATE sessions SET reclaimed_bytes = reclaimed_bytes + ? WHERE id = ?',
    bytes,
    sessionId,
  );
}

/** Mark the session finished. */
export async function completeSession(
  db: SQLiteDatabase,
  sessionId: number,
  at: number,
): Promise<void> {
  await db.runAsync('UPDATE sessions SET completed_at = ? WHERE id = ?', at, sessionId);
}

/** Store a lazily computed content hash (fallback identity). */
export async function setContentHash(
  db: SQLiteDatabase,
  assetId: string,
  hash: string,
): Promise<void> {
  await db.runAsync(
    'UPDATE photos SET content_hash = ? WHERE asset_id = ? AND content_hash IS NULL',
    hash,
    assetId,
  );
}
