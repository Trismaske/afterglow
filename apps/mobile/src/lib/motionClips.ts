/**
 * A motion photo's clip as a playable file (m0.9 phase 5/6): the
 * module's run-scoped extraction (`extractMotionClip`, swept at every
 * process start), keyed by volume + raw id + version, with ONE in-flight
 * extraction per key — the stage's overlay and any number of animated
 * thumbnail cells showing the same photo share it, because two
 * concurrent extractions of one key could rewrite the cache file under
 * a player preparing it (the probe's codex round 1). The resolved file
 * URI is safe to reuse for the process's life.
 */
import { extractMotionClip } from '../../modules/media-store-actions';
import { canonicalContentUri, rawIdOf, volumeOf } from './mediaIdentity';
import type { MotionClipRow } from '../db/store';

const inFlight = new Map<string, Promise<string>>();

/** The cache key: raw ids and generations are allocated per volume, so
 * primary and an SD card can share both. */
export function motionClipKey(id: string, clip: MotionClipRow): string {
  return `${volumeOf(id)}-${rawIdOf(id)}-${clip.version}`;
}

export function resolveMotionClip(id: string, clip: MotionClipRow): Promise<string> {
  const key = motionClipKey(id, clip);
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;
  const extraction = extractMotionClip(
    canonicalContentUri(id, 'photo'),
    clip.offset,
    clip.length,
    key,
  ).finally(() => inFlight.delete(key));
  inFlight.set(key, extraction);
  return extraction;
}
