/**
 * The ONE badge-visibility control (m0.8.7, F19/L6): a durable persisted
 * setting that hides EVERY photo badge — verdicts, actions, and the two
 * annotation badges — for an unobstructed look at the photo. No
 * per-badge settings (vetted 2026-08-21: a settings row earned by a
 * guess; if the cluster still feels noisy with the toggle in hand, that
 * complaint arrives with evidence).
 *
 * Module-scope observable, same shape as the scan status: BadgeCluster
 * subscribes, so ONE setting flips every surface at once, and the
 * durable row makes the choice survive restarts. Two access points,
 * same toggle (vetted 2026-08-21): the deck header's eye and the
 * PhotoViewer top bar's — the two surfaces where badges visually
 * compete with the photo.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { showToast } from './toast';

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

/** The last value KNOWN to be durable (loaded or successfully written) —
 * the only honest rollback anchor when a write fails. */
let lastPersisted = false;
/** Monotonic tap counter: only the LATEST tap may roll back or toast,
 * so a slow older failure cannot clobber a newer optimistic value
 * (codex m0.8.7 r2). */
let generation = 0;
/** ONE serial queue for the module's DB work (codex m0.8.7 r3): chained
 * ops complete in issue order BY CONSTRUCTION, so `lastPersisted` always
 * tracks the durable row without assuming the driver completes
 * concurrent async writes FIFO (Expo SQLite does not promise that). */
let chain: Promise<void> = Promise.resolve();
function enqueue(op: () => Promise<void>): Promise<void> {
  const next = chain.then(op, op);
  chain = next;
  return next;
}

/** Load the durable value once per process (App start). A read failure
 * keeps the default (shown) — badges appearing is the safe wrong. The
 * commit is FENCED: a tap that lands before the read resolves outranks
 * the startup value (codex m0.8.7 r3), whose row the tap's queued write
 * is about to overwrite anyway. */
export function loadBadgePrefs(db: SQLiteDatabase): Promise<void> {
  if (loaded) return Promise.resolve();
  loaded = true;
  return enqueue(async () => {
    try {
      const row = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM settings WHERE key = ?',
        HIDE_BADGES_KEY,
      );
      lastPersisted = row?.value === '1';
      if (generation === 0) commit(lastPersisted);
    } catch (error) {
      console.warn('[badges] visibility preference unreadable — badges shown:', String(error));
    }
  });
}

/** Flip and persist. The in-memory flip commits first so the UI answers
 * the tap instantly; the write runs on the serial queue. A failed write
 * ROLLS the flip back to the last PERSISTED value and says so (codex
 * m0.8.7 r1/r2) — a toggle that looks set but resets on restart would
 * present failure as success — but only when this tap is still the
 * LATEST: an older failure never clobbers a newer optimistic value.
 * Never rejects: the rollback + toast IS the surfacing. */
export function setBadgesHidden(db: SQLiteDatabase, value: boolean): Promise<void> {
  const gen = ++generation;
  commit(value);
  return enqueue(async () => {
    try {
      await db.runAsync(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        HIDE_BADGES_KEY,
        value ? '1' : '0',
      );
      // Chain order = issue order, so this is the durable row right now.
      lastPersisted = value;
    } catch (error) {
      console.warn('[badges] could not persist the visibility toggle:', String(error));
      if (gen === generation) {
        commit(lastPersisted);
        showToast('Could not save the badge setting — nothing was changed. Try again.');
      }
    }
  });
}
