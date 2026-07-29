/**
 * Organize queue contracts on real SQLite (gate 3: R#6, N#8, C#7):
 * validated primary-only targets, durable retryable intents,
 * already-at-target repair, post-move uri refresh, repeatability.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  commitOrganizeOutcomes,
  getOrganizeQueue,
  newAlbumPath,
  queueOrganize,
  setOrganizeTargets,
  unqueueOrganize,
  validateOrganizeTarget,
} from './organizeStore';
import { decodeOrganizeTarget } from './actions';
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

/** The photo's organize action, decoded — v18 keeps the intent in
 * photo_actions, not in four columns on `photos`. */
function organizeAction(
  d: TestDb,
  photoId: string,
): { state: string; path: string | null; appliedPath: string | null; resolvedAt: number | null } {
  const row = d.raw
    .prepare(
      `SELECT state, target, applied_target, resolved_at FROM photo_actions
        WHERE photo_id = ? AND kind = 'organize'`,
    )
    .get(photoId) as
    | {
        state: string;
        target: string | null;
        applied_target: string | null;
        resolved_at: number | null;
      }
    | undefined;
  if (!row) throw new Error(`no organize action for ${photoId}`);
  return {
    state: row.state,
    path: decodeOrganizeTarget(row.target)?.path ?? null,
    appliedPath: decodeOrganizeTarget(row.applied_target)?.path ?? null,
    resolvedAt: row.resolved_at,
  };
}

function photoRow(d: TestDb, photoId: string): { uri: string; activity_at: number | null } {
  return d.raw.prepare('SELECT uri, activity_at FROM photos WHERE asset_id = ?').get(photoId) as {
    uri: string;
    activity_at: number | null;
  };
}

function insertPhoto(d: TestDb, id: string, volume: string | null = 'external_primary'): void {
  d.raw
    .prepare(
      `INSERT INTO photos (asset_id, uri, taken_at, day, volume_name)
       VALUES (?, 'file:///dcim/x.jpg', ?, '2026-07-20', ?)`,
    )
    .run(id, AT, volume);
}

describe('target validation', () => {
  it('accepts primary-volume DCIM/Pictures paths and rejects the rest', () => {
    expect(
      validateOrganizeTarget({ volumeName: 'external_primary', relativePath: 'Pictures/Trips/' }),
    ).toBeNull();
    expect(
      validateOrganizeTarget({ volumeName: 'external_primary', relativePath: 'DCIM/Camera/' }),
    ).toBeNull();
    expect(validateOrganizeTarget({ volumeName: 'sd-1234', relativePath: 'Pictures/X/' })).toMatch(
      /primary storage/,
    );
    expect(
      validateOrganizeTarget({ volumeName: 'external_primary', relativePath: 'Download/X/' }),
    ).toMatch(/DCIM/);
    expect(
      validateOrganizeTarget({ volumeName: 'external_primary', relativePath: 'Pictures/../X/' }),
    ).toMatch(/not valid/);
  });

  it('newAlbumPath builds validated Pictures paths and rejects bad names', () => {
    expect(newAlbumPath('Japan 2026')).toBe('Pictures/Japan 2026/');
    expect(newAlbumPath('  ')).toBeNull();
    expect(newAlbumPath('a/b')).toBeNull();
  });
});

/** m0.8.2 helper: queue then assign — the two-step flow the UI drives. */
async function queueWithTarget(d: TestDb, id: string, relativePath: string, at: number) {
  expect(await queueOrganize(asExpo(d), id, at)).toBeNull();
  expect(
    await setOrganizeTargets(asExpo(d), [id], { volumeName: 'external_primary', relativePath }, at),
  ).toBeNull();
}

describe('queue lifecycle', () => {
  it('queues target-less, rejects SD sources, projects NULL until assigned, supports unqueue', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    insertPhoto(d, 'sd1', 'sd-1234');
    expect(await queueOrganize(asExpo(d), 'p1', AT)).toBeNull();
    expect(await queueOrganize(asExpo(d), 'sd1', AT)).toMatch(/removable storage/);
    let queue = await getOrganizeQueue(asExpo(d));
    expect(queue.map((r) => r.photo_id)).toEqual(['p1']);
    // Untargeted (F6): the projection is NULL, never substr() noise.
    expect(queue[0].organize_path).toBeNull();
    expect(queue[0].organize_volume).toBeNull();
    await unqueueOrganize(asExpo(d), 'p1', AT + 1);
    queue = await getOrganizeQueue(asExpo(d));
    expect(queue).toEqual([]);
  });

  it('setOrganizeTargets assigns one album to a batch, validates, and resets errored rows', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    insertPhoto(d, 'p2');
    await queueOrganize(asExpo(d), 'p1', AT);
    await queueOrganize(asExpo(d), 'p2', AT);
    expect(
      await setOrganizeTargets(
        asExpo(d),
        ['p1', 'p2'],
        { volumeName: 'sd-1234', relativePath: 'Pictures/X/' },
        AT + 1,
      ),
    ).toMatch(/primary storage/);
    expect(
      await setOrganizeTargets(
        asExpo(d),
        ['p1', 'p2'],
        { volumeName: 'external_primary', relativePath: 'Pictures/Trips/' },
        AT + 1,
      ),
    ).toBeNull();
    const queue = await getOrganizeQueue(asExpo(d));
    expect(queue.map((r) => r.organize_path)).toEqual(['Pictures/Trips/', 'Pictures/Trips/']);
    // An errored row re-targeted resets to queued — a new album is a
    // fresh intent.
    await commitOrganizeOutcomes(
      asExpo(d),
      [
        {
          photoId: 'p1',
          status: 'error',
          message: 'boom',
          volumeName: 'external_primary',
          relativePath: 'Pictures/Trips/',
        },
      ],
      AT + 2,
    );
    expect((await getOrganizeQueue(asExpo(d))).find((r) => r.photo_id === 'p1')?.state).toBe(
      'error',
    );
    await setOrganizeTargets(
      asExpo(d),
      ['p1'],
      { volumeName: 'external_primary', relativePath: 'Pictures/Other/' },
      AT + 3,
    );
    const p1 = (await getOrganizeQueue(asExpo(d))).find((r) => r.photo_id === 'p1');
    expect(p1?.state).toBe('queued');
    expect(p1?.organize_path).toBe('Pictures/Other/');
  });

  it('queueing an ABSENT photo is a no-op on both tables (write-side guard)', async () => {
    // The validate read can race a scan reconcile; the INSERT..SELECT
    // guard is the authority, so an absent photo gains neither a queue
    // row nor a History stamp.
    const d = await fresh();
    insertPhoto(d, 'p1');
    d.raw.prepare('UPDATE photos SET is_present = 0 WHERE asset_id = ?').run('p1');
    expect(await queueOrganize(asExpo(d), 'p1', AT)).toMatch(/no longer available/);
    const action = d.raw
      .prepare("SELECT 1 FROM photo_actions WHERE photo_id = ? AND kind = 'organize'")
      .get('p1');
    expect(action).toBeUndefined();
    expect(photoRow(d, 'p1').activity_at).toBeNull();
  });

  it('queue + History stamp land ATOMICALLY (a failed stamp rolls back the queue row)', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    // Statements in queueOrganize: validate read, transaction open,
    // BEGIN, the queue INSERT, the activity stamp — fail the 5th so the
    // stamp dies with the insert already executed.
    d.failAfter(5);
    await expect(queueOrganize(asExpo(d), 'p1', AT)).rejects.toThrow('injected failure');
    const action = d.raw
      .prepare("SELECT 1 FROM photo_actions WHERE photo_id = ? AND kind = 'organize'")
      .get('p1');
    expect(action).toBeUndefined(); // rolled back with the stamp
    expect(photoRow(d, 'p1').activity_at).toBeNull();
    // The same call without the fault lands BOTH sides with one clock.
    expect(await queueOrganize(asExpo(d), 'p1', AT + 1)).toBeNull();
    expect((await getOrganizeQueue(asExpo(d))).map((r) => r.photo_id)).toEqual(['p1']);
    expect(photoRow(d, 'p1').activity_at).toBe(AT + 1);
  });

  it('unqueue stamps History with the removal; a no-op unqueue stamps nothing', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    insertPhoto(d, 'p2');
    expect(await queueOrganize(asExpo(d), 'p1', AT)).toBeNull();
    await unqueueOrganize(asExpo(d), 'p1', AT + 5);
    expect(await getOrganizeQueue(asExpo(d))).toEqual([]);
    expect(photoRow(d, 'p1').activity_at).toBe(AT + 5);
    // p2 was never queued: removing it from the queue changes no intent,
    // so its History position must not move.
    await unqueueOrganize(asExpo(d), 'p2', AT + 6);
    expect(photoRow(d, 'p2').activity_at).toBeNull();
  });

  it('change-target is just re-assigning a new path', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    await queueWithTarget(d, 'p1', 'Pictures/A/', AT);
    await setOrganizeTargets(
      asExpo(d),
      ['p1'],
      { volumeName: 'external_primary', relativePath: 'Pictures/B/' },
      AT + 1,
    );
    const queue = await getOrganizeQueue(asExpo(d));
    expect(queue[0].organize_path).toBe('Pictures/B/');
  });

  it('the prefill survives a completed → requeue → unqueue → requeue lap', async () => {
    // leaveQueue's demote clears `target`; the re-queue restores it from
    // applied_target, or the documented "last album as a prefill" dies
    // one unqueue later (codex r7).
    const d = await fresh();
    insertPhoto(d, 'p1');
    await queueWithTarget(d, 'p1', 'Pictures/Trips/', AT);
    await commitOrganizeOutcomes(
      asExpo(d),
      [
        {
          photoId: 'p1',
          status: 'moved',
          message: 'verified',
          newData: '/storage/emulated/0/Pictures/Trips/x.jpg',
          volumeName: 'external_primary',
          relativePath: 'Pictures/Trips/',
        },
      ],
      AT + 1,
    );
    await queueOrganize(asExpo(d), 'p1', AT + 2);
    await unqueueOrganize(asExpo(d), 'p1', AT + 3);
    await queueOrganize(asExpo(d), 'p1', AT + 4);
    const queue = await getOrganizeQueue(asExpo(d));
    expect(queue[0].organize_path).toBe('Pictures/Trips/');
  });
});

describe('commitOrganizeOutcomes', () => {
  it('moved → applied with uri refresh and last-applied bookkeeping (N#8)', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    await queueWithTarget(d, 'p1', 'Pictures/Trips/', AT);
    await commitOrganizeOutcomes(
      asExpo(d),
      [
        {
          photoId: 'p1',
          status: 'moved',
          message: 'verified',
          newData: '/storage/emulated/0/Pictures/Trips/x.jpg',
          volumeName: 'external_primary',
          relativePath: 'Pictures/Trips/',
        },
      ],
      AT + 5,
    );
    const action = organizeAction(d, 'p1');
    expect(action.state).toBe('applied');
    expect(action.appliedPath).toBe('Pictures/Trips/');
    expect(action.resolvedAt).toBe(AT + 5);
    // Applied means OUT of the queue — the permanent record stays behind.
    expect(await getOrganizeQueue(asExpo(d))).toEqual([]);
    const row = photoRow(d, 'p1');
    expect(row.uri).toBe('file:///storage/emulated/0/Pictures/Trips/x.jpg');
    expect(row.activity_at).toBe(AT + 5);
    // Repeatable (N#8): a new queue starts a fresh intent — and the
    // target-less re-queue keeps the LAST target as a prefill (m0.8.2),
    // which the queue screen shows and one selection re-assigns.
    expect(await queueOrganize(asExpo(d), 'p1', AT + 10)).toBeNull();
    let queue = await getOrganizeQueue(asExpo(d));
    expect(queue[0].organize_path).toBe('Pictures/Trips/');
    await setOrganizeTargets(
      asExpo(d),
      ['p1'],
      { volumeName: 'external_primary', relativePath: 'Pictures/Other/' },
      AT + 11,
    );
    queue = await getOrganizeQueue(asExpo(d));
    expect(queue[0].organize_path).toBe('Pictures/Other/');
  });

  it("'already' completes the repair without a move (retry recognition)", async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    await queueWithTarget(d, 'p1', 'Pictures/Trips/', AT);
    await commitOrganizeOutcomes(
      asExpo(d),
      [
        {
          photoId: 'p1',
          status: 'already',
          message: 'already at target',
          volumeName: 'external_primary',
          relativePath: 'Pictures/Trips/',
        },
      ],
      AT + 5,
    );
    expect(organizeAction(d, 'p1').state).toBe('applied');
    expect(photoRow(d, 'p1').uri).toBe('file:///dcim/x.jpg'); // no newData → uri untouched
  });

  it('a mid-move retarget keeps the NEWER intent; only the uri refreshes', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    await queueWithTarget(d, 'p1', 'Pictures/Trips/', AT);
    // The user retargets while an old apply continuation is in flight.
    await setOrganizeTargets(
      asExpo(d),
      ['p1'],
      { volumeName: 'external_primary', relativePath: 'Pictures/Other/' },
      AT + 2,
    );
    // The stale continuation commits its OLD executed intent.
    await commitOrganizeOutcomes(
      asExpo(d),
      [
        {
          photoId: 'p1',
          status: 'moved',
          message: 'verified',
          newData: '/storage/emulated/0/Pictures/Trips/x.jpg',
          volumeName: 'external_primary',
          relativePath: 'Pictures/Trips/',
        },
      ],
      AT + 5,
    );
    // The newer intent survives, unapplied; the uri reflects the file's
    // real (old-target) location.
    const action = organizeAction(d, 'p1');
    expect(action.state).toBe('queued');
    expect(action.path).toBe('Pictures/Other/');
    expect(action.resolvedAt).toBeNull();
    expect(photoRow(d, 'p1').uri).toBe('file:///storage/emulated/0/Pictures/Trips/x.jpg');
  });

  it('an errored row stays in the queue AND says it failed', async () => {
    // 'error' counts as queue membership (docs/STATE_MODEL.md) precisely
    // so failed work is never silently dropped — but the row has to
    // carry the state, or it is indistinguishable from work that simply
    // has not run yet once the failure alert is dismissed.
    const d = await fresh();
    insertPhoto(d, 'p1');
    insertPhoto(d, 'p2');
    for (const id of ['p1', 'p2']) {
      await queueWithTarget(d, id, 'Pictures/Trips/', AT);
    }
    await commitOrganizeOutcomes(
      asExpo(d),
      [
        {
          photoId: 'p1',
          status: 'error',
          message: 'boom',
          volumeName: 'external_primary',
          relativePath: 'Pictures/Trips/',
        },
      ],
      AT + 5,
    );
    const queue = await getOrganizeQueue(asExpo(d));
    expect(queue.map((r) => [r.photo_id, r.state])).toEqual([
      ['p1', 'error'],
      ['p2', 'queued'],
    ]);
  });

  it('error keeps the durable target for retry', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1');
    await queueWithTarget(d, 'p1', 'Pictures/Trips/', AT);
    await commitOrganizeOutcomes(
      asExpo(d),
      [
        {
          photoId: 'p1',
          status: 'error',
          message: 'boom',
          volumeName: 'external_primary',
          relativePath: 'Pictures/Trips/',
        },
      ],
      AT + 5,
    );
    const queue = await getOrganizeQueue(asExpo(d));
    expect(queue).toHaveLength(1); // error rows stay in the queue view
    expect(queue[0].organize_path).toBe('Pictures/Trips/'); // target survived
  });
});
