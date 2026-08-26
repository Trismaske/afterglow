/** One-off scale benchmark: fetchBrowseGroupsPage at the S23's library
 * shape (27,466 photos, ~5,656 groups of ~3.3, ~8,613 singles). */
import { describe, expect, it } from 'vitest';
import { migrateDatabase } from './database';
import { fetchBrowseGroupsPage, writeContinuousGroups, type BrowseGroupCursor } from './store';
import { openTestDb, type TestDb } from './testDb';
import type { SQLiteDatabase } from 'expo-sqlite';

const asExpo = (d: TestDb) => d as unknown as SQLiteDatabase;
const AT = 1_753_000_000_000;

describe('browse page at S23 scale', () => {
  it.skip('measures page times over 27k photos / 5.6k groups', async () => {
    const d = openTestDb();
    d.raw.exec('PRAGMA foreign_keys = ON');
    await migrateDatabase(asExpo(d));

    const GROUPS = 5656;
    const PER = 3;
    const SINGLES = 8613;
    // Seed in batches the scan's way.
    const BATCH = 400;
    let raw = 0;
    const mk = (takenAt: number) => {
      raw += 1;
      const rawId = `r${raw}`;
      return {
        assetId: `external_primary/${rawId}`,
        uri: `file:///dcim/${rawId}.jpg`,
        takenAt,
        modTime: takenAt,
        day: '2026-07-20',
        volumeName: 'external_primary',
        rawId,
        sizeBytes: 1000,
      };
    };
    let t = AT;
    let queueGroups: { members: string[]; timeAttached: string[] }[] = [];
    let queuePhotos: ReturnType<typeof mk>[] = [];
    let queueSingles: string[] = [];
    const flush = async () => {
      if (queuePhotos.length === 0) return;
      await writeContinuousGroups(
        asExpo(d),
        { photos: queuePhotos, groups: queueGroups, singles: queueSingles },
        AT,
      );
      queueGroups = [];
      queuePhotos = [];
      queueSingles = [];
    };
    for (let g = 0; g < GROUPS; g++) {
      const members: string[] = [];
      for (let m = 0; m < PER; m++) {
        t -= 30_000;
        const p = mk(t);
        queuePhotos.push(p);
        members.push(p.assetId);
      }
      queueGroups.push({ members, timeAttached: [] });
      if (g % 2 === 0 && queueSingles.length < SINGLES) {
        for (let s = 0; s < 3; s++) {
          t -= 45_000;
          const p = mk(t);
          queuePhotos.push(p);
          queueSingles.push(p.assetId);
        }
      }
      if (queuePhotos.length >= BATCH) await flush();
    }
    await flush();

    const total = d.raw.prepare('SELECT COUNT(*) AS n FROM photos').get() as { n: number };
    const gcount = d.raw.prepare('SELECT COUNT(*) AS n FROM photo_groups').get() as { n: number };
    console.log(`seeded: ${total.n} photos, ${gcount.n} groups`);

    // Time 5 successive keyset pages of 40 (the S23 pass shape).
    let cursor: BrowseGroupCursor | undefined = undefined;
    const times: number[] = [];
    for (let page = 0; page < 5; page++) {
      const started = Date.now();
      const rows = await fetchBrowseGroupsPage(asExpo(d), null, null, cursor, 40);
      times.push(Date.now() - started);
      expect(rows.length).toBe(40);
      const last = rows[rows.length - 1];
      cursor = { anchor: last.anchor as number, groupId: last.groupId };
    }
    console.log('page times ms:', times.join(', '));
    d.close();
  }, 300_000);
});
