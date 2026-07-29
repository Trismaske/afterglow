/**
 * Habits aggregates on real SQLite (m0.8.2): the rhythm grid's local-hour
 * bucketing, queue turnaround over `photo_actions`, the duel summary, and
 * the rolling decisiveness window.
 *
 * Seeded from the shared 90-day fixture, with expectations derived from
 * the same dataset in JS — an independent implementation of the same
 * spec rather than a copy of the SQL's output.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  getDecisionOutcomesSince,
  getDecisionRhythm,
  getDuelSummary,
  getQueueTurnaround,
} from './store';
import { openTestDb, type TestDb } from './testDb';
import { buildReviewHistory, seedReviewHistory } from '../__fixtures__/reviewHistory';

const open: TestDb[] = [];

function asExpo(d: TestDb): SQLiteDatabase {
  return d as unknown as SQLiteDatabase;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

async function fresh(): Promise<TestDb> {
  const d = openTestDb();
  open.push(d);
  d.raw.exec('PRAGMA foreign_keys = ON');
  await migrateDatabase(asExpo(d));
  return d;
}

describe('getDecisionRhythm', () => {
  it('buckets every decision by LOCAL weekday and hour', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seedReviewHistory(d.raw, history.photos, { shareBatches: false });

    const cells = await getDecisionRhythm(asExpo(d), null);
    // Independent derivation with the JS Date the app itself uses; if
    // SQLite's 'localtime' disagreed with it, the grid would silently
    // describe a different day than the rest of the app.
    const expected = new Map<string, number>();
    for (const photo of history.photos) {
      if (photo.decidedAt === null) continue;
      const date = new Date(photo.decidedAt);
      const key = `${date.getDay()}:${date.getHours()}`;
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    expect(cells).toHaveLength(expected.size);
    for (const cell of cells) {
      expect(cell.count).toBe(expected.get(`${cell.weekday}:${cell.hour}`));
    }
    expect(cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(history.decisionStamps.length);
  });

  it('counts nothing for an undecided library', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seedReviewHistory(
      d.raw,
      history.photos.slice(0, 30).map((photo) => ({
        ...photo,
        decidedAt: null,
        state: 'unreviewed' as const,
      })),
      { shareBatches: false },
    );
    expect(await getDecisionRhythm(asExpo(d), null)).toEqual([]);
  });
});

describe('getQueueTurnaround', () => {
  it('separates what is waiting from what was ever finished', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seedReviewHistory(d.raw, history.photos, { shareBatches: false });

    const rows = await getQueueTurnaround(asExpo(d));
    const byKind = new Map(rows.map((row) => [row.kind, row]));
    for (const kind of ['edit', 'favourite', 'organize', 'share'] as const) {
      const waiting = history.photos.filter(
        (photo) =>
          // Queue membership is LIVE work: a staged cull or a trashed
          // photo is not waiting for you, however it is flagged.
          photo.state !== 'culled' &&
          photo.state !== 'trashed' &&
          photo.actions.some((action) => action.kind === kind && action.resolvedAt === null),
      ).length;
      const finished = history.photos.filter((photo) =>
        photo.actions.some((action) => action.kind === kind && action.resolvedAt !== null),
      ).length;
      expect(byKind.get(kind)?.waiting, `${kind} waiting`).toBe(waiting);
      expect(byKind.get(kind)?.finished, `${kind} finished`).toBe(finished);
    }
  });

  it('reports gaps only for work that actually completed', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seedReviewHistory(d.raw, history.photos, { shareBatches: false });

    const rows = await getQueueTurnaround(asExpo(d));
    for (const row of rows) {
      expect(row.gaps.every((gap) => gap >= 0)).toBe(true);
      expect(row.gaps.length).toBeLessThanOrEqual(row.finished);
    }
    const edit = rows.find((row) => row.kind === 'edit')!;
    // The fixture completes edits between 2 hours and 6 days out.
    expect(Math.min(...edit.gaps)).toBeGreaterThanOrEqual(2 * 3_600_000);
    expect(Math.max(...edit.gaps)).toBeLessThanOrEqual(6 * 86_400_000);
  });

  it('always reports all four kinds, even empty ones', async () => {
    const d = await fresh();
    const rows = await getQueueTurnaround(asExpo(d));
    expect(rows.map((row) => row.kind)).toEqual(['edit', 'favourite', 'organize', 'share']);
    expect(rows.every((row) => row.waiting === 0 && row.finished === 0)).toBe(true);
    // An empty queue has no oldest item — null, never 0, which would read
    // as "queued at the epoch" and stall every row forever.
    expect(rows.every((row) => row.oldestWaitingAt === null)).toBe(true);
  });

  it('reports the oldest STILL-WAITING item, ignoring finished and dead work', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seedReviewHistory(d.raw, history.photos, { shareBatches: false });

    const rows = await getQueueTurnaround(asExpo(d));
    for (const row of rows) {
      // Independent derivation: the earliest queued_at among rows the
      // SAME live-work rule counts as waiting.
      const waitingStamps = history.photos
        .filter((photo) => photo.state !== 'culled' && photo.state !== 'trashed')
        .flatMap((photo) =>
          photo.actions
            .filter((action) => action.kind === row.kind && action.resolvedAt === null)
            .map((action) => action.queuedAt),
        );
      const expected = waitingStamps.length === 0 ? null : Math.min(...waitingStamps);
      expect(row.oldestWaitingAt, `${row.kind} oldest`).toBe(expected);
      if (row.oldestWaitingAt !== null) expect(row.waiting).toBeGreaterThan(0);
    }
  });
});

describe('getDuelSummary', () => {
  it('counts duels and how many kept both', async () => {
    const d = await fresh();
    const insert = d.raw.prepare(
      "INSERT INTO duels (group_id, winner_id, loser_id, kept_both, at) VALUES ('1', 'a', 'b', ?, 1)",
    );
    for (const keptBoth of [0, 1, 1, 0, 0]) insert.run(keptBoth);
    expect(await getDuelSummary(asExpo(d))).toEqual({ duels: 5, keptBoth: 2 });
  });

  it('is zero, not null, on an empty history', async () => {
    const d = await fresh();
    expect(await getDuelSummary(asExpo(d))).toEqual({ duels: 0, keptBoth: 0 });
  });
});

describe('getDecisionOutcomesSince', () => {
  it('counts the rolling window against the same cull definition', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seedReviewHistory(d.raw, history.photos, { shareBatches: false });

    const sinceMs = history.todayMs - 30 * 86_400_000;
    const inWindow = history.photos.filter(
      (photo) => photo.decidedAt !== null && photo.decidedAt >= sinceMs,
    );
    const result = await getDecisionOutcomesSince(asExpo(d), sinceMs, null);
    expect(result.decided).toBe(inWindow.length);
    // Culled = staged OR already trashed, exactly as the base rates read it.
    expect(result.culled).toBe(
      inWindow.filter((photo) => photo.state === 'culled' || photo.state === 'trashed').length,
    );
  });

  it('is empty when the window predates every decision', async () => {
    const history = buildReviewHistory();
    const d = await fresh();
    seedReviewHistory(d.raw, history.photos, { shareBatches: false });
    expect(await getDecisionOutcomesSince(asExpo(d), history.todayMs + 86_400_000, null)).toEqual({
      decided: 0,
      culled: 0,
    });
  });
});
