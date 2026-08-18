import { describe, expect, it } from 'vitest';
import { photoBadges } from './photoBadges';

const NONE = {
  state: 'unreviewed',
  edit: null,
  favourite: null,
  organize: null,
  share: null,
} as const;

/** Kinds only, for the ordering assertions. */
const kinds = (input: Parameters<typeof photoBadges>[0]) => photoBadges(input).map((b) => b.kind);

describe('photoBadges', () => {
  it('badges nothing for an untouched unreviewed photo', () => {
    expect(photoBadges(NONE)).toEqual([]);
  });

  it('shows the verdict and every action together (none overrides another)', () => {
    expect(
      kinds({
        state: 'kept',
        edit: 'live',
        favourite: 'live',
        organize: 'live',
        share: 'live',
      }),
    ).toEqual(['keep', 'edit', 'fav', 'organize', 'share']);
  });

  it('keeps the action badges on a staged cull, with the cull verdict', () => {
    expect(kinds({ ...NONE, state: 'culled', share: 'live' })).toEqual(['cull', 'share']);
  });

  it('badges actions on a still-unreviewed photo', () => {
    expect(kinds({ ...NONE, edit: 'live', organize: 'live' })).toEqual(['edit', 'organize']);
  });

  it('carries a finished action at the quiet weight, beside a live one', () => {
    // m0.8.2: an edit that HAPPENED still badges — the photo carries it —
    // while a share still waiting stays loud. Same glyph set, two weights.
    expect(photoBadges({ ...NONE, state: 'kept', edit: 'carried', share: 'live' })).toEqual([
      { kind: 'keep', weight: 'live' },
      { kind: 'edit', weight: 'carried' },
      { kind: 'share', weight: 'live' },
    ]);
  });

  it('gives the verdict no weight of its own', () => {
    expect(photoBadges({ ...NONE, state: 'culled' })).toEqual([{ kind: 'cull', weight: 'live' }]);
  });
});

it("a trashed photo badges the trash-can verdict (D9's tombstone promise)", () => {
  const badges = photoBadges({
    state: 'trashed',
    edit: null,
    favourite: null,
    organize: null,
    share: null,
  });
  expect(badges).toEqual([{ kind: 'trashed', weight: 'live' }]);
});
