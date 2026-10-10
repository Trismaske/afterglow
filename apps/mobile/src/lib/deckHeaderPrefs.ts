/**
 * The deck header fold's durable row (lib/deckHeader.ts is the pure
 * half): one settings-table value read when the deck mounts and written
 * on every chevron tap, in tap order on one serial chain. The tap commits
 * in memory first and the write follows; a failed write says so with a toast and leaves the in-memory
 * fold as tapped (the next tap retries the row) — the same shape as the
 * eye (lib/badgePrefs.ts), without its rollback: a fold is a view
 * preference, re-chosen in one tap, never a state a user has to trust.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  DECK_HEADER_FOLD_KEY,
  NO_FOLD_CHOICES,
  parseFoldChoices,
  serializeFoldChoices,
  type FoldChoices,
} from './deckHeader';
import { showToast } from './toast';

/** One serial chain for the row's traffic: taps persist in tap order
 * and a read waits for the saves before it (codex round 9; the eye and
 * the Playback rows do the same). */
let chain: Promise<void> = Promise.resolve();
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(op, op);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function loadFoldChoices(db: SQLiteDatabase): Promise<FoldChoices> {
  return enqueue(() => readFoldChoices(db));
}

async function readFoldChoices(db: SQLiteDatabase): Promise<FoldChoices> {
  try {
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      DECK_HEADER_FOLD_KEY,
    );
    return parseFoldChoices(row?.value);
  } catch (error) {
    console.warn('[deck] header fold preference unreadable — defaults apply:', String(error));
    return NO_FOLD_CHOICES;
  }
}

export function saveFoldChoices(db: SQLiteDatabase, choices: FoldChoices): Promise<void> {
  return enqueue(() => writeFoldChoices(db, choices));
}

async function writeFoldChoices(db: SQLiteDatabase, choices: FoldChoices): Promise<void> {
  try {
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      DECK_HEADER_FOLD_KEY,
      serializeFoldChoices(choices),
    );
  } catch (error) {
    console.warn('[deck] could not persist the header fold:', String(error));
    showToast('Could not save the header choice — it holds until the deck closes.');
  }
}
