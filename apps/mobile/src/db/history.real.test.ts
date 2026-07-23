/**
 * History feed contracts on real SQLite (gate 4, item G: activity_at
 * ordering, keyset pagination, presence gating, share events).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import { getHistoryPage } from './store';
import { openTestDb, type TestDb } from './testDb';

const open: TestDb[] = [];
const AT = 1_800_000_000_000;

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

function insert(
  d: TestDb,
  id: string,
  state: string,
  activityAt: number,
  extras: Partial<Record<string, unknown>> = {},
): void {
  d.raw
    .prepare(
      `INSERT INTO photos (asset_id, uri, taken_at, day, state, activity_at, is_present, favourite_state, needs_edit)
       VALUES (?, 'content://x', ?, '2026-07-20', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      AT,
      state,
      activityAt,
      (extras.is_present as number) ?? 1,
      (extras.favourite_state as string) ?? 'none',
      (extras.needs_edit as number) ?? 0,
    );
}

describe('getHistoryPage', () => {
  it('orders by activity_at desc, drops absent photos, excludes unreviewed', async () => {
    const d = await fresh();
    insert(d, 'newest', 'kept', AT + 300);
    insert(d, 'older', 'culled', AT + 100);
    insert(d, 'gone', 'done', AT + 200, { is_present: 0 });
    insert(d, 'fresh', 'unreviewed', AT + 400);
    const page = await getHistoryPage(asExpo(d), 'all', null);
    expect(
      page.rows
        .filter((r) => r.kind === 'photo')
        .map((r) => (r.kind === 'photo' ? r.asset_id : '')),
    ).toEqual(['newest', 'older']);
  });

  it('keyset-paginates without skipping or duplicating', async () => {
    const d = await fresh();
    for (let i = 0; i < 95; i++) insert(d, `p${String(i).padStart(3, '0')}`, 'kept', AT + i);
    const first = await getHistoryPage(asExpo(d), 'all', null);
    expect(first.rows).toHaveLength(40);
    expect(first.next).not.toBeNull();
    const second = await getHistoryPage(asExpo(d), 'all', first.next);
    const third = await getHistoryPage(asExpo(d), 'all', second.next);
    const all = [...first.rows, ...second.rows, ...third.rows]
      .filter((r) => r.kind === 'photo')
      .map((r) => (r.kind === 'photo' ? r.asset_id : ''));
    expect(all).toHaveLength(95);
    expect(new Set(all).size).toBe(95);
    expect(third.next).toBeNull();
  });

  it('filters map to the pinned formulas (favourite = queued + applied)', async () => {
    const d = await fresh();
    insert(d, 'fav-q', 'done', AT + 1, { favourite_state: 'queued_apply' });
    insert(d, 'fav-a', 'done', AT + 2, { favourite_state: 'applied' });
    insert(d, 'plain', 'done', AT + 3);
    const favourites = await getHistoryPage(asExpo(d), 'favourite', null);
    expect(favourites.rows.map((r) => (r.kind === 'photo' ? r.asset_id : '')).sort()).toEqual([
      'fav-a',
      'fav-q',
    ]);
  });

  it('interleaves sheet_opened share events with labels; errors never appear', async () => {
    const d = await fresh();
    insert(d, 'p1', 'kept', AT + 10);
    d.raw.prepare('INSERT INTO share_cycles (started_at) VALUES (?)').run(AT);
    d.raw
      .prepare(
        "INSERT INTO share_batches (cycle_id, attempted_at, opened_at, label, state) VALUES (1, ?, ?, 'Mum', 'sheet_opened')",
      )
      .run(AT + 20, AT + 20);
    d.raw
      .prepare("INSERT INTO share_batches (cycle_id, attempted_at, state) VALUES (1, ?, 'error')")
      .run(AT + 30);
    d.raw.prepare("INSERT INTO share_batch_members VALUES (1, 'p1')").run();
    const page = await getHistoryPage(asExpo(d), 'all', null);
    const shares = page.rows.filter((r) => r.kind === 'share');
    expect(shares).toHaveLength(1);
    expect(shares[0].kind === 'share' && shares[0].label).toBe('Mum');
    // The opened event sorts ahead of the older photo decision.
    expect(page.rows[0].kind).toBe('share');
  });
});
