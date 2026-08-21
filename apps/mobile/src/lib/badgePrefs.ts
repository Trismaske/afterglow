/**
 * The ONE badge-visibility control (m0.8.7, F19/L6): a durable persisted
 * setting that hides EVERY photo badge — verdicts, actions, and the two
 * annotation badges — for an unobstructed look at the photo. No
 * per-badge settings (vetted 2026-08-21: a settings row earned by a
 * guess; if the cluster still feels noisy with the toggle in hand, that
 * complaint arrives with evidence).
 *
 * Module-scope observable, same shape as the scan status: BadgeCluster
 * subscribes, so ONE control (the deck header's eye) flips every surface
 * at once, and the durable row makes the choice survive restarts.
 */
import type { SQLiteDatabase } from 'expo-sqlite';

const HIDE_BADGES_KEY = 'hide_badges';

let hidden = false;
let loaded = false;
const listeners = new Set<(hidden: boolean) => void>();

export function badgesHidden(): boolean {
  return hidden;
}

export function subscribeBadgesHidden(listener: (hidden: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function commit(value: boolean): void {
  if (hidden === value) return;
  hidden = value;
  for (const listener of listeners) listener(hidden);
}

/** Load the durable value once per process (App start). A read failure
 * keeps the default (shown) — badges appearing is the safe wrong. */
export async function loadBadgePrefs(db: SQLiteDatabase): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      HIDE_BADGES_KEY,
    );
    commit(row?.value === '1');
  } catch (error) {
    console.warn('[badges] visibility preference unreadable — badges shown:', String(error));
  }
}

/** Flip and persist. The in-memory flip commits first so the UI answers
 * the tap instantly; a failed write is surfaced (the toggle would
 * silently reset on restart otherwise). */
export async function setBadgesHidden(db: SQLiteDatabase, value: boolean): Promise<void> {
  commit(value);
  try {
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      HIDE_BADGES_KEY,
      value ? '1' : '0',
    );
  } catch (error) {
    console.warn('[badges] could not persist the visibility toggle:', String(error));
    throw error;
  }
}
