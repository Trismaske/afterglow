/**
 * The browse-structure signal (m0.9 phase 8): a process-wide version
 * that only the audited MEMBERSHIP WRITERS bump, after their transaction
 * commits — the scan window (db/store.ts writeContinuousGroups), the
 * "not related" eject (ejectNotRelated), the trash confirmation
 * (db/trashStore.ts resolveTrashBatch), external-removal reconciliation
 * (reconcileExternallyRemoved) and "Forget this card"
 * (db/volumeLifecycle.ts forgetVolume). Each publishes only when its
 * transaction actually changed what the browse reads walk: a row added
 * or revived, a presence flip, an assignment, a dissolved or deleted
 * group, or a moved anchor — an identical re-scan window publishes
 * nothing. One publisher changes no membership: the photo-source
 * selection's commit (screens/SourcePickerScreen.tsx) — the scope
 * decides the browse population as surely as an assignment does, and
 * the forced rescan that follows may rewrite nothing (an all-singles
 * library).
 *
 * Verdicts never publish here: a decision changes a card's fill and
 * badges, never the set or order of units, and the Timeline's Everything
 * filter patches those in place (screens/TimelineScreen.tsx) instead of
 * re-reading its structure — the review provider's `version` bumps on
 * every decision, and resetting the browse on it was the livelock this
 * signal replaces.
 *
 * Module scope, no React: listeners are plain callbacks (the
 * lib/mountedVolumes.ts onVolumesChanged shape); the one hook over it is
 * components/useMembershipVersion.ts.
 */

let version = 0;
const listeners = new Set<() => void>();

/** The current structure version — monotonic, process-scoped. */
export function membershipVersion(): number {
  return version;
}

/** A membership writer's commit changed the browse structure. */
export function publishMembershipChange(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** Subscribe; returns the unsubscribe. */
export function onMembershipChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
