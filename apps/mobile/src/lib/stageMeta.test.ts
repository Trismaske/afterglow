import { describe, expect, it } from 'vitest';
import { DEFAULT_OVERLAY_PREFS, type OverlayPrefs } from './overlayPrefs';
import {
  extensionOf,
  folderAnnotation,
  folderNameOfUri,
  formatDuration,
  megapixelsOf,
  resolutionClassOf,
  stageMetaLines,
  type StageMetaInput,
} from './stageMeta';

const ALL_ON: OverlayPrefs = { ...DEFAULT_OVERLAY_PREFS, megapixels: true };

const photo: StageMetaInput = {
  when: 'Sat 12 Jul · 14:32',
  folder: null,
  sdCard: false,
  kind: null,
  facts: { displayName: '20260712_143201.jpg', width: 4032, height: 3024, durationMs: null },
};

describe('extensionOf', () => {
  it('uppercases the extension without the dot', () => {
    expect(extensionOf('IMG_0001.heic')).toBe('HEIC');
    expect(extensionOf('clip.mp4')).toBe('MP4');
  });
  it('is null without a usable extension', () => {
    expect(extensionOf(null)).toBeNull();
    expect(extensionOf('README')).toBeNull();
    expect(extensionOf('.hidden')).toBeNull();
    expect(extensionOf('trailing.')).toBeNull();
  });
});

describe('megapixelsOf and resolutionClassOf', () => {
  it('rounds ten and up, keeps one decimal below', () => {
    expect(megapixelsOf(4032, 3024)).toBe('12 MP');
    expect(megapixelsOf(8160, 4592)).toBe('37 MP');
    expect(megapixelsOf(640, 480)).toBe('0.3 MP');
    expect(megapixelsOf(3264, 2448)).toBe('8.0 MP');
  });
  it('classes a video by its shorter side, nearest class', () => {
    expect(resolutionClassOf(3840, 2160)).toBe('4K');
    expect(resolutionClassOf(1080, 1920)).toBe('1080p');
    expect(resolutionClassOf(1920, 1088)).toBe('1080p');
    expect(resolutionClassOf(2560, 1440)).toBe('2K');
    expect(resolutionClassOf(854, 480)).toBe('480p');
    expect(resolutionClassOf(7680, 4320)).toBe('8K');
  });
});

describe('formatDuration', () => {
  it('formats minutes, hours and the sub-second floor', () => {
    expect(formatDuration(34_000)).toBe('0:34');
    expect(formatDuration(725_000)).toBe('12:05');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(400)).toBe('0:01');
  });
});

describe('folder annotation', () => {
  it('names every folder but the primary camera roll (F31)', () => {
    expect(folderAnnotation('file:///storage/emulated/0/DCIM/Camera/a.jpg', false)).toBeNull();
    expect(folderAnnotation('file:///storage/emulated/0/WhatsApp/Media/b.jpg', false)).toBe(
      'Media',
    );
    expect(folderAnnotation('file:///storage/0A91-E18D/DCIM/Camera/c.jpg', true)).toBe('Camera');
    expect(folderAnnotation('content://media/external/images/media/9', false)).toBeNull();
  });
  it('decodes a folder segment and survives a literal percent', () => {
    expect(folderNameOfUri('file:///storage/emulated/0/My%20Pics/a.jpg')).toBe('My Pics');
    expect(folderNameOfUri('file:///storage/emulated/0/100%25Photos/a.jpg')).toBe('100%Photos');
    expect(folderNameOfUri('file:///storage/emulated/0/100%/a.jpg')).toBe('100%');
  });
});

describe('stageMetaLines', () => {
  it('lays a photo out as when / what with the defaults (no megapixels)', () => {
    expect(stageMetaLines(photo, DEFAULT_OVERLAY_PREFS)).toEqual([
      'Sat 12 Jul · 14:32',
      'JPG · 4032 × 3024',
    ]);
  });
  it('adds the where line only when there is a fact on it', () => {
    expect(stageMetaLines({ ...photo, folder: 'Screenshots' }, ALL_ON)).toEqual([
      'Sat 12 Jul · 14:32',
      'Screenshots',
      'JPG · 4032 × 3024 · 12 MP',
    ]);
    expect(stageMetaLines({ ...photo, sdCard: true, folder: 'Camera' }, ALL_ON)[1]).toBe(
      'Camera · SD card',
    );
  });
  it('gives a video its class and duration, never megapixels', () => {
    const video: StageMetaInput = {
      ...photo,
      kind: 'video',
      facts: { displayName: 'clip.mp4', width: 3840, height: 2160, durationMs: 34_000 },
    };
    expect(stageMetaLines(video, ALL_ON)[1]).toBe('MP4 · 3840 × 2160 · 4K · 0:34');
  });
  it("gives a motion photo its clip's duration once known, and omits it before", () => {
    const motion: StageMetaInput = {
      ...photo,
      kind: 'motion',
      facts: { displayName: 'm.jpg', width: 4032, height: 3024, durationMs: 2_900 },
    };
    expect(stageMetaLines(motion, ALL_ON)[1]).toBe('JPG · 4032 × 3024 · 12 MP · 0:03');
    expect(
      stageMetaLines({ ...motion, facts: { ...motion.facts!, durationMs: null } }, ALL_ON)[1],
    ).toBe('JPG · 4032 × 3024 · 12 MP');
  });
  it('omits unknown facts silently and drops empty lines (M17)', () => {
    expect(
      stageMetaLines(
        { ...photo, facts: { displayName: null, width: null, height: null, durationMs: null } },
        ALL_ON,
      ),
    ).toEqual(['Sat 12 Jul · 14:32']);
    expect(stageMetaLines({ ...photo, facts: null }, ALL_ON)).toEqual(['Sat 12 Jul · 14:32']);
  });
  it('is empty when every row is off', () => {
    const off = Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, false])) as OverlayPrefs;
    expect(stageMetaLines({ ...photo, folder: 'X', sdCard: true }, off)).toEqual([]);
  });
});
