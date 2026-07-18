import { FLAG_TYPES, type FlagType } from './types.js';

/**
 * Desktop flag queue (v0.2): while the slideshow runs, one keypress flags
 * the current photo — Delete / Edit / Move / Review — into a persistent
 * queue worked through later in organizer mode.
 *
 * Pure, immutable functions over a serializable state object. The app owns
 * persistence (electron-store / file); core owns the model.
 */

export interface FlagEntry {
  /** File path (or uri) of the flagged item. */
  path: string;
  flagType: FlagType;
  /** When the flag was captured, ms since epoch — injected by the caller. */
  at: number;
  /** Optional freeform note. */
  note?: string;
}

export interface FlagQueueState {
  entries: readonly FlagEntry[];
}

/** Serialized form (versioned so later releases can migrate). */
export interface FlagQueueJSON {
  version: 1;
  entries: FlagEntry[];
}

export function createFlagQueue(): FlagQueueState {
  return { entries: [] };
}

/**
 * Add a flag. Deduped by (path, flagType): re-flagging an already-flagged
 * item returns the state unchanged (the original `at` wins). The same path
 * may carry different flag types simultaneously.
 */
export function addFlag(state: FlagQueueState, entry: FlagEntry): FlagQueueState {
  if (!FLAG_TYPES.includes(entry.flagType)) {
    throw new Error(`addFlag: unknown flagType ${String(entry.flagType)}`);
  }
  if (state.entries.some((e) => e.path === entry.path && e.flagType === entry.flagType)) {
    return state;
  }
  return { entries: [...state.entries, { ...entry }] };
}

/** Remove one flag by (path, flagType). No-op if absent. */
export function removeFlag(
  state: FlagQueueState,
  path: string,
  flagType: FlagType,
): FlagQueueState {
  const entries = state.entries.filter((e) => !(e.path === path && e.flagType === flagType));
  return entries.length === state.entries.length ? state : { entries };
}

/** List entries, optionally filtered by flag type, oldest first. */
export function listFlags(state: FlagQueueState, flagType?: FlagType): FlagEntry[] {
  const entries = flagType ? state.entries.filter((e) => e.flagType === flagType) : state.entries;
  return [...entries];
}

/** Plain-JSON snapshot for persistence. */
export function flagQueueToJSON(state: FlagQueueState): FlagQueueJSON {
  return { version: 1, entries: state.entries.map((e) => ({ ...e })) };
}

/**
 * Restore a queue from persisted JSON (already-parsed object). Validates
 * shape, drops malformed entries, and re-applies (path, flagType) dedupe.
 */
export function flagQueueFromJSON(json: unknown): FlagQueueState {
  if (typeof json !== 'object' || json === null) {
    throw new Error('flagQueueFromJSON: not an object');
  }
  const obj = json as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`flagQueueFromJSON: unsupported version ${String(obj.version)}`);
  }
  if (!Array.isArray(obj.entries)) {
    throw new Error('flagQueueFromJSON: entries must be an array');
  }
  let state = createFlagQueue();
  for (const raw of obj.entries) {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof (raw as FlagEntry).path !== 'string' ||
      typeof (raw as FlagEntry).at !== 'number' ||
      !FLAG_TYPES.includes((raw as FlagEntry).flagType)
    ) {
      continue; // drop malformed entries rather than losing the whole queue
    }
    const e = raw as FlagEntry;
    state = addFlag(state, {
      path: e.path,
      flagType: e.flagType,
      at: e.at,
      ...(typeof e.note === 'string' ? { note: e.note } : {}),
    });
  }
  return state;
}
