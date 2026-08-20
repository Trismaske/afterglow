/**
 * History feed contracts on real SQLite (gate 4, item G: activity_at
 * ordering, keyset pagination, presence gating, share events).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import { getHistoryPage, type HistoryCursor } from './store';
import { reconcileExternallyRemoved } from './trashStore';
import { encodeOrganizeTarget } from './actions';
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

function insertPhoto(
  d: TestDb,
  id: string,
  state: string,
  activityAt: number,
  extras: { is_present?: number; decided_at?: number | null } = {},
): void {
  // Mirrors production: every verdict write stamps decided_at — the
  // tombstone predicate discriminates on it (codex r2). Overridable so
  // the reconcile-lifecycle test can model the one path that does not.
  const decidedAt =
    extras.decided_at !== undefined
      ? extras.decided_at
      : state === 'unreviewed'
        ? null
        : activityAt;
  d.raw
    .prepare(
      `INSERT INTO photos (asset_id, uri, taken_at, day, state, activity_at, is_present,
                           decided_at, volume_name, raw_id)
       VALUES (?, 'content://x', ?, '2026-07-20', ?, ?, ?, ?, 'external_primary', ?)`,
    )
    .run(id, AT, state, activityAt, extras.is_present ?? 1, decidedAt, id);
}

/** Attach a pending action (v18) — `resolvedAt` set means it happened. */
function action(
  d: TestDb,
  photoId: string,
  kind: 'edit' | 'favourite' | 'organize' | 'share',
  state: 'queued' | 'applied' | 'error',
  options: {
    target?: string | null;
    /** What actually landed, when it differs from what is queued now. */
    appliedTarget?: string | null;
    resolvedAt?: number | null;
  } = {},
): void {
  d.raw
    .prepare(
      `INSERT INTO photo_actions (photo_id, kind, state, target, applied_target, queued_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      photoId,
      kind,
      state,
      options.target ?? null,
      options.appliedTarget ?? (options.resolvedAt == null ? null : (options.target ?? null)),
      AT,
      options.resolvedAt ?? null,
    );
}

describe('getHistoryPage', () => {
  it('orders by activity_at desc; DECIDED tombstones stay on the record (D9); absent undecided drop', async () => {
    const d = await fresh();
    insertPhoto(d, 'newest', 'kept', AT + 300);
    insertPhoto(d, 'older', 'culled', AT + 100);
    // A forgotten card's keep: absent bytes, standing verdict — a
    // placeholder tile, not a vanished row (m0.8.6 D9).
    insertPhoto(d, 'gone', 'kept', AT + 200, { is_present: 0 });
    insertPhoto(d, 'fresh', 'unreviewed', AT + 400);
    // An absent UNDECIDED row carries no completed work — it stays out.
    insertPhoto(d, 'gone-undecided', 'unreviewed', AT + 350, { is_present: 0 });
    // The REAL external-removal lifecycle (codex r2): the reconcile
    // rewrites even a never-reviewed photo to 'trashed', but stamps no
    // decided_at — it must not mint a Trashed tombstone.
    insertPhoto(d, 'gone-via-reconcile', 'unreviewed', AT + 360);
    await reconcileExternallyRemoved(asExpo(d), ['gone-via-reconcile'], AT + 370);
    // A DECIDED photo removed externally becomes a tombstone AT ITS OWN
    // activity position (closing grilling, 2026-08-20): the reconcile
    // must NOT restamp activity_at — the discovery is not app activity,
    // and the old top-leap forced a mid-scroll rebase Tristan rejected.
    insertPhoto(d, 'gone-decided-external', 'kept', AT + 250);
    await reconcileExternallyRemoved(asExpo(d), ['gone-decided-external'], AT + 9999);
    const page = await getHistoryPage(asExpo(d), 'all', null);
    const photoRows = page.rows.filter((r) => r.kind === 'photo');
    expect(photoRows.map((r) => (r.kind === 'photo' ? r.asset_id : ''))).toEqual([
      'newest',
      'gone-decided-external', // AT + 250 — kept its slot, no top-leap
      'gone',
      'older',
    ]);
    expect(photoRows.map((r) => (r.kind === 'photo' ? r.is_present : -1))).toEqual([1, 0, 0, 1]);
  });

  it('the Trashed chip filters to executed culls (D9)', async () => {
    const d = await fresh();
    insertPhoto(d, 'kept', 'kept', AT + 300);
    insertPhoto(d, 'trashed-one', 'trashed', AT + 200, { is_present: 0 });
    insertPhoto(d, 'staged', 'culled', AT + 100);
    const page = await getHistoryPage(asExpo(d), 'trashed', null);
    expect(
      page.rows
        .filter((r) => r.kind === 'photo')
        .map((r) => (r.kind === 'photo' ? r.asset_id : '')),
    ).toEqual(['trashed-one']);
    // …and All keeps every verdict, tombstones included.
    const all = await getHistoryPage(asExpo(d), 'all', null);
    expect(
      all.rows.filter((r) => r.kind === 'photo').map((r) => (r.kind === 'photo' ? r.asset_id : '')),
    ).toEqual(['kept', 'trashed-one', 'staged']);
  });

  it('keyset-paginates without skipping or duplicating', async () => {
    const d = await fresh();
    for (let i = 0; i < 95; i++) insertPhoto(d, `p${String(i).padStart(3, '0')}`, 'kept', AT + i);
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

  it('All includes unreviewed photos with applied moves or favourite intents', async () => {
    const d = await fresh();
    insertPhoto(d, 'organized-only', 'unreviewed', AT + 1);
    action(d, 'organized-only', 'organize', 'applied', {
      target: encodeOrganizeTarget('external_primary', 'Pictures/A/'),
      resolvedAt: AT + 1,
    });
    insertPhoto(d, 'fav-only', 'unreviewed', AT + 2);
    action(d, 'fav-only', 'favourite', 'applied', { target: '1', resolvedAt: AT + 2 });
    insertPhoto(d, 'merely-drawn', 'unreviewed', AT + 3);
    const all = await getHistoryPage(asExpo(d), 'all', null);
    expect(all.rows.map((r) => (r.kind === 'photo' ? r.asset_id : '')).sort()).toEqual([
      'fav-only',
      'organized-only',
    ]);
  });

  it('All is the union of the filters, edits included', async () => {
    // v18 lets an UNREVIEWED photo carry a queued edit, so All has to
    // list it — the To-edit filter beside it does, and a feed where a
    // photo appears under a filter but not under All contradicts itself.
    const d = await fresh();
    insertPhoto(d, 'edit-only', 'unreviewed', AT + 1);
    action(d, 'edit-only', 'edit', 'queued');
    insertPhoto(d, 'merely-drawn', 'unreviewed', AT + 2);
    const toEdit = await getHistoryPage(asExpo(d), 'to_edit', null);
    expect(toEdit.rows.map((r) => (r.kind === 'photo' ? r.asset_id : ''))).toEqual(['edit-only']);
    const all = await getHistoryPage(asExpo(d), 'all', null);
    expect(all.rows.map((r) => (r.kind === 'photo' ? r.asset_id : ''))).toEqual(['edit-only']);
  });

  it('a re-queued move keeps the photo organized in History (applied marker wins)', async () => {
    const d = await fresh();
    insertPhoto(d, 'requeued', 'unreviewed', AT + 1);
    // Moved once (applied marker retained), then queued again — History
    // must keep showing it under Organized and All, even if the retry
    // errors forever.
    action(d, 'requeued', 'organize', 'queued', {
      target: encodeOrganizeTarget('external_primary', 'Pictures/B/'),
      appliedTarget: encodeOrganizeTarget('external_primary', 'Pictures/A/'),
      resolvedAt: AT + 1,
    });
    const organized = await getHistoryPage(asExpo(d), 'organized', null);
    expect(organized.rows.map((r) => (r.kind === 'photo' ? r.asset_id : ''))).toEqual(['requeued']);
    const all = await getHistoryPage(asExpo(d), 'all', null);
    expect(all.rows.map((r) => (r.kind === 'photo' ? r.asset_id : ''))).toEqual(['requeued']);
  });

  it('Kept is the VERDICT, so a queued edit does not remove a photo from it', async () => {
    // Before v18 "kept" and "to edit" were mutually exclusive states, and
    // this filter kept that model alive by excluding edit-pending rows.
    // The photo now has both layers, so it belongs under BOTH filters.
    const d = await fresh();
    insertPhoto(d, 'kept-and-queued', 'kept', AT + 1);
    action(d, 'kept-and-queued', 'edit', 'queued');
    insertPhoto(d, 'plain-keeper', 'kept', AT + 2);
    const kept = await getHistoryPage(asExpo(d), 'kept', null);
    expect(kept.rows.map((r) => (r.kind === 'photo' ? r.asset_id : '')).sort()).toEqual([
      'kept-and-queued',
      'plain-keeper',
    ]);
    const toEdit = await getHistoryPage(asExpo(d), 'to_edit', null);
    expect(toEdit.rows.map((r) => (r.kind === 'photo' ? r.asset_id : ''))).toEqual([
      'kept-and-queued',
    ]);
  });

  it('filters map to the pinned formulas (favourite = queued + applied)', async () => {
    const d = await fresh();
    insertPhoto(d, 'fav-q', 'kept', AT + 1);
    action(d, 'fav-q', 'favourite', 'queued', { target: '1' });
    insertPhoto(d, 'fav-a', 'kept', AT + 2);
    action(d, 'fav-a', 'favourite', 'applied', { target: '1', resolvedAt: AT + 2 });
    insertPhoto(d, 'plain', 'kept', AT + 3);
    const favourites = await getHistoryPage(asExpo(d), 'favourite', null);
    expect(favourites.rows.map((r) => (r.kind === 'photo' ? r.asset_id : '')).sort()).toEqual([
      'fav-a',
      'fav-q',
    ]);
  });

  it('paginates share events past the first page (Shared filter)', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1', 'kept', AT);
    d.raw.prepare('INSERT INTO share_cycles (started_at) VALUES (?)').run(AT);
    // The real 'shared' lifecycle stamps chosen_at (D10); opened_at is
    // deliberately EARLIER and constant — ordering must ignore it.
    const stmt = d.raw.prepare(
      "INSERT INTO share_batches (cycle_id, attempted_at, opened_at, chosen_at, label, state) VALUES (1, ?, ?, ?, ?, 'shared')",
    );
    for (let i = 0; i < 55; i++) stmt.run(AT + i, AT - 1000, AT + i, `pass ${i}`);
    d.raw.prepare("INSERT INTO share_batch_members VALUES (1, 'p1')").run();
    const first = await getHistoryPage(asExpo(d), 'shared', null);
    expect(first.rows).toHaveLength(40);
    expect(first.next).not.toBeNull();
    const second = await getHistoryPage(asExpo(d), 'shared', first.next);
    const all = [...first.rows, ...second.rows].map((r) => (r.kind === 'share' ? r.batch_id : -1));
    expect(all).toHaveLength(55);
    expect(new Set(all).size).toBe(55);
    expect(second.next).toBeNull();
    // Newest first across the page boundary.
    const labels = [...first.rows, ...second.rows].map((r) =>
      r.kind === 'share' ? r.label : null,
    );
    expect(labels[0]).toBe('pass 54');
    expect(labels[54]).toBe('pass 0');
  });

  it('merges both streams by timestamp on every page (All filter)', async () => {
    const d = await fresh();
    // 50 photos at even timestamps, 50 shares interleaved at odd ones.
    for (let i = 0; i < 50; i++)
      insertPhoto(d, `p${String(i).padStart(2, '0')}`, 'kept', AT + i * 2);
    d.raw.prepare('INSERT INTO share_cycles (started_at) VALUES (?)').run(AT);
    // opened_at sits far in the past: the merge must key on chosen_at
    // (codex r1 — a chooser left open files the share at CHOICE time).
    const stmt = d.raw.prepare(
      "INSERT INTO share_batches (cycle_id, attempted_at, opened_at, chosen_at, label, state) VALUES (1, ?, ?, ?, ?, 'shared')",
    );
    for (let i = 0; i < 50; i++) stmt.run(AT + i * 2 + 1, AT - 999, AT + i * 2 + 1, `s${i}`);
    const pages = [];
    let cursor: HistoryCursor | null = null;
    for (;;) {
      const page = await getHistoryPage(asExpo(d), 'all', cursor);
      pages.push(...page.rows);
      if (page.next === null) break;
      cursor = page.next;
    }
    expect(pages).toHaveLength(100);
    // Globally descending by timestamp — shares appear beyond page one.
    const times = pages.map((r) => (r.kind === 'photo' ? r.activity_at : r.chosen_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(pages.filter((r) => r.kind === 'share')).toHaveLength(50);
    expect(pages.slice(40).some((r) => r.kind === 'share')).toBe(true);
  });

  it('interleaves SHARED events with labels; errors and abandoned sheets never appear', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1', 'kept', AT + 10);
    d.raw.prepare('INSERT INTO share_cycles (started_at) VALUES (?)').run(AT);
    d.raw
      .prepare(
        // Sheet opened BEFORE the photo's decision, target chosen after:
        // the row must sort by the choice (old code sorted by opened_at
        // and filed this share behind the photo).
        "INSERT INTO share_batches (cycle_id, attempted_at, opened_at, chosen_at, label, state) VALUES (1, ?, ?, ?, 'Mum', 'shared')",
      )
      .run(AT + 20, AT + 5, AT + 20);
    d.raw
      .prepare("INSERT INTO share_batches (cycle_id, attempted_at, state) VALUES (1, ?, 'error')")
      .run(AT + 30);
    d.raw.prepare("INSERT INTO share_batch_members VALUES (1, 'p1')").run();
    const page = await getHistoryPage(asExpo(d), 'all', null);
    const shares = page.rows.filter((r) => r.kind === 'share');
    expect(shares).toHaveLength(1);
    expect(shares[0].kind === 'share' && shares[0].label).toBe('Mum');
    // The CHOSEN event sorts ahead of the older photo decision.
    expect(page.rows[0].kind).toBe('share');
  });
});
