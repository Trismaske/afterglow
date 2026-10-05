/**
 * The Everything browse reads at the S23's library shape (m0.9 phase 8:
 * ~27k photos, ~5.6k groups of ~3, ~8.6k singles), seeded the scan's
 * way so every group's anchor is written through. Pins the per-page
 * cost of both keyset streams on this seed — the group page was a
 * ~160 ms aggregate over every group before the stored anchor (v25) —
 * and runs the anchor audit over the whole seed at the end.
 */
import { describe, expect, it } from 'vitest';
import { migrateDatabase } from './database';
import {
  auditGroupAnchors,
  fetchBrowseGroupsPage,
  fetchBrowseSinglesPage,
  writeContinuousGroups,
  type BrowseGroupCursor,
} from './store';
import { openTestDb, type TestDb } from './testDb';
import type { SQLiteDatabase } from 'expo-sqlite';

const asExpo = (d: TestDb) => d as unknown as SQLiteDatabase;
const AT = 1_753_000_000_000;

describe('browse pages at S23 scale', () => {
  it('walks group and singles pages by index over 27k photos / 5.6k groups, anchors consistent', async () => {
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
        fileGeneration: null,
        kind: 'photo' as const,
        mimeType: 'image/jpeg',
        displayName: null,
        width: null,
        height: null,
        durationMs: null,
        fileMtime: takenAt,
        day: '2026-07-20',
        volumeName: 'external_primary',
        rawId,
        sizeBytes: 1000,
      };
    };
    let t = AT;
    let queueGroups: { members: string[]; timeAttached: string[]; parts: string[][] }[] = [];
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
      queueGroups.push({ members, timeAttached: [], parts: [members] });
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

    // (`raw` counts what the loop actually minted: the singles cap is
    // checked per batch, so the seed lands ~8.5k singles, not 8 613.)
    expect(total.n).toBe(raw);
    expect(gcount.n).toBe(GROUPS);

    // Ten successive keyset pages of 40 groups (the S23 pass shape) and
    // ten of 120 singles, deep into the stream — a per-page aggregate
    // would cost the same on every page; an index walk costs the page.
    let cursor: BrowseGroupCursor | undefined = undefined;
    const groupTimes: number[] = [];
    let previous = Number.POSITIVE_INFINITY;
    for (let page = 0; page < 10; page++) {
      const started = performance.now();
      const rows = await fetchBrowseGroupsPage(asExpo(d), null, null, cursor, 40);
      groupTimes.push(performance.now() - started);
      expect(rows.length).toBe(40);
      for (const row of rows) {
        // Newest-first, the stored anchor IS the newest member.
        expect(row.anchor).toBe(row.members[0].taken_at);
        expect(row.anchor as number).toBeLessThanOrEqual(previous);
        previous = row.anchor as number;
      }
      const last = rows[rows.length - 1];
      cursor = { anchor: last.anchor as number, groupId: last.groupId };
    }
    let singlesCursor: { takenAt: number; assetId: string } | undefined = undefined;
    const singleTimes: number[] = [];
    for (let page = 0; page < 10; page++) {
      const started = performance.now();
      const rows = await fetchBrowseSinglesPage(asExpo(d), null, null, singlesCursor, 120);
      singleTimes.push(performance.now() - started);
      expect(rows.length).toBe(120);
      const last = rows[rows.length - 1];
      singlesCursor = { takenAt: last.taken_at, assetId: last.asset_id };
    }
    const fmt = (t: number[]) => t.map((ms) => ms.toFixed(1)).join(', ');
    console.log(`group page ms: ${fmt(groupTimes)}\nsingles page ms: ${fmt(singleTimes)}`);
    // Generous wall-clock tripwires (workstation): the aggregate read
    // measured ~160 ms per group page here; an index walk is single
    // digits. Only a regression to a per-page aggregate can trip these.
    for (const ms of groupTimes) expect(ms).toBeLessThan(40);
    for (const ms of singleTimes) expect(ms).toBeLessThan(40);

    // The write-through held across every window of the seed.
    expect(await auditGroupAnchors(asExpo(d))).toEqual([]);
    d.close();
  }, 300_000);
});
