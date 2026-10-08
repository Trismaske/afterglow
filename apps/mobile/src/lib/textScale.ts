/**
 * The large-text threshold (m0.9.1 phase 1, measured on the accessibility
 * walk — docs/accessibility-audit.md): past it, the side-by-side layouts
 * that pair a fixed-size element with a column of text (Home's goal ring
 * and its numbers, Stats' Today ring, the Settings rows that put a title
 * beside a pill, the deck's four action chips) no longer fit and STACK or
 * WRAP instead. Below it they keep their rows. The text itself scales
 * freely at every step — this is a layout decision, never a cap.
 *
 * The measure is the font scale RELATIVE TO THE WIDTH: what matters is
 * how much text a line holds, so a 1.5 scale on the 411 dp S23 reads
 * like 1.31 on the 360 dp S10e. 1.3 at 360 dp is where the walk first
 * saw the goal card's numbers wrap to three lines each and the Settings
 * row titles cut at their fixed width; 1.15 still fit, and the S23 at
 * 1.5 (an effective 1.31) was at the edge.
 */
export const LARGE_TEXT_SCALE = 1.3;

/** The second threshold: past it even a wrapped or stacked layout runs
 * out of room for a label beside its icon (the tab bar's "Favourite" at
 * 1.8× on 360 dp broke mid-word in its fifth of the bar; the Progress
 * chips' labels at 2.0× too), so those surfaces drop to icons, or wrap
 * two chips per row. 1.5× still fit. */
export const HUGE_TEXT_SCALE = 1.6;

/** The width the threshold was measured on. */
export const REFERENCE_WIDTH_DP = 360;

export function effectiveTextScale(fontScale: number, widthDp: number): number {
  if (!Number.isFinite(fontScale) || !(widthDp > 0)) return 1;
  // Android hands the font scale over as a Java float, so a slider step
  // of 1.3 arrives as 1.29999995 and a plain >= misses its own threshold
  // (the S10e at 1.3, 2026-10-09); three decimals is the slider's own
  // resolution.
  return Math.round(((fontScale * REFERENCE_WIDTH_DP) / widthDp) * 1000) / 1000;
}

export function isLargeText(fontScale: number, widthDp: number): boolean {
  return effectiveTextScale(fontScale, widthDp) >= LARGE_TEXT_SCALE;
}

export function isHugeText(fontScale: number, widthDp: number): boolean {
  return effectiveTextScale(fontScale, widthDp) >= HUGE_TEXT_SCALE;
}
