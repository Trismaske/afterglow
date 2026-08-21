/**
 * The in-app diagnostics log (m0.8.7) — impure wiring over the pure
 * shaping in lib/diagShape.ts and the native rotating file sink
 * (modules/diag-log: 50 MB as ten 5 MB segments in the app's
 * external-files dir, `adb pull`-able, surviving locks and reboots).
 *
 * CONSOLE IS THE DIAGNOSTICS API. The 2026-08-21 log-site audit found
 * every one of the app's 85 log emissions already field-curated — zero
 * dev noise — so instead of rewriting every site, initDiagLog() HOOKS
 * console.log/warn/error: each line keeps printing to logcat exactly as
 * before, and additionally persists with its own timestamp. New code
 * keeps calling console.* — a new line is a new diagnostic by contract,
 * and dev noise stays banned. The audit's shape rules are implemented
 * here (identical-line suppression with summaries) and in lib/perfLog.ts
 * (the timeline per-page line aggregates before reaching console).
 *
 * Also installed: the GLOBAL JS ERROR HOOK — before this, a release
 * crash recorded nothing at all. A fatal error's message and stack
 * enqueue and flush immediately, then the previous handler (RN's) runs
 * unchanged. The provider-stack error boundary
 * (components/DiagErrorBoundary.tsx) adds the component stack for render
 * crashes the same way.
 *
 * Diagnostics means faults and timings, NEVER user behavior (the
 * analytics question is parked in PLAN.md with its own trigger). No
 * scrubbing in this slice: every routed line already prints to logcat,
 * so the sink adds device-local persistence, not new exposure —
 * scrub-or-disclose gates the parked EXPORT design instead.
 *
 * Failure stance: if the native append throws, the affected lines are
 * dropped (never requeued — an unbounded retry queue is its own bug),
 * loudly once per session through the ORIGINAL console so the hook can
 * never feed itself. Without the native module (a stale dev client, a
 * future non-Android build) init is a no-op and logcat remains the only
 * sink.
 */
import { appendDiagLines, diagSinkAvailable } from '../../modules/diag-log';
import { createRepeatSuppressor, formatDiagLine, joinConsoleArgs } from './diagShape';

const FLUSH_INTERVAL_MS = 3_000;
const FLUSH_THRESHOLD = 100;
/** Memory guard: past this many buffered lines the oldest drop. */
const QUEUE_CAP = 2_000;

type Level = 'log' | 'warn' | 'error';
const LEVEL_CHAR: Record<Level, 'I' | 'W' | 'E'> = { log: 'I', warn: 'W', error: 'E' };

let installed = false;

export function initDiagLog(): void {
  if (installed) return;
  installed = true;
  if (!diagSinkAvailable()) return;

  const original: Record<Level, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const suppressor = createRepeatSuppressor();
  const queue: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let warnedSinkFailure = false;
  let inHook = false;

  const flush = async (): Promise<void> => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (flushing) return; // the running flush reschedules if lines remain
    flushing = true;
    try {
      const now = Date.now();
      for (const summary of suppressor.sweep(now)) {
        queue.push(formatDiagLine('I', summary, now));
      }
      while (queue.length > 0) {
        const lines = queue.splice(0);
        try {
          await appendDiagLines(lines);
        } catch (error) {
          if (!warnedSinkFailure) {
            warnedSinkFailure = true;
            original.warn('[diag] sink append failed — these lines exist only in logcat:', error);
          }
          break; // dropped by design; the next flush tries fresh lines
        }
      }
    } finally {
      flushing = false;
      if (queue.length > 0) scheduleFlush(true);
    }
  };

  const scheduleFlush = (immediate = false): void => {
    if (immediate) {
      void flush();
      return;
    }
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
  };

  const enqueue = (level: Level, args: readonly unknown[], immediate = false): void => {
    const at = Date.now();
    const message = joinConsoleArgs(args);
    const verdict = suppressor.offer(message, at);
    if (verdict.summary !== null) queue.push(formatDiagLine('I', verdict.summary, at));
    if (verdict.emit) queue.push(formatDiagLine(LEVEL_CHAR[level], message, at));
    if (queue.length > QUEUE_CAP) queue.splice(0, queue.length - QUEUE_CAP);
    scheduleFlush(immediate || queue.length >= FLUSH_THRESHOLD);
  };

  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      original[level](...args);
      if (inHook) return; // a failure inside the hook must not recurse
      inHook = true;
      try {
        enqueue(level, args);
      } finally {
        inHook = false;
      }
    };
  }

  // The global JS error hook: the sink's most valuable lines. Flushed
  // immediately (best-effort — the append is async and the process may
  // die first, but RN dispatches the red screen/teardown after this
  // handler, which is normally time enough for one small write).
  const errorUtils = (
    globalThis as {
      ErrorUtils?: {
        getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
        setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
      };
    }
  ).ErrorUtils;
  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      enqueue('error', [`[crash] ${isFatal ? 'FATAL' : 'non-fatal'} JS error:`, error], true);
      previous(error, isFatal);
    });
  }
}
