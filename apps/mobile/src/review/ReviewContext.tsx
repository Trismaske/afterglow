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
import { resolveSources } from '../lib/sourceCatalog';
import { withUserWritePriority } from '../lib/writePriority';
import { startContinuousScan, subscribeScanStatus } from '../scan/scanRunner';
import { nextFavouriteIntent, NO_FAVOURITE, type FavouriteStatus } from '../lib/favouriteState';
import {
  applyReviewDecisions,
  readReviewQueue,
  getFavouriteStates,
  getNeedsEditAssets,
  getStagedCulls,
  getReviewGroup,
  applyRedecision,
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
  /** STRICT scoped refresh: reads under the GIVEN roots, no resolution,
   * no fallback — rejections propagate. The settings apply paths use it
   * so a silent fail-open can never leave an old scope actionable. */
  refreshScoped: (roots: readonly string[] | null) => Promise<void>;
  /** Fetch ONE group by id, completion irrespective (gate 5 browse of a
   * finished group). Its members join the flag/favourite tracking so the
   * deck's toggles work outside the queue; null = gone (dissolved). */
  loadGroup: (groupId: number) => Promise<ReviewGroupRow | null>;
  /** A decision write failed — the row is unchanged; retry the action. */
  writeError: string | null;
  clearWriteError: () => void;
  /** Verdict writes (decision 2 semantics; 'keep' → done). The optional
   * expected assignment (group id, or null for a single) is validated in
   * the transaction — a scan reassignment between render and tap must
   * reject rather than freeze a group the user never reviewed;
   * `undefined` skips the check (callers without a rendered context). */
  decide: (
    assetId: string,
    action: SingleReviewAction,
    expectedGroupId?: number | null,
  ) => Promise<void>;
  /** Clear a photo's verdict back to unreviewed (active-chip tap). */
  clearDecision: (assetId: string) => Promise<void>;
  /** State-aware change of mind on a DECIDED photo (gate 5 browse):
   * keep clears the edit flag; to_edit starts a fresh cycle; both
   * resolve pending copy matches. */
  redecideDecided: (assetId: string, target: 'keep' | 'to_edit') => Promise<void>;
  /** Finish a group: every remaining unreviewed member keeps (done). */
  keepRest: (groupId: number) => Promise<void>;
  markBest: (groupId: number, assetId: string | null) => Promise<void>;
  /** "Not related — review as single" (durable user ejection). The
   * displayed group id is validated in the transaction — a background
   * rescan may have rebuilt the group since render. */
  makeSingle: (assetId: string, expectedGroupId: number) => Promise<void>;
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
   * queued, cull (the active chip) → restore to unreviewed; keep/to_edit
   * are explicit un-staging decisions and resolve any pending copy match
   * (C#12) — a restore answers nothing and resolves nothing. */
  redecideStaged: (assetId: string, target: RedecideTarget) => Promise<void>;
  /**
   * THE one delete path (P4#1): loop the durable GLOBAL cull queue
   * through the trash-attempt lifecycle in bounded batches — one system
   * dialog each — until every row was attempted or the user declines.
   */
  confirmStagedCulls: () => Promise<ConfirmResult>;
}

/** Barrier for one not-yet-started refresh pass: handed to every
 * refresh() caller before the pass exists, settled when that pass
 * completes. Fire-and-forget callers may drop the promise, so
 * rejections are pre-marked handled — awaiting callers still see them. */
interface PassBarrier {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function makePassBarrier(): PassBarrier {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
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
  /** Last successfully resolved source roots (fail-closed fallback). */
  const lastRootsRef = useRef<{ roots: readonly string[] | null } | null>(null);
  /** Monotonic refresh token: only the LATEST refresh may commit — a
   * scan-status refresh overlapping a decision's refresh must not
   * overwrite the queue/refs with its older reads. */
  const refreshGenRef = useRef(0);
  /** Single-flight refresh chain (+ coalesced-rerun flag): at most ONE
   * general refresh pass runs at a time. Concurrent passes during a scan
   * used to supersede one another's generations perpetually — a
   * device-observed LIVELOCK that kept the queue empty for a whole
   * multi-thousand-photo rescan. */
  const refreshTailRef = useRef<Promise<void> | null>(null);
  const refreshAgainRef = useRef(false);
  /** Barrier for the NEXT pass to start — swapped fresh as each pass
   * begins, so a request always awaits a pass started at/after it and
   * never global quiescence (starvation-proof under sustained
   * scan-status requests). */
  const nextPassRef = useRef<PassBarrier | null>(null);
  /** Held by refreshScoped for exclusivity: the chain exits at its next
   * pass boundary and refresh() queues instead of starting a chain. */
  const chainPauseRef = useRef(false);
  const startedRef = useRef(false);

  const commitRefresh = useCallback(
    async (read: {
      nextGroups: ReviewGroupRow[];
      nextSingles: ReviewMemberRow[];
      counts: { grouped: number; singles: number };
      generation: number;
    }) => {
      const { nextGroups, nextSingles, counts, generation } = read;
      const ids = [
        ...nextGroups.flatMap((g) => g.members.map((m) => m.asset_id)),
        ...nextSingles.map((m) => m.asset_id),
        ...extraIdsRef.current,
      ];
      const [needsEdit, favourites] = await Promise.all([
        getNeedsEditAssets(db, ids),
        getFavouriteStates(db, ids),
      ]);
      if (generation !== refreshGenRef.current) return; // superseded mid-read
      needsEditRef.current = needsEdit;
      favouriteRef.current = favourites;
      setGroups(nextGroups);
      setSingles(nextSingles);
      setQueueCounts(counts);
      setVersion((v) => v + 1);
    },
    [db],
  );

  const refreshWithRoots = useCallback(
    async (roots: readonly string[] | null, generation: number) => {
      // ONE snapshot for all three slices — independent reads could cache
      // a photo as both grouped and single mid-scan.
      const queue = await readReviewQueue(db, GROUP_PAGE, SINGLES_PAGE, roots);
      return {
        nextGroups: queue.groups,
        nextSingles: queue.singles,
        counts: queue.counts,
        generation,
      };
    },
    [db],
  );

  /** One full refresh pass: resolve scope → snapshot read → commit. */
  const refreshOnce = useCallback(async () => {
    const generation = ++refreshGenRef.current;
    // The photo-source folder filter scopes every queue read (the scan
    // freezes out-of-source rows in place; reads must not resurface
    // them). FAIL CLOSED on resolution errors: null means "all folders"
    // to the store, so a transient failure must fall back to the last
    // known roots — or skip the refresh entirely before any resolution
    // succeeds — never silently broaden a narrowed source.
    let roots: readonly string[] | null;
    try {
      roots = (await resolveSources(db)).roots ?? null;
      // Only the LATEST refresh may move the fallback roots — an older
      // refresh resolving a superseded broader source must not
      // overwrite what refreshScoped just recorded.
      if (generation === refreshGenRef.current) lastRootsRef.current = { roots };
    } catch (error) {
      if (!lastRootsRef.current) {
        // Deliberate skip (cold start, nothing rendered yet).
        console.warn('[review] source resolution failed — queue refresh skipped:', String(error));
        return;
      }
      roots = lastRootsRef.current.roots;
    }
    await commitRefresh(await refreshWithRoots(roots, generation));
  }, [db, refreshWithRoots, commitRefresh]);

  const refresh = useCallback((): Promise<void> => {
    // SINGLE-FLIGHT + COALESCE with PER-PASS settlement. Scan status
    // ticks request refreshes every couple of seconds during an active
    // scan; running them concurrently let each pass supersede the
    // others' generations so NO pass ever committed (device-observed
    // livelock: an empty queue for an entire rescan). One chain runs
    // passes back-to-back instead — and each caller is settled by the
    // FIRST pass that starts at/after its request (commit or deliberate
    // skip), never by chain quiescence: under sustained requests the
    // chain may run for a whole scan, and barrier callers (decision
    // writes, the settings flows) must not starve behind it. A failing
    // pass rejects only its own waiters; later requests get fresh
    // passes.
    if (!nextPassRef.current) nextPassRef.current = makePassBarrier();
    const barrier = nextPassRef.current.promise;
    refreshAgainRef.current = true;
    if (!refreshTailRef.current && !chainPauseRef.current) {
      refreshTailRef.current = (async () => {
        // Loop-exit check, barrier settlement, and the tail clear below
        // share one synchronous block — a request can only interleave
        // during a pass's await, where the re-check still sees it.
        try {
          while (refreshAgainRef.current && !chainPauseRef.current) {
            refreshAgainRef.current = false;
            const mine = nextPassRef.current ?? makePassBarrier();
            nextPassRef.current = makePassBarrier();
            try {
              await refreshOnce();
              mine.resolve();
            } catch (error) {
              mine.reject(error);
            }
          }
        } finally {
          refreshTailRef.current = null;
        }
      })();
    }
    return barrier;
  }, [refreshOnce]);

  const refreshScoped = useCallback(
    async (roots: readonly string[] | null) => {
      // The given roots ARE the just-persisted truth — install them as
      // the fallback up front so any concurrent refresh that fails
      // resolution falls back to the NEW scope, never the old one.
      const previousFallback = lastRootsRef.current;
      lastRootsRef.current = { roots };
      // PAUSE the chain (it exits at its next pass boundary — bounded,
      // no quiescence wait) and drain it — chain passes and the strict
      // one must never interleave (mutual generation supersession).
      // refresh() requests arriving meanwhile hold pass barriers and are
      // served (or rejected) by the slot below.
      chainPauseRef.current = true;
      while (refreshTailRef.current) {
        await refreshTailRef.current.catch(() => {});
      }
      // RE-install after the drain: a drained chain pass that had
      // already read the OLD persisted source can finish resolving as
      // the latest generation and overwrite the eager install above —
      // the strict pass would then commit the new scope while a later
      // resolution failure fell back to the old roots.
      lastRootsRef.current = { roots };
      const run = (async () => {
        try {
          // Retry until this strict scope verifiably commits as the
          // LATEST refresh (belt-and-braces — with the slot held nothing
          // else should bump the generation) — the picker's fail-closed
          // contract needs the new scope actually rendered before it
          // navigates away.
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const generation = ++refreshGenRef.current;
            await commitRefresh(await refreshWithRoots(roots, generation));
            if (generation === refreshGenRef.current) return;
          }
          throw new Error('queue refresh kept being superseded — try again');
        } catch (error) {
          // FAILURE reverts the eager fallback; re-rendering the restored
          // scope is the CALLER's job AFTER its setting rollback lands — a
          // refresh fired here would resolve the still-persisted rejected
          // source and re-commit exactly the scope being rolled back.
          lastRootsRef.current = previousFallback;
          throw error;
        }
      })();
      // The slot: holds single-flight while the strict pass runs, then —
      // on strict SUCCESS — unpauses and serves the coalesced passes,
      // settling each waiter per pass. On strict FAILURE it REJECTS the
      // pending waiters instead: a pass run now would resolve the
      // still-persisted rejected source and repaint exactly the scope
      // the settings flow is rolling back. The slot itself never
      // rejects; barriers carry the errors.
      const slot = (async () => {
        try {
          try {
            await run;
          } catch {
            // The settings flow owns the strict pass's own failure. The
            // rejection, flag clear, and tail clear below share one
            // synchronous block — only requests that arrived during the
            // strict pass are rejected, none slip in after.
            if (refreshAgainRef.current) {
              refreshAgainRef.current = false;
              const pending = nextPassRef.current ?? makePassBarrier();
              nextPassRef.current = makePassBarrier();
              pending.reject(
                new Error('queue refresh unavailable during a scope rollback — try again'),
              );
            }
            return;
          }
          chainPauseRef.current = false;
          while (refreshAgainRef.current) {
            refreshAgainRef.current = false;
            const mine = nextPassRef.current ?? makePassBarrier();
            nextPassRef.current = makePassBarrier();
            try {
              await refreshOnce();
              mine.resolve();
            } catch (error) {
              mine.reject(error);
            }
          }
        } finally {
          chainPauseRef.current = false;
          refreshTailRef.current = null;
        }
      })();
      refreshTailRef.current = slot;
      // The scoped caller itself awaits only the strict pass (and its
      // failure) — the coalesced tail settles on its own for its callers.
      await run;
    },
    [refreshWithRoots, commitRefresh, refreshOnce],
  );

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

  /** Run a decision write; failures surface loudly, rows stay unchanged.
   * Takes WRITE PRIORITY: the scan yields at its next boundary instead
   * of queueing the decision behind a burst of window transactions. */
  const write = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await withUserWritePriority(fn);
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
    (assetId: string, action: SingleReviewAction, expectedGroupId?: number | null) =>
      write(async () => {
        const verdict: ReviewVerdict =
          action === 'keep' ? 'done' : action === 'cull' ? 'culled' : 'to_edit';
        await applyReviewDecisions(db, [[assetId, verdict]], Date.now(), {
          ...(expectedGroupId !== undefined
            ? { requireAssignment: [{ assetId, groupId: expectedGroupId }] }
            : {}),
        });
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
        // The queue page holds only GROUP_PAGE groups — an explicitly
        // opened group (DayProgress, off-page) is fetched directly so
        // "Keep remaining" never silently no-ops.
        const group =
          groups.find((g) => g.groupId === groupId) ?? (await getReviewGroup(db, groupId));
        if (!group) return;
        const changes = group.members
          .filter((m) => m.state === 'unreviewed')
          .map((m) => [m.asset_id, 'done'] as [string, ReviewVerdict]);
        if (changes.length > 0)
          await applyReviewDecisions(db, changes, Date.now(), {
            // Validated in the transaction: a warm scan can rebuild the
            // group between render and tap — the stale member list must
            // not freeze photos inside superseding groups.
            requireGroupMembership: { groupId, assetIds: changes.map(([id]) => id) },
          });
      }),
    [db, groups, write],
  );

  const redecideDecided = useCallback(
    (assetId: string, target: 'keep' | 'to_edit') =>
      write(async () => {
        await applyRedecision(db, assetId, target, Date.now());
      }),
    [db, write],
  );

  const markBest = useCallback(
    (groupId: number, assetId: string | null) =>
      write(async () => {
        await setGroupBest(db, groupId, assetId);
      }),
    [db, write],
  );

  const makeSingle = useCallback(
    (assetId: string, expectedGroupId: number) =>
      write(async () => {
        await makePhotoSingles(db, [assetId], expectedGroupId);
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
      // Duel, loser verdict, and the winner's star land in ONE
      // transaction — a partial compare verdict must be impossible.
      await applyReviewDecisions(db, keptBoth ? [] : [[loserId, 'culled']], duel.at, {
        duel,
        setBest: { groupId, assetId: winnerId },
      });
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
        if (target === 'cull') {
          // The active-verdict tap: the sheet promises "tap the current
          // decision to return to unreviewed" — restore, PRESERVING any
          // pending copy match (going back to unreviewed answers nothing;
          // the prompt must survive for the next edit cycle).
          await restoreCarriedCull(db, assetId, Date.now(), false);
          return;
        }
        // State-aware: Keep must land on done even when the edited-copy
        // flow left needs_edit set (the verdict path would bounce it to
        // to_edit); to_edit starts a fresh cycle. Both resolve matches.
        await applyRedecision(db, assetId, target, Date.now());
      }),
    [db, write],
  );

  const keepAllSingles = useCallback(
    () =>
      write(async () => {
        const changes = singles
          .filter((m) => m.state === 'unreviewed')
          .map((m) => [m.asset_id, 'done'] as [string, ReviewVerdict]);
        if (changes.length > 0)
          await applyReviewDecisions(db, changes, Date.now(), {
            // Every target must STILL be a single — a scan can move one
            // into a group mid-tap, and keeping it would silently freeze
            // the newly formed group.
            requireAssignment: changes.map(([id]) => ({ assetId: id, groupId: null })),
          });
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
    refreshScoped,
    loadGroup,
    writeError,
    clearWriteError,
    decide,
    clearDecision,
    redecideDecided,
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
