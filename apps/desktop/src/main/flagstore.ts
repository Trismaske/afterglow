/**
 * Persistent flag queue: @afterglow/core's flag model + atomic JSON
 * persistence at <userData>/flags.json.
 *
 * - Loads on start; a missing or corrupt file yields an empty queue (a bad
 *   byte on disk must never take the slideshow down).
 * - Every mutation persists via write-temp + rename (same atomicity story as
 *   settings.json); writes are serialized on a promise chain so overlapping
 *   mutations can't interleave their temp/rename pairs.
 * - All functions take the directory explicitly so tests can use a temp dir.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  addFlag,
  createFlagQueue,
  flagQueueFromJSON,
  flagQueueToJSON,
  listFlags,
  removeFlag,
  type FlagEntry,
  type FlagQueueState,
  type FlagType,
} from '@afterglow/core';

export const FLAGS_FILENAME = 'flags.json';

export interface FlagStore {
  /** All entries, oldest first. */
  list(): FlagEntry[];
  has(filePath: string, flagType: FlagType): boolean;
  /** True if any flag type references this path (queue-window action gate). */
  hasPath(filePath: string): boolean;
  /** Add a flag. Resolves true if newly added, false if it already existed. */
  add(entry: FlagEntry): Promise<boolean>;
  /** Remove a flag. Resolves true if an entry was removed. */
  remove(filePath: string, flagType: FlagType): Promise<boolean>;
  /** Resolves once all pending writes have hit the disk (tests, shutdown). */
  flush(): Promise<void>;
}

export interface FlagStoreOptions {
  /** Called after every successful mutation with the new entry list. */
  onChange?: (entries: FlagEntry[]) => void;
  /** Called for non-fatal problems (corrupt file, failed write). */
  onWarn?: (message: string, err?: unknown) => void;
}

/** Read + parse flags.json; missing/corrupt files yield an empty queue. */
export async function loadFlagQueue(dir: string, onWarn?: FlagStoreOptions['onWarn']): Promise<FlagQueueState> {
  const file = path.join(dir, FLAGS_FILENAME);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return createFlagQueue(); // first run: no file yet
  }
  try {
    return flagQueueFromJSON(JSON.parse(text));
  } catch (err) {
    onWarn?.(`flags file is corrupt, starting with an empty queue: ${file}`, err);
    return createFlagQueue();
  }
}

async function writeFlagQueue(dir: string, state: FlagQueueState): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, FLAGS_FILENAME);
  const tmp = path.join(dir, `${FLAGS_FILENAME}.tmp-${process.pid}-${Date.now()}`);
  const payload = JSON.stringify(flagQueueToJSON(state), null, 2) + '\n';
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, target);
}

/** Create a store over an already-loaded queue (see {@link loadFlagQueue}). */
export function createFlagStore(dir: string, initial: FlagQueueState, opts: FlagStoreOptions = {}): FlagStore {
  let state = initial;
  let writeChain: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    const snapshot = state;
    writeChain = writeChain
      .then(() => writeFlagQueue(dir, snapshot))
      .catch((err) => {
        opts.onWarn?.(`failed to persist ${FLAGS_FILENAME}`, err);
      });
    return writeChain;
  }

  return {
    list: () => listFlags(state),
    has: (filePath, flagType) => state.entries.some((e) => e.path === filePath && e.flagType === flagType),
    hasPath: (filePath) => state.entries.some((e) => e.path === filePath),
    async add(entry) {
      const next = addFlag(state, entry);
      if (next === state) return false;
      state = next;
      await persist();
      opts.onChange?.(listFlags(state));
      return true;
    },
    async remove(filePath, flagType) {
      const next = removeFlag(state, filePath, flagType);
      if (next === state) return false;
      state = next;
      await persist();
      opts.onChange?.(listFlags(state));
      return true;
    },
    flush: () => writeChain,
  };
}

/** Convenience: load flags.json from `dir` and wrap it in a store. */
export async function openFlagStore(dir: string, opts: FlagStoreOptions = {}): Promise<FlagStore> {
  return createFlagStore(dir, await loadFlagQueue(dir, opts.onWarn), opts);
}
