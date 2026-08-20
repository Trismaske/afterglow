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
 * Verdicts (decision 2): keep = 'kept' at swipe time; cull stages the
 * durable global cull queue; the Edit chip queues an edit ACTION without
 * touching the verdict; tapping the active verdict clears back to
 * 'unreviewed'. Un-staging a cull re-decide lands on 'kept'; CullList
 * "Restore" lands on 'unreviewed'.
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
 *
 * THE DAILY GOAL IS CREDITED BY THE WRITE (m0.8.5, A3). `applyReviewDecisions`
 * reports how many rows went unreviewed → decided, and `write` notes that
 * count. Callers pass nothing and can forget nothing: before this, each
 * screen counted its own fresh decisions from a rendered member list, and
 * the screens that never learned to — the state editor, History
 * re-decides — simply did not count, so a goal crossed there celebrated
 * on the next deck decision instead. Paths that cannot produce a fresh
 * decision return void deliberately: `applyRedecision` and the un-stage
 * paths are gated in SQL to already-decided states.
 *
 * Drawing the moment is separate from counting it. A review surface
 * registers as a HOST while focused; a crossing with a host arms the
 * consume-once overlay flag, and a crossing with none says so with a
 * toast instead of leaving a moment pending for a surface that may not
 * open again today.
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
import type { DuelRecord, PhotoState } from '@afterglow/core';
import { fileSize } from '../lib/hash';
import { runTrashAttempt } from '../lib/trashFlow';
import { recoverTrashBatches, TRASH_BATCH_LIMIT } from '../db/trashStore';
import { recoverShareBatches } from '../db/shareStore';
import { verifyTrashedTriState } from '../lib/media';
import { resolveSources } from '../lib/sourceCatalog';
import { mountedVolumeSet, onVolumesChanged } from '../lib/mountedVolumes';
import type { SourceRoot } from '../lib/sources';
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
import { showToast } from '../lib/toast';
import {
  applyLocalAction,
  badgeStateEqualsWithin,
  queueEquals,
  sameIdsWithin,
  type LocalAction,
} from '../lib/reviewPatch';
import {
  buildTimeline,
  groupAnchor,
  type TimelinePageTails,
  type TimelineUnit,
} from '../lib/timeline';
import {
  DAILY_GOAL_KEY,
  GOAL_CELEBRATED_KEY,
  parseCelebratedGoal,
  parseDailyGoal,
  serializeCelebratedGoal,
  shouldCelebrateGoal,
  type CelebratedGoal,
} from '../lib/dailyGoal';
import { dayKey, rangeOfDayKey } from '../lib/dates';
import {
  applyReviewDecisions,
  type ReviewDecisionResult,
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
   * badge describes the photo. Pass the member's verdict when it is at
   * hand: a staged cull (or trashed photo) is not on the to-do list —
   * the queues exclude it — so its retained actions badge QUIET
   * (STATE_MODEL rule 6: loud = waiting, quiet = history). */
  actionWeights: (
    assetId: string,
    state?: PhotoState,
  ) => {
    edit: BadgeWeight | null;
    /** 'removing' = a queued un-favourite (grilling Q5): heart-off glyph
     * at the live weight — waiting work, read apart from apply/applied. */
    favourite: BadgeWeight | 'removing' | null;
    organize: BadgeWeight | null;
    share: BadgeWeight | null;
  };
  refreshQueuedFor: () => Promise<void>;
  /** STRICT scoped refresh: reads under the GIVEN roots, no resolution,
   * no fallback — rejections propagate. The settings apply paths use it
   * so a silent fail-open can never leave an old scope actionable. */
  refreshScoped: (roots: readonly SourceRoot[] | null) => Promise<void>;
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
  /** Hydrate the badge refs for ids OUTSIDE the review snapshot without
   * installing them as browsed (loadGroup's path, exposed): a surface
   * listing off-page members (DayProgress's completed groups) awaits
   * this before rendering so actionWeights can answer for them. */
  hydrateBadges: (ids: readonly string[]) => Promise<void>;
  /** A decision write failed — the row is unchanged; retry the action. */
  writeError: string | null;
  clearWriteError: () => void;
  /** Verdict writes (decision 2 semantics; 'keep' → kept). The optional
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
  clearDecision: (assetId: string, clearDuelsForGroup?: number) => Promise<void>;
  /** State-aware change of mind on a DECIDED photo (gate 5 browse):
   * keep leaves pending actions alone; to_edit starts a fresh cycle; both
   * resolve pending copy matches. */
  redecideDecided: (assetId: string, target: 'keep' | 'to_edit') => Promise<number>;
  /** Finish a group: every remaining unreviewed member keeps (kept). */
  /** Resolves to the number actually kept (codex r10 — see keepAllSingles). */
  keepRest: (groupId: number) => Promise<number>;
  /** "Not related — review as single" (durable user ejection). The
   * displayed group id is validated in the transaction — a background
   * rescan may have rebuilt the group since render. */
  makeSingle: (assetId: string, expectedGroupId: number) => Promise<void>;
  /** Compare TRIAGE (3+ alive), m0.8.6 D7: "Keep this one" — a
   * targeted keep on the winner plus the duel row, in one transaction.
   * The narrow endpoint guard applies; no whole-table claim is made, so
   * the loser and the rest of the table stay untouched. */
  compareKeepWinner: (groupId: number, winnerId: string, loserId: string) => Promise<void>;
  /** Compare: cull the loser (records history + stages the cull). The
   * winner stays untouched — a cull judgment says nothing about keeping. */
  compareCull: (groupId: number, loserId: string, winnerId: string) => Promise<void>;
  /** The two-photo dialog's explicit "Keep both" (m0.8.2, F15): BOTH
   * participants land on kept, atomically. With a group: plus the duel
   * row in the same transaction. Without (singles): a plain two-photo
   * keep, each validated still-single. */
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
  restoreCull: (assetId: string, clearDuelsForGroup?: number) => Promise<void>;
  /** Keep every still-unreviewed single in one write. `day` (and a run's
   * taken_at range) narrows it to the deck's own scope — and, like
   * keepRest's off-page fetch, that scope is re-read from the DB at
   * write time rather than trusted from a rendered list. */
  /** Resolves to the number ACTUALLY kept — the write re-reads its scope
   * fresh, so the caller's rendered pending count can be stale (codex
   * r8: the goal counter must credit real decisions, not a snapshot). */
  keepAllSingles: (day?: string, range?: { from: number; to: number } | null) => Promise<number>;
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
   * counter and arm the once-per-day goal moment at the CROSSING.
   * Exported ONLY for the one surface that writes verdicts outside the
   * provider (Home's edited-copy trash lifecycle stages culls in the
   * trash batch's own transaction — codex device-pass round). Every
   * provider write credits itself from its returned result (A3); a new
   * surface goes through write(), never through this. */
  noteDecisions: (freshDecisions: number) => void;
  /** Register as a surface that can DRAW the goal moment; call the
   * returned function on unfocus. With no host registered a crossing
   * says so with a toast instead of arming an overlay nothing will
   * claim (m0.8.5, A4). */
  registerCelebrationHost: () => () => void;
  /** True while a decision's goal evaluation is still in flight. A
   * surface that advances on completion must WAIT for this, or it can
   * leave the unit before the crossing it caused is known (F4). */
  celebrationSettling: boolean;
  /** The goal of a crossing that has been claimed but not yet drawn.
   * Non-null means a host is about to render the moment, so nothing may
   * advance out from under it. */
  celebrationPending: number | null;
  /** Bumps when a goal moment arrives — focused surfaces re-check. */
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
  // Page TAILS are a READ-time fact (timeline.ts): optimistic patches
  // shrink the arrays, and a tail re-derived from a patched array would
  // either dissolve the horizon or jump it forward past loaded units.
  const [pageTails, setPageTails] = useState<TimelinePageTails>({
    groupsTail: null,
    singlesTail: null,
  });
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
  /** The mounted snapshot the CURRENT deck loaded under (final cycle
   * P4): keep-rest re-reads its day scope at write time, and that
   * re-read must cover the world the user SAW — a fresh provider read
   * could widen the bulk verdict to photos on a card that remounted
   * (or to hidden rows, if enumeration failed to null) after load. */
  const deckMountedRef = useRef<readonly string[] | null>(null);
  /** Deck-load generation (S4): only the LATEST loadGroup/loadDeckSingles
   * may publish the deck refs — overlapping loads around an eject can
   * finish out of order, and a canceled load's late result must not pair
   * the displayed deck with another world's mounted set. */
  const deckLoadGenRef = useRef(0);
  /** The queue snapshot's own load-time mounted set (R1) — the fallback
   * world for bulk writes on decks the snapshot itself rendered. */
  const snapshotMountedRef = useRef<readonly string[] | null>(null);
  const extraIdsRef = useRef<string[]>([]);
  /** Last successfully resolved source roots (fail-closed fallback). */
  const lastRootsRef = useRef<{ roots: readonly SourceRoot[] | null } | null>(null);
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
      mounted: readonly string[] | null;
      generation: number;
    }) => {
      const { nextGroups, nextSingles, counts, mounted, generation } = read;
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
      // Page tails commit on EVERY completed read, even a no-op one: a
      // fresh under-limit read can exactly equal the patched arrays (the
      // patch already removed what the DB lost), and taking the equality
      // return with a stale tail would keep truncating units this read
      // just disproved. Same-value reads bail out on reference equality,
      // so quiet refreshes stay free.
      const nextTails: TimelinePageTails = {
        groupsTail:
          nextGroups.length >= GROUP_PAGE ? groupAnchor(nextGroups[nextGroups.length - 1]) : null,
        singlesTail:
          nextSingles.length >= SINGLES_PAGE ? nextSingles[nextSingles.length - 1].taken_at : null,
      };
      setPageTails((old) =>
        old.groupsTail === nextTails.groupsTail && old.singlesTail === nextTails.singlesTail
          ? old
          : nextTails,
      );
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
        // Badge equality is judged WITHIN the read universe only (m0.8.6
        // codex closing): the refs also hold browse-deep ids the
        // Timeline hydrated, which this bounded read can never contain —
        // whole-set equality read them as permanent drift, so every
        // scan-status refresh committed, bumped the version, and reset
        // the Everything browse once a second (S23, instrumented).
        badgeStateEqualsWithin(
          ids,
          { needsEdit: needsEditRef.current, favourites: favouriteRef.current },
          { needsEdit, favourites },
        ) &&
        sameIdsWithin(ids, queuedForRef.current.share, queuedFor.share) &&
        sameIdsWithin(ids, queuedForRef.current.organize, queuedFor.organize) &&
        // Carried badges are read state too: finishing an edit turns its
        // pencil from live to carried while the QUEUE is unchanged.
        sameIdsWithin(ids, carriedRef.current.edit, carried.edit) &&
        sameIdsWithin(ids, carriedRef.current.organize, carried.organize) &&
        sameIdsWithin(ids, carriedRef.current.share, carried.share)
      ) {
        // Even a no-op refresh updates the PAIRED mounted snapshot
        // (final cycle T6): a card swap that leaves the visible rows
        // unchanged still moves the world later bulk re-reads must use.
        snapshotMountedRef.current = mounted;
        return;
      }
      // Reconcile WITHIN the read universe, never replace (same rule as
      // hydrateBadgeRefs): wholesale assignment dropped every hydrated
      // browse-deep entry on each pass.
      for (const id of ids) {
        if (needsEdit.has(id)) needsEditRef.current.add(id);
        else needsEditRef.current.delete(id);
        const fav = favourites.get(id);
        if (fav !== undefined) favouriteRef.current.set(id, fav);
        else favouriteRef.current.delete(id);
        if (queuedFor.share.has(id)) queuedForRef.current.share.add(id);
        else queuedForRef.current.share.delete(id);
        if (queuedFor.organize.has(id)) queuedForRef.current.organize.add(id);
        else queuedForRef.current.organize.delete(id);
        for (const kind of ['edit', 'organize', 'share'] as const) {
          if (carried[kind].has(id)) carriedRef.current[kind].add(id);
          else carriedRef.current[kind].delete(id);
        }
      }
      loadedIdsRef.current = ids;
      // The set keep-rest re-reads under for on-page groups (R1/S3) —
      // published only past the generation guard, as one unit with the
      // snapshot it loaded.
      snapshotMountedRef.current = mounted;
      snapshotRef.current = { groups: nextGroups, singles: nextSingles, counts };
      setGroups(nextGroups);
      setSingles(nextSingles);
      setQueueCounts(counts);
      setVersion((v) => v + 1);
    },
    [db],
  );

  const refreshWithRoots = useCallback(
    async (roots: readonly SourceRoot[] | null, generation: number) => {
      // ONE snapshot for all three slices — independent reads could cache
      // a photo as both grouped and single mid-scan.
      const snapshotMounted = await mountedVolumeSet();
      const queue = await readReviewQueue(db, GROUP_PAGE, SINGLES_PAGE, roots, snapshotMounted);
      return {
        nextGroups: queue.groups,
        nextSingles: queue.singles,
        counts: queue.counts,
        // Committed WITH the rows (final cycle S3): a superseded refresh
        // must not leave its mounted set published under someone else's
        // snapshot.
        mounted: snapshotMounted,
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
    let roots: readonly SourceRoot[] | null;
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
    async (roots: readonly SourceRoot[] | null) => {
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
  const scopedRoots = useCallback(async (): Promise<readonly SourceRoot[] | null> => {
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
      // The favourite query is SPARSE (codex r6): cancelling a
      // never-applied queued favourite deletes its action row and
      // returns no entry — absence must clear the cached heart, or the
      // next toggle repeats the cancellation against nothing.
      for (const id of ids) if (!favourites.has(id)) favouriteRef.current.delete(id);
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
      const myGen = ++deckLoadGenRef.current;
      const deckMounted = await mountedVolumeSet();
      const rows = await listSinglesForDeck(db, day, await scopedRoots(), range, deckMounted);
      // Published only WITH its rows (Q6) and only by the LATEST load
      // (S4): an overlapping older load finishing late must not pair the
      // displayed deck with its stale mounted set.
      if (myGen === deckLoadGenRef.current) {
        deckMountedRef.current = deckMounted;
        extraIdsRef.current = rows.map((m) => m.asset_id);
      }
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
      const myGen = ++deckLoadGenRef.current;
      const deckMounted = await mountedVolumeSet();
      const group = await getReviewGroup(db, groupId, deckMounted);
      // Published only WITH its rows (R1) and only by the LATEST load
      // (S4): keep-rest on this off-page group must write under the
      // world these rows rendered from.
      if (myGen === deckLoadGenRef.current) {
        deckMountedRef.current = deckMounted;
        extraIdsRef.current = group ? group.members.map((m) => m.asset_id) : [];
        await hydrateBadgeRefs(extraIdsRef.current);
      }
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
   *
   * The optional verdict demotes: a staged cull / trashed photo is off
   * every to-do list (livePhotoClause excludes it from the queues), so a
   * would-be 'live' weight renders 'carried' — the photo still CARRIES
   * the action (un-staging restores it), it just is not waiting. The
   * shared refs stay state-blind on purpose: they are the optimistic
   * patch model's truth (reviewPatch parity), so the demotion lives at
   * the read, per caller-supplied state.
   */
  const actionWeights = useCallback(
    (
      assetId: string,
      state?: PhotoState,
    ): {
      edit: BadgeWeight | null;
      favourite: BadgeWeight | 'removing' | null;
      organize: BadgeWeight | null;
      share: BadgeWeight | null;
    } => {
      const suspended = state === 'culled' || state === 'trashed';
      const weigh = (live: boolean, kind: BadgeActionKind): BadgeWeight | null =>
        live
          ? suspended
            ? 'carried'
            : 'live'
          : carriedRef.current[kind].has(assetId)
            ? 'carried'
            : null;
      const favourite = favouriteBadgeWeight(favouriteRef.current.get(assetId) ?? NO_FAVOURITE);
      return {
        edit: weigh(needsEditRef.current.has(assetId), 'edit'),
        // Suspended photos demote loud states to carried (rule 6): a
        // suspended queued REMOVAL shows the carried heart — truthful,
        // the gallery favourite still stands while the switch-off waits.
        favourite:
          suspended && (favourite === 'live' || favourite === 'removing') ? 'carried' : favourite,
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
    // Scoped like the full pass (m0.8.6 codex closing): entries for ids
    // outside this read are hydrated browse-deep state, not drift.
    if (
      sameIdsWithin(ids, queuedForRef.current.share, next.share) &&
      sameIdsWithin(ids, queuedForRef.current.organize, next.organize) &&
      sameIdsWithin(ids, carriedRef.current.edit, carried.edit) &&
      sameIdsWithin(ids, carriedRef.current.organize, carried.organize) &&
      sameIdsWithin(ids, carriedRef.current.share, carried.share)
    )
      return;
    // Invalidate any in-flight refresh pass that read the PRE-write rows
    // (its commit would revert these badges), exactly as patchLocal does.
    refreshGenRef.current += 1;
    for (const id of ids) {
      if (next.share.has(id)) queuedForRef.current.share.add(id);
      else queuedForRef.current.share.delete(id);
      if (next.organize.has(id)) queuedForRef.current.organize.add(id);
      else queuedForRef.current.organize.delete(id);
      for (const kind of ['edit', 'organize', 'share'] as const) {
        if (carried[kind].has(id)) carriedRef.current[kind].add(id);
        else carriedRef.current[kind].delete(id);
      }
    }
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
        recoverTrashBatches(db, verifyTrashedTriState, Date.now(), await mountedVolumeSet()),
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
    // LIVE mount changes take the same path (Tristan, m0.8.3 matrix): a
    // remount with the app foregrounded must kick the scan (the delta
    // picks up card-side changes) and refresh the reach-scoped queue —
    // without waiting for a navigation or background/foreground cycle.
    const unsubscribeVolumes = onVolumesChanged(() => {
      void startContinuousScan(db);
      void refresh().catch(() => {});
    });
    return () => {
      subscription.remove();
      unsubscribeVolumes();
    };
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
    celebrated: CelebratedGoal | null;
  } | null>(null);
  /**
   * The claimed-but-not-yet-drawn moment, as STATE (m0.8.5, codex r2).
   *
   * It was a ref plus a tick, and that left a hole exactly where the
   * barrier below was supposed to close one: arming and lowering the
   * barrier landed in the same batched render, so the deck's consume
   * effect had not yet set `celebrating` when the advance effects ran in
   * that same passive flush — and they advanced. Observable state means
   * "a moment is waiting to be drawn" is readable in the very render
   * that arms it, with no ordering assumption between effects.
   *
   * The ref mirrors it for the unregister callback, which runs outside
   * render and cannot read state.
   */
  const [celebrationPending, setCelebrationPending] = useState<number | null>(null);
  const celebrationPendingRef = useRef<number | null>(null);
  /**
   * How many review surfaces can draw the moment right now (m0.8.5, A4).
   *
   * The durable "celebrated today" marker is written BEFORE the moment
   * arms, so a crossing nothing can claim would mark the day celebrated
   * and show nothing — and then fire stale, hours later, on whatever
   * review surface happened to focus next. Since the count is now
   * sourced from the write itself, crossings can happen on surfaces that
   * host no overlay at all (the state editor, History), so this stopped
   * being theoretical.
   *
   * A registered host means arm the overlay; none means say it plainly
   * and consume the moment there and then.
   */
  const celebrationHostsRef = useRef(0);
  const registerCelebrationHost = useCallback(() => {
    celebrationHostsRef.current += 1;
    return () => {
      celebrationHostsRef.current -= 1;
      // The LAST host leaving takes any unclaimed moment with it (codex
      // r1/r3). A crossing armed while a host was focused, whose consume
      // effect had not run before that host blurred, would otherwise sit
      // in the ref and play on whatever review surface opened next —
      // possibly hours later, for a goal crossed this morning. That
      // delayed overlay is the exact thing A4 exists to prevent, so it
      // degrades to the same toast a host-less crossing gets.
      if (celebrationHostsRef.current > 0) return;
      const pending = celebrationPendingRef.current;
      celebrationPendingRef.current = null;
      setCelebrationPending(null);
      if (pending !== null) showToast(`Daily goal reached — ${pending} today`);
    };
  }, []);
  /** Notes queue behind one chain, and the sum of not-yet-applied notes
   * rides in a synchronous counter: two rapid decisions can BOTH commit
   * before the first initialization read resolves, so that read includes
   * every pending note — backing out only the caller's own `n` would
   * double-count the rest, and two concurrent initializers could arm two
   * celebrations or overwrite each other's counter (codex r3). */
  const celebrationChainRef = useRef<Promise<void>>(Promise.resolve());
  const celebrationUnappliedRef = useRef(0);
  /**
   * A crossing may still be under evaluation (m0.8.5, codex r1).
   *
   * `noteDecisions` is deliberately fire-and-forget — the write resolves
   * at COMMIT and nothing user-facing waits on a database read. But that
   * left F4's hold unarmable: the deck gates its advance on
   * `celebrating`, which cannot be true until this chain has re-read the
   * goal, written the durable marker and a host has claimed the moment.
   * A goal-crossing final decision would advance to the next unit first,
   * and the overlay would play over the successor.
   *
   * So the deck also holds while a note is settling. This is a few
   * hundred microseconds of cached reads in the common case, and it is
   * the ONLY thing between "the write committed" and "we know whether
   * this was the crossing".
   */
  const [celebrationSettling, setCelebrationSettling] = useState(0);
  const noteDecisions = useCallback(
    (n: number) => {
      if (n <= 0) return;
      // Raised BEFORE the chain is queued and lowered inside its own
      // step, so there is no window where a note is pending and nothing
      // says so.
      setCelebrationSettling((pending) => pending + 1);
      const settled = () => setCelebrationSettling((pending) => Math.max(0, pending - 1));
      // The decision's DAY is captured synchronously at the call — the
      // chained body can start after local midnight, and crediting an
      // old-day decision to the new day could celebrate the wrong day
      // and suppress the real crossing (codex r6). A stale-day note
      // simply drops: its day is over, no celebration can fire for it.
      const noteDay = dayKey(Date.now());
      celebrationUnappliedRef.current += n; // synchronous, before any await
      celebrationChainRef.current = celebrationChainRef.current
        .then(async () => {
          const today = dayKey(Date.now());
          if (noteDay !== today) {
            celebrationUnappliedRef.current -= n;
            settled();
            return;
          }
          let info = celebrationInfoRef.current;
          if (!info || info.day !== today) {
            const [rawGoal, rawCelebrated, byDay] = await Promise.all([
              getSetting(db, DAILY_GOAL_KEY),
              getSetting(db, GOAL_CELEBRATED_KEY),
              getReviewedCountsByDay(db, rangeOfDayKey(today).startMs),
            ]);
            // Every queued note's write COMMITTED before its call, so
            // the fresh read includes them — back out the whole
            // unapplied sum; each chained step then applies its own.
            // RESIDUAL RACE, deliberately kept in the LATE direction
            // (scoped review): a note registering mid-read whose write
            // missed the snapshot is over-subtracted, so a crossing can
            // fire one note late. The pre-read sample tried the other
            // way and could DOUBLE-count into a false EARLY celebration
            // that durably suppresses the real one — the worse lie. The
            // exact fix (a per-note count re-read) is parked for the
            // next cycle.
            info = {
              day: today,
              goal: parseDailyGoal(rawGoal),
              count: Math.max(0, (byDay.get(today) ?? 0) - celebrationUnappliedRef.current),
              celebrated: parseCelebratedGoal(rawCelebrated),
            };
            celebrationInfoRef.current = info;
          } else {
            // The GOAL re-reads on every note (one keyed row): Settings
            // can change it mid-day, and a threshold cached at the
            // day's first decision would celebrate against the OLD
            // number (codex r4). The count stays cached — it is this
            // serialized chain's own truth.
            info.goal = parseDailyGoal(await getSetting(db, DAILY_GOAL_KEY));
          }
          const before = info.count;
          info.count += n;
          celebrationUnappliedRef.current -= n;
          if (
            shouldCelebrateGoal({
              before,
              after: info.count,
              goal: info.goal,
              celebrated: info.celebrated,
              today,
            })
          ) {
            // The durable marker lands BEFORE the moment arms (codex
            // r8): an armed-but-unrecorded celebration re-fires after a
            // restart, and once-per-day is the durable contract. The
            // in-memory mark still sets on failure so this process never
            // doubles; the skipped overlay is the lesser lie.
            //
            // The marker carries the goal it was reached at (m0.8.5, F5),
            // and only ever moves UP within a day — the recorded value is
            // the highest celebrated, which is what stops a goal lowered
            // and re-raised from re-arming a moment already had.
            const celebrated: CelebratedGoal = { day: today, goal: info.goal };
            info.celebrated = celebrated;
            try {
              await setSetting(db, GOAL_CELEBRATED_KEY, serializeCelebratedGoal(celebrated));
            } catch (error) {
              console.warn('[review] goal celebration not recorded — skipped:', String(error));
              settled();
              return;
            }
            if (celebrationHostsRef.current > 0) {
              celebrationPendingRef.current = info.goal;
              setCelebrationPending(info.goal);
            } else {
              // Nothing can draw it — say it now rather than leave a
              // moment pending for a surface that may not open today.
              showToast(`Daily goal reached — ${info.goal} today`);
            }
          }
          settled();
        })
        .catch(() => {
          // No goal info = no celebration; the note still leaves the
          // unapplied sum, or the next init would over-subtract it.
          celebrationUnappliedRef.current -= n;
          settled();
        });
    },
    [db],
  );
  const consumeCelebration = useCallback((): number | null => {
    const goal = celebrationPendingRef.current;
    celebrationPendingRef.current = null;
    setCelebrationPending(null);
    return goal;
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
    async (
      fn: () => Promise<void | ReviewDecisionResult>,
      patch?: LocalAction | (() => LocalAction | null),
    ) => {
      try {
        const result = await withUserWritePriority(fn);
        setWriteError(null);
        // The goal is credited HERE, from what the write committed
        // (m0.8.5, A3). Every verdict path that returns its result is
        // counted, so a new surface cannot quietly fail to celebrate the
        // way the state editor and History re-decides did.
        if (result) noteDecisions(result.freshDecisions);
        const action = typeof patch === 'function' ? patch() : patch;
        if (action) patchLocal(action);
      } catch (error) {
        setWriteError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        void refresh().catch(() => {});
      }
    },
    [refresh, patchLocal, noteDecisions],
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
        () =>
          applyReviewDecisions(db, [[assetId, verdict]], Date.now(), {
            ...(queueEdit ? { needsEditChanges: [{ assetId, needsEdit: true }] } : {}),
            ...(expectedGroupId !== undefined
              ? { requireAssignment: [{ assetId, groupId: expectedGroupId }] }
              : {}),
          }),
        { kind: 'verdict', assetId, verdict, ...(queueEdit ? { queueEdit: true } : {}) },
      );
    },
    [db, write],
  );

  const clearDecision = useCallback(
    // `clearDuelsForGroup` is D5's editor-only lever (m0.8.6): ONLY the
    // state editor's deliberate un-review passes it, after its confirm
    // names the Compare-history deletion. The deck's undo never does —
    // a transient unreviewed state must not dissolve duels.
    (assetId: string, clearDuelsForGroup?: number) =>
      write(
        () =>
          applyReviewDecisions(
            db,
            [[assetId, 'unreviewed']],
            Date.now(),
            clearDuelsForGroup !== undefined ? { deleteDuelsForGroup: clearDuelsForGroup } : {},
          ),
        {
          kind: 'verdict',
          assetId,
          verdict: 'unreviewed',
        },
      ),
    [db, write],
  );

  const keepRest = useCallback(
    async (groupId: number) => {
      // A holder, not a plain `let`: the assignment happens inside the
      // write callback, and TypeScript's flow analysis would otherwise
      // narrow the variable to its `null` initializer after the await.
      const outcome: { result: ReviewDecisionResult | null } = { result: null };
      await write(
        async () => {
          // The queue page holds only GROUP_PAGE groups — an explicitly
          // opened group (DayProgress, off-page) is fetched directly so
          // "Keep remaining" never silently no-ops.
          // ALWAYS a write-time re-read (final cycle S2): the cached
          // snapshot's member states can be stale against another
          // surface's writes (a Progress state-editor cull must not be
          // overwritten to kept), and membership can have moved. The
          // mounted set is the deck's LOAD-time snapshot (R1) — an
          // on-page group re-reads under the queue snapshot's own set, an
          // off-page one under its loadGroup set; never a fresh read,
          // which could widen the bulk keep to members a hot remount
          // revealed after the rows rendered.
          const onPage = snapshotRef.current.groups.some((g) => g.groupId === groupId);
          const group = await getReviewGroup(
            db,
            groupId,
            onPage
              ? snapshotMountedRef.current
              : (deckMountedRef.current ?? snapshotMountedRef.current),
          );
          if (!group) return;
          const changes = group.members
            .filter((m) => m.state === 'unreviewed')
            .map((m) => [m.asset_id, 'kept'] as [string, ReviewVerdict]);
          // APPLIED ids (codex r10): a dissolved off-page group silently
          // keeps nothing, and the caller's goal credit must follow what
          // committed, exactly like keepAllSingles.
          outcome.result =
            changes.length > 0
              ? await applyReviewDecisions(db, changes, Date.now(), {
                  // Validated in the transaction: a warm scan can rebuild
                  // the group between render and tap — the stale member
                  // list must not freeze photos inside superseding groups.
                  requireGroupMembership: { groupId, assetIds: changes.map(([id]) => id) },
                })
              : null;
          return outcome.result ?? undefined;
        },
        () =>
          outcome.result && outcome.result.appliedIds.length > 0
            ? { kind: 'keepMany', assetIds: outcome.result.appliedIds }
            : null,
      );
      return outcome.result?.appliedIds.length ?? 0;
    },
    [db, write],
  );

  const redecideDecided = useCallback(
    (assetId: string, target: 'keep' | 'to_edit') => {
      // The result is RETURNED so write() credits the goal (§10 check
      // 13): a staged cull rescued on a later day is fresh work, and
      // this was the one verdict path that swallowed its result. The
      // patch is result-gated for the same reason keepRest's is: a
      // stale sheet's guarded no-op must stay a no-op in the cached
      // snapshot too (codex device-pass round).
      const outcome: { result: ReviewDecisionResult | null } = { result: null };
      return write(
        async () => (outcome.result = await applyRedecision(db, assetId, target, Date.now())),
        () =>
          outcome.result && outcome.result.appliedIds.length > 0
            ? { kind: 'redecide', assetId, target }
            : null,
        // The APPLIED count rides back to the deck (codex r6): a stale
        // row's guarded no-op must not advance the pager (D11 gates on
        // the durable result, not the rendered state).
      ).then(() => outcome.result?.appliedIds.length ?? 0);
    },
    [db, write],
  );

  const makeSingle = useCallback(
    (assetId: string, expectedGroupId: number) =>
      write(
        async () => {
          // The tap's mounted snapshot (final cycle O1): "Not related"
          // must not user_single-freeze a survivor on an ejected card.
          await makePhotoSingles(db, [assetId], expectedGroupId, await mountedVolumeSet());
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
      mode: 'keepBoth' | 'cull' | 'keepWinner',
    ) => {
      const duel: DuelRecord = {
        groupId: String(groupId),
        winnerId,
        loserId,
        // keptBoth records the whole-table DIALOG's outcome (v19): true
        // = Keep both, false = Cull. The triage keep records NULL — it
        // answers "which is better", not the dialog's question, and
        // Stats' kept-both percentage reads over dialog outcomes only.
        keptBoth: mode === 'keepBoth' ? true : mode === 'cull' ? false : null,
        at: Date.now(),
      };
      // Verdicts (F15 + m0.8.6 D7): the dialog's "Keep both" keeps BOTH;
      // its "Cull" stages the loser; the triage "Keep this one" keeps
      // the winner alone. Duel and verdicts land in ONE transaction — a
      // partial compare verdict must be impossible.
      const verdicts: [string, ReviewVerdict][] =
        mode === 'keepBoth'
          ? [
              [winnerId, 'kept'],
              [loserId, 'kept'],
            ]
          : mode === 'cull'
            ? [[loserId, 'culled']]
            : [[winnerId, 'kept']];
      return applyReviewDecisions(db, verdicts, duel.at, {
        duel,
        // The triage keep is a NARROW, explicitly-targeted verdict: it
        // claims nothing about the rest of the table (D7), so only the
        // dialog modes carry the whole-table claim.
        duelClaimsWholeTable: mode !== 'keepWinner',
        // The whole-table revalidation judges outsiders over the SAME
        // mounted population Compare RENDERED (m0.8.3 §5, final cycle
        // S5/T4) — a queue-backed group pairs with the queue snapshot's
        // own set (deckMountedRef could be a previously browsed deck's
        // world); an independently loaded group uses its loadGroup set.
        // Never a fresh read, which a mid-compare remount could widen.
        mounted: snapshotRef.current.groups.some((g) => g.groupId === groupId)
          ? snapshotMountedRef.current
          : (deckMountedRef.current ?? snapshotMountedRef.current),
      });
    },
    [db],
  );

  /** Triage's positive act (m0.8.6 D7): a targeted keep on the duel's
   * winner plus the duel row, in one transaction. The narrow guard is
   * the store's endpoint check — no whole-table claim is made, so the
   * loser and the rest of the table stay exactly as they were. */
  const compareKeepWinner = useCallback(
    (groupId: number, winnerId: string, loserId: string) =>
      write(() => recordDuel(groupId, winnerId, loserId, 'keepWinner'), {
        kind: 'duel',
        groupId,
        winnerId,
        loserId,
        mode: 'keepWinner',
      }),
    [recordDuel, write],
  );

  const compareKeepBoth = useCallback(
    (winnerId: string, loserId: string, groupId?: number) => {
      if (groupId !== undefined) {
        return write(() => recordDuel(groupId, winnerId, loserId, 'keepBoth'), {
          kind: 'duel',
          groupId,
          winnerId,
          loserId,
          mode: 'keepBoth',
        });
      }
      // Singles: no group, no duel row — just both kept, each
      // validated STILL single (a scan may have grouped one mid-compare,
      // and keeping it would silently freeze the newly formed group).
      return write(
        () =>
          applyReviewDecisions(
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
          ),
        { kind: 'keepMany', assetIds: [winnerId, loserId] },
      );
    },
    [db, recordDuel, write],
  );

  const compareCull = useCallback(
    (groupId: number, loserId: string, winnerId: string) =>
      write(() => recordDuel(groupId, winnerId, loserId, 'cull'), {
        kind: 'duel',
        groupId,
        winnerId,
        loserId,
        mode: 'cull',
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
    (assetId: string) => {
      // Not-a-cull-after-all: the photo was reviewed, so it lands
      // back on 'kept' and any queued edit rides along untouched (the
      // layers are independent). An explicit restore decision
      // resolves a pending copy match (C#12). The result is RETURNED
      // so write() credits the goal — a later-day rescue is fresh
      // work (§10 check 13's defect class) — and gates the patch (a
      // guarded no-op must stay a no-op in the cached snapshot).
      const outcome: { result: ReviewDecisionResult | null } = { result: null };
      return write(
        async () => (outcome.result = await unstageCullDirect(db, assetId, Date.now(), true)),
        () =>
          outcome.result && outcome.result.appliedIds.length > 0
            ? { kind: 'unstage', assetId }
            : null,
      );
    },
    [db, write],
  );

  const restoreCull = useCallback(
    // Same D5 lever as clearDecision: only the state editor's deliberate
    // culled → unreviewed passes `clearDuelsForGroup`.
    (assetId: string, clearDuelsForGroup?: number) => {
      const outcome = { applied: false };
      return write(
        async () => {
          outcome.applied = await restoreCarriedCull(
            db,
            assetId,
            Date.now(),
            true,
            clearDuelsForGroup,
          );
        },
        () => (outcome.applied ? { kind: 'restore', assetId } : null),
      );
    },
    [db, write],
  );

  const redecideStaged = useCallback(
    (assetId: string, target: RedecideTarget) => {
      const outcome: { result: ReviewDecisionResult | null; restored: boolean } = {
        result: null,
        restored: false,
      };
      return write(
        async () => {
          if (target === 'cull') {
            // The active-verdict tap: the sheet promises "tap the current
            // decision to return to unreviewed" — restore, PRESERVING any
            // pending copy match (going back to unreviewed answers nothing;
            // the prompt must survive for the next edit cycle).
            outcome.restored = await restoreCarriedCull(db, assetId, Date.now(), false);
            return;
          }
          // State-aware: "keep" rescues a staged cull and says nothing
          // about its pending actions (the same culled -> kept meaning
          // unstageCullDirect has always had), while "to edit" restarts
          // the edit cycle. Both resolve pending copy matches. The
          // result is RETURNED so write() credits the goal (§10 check
          // 13: THIS was the cull-list sheet's uncounted path), and it
          // gates the patch below like every guarded write.
          return (outcome.result = await applyRedecision(db, assetId, target, Date.now()));
        },
        () =>
          target === 'cull'
            ? outcome.restored
              ? { kind: 'restore', assetId }
              : null
            : outcome.result && outcome.result.appliedIds.length > 0
              ? { kind: 'redecide', assetId, target }
              : null,
      );
    },
    [db, write],
  );

  const keepAllSingles = useCallback(
    async (day?: string, range: { from: number; to: number } | null = null) => {
      // A holder, not a plain `let`: the assignment happens inside the
      // write callback, and TypeScript's flow analysis would otherwise
      // narrow the variable to its `null` initializer after the await.
      const outcome: { result: ReviewDecisionResult | null } = { result: null };
      await write(
        async () => {
          // The deck's rows are NOT the global snapshot (they can sit
          // beyond its newest-first page), so a day/run scope re-reads its
          // own singles here — the same fresh-at-write-time rule keepRest
          // uses for an off-page group.
          const rows = day
            ? await listSinglesForDeck(
                db,
                day,
                await scopedRoots(),
                range,
                // The deck's own load-time snapshot, NOT a fresh read
                // (final cycle P4): the bulk keep covers what was shown.
                deckMountedRef.current,
              )
            : snapshotRef.current.singles;
          const changes = rows
            .filter((m) => m.state === 'unreviewed')
            .map((m) => [m.asset_id, 'kept'] as [string, ReviewVerdict]);
          // APPLIED ids, not planned ones (codex r9): the batch write
          // silently skips externally-reconciled rows, and both the
          // optimistic patch and the goal credit must follow what
          // committed.
          outcome.result =
            changes.length > 0
              ? await applyReviewDecisions(db, changes, Date.now(), {
                  // Every target must STILL be a single — a scan can move
                  // one into a group mid-tap, and keeping it would
                  // silently freeze the newly formed group.
                  requireAssignment: changes.map(([id]) => ({ assetId: id, groupId: null })),
                })
              : null;
          return outcome.result ?? undefined;
        },
        () =>
          outcome.result && outcome.result.appliedIds.length > 0
            ? { kind: 'keepMany', assetIds: outcome.result.appliedIds }
            : null,
      );
      return outcome.result?.appliedIds.length ?? 0;
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
      const rows = (
        await getStagedCulls(db, TRASH_BATCH_LIMIT + unresolved.size, await mountedVolumeSet())
      ).filter((row) => !unresolved.has(row.asset_id));
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
    const remaining = await countStagedCulls(db, await mountedVolumeSet());
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

  /** Derived, never stored: the patch model keeps operating on the two
   * pages, and the timeline re-derives after every commit or patch. */
  const timeline = useMemo(
    () => buildTimeline(groups, singles, pageTails),
    [groups, singles, pageTails],
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
      hydrateBadges: hydrateBadgeRefs,
      writeError,
      clearWriteError,
      decide,
      clearDecision,
      redecideDecided,
      keepRest,
      makeSingle,
      compareKeepWinner,
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
      registerCelebrationHost,
      celebrationSettling: celebrationSettling > 0,
      celebrationPending,
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
      hydrateBadgeRefs,
      writeError,
      clearWriteError,
      decide,
      clearDecision,
      redecideDecided,
      keepRest,
      makeSingle,
      compareKeepWinner,
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
      registerCelebrationHost,
      celebrationSettling,
      celebrationPending,
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
