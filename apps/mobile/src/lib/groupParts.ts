/**
 * A group's PARTS in deck order (m0.9 phase 10, pure).
 *
 * The scan stores the engine's cut of a group into looks as each
 * member's `part` index (v27, core grouping.ts step 5). Membership is
 * the group; a part is presentation: the deck shows the group part by
 * part, newest part first, newest photo first inside a part, with a
 * divider and a chip ("Part 2 of 4 · 5 photos") at each boundary
 * (Tristan, 2026-10-05: ordered with dividers — the group stays one deck
 * unit, Everything, History and the counts untouched).
 *
 * Parts are ranked HERE, at read time, by their newest present member:
 * the stored index is an identity, not an order, because a trashed or
 * ejected member can leave the stored "first" part older than another.
 * A group whose members all share one part (every single, every group
 * the engine left whole) has no boundary to show.
 */

export interface PartMember {
  asset_id: string;
  taken_at: number;
  part: number;
}

export interface PartOrder<M extends PartMember> {
  /** The members in deck order: part by part, newest first within each. */
  ordered: M[];
  /** Each member's part ORDINAL in deck order (0 = the first part shown). */
  ordinalOf: Map<string, number>;
  /** Member count per part ordinal. */
  sizes: number[];
}

/** Order `members` (newest-first as the store reads them) part by part. */
export function orderByParts<M extends PartMember>(members: readonly M[]): PartOrder<M> {
  const byPart = new Map<number, M[]>();
  for (const m of members) {
    const bucket = byPart.get(m.part);
    if (bucket) bucket.push(m);
    else byPart.set(m.part, [m]);
  }
  const parts = [...byPart.values()].map((bucket) =>
    [...bucket].sort((a, b) => b.taken_at - a.taken_at || (a.asset_id < b.asset_id ? 1 : -1)),
  );
  parts.sort((a, b) => b[0].taken_at - a[0].taken_at || (a[0].asset_id < b[0].asset_id ? 1 : -1));
  const ordinalOf = new Map<string, number>();
  parts.forEach((part, ordinal) => part.forEach((m) => ordinalOf.set(m.asset_id, ordinal)));
  return { ordered: parts.flat(), ordinalOf, sizes: parts.map((p) => p.length) };
}

/** The boundary chip's text for the part at `ordinal`; null when the
 * group has one part. */
export function partLabel(order: PartOrder<PartMember>, ordinal: number): string | null {
  if (order.sizes.length < 2) return null;
  const n = order.sizes[ordinal];
  return `Part ${ordinal + 1} of ${order.sizes.length} · ${n} ${n === 1 ? 'photo' : 'photos'}`;
}
