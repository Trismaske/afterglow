/**
 * Where the deck lands after an advancing decision (m0.8.8, F23+F24,
 * G4) — pure.
 *
 * The old advance was a bare `index + 1`: deciding the last photo of a
 * unit with earlier unreviewed members stranded the cursor at the end
 * (F23), and deciding mid-unit landed on already-decided neighbours
 * (F24). Both measured on the S10e (2026-08-23) before this existed.
 *
 * ONE rule, both deck kinds: after a decision that advances, go to the
 * **nearest pending photo forward**; if none ahead, **backward to the
 * closest**; if none anywhere, stay put (`null` — the unit-completion
 * flow takes over). The decided photo itself is `from` and is never a
 * candidate, so callers need not wait for its state row to refresh.
 *
 * A re-decide in a fully-reviewed unit (browse mode) hits the
 * no-pending case and stays put — the cursor stops yanking off the
 * photo being re-judged, a side effect the G4 grilling wanted.
 *
 * The impure partner is `decideCurrent` in `screens/DeckScreen.tsx`,
 * which builds the pending flags from its state map and routes the
 * result through `jumpTo` (the pager-alignment contract).
 */

/**
 * The index to jump to after deciding the photo at `from`, or null to
 * stay put. `pending[i]` is true while photo i still needs a verdict;
 * `pending[from]` is ignored (it was just decided).
 */
export function nearestPendingIndex(pending: readonly boolean[], from: number): number | null {
  for (let i = from + 1; i < pending.length; i++) {
    if (pending[i]) return i;
  }
  for (let i = Math.min(from, pending.length) - 1; i >= 0; i--) {
    if (pending[i]) return i;
  }
  return null;
}
