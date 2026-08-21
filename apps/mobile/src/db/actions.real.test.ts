/**
 * The unified action store (v18) on real SQLite — layer 2 of
 * docs/STATE_MODEL.md.
 *
 * The cases that matter are the ones where the four old implementations
 * used to differ: what "queued" means, what survives clearing a queue,
 * and whether an action can disturb the verdict.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  ACTION_KINDS,
  clearQueue,
  countQueues,
  decodeFavouriteTarget,
  decodeOrganizeTarget,
  encodeFavouriteTarget,
  encodeOrganizeTarget,
  failActions,
  getActionBadges,
  getActionsForPhotos,
  getPhotoActions,
  getQueue,
  queueAction,
  resolveActions,
  unqueueAction,
} from './actions';
import { openTestDb, type TestDb } from './testDb';

const open: TestDb[] = [];
const AT = 1_800_000_000_000;

function asExpo(d: TestDb): SQLiteDatabase {
  return d as unknown as SQLiteDatabase;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

async function fresh(photoIds: readonly string[] = ['p1', 'p2', 'p3']): Promise<TestDb> {
  const d = openTestDb();
  open.push(d);
  d.raw.exec('PRAGMA foreign_keys = ON');
  await migrateDatabase(asExpo(d));
  const insert = d.raw.prepare(
    "INSERT INTO photos (asset_id, uri, taken_at, state, volume_name, raw_id) VALUES (?, ?, ?, 'unreviewed', 'external_primary', ?)",
  );
  for (const id of photoIds) insert.run(id, `file:///${id}.jpg`, AT, id);
  return d;
}

function stateOf(d: TestDb, photoId: string): string {
  return (
    d.raw.prepare('SELECT state FROM photos WHERE asset_id = ?').get(photoId) as {
      state: string;
    }
  ).state;
}

describe('queueing', () => {
  it('treats every kind identically', async () => {
    const d = await fresh();
    for (const kind of ACTION_KINDS) await queueAction(asExpo(d), 'p1', kind, AT);
    expect(await countQueues(asExpo(d))).toEqual({ edit: 1, favourite: 1, organize: 1, share: 1 });
    const actions = await getPhotoActions(asExpo(d), 'p1');
    expect(actions.map((a) => a.kind).sort()).toEqual([...ACTION_KINDS].sort());
    expect(actions.every((a) => a.state === 'queued' && a.resolvedAt === null)).toBe(true);
  });

  it('never touches the verdict', async () => {
    // Queuing an edit used to rewrite photos.state to 'to_edit'.
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'edit', AT);
    expect(stateOf(d, 'p1')).toBe('unreviewed');
    await resolveActions(asExpo(d), ['p1'], 'edit', AT + 10);
    expect(stateOf(d, 'p1')).toBe('unreviewed');
  });

  it('re-queues in place rather than duplicating', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'organize', AT, encodeOrganizeTarget('vol', 'DCIM/A'));
    await queueAction(asExpo(d), 'p1', 'organize', AT + 5, encodeOrganizeTarget('vol', 'DCIM/B'));
    const actions = await getPhotoActions(asExpo(d), 'p1');
    expect(actions).toHaveLength(1);
    expect(decodeOrganizeTarget(actions[0].target)).toEqual({ volume: 'vol', path: 'DCIM/B' });
    expect(actions[0].queuedAt).toBe(AT + 5);
  });
});

describe('resolving', () => {
  it('stamps resolved_at and records what was achieved', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'organize', AT, encodeOrganizeTarget('vol', 'DCIM/Wanted'));
    await resolveActions(
      asExpo(d),
      ['p1'],
      'organize',
      AT + 100,
      encodeOrganizeTarget('vol', 'DCIM/Actual'),
    );
    const [action] = await getPhotoActions(asExpo(d), 'p1');
    expect(action.state).toBe('applied');
    expect(action.resolvedAt).toBe(AT + 100);
    // The requested destination and the achieved one are both kept.
    expect(decodeOrganizeTarget(action.target)?.path).toBe('DCIM/Wanted');
    expect(decodeOrganizeTarget(action.appliedTarget)?.path).toBe('DCIM/Actual');
  });

  it('falls back to the requested target when none is reported', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'favourite', AT, encodeFavouriteTarget(true));
    await resolveActions(asExpo(d), ['p1'], 'favourite', AT + 1);
    const [action] = await getPhotoActions(asExpo(d), 'p1');
    expect(decodeFavouriteTarget(action.appliedTarget)).toBe(true);
  });

  it('refuses to resolve an action the user retargeted mid-flight', async () => {
    // Batch applies run behind an OS consent dialog, so the intent can
    // change while the old one is executing. Recording the NEW direction
    // as applied would claim a gallery state that does not exist.
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'favourite', AT, encodeFavouriteTarget(true));
    await queueAction(asExpo(d), 'p2', 'favourite', AT, encodeFavouriteTarget(true));
    // p1 is re-toggled while the "add to favourites" batch is in flight.
    await queueAction(asExpo(d), 'p1', 'favourite', AT + 5, encodeFavouriteTarget(false));

    const executed = encodeFavouriteTarget(true);
    await resolveActions(asExpo(d), ['p1', 'p2'], 'favourite', AT + 50, executed, executed);

    const [p1] = await getPhotoActions(asExpo(d), 'p1');
    const [p2] = await getPhotoActions(asExpo(d), 'p2');
    // p1 keeps its NEWER intent, still queued and still unapplied.
    expect(p1.state).toBe('queued');
    expect(p1.resolvedAt).toBeNull();
    expect(decodeFavouriteTarget(p1.target)).toBe(false);
    // p2 never changed, so its apply lands.
    expect(p2.state).toBe('applied');
    expect(p2.resolvedAt).toBe(AT + 50);
    expect(decodeFavouriteTarget(p2.appliedTarget)).toBe(true);
  });

  it('applies to a batch in one go, and leaves other kinds alone', async () => {
    const d = await fresh();
    for (const id of ['p1', 'p2', 'p3']) await queueAction(asExpo(d), id, 'share', AT);
    await queueAction(asExpo(d), 'p1', 'edit', AT);
    await resolveActions(asExpo(d), ['p1', 'p2'], 'share', AT + 50);
    expect((await countQueues(asExpo(d))).share).toBe(1);
    expect((await countQueues(asExpo(d))).edit).toBe(1);
  });
});

describe('leaving a queue', () => {
  it('forgets work that never happened', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'share', AT);
    await unqueueAction(asExpo(d), 'p1', 'share');
    expect(await getPhotoActions(asExpo(d), 'p1')).toEqual([]);
  });

  it('KEEPS the permanent record of work that did happen', async () => {
    // This is what makes base rates and turnaround stats possible: an
    // emptied queue is not an erased history.
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'favourite', AT);
    await resolveActions(asExpo(d), ['p1'], 'favourite', AT + 10);
    await unqueueAction(asExpo(d), 'p1', 'favourite');
    const [action] = await getPhotoActions(asExpo(d), 'p1');
    expect(action.resolvedAt).toBe(AT + 10);
    expect(action.state).toBe('applied');
    expect((await countQueues(asExpo(d))).favourite).toBe(0);
  });

  it('clears a whole queue on the same terms', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'share', AT);
    await queueAction(asExpo(d), 'p2', 'share', AT);
    await resolveActions(asExpo(d), ['p1'], 'share', AT + 10);
    // p1 was sent, p2 never was: clearing keeps p1's proof, drops p2.
    await queueAction(asExpo(d), 'p1', 'share', AT + 20);
    expect(await clearQueue(asExpo(d), 'share')).toBe(2);
    expect((await countQueues(asExpo(d))).share).toBe(0);
    expect((await getPhotoActions(asExpo(d), 'p1'))[0]?.resolvedAt).toBe(AT + 10);
    expect(await getPhotoActions(asExpo(d), 'p2')).toEqual([]);
  });
});

describe('errors', () => {
  it('keeps failed work visible in the queue instead of dropping it', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'organize', AT);
    await failActions(asExpo(d), ['p1'], 'organize');
    const [action] = await getPhotoActions(asExpo(d), 'p1');
    expect(action.state).toBe('error');
    // An errored action still counts as outstanding work.
    expect((await countQueues(asExpo(d))).organize).toBe(1);
    expect((await getQueue(asExpo(d), 'organize')).map((a) => a.photoId)).toEqual(['p1']);
  });
});

describe('queue membership is LIVE work only', () => {
  /** Set a photo's verdict without going through the review flow. */
  function verdict(d: TestDb, photoId: string, state: string): void {
    d.raw.prepare('UPDATE photos SET state = ? WHERE asset_id = ?').run(state, photoId);
  }

  it('a staged cull suspends PER KIND (F21): share/edit stay live, favourite/organize wait', async () => {
    const d = await fresh();
    for (const kind of ACTION_KINDS) await queueAction(asExpo(d), 'p1', kind, AT);
    await queueAction(asExpo(d), 'p2', 'edit', AT);
    expect(await countQueues(asExpo(d))).toEqual({ edit: 2, favourite: 1, organize: 1, share: 1 });

    // Staging p1 to cull: "delete it, but share it first" — its share
    // and edit stay dispatchable work; decorating/filing it does not.
    verdict(d, 'p1', 'culled');
    expect(await countQueues(asExpo(d))).toEqual({ edit: 2, favourite: 0, organize: 0, share: 1 });
    expect((await getQueue(asExpo(d), 'edit')).map((a) => a.photoId).sort()).toEqual(['p1', 'p2']);
    expect((await getQueue(asExpo(d), 'share')).map((a) => a.photoId)).toEqual(['p1']);
    expect(await getQueue(asExpo(d), 'favourite')).toEqual([]);
    expect(await getQueue(asExpo(d), 'organize')).toEqual([]);
    // The suspended rows are UNTOUCHED — that is what makes it reversible.
    expect((await getPhotoActions(asExpo(d), 'p1')).map((a) => a.kind).sort()).toEqual(
      [...ACTION_KINDS].sort(),
    );

    // Un-staging restores the suspended pair, with their original stamps.
    verdict(d, 'p1', 'kept');
    expect(await countQueues(asExpo(d))).toEqual({ edit: 2, favourite: 1, organize: 1, share: 1 });
    expect((await getPhotoActions(asExpo(d), 'p1')).every((a) => a.queuedAt === AT)).toBe(true);
  });

  it('excludes trashed and externally-removed photos too', async () => {
    const d = await fresh();
    for (const id of ['p1', 'p2', 'p3']) await queueAction(asExpo(d), id, 'share', AT);
    verdict(d, 'p1', 'trashed');
    d.raw.prepare('UPDATE photos SET is_present = 0 WHERE asset_id = ?').run('p2');
    expect((await countQueues(asExpo(d))).share).toBe(1);
    expect((await getQueue(asExpo(d), 'share')).map((a) => a.photoId)).toEqual(['p3']);
  });

  it('still reports what a staged cull CARRIES, for its badges', async () => {
    // "What is waiting for you" and "what does this photo carry" are
    // different questions; the badge answer must not follow the queue.
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'edit', AT);
    verdict(d, 'p1', 'culled');
    const byPhoto = await getActionsForPhotos(asExpo(d), ['p1']);
    expect(byPhoto.get('p1')?.map((a) => a.kind)).toEqual(['edit']);
  });
});

describe('reads', () => {
  it('lists a queue oldest first', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p3', 'edit', AT + 30);
    await queueAction(asExpo(d), 'p1', 'edit', AT + 10);
    await queueAction(asExpo(d), 'p2', 'edit', AT + 20);
    expect((await getQueue(asExpo(d), 'edit')).map((a) => a.photoId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('groups actions by photo for badge rendering', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'edit', AT);
    await queueAction(asExpo(d), 'p1', 'share', AT);
    await queueAction(asExpo(d), 'p2', 'favourite', AT);
    const byPhoto = await getActionsForPhotos(asExpo(d), ['p1', 'p2', 'p3']);
    expect(
      byPhoto
        .get('p1')
        ?.map((a) => a.kind)
        .sort(),
    ).toEqual(['edit', 'share']);
    expect(byPhoto.get('p2')?.map((a) => a.kind)).toEqual(['favourite']);
    expect(byPhoto.has('p3')).toBe(false);
  });

  it('drops actions when their photo is deleted', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'edit', AT);
    d.raw.prepare('DELETE FROM photos WHERE asset_id = ?').run('p1');
    expect(await countQueues(asExpo(d))).toEqual({ edit: 0, favourite: 0, organize: 0, share: 0 });
  });
});

describe('badge weights', () => {
  it('reads live for waiting work and carried for work that happened', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'edit', AT);
    await queueAction(asExpo(d), 'p1', 'organize', AT);
    await resolveActions(asExpo(d), ['p1'], 'organize', AT + 10);
    const badges = await getActionBadges(asExpo(d), ['p1', 'p2']);
    expect(badges.get('p1')).toEqual({ edit: 'live', organize: 'carried' });
    // A photo with no rows has no entry at all — no badge, not a weight.
    expect(badges.has('p2')).toBe(false);
  });

  it('keeps a retryable failure LIVE, because the user must still act', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'edit', AT);
    await failActions(asExpo(d), ['p1'], 'edit');
    expect((await getActionBadges(asExpo(d), ['p1'])).get('p1')).toEqual({ edit: 'live' });
  });

  it('lets WAITING beat CARRIED when an applied action is queued again', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'edit', AT);
    await resolveActions(asExpo(d), ['p1'], 'edit', AT + 10);
    expect((await getActionBadges(asExpo(d), ['p1'])).get('p1')).toEqual({ edit: 'carried' });
    await queueAction(asExpo(d), 'p1', 'edit', AT + 20);
    // resolved_at survives the re-queue (it is the permanent record), so
    // this is exactly the case where both facts are true at once.
    expect((await getActionBadges(asExpo(d), ['p1'])).get('p1')).toEqual({ edit: 'live' });
  });

  it('forgets an action queued and then abandoned, and remembers a done one', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'share', AT);
    await queueAction(asExpo(d), 'p2', 'share', AT);
    await resolveActions(asExpo(d), ['p2'], 'share', AT + 10);
    await clearQueue(asExpo(d), 'share');
    const badges = await getActionBadges(asExpo(d), ['p1', 'p2']);
    expect(badges.has('p1')).toBe(false); // never done → no trace
    expect(badges.get('p2')).toEqual({ share: 'carried' }); // done → permanent
  });

  it('never reports favourite, whose badge must read direction instead', async () => {
    const d = await fresh();
    await queueAction(asExpo(d), 'p1', 'favourite', AT, encodeFavouriteTarget(true));
    expect((await getActionBadges(asExpo(d), ['p1'])).has('p1')).toBe(false);
  });
});

describe('target encoding', () => {
  it('round-trips an organize destination containing separators', async () => {
    const target = encodeOrganizeTarget('external_primary', 'DCIM/Trips/2024 Italy');
    expect(decodeOrganizeTarget(target)).toEqual({
      volume: 'external_primary',
      path: 'DCIM/Trips/2024 Italy',
    });
  });

  it('round-trips a favourite direction, and reports absence', () => {
    expect(decodeFavouriteTarget(encodeFavouriteTarget(true))).toBe(true);
    expect(decodeFavouriteTarget(encodeFavouriteTarget(false))).toBe(false);
    expect(decodeFavouriteTarget(null)).toBeNull();
    expect(decodeOrganizeTarget(null)).toBeNull();
  });
});

describe('the source axis on queue reads (m0.8.7, F18)', () => {
  const CAMERA = [{ volume: 'external_primary', dir: 'DCIM/Camera' }];

  async function seedSourced(): Promise<TestDb> {
    const d = await fresh([]);
    const insert = d.raw.prepare(
      "INSERT INTO photos (asset_id, uri, taken_at, state, volume_name, raw_id) VALUES (?, ?, ?, 'unreviewed', 'external_primary', ?)",
    );
    insert.run('c1', 'file:///storage/emulated/0/DCIM/Camera/c1.jpg', AT, 'c1');
    insert.run('w1', 'file:///storage/emulated/0/WhatsApp/Media/w1.jpg', AT, 'w1');
    await queueAction(asExpo(d), 'c1', 'edit', AT);
    await queueAction(asExpo(d), 'w1', 'edit', AT + 1);
    await queueAction(asExpo(d), 'w1', 'share', AT + 2);
    return d;
  }

  it('getQueue lists only in-source photos under a dirs scope', async () => {
    const d = await seedSourced();
    const scoped = await getQueue(asExpo(d), 'edit', null, CAMERA);
    expect(scoped.map((a) => a.photoId)).toEqual(['c1']);
    // Null roots = All folders: both list, in queue order.
    const all = await getQueue(asExpo(d), 'edit');
    expect(all.map((a) => a.photoId)).toEqual(['c1', 'w1']);
  });

  it('countQueues counts exactly what the scoped lists show', async () => {
    const d = await seedSourced();
    expect(await countQueues(asExpo(d), null, CAMERA)).toEqual({
      edit: 1,
      favourite: 0,
      organize: 0,
      share: 0,
    });
    expect(await countQueues(asExpo(d))).toEqual({
      edit: 2,
      favourite: 0,
      organize: 0,
      share: 1,
    });
  });

  it('the ACTION ROW survives scoping — re-selecting the folder restores it', async () => {
    const d = await seedSourced();
    expect((await getQueue(asExpo(d), 'edit', null, CAMERA)).map((a) => a.photoId)).toEqual(['c1']);
    const restored = await getQueue(asExpo(d), 'edit', null, [
      ...CAMERA,
      { volume: 'external_primary', dir: 'WhatsApp/Media' },
    ]);
    expect(restored.map((a) => a.photoId)).toEqual(['c1', 'w1']);
  });

  it('both axes compose: unreachable AND out-of-source both hide', async () => {
    const d = await fresh([]);
    const insert = d.raw.prepare(
      "INSERT INTO photos (asset_id, uri, taken_at, state, volume_name, raw_id) VALUES (?, ?, ?, 'unreviewed', ?, ?)",
    );
    insert.run('c1', 'file:///storage/emulated/0/DCIM/Camera/c1.jpg', AT, 'external_primary', 'c1');
    insert.run('s1', 'file:///storage/0A91-E18D/DCIM/Camera/s1.jpg', AT, '0a91-e18d', 's1');
    await queueAction(asExpo(d), 'c1', 'share', AT);
    await queueAction(asExpo(d), 's1', 'share', AT + 1);
    // SD unmounted: its queued share waits even though its dir matches.
    const rows = await getQueue(
      asExpo(d),
      'share',
      ['external_primary'],
      [
        { volume: 'external_primary', dir: 'DCIM/Camera' },
        { volume: '0a91-e18d', dir: 'DCIM/Camera' },
      ],
    );
    expect(rows.map((a) => a.photoId)).toEqual(['c1']);
  });
});
