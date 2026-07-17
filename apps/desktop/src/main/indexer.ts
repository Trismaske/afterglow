/**
 * Background EXIF library index (v0.3 story engine).
 *
 * For every scanned image we persist { path, mtimeMs, size, timestampMs,
 * source } at <userData>/index.json. `timestampMs` is the EXIF capture time
 * (DateTimeOriginal / CreateDate via exifr) when present, otherwise the file
 * mtime — timezone-naive local time per PLAN.md ("EXIF timestamp quirks").
 *
 * Incremental: on every build the fresh scan's stats are diffed against the
 * persisted index — only new files and files whose mtime or size changed get
 * re-extracted; entries for deleted files drop out. Extraction runs with
 * bounded concurrency (default 8) so it never starves the slideshow, and the
 * whole build happens off the display path (the show starts in shuffle and
 * hot-swaps when the index lands).
 *
 * The diff logic is a pure function over {path, mtime, size} maps so it is
 * unit-testable without a filesystem; IO is injectable for the same reason.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getImageDates } from './metadata';

export const INDEX_FILENAME = 'index.json';
export const INDEX_VERSION = 1;
export const DEFAULT_EXTRACT_CONCURRENCY = 8;

/** Where an entry's timestamp came from. */
export type TimestampSource = 'exif' | 'mtime';

/** One indexed file, as persisted in index.json. */
export interface IndexEntry {
  /** Absolute file path (the identity key). */
  path: string;
  /** File mtime at extraction time, ms — change detector. */
  mtimeMs: number;
  /** File size at extraction time, bytes — change detector. */
  size: number;
  /** Best-known capture time, ms since epoch (local naive). */
  timestampMs: number;
  source: TimestampSource;
}

/** A freshly stat()ed file from the current scan. */
export interface FileStat {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface IndexDiff {
  /** Entries carried over unchanged (same path, mtime and size). */
  reused: IndexEntry[];
  /** Files that are new or changed and need (re-)extraction. */
  toExtract: FileStat[];
}

/**
 * Pure diff of the persisted index against the current scan.
 *
 * - unchanged (same mtime AND size) → reused as-is, no extraction
 * - new, or mtime/size changed      → toExtract
 * - in `prev` but not in `current`  → dropped (deleted files)
 */
export function diffIndex(prev: ReadonlyMap<string, IndexEntry>, current: readonly FileStat[]): IndexDiff {
  const reused: IndexEntry[] = [];
  const toExtract: FileStat[] = [];
  for (const stat of current) {
    const known = prev.get(stat.path);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
      reused.push(known);
    } else {
      toExtract.push(stat);
    }
  }
  return { reused, toExtract };
}

/** Is this parsed JSON blob a valid IndexEntry? (Malformed rows are dropped.) */
function isIndexEntry(raw: unknown): raw is IndexEntry {
  if (typeof raw !== 'object' || raw === null) return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.path === 'string' &&
    e.path.length > 0 &&
    typeof e.mtimeMs === 'number' &&
    Number.isFinite(e.mtimeMs) &&
    typeof e.size === 'number' &&
    Number.isFinite(e.size) &&
    typeof e.timestampMs === 'number' &&
    Number.isFinite(e.timestampMs) &&
    (e.source === 'exif' || e.source === 'mtime')
  );
}

/**
 * Parse persisted index JSON into a path-keyed map. Tolerant: anything that
 * isn't a well-formed v1 index (or contains malformed rows) degrades to
 * fewer/zero entries — worst case the affected files get re-extracted.
 */
export function indexFromJSON(raw: unknown): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();
  if (typeof raw !== 'object' || raw === null) return map;
  const obj = raw as { version?: unknown; entries?: unknown };
  if (obj.version !== INDEX_VERSION || !Array.isArray(obj.entries)) return map;
  for (const entry of obj.entries) {
    if (isIndexEntry(entry)) map.set(entry.path, entry);
  }
  return map;
}

/** Serializable form of the index (stable order for clean diffs on disk). */
export function indexToJSON(entries: readonly IndexEntry[]): { version: number; entries: IndexEntry[] } {
  return {
    version: INDEX_VERSION,
    entries: [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/** Load index.json; a missing or corrupt file yields an empty index. */
export async function loadIndex(dir: string, onWarn?: (msg: string, err?: unknown) => void): Promise<Map<string, IndexEntry>> {
  const file = path.join(dir, INDEX_FILENAME);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return new Map(); // first run: no index yet
  }
  try {
    return indexFromJSON(JSON.parse(text));
  } catch (err) {
    onWarn?.(`index file is corrupt, rebuilding from scratch: ${file}`, err);
    return new Map();
  }
}

/** Atomically persist the index (write temp + rename, like settings.json). */
export async function saveIndex(dir: string, entries: readonly IndexEntry[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, INDEX_FILENAME);
  const tmp = path.join(dir, `${INDEX_FILENAME}.tmp-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, JSON.stringify(indexToJSON(entries)) + '\n', 'utf8');
  await fs.rename(tmp, target);
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface BuildIndexDeps {
  /** stat() a file; return null to skip it (vanished mid-scan). */
  statFile?: (filePath: string) => Promise<FileStat | null>;
  /** Extract the capture timestamp for one file (default: exifr + mtime). */
  extract?: (stat: FileStat) => Promise<Pick<IndexEntry, 'timestampMs' | 'source'>>;
  concurrency?: number;
  onWarn?: (msg: string, err?: unknown) => void;
  /** Abort check — return true to stop early (a newer scan superseded us). */
  isCancelled?: () => boolean;
}

async function defaultStatFile(filePath: string): Promise<FileStat | null> {
  try {
    const st = await fs.stat(filePath);
    return { path: filePath, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

async function defaultExtract(stat: FileStat): Promise<Pick<IndexEntry, 'timestampMs' | 'source'>> {
  const dates = await getImageDates(stat.path);
  if (dates.captureDateMs !== null) return { timestampMs: dates.captureDateMs, source: 'exif' };
  return { timestampMs: dates.fileDateMs ?? stat.mtimeMs, source: 'mtime' };
}

/**
 * Build (or incrementally refresh) the index for the given scan result:
 * stat everything, diff against `prev`, extract only what changed, and
 * return the full fresh entry list (unchanged + re-extracted, no deleted).
 * Returns null if cancelled mid-build.
 */
export async function buildIndex(
  files: readonly string[],
  prev: ReadonlyMap<string, IndexEntry>,
  deps: BuildIndexDeps = {},
): Promise<IndexEntry[] | null> {
  const {
    statFile = defaultStatFile,
    extract = defaultExtract,
    concurrency = DEFAULT_EXTRACT_CONCURRENCY,
    isCancelled = () => false,
  } = deps;

  const stats = (
    await mapLimit(files, concurrency, async (f) => (isCancelled() ? null : statFile(f)))
  ).filter((s): s is FileStat => s !== null);
  if (isCancelled()) return null;

  const { reused, toExtract } = diffIndex(prev, stats);

  const extracted = await mapLimit(toExtract, concurrency, async (stat): Promise<IndexEntry | null> => {
    if (isCancelled()) return null;
    try {
      const { timestampMs, source } = await extract(stat);
      return { ...stat, timestampMs, source };
    } catch (err) {
      deps.onWarn?.(`could not extract a date for ${stat.path}, skipping`, err);
      return null;
    }
  });
  if (isCancelled()) return null;

  return [...reused, ...extracted.filter((e): e is IndexEntry => e !== null)];
}
