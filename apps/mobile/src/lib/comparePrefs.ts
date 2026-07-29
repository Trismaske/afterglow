/**
 * Compare-tool confirmation preferences (m0.5; tri-state m0.8.2 —
 * Tristan's grilling) — settings-table keys.
 *
 * A whole-table "X is better" raises the keep-both/cull dialog, whose
 * "Don't ask again" checkbox sticks with WHICHEVER outcome it rides on:
 * suppressed-with-cull means better = auto-cull the loser;
 * suppressed-with-keep-both means better = auto-keep both. Settings'
 * "Reset confirmation dialogs" row restores asking.
 */

/** Legacy key name kept (durable settings row): '1' = auto-cull,
 * 'keep_both' = auto-keep-both, anything else = ask. */
export const COMPARE_AUTO_CULL_KEY = 'compare_auto_cull_loser';

export type CompareDuelPref = 'ask' | 'cull' | 'keep_both';

export function parseCompareDuelPref(raw: string | null): CompareDuelPref {
  if (raw === '1') return 'cull';
  if (raw === 'keep_both') return 'keep_both';
  return 'ask';
}

export function serializeCompareDuelPref(pref: CompareDuelPref): string {
  return pref === 'cull' ? '1' : pref === 'keep_both' ? 'keep_both' : '0';
}
