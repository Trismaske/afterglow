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
 * RESPONSIVENESS (m0.8.1): a decision write resolves when its transaction
 * COMMITS. The matching optimistic patch (lib/reviewPatch.ts — exact SQL
 * parity, tested against a real database) updates the in-memory queue
 * and flag/favourite maps synchronously, so chips highlight and busy
 * states clear immediately; the queue refresh that used to gate every
 * write now runs in the background and merely reconciles concurrent scan
 * activity. Patching bumps the refresh generation so an in-flight pass
 * that read pre-write rows can never briefly revert the patch.
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
import { AppState } from 'react-native';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { getActionBadges, type ActionBadgeMap, type BadgeActionKind } from '../db/actions';
import { getFavouriteActionStates } from '../db/actions';
import type { DuelRecord } from '@afterglow/core';
import { fileSize } from '../lib/hash';
import { runTrashAttempt } from '../lib/trashFlow';
import { recoverTrashBatches, TRASH_BATCH_LIMIT } from '../db/trashStore';
import { recoverShareBatches } from '../db/shareStore';
import { verifyTrashedTriState } from '../lib/media';
import { resolveSources } from '../lib/sourceCatalog';
import { withUserWritePriority } from '../lib/writePriority';
import { startContinuousScan, subscribeScanStatus } from '../scan/scanRunner';
import {
  favouriteBadgeWeight,
  nextFavouriteIntent,
  NO_FAVOURITE,
  type FavouriteStatus,
} from '../lib/favouriteState';
import type { BadgeWeight } from '../lib/photoBadges';
import { perfLog } from '../lib/perfLog';
import { applyLocalAction, queueEquals, type LocalAction } from '../lib/reviewPatch';
import { buildTimeline, type TimelineUnit } from '../lib/timeline';
import {
  DAILY_GOAL_KEY,
  GOAL_CELEBRATED_KEY,
  parseDailyGoal,
  shouldCelebrateGoal,
} from '../lib/dailyGoal';
import { dayKey, rangeOfDayKey } from '../lib/dates';
import {
  applyReviewDecisions,
  readReviewQueue,
  getNeedsEditAssets,
  getQueuedForAssets,
  getReviewedCountsByDay,
  getSetting,
  setSetting,
  countStagedCulls,
  getStagedCulls,
  getReviewGroup,
  listSinglesForDeck,
  applyRedecision,
  makePhotoSingles,
  restoreCarriedCull,
  setGroupBest,
  unstageCullDirect,
  type QueueCounts,
  type QueuedForAssets,
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
  /** A queue read has COMPLETED at least once (m0.8.1). Distinct from
   * `version > 0`: since a no-change refresh deliberately commits
   * nothing, a library with an empty queue (everything reviewed) never
   * bumps the version — screens that showed a loading state until the
   * first bump stayed there forever. Ask this, never the version. */
  loaded: boolean;
  /** Live review queue: groups with ≥ 1 unreviewed member, newest first. */
  groups: ReviewGroupRow[];
  /** Singles feed: unreviewed + staged culls (badged), newest first. */
  singles: ReviewMemberRow[];
  /** The merged review timeline (m0.8.2, F9): groups and day-split
   * singles runs in one newest-first order, derived from the two pages
   * above — the overview renders it and the deck's advance walks it. */
  timeline: TimelineUnit[];
  queueCounts: QueueCounts;
  /** Re-read everything from the durable rows. */
  refresh: () => Promise<void>;
  /** Share/organize queue membership of the loaded photos (the deck and
   * Groups badges). Re-read, never patched — a targeted
   * `refreshQueuedFor` after any share/organize write keeps it exact. */
  queuedFor: (assetId: string) => { share: boolean; organize: boolean };
  /** Badge weight per action (m0.8.2): 'live' waiting, 'carried' done,
   * null absent. The BUTTONS keep asking needsEdit/queuedFor/
   * favouriteStatus, which are pending-only — a button offers work, a
   * badge describes the photo. */
  actionWeights: (assetId: string) => {
    edit: BadgeWeight | null;
    favourite: BadgeWeight | null;
    organize: BadgeWeight | null;
    share: BadgeWeight | null;
  };
  refreshQueuedFor: () => Promise<void>;
  /** STRICT scoped refresh: reads under the GIVEN roots, no resolution,
   * no fallback — rejections propagate. The settings apply paths use it
   * so a silent fail-open can never leave an old scope actionable. */
  refreshScoped: (roots: readonly string[] | null) => Promise<void>;
  /** Fetch ONE group by id, completion irrespective (gate 5 browse of a
   * finished group). Its members join the flag/favourite tracking so the
   * deck's toggles work outside the queue; null = gone (dissolved). */
  loadGroup: (groupId: number) => Promise<ReviewGroupRow | null>;
  /** Fetch ONE day's singles for a deck (m0.8.2) — kept photos included
   * (group-deck parity), optionally narrowed to a run's taken_at range.
   * Like loadGroup, the rows can sit outside the bounded queue page, and
   * their ids join the flag/favourite tracking. */
  loadDeckSingles: (
    day: string,
    range?: { from: number; to: number } | null,
  ) => Promise<ReviewMemberRow[]>;
  /** The deck left (route blur): drop the browsed ids installed by
   * loadGroup/loadDeckSingles so a stale group's ids stop riding every
   * refresh's overlay query (TODO rider, m0.8.2). */
  releaseBrowseIds: () => void;
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
   * keep leaves pending actions alone; to_edit starts a fresh cycle; both
   * resolve pending copy matches. */
  redecideDecided: (assetId: string, target: 'keep' | 'to_edit') => Promise<void>;
  /** Finish a group: every remaining unreviewed member keeps (done). */
  keepRest: (groupId: number) => Promise<void>;
  markBest: (groupId: number, assetId: string | null) => Promise<void>;
  /** "Not related — review as single" (durable user ejection). The
   * displayed group id is validated in the transaction — a background
   * rescan may have rebuilt the group since render. */
  makeSingle: (assetId: string, expectedGroupId: number) => Promise<void>;
  /** Compare TRIAGE (3+ alive): winner is better, both stay UNDECIDED —
   * stars the best and records the duel, writes no verdict (F15: a
   * repeated burst duel picks best/worst, it does not keep). */
  recordCompare: (groupId: number, winnerId: string, loserId: string) => Promise<void>;
  /** Compare: cull the loser (records history + stages the cull). The
   * winner stays untouched — a cull judgment says nothing about keeping. */
  compareCull: (groupId: number, loserId: string, winnerId: string) => Promise<void>;
  /** The two-photo dialog's explicit "Keep both" (m0.8.2, F15): BOTH
   * participants land on kept, atomically. With a group: plus the
   * winner's star and the duel row in the same transaction. Without
   * (singles): a plain two-photo keep, each validated still-single. */
  compareKeepBoth: (winnerId: string, loserId: string, groupId?: number) => Promise<void>;
  needsEdit: (assetId: string) => boolean;
  toggleNeedsEdit: (assetId: string) => Promise<void>;
  favouriteStatus: (assetId: string) => FavouriteStatus;
  toggleFavourite: (assetId: string) => Promise<void>;
  refreshFavouriteStates: () => Promise<void>;
  /**
   * A durable QUEUE changed outside the review snapshot — a queue screen
   * completing, clearing or retargeting work on photos the deck never
   * loaded. `refresh` deliberately commits nothing when the review queue
   * itself is unchanged (m0.8.1: a no-op refresh must not re-render), so
   * without this signal the tab badges and any loaded Stats tab keep a
   * count the user just watched change. Device-observed: marking an edit
   * done left the Edit badge on its old number until backgrounding.
   */
  queuesChanged: () => void;
  /** Re-decide from the cull list: not-a-cull-after-all lands on kept. */
  unstageCull: (assetId: string) => Promise<void>;
  /** CullList "Restore to unreviewed": back to the review pool. */
  restoreCull: (assetId: string) => Promise<void>;
  /** Keep every still-unreviewed single in one write. `day` (and a run's
   * taken_at range) narrows it to the deck's own scope — and, like
   * keepRest's off-page fetch, that scope is re-read from the DB at
   * write time rather than trusted from a rendered list. */
  keepAllSingles: (day?: string, range?: { from: number; to: number } | null) => Promise<void>;
  /** Re-decide a STAGED cull from the cull list: keep → kept (pending
   * actions untouched), to_edit → kept with a fresh edit cycle, cull (the
   * active chip) → restore to unreviewed; keep/to_edit
   * are explicit un-staging decisions and resolve any pending copy match
   * (C#12) — a restore answers nothing and resolves nothing. */
  redecideStaged: (assetId: string, target: RedecideTarget) => Promise<void>;
  /**
   * THE one delete path (P4#1): loop the durable GLOBAL cull queue
   * through the trash-attempt lifecycle in bounded batches — one system
   * dialog each — until every row was attempted or the user declines.
   */
  confirmStagedCulls: () => Promise<ConfirmResult>;
  /** F14 (amended by Tristan): fresh decisions landed — bump today's
   * counter and arm the once-per-day goal moment at the CROSSING. Every
   * review surface that writes verdicts calls this (deck AND Compare)
   * with the count of photos that just left `unreviewed`, so the moment
   * fires wherever the crossing actually happens. */
  noteDecisions: (n: number) => void;
  /** Bumps when a goal moment arrives — focused surfaces re-check. */
  celebrationTick: number;
  /** Claim the pending moment: returns the goal to celebrate exactly
   * once (null when nothing pending / already claimed). */
  consumeCelebration: () => number | null;
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

/** Set equality for the badge id sets (same no-op-refresh purpose as
 * reviewPatch's queueEquals, for state the patch model does not hold). */
function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Split an action-badge read into the CARRIED sets the badges need; the
 * live half is owned by the patched refs, which are a render ahead. */
function carriedSets(map: ActionBadgeMap): Record<BadgeActionKind, Set<string>> {
  const out: Record<BadgeActionKind, Set<string>> = {
    edit: new Set(),
    organize: new Set(),
    share: new Set(),
  };
  for (const [photoId, weights] of map)
    for (const kind of ['edit', 'organize', 'share'] as const)
      if (weights[kind] === 'carried') out[kind].add(photoId);
  return out;
}

const ReviewContext = createContext<ReviewContextValue | null>(null);

export function ReviewProvider({ children }: { children: React.ReactNode }) {
  const db = useSQLiteContext();
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const [groups, setGroups] = useState<ReviewGroupRow[]>([]);
  const [singles, setSingles] = useState<ReviewMemberRow[]>([]);
  const [queueCounts, setQueueCounts] = useState<QueueCounts>({
    grouped: 0,
    singles: 0,
    groups: 0,
  });
  const [writeError, setWriteError] = useState<string | null>(null);
  const needsEditRef = useRef<Set<string>>(new Set());
  const favouriteRef = useRef<Map<string, FavouriteStatus>>(new Map());
  /** Share/organize queue membership of the loaded ids (badges). */
  const queuedForRef = useRef<QueuedForAssets>({ share: new Set(), organize: new Set() });
  /** CARRIED actions of the loaded ids (m0.8.2): edit/organize/share that
   * already happened and are not waiting again. `live` deliberately does
   * NOT come from here — it comes from the patched refs above, so a chip
   * lights the instant you tap and this read only supplies history. */
  const carriedRef = useRef<Record<BadgeActionKind, Set<string>>>({
    edit: new Set(),
    organize: new Set(),
    share: new Set(),
  });
  /** The ids the maps above cover — `refreshQueuedFor` re-reads exactly
   * these after a share/organize write. */
  const loadedIdsRef = useRef<string[]>([]);
  /** Mirror of the committed queue state for synchronous optimistic
   * patching (React state reads would be a render behind). */
  const snapshotRef = useRef<{
    groups: ReviewGroupRow[];
    singles: ReviewMemberRow[];
    counts: QueueCounts;
  }>({ groups: [], singles: [], counts: { grouped: 0, singles: 0, groups: 0 } });
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
  /** COUNT of scoped calls holding exclusivity: while non-zero the
   * chain exits at its next pass boundary and refresh() queues instead
   * of starting a chain. Counted, not boolean — a newer scoped call's
   * pause must survive an older slot's release. */
  const chainPauseRef = useRef(0);
  const startedRef = useRef(false);

  const commitRefresh = useCallback(
    async (read: {
      nextGroups: ReviewGroupRow[];
      nextSingles: ReviewMemberRow[];
      counts: QueueCounts;
      generation: number;
    }) => {
      const { nextGroups, nextSingles, counts, generation } = read;
      const ids = [
        ...nextGroups.flatMap((g) => g.members.map((m) => m.asset_id)),
        ...nextSingles.map((m) => m.asset_id),
        ...extraIdsRef.current,
      ];
      const [needsEdit, favourites, queuedFor, actionBadges] = await Promise.all([
        getNeedsEditAssets(db, ids),
        getFavouriteActionStates(db, ids),
        getQueuedForAssets(db, ids),
        getActionBadges(db, ids),
      ]);
      const carried = carriedSets(actionBadges);
      if (generation !== refreshGenRef.current) return; // superseded mid-read
      // A read COMPLETED — even if it changed nothing. This must happen
      // before the equality check below, or an empty queue never reports
      // as loaded.
      if (!loadedRef.current) {
        loadedRef.current = true;
        setLoaded(true);
      }
      // NO-OP REFRESHES COMMIT NOTHING (m0.8.1): a decision's optimistic
      // patch already applied exactly what this read returns, and a
      // scan-driven refresh usually finds the queue unchanged. Bumping
      // `version` anyway re-ran every version-keyed loader in the app
      // (Home's corpus stats + whole-corpus MediaStore count, the four
      // badge COUNTs, the deck's per-photo queries, DayProgress) — twice
      // per swipe, and repeatedly during scans.
      if (
        queueEquals(
          {
            groups: snapshotRef.current.groups,
            singles: snapshotRef.current.singles,
            counts: snapshotRef.current.counts,
            needsEdit: needsEditRef.current,
            favourites: favouriteRef.current,
          },
          { groups: nextGroups, singles: nextSingles, counts, needsEdit, favourites },
        ) &&
        // The badge maps are outside the patch model, so they are their
        // own no-op condition: a share/organize queue changed elsewhere
        // (the queue tabs) leaves the queue itself identical.
        sameIds(queuedForRef.current.share, queuedFor.share) &&
        sameIds(queuedForRef.current.organize, queuedFor.organize) &&
        // Carried badges are read state too: finishing an edit turns its
        // pencil from live to carried while the QUEUE is unchanged.
        sameIds(carriedRef.current.edit, carried.edit) &&
        sameIds(carriedRef.current.organize, carried.organize) &&
        sameIds(carriedRef.current.share, carried.share)
      ) {
        return;
      }
      needsEditRef.current = needsEdit;
      favouriteRef.current = favourites;
      queuedForRef.current = queuedFor;
      carriedRef.current = carried;
      loadedIdsRef.current = ids;
      snapshotRef.current = { groups: nextGroups, singles: nextSingles, counts };
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
      chainPauseRef.current += 1;
      let pauseHeld = true;
      const releasePause = () => {
        // Exactly-once: the slot's serving hand-off and its finally both
        // release, and a double decrement would clear a NEWER scoped
        // call's pause.
        if (pauseHeld) {
          pauseHeld = false;
          chainPauseRef.current -= 1;
        }
      };
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
          releasePause();
          // Serve coalesced passes — but yield at the next boundary if a
          // NEWER scoped call has paused (its drain takes over the
          // pending waiters).
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
          releasePause();
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

  /** Source scope for a read outside the refresh chain, under the SAME
   * fail-closed rule: resolve, fall back to the last known roots, and
   * REJECT rather than let a resolution failure mean "all folders". */
  const scopedRoots = useCallback(async (): Promise<readonly string[] | null> => {
    try {
      return (await resolveSources(db)).roots ?? null;
    } catch (error) {
      if (!lastRootsRef.current) throw error;
      return lastRootsRef.current.roots;
    }
  }, [db]);

  /**
   * Hydrate the badge refs for ids OUTSIDE the queue page (an off-page
   * group, a day's singles): the deck's toggles and badges must work
   * there exactly as they do inside it. Merges into the refs rather than
   * replacing them — the queue's own ids stay covered.
   */
  const hydrateBadgeRefs = useCallback(
    async (ids: readonly string[]): Promise<void> => {
      if (ids.length === 0) return;
      const [needsEdit, favourites, queuedFor, actionBadges] = await Promise.all([
        getNeedsEditAssets(db, ids),
        getFavouriteActionStates(db, ids),
        getQueuedForAssets(db, ids),
        getActionBadges(db, ids),
      ]);
      const carried = carriedSets(actionBadges);
      for (const id of ids) {
        if (needsEdit.has(id)) needsEditRef.current.add(id);
        else needsEditRef.current.delete(id);
        if (queuedFor.share.has(id)) queuedForRef.current.share.add(id);
        else queuedForRef.current.share.delete(id);
        if (queuedFor.organize.has(id)) queuedForRef.current.organize.add(id);
        else queuedForRef.current.organize.delete(id);
        for (const kind of ['edit', 'organize', 'share'] as const) {
          if (carried[kind].has(id)) carriedRef.current[kind].add(id);
          else carriedRef.current[kind].delete(id);
        }
      }
      for (const [id, status] of favourites) favouriteRef.current.set(id, status);
    },
    [db],
  );

  /**
   * A singles deck's rows (m0.8.2): one day's singles — kept included,
   * optionally range-narrowed to a run — fetched directly because the
   * global feed is a bounded newest-first pending page: the same reason
   * loadGroup exists for an off-page group. Its ids join the
   * flag/favourite/queue tracking so the deck's toggles work outside the
   * queue.
   */
  const loadDeckSingles = useCallback(
    async (
      day: string,
      range: { from: number; to: number } | null = null,
    ): Promise<ReviewMemberRow[]> => {
      const rows = await listSinglesForDeck(db, day, await scopedRoots(), range);
      extraIdsRef.current = rows.map((m) => m.asset_id);
      await hydrateBadgeRefs(extraIdsRef.current);
      return rows;
    },
    [db, scopedRoots, hydrateBadgeRefs],
  );

  /** Route blur: the browsed ids stop riding the refresh overlay reads
   * (they re-install on the next loadGroup/loadDeckSingles). */
  const releaseBrowseIds = useCallback(() => {
    extraIdsRef.current = [];
  }, []);

  const loadGroup = useCallback(
    async (groupId: number): Promise<ReviewGroupRow | null> => {
      const group = await getReviewGroup(db, groupId);
      extraIdsRef.current = group ? group.members.map((m) => m.asset_id) : [];
      await hydrateBadgeRefs(extraIdsRef.current);
      return group;
    },
    [db, hydrateBadgeRefs],
  );

  const queuedFor = useCallback(
    (assetId: string) => ({
      share: queuedForRef.current.share.has(assetId),
      organize: queuedForRef.current.organize.has(assetId),
    }),
    [],
  );

  /**
   * What each action badge should say for this photo (m0.8.2): `live`
   * when it is waiting, `carried` when it happened, null when the photo
   * has no such action. LIVE comes from the patched refs so a chip lights
   * the instant you tap; CARRIED comes from the last read, because
   * history cannot be patched optimistically — nothing is carried until
   * the work actually completed.
   */
  const actionWeights = useCallback(
    (
      assetId: string,
    ): {
      edit: BadgeWeight | null;
      favourite: BadgeWeight | null;
      organize: BadgeWeight | null;
      share: BadgeWeight | null;
    } => {
      const weigh = (live: boolean, kind: BadgeActionKind): BadgeWeight | null =>
        live ? 'live' : carriedRef.current[kind].has(assetId) ? 'carried' : null;
      return {
        edit: weigh(needsEditRef.current.has(assetId), 'edit'),
        favourite: favouriteBadgeWeight(favouriteRef.current.get(assetId) ?? NO_FAVOURITE),
        organize: weigh(queuedForRef.current.organize.has(assetId), 'organize'),
        share: weigh(queuedForRef.current.share.has(assetId), 'share'),
      };
    },
    [],
  );

  /** Re-read share/organize membership AND the carried marks for the
   * loaded photos, then re-render. Called right after a share/organize
   * write: the badges are read state, not patched state, and this read is
   * one indexed IN query per chunk — orders of magnitude cheaper than the
   * full queue refresh that reconciles the rest in the background. The id
   * set is derived (not remembered) so it always covers an out-of-queue
   * group the deck is browsing, whose ids joined via loadGroup. */
  const refreshQueuedFor = useCallback(async () => {
    const ids = [
      ...snapshotRef.current.groups.flatMap((g) => g.members.map((m) => m.asset_id)),
      ...snapshotRef.current.singles.map((m) => m.asset_id),
      ...extraIdsRef.current,
    ];
    if (ids.length === 0) return;
    const [next, actionBadges] = await Promise.all([
      getQueuedForAssets(db, ids),
      getActionBadges(db, ids),
    ]);
    const carried = carriedSets(actionBadges);
    if (
      sameIds(queuedForRef.current.share, next.share) &&
      sameIds(queuedForRef.current.organize, next.organize) &&
      sameIds(carriedRef.current.edit, carried.edit) &&
      sameIds(carriedRef.current.organize, carried.organize) &&
      sameIds(carriedRef.current.share, carried.share)
    )
      return;
    // Invalidate any in-flight refresh pass that read the PRE-write rows
    // (its commit would revert these badges), exactly as patchLocal does.
    refreshGenRef.current += 1;
    queuedForRef.current = next;
    carriedRef.current = carried;
    setVersion((v) => v + 1);
  }, [db]);

  // Startup, once per process: crash recovery (0.7.1 hardening, rehomed
  // from session resume) → continuous scan → initial queue.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const started = Date.now();
      await Promise.all([
        recoverTrashBatches(db, verifyTrashedTriState, Date.now()),
        recoverShareBatches(db),
      ]).catch((error) => {
        // Recovery re-runs next launch; the durable lifecycle rows are
        // exactly the state it needs. Loud, once.
        console.warn('[review] startup recovery failed:', String(error));
      });
      const recovered = Date.now();
      await refresh().catch(() => {});
      // Field diagnostic, once per process: the cold-start critical path
      // (recovery + source resolution + first queue read) — this is the
      // "time to usable Home" budget.
      perfLog(
        () =>
          `first queue refresh: recovery ${recovered - started}ms, ` +
          `resolve+read ${Date.now() - recovered}ms`,
      );
    })();
  }, [db, refresh]);

  // FOREGROUND RETURN re-checks the library (m0.8.1, tester decision).
  // The generation fingerprint is read at pass START, so a photo that
  // arrived while Afterglow was open would otherwise wait for the next
  // launch. Starting a scan IS the check: an unchanged library costs one
  // native generation call and returns, and the runner is single-flight,
  // so this is safe to fire on every return to the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      void startContinuousScan(db);
      // Photos added/removed while we were away also change the counts
      // the queue renders — the refresh is coalesced and commits nothing
      // when nothing changed.
      void refresh().catch(() => {});
    });
    return () => subscription.remove();
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

  /** Apply an optimistic patch for a COMMITTED write: mirror the SQL's
   * effect on the loaded queue synchronously, invalidate any in-flight
   * pass that read pre-write rows (its commit would briefly revert the
   * patch), and bump the version so screens re-render now. */
  const patchLocal = useCallback((action: LocalAction) => {
    refreshGenRef.current += 1;
    const next = applyLocalAction(
      {
        groups: snapshotRef.current.groups,
        singles: snapshotRef.current.singles,
        counts: snapshotRef.current.counts,
        needsEdit: needsEditRef.current,
        favourites: favouriteRef.current,
      },
      action,
    );
    snapshotRef.current = {
      groups: [...next.groups],
      singles: [...next.singles],
      counts: next.counts,
    };
    // Runtime instances are plain Set/Map (readonly is a type-level view);
    // loadGroup keeps mutating the refs in place.
    needsEditRef.current = next.needsEdit as Set<string>;
    favouriteRef.current = next.favourites as Map<string, FavouriteStatus>;
    setGroups(snapshotRef.current.groups);
    setSingles(snapshotRef.current.singles);
    setQueueCounts(next.counts);
    setVersion((v) => v + 1);
  }, []);

  /** Run a decision write; failures surface loudly, rows stay unchanged.
   * Takes WRITE PRIORITY: the scan yields at its next boundary instead
   * of queueing the decision behind a burst of window transactions.
   * Resolves at COMMIT: the optimistic patch lands synchronously and the
   * reconciling queue refresh runs in the background — the UI must never
   * wait on a full re-read (device-observed multi-second "Saving…" while
   * a scan holds the database). `patch` may be a thunk for actions whose
   * shape is only known after fn ran (batch keeps); returning null skips
   * patching (nothing changed). */
  const write = useCallback(
    async (fn: () => Promise<void>, patch?: LocalAction | (() => LocalAction | null)) => {
      try {
        await withUserWritePriority(fn);
        setWriteError(null);
        const action = typeof patch === 'function' ? patch() : patch;
        if (action) patchLocal(action);
      } catch (error) {
        setWriteError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        void refresh().catch(() => {});
      }
    },
    [refresh, patchLocal],
  );

  const decide = useCallback(
    (assetId: string, action: SingleReviewAction, expectedGroupId?: number | null) => {
      // v18: 'to_edit' is not a verdict — flag-and-keep lands on 'kept'
      // AND queues an edit action, in ONE transaction. Sending only the
      // verdict would keep the photo and silently drop the edit, which
      // is the whole reason the two layers are written together here.
      const verdict: ReviewVerdict = action === 'cull' ? 'culled' : 'kept';
      const queueEdit = action === 'to_edit';
      return write(
        async () => {
          await applyReviewDecisions(db, [[assetId, verdict]], Date.now(), {
            ...(queueEdit ? { needsEditChanges: [{ assetId, needsEdit: true }] } : {}),
            ...(expectedGroupId !== undefined
              ? { requireAssignment: [{ assetId, groupId: expectedGroupId }] }
              : {}),
          });
        },
        { kind: 'verdict', assetId, verdict, ...(queueEdit ? { queueEdit: true } : {}) },
      );
    },
    [db, write],
  );

  const clearDecision = useCallback(
    (assetId: string) =>
      write(
        async () => {
          await applyReviewDecisions(db, [[assetId, 'unreviewed']], Date.now());
        },
        { kind: 'verdict', assetId, verdict: 'unreviewed' },
      ),
    [db, write],
  );

  const keepRest = useCallback(
    (groupId: number) => {
      let kept: string[] = [];
      return write(
        async () => {
          // The queue page holds only GROUP_PAGE groups — an explicitly
          // opened group (DayProgress, off-page) is fetched directly so
          // "Keep remaining" never silently no-ops.
          const group =
            snapshotRef.current.groups.find((g) => g.groupId === groupId) ??
            (await getReviewGroup(db, groupId));
          if (!group) return;
          const changes = group.members
            .filter((m) => m.state === 'unreviewed')
            .map((m) => [m.asset_id, 'kept'] as [string, ReviewVerdict]);
          if (changes.length > 0)
            await applyReviewDecisions(db, changes, Date.now(), {
              // Validated in the transaction: a warm scan can rebuild the
              // group between render and tap — the stale member list must
              // not freeze photos inside superseding groups.
              requireGroupMembership: { groupId, assetIds: changes.map(([id]) => id) },
            });
          kept = changes.map(([id]) => id);
        },
        () => (kept.length > 0 ? { kind: 'keepMany', assetIds: kept } : null),
      );
    },
    [db, write],
  );

  const redecideDecided = useCallback(
    (assetId: string, target: 'keep' | 'to_edit') =>
      write(
        async () => {
          await applyRedecision(db, assetId, target, Date.now());
        },
        { kind: 'redecide', assetId, target },
      ),
    [db, write],
  );

  const markBest = useCallback(
    (groupId: number, assetId: string | null) =>
      write(
        async () => {
          await setGroupBest(db, groupId, assetId);
        },
        { kind: 'best', groupId, assetId },
      ),
    [db, write],
  );

  const makeSingle = useCallback(
    (assetId: string, expectedGroupId: number) =>
      write(
        async () => {
          await makePhotoSingles(db, [assetId], expectedGroupId);
        },
        { kind: 'makeSingle', assetId, groupId: expectedGroupId },
      ),
    [db, write],
  );

  const recordDuel = useCallback(
    async (
      groupId: number,
      winnerId: string,
      loserId: string,
      keptBoth: boolean,
      keptVerdicts = false,
    ) => {
      const duel: DuelRecord = {
        groupId: String(groupId),
        winnerId,
        loserId,
        keptBoth,
        at: Date.now(),
      };
      // Verdicts (F15): the dialog's "Keep both" keeps BOTH; "Cull"
      // stages the loser; a triage duel writes none. Duel, verdicts and
      // the winner's star land in ONE transaction — a partial compare
      // verdict must be impossible.
      const verdicts: [string, ReviewVerdict][] = keptBoth
        ? keptVerdicts
          ? [
              [winnerId, 'kept'],
              [loserId, 'kept'],
            ]
          : []
        : [[loserId, 'culled']];
      await applyReviewDecisions(db, verdicts, duel.at, {
        duel,
        setBest: { groupId, assetId: winnerId },
      });
    },
    [db],
  );

  const recordCompare = useCallback(
    (groupId: number, winnerId: string, loserId: string) =>
      write(() => recordDuel(groupId, winnerId, loserId, true), {
        kind: 'duel',
        groupId,
        winnerId,
        loserId,
        keptBoth: true,
      }),
    [recordDuel, write],
  );

  const compareKeepBoth = useCallback(
    (winnerId: string, loserId: string, groupId?: number) => {
      if (groupId !== undefined) {
        return write(() => recordDuel(groupId, winnerId, loserId, true, true), {
          kind: 'duel',
          groupId,
          winnerId,
          loserId,
          keptBoth: true,
          keptVerdicts: true,
        });
      }
      // Singles: no group, no star, no duel row — just both kept, each
      // validated STILL single (a scan may have grouped one mid-compare,
      // and keeping it would silently freeze the newly formed group).
      return write(
        async () => {
          await applyReviewDecisions(
            db,
            [
              [winnerId, 'kept'],
              [loserId, 'kept'],
            ],
            Date.now(),
            {
              requireAssignment: [
                { assetId: winnerId, groupId: null },
                { assetId: loserId, groupId: null },
              ],
            },
          );
        },
        { kind: 'keepMany', assetIds: [winnerId, loserId] },
      );
    },
    [db, recordDuel, write],
  );

  const compareCull = useCallback(
    (groupId: number, loserId: string, winnerId: string) =>
      write(() => recordDuel(groupId, winnerId, loserId, false), {
        kind: 'duel',
        groupId,
        winnerId,
        loserId,
        keptBoth: false,
      }),
    [recordDuel, write],
  );

  const needsEdit = useCallback((assetId: string) => needsEditRef.current.has(assetId), []);

  const toggleNeedsEdit = useCallback(
    (assetId: string) => {
      const flag = !needsEditRef.current.has(assetId);
      return write(
        async () => {
          await applyReviewDecisions(db, [], Date.now(), {
            needsEditChanges: [{ assetId, needsEdit: flag }],
          });
        },
        { kind: 'flag', assetId, needsEdit: flag },
      );
    },
    [db, write],
  );

  const favouriteStatus = useCallback(
    (assetId: string) => favouriteRef.current.get(assetId) ?? NO_FAVOURITE,
    [],
  );

  const toggleFavourite = useCallback(
    (assetId: string) => {
      const current = favouriteRef.current.get(assetId) ?? NO_FAVOURITE;
      const intent = nextFavouriteIntent(assetId, current);
      return write(
        async () => {
          await applyReviewDecisions(db, [], Date.now(), {
            favouriteChanges: [intent],
          });
        },
        { kind: 'favourite', intent },
      );
    },
    [db, write],
  );

  const queuesChanged = useCallback(() => setVersion((v) => v + 1), []);

  const refreshFavouriteStates = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const unstageCull = useCallback(
    (assetId: string) =>
      write(
        async () => {
          // Not-a-cull-after-all: the photo was reviewed, so it lands
          // back on 'kept' and any queued edit rides along untouched (the
          // layers are independent). An explicit restore decision
          // resolves a pending copy match (C#12).
          await unstageCullDirect(db, assetId, Date.now(), true);
        },
        { kind: 'unstage', assetId },
      ),
    [db, write],
  );

  const restoreCull = useCallback(
    (assetId: string) =>
      write(
        async () => {
          await restoreCarriedCull(db, assetId, Date.now());
        },
        { kind: 'restore', assetId },
      ),
    [db, write],
  );

  const redecideStaged = useCallback(
    (assetId: string, target: RedecideTarget) =>
      write(
        async () => {
          if (target === 'cull') {
            // The active-verdict tap: the sheet promises "tap the current
            // decision to return to unreviewed" — restore, PRESERVING any
            // pending copy match (going back to unreviewed answers nothing;
            // the prompt must survive for the next edit cycle).
            await restoreCarriedCull(db, assetId, Date.now(), false);
            return;
          }
          // State-aware: "keep" rescues a staged cull and says nothing
          // about its pending actions (the same culled -> kept meaning
          // unstageCullDirect has always had), while "to edit" restarts
          // the edit cycle. Both resolve pending copy matches.
          await applyRedecision(db, assetId, target, Date.now());
        },
        target === 'cull' ? { kind: 'restore', assetId } : { kind: 'redecide', assetId, target },
      ),
    [db, write],
  );

  const keepAllSingles = useCallback(
    (day?: string, range: { from: number; to: number } | null = null) => {
      let kept: string[] = [];
      return write(
        async () => {
          // The deck's rows are NOT the global snapshot (they can sit
          // beyond its newest-first page), so a day/run scope re-reads its
          // own singles here — the same fresh-at-write-time rule keepRest
          // uses for an off-page group.
          const rows = day
            ? await listSinglesForDeck(db, day, await scopedRoots(), range)
            : snapshotRef.current.singles;
          const changes = rows
            .filter((m) => m.state === 'unreviewed')
            .map((m) => [m.asset_id, 'kept'] as [string, ReviewVerdict]);
          if (changes.length > 0)
            await applyReviewDecisions(db, changes, Date.now(), {
              // Every target must STILL be a single — a scan can move one
              // into a group mid-tap, and keeping it would silently freeze
              // the newly formed group.
              requireAssignment: changes.map(([id]) => ({ assetId: id, groupId: null })),
            });
          kept = changes.map(([id]) => id);
        },
        () => (kept.length > 0 ? { kind: 'keepMany', assetIds: kept } : null),
      );
    },
    [db, write, scopedRoots],
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
      // Read only what one batch can attempt (+ the rows this run has
      // already given up on, which the filter drops).
      const rows = (await getStagedCulls(db, TRASH_BATCH_LIMIT + unresolved.size)).filter(
        (row) => !unresolved.has(row.asset_id),
      );
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
    const remaining = await countStagedCulls(db);
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

  // -------------------------------------- goal celebration (F14, amended)
  // The counter lives HERE so a crossing fires wherever it happens —
  // Tristan's blocker was a goal crossed on the Compare screen that
  // never celebrated because the old counter was deck-local. Loaded
  // lazily per day; the moment is a consume-once flag any focused
  // review surface claims and renders.
  const celebrationInfoRef = useRef<{
    day: string;
    goal: number;
    count: number;
    celebratedDay: string | null;
  } | null>(null);
  const celebrationPendingRef = useRef<number | null>(null);
  const [celebrationTick, setCelebrationTick] = useState(0);
  const noteDecisions = useCallback(
    (n: number) => {
      if (n <= 0) return;
      void (async () => {
        const today = dayKey(Date.now());
        let info = celebrationInfoRef.current;
        if (!info || info.day !== today) {
          const [rawGoal, celebratedDay, byDay] = await Promise.all([
            getSetting(db, DAILY_GOAL_KEY),
            getSetting(db, GOAL_CELEBRATED_KEY),
            getReviewedCountsByDay(db, rangeOfDayKey(today).startMs),
          ]);
          // The write that triggered this call has already COMMITTED, so
          // the fresh read includes it — back it out before bumping, or
          // the crossing decision would double-count itself.
          info = {
            day: today,
            goal: parseDailyGoal(rawGoal),
            count: Math.max(0, (byDay.get(today) ?? 0) - n),
            celebratedDay,
          };
          celebrationInfoRef.current = info;
        }
        const before = info.count;
        info.count += n;
        if (
          shouldCelebrateGoal({
            before,
            after: info.count,
            goal: info.goal,
            celebratedDay: info.celebratedDay,
            today,
          })
        ) {
          info.celebratedDay = today;
          await setSetting(db, GOAL_CELEBRATED_KEY, today).catch(() => {});
          celebrationPendingRef.current = info.goal;
          setCelebrationTick((tick) => tick + 1);
        }
      })().catch(() => {}); // no goal info = no celebration, nothing else
    },
    [db],
  );
  const consumeCelebration = useCallback((): number | null => {
    const goal = celebrationPendingRef.current;
    celebrationPendingRef.current = null;
    return goal;
  }, []);

  /** Derived, never stored: the patch model keeps operating on the two
   * pages, and the timeline re-derives after every commit or patch. */
  const timeline = useMemo(
    () => buildTimeline(groups, singles, GROUP_PAGE, SINGLES_PAGE),
    [groups, singles],
  );

  const value = useMemo<ReviewContextValue>(
    () => ({
      version,
      loaded,
      groups,
      singles,
      timeline,
      queueCounts,
      refresh,
      refreshScoped,
      queuedFor,
      actionWeights,
      refreshQueuedFor,
      loadGroup,
      loadDeckSingles,
      releaseBrowseIds,
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
      compareKeepBoth,
      needsEdit,
      toggleNeedsEdit,
      favouriteStatus,
      toggleFavourite,
      refreshFavouriteStates,
      queuesChanged,
      unstageCull,
      restoreCull,
      keepAllSingles,
      redecideStaged,
      confirmStagedCulls,
      noteDecisions,
      celebrationTick,
      consumeCelebration,
    }),
    [
      version,
      loaded,
      groups,
      singles,
      timeline,
      queueCounts,
      refresh,
      refreshScoped,
      queuedFor,
      actionWeights,
      refreshQueuedFor,
      loadGroup,
      loadDeckSingles,
      releaseBrowseIds,
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
      compareKeepBoth,
      needsEdit,
      toggleNeedsEdit,
      favouriteStatus,
      toggleFavourite,
      refreshFavouriteStates,
      queuesChanged,
      unstageCull,
      restoreCull,
      keepAllSingles,
      redecideStaged,
      confirmStagedCulls,
      noteDecisions,
      celebrationTick,
      consumeCelebration,
    ],
  );
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
