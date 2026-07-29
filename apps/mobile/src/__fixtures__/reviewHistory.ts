/**
 * The shared review-history dataset (m0.8.2) — one synthetic 90-day
 * history consumed by BOTH test tiers: the pure forecast unit tests and
 * the real-SQLite store tests.
 *
 * It exists so the two tiers cannot disagree about what the data means.
 * A pure test that invents its own decision stamps and a DB test that
 * seeds different ones will both pass while describing different apps;
 * sharing the dataset makes a store query and the math over it provably
 * talk about the same photos.
 *
 * Everything is DERIVED from `photos` — the per-day maps are computed,
 * never hand-maintained beside it, so the fixture cannot drift out of
 * internal consistency. Generation is a seeded LCG: no Math.random, no
 * Date.now, so the same dataset appears on every machine and every run.
 *
 * Shape of the simulation (deliberately not uniform — flat data hides
 * exactly the bugs these tests exist to catch):
 * - capture volume varies by day, including days with nothing shot;
 * - review happens in SITTINGS, with realistic in-sitting gaps and long
 *   breaks between them, so sitting segmentation has something to find;
 * - photos are reviewed NEWEST FIRST, matching the real queue order;
 * - the cull rate DRIFTS across the history, so per-chunk base rates
 *   genuinely differ and projected ranges are non-degenerate;
 * - pending actions are BOTH queued and resolved, with real turnaround
 *   gaps between the two, because "ever actioned" and "waiting now" are
 *   different questions and several surfaces ask only one of them.
 */
import { dayKey, rangeOfDayKey } from '../lib/dates';

/** One queued or completed action, in `photo_actions` column terms. */
export interface FixtureAction {
  kind: 'edit' | 'favourite' | 'organize' | 'share';
  state: 'queued' | 'applied';
  /** Organize packs "volume\npath"; favourite is the '1'/'0' direction. */
  target: string | null;
  queuedAt: number;
  resolvedAt: number | null;
}

/** One photo in the fixture, in store column terms. */
export interface FixturePhoto {
  assetId: string;
  uri: string;
  takenAt: number;
  day: string;
  state: 'unreviewed' | 'kept' | 'culled' | 'trashed';
  /** Layer 2: every action this photo carries, queued or completed. */
  actions: FixtureAction[];
  /** Derived from `actions` — has an edit action at all (queued or done). */
  needsEdit: boolean;
  /** Derived — has a favourite action pointing AT favourite, not away. */
  favouriteTarget: boolean;
  /** Derived — has an organize action at all. */
  organized: boolean;
  /** Was in a share batch that reached the sheet (the durable proxy). */
  shared: boolean;
  sizeBytes: number;
  /** Latest verdict stamp; null while unreviewed. */
  decidedAt: number | null;
}

export interface ReviewHistory {
  /** Fixed "now" the dataset was built around (local noon). */
  todayMs: number;
  /** Calendar keys oldest FIRST, ending today — the shape every
   * forecast/streak caller passes. */
  dayKeys: string[];
  photos: FixturePhoto[];
  /** Decision-day counts, derived from `decidedAt`. */
  reviewedByDay: Map<string, number>;
  /** Capture-day counts over photos still present, derived from `day`. */
  capturedByDay: Map<string, number>;
  /** Every decision stamp, NEWEST first (the store's read order). */
  decisionStamps: number[];
  /** Photos with no verdict — the forecast's remaining pool. */
  remaining: number;
}

/** Days of history the fixture spans, including today. */
export const FIXTURE_DAYS = 90;

/** Local noon on a fixed date; built from local components so the
 * dataset's day keys are timezone-independent. */
export const FIXTURE_TODAY = new Date(2026, 5, 15, 12, 0, 0, 0).getTime();

/** Deterministic uniform [0, 1). Numerical Recipes LCG constants. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Integer in [min, max]. */
function pick(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

export function buildReviewHistory(): ReviewHistory {
  const rand = lcg(20260615);
  const todayMs = FIXTURE_TODAY;
  const todayStart = rangeOfDayKey(dayKey(todayMs)).startMs;
  const dayMs = 86_400_000;

  /**
   * Attach one action to a photo, completing it with probability
   * `resolveChance` after a turnaround somewhere in [minGap, maxGap].
   * Unresolved actions are what the queue screens show; resolved ones are
   * what the base rates and the turnaround stat read, and BOTH have to
   * exist in the dataset or half the queries look correct against it.
   */
  const queue = (
    photo: FixturePhoto,
    kind: FixtureAction['kind'],
    target: string | null,
    queuedAt: number,
    resolveChance: number,
    minGap: number,
    maxGap: number,
  ): void => {
    const resolvedAt = rand() < resolveChance ? queuedAt + pick(rand, minGap, maxGap) : null;
    photo.actions.push({
      kind,
      state: resolvedAt === null ? 'queued' : 'applied',
      target,
      queuedAt,
      resolvedAt,
    });
    if (kind === 'edit') photo.needsEdit = true;
    if (kind === 'favourite' && target === '1') photo.favouriteTarget = true;
    if (kind === 'organize') photo.organized = true;
  };

  // Day 0 is the oldest; FIXTURE_DAYS - 1 is today.
  const dayKeys: string[] = [];
  const dayStarts: number[] = [];
  for (let i = 0; i < FIXTURE_DAYS; i += 1) {
    const start = todayStart - (FIXTURE_DAYS - 1 - i) * dayMs;
    dayStarts.push(start);
    dayKeys.push(dayKey(start));
  }

  // ---- the pre-existing backlog: most of a real library was shot long
  // before the app was installed, and since review runs newest-first it
  // is what remains. Without it the simulation reaches inbox zero and
  // the forecast has nothing to forecast.
  const photos: FixturePhoto[] = [];
  for (let n = 0; n < 2600; n += 1) {
    const takenAt = dayStarts[0] - pick(rand, 1, 730) * dayMs - pick(rand, 0, dayMs - 1);
    photos.push({
      assetId: `external_primary/old-${n}`,
      uri: `file:///storage/emulated/0/DCIM/Camera/OLD_${n}.jpg`,
      takenAt,
      day: dayKey(takenAt),
      state: 'unreviewed',
      actions: [],
      needsEdit: false,
      favouriteTarget: false,
      organized: false,
      shared: false,
      sizeBytes: pick(rand, 1_800_000, 6_200_000),
      decidedAt: null,
    });
  }

  // ---- capture inside the window: uneven volume, with empty days.
  for (let i = 0; i < FIXTURE_DAYS; i += 1) {
    // Every 7th day nothing is shot: empty days must neither break
    // streaks nor be mistaken for "reviewed".
    const count = i % 7 === 3 ? 0 : pick(rand, 2, 26);
    for (let n = 0; n < count; n += 1) {
      const takenAt = dayStarts[i] + pick(rand, 8, 21) * 3_600_000 + pick(rand, 0, 3_599_000);
      const id = `external_primary/${i}-${n}`;
      photos.push({
        assetId: id,
        uri: `file:///storage/emulated/0/DCIM/Camera/IMG_${i}_${n}.jpg`,
        takenAt,
        day: dayKeys[i],
        state: 'unreviewed',
        actions: [],
        needsEdit: false,
        favouriteTarget: false,
        organized: false,
        shared: false,
        sizeBytes: pick(rand, 1_800_000, 6_200_000),
        decidedAt: null,
      });
    }
  }

  // ---- review: newest-first, in sittings, with a drifting cull rate.
  const undecided = [...photos].sort((a, b) => b.takenAt - a.takenAt);
  let cursor = 0;
  for (let i = 0; i < FIXTURE_DAYS; i += 1) {
    // Rest days are part of the honest pace denominator.
    if (i % 5 === 4) continue;
    // Fewer decisions than photos exist: the backlog outlives the window,
    // which is the situation the forecast is for.
    const target = pick(rand, 10, 45);
    // One or two sittings, each starting at a plausible hour.
    const sittings = pick(rand, 1, 2);
    const perSitting = Math.ceil(target / sittings);
    for (let s = 0; s < sittings; s += 1) {
      let stamp = dayStarts[i] + (s === 0 ? 9 : 20) * 3_600_000 + pick(rand, 0, 1_200_000);
      for (let n = 0; n < perSitting; n += 1) {
        const photo = undecided[cursor];
        if (photo === undefined) break;
        cursor += 1;
        // In-sitting gaps: 1.5-6 s, occasionally a longer think. Both
        // stay far below the self-tuned break threshold.
        stamp += pick(rand, 1_500, 6_000) + (rand() < 0.06 ? pick(rand, 8_000, 25_000) : 0);
        photo.decidedAt = stamp;
        // Cull rate drifts 0.20 -> 0.36 across the history, so per-chunk
        // base rates differ and the projected range has real width.
        const cullRate = 0.2 + (i / FIXTURE_DAYS) * 0.16;
        const roll = rand();
        if (roll < cullRate) {
          // Some staged culls have already gone to the system trash.
          photo.state = rand() < 0.4 ? 'trashed' : 'culled';
        } else if (roll < cullRate + 0.06) {
          photo.state = 'kept';
          queue(photo, 'edit', null, stamp, 0.55, 2 * 3_600_000, 6 * dayMs);
        } else {
          photo.state = 'kept';
        }
        // A tenth of favourite actions point the OTHER way: an un-favourite
        // is not a favourite, and every count that treats it as one is
        // wrong by exactly these photos.
        if (rand() < 0.05)
          queue(photo, 'favourite', rand() < 0.1 ? '0' : '1', stamp, 0.7, 60_000, 2 * dayMs);
        if (rand() < 0.04) photo.shared = true;
        if (rand() < 0.03) {
          queue(
            photo,
            'organize',
            'external_primary\nPictures/Albums/Trips',
            stamp,
            0.6,
            5 * 60_000,
            3 * dayMs,
          );
        }
      }
    }
  }

  // Every share the proxy counts also left an action row behind — the
  // batch is the durable fact, the action row is what the queue showed.
  for (const photo of photos) {
    if (!photo.shared || photo.decidedAt === null) continue;
    queue(photo, 'share', null, photo.decidedAt, 1, 30_000, dayMs);
  }

  const reviewedByDay = new Map<string, number>();
  const capturedByDay = new Map<string, number>();
  const decisionStamps: number[] = [];
  let remaining = 0;
  for (const photo of photos) {
    // Trashed photos have left MediaStore, so they are not intake.
    if (photo.state !== 'trashed') {
      capturedByDay.set(photo.day, (capturedByDay.get(photo.day) ?? 0) + 1);
    }
    if (photo.decidedAt === null) {
      remaining += 1;
      continue;
    }
    const key = dayKey(photo.decidedAt);
    reviewedByDay.set(key, (reviewedByDay.get(key) ?? 0) + 1);
    decisionStamps.push(photo.decidedAt);
  }
  decisionStamps.sort((a, b) => b - a);

  return {
    todayMs,
    dayKeys,
    photos,
    reviewedByDay,
    capturedByDay,
    decisionStamps,
    remaining,
  };
}

/** The slice of node:sqlite the real-DB tests hold (see db/testDb.ts). */
interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

export interface SeedOptions {
  /** Photos whose capture day is stripped — the undated bucket. */
  undatedIds?: readonly string[];
  /** Seed the share batch that makes `shared` true (default: yes). */
  shareBatches?: boolean;
  /** Timestamp for the seeded share cycle/batch. */
  at?: number;
}

/**
 * Write fixture photos, their actions and their share batch into a real
 * database. Direct inserts on purpose: these are READ-path tests, and the
 * scan's write path has its own contract tests.
 *
 * It lives beside the dataset rather than in each test file because the
 * mapping from a fixture photo to its `photo_actions` rows IS part of what
 * the fixture means — two test files inventing it separately is how the
 * tiers drift apart.
 */
export function seedReviewHistory(
  raw: RawDatabase,
  photos: readonly FixturePhoto[],
  options: SeedOptions = {},
): void {
  const undated = new Set(options.undatedIds ?? []);
  const photo = raw.prepare(
    `INSERT INTO photos
       (asset_id, uri, taken_at, day, state, size_bytes,
        reviewed_at, decided_at, culled_at, is_present)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const action = raw.prepare(
    `INSERT INTO photo_actions
       (photo_id, kind, state, target, applied_target, queued_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  raw.exec('BEGIN');
  for (const row of photos) {
    photo.run(
      row.assetId,
      row.uri,
      row.takenAt,
      undated.has(row.assetId) ? null : row.day,
      row.state,
      row.sizeBytes,
      row.decidedAt,
      row.decidedAt,
      // The lifetime cull marker stamps once, when the photo was staged.
      row.state === 'culled' || row.state === 'trashed' ? row.decidedAt : null,
      // Trashed photos have left MediaStore.
      row.state === 'trashed' ? 0 : 1,
    );
    for (const item of row.actions) {
      action.run(
        row.assetId,
        item.kind,
        item.state,
        item.target,
        item.resolvedAt === null ? null : item.target,
        item.queuedAt,
        item.resolvedAt,
      );
    }
  }
  raw.exec('COMMIT');

  if (options.shareBatches === false) return;
  const shared = photos.filter((row) => row.shared);
  if (shared.length === 0) return;
  const at = options.at ?? FIXTURE_TODAY;
  raw.prepare('INSERT INTO share_cycles (id, started_at) VALUES (1, ?)').run(at);
  raw
    .prepare(
      "INSERT INTO share_batches (id, cycle_id, attempted_at, opened_at, state) VALUES (1, 1, ?, ?, 'sheet_opened')",
    )
    .run(at, at);
  const member = raw.prepare('INSERT INTO share_batch_members (batch_id, photo_id) VALUES (1, ?)');
  raw.exec('BEGIN');
  for (const row of shared) member.run(row.assetId);
  raw.exec('COMMIT');
}

/**
 * Chunked outcome counts in decision order — the shape projectOutcomes
 * takes, and the independent check on the store's SQL.
 *
 * Slice sizes follow SQLite's NTILE rule exactly: with a remainder, the
 * FIRST `total % chunkCount` groups take the extra row, the rest take the
 * floor. Getting this wrong makes every chunk after the first disagree
 * with the query by one photo, which is why it is spelled out here.
 */
export function outcomeChunks(history: ReviewHistory, chunkCount: number) {
  const decided = history.photos
    .filter((photo) => photo.decidedAt !== null)
    .sort((a, b) => (a.decidedAt as number) - (b.decidedAt as number));
  const size = Math.floor(decided.length / chunkCount);
  const remainder = decided.length % chunkCount;
  const chunks = [];
  let offset = 0;
  for (let i = 0; i < chunkCount; i += 1) {
    const length = size + (i < remainder ? 1 : 0);
    const slice = decided.slice(offset, offset + length);
    offset += length;
    chunks.push({
      total: slice.length,
      culled: slice.filter((p) => p.state === 'culled' || p.state === 'trashed').length,
      toEdit: slice.filter((p) => p.needsEdit).length,
      favourited: slice.filter((p) => p.favouriteTarget).length,
      shared: slice.filter((p) => p.shared).length,
      organized: slice.filter((p) => p.organized).length,
    });
  }
  return chunks;
}
