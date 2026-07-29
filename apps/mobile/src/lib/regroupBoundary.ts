/**
 * The regroup boundary (m0.8 gate 2, Plan_m0.8.md decision 5): the
 * continuous scan rebuilds ONLY all-unreviewed groups. Pure logic — the
 * scan runner supplies the DB-sourced state/membership maps.
 *
 * A photo is FROZEN — its durable assignment must not be rewritten — when
 * its own review state has left 'unreviewed' (a missing row counts as
 * unreviewed: the photo has never been seen), when it is currently
 * assigned to a group any of whose members has left 'unreviewed'
 * (rebuilding around a reviewed member would silently reshape a group
 * the user already worked through), or when its group carries
 * GROUP-LEVEL review metadata (a starred best, recorded compares) — a
 * rebuild would discard the star and orphan the duels even though every
 * member is still 'unreviewed'.
 *
 * Frozen photos are removed from the engine's computed groups before
 * writing; a computed group left with one unfrozen member degrades to a
 * single (groups are always ≥ 2 photos).
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
  /** Groups carrying group-level review metadata (best star, duels). */
  metadataGroups: ReadonlySet<number>;
}

/** Photos in `windowIds` whose assignments must not be rewritten. */
export function frozenPhotos(windowIds: readonly string[], maps: ReconcileMaps): Set<string> {
  const unreviewed = (id: string): boolean =>
    (maps.states.get(id) ?? 'unreviewed') === 'unreviewed';
  const frozen = new Set<string>();
  for (const id of windowIds) {
    if (!unreviewed(id)) {
      frozen.add(id);
      continue;
    }
    const assignment = maps.assignments.get(id);
    if (assignment === undefined) continue;
    // A user-ejected single is a review DECISION even though the state is
    // still 'unreviewed' — singles are never promoted back into groups.
    if (assignment.userSingle) {
      frozen.add(id);
      continue;
    }
    if (assignment.groupId === null) continue;
    if (maps.metadataGroups.has(assignment.groupId)) {
      frozen.add(id);
      continue;
    }
    const members = maps.groupMembers.get(assignment.groupId) ?? [];
    if (members.some((member) => !unreviewed(member))) frozen.add(id);
  }
  return frozen;
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
): WindowPlan {
  const groups: PlannedGroup[] = [];
  const singles: string[] = [];
  for (const group of computed) {
    const unfrozen = group.members.filter((id) => !frozen.has(id));
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
  return { groups, singles };
}
