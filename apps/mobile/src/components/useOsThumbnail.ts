/**
 * The OS thumbnail hook (m0.9 phase 3, item 2 — impure partner of
 * lib/thumbnailSize.ts): every thumbnail-scale surface renders
 * MediaStore's own thumbnail through this hook instead of asking Glide
 * to decode the file (Tristan, 2026-09-04: all thumbnail surfaces, all
 * photos, one path). Measured 7–23 ms on the S23's 200 MP tier against
 * ~1.5 s for the Glide decode; and thumbnail-scale demand leaves the
 * image disk cache entirely.
 *
 * Retention (the F22 lessons, simplified): one BaseRetention of
 * SharedRef bitmaps keyed `${assetId}@${px}`, PINNED while any mounted
 * hook renders the key — an evicted ref a mounted Image still shows
 * would detach its bitmap under the view (codex round 3's class), so
 * such refs PARK and release only when the last pin drops. One
 * in-flight load per key; late arrivals adopt the retained entry.
 *
 * Fail-soft, loud once: a photo the store cannot serve resolves
 * `failed`, the surface falls back to the URI path (Glide), and the id
 * is warned once — never a silent blank.
 */

import { useEffect, useRef, useState } from 'react';
import { loadOsThumbnail, type RegionBitmap } from '../../modules/media-store-actions';
import { BaseRetention } from '../lib/regionZoom';
import { canonicalContentUri } from '../lib/mediaIdentity';
import { perfAggregate } from '../lib/perfLog';
import { imageCacheKey } from '../lib/imageKeys';

/** Thumbnails are small (≤ 1024² × 4 bytes); a budget that keeps a
 * screenful of grid tiles plus the strip and a few pager first paints. */
const THUMB_RETENTION_BYTES = 24 * 1024 * 1024;

const pins = new Map<string, number>();
const parked = new Map<string, RegionBitmap[]>();
const retention = new BaseRetention<RegionBitmap>(THUMB_RETENTION_BYTES, (ref, key) => {
  if ((pins.get(key) ?? 0) > 0) {
    const list = parked.get(key) ?? [];
    list.push(ref);
    parked.set(key, list);
  } else ref.release?.();
});
const inflight = new Map<string, Promise<RegionBitmap>>();
const failed = new Set<string>();
const warned = new Set<string>();

function pin(key: string): void {
  pins.set(key, (pins.get(key) ?? 0) + 1);
}
function unpin(key: string): void {
  const n = (pins.get(key) ?? 1) - 1;
  if (n > 0) {
    pins.set(key, n);
    return;
  }
  pins.delete(key);
  for (const ref of parked.get(key) ?? []) ref.release?.();
  parked.delete(key);
}

async function load(assetId: string, px: number, key: string): Promise<RegionBitmap> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const flight = (async () => {
    const start = Date.now();
    const ref = await loadOsThumbnail(canonicalContentUri(assetId), px);
    perfAggregate(`os thumbnail ${px}px`, Date.now() - start, 1);
    // Upper bound: the store scales to FIT, so the bitmap is at most px².
    retention.put(key, ref, px * px * 4);
    return ref;
  })();
  inflight.set(key, flight);
  try {
    return await flight;
  } finally {
    inflight.delete(key);
  }
}

export type OsThumbnailState =
  { status: 'loading' } | { status: 'ready'; ref: RegionBitmap } | { status: 'failed' };

/** The OS thumbnail for `assetId` at `px` (a lib/thumbnailSize bucket).
 * Synchronous on a retained hit; the ref stays valid while mounted. */
export function useOsThumbnail(assetId: string, px: number, version: number): OsThumbnailState {
  // The version (item 3) is part of the key: the OS store regenerates
  // its thumbnail on an in-place edit, and our retained ref must not
  // outlive that.
  const key = `${imageCacheKey(assetId, version)}@${px}`;
  const [state, setState] = useState<OsThumbnailState>(() => {
    const hit = retention.get(key);
    if (hit) return { status: 'ready', ref: hit };
    return failed.has(key) ? { status: 'failed' } : { status: 'loading' };
  });
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
    pin(key);
    let cancelled = false;
    const hit = retention.get(key);
    if (hit) setState({ status: 'ready', ref: hit });
    else if (failed.has(key)) setState({ status: 'failed' });
    else {
      setState({ status: 'loading' });
      void load(assetId, px, key).then(
        (ref) => {
          if (!cancelled) setState({ status: 'ready', ref });
        },
        (error: unknown) => {
          failed.add(key);
          if (!warned.has(assetId)) {
            warned.add(assetId);
            console.warn(
              `[thumb] OS thumbnail unavailable for ${assetId} — falling back to the file decode:`,
              String(error),
            );
          }
          if (!cancelled) setState({ status: 'failed' });
        },
      );
    }
    return () => {
      cancelled = true;
      unpin(key);
    };
  }, [assetId, px, version, key]);
  return state;
}
