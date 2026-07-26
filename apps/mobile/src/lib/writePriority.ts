/**
 * Write-priority gate (m0.8, vetted fix): USER writes must never queue
 * seconds behind the continuous scan's window transactions. Interactive
 * write paths mark themselves active; the scan awaits the gate at every
 * yield point (window boundaries, per-photo embed persists) so a pending
 * decision reaches SQLite next instead of after a burst of scan writes.
 *
 * The wait is BOUNDED (a hung user write must not stall the scan
 * forever) and the gate is deliberately conservative: it only delays
 * scan-side writes — user writes never wait on anything here.
 */

let activeUserWrites = 0;
let waiters: (() => void)[] = [];
/** Set when a yield timed out against a HUNG write: later yields bypass
 * the gate instantly instead of re-waiting 10 s each (which would
 * throttle a whole scan behind one stuck write). A fresh user write or a
 * fully cleared gate re-arms it. */
let hungBypass = false;

/** Longest a scan yield waits on the gate — a safety bound, not a
 * scheduling knob (the gate normally clears in milliseconds). */
const MAX_YIELD_WAIT_MS = 10_000;

function releaseWaiters(): void {
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve();
}

/** Run an interactive write with priority over the scan. */
export async function withUserWritePriority<T>(fn: () => Promise<T>): Promise<T> {
  activeUserWrites += 1;
  hungBypass = false; // a fresh write deserves fresh priority
  try {
    return await fn();
  } finally {
    activeUserWrites = Math.max(0, activeUserWrites - 1);
    if (activeUserWrites === 0) {
      hungBypass = false;
      releaseWaiters();
    }
  }
}

/** Scan-side yield: resolves when no user write is active (or after the
 * safety bound). Cheap no-op when the gate is clear. */
export function waitForUserWrites(): Promise<void> {
  if (activeUserWrites === 0 || hungBypass) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== wrapped);
      hungBypass = true; // one timeout opens the gate for everyone
      resolve();
    }, MAX_YIELD_WAIT_MS);
    const wrapped = () => {
      clearTimeout(timer);
      resolve();
    };
    waiters.push(wrapped);
  });
}

/** Test hook: observable gate state. */
export function userWritesActive(): number {
  return activeUserWrites;
}
