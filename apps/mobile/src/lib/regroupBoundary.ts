/**
 * The regroup boundary (m0.8 gate 2, decision 5; rewritten by m0.8.6
 * D4 — the FREEZE FOLLOWS CURRENT STATE, with no contagion). Pure
 * logic — the scan runner supplies the DB-sourced state/membership maps.
 *
 * A photo is FROZEN — its durable assignment must not be rewritten —
 * when:
 *  - it is a USER-EJECTED single (`user_single`): permanent by design;
 *  - it is decided (state left 'unreviewed'; a missing row counts as
 *    unreviewed) and NOT in a group with an undecided member;
 *  - its group carries GROUP-LEVEL review metadata (recorded compares) —
 *    a rebuild would orphan the duels. The state editor's un-review is
 *    the one deliberate act that clears this (D5: it deletes the
 *    group's duel rows), so a transient unreviewed state — a deck undo
 *    mid-Compare — never dissolves Compare work;
 *  - (m0.8.3 phase 2) its group holds an UNREACHABLE member: a pass
 *    while that member's volume is out can only see the group's mounted
 *    side, and rebuilding it would strand the unreachable photo in a
 *    rump group the <2-present repair then dissolves. Unfreezes the
 *    moment every member's volume is back.
 *
 * The m0.8.6 D4 change, stated positively: a group holding ANY
 * unreviewed member is rebuildable WHOLE — decided members included.
 * Un-reviewing one member of a finished group is what makes it
 * rebuildable, which is what un-reviewing means (Tristan, 2026-08-17
 * grilling). Accepted knowingly: this applies mid-review too — deciding
 * 1 of 5 leaves the other four AND the decided one reshapeable until
 * the group finishes (the old member-contagion rule protected that
 * window; the in-transaction assignment guards keep the WRITES safe,
 * and a Compare session self-freezes through its own duel rows).
 *
 * Frozen photos are removed from the engine's computed groups before
 * writing; a computed group left with one unfrozen member degrades to a
 * single (groups are always ≥ 2 photos).
 *
 * GROW-ONLY exception (Tristan, m0.8.3 grilling): a group frozen SOLELY
 * because a member is unreachable may still GROW — when the engine
 * clusters a new photo with that group's reachable members, the new
 * photo is APPENDED to the existing group instead of minting a
 * neighboring unit (two similar internal photos must not review as two
 * cards just because an SD sibling is away). Existing rows are never
 * touched; groups frozen for review reasons (a FINISHED group, group
 * metadata, user singles) never grow.
 */

/** The slice of a durable assignment the freeze rules consult. */
export interface AssignmentInfo {
  /** null = assigned single. */
  groupId: number | null;
  /** The USER ejected this photo to singles — never regroup it. */
  userSingle: boolean;
}

export interface ReconcileMaps {
  /** Review state per asset id (missing = no row yet = unreviewed). */
  states: ReadonlyMap<string, string>;
  /** Existing assignment per asset id (missing = none yet). */
  assignments: ReadonlyMap<string, AssignmentInfo>;
  /** Full member list of every group referenced by `assignments`. */
  groupMembers: ReadonlyMap<number, readonly string[]>;
  /** Groups carrying group-level review metadata (recorded duels). */
  metadataGroups: ReadonlySet<number>;
  /** Is this member's volume currently mounted? Absent = every member
   * reachable (the pre-m0.8.3 shape; non-scan callers and tests that
   * predate reachability pass nothing and freeze nothing extra). */
  reachable?: (photoId: string) => boolean;
}

export interface WindowFreeze {
  /** Photos whose assignments must not be rewritten. */
  frozen: Set<string>;
  /** Frozen photo → its group id, for photos frozen SOLELY by the
   * unreachable rule (photo and every member unreviewed, no metadata,
   * not user-single): those groups may GROW — new photos the engine
   * clusters with them append instead of forming a neighboring unit. */
  growable: Map<string, number>;
}

/** The window's freeze verdicts, growable groups included. */
export function windowFreeze(windowIds: readonly string[], maps: ReconcileMaps): WindowFreeze {
  const unreviewed = (id: string): boolean =>
    (maps.states.get(id) ?? 'unreviewed') === 'unreviewed';
  const frozen = new Set<string>();
  const growable = new Map<string, number>();
  for (const id of windowIds) {
    const assignment = maps.assignments.get(id);
    // Unassigned photos: frozen only by their own decided state.
    if (assignment === undefined) {
      if (!unreviewed(id)) frozen.add(id);
      continue;
    }
    // A user-ejected single is a review DECISION even though the state is
    // still 'unreviewed' — singles are never promoted back into groups.
    if (assignment.userSingle) {
      frozen.add(id);
      continue;
    }
    if (assignment.groupId === null) {
      if (!unreviewed(id)) frozen.add(id);
      continue;
    }
    // Grouped: the group's situation decides, never this photo's own
    // verdict alone (D4 — one unreviewed member makes the group
    // rebuildable whole, decided members included).
    if (maps.metadataGroups.has(assignment.groupId)) {
      frozen.add(id);
      continue;
    }
    const members = maps.groupMembers.get(assignment.groupId) ?? [];
    // A FINISHED group (every member decided) is settled work.
    if (members.every((member) => !unreviewed(member))) {
      frozen.add(id);
      continue;
    }
    // A group holding an unreachable member is frozen whole (m0.8.3):
    // only its mounted side is visible to this pass, and rebuilding a
    // group you can only half-see strands the unreachable member. This
    // is the ONE freeze reason that leaves the group growable — and
    // under D4 an unfinished mixed group's composition is explicitly
    // unsettled, so growth stays legal here too.
    if (maps.reachable && members.some((member) => !maps.reachable!(member))) {
      frozen.add(id);
      growable.set(id, assignment.groupId);
    }
  }
  return { frozen, growable };
}

/** Photos in `windowIds` whose assignments must not be rewritten. */
export function frozenPhotos(windowIds: readonly string[], maps: ReconcileMaps): Set<string> {
  return windowFreeze(windowIds, maps).frozen;
}

/** One computed group entering reconciliation. */
export interface ComputedGroup {
  members: readonly string[];
  /** Members the engine grouped by time (no embedding) — badge carriers. */
  timeAttached: readonly string[];
}

export interface PlannedGroup {
  members: string[];
  timeAttached: string[];
}

export interface WindowPlan {
  /** Multi-photo groups to write (frozen members removed). */
  groups: PlannedGroup[];
  /** Photos to write as singles (computed singles + shrunk remainders). */
  singles: string[];
  /** Grow-only: unfrozen members the engine clustered with a GROWABLE
   * frozen group, appended to it (existing member rows untouched). */
  appends: PlannedAppend[];
}

export interface PlannedAppend {
  groupId: number;
  members: string[];
  timeAttached: string[];
}

/**
 * Turn the engine's computed groups (singles included as length-1
 * groups) into the window's assignment writes, honoring the frozen set.
 * Time-attached badges survive only for members that stay grouped — a
 * remainder degraded to a single was not grouped with anyone.
 */
export function reconcileWindowGroups(
  computed: readonly ComputedGroup[],
  frozen: ReadonlySet<string>,
  /** Frozen photo → growable group id (windowFreeze). Omitted = no
   * growing (pre-grow callers and the in-transaction revalidation's
   * shrink-only pass). */
  growable?: ReadonlyMap<string, number>,
): WindowPlan {
  const groups: PlannedGroup[] = [];
  const singles: string[] = [];
  const appends: PlannedAppend[] = [];
  for (const group of computed) {
    const unfrozen = group.members.filter((id) => !frozen.has(id));
    if (unfrozen.length === 0) continue;
    // Grow-only: the engine put these unfrozen photos in one cluster
    // with a growable frozen group's reachable members — append them to
    // that group (largest member overlap wins; ties break to the lowest
    // id for determinism) instead of minting a neighboring unit.
    if (growable !== undefined) {
      const overlap = new Map<number, number>();
      for (const id of group.members) {
        const target = growable.get(id);
        if (target !== undefined) overlap.set(target, (overlap.get(target) ?? 0) + 1);
      }
      let best: number | null = null;
      for (const [groupId, n] of overlap) {
        if (
          best === null ||
          n > overlap.get(best)! ||
          (n === overlap.get(best)! && groupId < best)
        ) {
          best = groupId;
        }
      }
      if (best !== null) {
        const kept = new Set(unfrozen);
        appends.push({
          groupId: best,
          members: unfrozen,
          timeAttached: group.timeAttached.filter((id) => kept.has(id)),
        });
        continue;
      }
    }
    if (unfrozen.length >= 2) {
      const kept = new Set(unfrozen);
      groups.push({
        members: unfrozen,
        timeAttached: group.timeAttached.filter((id) => kept.has(id)),
      });
    } else {
      singles.push(...unfrozen);
    }
  }
  return { groups, singles, appends };
}
