import { describe, expect, it } from 'vitest';
import { thumbBucketPx, THUMB_BUCKETS_PX } from './thumbnailSize';

describe('thumbBucketPx (the OS-thumbnail request buckets)', () => {
  it('picks the smallest bucket that covers the rendered pixels', () => {
    expect(thumbBucketPx(52, 2.75)).toBe(256); // the deck strip on the S10e (143 px)
    expect(thumbBucketPx(52, 1)).toBe(128);
    expect(thumbBucketPx(120, 3)).toBe(512); // a grid tile at 3x (360 px)
    expect(thumbBucketPx(256, 1)).toBe(256); // exact fit stays put
  });
  it('never downscales: past the largest bucket it returns the largest', () => {
    expect(thumbBucketPx(600, 3)).toBe(THUMB_BUCKETS_PX[THUMB_BUCKETS_PX.length - 1]);
  });
});
