/**
 * Field performance logging — ON in every build until v1 (m0.8.2).
 *
 * The `[perf]` lines are how the cold-start regressions were found (a
 * 35 s source-catalog rebuild, a 44 s first queue read), and they exist
 * to catch the next one on a TESTER'S phone. m0.8.1 gated them to
 * `__DEV__` to save a bridge call; that had it backwards on two counts:
 *
 * - Every on-device acceptance pass runs a RELEASE build — the UI gate
 *   relaunches through the launcher intent, which a dev-client answers
 *   with its "connect to a server" screen. So the tripwires were armed
 *   only in the build nobody ships.
 * - A timing measured on a dev bundle is not a claim about the app:
 *   unminified, through the dev bridge. Dev-only perf logs can only ever
 *   measure the wrong build.
 *
 * The cost they were gated for barely exists: the message is a THUNK, so
 * a disabled call formats nothing, and every call site is cold-path (a
 * catalog build, the first queue refresh, a Stats tab's first open). The
 * `[scan]` lines have always logged unconditionally in release.
 *
 * v1 hardens this — gate it, or put a real Settings toggle behind
 * `setPerfLogging` (docs/TODO.md, "Re-gate the [perf] logs at v1").
 * Pre-v1 the builds go to
 * friends with a debug keystore, and diagnostics are the point.
 */

let enabled = true;

/** Force perf logging on/off (a future Settings toggle; tests). */
export function setPerfLogging(value: boolean): void {
  enabled = value;
}

export function perfLoggingEnabled(): boolean {
  return enabled;
}

/**
 * Log a `[perf]` line when enabled. The message is a THUNK so callers pay
 * no string interpolation in release builds.
 */
export function perfLog(message: () => string): void {
  if (!enabled) return;
  console.log(`[perf] ${message()}`);
}

/** Samples settle into one line after this much quiet. */
const AGGREGATE_QUIET_MS = 10_000;

interface Aggregate {
  samples: number[];
  items: number;
  timer: ReturnType<typeof setTimeout>;
}

const aggregates = new Map<string, Aggregate>();

/**
 * Aggregate a repeating measurement instead of logging per occurrence
 * (m0.8.7 audit shape rule: the timeline's per-page line flooded the
 * sink one line per scroll page). Samples for a key accumulate; after
 * ten quiet seconds ONE line lands with count, min–max and median (plus
 * an item total when given). A one-off measurement still uses perfLog.
 */
export function perfAggregate(key: string, ms: number, items = 0): void {
  if (!enabled) return;
  const existing = aggregates.get(key);
  if (existing) clearTimeout(existing.timer);
  const aggregate: Aggregate = {
    samples: existing ? [...existing.samples, ms] : [ms],
    items: (existing?.items ?? 0) + items,
    timer: setTimeout(() => {
      aggregates.delete(key);
      const sorted = [...aggregate.samples].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      console.log(
        `[perf] ${key}: ${sorted.length} samples, ${sorted[0]}–${sorted[sorted.length - 1]} ms ` +
          `(median ${median}${aggregate.items > 0 ? `, ${aggregate.items} items` : ''})`,
      );
    }, AGGREGATE_QUIET_MS),
  };
  aggregates.set(key, aggregate);
}
