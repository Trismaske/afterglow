/**
 * Deck list-source parity suite (m0.9 phase 2, P2-1): the resolver
 * table must return EXACTLY what each host's own query returns —
 * membership, order, mapping, cursor plumbing — because the deck's
 * list mode replaces the surfaces that used those queries directly.
 * Real DB, real writers, no mocks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import { applyReviewDecisions, writeContinuousGroups, type ContinuousPhotoUpsert } from './store';
import { addToShareQueue } from './shareStore';
import { reconcileExternallyRemoved } from './trashStore';
import { resolveDeckListPage } from '../lib/deckList';
import { openTestDb, type TestDb } from './testDb';

const open: TestDb[] = [];
const AT = 1_800_000_000_000;
const DAY = '2026-07-20';

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

const id = (rawId: string): string => `external_primary/${rawId}`;

function upsert(rawId: string, takenAt: number): ContinuousPhotoUpsert {
  return {
    assetId: id(rawId),
    uri: `file:///dcim/${rawId}.jpg`,
    takenAt,
    fileGeneration: null,
    fileMtime: AT,
    modTime: takenAt,
    day: DAY,
    volumeName: 'external_primary',
    rawId,
    sizeBytes: 1_000,
  };
}

/** Seed singles via the scan's window write; later rawId = newer photo. */
async function seed(d: TestDb, rawIds: string[]): Promise<void> {
  await writeContinuousGroups(
    asExpo(d),
    {
      photos: rawIds.map((r, i) => upsert(r, AT - 3_600_000 + i * 60_000)),
      groups: [],
      singles: rawIds.map(id),
    },
    AT,
  );
}

describe('queue sources', () => {
  it('edit: membership and newest-first order match getToEditPhotos', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3']);
    await applyReviewDecisions(asExpo(d), [], AT + 10, {
      needsEditChanges: [
        { assetId: id('1'), needsEdit: true },
        { assetId: id('3'), needsEdit: true },
      ],
    });
    const page = await resolveDeckListPage(
      asExpo(d),
      { source: 'queue', queue: 'edit' },
      null,
      null,
      null,
    );
    // taken_at DESC: '3' is newer than '1'.
    expect(page.rows.map((r) => r.id)).toEqual([id('3'), id('1')]);
    expect(page.rows[0]).toEqual({
      id: id('3'),
      uri: 'file:///dcim/3.jpg',
      // The image cache version (item 3): the seed writes no generation,
      // so it is the mtime the upsert carried.
      version: AT,
      takenAt: AT - 3_600_000 + 2 * 60_000,
      day: DAY,
      state: 'unreviewed',
      tracked: true,
    });
    expect(page.next).toBeNull();
  });

  it('share: chronological order and mapping match getShareQueue', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    await addToShareQueue(asExpo(d), id('2'), AT + 5);
    await addToShareQueue(asExpo(d), id('1'), AT + 6);
    const page = await resolveDeckListPage(
      asExpo(d),
      { source: 'queue', queue: 'share' },
      null,
      null,
      null,
    );
    // taken_at ASC: '1' before '2' regardless of queue order.
    expect(page.rows.map((r) => r.id)).toEqual([id('1'), id('2')]);
    expect(page.next).toBeNull();
  });
});

describe('history source', () => {
  it('excludes tombstones — a swipe must not land on a gone photo', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'kept'],
        [id('2'), 'kept'],
      ],
      AT + 10,
    );
    await reconcileExternallyRemoved(asExpo(d), [id('1')], AT + 20);
    const page = await resolveDeckListPage(
      asExpo(d),
      { source: 'history', filter: 'all' },
      null,
      null,
      null,
    );
    expect(page.rows.map((r) => r.id)).toEqual([id('2')]);
    expect(page.next).toBeNull();
  });

  it('pages by the keyset cursor with no overlap and no gap', async () => {
    const d = await fresh();
    const rawIds = Array.from({ length: 45 }, (_, i) => String(i + 1));
    await seed(d, rawIds);
    await applyReviewDecisions(
      asExpo(d),
      rawIds.map((r) => [id(r), 'kept'] as [string, 'kept']),
      AT + 10,
    );
    const first = await resolveDeckListPage(
      asExpo(d),
      { source: 'history', filter: 'kept' },
      null,
      null,
      null,
    );
    expect(first.rows.length).toBe(40);
    expect(first.next).not.toBeNull();
    const second = await resolveDeckListPage(
      asExpo(d),
      { source: 'history', filter: 'kept' },
      first.next,
      null,
      null,
    );
    expect(second.rows.length).toBe(5);
    expect(second.next).toBeNull();
    const all = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(all).size).toBe(45);
  });
});

describe('grid source', () => {
  it('DB-filter day grids page by LIMIT/OFFSET and map GridPhotoRow', async () => {
    const d = await fresh();
    await seed(d, ['1', '2', '3']);
    await applyReviewDecisions(
      asExpo(d),
      [
        [id('1'), 'kept'],
        [id('3'), 'kept'],
      ],
      AT + 10,
    );
    const page = await resolveDeckListPage(
      asExpo(d),
      { source: 'grid', day: DAY, filter: 'kept' },
      null,
      null,
      null,
    );
    expect(page.rows.map((r) => r.id).sort()).toEqual([id('1'), id('3')].sort());
    expect(page.rows.every((r) => r.tracked && r.state === 'kept')).toBe(true);
    expect(page.next).toBeNull();
  });

  it('rows carry the image cache version — generation when known, else mtime (item 3)', async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 10);
    const page = await resolveDeckListPage(
      asExpo(d),
      { source: 'grid', day: DAY, filter: 'all' },
      null,
      null,
      null,
    );
    const versions = new Map(page.rows.map((r) => [r.id, r.version]));
    // seed() writes no generation: the version is the mtime the upsert carried.
    expect(versions.get(id('1'))).toBe(AT);
    expect(versions.get(id('2'))).toBe(AT);
  });

  it('library-scope verdict and action filters take the DB engine (engine parity)', async () => {
    // The S23 bug (2026-09-01): a Progress 'favourite' tile opened a
    // deck that streamed MediaStore against an action filter the stream
    // can never match. The MediaStore engine cannot even load here (a
    // native import), so a resolved page IS the proof of the DB route.
    const d = await fresh();
    await seed(d, ['1', '2', '3']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 10, {
      needsEditChanges: [{ assetId: id('2'), needsEdit: true }],
    });
    const edits = await resolveDeckListPage(
      asExpo(d),
      { source: 'grid', filter: 'act:edit' },
      null,
      null,
      null,
    );
    expect(edits.rows.map((r) => r.id)).toEqual([id('2')]);
    const kept = await resolveDeckListPage(
      asExpo(d),
      { source: 'grid', filter: 'kept' },
      null,
      null,
      null,
    );
    expect(kept.rows.map((r) => r.id)).toEqual([id('1')]);
    expect(kept.rows[0]?.tracked).toBe(true);
  });

  it("day-scope 'all' is DB-backed (m0.8.6) and includes unreviewed photos", async () => {
    const d = await fresh();
    await seed(d, ['1', '2']);
    await applyReviewDecisions(asExpo(d), [[id('1'), 'kept']], AT + 10);
    const page = await resolveDeckListPage(
      asExpo(d),
      { source: 'grid', day: DAY, filter: 'all' },
      null,
      null,
      null,
    );
    expect(page.rows.map((r) => r.id).sort()).toEqual([id('1'), id('2')].sort());
    const states = new Map(page.rows.map((r) => [r.id, r.state]));
    expect(states.get(id('1'))).toBe('kept');
    expect(states.get(id('2'))).toBe('unreviewed');
  });
});
