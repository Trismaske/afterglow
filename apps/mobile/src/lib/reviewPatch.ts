/**
 * Optimistic local queue patches (pure). After a decision write COMMITS,
 * ReviewContext applies the matching patch here so the UI reflects the
 * decision immediately — the deck chip highlights and "Saving…" clears at
 * transaction commit instead of after a full queue re-read, which during
 * an active scan can queue seconds behind window transactions. The
 * background refresh that follows every write reconciles anything a
 * concurrent scan changed.
 *
 * Every patch mirrors the corresponding db/store.ts SQL exactly (the
 * parity suite in db/reviewPatch.real.test.ts runs both against a real
 * database and diffs the results):
 * - verdict         → applyReviewDecisions change rows; `queueEdit`
 *                     mirrors the needsEditChanges the same transaction
 *                     carries (the deck's "To edit" = keep + queue)
 * - flag            → applyReviewDecisions needsEditChanges (the verdict
 *                     never moves — they are separate layers)
 * - favourite       → applyReviewDecisions favouriteChanges
 * - redecide        → applyRedecision (both land on kept; "to_edit"
 *                     restarts the cycle, "keep" leaves actions alone)
 * - unstage         → unstageCullDirect (culled → kept, edit rides along)
 * - restore         → restoreCarriedCull (culled → unreviewed; a queued
 *                     edit survives, like every other verdict write)
 * - duel            → applyReviewDecisions duel (compare)
 * - makeSingle      → makePhotoSingles (group member → singles feed)
 * - keepMany        → applyReviewDecisions batch keeps (keep-rest/-all)
 *
 * Queue-shape parity: a group with no unreviewed member left leaves the
 * queue (listReviewGroupsIn's EXISTS filter); a single whose state moves
 * outside {unreviewed, culled} leaves the feed (listSinglesFeedIn's
 * predicate); counts track UNREVIEWED members per side, plus the number
 * of groups still holding one (countReviewQueueIn's COUNT DISTINCT). A
 * photo the loaded pages don't contain (off-page cull-list rows) only
 * updates the flag/favourite maps — counts for it reconcile on the
 * refresh.
 */
import type { QueueCounts, ReviewGroupRow, ReviewMemberRow, ReviewVerdict } from '../db/store';
import type { FavouriteIntentChange } from '../db/store';
import { type FavouriteStatus } from './favouriteState';

/** Everything ReviewContext holds about the loaded queue. */
export interface ReviewSnapshot {
  groups: readonly ReviewGroupRow[];
  singles: readonly ReviewMemberRow[];
  counts: QueueCounts;
  needsEdit: ReadonlySet<string>;
  favourites: ReadonlyMap<string, FavouriteStatus>;
}

export type LocalAction =
  /** `queueEdit` mirrors the needsEditChanges the same write carries —
   * the deck's "To edit" is one transaction: keep the photo AND queue
   * the edit. Absent means the write said nothing about the edit, which
   * (v18) leaves any pending one exactly as it was. */
  | { kind: 'verdict'; assetId: string; verdict: ReviewVerdict; queueEdit?: boolean }
  | { kind: 'flag'; assetId: string; needsEdit: boolean }
  | { kind: 'favourite'; intent: FavouriteIntentChange }
  | { kind: 'redecide'; assetId: string; target: 'keep' | 'to_edit' }
  | { kind: 'unstage'; assetId: string }
  | { kind: 'restore'; assetId: string }
  /** The duel's verdict shape (m0.8.6 D7): the whole-table dialog's
   * "Keep both" keeps BOTH, its "Cull" stages the loser, and a triage
   * duel's "Keep this one" writes a targeted keep on the winner alone. */
  | {
      kind: 'duel';
      groupId: number;
      winnerId: string;
      loserId: string;
      mode: 'keepBoth' | 'cull' | 'keepWinner';
    }
  | { kind: 'makeSingle'; assetId: string; groupId: number }
  | { kind: 'keepMany'; assetIds: readonly string[] };

/** Feed membership predicate (listSinglesFeedIn's WHERE clause). */
function inSinglesFeed(state: ReviewMemberRow['state']): boolean {
  return state === 'unreviewed' || state === 'culled';
}

/** Queue membership predicate (listReviewGroupsIn's EXISTS clause). */
function inGroupQueue(group: ReviewGroupRow): boolean {
  return group.members.some((m) => m.state === 'unreviewed');
}

interface MemberUpdate {
  state?: ReviewMemberRow['state'];
  needs_edit?: number;
}

/** Where a loaded snapshot holds an asset (for the counts side). */
function findMember(
  s: ReviewSnapshot,
  assetId: string,
): { side: 'grouped' | 'singles'; member: ReviewMemberRow } | null {
  for (const g of s.groups) {
    const member = g.members.find((m) => m.asset_id === assetId);
    if (member) return { side: 'grouped', member };
  }
  const member = s.singles.find((m) => m.asset_id === assetId);
  return member ? { side: 'singles', member } : null;
}

/** Apply one member update everywhere it appears, then re-derive queue
 * membership (groups with no unreviewed member drop; singles outside the
 * feed predicate drop) and the unreviewed counts. */
function patchMember(s: ReviewSnapshot, assetId: string, update: MemberUpdate): ReviewSnapshot {
  const located = findMember(s, assetId);
  if (!located) return s;
  const prior = located.member;
  const nextState = update.state ?? prior.state;
  const patched: ReviewMemberRow = {
    ...prior,
    state: nextState,
    needs_edit: update.needs_edit ?? prior.needs_edit,
  };
  const counts = { ...s.counts };
  if (prior.state === 'unreviewed' && nextState !== 'unreviewed') counts[located.side] -= 1;
  if (prior.state !== 'unreviewed' && nextState === 'unreviewed') counts[located.side] += 1;
  if (located.side === 'grouped') {
    const updated = s.groups.map((g) =>
      g.members.some((m) => m.asset_id === assetId)
        ? { ...g, members: g.members.map((m) => (m.asset_id === assetId ? patched : m)) }
        : g,
    );
    const groups = updated.filter(inGroupQueue);
    // Every loaded group is a QUEUED group, so the ones this decision
    // filtered out are exactly the groups that just left the queue.
    counts.groups -= updated.length - groups.length;
    return { ...s, groups, counts };
  }
  const singles = inSinglesFeed(nextState)
    ? s.singles.map((m) => (m.asset_id === assetId ? patched : m))
    : s.singles.filter((m) => m.asset_id !== assetId);
  return { ...s, singles, counts };
}

function withFlag(s: ReviewSnapshot, assetId: string, flag: boolean): ReviewSnapshot {
  if (s.needsEdit.has(assetId) === flag) return s;
  const needsEdit = new Set(s.needsEdit);
  if (flag) needsEdit.add(assetId);
  else needsEdit.delete(assetId);
  return { ...s, needsEdit };
}

function applyVerdict(
  s: ReviewSnapshot,
  assetId: string,
  verdict: ReviewVerdict,
  queueEdit?: boolean,
): ReviewSnapshot {
  // v18: the verdict IS the state. The CASE chain this used to mirror is
  // gone — an edit lives in its own layer and never bends the verdict,
  // so a keep is 'kept' whether or not an edit is pending. Nor does the
  // verdict bend the edit: clearing a verdict leaves a queued edit
  // queued, because undoing a keep says nothing about the edit.
  let next = s;
  if (queueEdit !== undefined) next = withFlag(next, assetId, queueEdit);
  const flag = next.needsEdit.has(assetId) ? 1 : 0;
  return patchMember(next, assetId, { state: verdict, needs_edit: flag });
}

export function applyLocalAction(s: ReviewSnapshot, action: LocalAction): ReviewSnapshot {
  switch (action.kind) {
    case 'verdict':
      return applyVerdict(s, action.assetId, action.verdict, action.queueEdit);
    case 'flag': {
      // setNeedsEdit semantics (v18): the flag NEVER moves the verdict,
      // so one patch covers every prior state.
      let next = withFlag(s, action.assetId, action.needsEdit);
      if (findMember(next, action.assetId)) {
        next = patchMember(next, action.assetId, { needs_edit: action.needsEdit ? 1 : 0 });
      }
      return next;
    }
    case 'favourite': {
      const favourites = new Map(s.favourites);
      favourites.set(action.intent.assetId, {
        state: action.intent.state,
        target: action.intent.target,
      });
      return { ...s, favourites };
    }
    case 'redecide': {
      // applyRedecision (v18): both targets land on the KEPT verdict.
      // 'to_edit' ASKS for an edit, so it sets the flag; 'keep' says
      // nothing about the edit and therefore leaves it exactly as it is
      // (m0.8.2 — it used to abandon it, for a reason that no longer
      // exists; see the store's header).
      // Same guard as the SQL (`state IN ('culled','kept')`): a stale
      // sheet on a photo that left the decided states patches nothing,
      // exactly as the UPDATE matches no row.
      const located = findMember(s, action.assetId);
      if (located && located.member.state !== 'culled' && located.member.state !== 'kept') return s;
      const next = action.target === 'to_edit' ? withFlag(s, action.assetId, true) : s;
      return patchMember(next, action.assetId, {
        state: 'kept',
        needs_edit: next.needsEdit.has(action.assetId) ? 1 : 0,
      });
    }
    case 'unstage': {
      // unstageCullDirect: culled → kept. Any queued edit rides along
      // untouched, because it was never part of the verdict.
      const located = findMember(s, action.assetId);
      if (located && located.member.state !== 'culled') return s;
      return patchMember(s, action.assetId, { state: 'kept' });
    }
    case 'restore': {
      // restoreCarriedCull: culled → unreviewed, and NOTHING else. A
      // queued edit survives, exactly as it does in the SQL — sending a
      // staged cull back to the review pool is a statement about the
      // verdict alone (docs/STATE_MODEL.md).
      const located = findMember(s, action.assetId);
      if (located && located.member.state !== 'culled') return s;
      const flag = s.needsEdit.has(action.assetId) ? 1 : 0;
      return patchMember(s, action.assetId, { state: 'unreviewed', needs_edit: flag });
    }
    case 'duel': {
      // The duel row itself is invisible to the queue snapshot — only
      // the verdicts it carries patch anything.
      return action.mode === 'keepBoth'
        ? applyVerdict(applyVerdict(s, action.winnerId, 'kept'), action.loserId, 'kept')
        : action.mode === 'cull'
          ? applyVerdict(s, action.loserId, 'culled')
          : applyVerdict(s, action.winnerId, 'kept');
    }
    case 'makeSingle': {
      const group = s.groups.find((g) => g.groupId === action.groupId);
      const member = group?.members.find((m) => m.asset_id === action.assetId);
      if (!group || !member) return s;
      // A group this ejection shrinks below 2 members DISSOLVES — the
      // survivor becomes a durable single too (applyPhotoSingles +
      // repairGroupMembership); everyone leaving a group drops its
      // time-attached badge.
      const remaining = group.members.filter((m) => m.asset_id !== action.assetId);
      const ejected = remaining.length < 2 ? [member, ...remaining] : [member];
      const updated = s.groups.map((g) =>
        g.groupId === action.groupId
          ? remaining.length < 2
            ? { ...g, members: [] }
            : { ...g, members: remaining }
          : g,
      );
      const groups = updated.filter(inGroupQueue);
      let singles = s.singles;
      const counts = { ...s.counts };
      counts.groups -= updated.length - groups.length;
      for (const m of ejected) {
        // Feed order is taken_at DESC, asset_id DESC.
        if (inSinglesFeed(m.state))
          singles = insertFeedOrdered(singles, { ...m, time_attached: 0 });
        if (m.state === 'unreviewed') {
          counts.grouped -= 1;
          counts.singles += 1;
        }
      }
      return { ...s, groups, singles, counts };
    }
    case 'keepMany': {
      let next = s;
      for (const assetId of action.assetIds) next = applyVerdict(next, assetId, 'kept');
      return next;
    }
  }
}

/** Are two members identical in every field the UI renders? */
function memberEquals(a: ReviewMemberRow, b: ReviewMemberRow): boolean {
  return (
    a.asset_id === b.asset_id &&
    a.state === b.state &&
    a.needs_edit === b.needs_edit &&
    a.time_attached === b.time_attached &&
    a.uri === b.uri &&
    a.taken_at === b.taken_at &&
    a.day === b.day
  );
}

/**
 * Structural equality of two queue snapshots (m0.8.1 — no allocation, no
 * signature strings). ReviewContext uses it to make a refresh that read
 * back exactly what an optimistic patch already applied a NO-OP: without
 * it every decision bumped `version` twice (patch, then the reconciling
 * refresh), so every version-keyed loader in the app — Home's corpus
 * stats, the tab badges, the deck's per-photo queries, DayProgress —
 * ran twice per swipe, and once per scan-driven refresh that changed
 * nothing at all.
 */
export function queueEquals(a: ReviewSnapshot, b: ReviewSnapshot): boolean {
  // Badge state (needsEdit/favourites/queued/carried) is deliberately
  // NOT compared here (m0.8.6 codex closing): the provider's refs hold
  // a UNION universe — the bounded pass ids plus browse-deep ids the
  // Timeline hydrated — so whole-set equality read every hydrated extra
  // as drift, and every scan-status refresh bumped the version and
  // reset the Everything browse (the S23's once-a-second Loading
  // flash). Badge equality is judged per read id by
  // badgeStateEqualsWithin/sameIdsWithin beside this.
  if (
    a.counts.grouped !== b.counts.grouped ||
    a.counts.singles !== b.counts.singles ||
    a.counts.groups !== b.counts.groups
  ) {
    return false;
  }
  if (a.groups.length !== b.groups.length || a.singles.length !== b.singles.length) return false;
  for (let i = 0; i < a.groups.length; i += 1) {
    const ga = a.groups[i];
    const gb = b.groups[i];
    if (ga.groupId !== gb.groupId) return false;
    // Hidden-member metadata is queue state (final cycle T6): forgetting
    // an away card changes a group's "N on unmounted SD card" header
    // while its visible members stay identical.
    if ((ga.unreachableCount ?? 0) !== (gb.unreachableCount ?? 0)) return false;
    if (ga.members.length !== gb.members.length) return false;
    for (let m = 0; m < ga.members.length; m += 1) {
      if (!memberEquals(ga.members[m], gb.members[m])) return false;
    }
  }
  for (let i = 0; i < a.singles.length; i += 1) {
    if (!memberEquals(a.singles[i], b.singles[i])) return false;
  }
  return true;
}

function insertFeedOrdered(
  singles: readonly ReviewMemberRow[],
  member: ReviewMemberRow,
): ReviewMemberRow[] {
  const out = singles.filter((m) => m.asset_id !== member.asset_id);
  const at = out.findIndex(
    (m) =>
      m.taken_at < member.taken_at ||
      (m.taken_at === member.taken_at && m.asset_id < member.asset_id),
  );
  if (at === -1) return [...out, member];
  return [...out.slice(0, at), member, ...out.slice(at)];
}

/** Set equality judged ONLY within `ids` — an entry outside the read
 * universe is neither confirmation nor drift (hydrated browse-deep ids
 * live in the same refs the bounded refresh reconciles). */
export function sameIdsWithin(
  ids: readonly string[],
  current: ReadonlySet<string>,
  next: ReadonlySet<string>,
): boolean {
  for (const id of ids) if (current.has(id) !== next.has(id)) return false;
  return true;
}

/** needsEdit + favourite equality within the read universe (the two
 * badge legs queueEquals no longer judges). */
export function badgeStateEqualsWithin(
  ids: readonly string[],
  current: {
    needsEdit: ReadonlySet<string>;
    favourites: ReadonlyMap<string, FavouriteStatus>;
  },
  next: {
    needsEdit: ReadonlySet<string>;
    favourites: ReadonlyMap<string, FavouriteStatus>;
  },
): boolean {
  for (const id of ids) {
    if (current.needsEdit.has(id) !== next.needsEdit.has(id)) return false;
    const a = current.favourites.get(id);
    const b = next.favourites.get(id);
    if ((a === undefined) !== (b === undefined)) return false;
    if (a !== undefined && b !== undefined && (a.state !== b.state || a.target !== b.target))
      return false;
  }
  return true;
}
