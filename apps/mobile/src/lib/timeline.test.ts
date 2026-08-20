import { describe, expect, it } from 'vitest';
import type { PhotoState } from '@afterglow/core';
import type { ReviewGroupRow, ReviewMemberRow } from '../db/store';
import {
  anchorIndexIn,
  appendBrowseItems,
  browseItemTime,
  buildTimeline,
  EMPTY_BROWSE_ASSEMBLY,
  flushBrowseTail,
  unreviewedOnly,
  type BrowseItem,
  completedDuringVisit,
  destinationAfterUnit,
  findUnitIndex,
  firstPendingUnit,
  needsDeeperPages,
  sameUnitRefs,
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
    const empty = { groupId: 9, members: [] };
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

describe('the browse assembler (m0.8.6 F2: the Everything filter)', () => {
  const day = '2026-07-12';
  const other = '2026-07-11';

  /** The merged stream the pager emits: globally descending by
   * browseItemTime. */
  const stream = (items: BrowseItem[]) =>
    [...items].sort((a, b) => browseItemTime(b) - browseItemTime(a));

  it('assembles the SAME units buildTimeline would from one whole stream (D2: consistency)', () => {
    const groups = [
      group(1, [member('a2', 50, day, 'kept'), member('a1', 40, day, 'kept')]),
      group(2, [member('b2', 20, day), member('b1', 10, day)]),
    ];
    const singles = [
      member('s6', 60, day, 'kept'),
      member('s3', 30, day),
      member('s2', 25, other, 'culled'),
    ];
    const expected = buildTimeline(groups, singles, NOT_FULL);
    const items = stream([
      ...groups.map((g) => ({ kind: 'group' as const, group: g })),
      ...singles.map((m) => ({ kind: 'single' as const, member: m })),
    ]);
    const assembled = flushBrowseTail(appendBrowseItems(EMPTY_BROWSE_ASSEMBLY, items));
    expect(assembled.map(ids)).toEqual(expected.map(ids));
    expect(assembled.map((u) => u.kind)).toEqual(expected.map((u) => u.kind));
  });

  it('keeps the tail run OPEN across batches — the next page may extend it', () => {
    const first = appendBrowseItems(EMPTY_BROWSE_ASSEMBLY, [
      { kind: 'single', member: member('s3', 30, day, 'kept') },
      { kind: 'single', member: member('s2', 25, day, 'kept') },
    ]);
    // Nothing finished yet: the run could still grow.
    expect(first.units).toEqual([]);
    expect(first.openRun.map((m) => m.asset_id)).toEqual(['s3', 's2']);
    // The next batch extends the same day, then a group closes it.
    const second = appendBrowseItems(first, [
      { kind: 'single', member: member('s1', 20, day) },
      { kind: 'group', group: group(7, [member('g1', 10, day)]) },
    ]);
    expect(second.units.map(ids)).toEqual([['s3', 's2', 's1'], ['g1']]);
    expect(second.openRun).toEqual([]);
  });

  it('a day boundary inside a batch closes the run exactly like buildTimeline', () => {
    const a = appendBrowseItems(EMPTY_BROWSE_ASSEMBLY, [
      { kind: 'single', member: member('s2', 25, day) },
      { kind: 'single', member: member('s1', 20, other) },
    ]);
    expect(a.units.map(ids)).toEqual([['s2']]);
    expect(flushBrowseTail(a).map(ids)).toEqual([['s2'], ['s1']]);
  });

  it('flushBrowseTail closes the run only at exhaustion; empty groups are dropped', () => {
    const a = appendBrowseItems(EMPTY_BROWSE_ASSEMBLY, [
      { kind: 'group', group: group(9, []) },
      { kind: 'single', member: member('s1', 20, day) },
    ]);
    expect(a.units).toEqual([]);
    const flushed = flushBrowseTail(a);
    expect(flushed.map(ids)).toEqual([['s1']]);
    // Flushing does not mutate: the assembly can flush again.
    expect(flushBrowseTail(a).map(ids)).toEqual([['s1']]);
  });
});

describe('unreviewedOnly (m0.8.6 D3)', () => {
  const day = '2026-07-12';

  it('keeps units with pending work, hides staged-cull singles inside runs', () => {
    const units = buildTimeline(
      [group(1, [member('a2', 50, day, 'kept'), member('a1', 40, day)])],
      [member('s3', 30, day), member('s2', 25, day, 'culled')],
      NOT_FULL,
    );
    const filtered = unreviewedOnly(units);
    // The mixed group renders WHOLE (cards never hide members)…
    expect(filtered.map(ids)).toEqual([
      ['a2', 'a1'],
      ['s3'], // …but the run's staged single is hidden.
    ]);
  });

  it('an all-staged run and a finished group vanish — no undecided work', () => {
    const units = buildTimeline(
      [group(1, [member('a1', 40, day, 'kept')])],
      [member('s2', 25, day, 'culled')],
      NOT_FULL,
    );
    expect(unreviewedOnly(units)).toEqual([]);
  });
});

describe('anchorIndexIn (m0.8.6 device pass: filter-switch landing)', () => {
  const day = '2026-05-09';
  // Newest-first: group 1 (t=100), run (t=80..70), group 2 (t=50).
  const units = buildTimeline(
    [group(1, [member('a2', 100, day), member('a1', 95, day)])],
    [member('s2', 80, day), member('s1', 70, day)],
    NOT_FULL,
  );
  const target = [...units, ...buildTimeline([group(2, [member('b1', 50, day)])], [], NOT_FULL)];

  it('the same unit wins: a group by id wherever it sits', () => {
    const anchor = { ref: { kind: 'group' as const, groupId: '2' }, newestAt: 50 };
    expect(anchorIndexIn(target, anchor, false)).toBe(2);
  });

  it('a run matches by day + range overlap, not exact bounds', () => {
    // The other filter loaded the run wider (70..80 vs a 75..75 slice).
    const anchor = { ref: { kind: 'run' as const, day, from: 75, to: 75 }, newestAt: 75 };
    expect(anchorIndexIn(target, anchor, false)).toBe(1);
  });

  it('a missing unit lands on the first at-or-older unit', () => {
    // t=60 sits between the run (80) and group 2 (50) — group 2 is the
    // closest content a newest-first list can show.
    const anchor = { ref: { kind: 'group' as const, groupId: '99' }, newestAt: 60 };
    expect(anchorIndexIn(target, anchor, false)).toBe(2);
  });

  it('older than everything loaded: clampToEnd picks the last unit (complete pending reads)', () => {
    const anchor = { ref: { kind: 'group' as const, groupId: '99' }, newestAt: 5 };
    expect(anchorIndexIn(target, anchor, true)).toBe(target.length - 1);
  });

  it('older than everything loaded: the incremental browse read sends the caller to the top', () => {
    const anchor = { ref: { kind: 'group' as const, groupId: '99' }, newestAt: 5 };
    expect(anchorIndexIn(target, anchor, false)).toBeNull();
  });

  it('empty target data is a top jump regardless of clamping', () => {
    const anchor = { ref: { kind: 'group' as const, groupId: '1' }, newestAt: 100 };
    expect(anchorIndexIn([], anchor, true)).toBeNull();
  });
});

describe('needsDeeperPages (codex r7: the page-toward hold predicate)', () => {
  const day = '2026-05-09';
  // Loaded frontier: group 1 (t=100), then the run (t=80..70).
  const loaded = buildTimeline(
    [group(1, [member('a2', 100, day), member('a1', 95, day)])],
    [member('s2', 80, day), member('s1', 70, day)],
    NOT_FULL,
  );

  it('an empty stream always pages', () => {
    expect(needsDeeperPages([], { ref: { kind: 'group', groupId: '1' }, newestAt: 100 })).toBe(
      true,
    );
  });

  it('an anchor past the frontier pages deeper', () => {
    expect(needsDeeperPages(loaded, { ref: { kind: 'group', groupId: '9' }, newestAt: 50 })).toBe(
      true,
    );
  });

  it('a frontier TIE without the unit loaded keeps paging (equal capture times split across a page boundary)', () => {
    // t=80 equals the frontier (the run's newest member), but group 9
    // is not here — it can still open the next page.
    expect(needsDeeperPages(loaded, { ref: { kind: 'group', groupId: '9' }, newestAt: 80 })).toBe(
      true,
    );
  });

  it('a frontier tie WITH the unit loaded lands now', () => {
    const anchor = { ref: { kind: 'run' as const, day, from: 70, to: 80 }, newestAt: 80 };
    expect(needsDeeperPages(loaded, anchor)).toBe(false);
  });

  it('a frontier past the anchor stops paging — the nearest fallback takes over', () => {
    // t=90 sits between group 1 (100) and the run (80): the frontier
    // has already streamed past it, so more pages cannot help.
    expect(needsDeeperPages(loaded, { ref: { kind: 'group', groupId: '9' }, newestAt: 90 })).toBe(
      false,
    );
  });

  it('a loaded unit shallower than the frontier lands now', () => {
    expect(needsDeeperPages(loaded, { ref: { kind: 'group', groupId: '1' }, newestAt: 100 })).toBe(
      false,
    );
  });
});

describe('browseItemTime honours the query-minted anchor (codex r1+r5)', () => {
  const day = '2026-05-09';
  it("a group's merge key is the query-minted anchor, wherever the read minted it", () => {
    // Whatever the heads query minted (since codex r5: the whole
    // reachable group's newest, matching the projection) is the merge
    // key — members[0] must never override it.
    const g: BrowseItem = {
      kind: 'group',
      group: { groupId: 7, anchor: 50, members: [member('out', 90, day), member('in', 50, day)] },
    };
    expect(browseItemTime(g)).toBe(50);
    // No anchor minted (the pending read): the newest member stands.
    const bare: BrowseItem = {
      kind: 'group',
      group: { groupId: 8, members: [member('a', 70, day)] },
    };
    expect(browseItemTime(bare)).toBe(70);
  });

  it('the assembled unit newestAt matches the merge key, keeping anchorIndexIn monotone', () => {
    const g: BrowseItem = {
      kind: 'group',
      group: { groupId: 7, anchor: 50, members: [member('out', 90, day), member('in', 50, day)] },
    };
    const assembly = appendBrowseItems(EMPTY_BROWSE_ASSEMBLY, [g]);
    expect(assembly.units[0].newestAt).toBe(50);
  });
});

describe('sameUnitRefs (the one switch rule, final device pass)', () => {
  it('groups by id; runs by day + range overlap; kinds never cross', () => {
    expect(sameUnitRefs({ kind: 'group', groupId: '7' }, { kind: 'group', groupId: '7' })).toBe(
      true,
    );
    expect(sameUnitRefs({ kind: 'group', groupId: '7' }, { kind: 'group', groupId: '8' })).toBe(
      false,
    );
    const day = '2026-05-09';
    expect(
      sameUnitRefs({ kind: 'run', day, from: 10, to: 20 }, { kind: 'run', day, from: 15, to: 30 }),
    ).toBe(true);
    expect(
      sameUnitRefs({ kind: 'run', day, from: 10, to: 20 }, { kind: 'run', day, from: 21, to: 30 }),
    ).toBe(false);
    expect(
      sameUnitRefs({ kind: 'run', day, from: 10, to: 20 }, { kind: 'group', groupId: '7' }),
    ).toBe(false);
  });
});
