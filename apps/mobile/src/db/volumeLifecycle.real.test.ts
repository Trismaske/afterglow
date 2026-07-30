/**
 * Departed-photo data lifecycle on real SQLite (m0.8.3 §7): the
 * mechanism-1 tombstone sweep riding every removal cleanup, both levels
 * of "Forget this card", and the returning-card revival edge.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import { getPresentAssetIds, writeContinuousGroups, type ContinuousPhotoUpsert } from './store';
import { reconcileExternallyRemoved } from './trashStore';
import { countForgettable, forgetVolume } from './volumeLifecycle';
import { queueAction, resolveActions } from './actions';
import { openTestDb, type TestDb } from './testDb';

const open: TestDb[] = [];
const AT = 1_800_000_000_000;
const PRIMARY = 'external_primary';
const SD = '0a91-e18d';

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

function photo(volume: string, rawId: string, takenAt = AT - 3_600_000): ContinuousPhotoUpsert {
  return {
    assetId: `${volume}/${rawId}`,
    uri: `file:///storage/${volume === PRIMARY ? 'emulated/0' : '0A91-E18D'}/DCIM/${rawId}.jpg`,
    takenAt,
    modTime: takenAt,
    day: '2027-01-15',
    volumeName: volume,
    rawId,
    sizeBytes: 1_000,
  };
}

async function seed(d: TestDb): Promise<void> {
  await writeContinuousGroups(
    asExpo(d),
    {
      photos: [photo(PRIMARY, 'p1'), photo(SD, 'sd1'), photo(SD, 'sd2')],
      groups: [{ members: [`${PRIMARY}/p1`, `${SD}/sd1`], timeAttached: [] }],
      singles: [`${SD}/sd2`],
    },
    AT,
  );
  const db = asExpo(d);
  // Satellites: embeddings + hashes + a duel + one queued and one
  // resolved action per SD photo.
  for (const id of [`${PRIMARY}/p1`, `${SD}/sd1`, `${SD}/sd2`]) {
    d.raw
      .prepare('INSERT INTO photo_embeddings (asset_id, mod_time, vec) VALUES (?, ?, ?)')
      .run(id, AT, Buffer.from([1, 2, 3]));
    d.raw
      .prepare(
        "INSERT INTO photo_hashes (asset_id, hash, mod_time, source) VALUES (?, 'abcd', ?, 'native')",
      )
      .run(id, AT);
  }
  d.raw
    .prepare('INSERT INTO duels (group_id, winner_id, loser_id, kept_both, at) VALUES (?,?,?,?,?)')
    .run('1', `${SD}/sd1`, `${PRIMARY}/p1`, 1, AT);
  await queueAction(db, `${SD}/sd2`, 'edit', AT);
  await queueAction(db, `${SD}/sd1`, 'share', AT);
  await resolveActions(db, [`${SD}/sd1`], 'share', AT + 1);
}

function count(d: TestDb, sql: string, ...args: (string | number)[]): number {
  return Number((d.raw.prepare(sql).get(...args) as { n: number }).n);
}

describe('mechanism 1 — the tombstone sweep rides removal cleanup', () => {
  it('sweeps embeddings, hashes and duels; keeps the row and its verdict', async () => {
    const d = await fresh();
    await seed(d);
    d.raw.prepare("UPDATE photos SET state = 'kept' WHERE asset_id = ?").run(`${PRIMARY}/p1`);
    await reconcileExternallyRemoved(
      asExpo(d),
      [`${PRIMARY}/p1`],
      AT + 10,
      [PRIMARY, SD],
      // Scan-confirmed PERMANENT delete — the mechanism-1 case (§7).
      new Set([`${PRIMARY}/p1`]),
    );
    // The row survives as a tombstone (all-time counts intact)…
    const row = d.raw
      .prepare('SELECT state, is_present, day FROM photos WHERE asset_id = ?')
      .get(`${PRIMARY}/p1`) as { state: string; is_present: number; day: string };
    expect(row.is_present).toBe(0);
    expect(row.day).toBe('2027-01-15');
    // …and the satellites are gone.
    expect(
      count(d, 'SELECT COUNT(*) AS n FROM photo_embeddings WHERE asset_id = ?', `${PRIMARY}/p1`),
    ).toBe(0);
    expect(
      count(d, 'SELECT COUNT(*) AS n FROM photo_hashes WHERE asset_id = ?', `${PRIMARY}/p1`),
    ).toBe(0);
    expect(count(d, 'SELECT COUNT(*) AS n FROM duels WHERE loser_id = ?', `${PRIMARY}/p1`)).toBe(0);
    // Unrelated photos' satellites untouched.
    expect(
      count(d, 'SELECT COUNT(*) AS n FROM photo_embeddings WHERE asset_id = ?', `${SD}/sd2`),
    ).toBe(1);
  });

  it('a RESTORABLE trash keeps duel history — only permanence sweeps it (grilling Q13)', async () => {
    const d = await fresh();
    await seed(d);
    // No permanentIds: the photo sits in the system trash (30 days).
    await reconcileExternallyRemoved(asExpo(d), [`${PRIMARY}/p1`], AT + 10, [PRIMARY, SD]);
    expect(
      count(d, 'SELECT COUNT(*) AS n FROM photo_embeddings WHERE asset_id = ?', `${PRIMARY}/p1`),
    ).toBe(0); // recomputable satellites still sweep
    expect(count(d, 'SELECT COUNT(*) AS n FROM duels WHERE loser_id = ?', `${PRIMARY}/p1`)).toBe(1); // Compare history survives a possible restore
  });

  it('sweeps a PENDING copy match whichever endpoint departs (codex phase-4)', async () => {
    const d = await fresh();
    await seed(d);
    d.raw
      .prepare(
        "INSERT INTO edit_copy_matches (original_id, copy_id, state, detected_at) VALUES (?, ?, 'pending', ?)",
      )
      .run(`${SD}/sd1`, `${PRIMARY}/p1`, AT);
    // The departed photo is the COPY — the pending relationship must not
    // survive to block the original's next legitimate match.
    await reconcileExternallyRemoved(asExpo(d), [`${PRIMARY}/p1`], AT + 10, [PRIMARY, SD]);
    expect(
      count(d, 'SELECT COUNT(*) AS n FROM edit_copy_matches WHERE copy_id = ?', `${PRIMARY}/p1`),
    ).toBe(0);
  });
});

describe('mechanism 2 — Forget this card', () => {
  it('keep: tombstones every row, sweeps satellites + queued work, keeps resolved work', async () => {
    const d = await fresh();
    await seed(d);
    expect(await countForgettable(asExpo(d), SD)).toEqual({ present: 2, total: 2 });
    const result = await forgetVolume(asExpo(d), SD, 'keep', AT + 10);
    expect(result.photos).toBe(2);
    // Rows survive absent, verdicts intact; primary untouched.
    expect(
      count(d, 'SELECT COUNT(*) AS n FROM photos WHERE volume_name = ? AND is_present = 0', SD),
    ).toBe(2);
    expect(await getPresentAssetIds(asExpo(d), null, [PRIMARY, SD])).toEqual([`${PRIMARY}/p1`]);
    // Satellites swept; the QUEUED edit died, the RESOLVED share stayed.
    expect(
      count(d, `SELECT COUNT(*) AS n FROM photo_embeddings WHERE asset_id LIKE '${SD}/%'`),
    ).toBe(0);
    expect(
      count(
        d,
        "SELECT COUNT(*) AS n FROM photo_actions WHERE photo_id = ? AND kind = 'edit'",
        `${SD}/sd2`,
      ),
    ).toBe(0);
    expect(
      count(
        d,
        "SELECT COUNT(*) AS n FROM photo_actions WHERE photo_id = ? AND kind = 'share' AND resolved_at IS NOT NULL",
        `${SD}/sd1`,
      ),
    ).toBe(1);
  });

  it('keep preserves activity_at — Forget is not a photo decision (final cycle O7)', async () => {
    const d = await fresh();
    await seed(d);
    const decidedAt = AT - 500_000;
    d.raw
      .prepare('UPDATE photos SET activity_at = ? WHERE asset_id = ?')
      .run(decidedAt, `${SD}/sd1`);
    await forgetVolume(asExpo(d), SD, 'keep', AT + 10);
    const row = d.raw
      .prepare('SELECT activity_at FROM photos WHERE asset_id = ?')
      .get(`${SD}/sd1`) as { activity_at: number | null };
    expect(row.activity_at).toBe(decidedAt);
  });

  it('the repair defers a touched group holding a member on ANOTHER unmounted card (O2)', async () => {
    const d = await fresh();
    const OTHER = 'aaaa-1111';
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          photo(SD, 'sd1'),
          {
            ...photo(OTHER, 'o1'),
            uri: 'file:///storage/AAAA-1111/DCIM/o1.jpg',
          },
        ],
        groups: [{ members: [`${SD}/sd1`, `${OTHER}/o1`], timeAttached: [] }],
        singles: [],
      },
      AT,
    );
    // Forget the SD card while the OTHER card is merely unmounted: sd1
    // tombstones, but o1's assignment must wait for its card.
    await forgetVolume(asExpo(d), SD, 'keep', AT + 10, [PRIMARY]);
    const other = d.raw
      .prepare('SELECT group_id FROM photo_group_assignments WHERE photo_id = ?')
      .get(`${OTHER}/o1`) as { group_id: number | null };
    expect(other.group_id).not.toBeNull();
  });

  it('both levels durably defeat the scan skip in the same transaction (P4)', async () => {
    const d = await fresh();
    await seed(d);
    d.raw.prepare("INSERT INTO settings (key, value) VALUES ('scan_fingerprint', 'fp')").run();
    d.raw
      .prepare("INSERT INTO settings (key, value) VALUES ('scan_generations', '{\"0a91-e18d\":5}')")
      .run();
    await forgetVolume(asExpo(d), SD, 'keep', AT + 10);
    const remaining = d.raw
      .prepare("SELECT key FROM settings WHERE key IN ('scan_fingerprint', 'scan_generations')")
      .all();
    expect(remaining).toEqual([]);
  });

  it('erase: hard-deletes rows and satellites — all-time counts drop', async () => {
    const d = await fresh();
    await seed(d);
    await forgetVolume(asExpo(d), SD, 'erase', AT + 10);
    expect(count(d, 'SELECT COUNT(*) AS n FROM photos WHERE volume_name = ?', SD)).toBe(0);
    expect(count(d, `SELECT COUNT(*) AS n FROM photo_actions WHERE photo_id LIKE '${SD}/%'`)).toBe(
      0,
    );
    expect(count(d, `SELECT COUNT(*) AS n FROM duels WHERE winner_id LIKE '${SD}/%'`)).toBe(0);
    // Primary untouched, its group repaired to a single (partner gone).
    expect(count(d, 'SELECT COUNT(*) AS n FROM photos WHERE volume_name = ?', PRIMARY)).toBe(1);
  });

  it('a forgotten (keep) card that RETURNS revives through the scan upsert', async () => {
    const d = await fresh();
    await seed(d);
    d.raw.prepare("UPDATE photos SET state = 'kept' WHERE asset_id = ?").run(`${SD}/sd2`);
    await forgetVolume(asExpo(d), SD, 'keep', AT + 10);
    // The card comes back: the scan re-ingests sd2.
    await writeContinuousGroups(
      asExpo(d),
      { photos: [photo(SD, 'sd2')], groups: [], singles: [`${SD}/sd2`] },
      AT + 20,
    );
    const row = d.raw
      .prepare('SELECT state, is_present FROM photos WHERE asset_id = ?')
      .get(`${SD}/sd2`) as { state: string; is_present: number };
    expect(row.is_present).toBe(1);
    // State-intact (the honest edge the flow copy promises).
    expect(row.state).toBe('kept');
  });
});
