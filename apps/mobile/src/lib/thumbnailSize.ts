/**
 * Thumbnail request buckets (m0.9 phase 3, item 2): the OS thumbnail
 * store is asked for one of a few sizes so the in-app retention keys
 * stay coarse (a grid tile on two DPIs should share an entry, not
 * mint two). Pure: layout dp × device scale → the smallest bucket that
 * covers the rendered pixels, never a downscale.
 */

export const THUMB_BUCKETS_PX = [128, 256, 512, 1024] as const;

export function thumbBucketPx(layoutDp: number, scale: number): number {
  const px = Math.ceil(layoutDp * scale);
  for (const b of THUMB_BUCKETS_PX) if (b >= px) return b;
  return THUMB_BUCKETS_PX[THUMB_BUCKETS_PX.length - 1];
}
