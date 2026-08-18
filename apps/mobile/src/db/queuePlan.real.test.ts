/**
 * Queue-read scalability regression (m0.8.1). The review-queue group
 * query once let SQLite start its EXISTS from idx_photos_present_state —
 * every group re-scanning every unreviewed photo (~200M index probes,
 * a MEASURED 14 s read on a 27k corpus that made Home take 44 s to load
 * and every scan-time refresh pass crawl). The CROSS JOIN order hint in
 * listReviewGroupsIn pins the sane plan; these tests pin BOTH the plan
 * shape (stable across machines) and a generous wall-clock tripwire on
 * a full-scale corpus (26× headroom over the fixed cost — only a
 * quadratic regression can trip it).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase, withWriteTransaction } from './database';
import { readReviewQueue, repairGroupMembership } from './store';
import { foreignKeyCheck, openTestDb, type TestDb } from './testDb';

const open: TestDb[] = [];
const AT = 1_800_000_000_000;

afterEach(() => {
  while (open.length) open.pop()!.close();
});

/** 27k-photo corpus seeded with RAW bulk inserts (fast): 70% in ~3-photo
 * groups, 30% singles — the S23 test corpus shape. */
async function seedLarge(): Promise<TestDb> {
  const d = openTestDb();
  open.push(d);
  d.raw.exec('PRAGMA foreign_keys = ON');
  await migrateDatabase(d as unknown as SQLiteDatabase);
  d.raw.exec('BEGIN');
  d.raw.exec("INSERT INTO grouping_runs (id, provenance, created_at) VALUES (1, 'continuous', 1)");
  const photo = d.raw.prepare(
    `INSERT INTO photos (asset_id, uri, taken_at, state, day, volume_name, raw_id)
     VALUES (?, ?, ?, 'unreviewed', '2026-07-20', 'external_primary', ?)`,
  );
  const group = d.raw.prepare('INSERT INTO photo_groups (id, run_id) VALUES (?, 1)');
  const assign = d.raw.prepare(
    'INSERT INTO photo_group_assignments (photo_id, run_id, group_id) VALUES (?, 1, ?)',
  );
  let groupId = 0;
  for (let i = 0; i < 27_000;) {
    const size = groupId % 10 < 7 ? 3 : 1;
    let gid: number | null = null;
    if (size > 1) {
      groupId += 1;
      gid = groupId;
      group.run(gid);
    } else {
      groupId += 1;
    }
    for (let k = 0; k < size && i < 27_000; k += 1, i += 1) {
      const id = `external_primary/${i}`;
      photo.run(id, `file:///dcim/${i}.jpg`, AT - i * 30_000, String(i));
      assign.run(id, gid);
    }
  }
  d.raw.exec('COMMIT');
  return d;
}

describe('review-queue group query plan', () => {
  it('the EXISTS walks assignments-by-group, never photos-by-state', async () => {
    const d = await seedLarge();
    const plan = d.raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT g.id FROM photo_groups g
         WHERE EXISTS (
           SELECT 1 FROM photo_group_assignments a CROSS JOIN photos p
           WHERE a.group_id = g.id AND p.asset_id = a.photo_id
             AND p.state = 'unreviewed' AND p.is_present = 1)`,
      )
      .all() as { detail: string }[];
    const subquery = plan.map((r) => r.detail).join(' | ');
    // The correlated subquery must SEARCH assignments by group_id and
    // probe photos by primary key — the inverted plan (photos via
    // idx_photos_present_state first) is the quadratic one.
    expect(subquery).toMatch(/SEARCH a USING/);
    expect(subquery).not.toMatch(/SEARCH p USING INDEX idx_photos_present_state/);
  });

  it('readReviewQueue completes at 27k scale (quadratic-regression tripwire)', async () => {
    const d = await seedLarge();
    const t0 = performance.now();
    const q = await readReviewQueue(d as unknown as SQLiteDatabase, 100, 500);
    const elapsed = performance.now() - t0;
    expect(q.groups).toHaveLength(100);
    expect(q.counts.grouped + q.counts.singles).toBe(27_000);
    // Fixed cost measured ~0.4 s here, ~15 s when quadratic.
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);
});

describe('index coverage for hot paths (m0.8.1 audit)', () => {
  it('the four tab badges count queued actions from one index', async () => {
    const d = await seedLarge();
    // Every queue read is now one shape over photo_actions (v18), and all
    // of them run on the tab-badge refresh. The predecessor of this test
    // pinned a partial index on "organize_state <> 'none'", which SQLite's
    // implication analysis rejected for "IN ('queued','error')" — the
    // index was unusable and every organize read scanned all 27k photos.
    // idx_actions_kind_state(kind, state) serves both the grouped count
    // and the per-kind listing, and the queue is small by construction.
    const action = d.raw.prepare(
      `INSERT INTO photo_actions (photo_id, kind, state, queued_at)
       VALUES (?, ?, 'queued', ?)`,
    );
    d.raw.exec('BEGIN');
    for (let i = 0; i < 400; i += 1) {
      action.run(
        `external_primary/${i}`,
        ['edit', 'favourite', 'organize', 'share'][i % 4],
        AT + i,
      );
    }
    d.raw.exec('COMMIT');

    const counts = d.raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT kind, COUNT(*) AS n FROM photo_actions
          WHERE state IN ('queued', 'error') GROUP BY kind`,
      )
      .all() as { detail: string }[];
    const countPlan = counts.map((r) => r.detail).join(' | ');
    expect(countPlan).toMatch(/idx_actions_kind_state/);
    // Grouping by the index's leading column needs no sort pass.
    expect(countPlan).not.toMatch(/TEMP B-TREE/);

    const listing = d.raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT photo_id FROM photo_actions
          WHERE kind = 'organize' AND state IN ('queued', 'error') ORDER BY queued_at ASC`,
      )
      .all() as { detail: string }[];
    expect(listing.map((r) => r.detail).join(' | ')).toMatch(
      /SEARCH photo_actions USING INDEX idx_actions_kind_state/,
    );
  });

  it('deleting a group does not scan the whole assignments table', async () => {
    const d = await seedLarge();
    // The FK (run_id, group_id) -> photo_groups(run_id, id) needs a child
    // index that discriminates: run_id alone matches EVERY assignment row
    // (there is one continuous run), so group deletes — which every scan
    // window can trigger via repairGroupMembership — re-scanned all 27k.
    const plan = d.raw
      .prepare(
        'EXPLAIN QUERY PLAN SELECT 1 FROM photo_group_assignments WHERE run_id = 1 AND group_id = 5',
      )
      .all() as { detail: string }[];
    expect(plan.map((r) => r.detail).join(' | ')).toMatch(/idx_assignments_run_group/);

    const emptyIds = d.raw.prepare('SELECT id FROM photo_groups LIMIT 50').all() as {
      id: number;
    }[];
    d.raw.exec('PRAGMA foreign_keys = ON');
    const started = performance.now();
    d.raw.exec('BEGIN');
    for (const row of emptyIds) {
      d.raw.prepare('DELETE FROM photo_group_assignments WHERE group_id = ?').run(row.id);
      d.raw.prepare('DELETE FROM photo_groups WHERE id = ?').run(row.id);
    }
    d.raw.exec('COMMIT');
    // ~55 ms without the index, ~2 ms with it; generous tripwire.
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('the duels EXISTS is index-served', async () => {
    const d = await seedLarge();
    const duels = d.raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM photo_groups g WHERE EXISTS
         (SELECT 1 FROM duels dd WHERE dd.group_id = CAST(g.id AS TEXT))`,
      )
      .all() as { detail: string }[];
    expect(duels.map((r) => r.detail).join(' | ')).toMatch(/idx_duels_group/);
  });
});

describe('scoped repairGroupMembership (m0.8.1)', () => {
  it('an empty scope is a no-op and a scoped repair matches the full sweep', async () => {
    const d = await seedLarge();
    const db = d as unknown as SQLiteDatabase;
    const groupCount = () =>
      (d.raw.prepare('SELECT COUNT(*) c FROM photo_groups').get() as { c: number }).c;
    const before = groupCount();

    // Empty scope: the caller touched nothing, so nothing may change.
    await withWriteTransaction(db, (txn) => repairGroupMembership(txn, []));
    expect(groupCount()).toBe(before);

    // Break ONE group by marking a member absent, leaving 1 present member.
    const victim = d.raw
      .prepare(
        `SELECT a.group_id AS gid, a.photo_id AS pid FROM photo_group_assignments a
         WHERE a.group_id IS NOT NULL LIMIT 1`,
      )
      .get() as { gid: number; pid: string };
    const members = d.raw
      .prepare('SELECT photo_id FROM photo_group_assignments WHERE group_id = ?')
      .all(victim.gid) as { photo_id: string }[];
    for (const m of members.slice(1)) {
      d.raw.prepare('UPDATE photos SET is_present = 0 WHERE asset_id = ?').run(m.photo_id);
    }

    // A scope that EXCLUDES the broken group must leave it alone...
    const other = d.raw
      .prepare('SELECT id FROM photo_groups WHERE id <> ? LIMIT 1')
      .get(victim.gid) as { id: number };
    await withWriteTransaction(db, (txn) => repairGroupMembership(txn, [other.id]));
    expect(groupCount()).toBe(before);

    // ...and the correct scope dissolves exactly it, same as a full sweep.
    await withWriteTransaction(db, (txn) => repairGroupMembership(txn, [victim.gid]));
    expect(groupCount()).toBe(before - 1);
    expect(
      d.raw
        .prepare('SELECT group_id FROM photo_group_assignments WHERE photo_id = ?')
        .get(victim.pid),
    ).toEqual({ group_id: null });
    // A full sweep afterwards finds nothing left to do (idempotent).
    await withWriteTransaction(db, (txn) => repairGroupMembership(txn));
    expect(groupCount()).toBe(before - 1);
    expect(foreignKeyCheck(d)).toEqual([]);
  }, 60_000);
});
