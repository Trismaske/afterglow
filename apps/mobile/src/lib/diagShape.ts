/**
 * Pure shaping for the diagnostics sink (m0.8.7) — the testable half of
 * lib/diagLog.ts: line formatting, console-argument joining, and the
 * repeated-line suppressor that implements the log-site audit's shape
 * rules (screen-level echoes dedup; paging-loop classes rate-limit —
 * both are "the same line arriving many times in a short window").
 * Root causes always land: the suppressor keys on the exact line text,
 * so distinct messages never mask each other, and even a suppressed
 * line's volume is preserved as a summary count.
 */

/** One sink line: ISO timestamp, level letter, message. */
export function formatDiagLine(level: 'I' | 'W' | 'E', message: string, at: number): string {
  return `${new Date(at).toISOString()} ${level} ${message}`;
}

/** Join console arguments the way the log reads them: strings as-is,
 * Errors by stack (the crash hook's whole value), everything else
 * JSON-ish with a String() fallback. */
export function joinConsoleArgs(args: readonly unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.stack ?? String(arg);
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

export interface SuppressorVerdict {
  /** Emit the offered line itself? */
  emit: boolean;
  /** A summary line to emit FIRST (a previous window closed with
   * suppressed repeats), or null. */
  summary: string | null;
}

export interface RepeatSuppressor {
  offer(message: string, at: number): SuppressorVerdict;
  /** Close every window that has expired by `at`, returning their
   * summary lines — called at flush time so a burst that simply stops
   * still reports its suppressed volume. */
  sweep(at: number): string[];
}

interface WindowState {
  windowStart: number;
  seen: number;
}

/**
 * Allow the first `free` identical messages per `windowMs` window;
 * suppress and count the rest. A new window (or the sweep) emits one
 * summary naming the suppressed volume. The key map is capped: past
 * `keyCap` distinct keys everything resets — losing suppression state
 * for a moment beats unbounded growth, and the cost is only a few
 * duplicate lines.
 */
export function createRepeatSuppressor(
  windowMs = 60_000,
  free = 3,
  keyCap = 300,
): RepeatSuppressor {
  const windows = new Map<string, WindowState>();

  const summarize = (message: string, state: WindowState): string | null => {
    const suppressed = state.seen - free;
    if (suppressed <= 0) return null;
    return `${message} [repeated ${suppressed}× more in ${Math.round(windowMs / 1000)} s]`;
  };

  return {
    offer(message, at) {
      if (windows.size >= keyCap && !windows.has(message)) windows.clear();
      const state = windows.get(message);
      if (state === undefined || at >= state.windowStart + windowMs) {
        const summary = state === undefined ? null : summarize(message, state);
        windows.set(message, { windowStart: at, seen: 1 });
        return { emit: true, summary };
      }
      state.seen += 1;
      return { emit: state.seen <= free, summary: null };
    },
    sweep(at) {
      const summaries: string[] = [];
      for (const [message, state] of windows) {
        if (at >= state.windowStart + windowMs) {
          const summary = summarize(message, state);
          if (summary !== null) summaries.push(summary);
          windows.delete(message);
        }
      }
      return summaries;
    },
  };
}
