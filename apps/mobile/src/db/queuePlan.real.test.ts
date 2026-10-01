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
  // The raw seed bypasses the writers, so the anchors (v25) are written
  // through once over the whole table — the scope every writer's repair
  // otherwise bounds to the groups it touched.
  await withWriteTransaction(d as unknown as SQLiteDatabase, async (txn) => {
    await repairGroupMembership(txn);
  });
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

  it('the member reads start from the group (CROSS JOIN), the anchor aggregate too, and the singles walk ranges the presence-taken index (phase 8)', async () => {
    const d = await seedLarge();
    const plan = (sql: string, ...params: unknown[]) =>
      (
        d.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
          detail: string;
        }[]
      )
        .map((r) => r.detail)
        .join(' | ');
    // The browse/pending members projection: 40 group ids in, the
    // planner used to start from every present photo (idx_photos_
    // present_state) and probe the 40 groups per row — a MEASURED
    // 148 ms per page at 27k, the cost the anchor was blamed for.
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    const members = plan(
      `SELECT a.group_id, p.asset_id FROM photo_group_assignments a
        CROSS JOIN photos p ON p.asset_id = a.photo_id
        WHERE a.group_id IN (${ids.map(() => '?').join(',')}) AND p.is_present = 1
        ORDER BY p.taken_at DESC, p.asset_id DESC`,
      ...ids,
    );
    // Either group-keyed index is the sane plan (the UNIQUE(group_id,
    // photo_id) autoindex covers this projection).
    const byGroup = /^SEARCH a USING (COVERING )?INDEX \S+ \(group_id=\?/;
    expect(members).toMatch(byGroup);
    expect(members).not.toMatch(/idx_photos_present_state/);
    // The anchor write-through's correlated aggregate, per touched group.
    const anchor = plan(
      `SELECT id, (SELECT MAX(p.taken_at) FROM photo_group_assignments a
         CROSS JOIN photos p ON p.asset_id = a.photo_id
         WHERE a.group_id = photo_groups.id AND p.is_present = 1) FROM photo_groups WHERE id IN (1, 2)`,
    );
    expect(anchor).toMatch(/SEARCH a USING (COVERING )?INDEX \S+ \(group_id=\?/);
    expect(anchor).not.toMatch(/idx_photos_present_state/);
    // The singles keyset page: a range on idx_photos_present_taken, no sort.
    const singles = plan(
      `SELECT p.asset_id FROM photo_group_assignments a
        JOIN photos p ON p.asset_id = a.photo_id
        WHERE a.group_id IS NULL AND p.is_present = 1
          AND p.taken_at <= ? AND (p.taken_at < ? OR p.asset_id < ?)
        ORDER BY p.taken_at DESC, p.asset_id DESC LIMIT 120`,
      AT,
      AT,
      'x',
    );
    expect(singles).toMatch(/idx_photos_present_taken \(is_present=\? AND taken_at</);
    expect(singles).not.toMatch(/TEMP B-TREE/);
    // The stored anchors walk their own index, newest first, no sort.
    const heads = plan(
      `SELECT g.id, g.anchor FROM photo_groups g WHERE g.anchor IS NOT NULL
        AND g.anchor <= ? AND (g.anchor < ? OR g.id < ?)
        ORDER BY g.anchor DESC, g.id DESC LIMIT 40`,
      AT,
      AT,
      1,
    );
    expect(heads).toMatch(/idx_groups_anchor/);
    expect(heads).not.toMatch(/TEMP B-TREE/);
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

  it('the duel endpoint lookups are index-served (v22)', async () => {
    // Forget-erase anonymization and future per-photo duel history both
    // key on an endpoint id — the two endpoint indexes must serve them.
    const d = await seedLarge();
    const winner = d.raw
      .prepare(`EXPLAIN QUERY PLAN SELECT id FROM duels WHERE winner_id = 'x'`)
      .all() as { detail: string }[];
    expect(winner.map((r) => r.detail).join(' | ')).toMatch(/idx_duels_winner/);
    const loser = d.raw
      .prepare(`EXPLAIN QUERY PLAN SELECT id FROM duels WHERE loser_id = 'x'`)
      .all() as { detail: string }[];
    expect(loser.map((r) => r.detail).join(' | ')).toMatch(/idx_duels_loser/);
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
    await withWriteTransaction(db, async (txn) => void (await repairGroupMembership(txn, [])));
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
    await withWriteTransaction(
      db,
      async (txn) => void (await repairGroupMembership(txn, [other.id])),
    );
    expect(groupCount()).toBe(before);

    // ...and the correct scope dissolves exactly it, same as a full sweep.
    await withWriteTransaction(
      db,
      async (txn) => void (await repairGroupMembership(txn, [victim.gid])),
    );
    expect(groupCount()).toBe(before - 1);
    expect(
      d.raw
        .prepare('SELECT group_id FROM photo_group_assignments WHERE photo_id = ?')
        .get(victim.pid),
    ).toEqual({ group_id: null });
    // A full sweep afterwards finds nothing left to do (idempotent).
    await withWriteTransaction(db, async (txn) => void (await repairGroupMembership(txn)));
    expect(groupCount()).toBe(before - 1);
    expect(foreignKeyCheck(d)).toEqual([]);
  }, 60_000);
});

describe('source-scoped queue reads at scale (m0.8.7, F18)', () => {
  it('the LIKE-backed scope stays cheap on a 27k corpus with big queues', async () => {
    const d = await seedLarge();
    const db = d as unknown as SQLiteDatabase;
    // Give the corpus real folder shapes: every 9th photo lives in
    // WhatsApp, the rest in DCIM/Camera (seedLarge wrote file:///dcim/).
    d.raw.exec('BEGIN');
    d.raw.exec(
      `UPDATE photos SET uri = 'file:///storage/emulated/0/DCIM/Camera/' || raw_id || '.jpg'`,
    );
    d.raw.exec(
      `UPDATE photos SET uri = 'file:///storage/emulated/0/WhatsApp/Media/' || raw_id || '.jpg'
        WHERE CAST(raw_id AS INTEGER) % 9 = 0`,
    );
    // 3,000 staged culls and 500 queued edits — a heavy user's queues.
    d.raw.exec(`UPDATE photos SET state = 'culled' WHERE CAST(raw_id AS INTEGER) < 3000`);
    d.raw.exec(
      `INSERT INTO photo_actions (photo_id, kind, state, queued_at)
       SELECT asset_id, 'edit', 'queued', 1 FROM photos
        WHERE CAST(raw_id AS INTEGER) >= 3000 AND CAST(raw_id AS INTEGER) < 3500`,
    );
    d.raw.exec('COMMIT');

    const { countQueues, getQueue } = await import('./actions');
    const { countStagedCulls, getStagedCulls } = await import('./store');
    const CAMERA = [{ volume: 'external_primary', dir: 'DCIM/Camera' }];
    const started = performance.now();
    const counts = await countQueues(db, null, CAMERA);
    const edits = await getQueue(db, 'edit', null, CAMERA);
    const culls = await countStagedCulls(db, null, CAMERA);
    const cullRows = await getStagedCulls(db, undefined, null, CAMERA);
    const elapsed = performance.now() - started;
    // Real values from the seeded shape: multiples of 9 fall out.
    expect(counts.edit).toBe(edits.length);
    expect(edits.length).toBe(500 - 55); // 3000..3499 holds 55 multiples of 9
    expect(culls).toBe(cullRows.length);
    expect(culls).toBe(3000 - 334); // 0..2999 holds 334 multiples of 9
    // Generous tripwire (same discipline as the plan pins above): all
    // four scoped reads together, on a desktop, in well under a second —
    // only a per-corpus-row LIKE regression can trip this. The S10e
    // device measurement rides the `[perf] queue read` lines.
    expect(elapsed).toBeLessThan(1_000);
  });
});
