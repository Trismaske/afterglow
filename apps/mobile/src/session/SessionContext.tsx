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
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import {
  DeckSession,
  clusterByGap,
  MOMENTS_GAP_MS,
  refineClustersBySimilarity,
  type Cluster,
  type MediaItem,
  type PhotoState,
} from '@afterglow/core';
import type { LoadedPhoto } from '../lib/media';
import { deleteAssets } from '../lib/media';
import { fileSize, sha256OfFile } from '../lib/hash';
import { dayKey } from '../lib/dates';
import { ensureDhashes } from '../lib/similarityHashes';
import { parseSimilarityThreshold, SIMILARITY_THRESHOLD_KEY } from '../lib/similarityPrefs';
import {
  abandonActiveSessions,
  addReclaimedBytes,
  clearPhotoGroup,
  completeSession,
  createSession,
  getActiveSession,
  getNeedsEditAssets,
  getSetting,
  markKeptDone,
  persistDecision,
  setContentHash,
  setNeedsEdit,
} from '../db/store';

/** Gap that makes shots "the same moment" → one cull group. */
export const CULL_GROUP_GAP_MS = MOMENTS_GAP_MS; // 3 minutes

/** m0.2 single-review actions ('to_edit' = keep + flag for the edit queue). */
export type SingleReviewAction = 'keep' | 'cull' | 'to_edit';

export interface GroupInfo {
  id: string;
  /** Current members (photos moved out via "not related" have left). */
  items: MediaItem[];
  complete: boolean;
  bestId: string | null;
}

export interface ConfirmResult {
  /** True if the batch was deleted (or there was nothing to delete). */
  deleted: boolean;
  count: number;
  bytes: number;
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
  /** Whether a photo carries the "keeper needs editing" flag. */
  needsEdit: (id: string) => boolean;
  /** Flip the needs-edit flag (persisted immediately; state remaps if kept). */
  toggleNeedsEdit: (id: string) => Promise<void>;
  /** How many photos in this session are flagged for editing. */
  editFlagCount: number;
  /**
   * Group that just completed with reconsider candidates (kept losers of
   * explicit compares) — the Deck screen routes to the Reconsider screen
   * when set. In-memory only: lost on app restart (the hint is
   * opportunistic).
   */
  pendingReconsider: string | null;
  clearPendingReconsider: () => void;
  /**
   * Second-pass cull from the Reconsider screen: a kept photo goes to the
   * staged cull list (core cullKept — the deck model supports kept→culled
   * directly; no snapshot rewrite needed anymore). Not a compare — no
   * duel record is written.
   */
  reconsiderCull: (id: string) => Promise<void>;
  unstageCull: (id: string) => Promise<void>;
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

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const db = useSQLiteContext();
  const sessionRef = useRef<DeckSession | null>(null);
  const lastStatesRef = useRef<Map<string, PhotoState>>(new Map());
  const needsEditRef = useRef<Set<string>>(new Set());
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [reclaimedBytes, setReclaimedBytes] = useState(0);
  const [version, setVersion] = useState(0);
  const [pendingReconsider, setPendingReconsider] = useState<string | null>(null);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  /** Persist a mutation the session just performed. */
  const persist = useCallback(
    async (duel?: Parameters<typeof persistDecision>[5]) => {
      const session = sessionRef.current;
      if (!session || sessionId === null) return;
      const after = statesOf(session);
      const changes = changedStates(lastStatesRef.current, after);
      lastStatesRef.current = after;
      await persistDecision(
        db,
        sessionId,
        JSON.stringify(session.toJSON()),
        changes,
        Date.now(),
        duel,
      );
    },
    [db, sessionId],
  );

  const startSession = useCallback(
    async (
      newLabel: string,
      rangeStart: number,
      rangeEnd: number,
      photos: readonly LoadedPhoto[],
      onHashProgress?: (done: number, total: number) => void,
    ) => {
      const clusters: Cluster[] = clusterByGap(
        photos.map((p) => p.item),
        { gapMs: CULL_GROUP_GAP_MS },
      );
      // m0.4: time clusters are refined by perceptual similarity (dHash)
      // so visually unrelated quick-succession shots don't share a group.
      // Hashes are computed lazily — only for photos inside multi-photo
      // time clusters — and cached in SQLite (similarityHashes.ts).
      const timeGroups = clusters.filter((c) => c.items.length >= 2);
      const photoById = new Map(photos.map((p) => [p.item.id, p]));
      const { hashes } = await ensureDhashes(
        db,
        timeGroups.flatMap((c) => c.items).map((i) => photoById.get(i.id)!),
        onHashProgress,
      );
      const threshold = parseSimilarityThreshold(
        await getSetting(db, SIMILARITY_THRESHOLD_KEY),
      );
      const refined = refineClustersBySimilarity(
        timeGroups,
        (id) => hashes.get(id) ?? null,
        threshold,
      );
      const groups = refined.filter((c) => c.items.length >= 2);
      // Singleton components join the singles bucket, chronological order.
      const singles = [
        ...clusters.filter((c) => c.items.length === 1),
        ...refined.filter((c) => c.items.length === 1),
      ]
        .map((c) => c.items[0])
        .sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const session = DeckSession.create({ groups, singles });

      const groupIdByAsset = new Map<string, string>();
      for (const g of groups) for (const item of g.items) groupIdByAsset.set(item.id, g.id);

      await abandonActiveSessions(db, Date.now());
      const id = await createSession(db, {
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
      });

      sessionRef.current = session;
      lastStatesRef.current = statesOf(session);
      needsEditRef.current = new Set();
      setSessionId(id);
      setLabel(newLabel);
      setReclaimedBytes(0);
      setPendingReconsider(null);
      bump();
    },
    [db, bump],
  );

  const resumeSession = useCallback(async () => {
    const row = await getActiveSession(db);
    if (!row) return false;
    try {
      // Bracket-era (m0.3.x) snapshots throw here and are abandoned —
      // deliberate upgrade behavior, see the module docs.
      const session = DeckSession.fromJSON(JSON.parse(row.snapshot));
      sessionRef.current = session;
      lastStatesRef.current = statesOf(session);
      needsEditRef.current = await getNeedsEditAssets(
        db,
        session.toJSON().items.map((i) => i.id),
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
  }, [db, bump]);

  const discardActiveSession = useCallback(async () => {
    await abandonActiveSessions(db, Date.now());
    sessionRef.current = null;
    needsEditRef.current = new Set();
    setSessionId(null);
    setLabel('');
    setReclaimedBytes(0);
    setPendingReconsider(null);
    bump();
  }, [db, bump]);

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

  /**
   * A group just completed — queue the reconsider hint if any kept photo
   * lost an explicit compare (m0.4 rule; photos the user flagged
   * needs-edit are exempt — they explicitly want those). A group finished
   * with zero compares never prompts.
   */
  const maybeQueueReconsider = useCallback((groupId: string) => {
    const session = sessionRef.current;
    if (!session || !session.isGroupComplete(groupId)) return;
    const candidates = session
      .reconsiderCandidates(groupId)
      .filter((item) => !needsEditRef.current.has(item.id));
    if (candidates.length > 0) setPendingReconsider(groupId);
  }, []);

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
      const groupId = session.groupsInfo().find((g) => g.aliveIds.includes(id))?.id;
      session.cull(id); // throws if the id is not in a live deck
      if (groupId) maybeQueueReconsider(groupId);
      bump();
      await persist();
      void hashInBackground(id);
    },
    [persist, bump, maybeQueueReconsider, hashInBackground],
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
      maybeQueueReconsider(groupId);
      bump();
      await persist();
    },
    [persist, bump, maybeQueueReconsider],
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
      const groupId = session.groupsInfo().find((g) => g.aliveIds.includes(id))?.id;
      session.makeSingle(id);
      if (groupId) maybeQueueReconsider(groupId);
      bump();
      await persist();
      // The photo is no longer "in a group" for day-progress accounting.
      await clearPhotoGroup(db, id).catch(() => {});
    },
    [db, persist, bump, maybeQueueReconsider],
  );

  const recordCompare = useCallback(
    async (winnerId: string, loserId: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('recordCompare: no active session');
      const record = session.recordCompare(winnerId, loserId, true, Date.now());
      bump();
      await persist(record);
    },
    [persist, bump],
  );

  const compareCull = useCallback(
    async (loserId: string, winnerId: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('compareCull: no active session');
      const record = session.recordCompare(winnerId, loserId, false, Date.now());
      const groupId = record.groupId;
      session.cull(loserId);
      maybeQueueReconsider(groupId);
      bump();
      await persist(record);
      void hashInBackground(loserId);
    },
    [persist, bump, maybeQueueReconsider, hashInBackground],
  );

  const clearPendingReconsider = useCallback(() => setPendingReconsider(null), []);

  const reconsiderCull = useCallback(
    async (id: string) => {
      const session = sessionRef.current;
      if (!session) throw new Error('reconsiderCull: no active session');
      if (session.getState(id) !== 'kept') return; // already culled/edited — nothing to do
      session.cullKept(id);
      bump();
      await persist();
      void hashInBackground(id);
    },
    [persist, bump, hashInBackground],
  );

  const decideSingle = useCallback(
    async (id: string, action: SingleReviewAction) => {
      const session = sessionRef.current;
      if (!session) throw new Error('decideSingle: no active session');
      if (action === 'to_edit') {
        // Core only knows keep/cull — the edit flag is app-side state.
        // Set the flag BEFORE persisting so the state write lands as
        // 'to_edit' (see persistDecision's CASE).
        await setNeedsEdit(db, id, true, Date.now());
        needsEditRef.current.add(id);
        session.decideSingle(id, 'keep');
      } else {
        session.decideSingle(id, action);
      }
      bump();
      await persist();
      if (action === 'cull') void hashInBackground(id);
    },
    [db, persist, bump, hashInBackground],
  );

  const needsEdit = useCallback(
    (id: string) => needsEditRef.current.has(id),
    // needsEditRef is a ref; version ties re-renders to mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  const toggleNeedsEdit = useCallback(
    async (id: string) => {
      const flagged = needsEditRef.current.has(id);
      if (flagged) needsEditRef.current.delete(id);
      else needsEditRef.current.add(id);
      bump();
      // setNeedsEdit also remaps an already-kept row to to_edit (and back).
      await setNeedsEdit(db, id, !flagged, Date.now());
    },
    [db, bump],
  );

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

  const confirmCulls = useCallback(async (): Promise<ConfirmResult> => {
    const session = sessionRef.current;
    if (!session || sessionId === null) throw new Error('confirmCulls: no active session');
    const staged = session.stagedCulls();
    if (staged.length === 0) return { deleted: true, count: 0, bytes: 0 };

    // Approximate storage reclaimed, measured before the files disappear.
    let bytes = 0;
    for (const item of staged) bytes += fileSize(item.uri);

    // Flip to `confirmed` in memory only — SQLite keeps `culled` until the
    // system delete actually succeeds, so an app death mid-dialog resumes
    // with the batch still staged (and nothing silently lost).
    const ids = session.confirmAll();

    const deleted = await deleteAssets(ids);
    if (deleted) {
      session.markTrashed(ids);
      await persist();
      await addReclaimedBytes(db, sessionId, bytes);
      setReclaimedBytes((b) => b + bytes);
      bump();
      return { deleted: true, count: ids.length, bytes };
    }

    // User cancelled the system dialog: roll `confirmed` back to `culled`
    // by rewriting the snapshot (core has no un-confirm — deliberate; the
    // snapshot format is the supported escape hatch).
    const snap = session.toJSON();
    for (const id of ids) snap.states[id] = 'culled';
    const restored = DeckSession.fromJSON(snap);
    sessionRef.current = restored;
    bump();
    await persistDecision(db, sessionId, JSON.stringify(restored.toJSON()),
      ids.map((id) => [id, 'culled'] as [string, PhotoState]), Date.now());
    lastStatesRef.current = statesOf(restored);
    return { deleted: false, count: ids.length, bytes };
  }, [db, sessionId, persist, bump]);

  const finishSession = useCallback(async () => {
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
    setSessionId(null);
    setLabel('');
    setPendingReconsider(null);
    bump();
  }, [db, sessionId, bump]);

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
      needsEdit,
      toggleNeedsEdit,
      editFlagCount,
      pendingReconsider,
      clearPendingReconsider,
      reconsiderCull,
      unstageCull,
      confirmCulls,
      finishSession,
    }),
    [
      sessionId,
      label,
      reclaimedBytes,
      version,
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
      needsEdit,
      toggleNeedsEdit,
      editFlagCount,
      pendingReconsider,
      clearPendingReconsider,
      reconsiderCull,
      unstageCull,
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
