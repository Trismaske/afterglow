/**
 * The mounted-volume set for QUERY scoping (m0.8.3 phase 3, D5/D5b) —
 * the impure provider behind "reachability is scope, not state"
 * (docs/STATE_MODEL.md). Every
 * review-scope read adds `volume_name IN (mounted)` beside
 * `is_present = 1` (store.ts `reachClause`, actions.ts `reachExists`);
 * this module answers "mounted right now?" once per
 * refresh burst, the same lifecycle as resolveSources.
 *
 * NULL means "unknowable" (module absent — Expo Go, iOS): queries then
 * apply NO predicate, showing everything — the pre-m0.8.3 behavior.
 * That fail direction is DELIBERATE and opposite to the scan's: a query
 * that cannot know hides nothing (display stays honest to the DB), while
 * a scan that cannot know must not write (it aborts instead,
 * scanRunner). Devices with the native module always answer.
 *
 * Zero writes on mount/unmount: the set is derived at read time and
 * cached for one burst; `invalidateMountedVolumes()` drops it (Home
 * focus, refresh entry points), so an eject surfaces at the next burst.
 */
import { AppState } from 'react-native';
import { getMountedVolumes, subscribeVolumesChanged } from '../../modules/media-store-actions';
import { invalidatePhotoCounts } from './media';

const TTL_MS = 5_000;
let cache: { at: number; volumes: readonly string[] | null } | null = null;
let inFlight: Promise<readonly string[] | null> | null = null;
/** Generation fence (codex phase-3): an invalidation must also stop a
 * read already in flight from re-arming the cache with the world it saw
 * before the eject. */
let generation = 0;

/** Called on Home focus and on every foreground return (the module-
 * scope listener below): the TTL bounds staleness to 5 s within a
 * burst, but a fresh entry to the app should never render even
 * 5-second-old mount state. */
export function invalidateMountedVolumes(): void {
  generation += 1;
  cache = null;
  inFlight = null;
  // A mount change moves what MediaStore's merged queries return, so the
  // 20-second count memo must fall with the mount snapshot (final cycle
  // M7) — otherwise totals cached seconds before an eject outlive it.
  invalidatePhotoCounts();
}

// Foreground return invalidates HERE, at module scope (final cycle O6):
// module evaluation precedes every component's AppState subscription, so
// this listener is guaranteed to run before any screen's reload —
// every useExternalRefresh callback reads fresh mount state.
AppState.addEventListener('change', (next) => {
  if (next === 'active') invalidateMountedVolumes();
});

/** Screen reload fan-out for LIVE mount changes (Tristan, m0.8.3
 * matrix): a card swapped while the app stays foregrounded fires no
 * AppState or navigation event — the OS MEDIA_* broadcast is the only
 * push. The module-scope subscription invalidates FIRST, then notifies,
 * so every listener's re-read sees the new world. */
const volumeChangeListeners = new Set<() => void>();
subscribeVolumesChanged(() => {
  invalidateMountedVolumes();
  for (const listener of volumeChangeListeners) listener();
});

/** Register a screen reload for live mount changes; returns unsubscribe. */
export function onVolumesChanged(listener: () => void): () => void {
  volumeChangeListeners.add(listener);
  return () => volumeChangeListeners.delete(listener);
}

/** The mounted set, or null when unknowable. Never throws. */
export async function mountedVolumeSet(): Promise<readonly string[] | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.volumes;
  if (inFlight) return inFlight;
  const myGeneration = generation;
  const pending = (async (): Promise<readonly string[] | null> => {
    try {
      return await getMountedVolumes();
    } catch {
      // Unknowable (module absent) — scope nothing rather than lie.
      return null;
    }
  })();
  inFlight = pending;
  void pending
    .then((volumes) => {
      if (myGeneration !== generation) return; // invalidated mid-flight
      // A TTL refresh that observes a DIFFERENT set is a mount change
      // nobody explicitly invalidated for (hot eject while active) — the
      // MediaStore count memo must fall with it (final cycle N2).
      const previous = cache?.volumes;
      cache = { at: Date.now(), volumes };
      if (previous !== undefined && !sameVolumeSet(previous, volumes)) invalidatePhotoCounts();
    })
    .finally(() => {
      if (inFlight === pending) inFlight = null;
    });
  return pending;
}

/** Pure: same mounted set, order-insensitive (null = unknowable only
 * equals null). Callers keeping a snapshot in React state use it to
 * preserve identity across reloads that observed no change. */
export function sameVolumeSet(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.length === b.length && a.every((v) => b.includes(v));
}

/** Pure: which of these per-volume count entries are unreachable, with
 * their photo counts — the naming surfaces' number ("SD card not
 * mounted — 214 photos waiting on it"). Null mounted = nothing is
 * unreachable (unknowable ⇒ no claims). */
export function unreachableCounts(
  trackedByVolume: Readonly<Record<string, number>>,
  mounted: readonly string[] | null,
): { volume: string; count: number }[] {
  if (mounted === null) return [];
  const set = new Set(mounted);
  return Object.entries(trackedByVolume)
    .filter(([volume, count]) => !set.has(volume) && count > 0)
    .map(([volume, count]) => ({ volume, count }));
}
