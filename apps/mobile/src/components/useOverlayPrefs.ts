/**
 * The Overlay rows' persistence (m0.9 phase 7, lib/overlayPrefs): ONE
 * module-scope serial chain for every write, whichever Settings
 * instance issues it, and a read that waits for the chain to drain —
 * Expo SQLite promises no FIFO across concurrent async operations, so
 * a row toggled on the way out of Settings must still land before the
 * deck's focus read, and an abandoned instance's older write must never
 * commit after a newer instance's choice (codex round 6; the badgePrefs
 * pattern). The hook re-reads on every focus like the
 * animated-thumbnails mode — a row saved in Settings can never be
 * overtaken by a stale copy. The defaults stand until the read lands (a
 * stage that starts with everything on and loses a row a frame later is
 * the safe wrong).
 */
import { useEffect, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { getSettings, setSetting } from '../db/store';
import {
  DEFAULT_OVERLAY_PREFS,
  OVERLAY_KEYS,
  parseOverlayPrefs,
  serializeOverlayPref,
  type OverlayPrefs,
} from '../lib/overlayPrefs';

let chain: Promise<void> = Promise.resolve();

/** Persist one row, in issue order with every other row write. Rejects
 * when the write does; the chain itself carries on. */
export function writeOverlayRow(db: SQLiteDatabase, key: string, on: boolean): Promise<void> {
  const write = () => setSetting(db, key, serializeOverlayPref(on));
  const next = chain.then(write, write);
  chain = next.catch(() => undefined);
  return next;
}

/** The rows as SQLite holds them once every issued write has landed. */
export function readOverlayPrefs(db: SQLiteDatabase): Promise<OverlayPrefs> {
  return chain.then(() => getSettings(db, OVERLAY_KEYS)).then(parseOverlayPrefs);
}

export function useOverlayPrefs(): OverlayPrefs {
  const db = useSQLiteContext();
  const focused = useIsFocused();
  const [prefs, setPrefs] = useState<OverlayPrefs>(DEFAULT_OVERLAY_PREFS);
  useEffect(() => {
    if (!focused) return;
    let cancelled = false;
    void readOverlayPrefs(db).then(
      (loaded) => {
        if (!cancelled) setPrefs(loaded);
      },
      (error) => console.warn('[overlay] preferences read failed — defaults kept:', String(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [db, focused]);
  return prefs;
}
