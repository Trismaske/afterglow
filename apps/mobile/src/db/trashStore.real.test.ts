/**
 * Trash-attempt lifecycle proof on real SQLite (gate 3: P6#4, P7#4, P8#3,
 * P8#4, P5#4, C#7). Death windows are simulated by driving the lifecycle
 * functions exactly as the interrupted process would find the rows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase } from './database';
import {
  lifetimeReclaimedBytes,
  markBatchLaunching,
  markPhotoRestored,
  prepareTrashBatch,
  reconcileExternallyRemoved,
  recoverTrashBatches,
  resolveTrashBatch,
  TRASH_BATCH_LIMIT,
} from './trashStore';
import { encodeOrganizeTarget } from './actions';
import { writeContinuousGroups } from './store';
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

function insertPhoto(d: TestDb, id: string, state: string): void {
  d.raw
    .prepare(
      `INSERT INTO photos (asset_id, uri, taken_at, day, state, volume_name, raw_id)
       VALUES (?, 'content://x', ?, '2026-07-20', ?, 'external_primary', ?)`,
    )
    .run(id, AT, state, id);
}

function insertCull(d: TestDb, id: string): void {
  insertPhoto(d, id, 'culled');
}

/** Attach a pending action (v18). */
function attach(
  d: TestDb,
  photoId: string,
  kind: 'edit' | 'favourite' | 'organize' | 'share',
  state: 'queued' | 'applied' | 'error',
  target: string | null = null,
  resolvedAt: number | null = null,
): void {
  d.raw
    .prepare(
      `INSERT INTO photo_actions (photo_id, kind, state, target, applied_target, queued_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(photoId, kind, state, target, resolvedAt === null ? null : target, AT, resolvedAt);
}

/** Every action row still attached to a photo, kind -> state. */
function actionsOf(d: TestDb, photoId: string): Record<string, string> {
  const rows = d.raw
    .prepare('SELECT kind, state, target FROM photo_actions WHERE photo_id = ?')
    .all(photoId) as { kind: string; state: string; target: string | null }[];
  return Object.fromEntries(rows.map((r) => [r.kind, r.state]));
}

const absent = async () => 'absent' as const;
const present = async () => 'present' as const;
const unknown = async () => 'unknown' as const;

describe('prepareTrashBatch', () => {
  it('reserves staged culls up to the batch limit, skipping live reservations', async () => {
    const d = await fresh();
    for (let i = 0; i < TRASH_BATCH_LIMIT + 20; i++) insertCull(d, `p${i}`);
    const first = await prepareTrashBatch(
      asExpo(d),
      Array.from({ length: TRASH_BATCH_LIMIT + 20 }, (_, i) => ({
        photoId: `p${i}`,
        measuredBytes: 10,
      })),
      AT,
    );
    expect(first!.members).toHaveLength(TRASH_BATCH_LIMIT);
    // The overflow can start its own batch; reserved photos are skipped.
    const second = await prepareTrashBatch(
      asExpo(d),
      Array.from({ length: TRASH_BATCH_LIMIT + 20 }, (_, i) => ({
        photoId: `p${i}`,
        measuredBytes: 10,
      })),
      AT,
    );
    expect(second!.members).toHaveLength(20);
  });

  it('only stages culled photos and returns null when nothing is eligible', async () => {
    const d = await fresh();
    insertPhoto(d, 'kept1', 'kept');
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'kept1', measuredBytes: 5 }], AT);
    expect(batch).toBeNull();
  });
});

describe('resolveTrashBatch', () => {
  it('applied + absent → trashed with credit and the C#7 cleanup', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    attach(d, 'p1', 'edit', 'queued');
    attach(d, 'p1', 'favourite', 'queued', '1');
    attach(d, 'p1', 'organize', 'queued', encodeOrganizeTarget('external_primary', 'Pictures/A/'));
    attach(d, 'p1', 'share', 'queued');
    d.raw.prepare('INSERT INTO share_cycles (started_at) VALUES (?)').run(AT);
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'p1', measuredBytes: 111 }], AT);
    await markBatchLaunching(asExpo(d), batch!.batchId, AT + 1);
    const result = await resolveTrashBatch(asExpo(d), {
      batchId: batch!.batchId,
      verify: absent,
      dialog: 'applied',
      at: AT + 2,
    });
    expect(result.outcomes.p1).toBe('trashed');
    expect(result.creditedBytes).toBe(111);
    expect(result.batchState).toBe('verified');
    const row = d.raw
      .prepare('SELECT state, is_present FROM photos WHERE asset_id = ?')
      .get('p1') as Record<string, unknown>;
    expect(row.state).toBe('trashed');
    expect(row.is_present).toBe(0);
    // Every outstanding action left; none of them ever completed, so
    // nothing remains to remember (C#7).
    expect(actionsOf(d, 'p1')).toEqual({});
    const reservations = d.raw.prepare('SELECT COUNT(*) AS n FROM trash_reservations').get() as {
      n: number;
    };
    expect(reservations.n).toBe(0);
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(111);
  });

  it('C#7 cleanup also cancels error-state intents so a restore cannot resurrect them', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    attach(d, 'p1', 'favourite', 'error', '1');
    attach(
      d,
      'p1',
      'organize',
      'error',
      encodeOrganizeTarget('external_primary', 'Pictures/Trips/'),
    );
    // A favourite that ALREADY applied once, now re-queued and failing:
    // its permanent record must survive what its live intent does not.
    attach(d, 'p1', 'share', 'error', null, AT - 1000);
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'p1', measuredBytes: 10 }], AT);
    await markBatchLaunching(asExpo(d), batch!.batchId, AT + 1);
    await resolveTrashBatch(asExpo(d), {
      batchId: batch!.batchId,
      verify: absent,
      dialog: 'applied',
      at: AT + 2,
    });
    // The two intents that never completed are gone entirely; the one
    // that did keeps its proof, demoted out of the queue with no target.
    expect(actionsOf(d, 'p1')).toEqual({ share: 'applied' });
    const share = d.raw
      .prepare(
        "SELECT target, resolved_at FROM photo_actions WHERE photo_id = 'p1' AND kind = 'share'",
      )
      .get() as { target: string | null; resolved_at: number | null };
    expect(share.target).toBeNull();
    expect(share.resolved_at).toBe(AT - 1000);
  });

  it('cancelled dialog releases members back to the cull queue', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'p1', measuredBytes: 50 }], AT);
    const result = await resolveTrashBatch(asExpo(d), {
      batchId: batch!.batchId,
      verify: absent,
      dialog: 'cancelled',
      at: AT + 2,
    });
    expect(result.outcomes.p1).toBe('still_present');
    expect(result.creditedBytes).toBe(0);
    expect(result.batchState).toBe('cancelled');
    const row = d.raw.prepare('SELECT state FROM photos WHERE asset_id = ?').get('p1') as {
      state: string;
    };
    expect(row.state).toBe('culled'); // still staged, retryable
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(0);
  });

  it('unknown verification earns no credit and stays retryable', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'p1', measuredBytes: 50 }], AT);
    await markBatchLaunching(asExpo(d), batch!.batchId, AT + 1);
    const result = await resolveTrashBatch(asExpo(d), {
      batchId: batch!.batchId,
      verify: unknown,
      dialog: 'applied',
      at: AT + 2,
    });
    expect(result.outcomes.p1).toBe('unknown');
    expect(result.creditedBytes).toBe(0);
    expect(result.batchState).toBe('verified_partial');
    // Retry: a new batch can be prepared (no terminal outcome, no live reservation).
    const retry = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: 'p1', measuredBytes: 50 }],
      AT + 3,
    );
    expect(retry!.members).toHaveLength(1);
  });
});

describe('resolveTrashBatch — unreachable partner (final cycle O2)', () => {
  /** Seed a cross-volume pair through the scan write: primary/p1 grouped
   * with sd/s1 (the SD card later ejects). */
  async function seedPair(d: TestDb): Promise<void> {
    await writeContinuousGroups(
      asExpo(d),
      {
        photos: [
          {
            assetId: 'external_primary/p1',
            uri: 'file:///storage/emulated/0/DCIM/p1.jpg',
            takenAt: AT - 3_600_000,
            modTime: AT - 3_600_000,
            day: '2026-07-20',
            volumeName: 'external_primary',
            rawId: 'p1',
            sizeBytes: 1_000,
          },
          {
            assetId: '0a91-e18d/s1',
            uri: 'file:///storage/0A91-E18D/DCIM/s1.jpg',
            takenAt: AT - 3_599_000,
            modTime: AT - 3_599_000,
            day: '2026-07-20',
            volumeName: '0a91-e18d',
            rawId: 's1',
            sizeBytes: 1_000,
          },
        ],
        groups: [{ members: ['external_primary/p1', '0a91-e18d/s1'], timeAttached: [] }],
        singles: [],
      },
      AT,
    );
  }

  async function trashPrimaryMember(d: TestDb, mountedVolumes: readonly string[] | null) {
    d.raw
      .prepare("UPDATE photos SET state = 'culled' WHERE asset_id = 'external_primary/p1'")
      .run();
    const prepared = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: 'external_primary/p1', measuredBytes: 10 }],
      AT + 100,
    );
    await markBatchLaunching(asExpo(d), prepared!.batchId, AT + 200);
    return resolveTrashBatch(asExpo(d), {
      batchId: prepared!.batchId,
      verify: absent,
      dialog: 'applied',
      at: AT + 300,
      mountedVolumes,
    });
  }

  it('defers the dissolve while the partner is on an unmounted card (plan §5)', async () => {
    const d = await fresh();
    await seedPair(d);
    await trashPrimaryMember(d, ['external_primary']);
    const partner = d.raw
      .prepare(
        `SELECT group_id, user_single FROM photo_group_assignments WHERE photo_id = '0a91-e18d/s1'`,
      )
      .get() as { group_id: number | null; user_single: number };
    expect(partner.group_id).not.toBeNull();
    expect(partner.user_single).toBe(0);
  });

  it('without mount knowledge (null) the standard dissolve applies', async () => {
    const d = await fresh();
    await seedPair(d);
    await trashPrimaryMember(d, null);
    const partner = d.raw
      .prepare(`SELECT group_id FROM photo_group_assignments WHERE photo_id = '0a91-e18d/s1'`)
      .get() as { group_id: number | null };
    expect(partner.group_id).toBeNull();
  });
});

describe('reconcileExternallyRemoved', () => {
  it('converges externally-removed photos like a verified trash outcome, without credit', async () => {
    const d = await fresh();
    insertPhoto(d, 'p1', 'kept');
    attach(d, 'p1', 'edit', 'queued');
    attach(d, 'p1', 'favourite', 'queued', '1');
    attach(d, 'p1', 'organize', 'error', encodeOrganizeTarget('external_primary', 'Pictures/A/'));
    attach(d, 'p1', 'share', 'queued');
    d.raw.prepare('INSERT INTO share_cycles (started_at) VALUES (?)').run(AT);
    await reconcileExternallyRemoved(asExpo(d), ['p1'], AT + 10);
    const row = d.raw
      .prepare('SELECT state, is_present, culled_at FROM photos WHERE asset_id = ?')
      .get('p1') as Record<string, unknown>;
    expect(row.state).toBe('trashed');
    // No Afterglow cull decision was made — the lifetime culled count
    // (culled_at markers) must not inflate.
    expect(row.culled_at).toBeNull();
    expect(row.is_present).toBe(0);
    expect(actionsOf(d, 'p1')).toEqual({});
    // The share queue emptied, so its cycle ends; and no credit accrues.
    const openCycles = d.raw
      .prepare('SELECT COUNT(*) AS n FROM share_cycles WHERE ended_at IS NULL')
      .get() as { n: number };
    expect(openCycles.n).toBe(0);
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(0);
  });
});

describe('prepareTrashBatch stageToEditMembers (edited-copy cull)', () => {
  it('stages an edit-queue member and reserves it in one transaction', async () => {
    const d = await fresh();
    insertPhoto(d, 'e1', 'kept');
    attach(d, 'e1', 'edit', 'queued');
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'e1', measuredBytes: 42 }], AT, {
      stageToEditMembers: true,
    });
    expect(batch!.members).toHaveLength(1);
    const row = d.raw.prepare('SELECT state FROM photos WHERE asset_id = ?').get('e1') as {
      state: string;
    };
    // Staged AND reserved atomically, and the edit RESOLVED in the same
    // transaction: the editor already wrote the copy, so the edit is
    // done however the original ends up. A non-trashed outcome still
    // reverts the verdict, and the permanent resolved_at then survives
    // the removal cleanup — an edit you really did counts exactly once,
    // whichever way the copy prompt is answered.
    expect(row.state).toBe('culled');
    expect(actionsOf(d, 'e1')).toEqual({ edit: 'applied' });
    const resolved = d.raw
      .prepare("SELECT resolved_at FROM photo_actions WHERE photo_id = 'e1' AND kind = 'edit'")
      .get() as { resolved_at: number };
    expect(resolved.resolved_at).toBe(AT);
    const reserved = d.raw.prepare('SELECT photo_id FROM trash_reservations').all();
    expect(reserved).toEqual([{ photo_id: 'e1' }]);
  });

  it('staging an UNREVIEWED edit-queue member stamps it like any verdict', async () => {
    // The edited-copy prompt can cull a photo that was never reviewed
    // (flagging to edit does not decide). The staged cull is a VERDICT,
    // so reviewed_at first-stamps and decided_at stamps with it — or the
    // photo stays invisible to every decided_at/reviewed_at consumer
    // (daily goal, lifetime stats, forecast base rates) while its state
    // says culled.
    const d = await fresh();
    insertPhoto(d, 'e1', 'unreviewed');
    attach(d, 'e1', 'edit', 'queued');
    await prepareTrashBatch(asExpo(d), [{ photoId: 'e1', measuredBytes: 42 }], AT, {
      stageToEditMembers: true,
    });
    const row = d.raw
      .prepare('SELECT state, reviewed_at, decided_at FROM photos WHERE asset_id = ?')
      .get('e1') as { state: string; reviewed_at: number | null; decided_at: number | null };
    expect(row).toEqual({ state: 'culled', reviewed_at: AT, decided_at: AT });
  });

  it('without the option an undecided edit-queue member is skipped', async () => {
    const d = await fresh();
    insertPhoto(d, 'e1', 'kept');
    attach(d, 'e1', 'edit', 'queued');
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'e1', measuredBytes: 42 }], AT);
    expect(batch).toBeNull();
  });

  it('the completed edit survives the verified removal', async () => {
    // applyRemovalCleanup DELETES an unresolved action and demotes a
    // resolved one, so resolving at stage time is what keeps the record.
    const d = await fresh();
    insertPhoto(d, 'e1', 'kept');
    attach(d, 'e1', 'edit', 'queued');
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'e1', measuredBytes: 42 }], AT, {
      stageToEditMembers: true,
    });
    await markBatchLaunching(asExpo(d), batch!.batchId, AT + 1);
    await resolveTrashBatch(asExpo(d), {
      batchId: batch!.batchId,
      verify: absent,
      dialog: 'applied',
      at: AT + 2,
    });
    expect(
      (d.raw.prepare("SELECT state FROM photos WHERE asset_id = 'e1'").get() as { state: string })
        .state,
    ).toBe('trashed');
    expect(actionsOf(d, 'e1')).toEqual({ edit: 'applied' });
  });

  it('reports fresh goal work under the once-per-day rule (codex round 3)', async () => {
    // The staging is a verdict write that moves decided_at into the
    // day of `at` — it must report fresh work exactly like
    // applyReviewDecisions, or the ring moves without the celebration
    // counter (the m0.8.5 uncredited-path defect class). Unreviewed and
    // earlier-day rows count; a row already stamped in `at`'s day does
    // not.
    const d = await fresh();
    insertPhoto(d, 'never', 'unreviewed');
    attach(d, 'never', 'edit', 'queued');
    insertPhoto(d, 'earlier', 'kept');
    attach(d, 'earlier', 'edit', 'queued');
    d.raw
      .prepare('UPDATE photos SET decided_at = ? WHERE asset_id = ?')
      .run(AT - 86_400_000, 'earlier');
    insertPhoto(d, 'sameDay', 'kept');
    attach(d, 'sameDay', 'edit', 'queued');
    d.raw.prepare('UPDATE photos SET decided_at = ? WHERE asset_id = ?').run(AT - 1000, 'sameDay');
    const batch = await prepareTrashBatch(
      asExpo(d),
      [
        { photoId: 'never', measuredBytes: 1 },
        { photoId: 'earlier', measuredBytes: 1 },
        { photoId: 'sameDay', measuredBytes: 1 },
      ],
      AT,
      { stageToEditMembers: true },
    );
    expect(batch!.members).toHaveLength(3);
    expect(batch!.freshDecisions).toBe(2);
  });

  it('reserving already-staged culls reports no fresh work', async () => {
    // Without stageToEditMembers nothing decides — the reservation must
    // never count toward the goal.
    const d = await fresh();
    insertCull(d, 'c1');
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'c1', measuredBytes: 1 }], AT);
    expect(batch!.members).toHaveLength(1);
    expect(batch!.freshDecisions).toBe(0);
  });

  it('a stale prompt whose original left the edit queue stages nothing', async () => {
    const d = await fresh();
    insertPhoto(d, 'e1', 'kept'); // the edit was completed and unqueued
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'e1', measuredBytes: 42 }], AT, {
      stageToEditMembers: true,
    });
    expect(batch).toBeNull();
    expect(
      (d.raw.prepare('SELECT state FROM photos WHERE asset_id = ?').get('e1') as { state: string })
        .state,
    ).toBe('kept');
  });
});

describe('recovery after process death (P8#3)', () => {
  it('an interrupted preparing batch is released without dispatch', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    await prepareTrashBatch(asExpo(d), [{ photoId: 'p1', measuredBytes: 10 }], AT);
    // Death here — no dispatch. Recovery releases everything.
    const recovered = await recoverTrashBatches(asExpo(d), absent, AT + 10);
    expect(recovered.staleBatches).toBe(1);
    expect(recovered.trashedIds).toEqual([]); // released, not trashed
    const batch = d.raw.prepare('SELECT state FROM trash_batches').get() as { state: string };
    expect(batch.state).toBe('cancelled');
    const row = d.raw.prepare('SELECT state FROM photos WHERE asset_id = ?').get('p1') as {
      state: string;
    };
    expect(row.state).toBe('culled');
  });

  it('an interrupted launching batch with absence is repaired but UNCREDITED', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'p1', measuredBytes: 999 }], AT);
    await markBatchLaunching(asExpo(d), batch!.batchId, AT + 1);
    // Death in the crash window; on restart the URI is absent.
    const recovered = await recoverTrashBatches(asExpo(d), absent, AT + 10);
    // The caller reconciles these into any resumed session snapshot.
    expect(recovered.trashedIds).toEqual(['p1']);
    const member = d.raw
      .prepare('SELECT outcome FROM trash_batch_members WHERE photo_id = ?')
      .get('p1') as { outcome: string };
    expect(member.outcome).toBe('absent_after_interrupted_launch');
    const row = d.raw
      .prepare('SELECT state, is_present FROM photos WHERE asset_id = ?')
      .get('p1') as Record<string, unknown>;
    expect(row.state).toBe('trashed'); // repaired
    expect(row.is_present).toBe(0);
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(0); // never credited
    // A second recovery pass cannot double-account (idempotent terminal).
    await recoverTrashBatches(asExpo(d), absent, AT + 20);
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(0);
  });

  it('an interrupted launching batch still present releases back to culled', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'p1', measuredBytes: 10 }], AT);
    await markBatchLaunching(asExpo(d), batch!.batchId, AT + 1);
    await recoverTrashBatches(asExpo(d), present, AT + 10);
    const row = d.raw.prepare('SELECT state FROM photos WHERE asset_id = ?').get('p1') as {
      state: string;
    };
    expect(row.state).toBe('culled');
  });
});

describe('restore → re-trash generations (P8#4)', () => {
  it('a verified post-restore re-trash counts the next generation exactly once', async () => {
    const d = await fresh();
    insertCull(d, 'p1');
    const first = await prepareTrashBatch(asExpo(d), [{ photoId: 'p1', measuredBytes: 100 }], AT);
    await markBatchLaunching(asExpo(d), first!.batchId, AT + 1);
    await resolveTrashBatch(asExpo(d), {
      batchId: first!.batchId,
      verify: absent,
      dialog: 'applied',
      at: AT + 2,
    });
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(100);
    // Gallery restore: generation increments once, photo re-enters review.
    await markPhotoRestored(asExpo(d), 'p1', AT + 10);
    const gen = d.raw
      .prepare('SELECT trash_generation, state FROM photos WHERE asset_id = ?')
      .get('p1') as Record<string, unknown>;
    expect(gen.trash_generation).toBe(1);
    expect(gen.state).toBe('unreviewed');
    // Re-stage + re-trash: the new generation counts again.
    d.raw.prepare("UPDATE photos SET state = 'culled' WHERE asset_id = 'p1'").run();
    const second = await prepareTrashBatch(
      asExpo(d),
      [{ photoId: 'p1', measuredBytes: 100 }],
      AT + 20,
    );
    await markBatchLaunching(asExpo(d), second!.batchId, AT + 21);
    await resolveTrashBatch(asExpo(d), {
      batchId: second!.batchId,
      verify: absent,
      dialog: 'applied',
      at: AT + 22,
    });
    expect(await lifetimeReclaimedBytes(asExpo(d))).toBe(200);
  });
});

describe('stage-and-reserve star hygiene (final-review round 8)', () => {
  it('staging an edit-queue member to culled clears a star pointing at it', async () => {
    const d = await fresh();
    insertPhoto(d, 'a', 'kept');
    attach(d, 'a', 'edit', 'queued');
    insertPhoto(d, 'b', 'unreviewed');
    d.raw
      .prepare("INSERT INTO grouping_runs (provenance, created_at) VALUES ('continuous', 1)")
      .run();
    d.raw.prepare('INSERT INTO photo_groups (run_id, best_photo_id) VALUES (1, NULL)').run();
    d.raw
      .prepare(
        "INSERT INTO photo_group_assignments (photo_id, group_id, run_id) VALUES ('a', 1, 1), ('b', 1, 1)",
      )
      .run();
    d.raw.prepare("UPDATE photo_groups SET best_photo_id = 'a' WHERE id = 1").run();
    const batch = await prepareTrashBatch(asExpo(d), [{ photoId: 'a', measuredBytes: 10 }], AT, {
      stageToEditMembers: true,
    });
    expect(batch).not.toBeNull();
    const row = d.raw.prepare('SELECT best_photo_id FROM photo_groups WHERE id = 1').get() as {
      best_photo_id: string | null;
    };
    expect(row.best_photo_id).toBeNull();
    const photo = d.raw.prepare("SELECT state FROM photos WHERE asset_id = 'a'").get() as {
      state: string;
    };
    expect(photo.state).toBe('culled');
  });
});
