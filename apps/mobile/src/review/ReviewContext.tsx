/**
 * The m0.8 DB-backed review model (replaces session/SessionContext.tsx —
 * sessions are gone). SQLite is the ONLY review state: groups come from
 * the continuous grouping run (db/store.ts listReviewGroups), decisions
 * write `photos` directly through applyReviewDecisions in one awaited
 * transaction each (no snapshot, no persistence queue, no banking), and
 * every screen re-reads on the version bump. The deck cursor is DERIVED —
 * the first unreviewed member is "next"; screens keep any transient
 * browsing position locally.
 *
 * Verdicts (decision 2): keep = 'done' at swipe time; cull stages the
 * durable global cull queue; to-edit flags + queues; tapping the active
 * verdict clears back to 'unreviewed'. Un-staging a cull re-decide lands
 * on 'done'; CullList "Restore" lands on 'unreviewed'.
 *
 * Startup (once per process): recover interrupted trash/share batches
 * (the 0.7.1 crash-safety, rehomed from session resume), then start the
 * continuous scan. The provider refreshes on scan progress so the queue
 * fills as windows land.
 *
 * A failed decision write surfaces as `writeError` (loud alert in
 * App.tsx); the durable row is unchanged, so the user simply retries the
 * action.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import type { DuelRecord } from '@afterglow/core';
import { fileSize } from '../lib/hash';
import { runTrashAttempt } from '../lib/trashFlow';
import { recoverTrashBatches } from '../db/trashStore';
import { recoverShareBatches } from '../db/shareStore';
import { verifyTrashedTriState } from '../lib/media';
import { startContinuousScan, subscribeScanStatus } from '../scan/scanRunner';
import { nextFavouriteIntent, NO_FAVOURITE, type FavouriteStatus } from '../lib/favouriteState';
import {
  applyReviewDecisions,
  countReviewQueue,
  getFavouriteStates,
  getNeedsEditAssets,
  getStagedCulls,
  listReviewGroups,
  listSinglesFeed,
  getReviewGroup,
  makePhotoSingles,
  restoreCarriedCull,
  setGroupBest,
  unstageCullDirect,
  type ReviewGroupRow,
  type ReviewMemberRow,
  type ReviewVerdict,
} from '../db/store';

/** Review-queue page bounds (gate 5 refines browsing beyond these). */
const GROUP_PAGE = 100;
const SINGLES_PAGE = 500;

export type SingleReviewAction = 'keep' | 'cull' | 'to_edit';
export type RedecideTarget = 'keep' | 'cull' | 'to_edit';

export interface ConfirmResult {
  status: 'applied' | 'cancelled' | 'unsupported' | 'failed';
  error?: string;
  trashedCount: number;
  creditedBytes: number;
  remaining: number;
  unresolvedCount: number;
}

interface ReviewContextValue {
  /** Monotonic counter bumped after every mutation (memo deps). */
  version: number;
  /** Live review queue: groups with ≥ 1 unreviewed member, newest first. */
  groups: ReviewGroupRow[];
  /** Singles feed: unreviewed + staged culls (badged), newest first. */
  singles: ReviewMemberRow[];
  queueCounts: { grouped: number; singles: number };
  /** Re-read everything from the durable rows. */
  refresh: () => Promise<void>;
  /** Fetch ONE group by id, completion irrespective (gate 5 browse of a
   * finished group). Its members join the flag/favourite tracking so the
   * deck's toggles work outside the queue; null = gone (dissolved). */
  loadGroup: (groupId: number) => Promise<ReviewGroupRow | null>;
  /** A decision write failed — the row is unchanged; retry the action. */
  writeError: string | null;
  clearWriteError: () => void;
  /** Verdict writes (decision 2 semantics; 'keep' → done). */
  decide: (assetId: string, action: SingleReviewAction) => Promise<void>;
  /** Clear a photo's verdict back to unreviewed (active-chip tap). */
  clearDecision: (assetId: string) => Promise<void>;
  /** Finish a group: every remaining unreviewed member keeps (done). */
  keepRest: (groupId: number) => Promise<void>;
  markBest: (groupId: number, assetId: string | null) => Promise<void>;
  /** "Not related — review as single" (durable user ejection). */
  makeSingle: (assetId: string) => Promise<void>;
  /** Compare: winner is better, both stay (stars the best). */
  recordCompare: (groupId: number, winnerId: string, loserId: string) => Promise<void>;
  /** Compare: cull the loser (records history + stages the cull). */
  compareCull: (groupId: number, loserId: string, winnerId: string) => Promise<void>;
  needsEdit: (assetId: string) => boolean;
  toggleNeedsEdit: (assetId: string) => Promise<void>;
  favouriteStatus: (assetId: string) => FavouriteStatus;
  toggleFavourite: (assetId: string) => Promise<void>;
  refreshFavouriteStates: () => Promise<void>;
  /** Re-decide from the cull list: not-a-cull-after-all lands on done. */
  unstageCull: (assetId: string) => Promise<void>;
  /** CullList "Restore to unreviewed": back to the review pool. */
  restoreCull: (assetId: string) => Promise<void>;
  /** Keep every still-unreviewed single in one write. */
  keepAllSingles: () => Promise<void>;
  /** Re-decide a STAGED cull from the cull list: keep → done, to_edit →
   * queued, cull → no-op-stays-culled; keep/to_edit are explicit
   * un-staging decisions and resolve any pending copy match (C#12). */
  redecideStaged: (assetId: string, target: RedecideTarget) => Promise<void>;
  /**
   * THE one delete path (P4#1): loop the durable GLOBAL cull queue
   * through the trash-attempt lifecycle in bounded batches — one system
   * dialog each — until every row was attempted or the user declines.
   */
  confirmStagedCulls: () => Promise<ConfirmResult>;
}

const ReviewContext = createContext<ReviewContextValue | null>(null);

export function ReviewProvider({ children }: { children: React.ReactNode }) {
  const db = useSQLiteContext();
  const [version, setVersion] = useState(0);
  const [groups, setGroups] = useState<ReviewGroupRow[]>([]);
  const [singles, setSingles] = useState<ReviewMemberRow[]>([]);
  const [queueCounts, setQueueCounts] = useState({ grouped: 0, singles: 0 });
  const [writeError, setWriteError] = useState<string | null>(null);
  const needsEditRef = useRef<Set<string>>(new Set());
  const favouriteRef = useRef<Map<string, FavouriteStatus>>(new Map());
  /** Members of an out-of-queue group the deck browses (gate 5): refresh
   * keeps their flag/favourite entries alive alongside the queue's. */
  const extraIdsRef = useRef<string[]>([]);
  const startedRef = useRef(false);

  const refresh = useCallback(async () => {
    const [nextGroups, nextSingles, counts] = await Promise.all([
      listReviewGroups(db, GROUP_PAGE),
      listSinglesFeed(db, SINGLES_PAGE),
      countReviewQueue(db),
    ]);
    const ids = [
      ...nextGroups.flatMap((g) => g.members.map((m) => m.asset_id)),
      ...nextSingles.map((m) => m.asset_id),
      ...extraIdsRef.current,
    ];
    const [needsEdit, favourites] = await Promise.all([
      getNeedsEditAssets(db, ids),
      getFavouriteStates(db, ids),
    ]);
    needsEditRef.current = needsEdit;
    favouriteRef.current = favourites;
    setGroups(nextGroups);
    setSingles(nextSingles);
    setQueueCounts(counts);
    setVersion((v) => v + 1);
  }, [db]);

  const loadGroup = useCallback(
    async (groupId: number): Promise<ReviewGroupRow | null> => {
      const group = await getReviewGroup(db, groupId);
      extraIdsRef.current = group ? group.members.map((m) => m.asset_id) : [];
      if (group) {
        const ids = extraIdsRef.current;
        const [needsEdit, favourites] = await Promise.all([
          getNeedsEditAssets(db, ids),
          getFavouriteStates(db, ids),
        ]);
        for (const id of ids) {
          if (needsEdit.has(id)) needsEditRef.current.add(id);
          else needsEditRef.current.delete(id);
        }
        for (const [id, status] of favourites) favouriteRef.current.set(id, status);
      }
      return group;
    },
    [db],
  );

  // Startup, once per process: crash recovery (0.7.1 hardening, rehomed
  // from session resume) → continuous scan → initial queue.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      await Promise.all([
        recoverTrashBatches(db, verifyTrashedTriState, Date.now()),
        recoverShareBatches(db),
      ]).catch((error) => {
        // Recovery re-runs next launch; the durable lifecycle rows are
        // exactly the state it needs. Loud, once.
        console.warn('[review] startup recovery failed:', String(error));
      });
      await refresh().catch(() => {});
    })();
  }, [db, refresh]);

  // The queue fills as the scan lands windows; refresh on phase changes
  // and coarsely on window progress.
  useEffect(() => {
    let lastWindows = 0;
    let lastPhase = '';
    return subscribeScanStatus((status) => {
      const phaseChanged = status.phase !== lastPhase;
      const windowStep = status.windowsGrouped - lastWindows >= 25;
      if (phaseChanged || windowStep) {
        lastPhase = status.phase;
        lastWindows = status.windowsGrouped;
        void refresh().catch(() => {});
      }
    });
  }, [refresh]);

  /** Run a decision write; failures surface loudly, rows stay unchanged. */
  const write = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
        setWriteError(null);
      } catch (error) {
        setWriteError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        await refresh().catch(() => {});
      }
    },
    [refresh],
  );

  const decide = useCallback(
    (assetId: string, action: SingleReviewAction) =>
      write(async () => {
        const verdict: ReviewVerdict =
          action === 'keep' ? 'done' : action === 'cull' ? 'culled' : 'to_edit';
        await applyReviewDecisions(db, [[assetId, verdict]], Date.now());
      }),
    [db, write],
  );

  const clearDecision = useCallback(
    (assetId: string) =>
      write(async () => {
        await applyReviewDecisions(db, [[assetId, 'unreviewed']], Date.now());
      }),
    [db, write],
  );

  const keepRest = useCallback(
    (groupId: number) =>
      write(async () => {
        const group = groups.find((g) => g.groupId === groupId);
        if (!group) return;
        const changes = group.members
          .filter((m) => m.state === 'unreviewed')
          .map((m) => [m.asset_id, 'done'] as [string, ReviewVerdict]);
        if (changes.length > 0) await applyReviewDecisions(db, changes, Date.now());
      }),
    [db, groups, write],
  );

  const markBest = useCallback(
    (groupId: number, assetId: string | null) =>
      write(async () => {
        await setGroupBest(db, groupId, assetId);
      }),
    [db, write],
  );

  const makeSingle = useCallback(
    (assetId: string) =>
      write(async () => {
        await makePhotoSingles(db, [assetId]);
      }),
    [db, write],
  );

  const recordDuel = useCallback(
    async (groupId: number, winnerId: string, loserId: string, keptBoth: boolean) => {
      const duel: DuelRecord = {
        groupId: String(groupId),
        winnerId,
        loserId,
        keptBoth,
        at: Date.now(),
      };
      await applyReviewDecisions(db, keptBoth ? [] : [[loserId, 'culled']], duel.at, { duel });
      if (keptBoth) await setGroupBest(db, groupId, winnerId);
    },
    [db],
  );

  const recordCompare = useCallback(
    (groupId: number, winnerId: string, loserId: string) =>
      write(() => recordDuel(groupId, winnerId, loserId, true)),
    [recordDuel, write],
  );

  const compareCull = useCallback(
    (groupId: number, loserId: string, winnerId: string) =>
      write(() => recordDuel(groupId, winnerId, loserId, false)),
    [recordDuel, write],
  );

  const needsEdit = useCallback((assetId: string) => needsEditRef.current.has(assetId), []);

  const toggleNeedsEdit = useCallback(
    (assetId: string) =>
      write(async () => {
        const flag = !needsEditRef.current.has(assetId);
        await applyReviewDecisions(db, [], Date.now(), {
          needsEditChanges: [{ assetId, needsEdit: flag }],
        });
      }),
    [db, write],
  );

  const favouriteStatus = useCallback(
    (assetId: string) => favouriteRef.current.get(assetId) ?? NO_FAVOURITE,
    [],
  );

  const toggleFavourite = useCallback(
    (assetId: string) =>
      write(async () => {
        const current = favouriteRef.current.get(assetId) ?? NO_FAVOURITE;
        const intent = nextFavouriteIntent(assetId, current);
        await applyReviewDecisions(db, [], Date.now(), {
          favouriteChanges: [intent],
        });
      }),
    [db, write],
  );

  const refreshFavouriteStates = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const unstageCull = useCallback(
    (assetId: string) =>
      write(async () => {
        // Not-a-cull-after-all: the photo was reviewed — it lands on done
        // (to_edit when flagged); an explicit restore decision resolves
        // any pending copy match (C#12).
        await unstageCullDirect(db, assetId, Date.now(), true);
      }),
    [db, write],
  );

  const restoreCull = useCallback(
    (assetId: string) =>
      write(async () => {
        await restoreCarriedCull(db, assetId, Date.now());
      }),
    [db, write],
  );

  const redecideStaged = useCallback(
    (assetId: string, target: RedecideTarget) =>
      write(async () => {
        if (target === 'cull') return; // already staged
        const verdict: ReviewVerdict = target === 'keep' ? 'done' : 'to_edit';
        await applyReviewDecisions(db, [[assetId, verdict]], Date.now(), {
          resolveCopyMatchesFor: [assetId],
        });
      }),
    [db, write],
  );

  const keepAllSingles = useCallback(
    () =>
      write(async () => {
        const changes = singles
          .filter((m) => m.state === 'unreviewed')
          .map((m) => [m.asset_id, 'done'] as [string, ReviewVerdict]);
        if (changes.length > 0) await applyReviewDecisions(db, changes, Date.now());
      }),
    [db, singles, write],
  );

  const confirmStagedCulls = useCallback(async (): Promise<ConfirmResult> => {
    let trashedCount = 0;
    let creditedBytes = 0;
    let outcome: ConfirmResult['status'] = 'applied';
    let error: string | undefined;
    // m0.7 item H (P7#4/P8#3/P8#4): each attempt is DURABLE before native
    // dispatch (lib/trashFlow.ts). Batches are bounded per OS consent
    // request, so the GLOBAL queue loops — one dialog per batch — until
    // every non-excluded row was attempted or the user declines. Members
    // whose verification stayed inconclusive get ONE dialog per run.
    const unresolved = new Set<string>();
    const ambiguous = new Set<string>();
    for (;;) {
      const rows = (await getStagedCulls(db)).filter((row) => !unresolved.has(row.asset_id));
      if (rows.length === 0) break;
      const attempt = await runTrashAttempt(
        db,
        rows.map((row) => ({ photoId: row.asset_id, measuredBytes: fileSize(row.uri) })),
      );
      if (attempt.status === 'skipped') break; // every row held by a live attempt
      const gone = new Set(attempt.trashedIds);
      for (const id of attempt.attemptedIds) if (!gone.has(id)) unresolved.add(id);
      for (const id of attempt.unknownIds) ambiguous.add(id);
      outcome = attempt.status;
      error = attempt.error;
      trashedCount += attempt.trashedIds.length;
      creditedBytes += attempt.creditedBytes;
      if (attempt.status !== 'applied') break;
    }
    const remaining = (await getStagedCulls(db)).length;
    await refresh().catch(() => {});
    return {
      status: outcome,
      error,
      trashedCount,
      creditedBytes,
      remaining,
      unresolvedCount: ambiguous.size,
    };
  }, [db, refresh]);

  const clearWriteError = useCallback(() => setWriteError(null), []);

  const value: ReviewContextValue = {
    version,
    groups,
    singles,
    queueCounts,
    refresh,
    loadGroup,
    writeError,
    clearWriteError,
    decide,
    clearDecision,
    keepRest,
    markBest,
    makeSingle,
    recordCompare,
    compareCull,
    needsEdit,
    toggleNeedsEdit,
    favouriteStatus,
    toggleFavourite,
    refreshFavouriteStates,
    unstageCull,
    restoreCull,
    keepAllSingles,
    redecideStaged,
    confirmStagedCulls,
  };
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

export function useReview(): ReviewContextValue {
  const value = useContext(ReviewContext);
  if (!value) throw new Error('useReview outside ReviewProvider');
  return value;
}

// The scan starts from Home once media permission is granted (the
// provider mounts before permission resolves); re-exported so screens
// import one review surface.
export { startContinuousScan };
