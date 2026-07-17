/**
 * Compare-tool confirmation preferences (m0.5) — settings-table keys.
 *
 * In a two-photo group, "X is better" offers to cull the other photo.
 * The confirm dialog carries a "Don't ask again" checkbox; once
 * suppressed, better = auto-cull the loser (matching tester intuition).
 * Settings has a "Reset confirmation dialogs" row that clears this.
 */

/** '1' = skip the confirm and auto-cull the two-photo-group loser. */
export const COMPARE_AUTO_CULL_KEY = 'compare_auto_cull_loser';

export function parseCompareAutoCull(raw: string | null): boolean {
  return raw === '1';
}

export function serializeCompareAutoCull(autoCull: boolean): string {
  return autoCull ? '1' : '0';
}
