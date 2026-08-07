/**
 * The merged review timeline (m0.8.2, F9 — pure; replaces groupFlow.ts).
 *
 * Review order is ONE newest-first timeline of units: a GROUP (anchored
 * at its newest member) or a RUN of consecutive ungrouped singles. Runs
 * split at day boundaries and wherever a group's anchor lands between
 * two singles, so a run is always "the singles of one day between two
 * groups" — sitting-sized, and reviewable in capture order. The overview
 * screen renders this list and the deck's auto-advance walks it, so the
 * screen can never display an order the flow does not follow.
 *
 * Inputs are the queue's two bounded pages (groups + singles feed),
 * each newest-first. When either page is FULL, units older than the
 * older page's tail are TRUNCATED: singles below the last loaded group
 * may have unloaded groups between them (and vice versa), so placing
 * them would invent an order the database does not hold. The truncated
 * tail pages in as units complete — exactly like today's bounded queue.
 *
 * A COMPLETED unit leaves the timeline on the next build (a group with
 * no unreviewed member leaves the queue; a run's pending singles leave
 * the feed), so `destinationAfterUnit` mirrors the old group advance:
 * the successor slides into the completed unit's former index.
 *
 * Undated photos carry `day = null` (rendered as the undated pseudo-day)
 * but still hold a fallback timestamp (DATE_TAKEN ?? DATE_MODIFIED), so
 * they interleave by that timestamp like every other unit — forcing
 * them last would break the merge order the feed already renders.
 */
import type { ReviewGroupRow, ReviewMemberRow } from '../db/store';
import { UNDATED_DAY_KEY } from './dates';

export interface TimelineGroupUnit {
  kind: 'group';
  group: ReviewGroupRow;
  /** Newest member's taken_at — the unit's merge anchor. */
  newestAt: number;
}

export interface TimelineRunUnit {
  kind: 'run';
  /** The run's local day key (photos.day; UNDATED_DAY_KEY for null). */
  day: string;
  /** NEWEST-first members — the singles decks' page order (Tristan's
   * call: singles read newest-first; groups stay chronological), so a
   * run card's first thumbnail is the first photo its deck shows. */
  members: ReviewMemberRow[];
  newestAt: number;
  /** Inclusive taken_at range — the deck re-reads members by it, so a
   * mid-run keep (which leaves the pending feed) never shrinks an open
   * deck: the range is fixed at build time, the row read is not. */
  from: number;
  to: number;
}

export type TimelineUnit = TimelineGroupUnit | TimelineRunUnit;

/** How a screen names a unit across rebuilds: groups by id; runs by day
 * plus range OVERLAP, because a rebuilt run's pending-only range can
 * only shrink within the range the deck was opened with. */
export type UnitRef =
  { kind: 'group'; groupId: string } | { kind: 'run'; day: string; from: number; to: number };

/** Where the review flow goes next. Named for the UNIT, not a screen:
 * since m0.8.5 (L4) both unit kinds are the one `Deck` route, which the
 * deck re-seeds in place rather than remounting. */
export type UnitDestination =
  | { kind: 'group'; groupId: string }
  | { kind: 'run'; day: string; from: number; to: number }
  | { kind: 'cullList' };

const dayOf = (member: ReviewMemberRow): string => member.day ?? UNDATED_DAY_KEY;

export function unitRefOf(unit: TimelineUnit): UnitRef {
  return unit.kind === 'group'
    ? { kind: 'group', groupId: String(unit.group.groupId) }
    : { kind: 'run', day: unit.day, from: unit.from, to: unit.to };
}

export function unitDestination(unit: TimelineUnit): UnitDestination {
  return unit.kind === 'group'
    ? { kind: 'group', groupId: String(unit.group.groupId) }
    : { kind: 'run', day: unit.day, from: unit.from, to: unit.to };
}

function sameUnit(unit: TimelineUnit, ref: UnitRef): boolean {
  if (unit.kind === 'group')
    return ref.kind === 'group' && String(unit.group.groupId) === ref.groupId;
  return ref.kind === 'run' && unit.day === ref.day && unit.from <= ref.to && ref.from <= unit.to;
}

export function findUnitIndex(units: readonly TimelineUnit[], ref: UnitRef): number {
  return units.findIndex((unit) => sameUnit(unit, ref));
}

/** Does this unit still hold REVIEW WORK? The singles feed deliberately
 * keeps staged culls in place (badged), so a run whose last unreviewed
 * member was culled stays on the timeline as a browseable card — but
 * "continue" and the auto-advance must never land on it: the deck would
 * open in browse mode and stop advancing (codex r3). */
export function unitHasPending(unit: TimelineUnit): boolean {
  const members = unit.kind === 'group' ? unit.group.members : unit.members;
  return members.some((member) => member.state === 'unreviewed');
}

/** The first unit holding review work — what every "Continue reviewing"
 * door opens (Home's CTA, the overview's, the deck's fallback). */
export function firstPendingUnit(units: readonly TimelineUnit[]): TimelineUnit | null {
  return units.find(unitHasPending) ?? null;
}

/** Each FULL page's read-time TAIL timestamp (null = the page was not
 * full, so nothing truncates on its account). Captured when the arrays
 * were READ and carried through optimistic patches: the horizon is a
 * fact about the SOURCE — what may remain unloaded past the tail — and
 * the patched arrays can neither re-derive it (a decision removing the
 * tail row would jump the horizon forward and hide already-loaded
 * pending units between the old and new tails from the advance, codex
 * r7) nor dissolve it (removing rows from a full page loads nothing).
 * Only the next completed read moves a tail. */
export interface TimelinePageTails {
  groupsTail: number | null;
  singlesTail: number | null;
}

/** A group's merge anchor — its newest member's taken_at. Exported so
 * the read commit can capture the tail group's anchor with the same
 * definition the merge uses. */
export const groupAnchor = (group: ReviewGroupRow): number => group.members[0]?.taken_at ?? 0;

/**
 * Merge the two newest-first pages into the unit timeline. `tails` are
 * each full page's read-time tail timestamps — a non-null tail means
 * the source continues past it, which is what arms the truncation
 * described in the header.
 */
export function buildTimeline(
  rawGroups: readonly ReviewGroupRow[],
  singles: readonly ReviewMemberRow[],
  tails: TimelinePageTails,
): TimelineUnit[] {
  // A group with no members has no anchor and cannot be placed — the
  // store never emits one, but a defensive `?? 0` anchor would sort it
  // to the epoch and could collapse the truncation horizon.
  const groups = rawGroups.filter((group) => group.members.length > 0);
  const units: TimelineUnit[] = [];
  let run: ReviewMemberRow[] = [];
  const closeRun = () => {
    if (run.length === 0) return;
    // Accumulated newest-first — which IS the singles decks' page order.
    const members = [...run];
    units.push({
      kind: 'run',
      day: dayOf(members[0]),
      members,
      newestAt: members[0].taken_at,
      from: members[members.length - 1].taken_at,
      to: members[0].taken_at,
    });
    run = [];
  };
  let g = 0;
  let s = 0;
  while (g < groups.length || s < singles.length) {
    const nextGroup = g < groups.length ? groups[g] : null;
    const nextSingle = s < singles.length ? singles[s] : null;
    // Ties break toward the single so its run closes before the group
    // that shares its anchor — either order is defensible; this one
    // keeps a burst's stragglers ahead of the burst.
    if (nextGroup && (!nextSingle || groupAnchor(nextGroup) > nextSingle.taken_at)) {
      closeRun();
      units.push({ kind: 'group', group: nextGroup, newestAt: groupAnchor(nextGroup) });
      g += 1;
    } else if (nextSingle) {
      if (run.length > 0 && dayOf(run[run.length - 1]) !== dayOf(nextSingle)) closeRun();
      run.push(nextSingle);
      s += 1;
    }
  }
  closeRun();

  // Truncate below the horizon: with a FULL page, anything older than
  // its READ-TIME tail may have unloaded units between it and the tail.
  // The tails come from the read commit, never from the patched arrays
  // — see TimelinePageTails.
  const horizon = Math.max(tails.groupsTail ?? -Infinity, tails.singlesTail ?? -Infinity);
  if (horizon === -Infinity) return units;
  const kept: TimelineUnit[] = [];
  for (const unit of units) {
    if (unit.newestAt < horizon) break;
    if (unit.kind === 'run' && unit.from < horizon) {
      const members = unit.members.filter((m) => m.taken_at >= horizon);
      if (members.length > 0)
        kept.push({ ...unit, members, from: members[members.length - 1].taken_at });
      break; // anchors are non-increasing — nothing after survives
    }
    kept.push(unit);
  }
  return kept;
}

export interface UnitVisitState {
  ref: UnitRef | null;
  complete: boolean | null;
}

/** A completed unit opened for browsing must not look newly completed. */
export function completedDuringVisit(
  previous: UnitVisitState,
  ref: UnitRef,
  complete: boolean,
  focused: boolean,
): boolean {
  return (
    focused &&
    previous.ref !== null &&
    refEquals(previous.ref, ref) &&
    previous.complete === false &&
    complete
  );
}

function refEquals(a: UnitRef, b: UnitRef): boolean {
  if (a.kind === 'group') return b.kind === 'group' && a.groupId === b.groupId;
  return b.kind === 'run' && a.day === b.day && a.from <= b.to && b.from <= a.to;
}

/**
 * Continue forward from a completed unit, wrapping only when the user
 * reviewed out of order. A completed unit is normally GONE from `units`
 * (its successor sits at the former index), so the scan starts one
 * before the former index — the same dissolved-group semantics the old
 * group flow had. Nothing left = the cull list.
 */
export function destinationAfterUnit(
  units: readonly TimelineUnit[],
  completed: UnitRef,
  formerIndex: number,
): UnitDestination {
  if (units.length === 0) return { kind: 'cullList' };
  const found = findUnitIndex(units, completed);
  // A unit MATCHING the completed ref can still hold pending work: run
  // identity is range OVERLAP, and a scan can dissolve a neighbouring
  // group mid-deck, merging two runs into one wider unit that matches
  // the finished range (codex r4) — new work IN PLACE is the immediate
  // next destination, not a skip. A genuinely completed unit fails
  // unitHasPending (its members were patched decided), so it cannot
  // loop back into itself.
  if (found >= 0 && unitHasPending(units[found])) return unitDestination(units[found]);
  const start = found >= 0 ? found : formerIndex >= 0 ? formerIndex - 1 : -1;
  for (let offset = 1; offset <= units.length; offset += 1) {
    const unit = units[(((start + offset) % units.length) + units.length) % units.length];
    // Pending units only: a cull-only run is a still-listed card, not a
    // destination — routing into it opens a browse deck that never
    // advances (see unitHasPending).
    if (unitHasPending(unit)) return unitDestination(unit);
  }
  return { kind: 'cullList' };
}
