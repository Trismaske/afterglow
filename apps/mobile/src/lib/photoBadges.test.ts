import { describe, expect, it } from 'vitest';
import { folderNameOfUri, isSdPhoto, photoBadges } from './photoBadges';

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

describe('the annotation badges (m0.8.7, F14/F19)', () => {
  const NONE = {
    state: 'unreviewed' as const,
    edit: null,
    favourite: null,
    organize: null,
    share: null,
  };

  it('folder and SD render LAST and always quiet — facts, never chores', () => {
    const badges = photoBadges({
      ...NONE,
      state: 'kept',
      share: 'live',
      folder: 'Camera',
      sdCard: true,
    });
    expect(badges).toEqual([
      { kind: 'keep', weight: 'live' },
      { kind: 'share', weight: 'live' },
      { kind: 'sd', weight: 'carried' },
      { kind: 'folder', weight: 'carried', label: 'Camera' },
    ]);
  });

  it('absent annotations add nothing', () => {
    expect(photoBadges({ ...NONE, folder: null, sdCard: false })).toEqual([]);
  });
});

describe('folderNameOfUri (F19: last folder name only)', () => {
  it('takes the segment above the filename', () => {
    expect(folderNameOfUri('file:///storage/emulated/0/DCIM/Camera/IMG_001.jpg')).toBe('Camera');
    expect(folderNameOfUri('file:///storage/0A91-E18D/Pictures/Trips/rome.jpg')).toBe('Trips');
  });

  it('is honest about uris without a usable directory', () => {
    expect(folderNameOfUri('content://media/external/images/1')).toBeNull();
    expect(folderNameOfUri('file:///lonely.jpg')).toBeNull();
    expect(folderNameOfUri(null)).toBeNull();
  });

  it('decodes percent-escapes so the pill shows the real name', () => {
    expect(folderNameOfUri('file:///storage/emulated/0/My%20Photos/x.jpg')).toBe('My Photos');
  });
});

describe('isSdPhoto (F14)', () => {
  it('is true exactly for non-primary volumes', () => {
    expect(isSdPhoto('external_primary/123')).toBe(false);
    expect(isSdPhoto('0a91-e18d/123')).toBe(true);
  });
});
