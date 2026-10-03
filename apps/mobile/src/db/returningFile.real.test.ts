/**
 * A returning file adopts its tombstone (m0.9 phase 9, F44): the scan's
 * write re-keys an ABSENT row that matches a new window row on volume +
 * path + size + capture time, so a Samsung Recycle-bin restore (a NEW
 * MediaStore id at the old path) carries on as the same photo — its
 * stamps, its History line, its satellites, the lifetime counts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  adoptReturningFiles,
  applyReviewDecisions,
  auditGroupAnchors,
  getHistoryPage,
  getLifetimeStats,
  writeContinuousGroups,
  type ContinuousPhotoUpsert,
} from './store';
import { reconcileExternallyRemoved } from './trashStore';
import { foreignKeyCheck, openTestDb, type TestDb } from './testDb';

const open: TestDb[] = [];
const AT = 1_800_000_000_000;
const T = AT - 3_600_000;
const VOL = 'external_primary';

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

function upsert(rawId: string, over: Partial<ContinuousPhotoUpsert> = {}): ContinuousPhotoUpsert {
  return {
    assetId: `${VOL}/${rawId}`,
    uri: `file:///storage/emulated/0/DCIM/Camera/20260930_234054.jpg`,
    takenAt: T,
    modTime: T,
    fileGeneration: 7,
    kind: 'photo',
    mimeType: 'image/jpeg',
    displayName: '20260930_234054.jpg',
    width: null,
    height: null,
    durationMs: null,
    fileMtime: T,
    day: '2027-01-15',
    volumeName: VOL,
    rawId,
    sizeBytes: 3_412_990,
    ...over,
  };
}

/** The runner's per-window sequence: adopt returning files, then write.
 * `oldGone` stands in for the runner's presence probe on a PRESENT
 * candidate (default: the old MediaStore row is gone). */
async function land(
  d: TestDb,
  photos: ContinuousPhotoUpsert[],
  at = AT,
  oldGone: () => Promise<boolean> = async () => true,
): Promise<void> {
  await adoptReturningFiles(asExpo(d), photos, oldGone);
  await writeContinuousGroups(
    asExpo(d),
    { photos, groups: [], singles: photos.map((p) => p.assetId) },
    at,
  );
}

type Row = Record<string, unknown>;
const row = (d: TestDb, id: string): Row | undefined =>
  d.raw.prepare('SELECT * FROM photos WHERE asset_id = ?').get(id) as Row | undefined;

/** The kept photo with its satellites: a favourite applied, a duel it
 * won, a not-related pair, and a partner row so the pair has two ends. */
async function keptWithSatellites(d: TestDb): Promise<{ old: string; partner: string }> {
  const db = asExpo(d);
  const old = `${VOL}/1000187704`;
  const partner = `${VOL}/1000187705`;
  await land(d, [
    upsert('1000187704'),
    upsert('1000187705', {
      uri: 'file:///storage/emulated/0/DCIM/Camera/20260930_234055.jpg',
      takenAt: T + 1_000,
      sizeBytes: 2_000,
    }),
  ]);
  await applyReviewDecisions(db, [[old, 'kept']], AT + 1);
  d.raw
    .prepare(
      `INSERT INTO photo_actions (photo_id, kind, state, target, applied_target, queued_at, resolved_at)
       VALUES (?, 'favourite', 'applied', NULL, '1', ?, ?)`,
    )
    .run(old, AT + 2, AT + 3);
  d.raw
    .prepare('INSERT INTO duels (winner_id, loser_id, kept_both, at) VALUES (?, ?, 0, ?)')
    .run(old, partner, AT + 4);
  d.raw
    .prepare('INSERT INTO not_related (ejected_id, partner_id, at) VALUES (?, ?, ?)')
    .run(old, partner, AT + 5);
  return { old, partner };
}

describe('a returning file adopts its tombstone (phase 9, F44)', () => {
  it('a kept photo deleted in Gallery and restored under a new id is one photo: stamps, History, satellites, counts', async () => {
    const d = await fresh();
    const db = asExpo(d);
    const { old, partner } = await keptWithSatellites(d);
    const before = row(d, old)!;
    expect(before.state).toBe('kept');
    expect(before.decided_first_at).toBe(AT + 1);
    const statsBefore = await getLifetimeStats(db);
    expect(statsBefore.reviewed).toBe(1);

    // Gallery's Recycle bin: the row is deleted outright, the delta's
    // id walk finds it gone — the external-removal tombstone.
    await reconcileExternallyRemoved(db, [old], AT + 10, [VOL]);
    const tomb = row(d, old)!;
    expect(tomb.is_present).toBe(0);
    expect(tomb.state).toBe('trashed');
    expect((await getLifetimeStats(db)).reviewed).toBe(1);

    // Gallery's Restore: the same bytes at the same path, a NEW id.
    const returned = `${VOL}/1000187900`;
    await land(d, [upsert('1000187900')], AT + 20);

    expect(row(d, old)).toBeUndefined();
    const after = row(d, returned)!;
    expect(after.is_present).toBe(1);
    expect(after.raw_id).toBe('1000187900');
    // The standing restore transition: back to review, the generation
    // bumped — not silently kept.
    expect(after.state).toBe('unreviewed');
    expect(after.trash_generation).toBe(1);
    // The decision stamps rode along: this photo was decided once, on
    // the old id, and the lifetime counts do not move.
    expect(after.decided_first_at).toBe(AT + 1);
    expect(after.decided_at).toBe(AT + 1);
    expect(after.reviewed_at).toBe(before.reviewed_at);
    expect(await getLifetimeStats(db)).toEqual(statsBefore);

    // Every satellite names the new id and nothing names the old one.
    const count = (sql: string, id: string): number =>
      Number((d.raw.prepare(sql).get(id) as { n: number }).n);
    expect(count('SELECT COUNT(*) AS n FROM photo_actions WHERE photo_id = ?', returned)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM photo_actions WHERE photo_id = ?', old)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM duels WHERE winner_id = ?', returned)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM duels WHERE loser_id = ?', partner)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM not_related WHERE ejected_id = ?', returned)).toBe(1);
    expect(
      count('SELECT COUNT(*) AS n FROM photo_group_assignments WHERE photo_id = ?', returned),
    ).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM photo_group_assignments WHERE photo_id = ?', old)).toBe(
      0,
    );
    expect(foreignKeyCheck(d)).toEqual([]);
    await auditGroupAnchors(db);

    // History shows the one line (the partner was never decided), under
    // the new id, present again.
    const page = await getHistoryPage(db, 'all', null);
    const lines = page.rows.filter((r) => r.kind === 'photo');
    expect(lines.map((r) => (r.kind === 'photo' ? r.asset_id : ''))).toEqual([returned]);
    expect(lines[0].kind === 'photo' && lines[0].is_present).toBe(1);
  });

  it('a different file at the old path is a new photo; the tombstone stays', async () => {
    const d = await fresh();
    const { old } = await keptWithSatellites(d);
    await reconcileExternallyRemoved(asExpo(d), [old], AT + 10, [VOL]);
    const fresh2 = `${VOL}/1000187901`;
    await land(d, [upsert('1000187901', { sizeBytes: 999 })], AT + 20);
    expect(row(d, old)!.is_present).toBe(0);
    const after = row(d, fresh2)!;
    expect(after.is_present).toBe(1);
    expect(after.decided_first_at).toBeNull();
    expect((await getLifetimeStats(asExpo(d))).reviewed).toBe(1);
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('a removal and return between two checks: the PRESENT old row is adopted once the probe says its MediaStore row is gone, and keeps its verdict', async () => {
    const d = await fresh();
    const { old } = await keptWithSatellites(d);
    const statsBefore = await getLifetimeStats(asExpo(d));
    // The probe cannot confirm the old id gone (present, or undecidable
    // this pass): no adoption, the new row lands as a fresh duplicate.
    await land(d, [upsert('1000187902')], AT + 20, async () => false);
    expect(row(d, old)!.is_present).toBe(1);
    expect(row(d, `${VOL}/1000187902`)!.decided_first_at).toBeNull();
    // A later pass with the probe decided: the FRESH new-id row gives
    // way and the match adopts (codex r5 — an undecidable probe must not
    // strand the identity for good). The present candidate still holds
    // its caches, and the window's embed pass has already written the
    // new id's (codex r4): the re-key must not collide on them.
    const seedCache = (id: string, mod: number): void => {
      d.raw
        .prepare('INSERT INTO photo_embeddings (asset_id, mod_time, vec) VALUES (?, ?, ?)')
        .run(id, mod, Buffer.alloc(8));
      d.raw
        .prepare(
          "INSERT INTO photo_hashes (asset_id, hash, mod_time, source) VALUES (?, 'h', ?, 'native')",
        )
        .run(id, mod);
    };
    seedCache(old, T);
    seedCache(`${VOL}/1000187902`, T + 5);
    await land(d, [upsert('1000187902')], AT + 30, async () => true);
    expect(row(d, old)).toBeUndefined();
    const after = row(d, `${VOL}/1000187902`)!;
    expect(
      Number(
        (
          d.raw
            .prepare('SELECT COUNT(*) AS n FROM photos WHERE uri = ?')
            .get(after.uri as string) as { n: number }
        ).n,
      ),
    ).toBe(1);
    const cacheRows = (table: string, id: string): number =>
      Number(
        (
          d.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE asset_id = ?`).get(id) as {
            n: number;
          }
        ).n,
      );
    expect(cacheRows('photo_embeddings', old)).toBe(0);
    expect(cacheRows('photo_embeddings', `${VOL}/1000187902`)).toBe(1);
    expect(cacheRows('photo_hashes', `${VOL}/1000187902`)).toBe(1);
    // A new-id row the user has touched is a second photo and stays.
    const twin = `${VOL}/1000187905`;
    await land(d, [upsert('1000187905')], AT + 40, async () => false);
    await applyReviewDecisions(asExpo(d), [[twin, 'kept']], AT + 41);
    await land(d, [upsert('1000187905')], AT + 50, async () => true);
    expect(row(d, `${VOL}/1000187902`)).toBeDefined();
    expect(row(d, twin)!.decided_first_at).toBe(AT + 41);
    expect(after.state).toBe('kept');
    expect(after.is_present).toBe(1);
    expect(after.decided_first_at).toBe(AT + 1);
    // The adoption moved no count; the kept twin above is the one new
    // reviewed photo.
    expect(await getLifetimeStats(asExpo(d))).toEqual({
      ...statsBefore,
      reviewed: statsBefore.reviewed + 1,
    });
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it("declines when two stored rows carry the returning file's identity", async () => {
    const d = await fresh();
    const { old } = await keptWithSatellites(d);
    // A second history at the same tuple: an earlier return kept as its
    // own photo (the probe could not decide, then the user decided it).
    await land(d, [upsert('1000187910')], AT + 20, async () => false);
    await applyReviewDecisions(asExpo(d), [[`${VOL}/1000187910`, 'kept']], AT + 21);
    await reconcileExternallyRemoved(asExpo(d), [old, `${VOL}/1000187910`], AT + 30, [VOL]);
    await land(d, [upsert('1000187911')], AT + 40);
    expect(row(d, old)!.is_present).toBe(0);
    expect(row(d, `${VOL}/1000187910`)!.is_present).toBe(0);
    expect(row(d, `${VOL}/1000187911`)!.decided_first_at).toBeNull();
    expect(foreignKeyCheck(d)).toEqual([]);
  });

  it('never matches without a recorded size, and the probe walks the index', async () => {
    const d = await fresh();
    const { old } = await keptWithSatellites(d);
    await reconcileExternallyRemoved(asExpo(d), [old], AT + 30, [VOL]);
    d.raw.prepare('UPDATE photos SET size_bytes = NULL WHERE asset_id = ?').run(old);
    await land(d, [upsert('1000187903')], AT + 40);
    expect(row(d, old)!.is_present).toBe(0);
    expect(row(d, `${VOL}/1000187903`)!.decided_first_at).toBeNull();
    expect(foreignKeyCheck(d)).toEqual([]);
    // The plan pin: a first pass over a fresh database probes once per
    // row, so the probe must key on the presence-prefixed capture index.
    const plan = d.raw
      .prepare(
        `EXPLAIN QUERY PLAN SELECT t.asset_id FROM photos t
          WHERE t.is_present IN (0, 1) AND t.taken_at = ? AND t.volume_name = ? AND t.uri = ?
            AND t.size_bytes = ? AND t.asset_id <> ?
            AND NOT EXISTS (SELECT 1 FROM photos n WHERE n.asset_id = ?)`,
      )
      .all(T, VOL, 'x', 1, 'a', 'a') as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' | ')).toMatch(/USING INDEX idx_photos_present_taken/);
  });
});
