/**
 * The Playback rows' settings traffic (m0.9 close-out, codex round 4):
 * the two per-kind modes (lib/playbackPrefs) and the animated-thumbnails
 * row (lib/animatedCells) write through ONE module-scope serial chain,
 * whichever Settings instance issues the write, and every consumer's
 * read waits for the chain to drain — the same discipline the Overlay
 * rows have (components/useOverlayPrefs). Without it expo-sqlite's IO
 * dispatcher could commit an older tap after a newer one while the
 * control showed the newer, and the deck's focus read or the grid's
 * mode read could land before an outstanding save.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { getSetting, setSetting } from '../db/store';

let chain: Promise<void> = Promise.resolve();

/** Persist one playback setting, in issue order with every other.
 * Rejects when the write does; the chain itself carries on. */
export function writePlaybackValue(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  const write = () => setSetting(db, key, value);
  const next = chain.then(write, write);
  chain = next.catch(() => undefined);
  return next;
}

/** Read playback settings after every issued write has settled. */
export function readPlaybackValues(
  db: SQLiteDatabase,
  keys: readonly string[],
): Promise<(string | null)[]> {
  return chain.then(() => Promise.all(keys.map((key) => getSetting(db, key))));
}
