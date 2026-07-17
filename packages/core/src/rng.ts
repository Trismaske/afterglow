import type { Rng } from './types.js';

/**
 * mulberry32 — tiny, fast, seedable PRNG. Good enough for shuffling
 * slideshows; not for cryptography. Same seed → same sequence, everywhere.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle into a new array, driven by the injected rng. */
export function shuffled<T>(input: readonly T[], rng: Rng): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Uniform pick from a non-empty array. Throws on empty input. */
export function pickOne<T>(arr: readonly T[], rng: Rng): T {
  if (arr.length === 0) throw new Error('pickOne: empty array');
  const i = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return arr[i];
}
