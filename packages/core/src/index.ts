/**
 * @afterglow/core — shared, pure-TypeScript intelligence for Afterglow
 * Desktop and Afterglow Companion.
 *
 * No filesystem or platform APIs live here; no Date.now()/Math.random()
 * defaults — time and randomness are injected. Both apps feed MediaItem[]
 * through their own adapters.
 */

export * from './types.js';
export * from './rng.js';
export * from './clustering.js';
export * from './mix.js';
export * from './retrospectives.js';
export * from './flags.js';
export * from './cull.js';
export * from './deck.js';
export * from './similarity.js';
export * from './grouping.js';
