import { describe, expect, it } from 'vitest';
import { orderByParts, partLabel } from './groupParts';

const m = (asset_id: string, taken_at: number, part: number) => ({ asset_id, taken_at, part });

describe('orderByParts (phase 10)', () => {
  it('ranks parts by their newest member and keeps newest-first inside each', () => {
    // Stored part 0 is the older look; part 1 holds the newest photo.
    const members = [m('e', 50, 1), m('d', 40, 0), m('c', 30, 1), m('b', 20, 0), m('a', 10, 0)];
    const order = orderByParts(members);
    expect(order.ordered.map((x) => x.asset_id)).toEqual(['e', 'c', 'd', 'b', 'a']);
    expect(order.sizes).toEqual([2, 3]);
    expect(order.ordinalOf.get('d')).toBe(1);
    expect(partLabel(order, 0)).toBe('Part 1 of 2 · 2 photos');
    expect(partLabel(order, 1)).toBe('Part 2 of 2 · 3 photos');
  });

  it('a one-part group (or a singles run) has no boundary and no label', () => {
    const order = orderByParts([m('b', 20, 0), m('a', 10, 0)]);
    expect(order.ordered.map((x) => x.asset_id)).toEqual(['b', 'a']);
    expect(order.sizes).toEqual([2]);
    expect(partLabel(order, 0)).toBeNull();
  });

  it('a removed member re-ranks the parts: the stored first part can fall behind', () => {
    // Part 0 held the newest photo until it was trashed; part 1 now leads.
    const members = [m('c', 30, 1), m('b', 20, 0), m('a', 10, 0)];
    const order = orderByParts(members);
    expect(order.ordered.map((x) => x.asset_id)).toEqual(['c', 'b', 'a']);
    expect(order.ordinalOf.get('c')).toBe(0);
    expect(partLabel(order, 1)).toBe('Part 2 of 2 · 2 photos');
  });

  it('singles label as a photo', () => {
    const order = orderByParts([m('b', 20, 0), m('a', 10, 1)]);
    expect(partLabel(order, 0)).toBe('Part 1 of 2 · 1 photo');
  });
});
