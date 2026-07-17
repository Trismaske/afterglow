/**
 * Holds the live core CullSession, mirrors every mutation into SQLite
 * (snapshot + changed photo states + duel records), and exposes the review
 * actions to the screens.
 *
 * All bracket/staging logic lives in @afterglow/core — this file only
 * adapts it to React and persistence. The m0.2 additions (needs-edit flags,
 * kept → done convergence) are app-side state layered over the core
 * session: core only knows kept/culled; SQLite is the source of truth for
 * to_edit/done (PLAN.md).
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
  CullSession,
  clusterByGap,
  MOMENTS_GAP_MS,
  type Cluster,
  type DuelDecision,
  type MediaItem,
  type PhotoState,
} from '@afterglow/core';
import type { LoadedPhoto } from '../lib/media';
import { deleteAssets } from '../lib/media';
import { fileSize, sha256OfFile } from '../lib/hash';
import { dayKey } from '../lib/dates';
import {
  abandonActiveSessions,
  addReclaimedBytes,
  completeSession,
  createSession,
  getActiveSession,
  getNeedsEditAssets,
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
  session: CullSession | null;
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
  ) => Promise<void>;
  /** Restore the persisted active session, if any. Returns true if resumed. */
  resumeSession: () => Promise<boolean>;
  discardActiveSession: () => Promise<void>;
  decideDuel: (decision: DuelDecision) => Promise<void>;
  decideSingle: (id: string, action: SingleReviewAction) => Promise<void>;
  /** Whether a photo carries the "keeper needs editing" flag. */
  needsEdit: (id: string) => boolean;
  /** Flip the needs-edit flag (persisted immediately; state remaps if kept). */
  toggleNeedsEdit: (id: string) => Promise<void>;
  /** How many photos in this session are flagged for editing. */
  editFlagCount: number;
  unstageCull: (id: string) => Promise<void>;
  /** THE one delete path: confirm staged culls → system dialog → trash. */
  confirmCulls: () => Promise<ConfirmResult>;
  /** Finish: remaining keepers converge to done; to_edit stays queued. */
  finishSession: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function statesOf(session: CullSession): Map<string, PhotoState> {
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
  const sessionRef = useRef<CullSession | null>(null);
  const lastStatesRef = useRef<Map<string, PhotoState>>(new Map());
  const groupItemsRef = useRef<{ id: string; items: MediaItem[] }[]>([]);
  const singleIdsRef = useRef<string[]>([]);
  const needsEditRef = useRef<Set<string>>(new Set());
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [reclaimedBytes, setReclaimedBytes] = useState(0);
  const [version, setVersion] = useState(0);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  /** Rebuild group/single navigation info from a (re)loaded session. */
  const indexSession = useCallback((session: CullSession) => {
    const snap = session.toJSON();
    const byId = new Map(snap.items.map((i) => [i.id, i]));
    groupItemsRef.current = snap.brackets.map((b) => ({
      id: b.groupId,
      items: b.photoIds.map((id) => byId.get(id)!),
    }));
    singleIdsRef.current = [...snap.singleIds];
    lastStatesRef.current = statesOf(session);
  }, []);

  /** Persist a mutation the session just performed. */
  const persist = useCallback(
    async (duel?: Parameters<typeof persistDecision>[4]) => {
      const session = sessionRef.current;
      if (!session || sessionId === null) return;
      const after = statesOf(session);
      const changes = changedStates(lastStatesRef.current, after);
      lastStatesRef.current = after;
      await persistDecision(db, sessionId, JSON.stringify(session.toJSON()), changes, duel);
    },
    [db, sessionId],
  );

  const startSession = useCallback(
    async (
      newLabel: string,
      rangeStart: number,
      rangeEnd: number,
      photos: readonly LoadedPhoto[],
    ) => {
      const clusters: Cluster[] = clusterByGap(
        photos.map((p) => p.item),
        { gapMs: CULL_GROUP_GAP_MS },
      );
      const groups = clusters.filter((c) => c.items.length >= 2);
      const singles = clusters.filter((c) => c.items.length === 1).map((c) => c.items[0]);
      const session = CullSession.create({ groups, singles });

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
      indexSession(session);
      needsEditRef.current = new Set();
      setSessionId(id);
      setLabel(newLabel);
      setReclaimedBytes(0);
      bump();
    },
    [db, indexSession, bump],
  );

  const resumeSession = useCallback(async () => {
    const row = await getActiveSession(db);
    if (!row) return false;
    try {
      const session = CullSession.fromJSON(JSON.parse(row.snapshot));
      sessionRef.current = session;
      indexSession(session);
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
      // Corrupt snapshot: abandon it rather than dead-ending the app.
      await abandonActiveSessions(db, Date.now());
      return false;
    }
  }, [db, indexSession, bump]);

  const discardActiveSession = useCallback(async () => {
    await abandonActiveSessions(db, Date.now());
    sessionRef.current = null;
    needsEditRef.current = new Set();
    setSessionId(null);
    setLabel('');
    setReclaimedBytes(0);
    bump();
  }, [db, bump]);

  const decideDuel = useCallback(
    async (decision: DuelDecision) => {
      const session = sessionRef.current;
      if (!session) throw new Error('decideDuel: no active session');
      const record = session.decideDuel(decision, Date.now());
      bump();
      await persist(record);
      if (!record.keptBoth) void hashInBackground(record.loserId);
    },
    [persist, bump],
  );

  const decideSingle = useCallback(
    async (id: string, action: SingleReviewAction) => {
      const session = sessionRef.current;
      if (!session) throw new Error('decideSingle: no active session');
      if (action === 'to_edit') {
        // Core only knows keep/cull — the edit flag is app-side state.
        // Set the flag BEFORE persisting so the state write lands as
        // 'to_edit' (see persistDecision's CASE).
        await setNeedsEdit(db, id, true);
        needsEditRef.current.add(id);
        session.decideSingle(id, 'keep');
      } else {
        session.decideSingle(id, action);
      }
      bump();
      await persist();
      if (action === 'cull') void hashInBackground(id);
    },
    [db, persist, bump],
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
      await setNeedsEdit(db, id, !flagged);
    },
    [db, bump],
  );

  /** Content-hash fallback identity, computed only for staged culls. */
  const hashInBackground = useCallback(
    async (assetId: string) => {
      const session = sessionRef.current;
      if (!session) return;
      const item = session
        .toJSON()
        .items.find((i) => i.id === assetId);
      if (!item) return;
      const hash = await sha256OfFile(item.uri);
      if (hash) await setContentHash(db, assetId, hash).catch(() => {});
    },
    [db],
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
    const restored = CullSession.fromJSON(snap);
    sessionRef.current = restored;
    indexSession(restored);
    bump();
    await persistDecision(db, sessionId, JSON.stringify(restored.toJSON()),
      ids.map((id) => [id, 'culled'] as [string, PhotoState]));
    lastStatesRef.current = statesOf(restored);
    return { deleted: false, count: ids.length, bytes };
  }, [db, sessionId, persist, indexSession, bump]);

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
    bump();
  }, [db, sessionId, bump]);

  const groups: GroupInfo[] = useMemo(() => {
    const session = sessionRef.current;
    if (!session) return [];
    return groupItemsRef.current.map((g) => ({
      id: g.id,
      items: g.items,
      complete: session.isGroupComplete(g.id),
      bestId: session.groupBest(g.id)?.id ?? null,
    }));
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
      singleIds: singleIdsRef.current,
      startSession,
      resumeSession,
      discardActiveSession,
      decideDuel,
      decideSingle,
      needsEdit,
      toggleNeedsEdit,
      editFlagCount,
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
      startSession,
      resumeSession,
      discardActiveSession,
      decideDuel,
      decideSingle,
      needsEdit,
      toggleNeedsEdit,
      editFlagCount,
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
