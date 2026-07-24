export interface GroupProgress {
  id: string;
  complete: boolean;
}

export type GroupCompletionDestination =
  { screen: 'Deck'; groupId: string } | { screen: 'Singles' } | { screen: 'CullList' };

export interface GroupVisitState {
  groupId: string | null;
  complete: boolean | null;
}

/** A completed group opened for browsing must not look newly completed. */
export function completedDuringVisit(
  previous: GroupVisitState,
  groupId: string,
  complete: boolean,
  focused: boolean,
): boolean {
  return focused && previous.groupId === groupId && previous.complete === false && complete;
}

/**
 * Continue forward from a completed group, wrapping only when the user
 * reviewed groups out of order. Completed groups are never reopened by the
 * automatic flow. A DISSOLVED group (pair broken by "Not related", C#6) is
 * no longer in `groups` — pass its former index so the scan still starts
 * from its old position instead of the top of the list.
 */
export function destinationAfterGroup(
  groups: readonly GroupProgress[],
  completedGroupId: string,
  hasPendingSingles: boolean,
  dissolvedFormerIndex?: number,
): GroupCompletionDestination {
  const completedIndex = groups.findIndex((group) => group.id === completedGroupId);
  // After a dissolve the array shifted: the group now AT the former index
  // is the immediate successor, so the scan starts one before it.
  const start =
    completedIndex >= 0
      ? completedIndex
      : dissolvedFormerIndex !== undefined && dissolvedFormerIndex >= 0
        ? dissolvedFormerIndex - 1
        : -1;

  for (let offset = 1; offset <= groups.length; offset += 1) {
    const group = groups[(start + offset) % groups.length];
    if (group.id !== completedGroupId && !group.complete) {
      return { screen: 'Deck', groupId: group.id };
    }
  }

  return hasPendingSingles ? { screen: 'Singles' } : { screen: 'CullList' };
}
