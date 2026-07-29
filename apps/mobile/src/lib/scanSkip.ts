/**
 * Scan-skip fingerprint (m0.8.1, pure). A full continuous scan costs
 * ~6 minutes of sustained CPU on a 27k corpus — and it ran on EVERY app
 * open, even when nothing changed (the dominant battery/CPU cost in the
 * field). MediaStore's per-volume generation counter (API 30+) bumps on
 * any insert/update/delete, so a stored fingerprint matching the current
 * one is OS-guaranteed evidence the scan would be a no-op.
 *
 * The fingerprint binds EVERYTHING a pass depends on — the volume
 * generations, the source scope, the grouping strictness, and the
 * embedding model — so any configuration change misses naturally, with
 * no force-flag bookkeeping for settings paths. Forced rescans
 * (requestRescan: settings applies and resets that rewrite scan OUTPUT
 * without changing scan INPUT) bypass the check entirely.
 *
 * No-skip cases: an empty generations map (API < 30 or unreadable
 * volumes) can prove nothing.
 */

export function scanFingerprint(args: {
  /** Per-volume MediaStore generations ({} = unknown). */
  generations: Readonly<Record<string, number>>;
  /** Resolved source roots (null = all folders). */
  roots: readonly string[] | null;
  /** Raw grouping-strictness setting (null = default). */
  strictness: string | null;
  /** Pinned embedding-model SHA. */
  modelSha: string;
}): string {
  const volumes = Object.keys(args.generations)
    .sort()
    .map((volume) => `${volume}=${args.generations[volume]}`)
    .join(',');
  const roots = args.roots === null ? '*' : [...args.roots].sort().join(',');
  return `gen:${volumes}|src:${roots}|strict:${args.strictness ?? 'default'}|model:${args.modelSha}`;
}

/**
 * Whether the pass may be skipped: proof exists and the stored
 * fingerprint matches exactly.
 *
 * "Proof exists" is a WHOLE-CALL property, not a per-volume one. The
 * native side now fails the entire `mediaGenerations` call if any
 * enumerated volume is unreadable (m0.8.2), and the caller turns that
 * into an empty map — so an empty map here means "could not prove", and
 * a non-empty one means every current volume contributed. Before that,
 * a partial map fingerprinted and compared like a complete one, so a
 * consistently-unreadable volume could skip the scan indefinitely while
 * its photos changed.
 */
export function scanCanSkip(args: {
  generations: Readonly<Record<string, number>>;
  stored: string | null;
  current: string;
}): boolean {
  if (Object.keys(args.generations).length === 0) return false;
  return args.stored !== null && args.stored === args.current;
}

/**
 * The "Library scan" row's subtitle (m0.8.2, pure).
 *
 * Settings answers "are my numbers current?" with a FACT — when the
 * library was last verified, and how big it is — rather than offering a
 * refresh button that implies it is stale. Home already re-checks on
 * every open and every foreground return, so staleness is not the normal
 * state; the honest surface is a status line, and the rescan is what you
 * reach for only when that line looks wrong.
 *
 * "Verified" covers a SKIP as well as a full pass: an unchanged
 * generation is OS-level proof the library did not change, so a skip
 * answers the user's question exactly as well. Reporting only passes
 * would make a phone that checks daily read "6 days ago".
 */
export function scanStatusLine(args: {
  /** Epoch ms the library was last VERIFIED current — by a full pass or
   * by a skip, which proves the same thing. Null before either. */
  verifiedAt: number | null;
  /** Tracked photos in scope. */
  corpus: number;
  /** Live scan progress, when one is running. */
  running?: { scanned: number; total: number | null } | null;
  now?: number;
}): string {
  if (args.running) {
    const { scanned, total } = args.running;
    // A full pass carries its denominator (m0.8.2, F3) — show the same
    // percent Home shows; a delta shows the plain count.
    if (total !== null && total > 0) {
      const pct = Math.min(100, Math.round((scanned / total) * 100));
      return `Scanning ${pct}% · ${Math.min(scanned, total).toLocaleString()} of ${total.toLocaleString()} photos`;
    }
    return `Scanning now · ${scanned.toLocaleString()} photos`;
  }
  if (args.verifiedAt === null) return 'Not checked yet';
  const ageMs = Math.max(0, (args.now ?? Date.now()) - args.verifiedAt);
  return `Checked ${relativeAge(ageMs)} · ${args.corpus.toLocaleString()} photos`;
}

/** "just now" / "12 minutes ago" / "3 hours ago" / "2 days ago". */
function relativeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
