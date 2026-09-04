/**
 * Phase-3 spike (a) instrument (docs/Plan_m0.9.md): ASSIGN THE
 * GIGABYTE. One `[perf] footprint` line breaks the app's storage into
 * the buckets the cache pass will act on — DB main, WAL, Glide's image
 * cache, and the rest of the document/cache trees — measured on the
 * build testers actually run (release; `run-as` needs debuggable, so
 * the walk lives in-app). Logged at app start and scan end, throttled;
 * the diag sink is EXCLUDED by name (external-files dir, unreachable
 * from Paths, self-capped at 50 MB by design — a bounded, named
 * omission, not a silent one).
 *
 * The walk is synchronous (`Directory.list()` / `File.size`, the
 * codebase's existing file API) and runs only on cold paths. This file
 * is the phase's measurement instrument: the DoD ("footprint ≤ durable
 * + budget, steady-state growth ≈ zero") is judged from its line, so it
 * outlives the spike.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { DATABASE_NAME } from '../db/database';
import { perfLog } from './perfLog';

/** Glide's default disk-cache directory name (expo-image on Android). */
const GLIDE_DIR = 'image_manager_disk_cache';
const SQLITE_DIR = 'SQLite';

function sizeOfTree(dir: Directory): number {
  let total = 0;
  for (const entry of dir.list()) {
    if (entry instanceof File) total += entry.size ?? 0;
    else total += sizeOfTree(entry);
  }
  return total;
}

function fileSize(dir: Directory, name: string): number {
  const f = new File(dir, name);
  try {
    return f.exists ? (f.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)}MB`;

let lastRun = 0;

/** Measure and log the footprint line. Throttled to one run per minute
 * (start and scan-end can coincide); `label` names the trigger. */
export function logFootprint(label: string): void {
  const now = Date.now();
  if (now - lastRun < 60_000) return;
  lastRun = now;
  try {
    const docs = Paths.document;
    const cache = Paths.cache;
    const sqliteDir = new Directory(docs, SQLITE_DIR);
    const db = fileSize(sqliteDir, DATABASE_NAME);
    const wal = fileSize(sqliteDir, `${DATABASE_NAME}-wal`);
    const shm = fileSize(sqliteDir, `${DATABASE_NAME}-shm`);
    const glideDir = new Directory(cache, GLIDE_DIR);
    let glide = 0;
    try {
      glide = sizeOfTree(glideDir);
    } catch {
      glide = 0; // absent until the first image caches
    }
    const docsTotal = sizeOfTree(docs);
    const cacheTotal = sizeOfTree(cache);
    const docsRest = docsTotal - db - wal - shm;
    const cacheRest = cacheTotal - glide;
    perfLog(
      () =>
        `footprint (${label}): db ${mb(db)} + wal ${mb(wal + shm)} · image cache ${mb(glide)} · ` +
        `docs rest ${mb(docsRest)} · cache rest ${mb(cacheRest)} · total ${mb(docsTotal + cacheTotal)} ` +
        `(diag sink excluded: external, ≤50MB by design)`,
    );
  } catch (error) {
    // The instrument must never wound the app it measures.
    console.warn('[perf] footprint walk failed:', String(error));
  }
}
