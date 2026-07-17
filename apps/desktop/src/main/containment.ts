/**
 * Path-containment check for the afterglow:// media protocol.
 *
 * Both arguments must already be real paths (symlinks resolved) — the caller
 * realpath()s the requested file and the configured media folders before
 * asking. Pure string logic lives here so it is unit-testable.
 */

import * as path from 'node:path';

/** True iff `childReal` is strictly inside `parentReal`. */
export function isInside(childReal: string, parentReal: string): boolean {
  const rel = path.relative(parentReal, childReal);
  if (rel === '') return false; // the folder itself is not a file inside it
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** True iff `childReal` is inside at least one of `rootsReal`. */
export function isInsideAny(childReal: string, rootsReal: readonly string[]): boolean {
  return rootsReal.some((root) => isInside(childReal, root));
}
