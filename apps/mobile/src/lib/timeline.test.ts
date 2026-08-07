import { describe, expect, it } from 'vitest';
import type { PhotoState } from '@afterglow/core';
import type { ReviewGroupRow, ReviewMemberRow } from '../db/store';
import {
  buildTimeline,
  completedDuringVisit,
  destinationAfterUnit,
  findUnitIndex,
  firstPendingUnit,
  unitDestination,
  unitHasPending,
  type TimelineRunUnit,
  type TimelineUnit,
} from './timeline';
import { UNDATED_DAY_KEY } from './dates';

const member = (
  id: string,
  takenAt: number,
  day: string | null,
  state: PhotoState = 'unreviewed',
): ReviewMemberRow => ({
  asset_id: id,
  uri: `file://${id}`,
  taken_at: takenAt,
  day,
  state,
  needs_edit: 0,
  time_attached: 0,
});

/** Members NEWEST-first, like the store returns them (m0.8.2). */
const group = (groupId: number, members: ReviewMemberRow[]): ReviewGroupRow => ({
  groupId,
  bestPhotoId: null,
  members,
});

const ids = (unit: TimelineUnit): string[] =>
  unit.kind === 'group'
    ? unit.group.members.map((m) => m.asset_id)
    : unit.members.map((m) => m.asset_id);

/** Read-time page tails (timeline.ts): not-full pages, no truncation. */
const NOT_FULL = { groupsTail: null, singlesTail: null };

describe('buildTimeline', () => {
  const day = '2026-07-12';

  it('interleaves singles runs between groups by capture time, newest first', () => {
    // Times: s6 @60 · group A (40-50) · s3 @30, s2 @25 · group B (10-20).
    // listReviewGroups is newest-first — the array is ordered that way.
    const orderedGroups = [
      group(1, [member('a2', 50, day), member('a1', 40, day)]),
      group(2, [member('b2', 20, day), member('b1', 10, day)]),
    ];
    const singles = [member('s6', 60, day), member('s3', 30, day), member('s2', 25, day)];
    const units = buildTimeline(orderedGroups, singles, NOT_FULL);
    expect(units.map((u) => u.kind)).toEqual(['run', 'group', 'run', 'group']);
    // Run members are NEWEST-first (the singles decks' page order —
    // Tristan's call); group members stay chronological.
    expect(units.map(ids)).toEqual([['s6'], ['a2', 'a1'], ['s3', 's2'], ['b2', 'b1']]);
    // The inclusive range is orientation-free: from = oldest, to = newest.
    const run = units[2] as TimelineRunUnit;
    expect(run.from).toBe(25);
    expect(run.to).toBe(30);
    expect(run.day).toBe(day);
  });

  it('splits runs at day boundaries', () => {
    const singles = [
      member('t2', 200, '2026-07-13'),
      member('t1', 150, '2026-07-13'),
      member('m1', 100, '2026-07-12'),
    ];
    const units = buildTimeline([], singles, NOT_FULL);
    expect(units.map(ids)).toEqual([['t2', 't1'], ['m1']]);
    expect((units[0] as TimelineRunUnit).day).toBe('2026-07-13');
    expect((units[1] as TimelineRunUnit).day).toBe('2026-07-12');
  });

  it('undated singles form their own runs under the pseudo-day, placed by their fallback timestamp', () => {
    const singles = [
      member('d1', 300, '2026-07-13'),
      member('u1', 200, null),
      member('d0', 100, '2026-07-12'),
    ];
    const units = buildTimeline([], singles, NOT_FULL);
    expect(units.map(ids)).toEqual([['d1'], ['u1'], ['d0']]);
    expect((units[1] as TimelineRunUnit).day).toBe(UNDATED_DAY_KEY);
  });

  it('a tie between a single and a group anchor keeps the single (and its run) first', () => {
    const g = group(1, [member('g2', 50, '2026-07-12'), member('g1', 40, '2026-07-12')]);
    const singles = [member('s1', 50, '2026-07-12')];
    const units = buildTimeline([g], singles, NOT_FULL);
    expect(units.map(ids)).toEqual([['s1'], ['g2', 'g1']]);
  });

  it('truncates below the horizon when the GROUP page is full', () => {
    // The group page was read FULL with tail anchor 100, so singles
    // older than that anchor may have unloaded groups between them and
    // must not be placed.
    const g = group(1, [member('g2', 100, '2026-07-12'), member('g1', 90, '2026-07-12')]);
    const singles = [
      member('s2', 150, '2026-07-12'),
      member('s1', 95, '2026-07-12'),
      member('s0', 50, '2026-07-12'),
    ];
    const units = buildTimeline([g], singles, { groupsTail: 100, singlesTail: null });
    expect(units.map(ids)).toEqual([['s2'], ['g2', 'g1']]);
  });

  it('trims a run straddling the horizon and keeps its surviving members', () => {
    const g = group(1, [member('g2', 100, '2026-07-12'), member('g1', 90, '2026-07-12')]);
    const singles = [member('s2', 150, '2026-07-12'), member('s1', 120, '2026-07-12')];
    // Singles page read full with tail 120: both singles stand, but the
    // group below the horizon is dropped.
    const units = buildTimeline([g], singles, { groupsTail: null, singlesTail: 120 });
    expect(units.map(ids)).toEqual([['s2', 's1']]);
  });

  it('an empty queue is an empty timeline', () => {
    expect(buildTimeline([], [], NOT_FULL)).toEqual([]);
  });

  it('keeps truncating after a patch shrinks a FULL page (fullness is a read-time fact)', () => {
    // Read time: the singles page came back full with tail 120. An
    // optimistic keep then removed a row — the source still continues
    // past the READ-TIME tail, so groups below it stay truncated.
    // Re-deriving the tail from the patched length either dissolved the
    // horizon (this fixture) or jumped it forward past loaded units.
    const g = group(1, [member('g2', 100, '2026-07-12'), member('g1', 90, '2026-07-12')]);
    const patchedSingles = [member('s2', 150, '2026-07-12'), member('s1', 120, '2026-07-12')];
    const units = buildTimeline([g], patchedSingles, { groupsTail: null, singlesTail: 120 });
    expect(units.map(ids)).toEqual([['s2', 's1']]);
  });

  it('a full page patched down to EMPTY truncates everything from the other source', () => {
    // The full singles page (read-time tail 120) was optimistically
    // decided down to empty. The READ-TIME tail still governs: the
    // group below it stays truncated — but unlike a fullness flag, a
    // group ABOVE the tail would still render, because the tail is a
    // fact about the source, not about the patched array.
    const g = group(1, [member('g1', 100, '2026-07-12')]);
    const units = buildTimeline([g], [], { groupsTail: null, singlesTail: 120 });
    expect(units).toEqual([]);
    const above = group(2, [member('g9', 150, '2026-07-12')]);
    expect(buildTimeline([above], [], { groupsTail: null, singlesTail: 120 }).map(ids)).toEqual([
      ['g9'],
    ]);
  });

  it('drops a memberless group instead of anchoring it at the epoch', () => {
    const empty = { groupId: 9, bestPhotoId: null, members: [] };
    const g = group(1, [member('g1', 100, '2026-07-12')]);
    const units = buildTimeline([empty, g], [], { groupsTail: 100, singlesTail: null });
    expect(units.map(ids)).toEqual([['g1']]);
  });
});

describe('destinationAfterUnit', () => {
  const day = '2026-07-12';
  const units = (): TimelineUnit[] =>
    buildTimeline(
      [
        group(1, [member('a2', 50, day), member('a1', 40, day)]),
        group(2, [member('b2', 20, day), member('b1', 10, day)]),
      ],
      [member('s1', 30, day), member('s0', 25, day)],
      NOT_FULL,
    ); // [group 1, run(s0..s1), group 2]

  it('advances from a completed unit’s FORMER index to the successor', () => {
    // Group 1 completed and left the list — the run slid into index 0.
    const remaining = units().slice(1);
    expect(destinationAfterUnit(remaining, { kind: 'group', groupId: '1' }, 0)).toEqual({
      kind: 'run',
      day,
      from: 25,
      to: 30,
    });
  });

  it('a completed run advances to the next group', () => {
    const remaining = units().filter((u) => u.kind === 'group');
    expect(destinationAfterUnit(remaining, { kind: 'run', day, from: 25, to: 30 }, 1)).toEqual({
      kind: 'group',
      groupId: '2',
    });
  });

  it('wraps to an earlier unit after out-of-order review', () => {
    // Group 2 (last) completed first; group 1 and the run remain.
    const remaining = units().slice(0, 2);
    expect(destinationAfterUnit(remaining, { kind: 'group', groupId: '2' }, 2)).toEqual({
      kind: 'group',
      groupId: '1',
    });
  });

  it('a still-listed completed unit with NO pending is skipped, not returned', () => {
    // Post-patch reality: the completed group's members read decided in
    // the stale timeline, so unitHasPending excludes it.
    const all = buildTimeline(
      [
        group(1, [member('a2', 50, day, 'kept'), member('a1', 40, day, 'kept')]),
        group(2, [member('b2', 20, day), member('b1', 10, day)]),
      ],
      [member('s1', 30, day), member('s0', 25, day)],
      NOT_FULL,
    );
    expect(destinationAfterUnit(all, { kind: 'group', groupId: '1' }, 0)).toEqual({
      kind: 'run',
      day,
      from: 25,
      to: 30,
    });
  });

  it('routes INTO a widened run that overlap-matches the completed range', () => {
    // The deck finished [25,30]; a scan dissolved the separating group
    // mid-deck and merged the next run in. The wider unit [10,30] still
    // holds pending photos — it is the immediate next work, not a skip.
    const widened = buildTimeline(
      [],
      [
        member('s1', 30, day, 'kept'),
        member('s0', 25, day, 'kept'),
        member('r1', 15, day),
        member('r0', 10, day),
      ],
      NOT_FULL,
    );
    expect(destinationAfterUnit(widened, { kind: 'run', day, from: 25, to: 30 }, 0)).toEqual({
      kind: 'run',
      day,
      from: 10,
      to: 30,
    });
  });

  it('nothing left goes to the cull list', () => {
    expect(destinationAfterUnit([], { kind: 'group', groupId: '1' }, 0)).toEqual({
      kind: 'cullList',
    });
  });

  it('skips a cull-only run — a browseable card is not a destination', () => {
    // The singles feed keeps staged culls, so run A stays listed after
    // its last unreviewed member was culled. Completing group 2 with A
    // as the only other unit must go to the cull list, not open A's
    // browse deck (which never advances).
    const culledRun = [member('s1', 30, day, 'culled'), member('s0', 25, day, 'culled')];
    const remaining = buildTimeline([], culledRun, NOT_FULL);
    expect(remaining).toHaveLength(1);
    expect(unitHasPending(remaining[0])).toBe(false);
    expect(destinationAfterUnit(remaining, { kind: 'group', groupId: '2' }, 1)).toEqual({
      kind: 'cullList',
    });
  });

  it('firstPendingUnit skips a cull-only head run', () => {
    const units = buildTimeline(
      [group(1, [member('g1', 10, day)])],
      [member('s1', 30, day, 'culled')],
      NOT_FULL,
    );
    expect(units).toHaveLength(2);
    expect(firstPendingUnit(units)).toBe(units[1]);
  });
});

describe('unit identity', () => {
  const day = '2026-07-12';

  it('finds a rebuilt (shrunken) run by day + range overlap', () => {
    // The deck opened the run as [25, 30]; a keep left only s1, so the
    // rebuilt run is [30, 30] — still the same unit.
    const rebuilt = buildTimeline([], [member('s1', 30, day)], NOT_FULL);
    expect(findUnitIndex(rebuilt, { kind: 'run', day, from: 25, to: 30 })).toBe(0);
    // A different day never matches, whatever the range.
    expect(findUnitIndex(rebuilt, { kind: 'run', day: '2026-07-13', from: 25, to: 30 })).toBe(-1);
  });

  it('unitDestination round-trips a run’s scope into route params', () => {
    const [run] = buildTimeline([], [member('s1', 30, day), member('s0', 25, day)], NOT_FULL);
    expect(unitDestination(run)).toEqual({ kind: 'run', day, from: 25, to: 30 });
  });
});

describe('completedDuringVisit', () => {
  const ref = { kind: 'group', groupId: 'g1' } as const;

  it('advances only on an incomplete-to-complete transition in the active unit', () => {
    expect(completedDuringVisit({ ref, complete: false }, ref, true, true)).toBe(true);
    expect(completedDuringVisit({ ref, complete: true }, ref, true, true)).toBe(false);
    expect(
      completedDuringVisit({ ref, complete: false }, { kind: 'group', groupId: 'g2' }, true, true),
    ).toBe(false);
  });

  it('defers the transition while another screen is focused', () => {
    expect(completedDuringVisit({ ref, complete: false }, ref, true, false)).toBe(false);
  });
});
