/**
 * Store-backed review scopes (m0.5) — pure config logic, unit-tested;
 * persisted as one JSON blob in the settings table (key `review_scopes`,
 * same pattern as `photo_sources`). Replaces direct consumption of the
 * static SCOPE_DEFS array: Home renders the ENABLED scopes from this
 * config (plus the ever-present "Custom" date-range chip), and Settings
 * gains a manager (enable/disable, delete customs, reset).
 *
 * Shape:
 * - Built-in scopes are seeded from lib/scopes.ts SCOPE_DEFS with their
 *   ids kept stable (day1/days7/days30/months6/year1/all) — they can be
 *   disabled but never deleted, and parsing re-seeds any missing builtin
 *   (forward compatibility if defaults ever grow).
 * - Custom scopes are user-named FIXED date ranges ("Japan — Jan 31 to
 *   Mar 6"): unlike the rolling builtins they don't move with "now",
 *   which is the point (a trip doesn't drift).
 * - The "Custom" picker chip itself is NOT a stored scope; Home always
 *   appends it.
 */
import { DAY_MS, SCOPE_DEFS } from './scopes';

/** settings-table key for the persisted scope config. */
export const REVIEW_SCOPES_KEY = 'review_scopes';

export type StoredScope =
  | { id: string; label: string; kind: 'rolling'; days: number; builtin: true; enabled: boolean }
  | { id: string; label: string; kind: 'all'; builtin: true; enabled: boolean }
  | {
      id: string;
      label: string;
      kind: 'range';
      startMs: number;
      endMs: number;
      builtin: false;
      enabled: boolean;
    };

export interface ScopeConfig {
  version: 1;
  scopes: StoredScope[];
}

/** The seed: every built-in chip (SCOPE_DEFS minus the picker chip), enabled. */
export function defaultScopeConfig(): ScopeConfig {
  const scopes: StoredScope[] = [];
  for (const def of SCOPE_DEFS) {
    if (def.key === 'custom') continue;
    scopes.push(
      def.key === 'all'
        ? { id: def.key, label: def.label, kind: 'all', builtin: true, enabled: true }
        : {
            id: def.key,
            label: def.label,
            kind: 'rolling',
            days: def.days ?? 1,
            builtin: true,
            enabled: true,
          },
    );
  }
  return { version: 1, scopes };
}

function isValidScope(s: unknown): s is StoredScope {
  if (typeof s !== 'object' || s === null) return false;
  const v = s as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id === '' || typeof v.label !== 'string' || v.label === '') {
    return false;
  }
  if (typeof v.enabled !== 'boolean') return false;
  if (v.kind === 'rolling') {
    return v.builtin === true && typeof v.days === 'number' && v.days > 0;
  }
  if (v.kind === 'all') return v.builtin === true;
  if (v.kind === 'range') {
    return (
      v.builtin === false &&
      typeof v.startMs === 'number' &&
      typeof v.endMs === 'number' &&
      v.startMs <= v.endMs
    );
  }
  return false;
}

/**
 * Parse the persisted config. Garbage → defaults. Any builtin missing
 * from the stored list is re-seeded (disabled builtins stay disabled —
 * only truly absent ids come back, in default order after the kept
 * scopes' builtins).
 */
export function parseScopeConfig(raw: string | null): ScopeConfig {
  if (!raw) return defaultScopeConfig();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaultScopeConfig();
    const p = parsed as { version?: unknown; scopes?: unknown };
    if (p.version !== 1 || !Array.isArray(p.scopes)) return defaultScopeConfig();
    const seen = new Set<string>();
    const scopes: StoredScope[] = [];
    for (const s of p.scopes) {
      if (isValidScope(s) && !seen.has(s.id)) {
        seen.add(s.id);
        scopes.push({ ...s });
      }
    }
    // Re-seed builtins that vanished (or were never known).
    const builtins: StoredScope[] = scopes.filter((s) => s.builtin);
    const customs = scopes.filter((s) => !s.builtin);
    for (const def of defaultScopeConfig().scopes) {
      if (!seen.has(def.id)) builtins.push(def);
    }
    return { version: 1, scopes: [...builtins, ...customs] };
  } catch {
    return defaultScopeConfig();
  }
}

export function serializeScopeConfig(config: ScopeConfig): string {
  return JSON.stringify(config);
}

/** Id for a new custom scope — unique per creation time. */
export function newCustomScopeId(nowMs: number): string {
  return `range-${nowMs}`;
}

/** Append a named fixed-range scope (enabled). Returns a new config. */
export function addCustomScope(
  config: ScopeConfig,
  scope: { id: string; label: string; startMs: number; endMs: number },
): ScopeConfig {
  const trimmed = scope.label.trim();
  if (trimmed === '') throw new Error('addCustomScope: empty label');
  if (config.scopes.some((s) => s.id === scope.id)) {
    throw new Error(`addCustomScope: duplicate id ${scope.id}`);
  }
  return {
    version: 1,
    scopes: [
      ...config.scopes,
      {
        id: scope.id,
        label: trimmed,
        kind: 'range',
        startMs: scope.startMs,
        endMs: scope.endMs,
        builtin: false,
        enabled: true,
      },
    ],
  };
}

/** Remove a CUSTOM scope; builtins are silently kept (disable instead). */
export function removeScope(config: ScopeConfig, id: string): ScopeConfig {
  return {
    version: 1,
    scopes: config.scopes.filter((s) => s.builtin || s.id !== id),
  };
}

export function setScopeEnabled(config: ScopeConfig, id: string, enabled: boolean): ScopeConfig {
  return {
    version: 1,
    scopes: config.scopes.map((s) => (s.id === id ? { ...s, enabled } : s)),
  };
}

/**
 * "Reset to defaults": builtins return to default order + enabled state;
 * custom scopes are kept (deleting them is an explicit per-scope act).
 */
export function resetScopeConfig(config: ScopeConfig): ScopeConfig {
  return {
    version: 1,
    scopes: [...defaultScopeConfig().scopes, ...config.scopes.filter((s) => !s.builtin)],
  };
}

export function enabledScopes(config: ScopeConfig): StoredScope[] {
  return config.scopes.filter((s) => s.enabled);
}

export interface StoredScopeRange {
  startMs: number;
  endMs: number;
  label: string;
}

/**
 * The date range a stored scope covers. Rolling builtins end at `nowMs`
 * (m0.3.1 semantics); "all" spans epoch → now; custom ranges are fixed.
 */
export function storedScopeRange(scope: StoredScope, nowMs: number): StoredScopeRange {
  switch (scope.kind) {
    case 'rolling':
      return { startMs: nowMs - scope.days * DAY_MS, endMs: nowMs, label: scope.label };
    case 'all':
      return { startMs: 0, endMs: nowMs, label: scope.label };
    case 'range':
      return { startMs: scope.startMs, endMs: scope.endMs, label: scope.label };
  }
}
