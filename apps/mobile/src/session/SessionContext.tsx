/**
 * Holds the live core DeckSession, mirrors every mutation into SQLite
 * (snapshot + changed photo states + compare records), and exposes the
 * review actions to the screens.
 *
 * All deck/staging logic lives in @afterglow/core — this file only adapts
 * it to React and persistence. m0.4 replaced the pairwise duel bracket
 * with the swipe deck (core deck.ts; the bracket CullSession remains in
 * core, unused by the app). The m0.2 additions (needs-edit flags, kept →
 * done convergence) are app-side state layered over the core session:
 * core only knows kept/culled; SQLite is the source of truth for
 * to_edit/done (PLAN.md).
 *
 * Migration note (m0.3.x → m0.4): an in-flight bracket session's snapshot
 * fails DeckSession.fromJSON and is abandoned on resume — reviewed states
 * in SQLite are the durable truth, and per m0.3.1 an abandoned session's
 * interim rows are re-reviewed next session.
 */
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import {
  DeckSession,
  clusterByGap,
  groupBySimilarity,
  MOMENTS_GAP_MS,
  type Cluster,
  type MediaItem,
  type PhotoState,
} from '@afterglow/core';
import type { LoadedPhoto } from '../lib/media';
import { getEditableContentUri, trashAssets } from '../lib/media';
import { isMediaTrashed } from '../../modules/media-store-actions';
import { markBatchLaunching, prepareTrashBatch, resolveTrashBatch } from '../db/trashStore';
import { fileSize, sha256OfFile } from '../lib/hash';
import { dayKey } from '../lib/dates';
import { ensureDhashes } from '../lib/similarityHashes';
import {
  parseSimilarityThreshold,
  parseTimeOnly,
  SIMILARITY_THRESHOLD_KEY,
  SIMILARITY_TIME_ONLY_KEY,
  TIME_BONUS_BITS,
} from '../lib/similarityPrefs';
import { FifoPersistenceQueue } from './persistenceQueue';
import {
  isFavouriteSelected,
  nextFavouriteIntent,
  NO_FAVOURITE,
  type FavouriteStatus,
} from '../lib/favouriteState';
import {
  abandonActiveSessions,
  addReclaimedBytes,
  bankActiveSessionKeepers,
  clearPhotoGroup,
  completeSession,
  replaceActiveSession,
  getActiveSession,
  getFavouriteStates,
  getNeedsEditAssets,
  getSetting,
  markKeptDone,
  persistDecision,
  setContentHash,
  type PersistDecisionExtras,
} from '../db/store';

/** Gap that makes shots "the same moment" → one cull group. */
export const CULL_GROUP_GAP_MS = MOMENTS_GAP_MS; // 3 minutes

/** m0.2 single-review actions ('to_edit' = keep + flag for the edit queue). */
export type SingleReviewAction = 'keep' | 'cull' | 'to_edit';

/** Decision chips. Tapping the active chip clears back to unreviewed. */
export type RedecideTarget = 'keep' | 'cull' | 'to_edit';

export interface GroupInfo {
  id: string;
  /** Current members (photos moved out via "not related" have left). */
  items: MediaItem[];
  complete: boolean;
  bestId: string | null;
}

export interface ConfirmResult {
  /** True if the batch was moved to system trash (or was empty). */
  deleted: boolean;
  status: 'applied' | 'cancelled' | 'unsupported' | 'failed';
  error?: string;
  count: number;
  bytes: number;
}

interface PersistenceError {
  message: string;
  nonce: number;
}

interface PersistJob {
  sessionId: number;
  snapshot: string;
  after: Map<string, PhotoState>;
  extras: PersistDecisionExtras;
}

interface SessionContextValue {
  /** Null when no session is active. */
  session: DeckSession | null;
  sessionId: number | null;
  label: string;
  /** Bytes reclaimed so far in this session. */
  reclaimedBytes: number;
  /** Monotonic counter bumped on every mutation (for memo deps). */
  version: number;
  /** A decision write failed; the queued write must be retried before continuing. */
  persistenceError: PersistenceError | null;
  retryPersistence: () => void;
  groups: GroupInfo[];
  singleIds: string[];
  startSession: (
    label: string,
    rangeStart: number,
    rangeEnd: number,
    photos: readonly LoadedPhoto[],
    /** Perceptual-hash progress while groups are being built (m0.4). */
    onHashProgress?: (done: number, total: number) => void,
  ) => Promise<void>;
  /** Restore the persisted active session, if any. Returns true if resumed. */
  resumeSession: () => Promise<boolean>;
  discardActiveSession: () => Promise<void>;
  // ------------------------------------------------------- deck actions
  /** Swipe: persistively move a group's deck cursor. */
  deckSetCursor: (groupId: string, index: number) => void;
  /** Cull the photo out of its deck onto the staged cull list. */
  deckCull: (id: string) => Promise<void>;
  /** Brief-undo for a deck cull: back into the deck, unreviewed. */
  deckUndoCull: (id: string) => Promise<void>;
  /** Finish the group: alive unreviewed members are kept. */
  keepRest: (groupId: string) => Promise<void>;
  /** Star/unstar the group's single best. */
  markBest: (groupId: string, id: string | null) => Promise<void>;
  /** "Not related — review as single": moves the photo to the singles flow. */
  makeSingle: (id: string) => Promise<void>;
  /** Compare tool outcome: winner is better, both stay (records history). */
  recordCompare: (winnerId: string, loserId: string) => Promise<void>;
  /** Compare tool outcome: cull the loser (records history + stages cull). */
  compareCull: (loserId: string, winnerId: string) => Promise<void>;
  decideSingle: (id: string, action: SingleReviewAction) => Promise<void>;
  /** Keep every still-unreviewed single in one captured write. */
  keepRemainingSingles: () => Promise<void>;
  /** Whether a photo carries the "keeper needs editing" flag. */
  needsEdit: (id: string) => boolean;
  /** Flip the needs-edit flag (persisted immediately; state remaps if kept). */
  toggleNeedsEdit: (id: string) => Promise<void>;
  /** How many photos in this session are flagged for editing. */
  editFlagCount: number;
  favouriteStatus: (id: string) => FavouriteStatus;
  toggleFavourite: (id: string) => Promise<void>;
  /** Reload gallery-favourite state after the queue screen applies a batch. */
  refreshFavouriteStates: () => Promise<void>;
  unstageCull: (id: string) => Promise<void>;
  /**
   * Change any decided photo's verdict until final trash confirmation.
   * Tapping the currently active target clears it to unreviewed and reopens
   * its group/singles queue; no hidden decision history is maintained.
   */
  redecide: (id: string, target: RedecideTarget) => Promise<void>;
  /** THE one delete path: confirm staged culls → system dialog → trash. */
  confirmCulls: () => Promise<ConfirmResult>;
  /** Finish: remaining keepers converge to done; to_edit stays queued. */
  finishSession: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function statesOf(session: DeckSession): Map<string, PhotoState> {
  return new Map(Object.entries(session.toJSON().states) as [string, PhotoState][]);
}

function changedStates(
  before: Map<string, PhotoState>,
  after: Map<string, PhotoState>,
): [string, PhotoState][] {
  const changes: [string, PhotoState][] = [];
  for (const [id, state] of after) {
    if (before.get(id) !== state) changes.push([id, state]);
  }
  return changes;
}

/** Keep one unreviewed photo regardless of grouped/single membership. */
function keepUnreviewed(session: DeckSession, id: string): void {
  const group = session.groupsInfo().find((candidate) => candidate.aliveIds.includes(id));
  if (group) session.keep(id);
  else if (session.toJSON().singleIds.includes(id)) session.decideSingle(id, 'keep');
  else throw new Error(`keepUnreviewed: ${id} is not pending review`);
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const db = useSQLiteContext();
  const sessionRef = useRef<DeckSession | null>(null);
  const needsEditRef = useRef<Set<string>>(new Set());
  const favouriteRef = useRef<Map<string, FavouriteStatus>>(new Map());
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [reclaimedBytes, setReclaimedBytes] = useState(0);
  const [version, setVersion] = useState(0);
  const [persistenceError, setPersistenceError] = useState<PersistenceError | null>(null);
  const persistenceQueueRef = useRef<FifoPersistenceQueue<
    Map<string, PhotoState>,
    PersistJob
  > | null>(null);
  if (persistenceQueueRef.current === null) {
    persistenceQueueRef.current = new FifoPersistenceQueue(
      new Map(),
      async (job, before) => {
        await persistDecision(
          db,
          job.sessionId,
          job.snapshot,
          changedStates(before, job.after),
          Date.now(),
          job.extras,
        );
        return job.after;
      },
      (error) => {
        setPersistenceError(
          error === null
            ? null
            : {
                message: error instanceof Error ? error.message : String(error),
                nonce: Date.now(),
              },
        );
      },
    );
  }
  const persistenceQueue = persistenceQueueRef.current;

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  /** Capture a mutation immediately, then persist it in strict FIFO order. */
  const persist = useCallback(
    (extras: PersistDecisionExtras = {}): Promise<void> => {
      const session = sessionRef.current;
      if (!session || sessionId === null) return Promise.resolve();
      const after = statesOf(session);
      const snapshot = JSON.stringify(session.toJSON());
      return persistenceQueue.enqueue({ sessionId, snapshot, after, extras });
    },
    [sessionId, persistenceQueue],
  );

  const retryPersistence = useCallback(() => {
    persistenceQueue.retry();
  }, [persistenceQueue]);

  const waitForPersistence = useCallback(
    (): Promise<void> => persistenceQueue.waitForIdle(),
    [persistenceQueue],
  );

  const startSession = useCallback(
    async (
      newLabel: string,
      rangeStart: number,
      rangeEnd: number,
      photos: readonly LoadedPhoto[],
      onHashProgress?: (done: number, total: number) => void,
    ) => {
      await waitForPersistence();
      // m0.7 item B: SIMILARITY-FIRST grouping. Components form over the
      // whole draw — time proximity only relaxes the bar (never excludes),
      // so the same subject shot on different days still groups (#24). The
      // legacy time-only toggle keeps clusterByGap verbatim as an escape
      // hatch (R#8: a separate mode, not slider value 64).
      const timeOnly = parseTimeOnly(await getSetting(db, SIMILARITY_TIME_ONLY_KEY));
      let components: Cluster[];
      if (timeOnly) {
        components = clusterByGap(
          photos.map((p) => p.item),
          { gapMs: CULL_GROUP_GAP_MS },
        );
      } else {
        // Every drawn photo is hashed (cached in SQLite); a hashless photo
        // becomes a singleton by the core null-hash rule.
        const { hashes } = await ensureDhashes(db, [...photos], onHashProgress);
        const threshold = parseSimilarityThreshold(await getSetting(db, SIMILARITY_THRESHOLD_KEY));
        components = groupBySimilarity(
          photos.map((p) => p.item),
          (id) => hashes.get(id) ?? null,
          {
            threshold,
            timeBonusMs: CULL_GROUP_GAP_MS,
            timeBonusBits: TIME_BONUS_BITS,
          },
        );
      }
      const groups = components.filter((c) => c.items.length >= 2);
      // Singleton components join the singles bucket, chronological order.
      const singles = components
        .filter((c) => c.items.length === 1)
        .map((c) => c.items[0])
        .sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const session = DeckSession.create({ groups, singles });

      const groupIdByAsset = new Map<string, string>();
      for (const g of groups) for (const item of g.items) groupIdByAsset.set(item.id, g.id);

      // m0.7 (N#2, P4#1): replacement is ONE atomic transaction — bank the
      // old session's keepers, abandon it, create the new session. Staged
      // culls are carried in the durable global cull queue, so replacement
      // is silent; a failure anywhere leaves the old session resumable.
      const id = await replaceActiveSession(
        db,
        {
          label: newLabel,
          rangeStart,
          rangeEnd,
          snapshot: JSON.stringify(session.toJSON()),
          photos: photos.map((p) => ({
            ...p,
            groupId: groupIdByAsset.get(p.item.id) ?? null,
            day: dayKey(p.item.timestamp),
          })),
          createdAt: Date.now(),
        },
        Date.now(),
      );

      sessionRef.current = session;
      persistenceQueue.resetCommitted(statesOf(session));
      needsEditRef.current = new Set();
      favouriteRef.current = await getFavouriteStates(
        db,
        session.toJSON().items.map((item) => item.id),
      );
      setSessionId(id);
      setLabel(newLabel);
      setReclaimedBytes(0);
      bump();
    },
    [db, bump, waitForPersistence, persistenceQueue],
  );

  const resumeSession = useCallback(async () => {
    await waitForPersistence();
    const row = await getActiveSession(db);
    if (!row) return false;
    try {
      // Bracket-era (m0.3.x) snapshots throw here and are abandoned —
      // deliberate upgrade behavior, see the module docs.
      const session = DeckSession.fromJSON(JSON.parse(row.snapshot));
      sessionRef.current = session;
      persistenceQueue.resetCommitted(statesOf(session));
      needsEditRef.current = await getNeedsEditAssets(
        db,
        session.toJSON().items.map((i) => i.id),
      );
      favouriteRef.current = await getFavouriteStates(
        db,
        session.toJSON().items.map((item) => item.id),
      );
      setSessionId(row.id);
      setLabel(row.label);
      setReclaimedBytes(row.reclaimed_bytes);
      bump();
      return true;
    } catch {
      // Corrupt or pre-deck snapshot: abandon rather than dead-ending.
      await abandonActiveSessions(db, Date.now());
      return false;
    }
  }, [db, bump, waitForPersistence, persistenceQueue]);

  const discardActiveSession = useCallback(async () => {
    await waitForPersistence();
    await abandonActiveSessions(db, Date.now());
    sessionRef.current = null;
    needsEditRef.current = new Set();
    favouriteRef.current = new Map();
    setSessionId(null);
    setLabel('');
    setReclaimedBytes(0);
    bump();
  }, [db, bump, waitForPersistence]);

  /** Content-hash fallback identity, computed only for staged culls. */
  const hashInBackground = useCallback(
    async (assetId: string) => {
      const session = sessionRef.current;
      if (!session) return;
      let uri: string;
      try {
        uri = session.item(assetId).uri;
      } catch {
        return;
      }
      const hash = await sha256OfFile(uri);
      if (hash) await setContentHash(db, assetId, hash).catch(() => {});
    },
    [db],
  );

  // ---------------------------------------------------------- deck actions

  const deckSetCursor = useCallback(
    (groupId: string, index: number) => {
      const session = sessionRef.current;
      if (!session) return;
      const before = session.groupInfo(groupId).cursor;
      session.setCursor(groupId, index);
      if (session.groupInfo(groupId).cursor === before) return;
      bump();
      // Fire-and-forget: cursor-only snapshot write, nothing user-visible
      // depends on it landing before the next action (expo-sqlite queues
      // writes in call order on one connection).
      void persist();
    },
    [persist, bump],
  );

  const deckCull = useCallback(
    async (id: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('deckCull: no active session');
      session.cull(id); // throws if the id is not in a live deck
      bump();
      await persist();
      void hashInBackground(id);
    },
    [persist, bump, hashInBackground],
  );

  const deckUndoCull = useCallback(
    async (id: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('deckUndoCull: no active session');
      session.undoCull(id);
      bump();
      await persist();
    },
    [persist, bump],
  );

  const keepRest = useCallback(
    async (groupId: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('keepRest: no active session');
      session.keepRest(groupId);
      bump();
      await persist();
    },
    [persist, bump],
  );

  const markBest = useCallback(
    async (groupId: string, id: string | null) => {
      const session = sessionRef.current;
      if (!session) throw new Error('markBest: no active session');
      session.markBest(groupId, id);
      bump();
      await persist();
    },
    [persist, bump],
  );

  const makeSingle = useCallback(
    async (id: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('makeSingle: no active session');
      session.makeSingle(id);
      bump();
      await persist();
      // The photo is no longer "in a group" for day-progress accounting.
      await clearPhotoGroup(db, id).catch(() => {});
    },
    [db, persist, bump],
  );

  const recordCompare = useCallback(
    async (winnerId: string, loserId: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('recordCompare: no active session');
      const record = session.recordCompare(winnerId, loserId, true, Date.now());
      bump();
      await persist({ duel: record });
    },
    [persist, bump],
  );

  const compareCull = useCallback(
    async (loserId: string, winnerId: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('compareCull: no active session');
      const record = session.recordCompare(winnerId, loserId, false, Date.now());
      session.cull(loserId);
      bump();
      await persist({ duel: record });
      void hashInBackground(loserId);
    },
    [persist, bump, hashInBackground],
  );

  const decideSingle = useCallback(
    async (id: string, action: SingleReviewAction) => {
      const session = sessionRef.current;
      if (!session) throw new Error('decideSingle: no active session');
      if (action === 'to_edit') {
        needsEditRef.current.add(id);
        session.decideSingle(id, 'keep');
      } else {
        session.decideSingle(id, action);
      }
      bump();
      await persist(
        action === 'to_edit' ? { needsEditChanges: [{ assetId: id, needsEdit: true }] } : undefined,
      );
      if (action === 'cull') void hashInBackground(id);
    },
    [persist, bump, hashInBackground],
  );

  const keepRemainingSingles = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) throw new Error('keepRemainingSingles: no active session');
    const pending = session
      .toJSON()
      .singleIds.filter((id) => session.getState(id) === 'unreviewed');
    if (pending.length === 0) return;
    for (const id of pending) session.decideSingle(id, 'keep');
    bump();
    await persist();
  }, [persist, bump]);

  const needsEdit = useCallback(
    (id: string) => needsEditRef.current.has(id),
    // needsEditRef is a ref; version ties re-renders to mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  const toggleNeedsEdit = useCallback(
    async (id: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('toggleNeedsEdit: no active session');
      const flagged = needsEditRef.current.has(id);
      if (flagged) needsEditRef.current.delete(id);
      else {
        needsEditRef.current.add(id);
        if (session.getState(id) === 'unreviewed') keepUnreviewed(session, id);
      }
      bump();
      await persist({ needsEditChanges: [{ assetId: id, needsEdit: !flagged }] });
    },
    [persist, bump],
  );

  const favouriteStatus = useCallback(
    (id: string): FavouriteStatus => favouriteRef.current.get(id) ?? NO_FAVOURITE,
    // favouriteRef is mutable; version is the render signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  const toggleFavourite = useCallback(
    async (id: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('toggleFavourite: no active session');
      const current = favouriteRef.current.get(id) ?? NO_FAVOURITE;
      const change = nextFavouriteIntent(id, current);
      if (isFavouriteSelected({ state: change.state, target: change.target })) {
        if (session.getState(id) === 'unreviewed') keepUnreviewed(session, id);
      }
      favouriteRef.current.set(id, { state: change.state, target: change.target });
      bump();
      await persist({ favouriteChanges: [change] });
    },
    [persist, bump],
  );

  const refreshFavouriteStates = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    favouriteRef.current = await getFavouriteStates(
      db,
      session.toJSON().items.map((item) => item.id),
    );
    bump();
  }, [db, bump]);

  const unstageCull = useCallback(
    async (id: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('unstageCull: no active session');
      session.unstageCull(id);
      bump();
      await persist();
    },
    [persist, bump],
  );

  const redecide = useCallback(
    async (id: string, target: RedecideTarget) => {
      const session = sessionRef.current;
      if (!session) throw new Error('redecide: no active session');
      const state = session.getState(id);
      // Only decided, pre-confirm photos are re-decidable; 'to_edit' is
      // app-side (core state 'kept' + needs-edit flag).
      if (state !== 'kept' && state !== 'culled') return;
      const current: RedecideTarget =
        state === 'culled' ? 'cull' : needsEditRef.current.has(id) ? 'to_edit' : 'keep';

      // One invariant everywhere: tapping an active verdict clears it to
      // the default state. A group item is reinserted and the group reopens;
      // a single becomes pending again.
      if (target === current) {
        const clearedEdit = needsEditRef.current.delete(id);
        session.clearDecision(id);
        bump();
        await persist(
          clearedEdit ? { needsEditChanges: [{ assetId: id, needsEdit: false }] } : undefined,
        );
        return;
      }
      if (target === 'cull') {
        if (state === 'kept') {
          const clearedEdit = needsEditRef.current.delete(id);
          session.cullKept(id);
          bump();
          await persist(
            clearedEdit ? { needsEditChanges: [{ assetId: id, needsEdit: false }] } : undefined,
          );
          void hashInBackground(id);
        }
        return;
      }
      // keep / to_edit: align the app-side flag FIRST so any state write
      // lands as 'to_edit' vs 'kept' via the persistDecision/store CASE.
      const wantFlag = target === 'to_edit';
      let editChanged = false;
      if (needsEditRef.current.has(id) !== wantFlag) {
        editChanged = true;
        if (wantFlag) needsEditRef.current.add(id);
        else needsEditRef.current.delete(id);
      }
      if (state === 'culled') session.unstageCull(id); // culled → kept (+flag remap)
      bump();
      await persist(
        editChanged ? { needsEditChanges: [{ assetId: id, needsEdit: wantFlag }] } : undefined,
      );
    },
    [persist, bump, hashInBackground],
  );

  const confirmCulls = useCallback(async (): Promise<ConfirmResult> => {
    const session = sessionRef.current;
    if (!session || sessionId === null) throw new Error('confirmCulls: no active session');
    const staged = session.stagedCulls();
    if (staged.length === 0) {
      return { deleted: true, status: 'applied', count: 0, bytes: 0 };
    }

    // m0.7 item H (P7#4/P8#3/P8#4): the attempt is DURABLE before native
    // dispatch — batch + measured bytes + one reservation per photo — so a
    // process death anywhere leaves a recoverable record and ambiguous
    // absence can never claim credit. Bounded per OS request (P5#4).
    const batch = await prepareTrashBatch(
      db,
      staged.map((item) => ({ photoId: item.id, measuredBytes: fileSize(item.uri) })),
      sessionId,
      Date.now(),
    );
    if (!batch) return { deleted: true, status: 'applied', count: 0, bytes: 0 };

    await markBatchLaunching(db, batch.batchId, Date.now());
    const ids = batch.members.map((m) => m.photoId);
    const result = await trashAssets(ids);

    const resolved = await resolveTrashBatch(db, {
      batchId: batch.batchId,
      verify: async (photoId) => {
        const trashed = await isMediaTrashed(await getEditableContentUri(photoId));
        // Tri-state (C#1): a query failure is 'unknown', never 'absent'.
        if (trashed === true) return 'absent';
        if (trashed === false) return 'present';
        return 'unknown';
      },
      dialog:
        result.status === 'applied'
          ? 'applied'
          : result.status === 'cancelled'
            ? 'cancelled'
            : result.status === 'unsupported'
              ? 'unsupported'
              : 'failed',
      at: Date.now(),
    });

    // Mirror verified outcomes into the live core snapshot.
    const trashedIds = ids.filter(
      (id) =>
        resolved.outcomes[id] === 'trashed' ||
        resolved.outcomes[id] === 'absent_after_interrupted_launch',
    );
    if (trashedIds.length > 0) {
      const confirmed = session.confirmAll();
      session.markTrashed(confirmed.filter((id) => trashedIds.includes(id)));
      // Anything confirmed but not verified rolls back to culled.
      const snap = session.toJSON();
      for (const id of confirmed) {
        if (!trashedIds.includes(id)) snap.states[id] = 'culled';
      }
      sessionRef.current = DeckSession.fromJSON(snap);
      await persist();
      await addReclaimedBytes(db, sessionId, resolved.creditedBytes);
      setReclaimedBytes((b) => b + resolved.creditedBytes);
      bump();
      return {
        deleted: true,
        status: 'applied',
        count: trashedIds.length,
        bytes: resolved.creditedBytes,
      };
    }

    bump();
    return {
      deleted: false,
      status: result.status,
      error: result.status === 'failed' ? result.error : undefined,
      count: ids.length,
      bytes: 0,
    };
  }, [db, sessionId, persist, bump]);

  const finishSession = useCallback(async () => {
    await waitForPersistence();
    const session = sessionRef.current;
    if (sessionId === null) return;
    // Converge: keepers that don't need editing are done. Rows already
    // remapped to 'to_edit' are untouched (markKeptDone only hits 'kept').
    if (session) {
      const snap = session.toJSON();
      const keptIds = Object.entries(snap.states)
        .filter(([, state]) => state === 'kept')
        .map(([id]) => id);
      await markKeptDone(db, keptIds);
    }
    await completeSession(db, sessionId, Date.now());
    sessionRef.current = null;
    needsEditRef.current = new Set();
    favouriteRef.current = new Map();
    setSessionId(null);
    setLabel('');
    bump();
  }, [db, sessionId, bump, waitForPersistence]);

  const groups: GroupInfo[] = useMemo(() => {
    const session = sessionRef.current;
    if (!session) return [];
    return session.groupsInfo().map((g) => ({
      id: g.id,
      items: g.memberIds.map((id) => session.item(id)),
      complete: g.complete,
      bestId: g.bestId,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const singleIds: string[] = useMemo(() => {
    const session = sessionRef.current;
    return session ? [...session.singles] : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const editFlagCount = useMemo(
    () => needsEditRef.current.size,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  const value: SessionContextValue = useMemo(
    () => ({
      session: sessionRef.current,
      sessionId,
      label,
      reclaimedBytes,
      version,
      persistenceError,
      retryPersistence,
      groups,
      singleIds,
      startSession,
      resumeSession,
      discardActiveSession,
      deckSetCursor,
      deckCull,
      deckUndoCull,
      keepRest,
      markBest,
      makeSingle,
      recordCompare,
      compareCull,
      decideSingle,
      keepRemainingSingles,
      needsEdit,
      toggleNeedsEdit,
      editFlagCount,
      favouriteStatus,
      toggleFavourite,
      refreshFavouriteStates,
      unstageCull,
      redecide,
      confirmCulls,
      finishSession,
    }),
    [
      sessionId,
      label,
      reclaimedBytes,
      version,
      persistenceError,
      retryPersistence,
      groups,
      singleIds,
      startSession,
      resumeSession,
      discardActiveSession,
      deckSetCursor,
      deckCull,
      deckUndoCull,
      keepRest,
      markBest,
      makeSingle,
      recordCompare,
      compareCull,
      decideSingle,
      keepRemainingSingles,
      needsEdit,
      toggleNeedsEdit,
      editFlagCount,
      favouriteStatus,
      toggleFavourite,
      refreshFavouriteStates,
      unstageCull,
      redecide,
      confirmCulls,
      finishSession,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
