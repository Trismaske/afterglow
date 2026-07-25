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
import { verifyTrashedTriState } from '../lib/media';
import { runTrashAttempt } from '../lib/trashFlow';
import { recoverTrashBatches } from '../db/trashStore';
import { recoverShareBatches } from '../db/shareStore';
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
  completeSession,
  replaceActiveSession,
  getActiveSession,
  getFavouriteStates,
  getNeedsEditAssets,
  getSetting,
  getPhotoUris,
  getStagedCulls,
  getStatesForAssets,
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
  /** Outcome of the LAST system dialog run (batches loop until done). */
  status: 'applied' | 'cancelled' | 'unsupported' | 'failed';
  error?: string;
  /** Verified photos moved to trash across all batches this run. */
  trashedCount: number;
  /** Verified bytes credited across all batches this run. */
  creditedBytes: number;
  /** Staged culls still in the global queue afterwards. */
  remaining: number;
  /** Members attempted this run whose verification stayed inconclusive —
   * still staged, and possibly already in system trash. */
  unresolvedCount: number;
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
  /** Await the FIFO persistence barrier: every queued decision write has
   * landed. Callers that READ persisted rows to plan a replacement (the
   * session loaders) must flush first, or a decision made moments ago —
   * e.g. a staged cull — could be re-drawn from its stale row. */
  flushPersistence: () => Promise<void>;
  /** Restore the persisted active session, if any. Returns true if resumed. */
  resumeSession: () => Promise<boolean>;
  /** True while resumeSession is in flight with no session loaded yet —
   * and it STAYS true after a transient (retryable) resume failure, until
   * an attempt settles authoritatively (resumed, or provably no active
   * session). Membership is UNKNOWN while true — screens with direct DB
   * state edits (state editor, carried-cull restore, queue applies, page
   * reconciliation) must gate on this, or a write could desync the
   * snapshot a retry then installs. */
  restoring: boolean;
  discardActiveSession: () => Promise<void>;
  // ------------------------------------------------------- deck actions
  /** Swipe: persistively move a group's deck cursor. */
  deckSetCursor: (groupId: string, index: number) => void;
  /** Cull the photo out of its deck onto the staged cull list. */
  deckCull: (id: string) => Promise<void>;
  /** m0.7 #19: Keep the CURRENT photo (deck advances past it). */
  keepOne: (id: string) => Promise<void>;
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
  /**
   * THE one delete path (P4#1): loop the durable GLOBAL cull queue through
   * the trash-attempt lifecycle in TRASH_BATCH_LIMIT batches — one system
   * dialog each — until every row was attempted or the user declines.
   * Members whose verification stays inconclusive get one dialog per run
   * (they stay staged but are excluded from later batches). Credits
   * reclaimed bytes and mirrors verified outcomes into the live snapshot
   * per batch.
   */
  confirmStagedCulls: () => Promise<ConfirmResult>;
  /** Mirror durably-trashed outcomes into the live snapshot — members in
   * ANY state converge (kept members leave their decks); no-op for
   * non-members. Used internally by the cull confirm, and externally by
   * the edited-copy cull and History's external-removal reconciliation. */
  reconcileTrashed: (ids: readonly string[]) => Promise<void>;
  /** Mirror organize-move URI repairs into the live snapshot — a moved
   * member's old file:// path would render nothing. No-op for
   * non-members; resume covers the crash window via durable photos.uri. */
  reconcileMovedUris: (moves: ReadonlyArray<{ photoId: string; uri: string }>) => Promise<void>;
  /** Mirror edits that converged to durable 'done' outside the session
   * screens (edit-queue mark-done, auto-detection) — drop the live
   * To-Edit flag so its stale active verdict can't later clear the photo
   * back to unreviewed and overwrite the durable done. No-op for
   * non-members; the durable row already moved (markEditDone). */
  reconcileEditsDone: (ids: readonly string[]) => void;
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

/**
 * Apply durably-verified trash outcomes to a deck snapshot: a member in
 * ANY state becomes trashed and leaves every deck (aliveIds + best
 * star). Kept members converge too — an app-side to_edit photo is core
 * 'kept', and the edited-copy cull or an external removal can trash it
 * outside the staged-cull flow. Shared by live reconciliation and
 * resume-time recovery. Returns true when anything changed.
 */
function applyTrashedToSnapshot(
  snap: {
    states: Record<string, PhotoState>;
    groups: { aliveIds: string[]; bestId: string | null; complete: boolean }[];
  },
  ids: readonly string[],
): boolean {
  let changed = false;
  for (const id of ids) {
    const state = snap.states[id];
    if (state !== undefined && state !== 'trashed') {
      snap.states[id] = 'trashed';
      for (const group of snap.groups) {
        group.aliveIds = group.aliveIds.filter((m) => m !== id);
        if (group.bestId === id) group.bestId = null;
        // An emptied deck completes its group (mirrors core
        // removeFromDeck) — otherwise the flow would keep selecting an
        // empty group and render a blank deck.
        if (group.aliveIds.length === 0) group.complete = true;
      }
      changed = true;
    }
  }
  return changed;
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
  /** The once-per-process startup recovery (trash attempts + share
   * batches); every resume awaits it. */
  const trashRecoveryRef = useRef<Promise<boolean> | null>(null);
  /** Consecutive recovery failures — escalates the start-session error
   * copy toward the platform escape hatch (Clear data) after 3. */
  const recoveryFailuresRef = useRef(0);
  const needsEditRef = useRef<Set<string>>(new Set());
  /** Ids whose edits converged to durable 'done' this process
   * (reconcileEditsDone) — subtracted when a resume assigns the
   * needs-edit set, so a restoration racing a mark-done cannot
   * resurrect the stale flag. Re-flagging (toggleNeedsEdit) removes
   * the id again. */
  const editsDoneRef = useRef<Set<string>>(new Set());
  const favouriteRef = useRef<Map<string, FavouriteStatus>>(new Map());
  const [sessionId, setSessionIdState] = useState<number | null>(null);
  /** True while resumeSession runs with no session loaded (see interface). */
  const [restoring, setRestoring] = useState(false);
  /** In-flight tracked resume attempts backing `restoring` (overlaps). */
  const restoringCountRef = useRef(0);
  /** Mirrors sessionId SYNCHRONOUSLY for async continuations that must
   * check the CURRENT session (a cull confirm finishing after a silent
   * replacement must not credit the new session's display stat) — a
   * passive effect would leave a stale id until React commits. */
  const sessionIdRef = useRef<number | null>(null);
  const setSessionId = useCallback((id: number | null) => {
    sessionIdRef.current = id;
    setSessionIdState(id);
  }, []);
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

  /**
   * Serializes the session-installing operations (resume, start,
   * discard): a resume that read the old durable rows must never
   * install its stale result over a replacement that committed while
   * it was reading, and vice versa. The chain always resolves, so one
   * failed operation cannot wedge later ones.
   */
  const sessionOpChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const serializeSessionOp = useCallback(<T,>(op: () => Promise<T>): Promise<T> => {
    const run = sessionOpChainRef.current.then(op, op);
    sessionOpChainRef.current = run.catch(() => undefined);
    return run;
  }, []);

  /**
   * Once per process, shared by resume AND start: recover interrupted
   * trash attempts (P8#3) and share batches (C#10). Returns false on a
   * transient failure — the once-guard clears so the next caller
   * retries. Installing ANY session before recovery succeeds would let
   * Home's session short-circuit skip every later retry, leaving stale
   * reservations blocked for the process lifetime.
   */
  const ensureStartupRecovery = useCallback(async (): Promise<boolean> => {
    if (!trashRecoveryRef.current) {
      trashRecoveryRef.current = Promise.allSettled([
        recoverTrashBatches(db, verifyTrashedTriState, Date.now()),
        recoverShareBatches(db),
      ]).then((results) => results.every((r) => r.status === 'fulfilled'));
    }
    const attempt = trashRecoveryRef.current;
    const ok = await attempt;
    if (ok) {
      recoveryFailuresRef.current = 0;
    } else {
      recoveryFailuresRef.current += 1;
      if (trashRecoveryRef.current === attempt) trashRecoveryRef.current = null;
    }
    return ok;
  }, [db]);

  const startSession = useCallback(
    async (
      newLabel: string,
      rangeStart: number,
      rangeEnd: number,
      photos: readonly LoadedPhoto[],
      onHashProgress?: (done: number, total: number) => void,
      // Serialized against resume/discard: a restore that read the old
      // rows must not install its result over this replacement.
    ) =>
      serializeSessionOp(async () => {
        await waitForPersistence();
        if (!(await ensureStartupRecovery())) {
          throw new Error(
            'Startup recovery has not completed yet — please try again.' +
              (recoveryFailuresRef.current >= 3
                ? " If this keeps happening, clearing Afterglow's app data in Android settings resets its bookkeeping — your photos are never touched."
                : ''),
          );
        }
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
          const threshold = parseSimilarityThreshold(
            await getSetting(db, SIMILARITY_THRESHOLD_KEY),
          );
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
        // Installing a replacement is authoritative — lower a membership
        // gate a retryably-failed resume may have left up (any queued
        // resume attempt finds this session and settles authoritatively).
        if (restoringCountRef.current === 0) setRestoring(false);
        bump();
      }),
    [
      db,
      bump,
      waitForPersistence,
      persistenceQueue,
      ensureStartupRecovery,
      setSessionId,
      serializeSessionOp,
    ],
  );

  /**
   * 'resumed' installed a session; 'none' is AUTHORITATIVE (no active row,
   * or a corrupt one was abandoned); 'retry' is a transient failure — an
   * active session may still exist unloaded, so the caller must keep the
   * membership gate (`restoring`) up for the next focus retry.
   */
  const resumeSessionInner = useCallback(async (): Promise<'resumed' | 'none' | 'retry'> => {
    await waitForPersistence();
    // Recovery gates BOTH resume and start (ensureStartupRecovery): a
    // transient failure aborts this resume retryably — restoring a
    // session anyway would make Home short-circuit every later focus
    // check, leaving stale rows blocked for the process lifetime.
    if (!(await ensureStartupRecovery())) return 'retry';
    let row;
    try {
      row = await getActiveSession(db);
    } catch {
      return 'retry';
    }
    if (!row) return 'none';

    // Abandonment is reserved for a CORRUPT/pre-deck snapshot — parse and
    // structural failures only. Transient SQLite I/O during reads or the
    // reconciliation write must never end the user's session: those paths
    // abort this resume (return false) and the next focus retries.
    let parsed: {
      states: Record<string, PhotoState>;
      groups: { aliveIds: string[]; bestId: string | null; complete: boolean }[];
      items: { id: string; uri: string }[];
    };
    try {
      // Bracket-era (m0.3.x) snapshots throw here and are abandoned —
      // deliberate upgrade behavior, see the module docs. A parseable
      // non-object (e.g. the literal null) is corruption too — it must
      // not reach the transient-I/O path below and retry forever.
      parsed = JSON.parse(row.snapshot) as typeof parsed;
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    } catch {
      await abandonActiveSessions(db, Date.now());
      return 'none';
    }

    // ANY crash window after resolveTrashBatch commits (recovery, or a
    // death between resolution and the snapshot write) can leave the
    // stored snapshot behind the durable photo rows — so reconcile EVERY
    // member against SQLite, the single source of truth, not just this
    // launch's recovery outcomes. Kept members count too: an app-side
    // to_edit photo is core 'kept' and the edited-copy cull or an
    // external removal can trash it outside the staged flow.
    let trashedNow: string[];
    let durableUris: Map<string, string>;
    let needsEditIds: Set<string>;
    let favourites: typeof favouriteRef.current;
    try {
      const memberIds = Object.entries(parsed.states ?? {})
        .filter(([, state]) => state !== 'trashed')
        .map(([id]) => id);
      const durable = memberIds.length > 0 ? await getStatesForAssets(db, memberIds) : new Map();
      trashedNow = memberIds.filter((id) => durable.get(id) === 'trashed');
      const allIds = Object.keys(parsed.states ?? {});
      durableUris = await getPhotoUris(db, allIds);
      needsEditIds = await getNeedsEditAssets(db, allIds);
      favourites = await getFavouriteStates(db, allIds);
    } catch {
      return 'retry'; // transient read failure — session untouched
    }

    let session: DeckSession;
    let reconciled = false;
    try {
      reconciled = trashedNow.length > 0 && applyTrashedToSnapshot(parsed, trashedNow);
      // Organize moves repair photos.uri (the durable truth) — a snapshot
      // still holding the pre-move path would render dead file:// URIs.
      for (const item of parsed.items ?? []) {
        const uri = durableUris.get(item.id);
        if (uri !== undefined && uri !== item.uri) {
          item.uri = uri;
          reconciled = true;
        }
      }
      session = DeckSession.fromJSON(parsed);
    } catch {
      // Corrupt or pre-deck snapshot: abandon rather than dead-ending.
      await abandonActiveSessions(db, Date.now());
      return 'none';
    }

    if (reconciled) {
      // The photo rows are already correct; only the stored snapshot
      // needs to catch up.
      try {
        await persistDecision(db, row.id, JSON.stringify(session.toJSON()), [], Date.now());
      } catch {
        return 'retry'; // transient write failure — retry next focus
      }
    }
    sessionRef.current = session;
    persistenceQueue.resetCommitted(statesOf(session));
    needsEditRef.current = new Set([...needsEditIds].filter((id) => !editsDoneRef.current.has(id)));
    favouriteRef.current = favourites;
    setSessionId(row.id);
    setLabel(row.label);
    setReclaimedBytes(row.reclaimed_bytes);
    bump();
    return 'resumed';
  }, [db, bump, waitForPersistence, persistenceQueue, ensureStartupRecovery, setSessionId]);

  const resumeSession = useCallback(async () => {
    // Membership is unknown until the restore settles; screens gate
    // their direct DB state edits on this flag. Counted, not boolean:
    // with overlapping (serialized) attempts, the first one's finally
    // must not un-gate the queued retry still waiting to run.
    const track = sessionRef.current === null;
    if (track) {
      restoringCountRef.current += 1;
      setRestoring(true);
    }
    // Fail-closed: only an AUTHORITATIVE outcome (resumed / no session /
    // abandoned) lowers the gate — after a transient failure an active
    // session may still exist unloaded, and direct DB edits acting on
    // "not a member" would desync the snapshot the retry then installs.
    let authoritative = false;
    try {
      return await serializeSessionOp(async () => {
        // A start/replacement that won the serialization already
        // installed a session — this queued restore has nothing to do.
        if (sessionRef.current) {
          authoritative = true;
          return true;
        }
        const outcome = await resumeSessionInner();
        authoritative = outcome !== 'retry';
        return outcome === 'resumed';
      });
    } finally {
      if (track) {
        restoringCountRef.current -= 1;
        if (restoringCountRef.current === 0 && authoritative) setRestoring(false);
      }
    }
  }, [resumeSessionInner, serializeSessionOp]);

  const discardActiveSession = useCallback(async () => {
    await serializeSessionOp(async () => {
      await waitForPersistence();
      await abandonActiveSessions(db, Date.now());
      sessionRef.current = null;
      needsEditRef.current = new Set();
      favouriteRef.current = new Map();
      setSessionId(null);
      setLabel('');
      setReclaimedBytes(0);
      // Abandoning every active session is authoritative — membership is
      // now known (nothing is loaded, nothing durable remains active).
      if (restoringCountRef.current === 0) setRestoring(false);
      bump();
    });
  }, [db, bump, waitForPersistence, setSessionId, serializeSessionOp]);

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

  const keepOne = useCallback(
    async (id: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('keepOne: no active session');
      keepUnreviewed(session, id); // group deck keep or single keep
      bump();
      await persist();
    },
    [persist, bump],
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
      // Core reports every id that left grouping — the ejected photo plus
      // the survivor when the group dissolved. The durable membership
      // update (photos.group_id + photo_group_assignments) rides the
      // persistence queue with the snapshot, so a failed write hits the
      // retry barrier instead of being silently lost.
      const removed = session.makeSingle(id);
      bump();
      await persist({ madeSingles: removed });
    },
    [persist, bump],
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
        editsDoneRef.current.delete(id); // an explicit re-flag outranks a past done
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
        editsDoneRef.current.delete(id); // an explicit re-flag outranks a past done
        if (session.getState(id) === 'unreviewed') keepUnreviewed(session, id);
      }
      bump();
      await persist({ needsEditChanges: [{ assetId: id, needsEdit: !flagged }] });
    },
    [persist, bump],
  );

  const reconcileEditsDone = useCallback(
    (ids: readonly string[]) => {
      // In-memory only: markEditDone already moved the durable row to
      // 'done' with needs_edit = 0, and resume re-derives the flag set
      // from SQLite — only the live set is behind. editsDoneRef guards
      // the resume path that read its set before the durable write.
      let changed = false;
      for (const id of ids) {
        editsDoneRef.current.add(id);
        if (needsEditRef.current.delete(id)) changed = true;
      }
      if (changed) bump();
    },
    [bump],
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
      // Restoring answers the copy prompt's question (see store C#12).
      await persist({ resolveCopyMatchesFor: [id] });
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
        // An explicit active-verdict tap REOPENS the photo — including one
        // whose edit already converged to durable 'done' (the universal
        // clear contract; re-culling an edited photo must stay possible).
        // Drop the tombstone so the reopened photo starts a fresh cycle.
        editsDoneRef.current.delete(id);
        session.clearDecision(id);
        bump();
        await persist({
          ...(clearedEdit && { needsEditChanges: [{ assetId: id, needsEdit: false }] }),
          // Clearing a cull restores the photo (see store C#12).
          ...(state === 'culled' && { resolveCopyMatchesFor: [id] }),
        });
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
        if (wantFlag) {
          needsEditRef.current.add(id);
          editsDoneRef.current.delete(id); // an explicit re-flag outranks a past done
        } else {
          needsEditRef.current.delete(id);
        }
      }
      const restored = state === 'culled';
      if (restored) session.unstageCull(id); // culled → kept (+flag remap)
      bump();
      await persist({
        ...(editChanged && { needsEditChanges: [{ assetId: id, needsEdit: wantFlag }] }),
        // Restoring answers the copy prompt's question (see store C#12).
        ...(restored && { resolveCopyMatchesFor: [id] }),
      });
    },
    [persist, bump, hashInBackground],
  );

  const reconcileTrashed = useCallback(
    async (ids: readonly string[]) => {
      const session = sessionRef.current;
      if (!session || ids.length === 0) return;
      // The DB cleanup already dropped needs_edit — the in-memory flag
      // must follow or editFlagCount/Summary keep counting the trashed
      // photo as queued for editing.
      let flagsChanged = false;
      for (const id of ids) if (needsEditRef.current.delete(id)) flagsChanged = true;
      const snap = session.toJSON();
      const snapshotChanged = applyTrashedToSnapshot(snap, ids);
      if (!snapshotChanged && !flagsChanged) return;
      if (snapshotChanged) sessionRef.current = DeckSession.fromJSON(snap);
      bump();
      if (snapshotChanged) await persist();
    },
    [bump, persist],
  );

  const reconcileMovedUris = useCallback(
    async (moves: ReadonlyArray<{ photoId: string; uri: string }>) => {
      const session = sessionRef.current;
      if (!session || moves.length === 0) return;
      const snap = session.toJSON();
      let changed = false;
      for (const move of moves) {
        const item = snap.items.find((i) => i.id === move.photoId);
        if (item && item.uri !== move.uri) {
          item.uri = move.uri;
          changed = true;
        }
      }
      if (!changed) return;
      sessionRef.current = DeckSession.fromJSON(snap);
      bump();
      await persist();
    },
    [bump, persist],
  );

  const confirmStagedCulls = useCallback(async (): Promise<ConfirmResult> => {
    // The session this confirmation was LAUNCHED from — a continuation
    // outliving a silent replacement must not touch the new session.
    const launchedFrom = sessionId;
    let trashedCount = 0;
    let creditedBytes = 0;
    let status: ConfirmResult['status'] = 'applied';
    let error: string | undefined;
    // m0.7 item H (P7#4/P8#3/P8#4): each attempt is DURABLE before native
    // dispatch (lib/trashFlow.ts). Batches are bounded per OS consent
    // request (P5#4), so the GLOBAL queue loops — one dialog per batch —
    // until every non-excluded row was attempted or the user declines.
    // Members whose verification stayed inconclusive this run: they keep
    // their staged row, but re-requesting the same URI in every later
    // batch would show the user repeated consent dialogs for photos that
    // may already be trashed — each unresolved member gets ONE dialog
    // per run.
    const unresolved = new Set<string>();
    // Genuinely UNKNOWN verifications only (possibly already in system
    // trash) — cancelled/still-present members are excluded from later
    // batches too, but they are known untouched and must not scare the
    // user in the cancellation message.
    const ambiguous = new Set<string>();
    for (;;) {
      const rows = (await getStagedCulls(db)).filter((row) => !unresolved.has(row.asset_id));
      if (rows.length === 0) break;
      const attempt = await runTrashAttempt(
        db,
        rows.map((row) => ({ photoId: row.asset_id, measuredBytes: fileSize(row.uri) })),
        launchedFrom,
      );
      if (attempt.status === 'skipped') break; // every row held by a live attempt
      const gone = new Set(attempt.trashedIds);
      for (const id of attempt.attemptedIds) if (!gone.has(id)) unresolved.add(id);
      for (const id of attempt.unknownIds) ambiguous.add(id);
      status = attempt.status;
      error = attempt.error;
      trashedCount += attempt.trashedIds.length;
      creditedBytes += attempt.creditedBytes;
      // The durable session aggregate credited ATOMICALLY with the batch
      // outcomes (resolveTrashBatch); the in-memory display mirrors here
      // ONLY while the launching session is still the active one.
      if (
        attempt.creditedBytes > 0 &&
        launchedFrom !== null &&
        sessionIdRef.current === launchedFrom
      ) {
        setReclaimedBytes((b) => b + attempt.creditedBytes);
      }
      // Mirror verified outcomes into the live core snapshot (P4#1).
      await reconcileTrashed(attempt.trashedIds);
      // Only a declined/failed dialog stops the run — an all-unresolved
      // batch must NOT: its members are now excluded, so the next
      // iteration reaches the rows behind them (the unresolved filter
      // shrinks the candidate set every iteration, so the loop always
      // terminates).
      if (attempt.status !== 'applied') break;
    }
    const remaining = (await getStagedCulls(db)).length;
    bump();
    return {
      status,
      error,
      trashedCount,
      creditedBytes,
      remaining,
      unresolvedCount: ambiguous.size,
    };
  }, [db, sessionId, reconcileTrashed, bump]);

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
  }, [db, sessionId, bump, waitForPersistence, setSessionId]);

  // Durably trashed members (verified edited-copy cull, external
  // removal) stay in the snapshot for statistics but leave every DISPLAY
  // surface — dead URIs with un-actionable controls must not render on
  // Groups cards, counts, or decks.
  const groups: GroupInfo[] = useMemo(() => {
    const session = sessionRef.current;
    if (!session) return [];
    return session.groupsInfo().map((g) => ({
      id: g.id,
      items: g.memberIds
        .filter((id) => session.getState(id) !== 'trashed')
        .map((id) => session.item(id)),
      complete: g.complete,
      bestId: g.bestId,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const singleIds: string[] = useMemo(() => {
    const session = sessionRef.current;
    if (!session) return [];
    return session.singles.filter((id) => session.getState(id) !== 'trashed');
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
      flushPersistence: waitForPersistence,
      resumeSession,
      restoring,
      discardActiveSession,
      deckSetCursor,
      deckCull,
      keepOne,
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
      confirmStagedCulls,
      reconcileTrashed,
      reconcileMovedUris,
      reconcileEditsDone,
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
      waitForPersistence,
      resumeSession,
      restoring,
      discardActiveSession,
      deckSetCursor,
      deckCull,
      keepOne,
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
      confirmStagedCulls,
      reconcileTrashed,
      reconcileMovedUris,
      reconcileEditsDone,
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
