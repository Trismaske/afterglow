/**
 * Compare-tool prompt preferences (m0.8.8, F29/G10, D8) —
 * settings-table keys.
 *
 * Compare's Keep and Cull write immediately; each is followed by ONE
 * binary prompt about the other photo ("Cull the other photo?" after a
 * keep, "Keep the other photo?" after a cull) that fires only while the
 * other photo is still unreviewed. The prompt's "Remember this answer"
 * checkbox stores WHICHEVER button was pressed, per direction: a
 * remembered verdict auto-applies it, a remembered "Leave open"
 * silences the prompt. Settings' "Reset confirmation dialogs" row
 * clears both memories.
 */

/** After "Keep {photo}": what happens to the other, still-unreviewed photo. */
export const COMPARE_AFTER_KEEP_KEY = 'compare_after_keep';
/** After "Cull {photo}": what happens to the other, still-unreviewed photo. */
export const COMPARE_AFTER_CULL_KEY = 'compare_after_cull';

export type CompareAfterKeep = 'ask' | 'cull' | 'leave';
export type CompareAfterCull = 'ask' | 'keep' | 'leave';

export function parseCompareAfterKeep(raw: string | null): CompareAfterKeep {
  return raw === 'cull' || raw === 'leave' ? raw : 'ask';
}

export function parseCompareAfterCull(raw: string | null): CompareAfterCull {
  return raw === 'keep' || raw === 'leave' ? raw : 'ask';
}

/** Both prefs serialize as their literal value; 'ask' is the absent /
 * reset state, so parsing tolerates any garbage as 'ask'. */
export function serializeComparePref(pref: CompareAfterKeep | CompareAfterCull): string {
  return pref;
}
