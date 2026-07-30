import { describe, expect, it } from 'vitest';
import {
  dirOfUri,
  escapeLike,
  foldAlbumsToDirs,
  isUnderAnyRoot,
  isUnderRoot,
  matchAlbumIds,
  matchAlbumIdsByVolume,
  parsePhotoSourceSetting,
  rootKey,
  rootLabel,
  serializePhotoSourceSetting,
  sourceDirOfUri,
  sourceLabel,
  sourceLikePattern,
  storageRelativeDir,
  volumeTag,
  type PhotoSourceSetting,
} from './sources';

const PRIMARY = 'external_primary';
const SD = '0a91-e18d';
const OTHER_VOLUME = 'ffff-0001';

describe('parse/serialize round trip', () => {
  it('round-trips both modes', () => {
    const settings: PhotoSourceSetting[] = [
      { mode: 'all' },
      {
        mode: 'dirs',
        dirs: [
          { volume: PRIMARY, dir: 'DCIM/Camera' },
          { volume: SD, dir: 'DCIM/100MSDCF' },
        ],
      },
    ];
    for (const setting of settings) {
      expect(parsePhotoSourceSetting(serializePhotoSourceSetting(setting))).toEqual(setting);
    }
  });

  it('rejects absent and malformed values', () => {
    expect(parsePhotoSourceSetting(null)).toBeNull();
    expect(parsePhotoSourceSetting('')).toBeNull();
    expect(parsePhotoSourceSetting('not json')).toBeNull();
    expect(parsePhotoSourceSetting('42')).toBeNull();
    expect(parsePhotoSourceSetting('{"mode":"bogus"}')).toBeNull();
    expect(parsePhotoSourceSetting('{"mode":"dirs","dirs":[]}')).toBeNull();
    expect(parsePhotoSourceSetting('{"mode":"dirs","dirs":[1]}')).toBeNull();
    expect(parsePhotoSourceSetting('{"mode":"dirs","dirs":[{"volume":"v"}]}')).toBeNull();
    expect(parsePhotoSourceSetting('{"mode":"dirs","dirs":[{"volume":"","dir":"D"}]}')).toBeNull();
    expect(parsePhotoSourceSetting('{"mode":"dirs","dirs":[{"volume":"v","dir":""}]}')).toBeNull();
  });

  it('rejects the pre-m0.8.3 path-only shape (no migration, D4/D14)', () => {
    expect(parsePhotoSourceSetting('{"mode":"dirs","dirs":["DCIM/Camera"]}')).toBeNull();
  });
});

describe('dirOfUri', () => {
  it('extracts the directory from a legacy file:// uri', () => {
    expect(dirOfUri('file:///storage/emulated/0/DCIM/Camera/IMG_001.jpg')).toBe(
      '/storage/emulated/0/DCIM/Camera',
    );
  });

  it('keeps raw paths raw (no percent-decoding, spaces intact)', () => {
    expect(dirOfUri('file:///storage/emulated/0/My Photos/a.jpg')).toBe(
      '/storage/emulated/0/My Photos',
    );
  });

  it('returns null for non-file uris and malformed values', () => {
    expect(dirOfUri('ph://ABC-123/L0/001')).toBeNull();
    expect(dirOfUri('content://media/external/images/media/42')).toBeNull();
    expect(dirOfUri('file:///rootfile.jpg')).toBeNull();
  });
});

describe('storageRelativeDir', () => {
  it('strips the internal-storage prefix', () => {
    expect(storageRelativeDir('/storage/emulated/0/DCIM/Camera')).toBe('DCIM/Camera');
  });

  it('strips SD-card volume prefixes', () => {
    expect(storageRelativeDir('/storage/ABCD-1234/DCIM/Camera')).toBe('DCIM/Camera');
    expect(storageRelativeDir('/sdcard/Pictures')).toBe('Pictures');
  });

  it('strips the whole /storage/self/primary alias — no phantom primary/ segment (codex r2)', () => {
    expect(storageRelativeDir('/storage/self/primary/DCIM/Camera')).toBe('DCIM/Camera');
  });

  it('keeps unrecognized prefixes (minus the leading slash)', () => {
    expect(storageRelativeDir('/data/media/0/DCIM')).toBe('data/media/0/DCIM');
  });
});

describe('sourceDirOfUri', () => {
  it('composes dir extraction and volume stripping', () => {
    expect(sourceDirOfUri('file:///storage/emulated/0/DCIM/Camera/IMG.jpg')).toBe('DCIM/Camera');
    expect(sourceDirOfUri('ph://ABC/1')).toBeNull();
  });
});

describe('isUnderRoot', () => {
  it('matches the root itself and true subdirectories', () => {
    expect(isUnderRoot('DCIM/Camera', 'DCIM/Camera')).toBe(true);
    expect(isUnderRoot('DCIM/Camera/Burst', 'DCIM/Camera')).toBe(true);
    expect(isUnderRoot('DCIM/Camera/Burst', 'DCIM')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isUnderRoot('dcim/camera', 'DCIM/Camera')).toBe(true);
  });

  it('never matches partial path segments or parents', () => {
    expect(isUnderRoot('DCIM/CameraX', 'DCIM/Camera')).toBe(false);
    expect(isUnderRoot('DCIM', 'DCIM/Camera')).toBe(false);
    expect(isUnderRoot('Pictures', 'DCIM')).toBe(false);
  });

  it('isUnderAnyRoot requires the volume to match exactly (D4)', () => {
    const roots = [
      { volume: PRIMARY, dir: 'DCIM/Camera' },
      { volume: SD, dir: 'Pictures' },
    ];
    expect(isUnderAnyRoot(PRIMARY, 'DCIM/Camera/Burst', roots)).toBe(true);
    expect(isUnderAnyRoot(SD, 'Pictures/Editor', roots)).toBe(true);
    // Same dir, wrong volume — a root never leaks across volumes.
    expect(isUnderAnyRoot(SD, 'DCIM/Camera/Burst', roots)).toBe(false);
    expect(isUnderAnyRoot(PRIMARY, 'Pictures/Editor', roots)).toBe(false);
    expect(isUnderAnyRoot(PRIMARY, 'Download', roots)).toBe(false);
  });
});

describe('matchAlbumIds', () => {
  const albums = [
    { albumIds: ['1'], volume: PRIMARY, dir: 'DCIM/Camera' },
    { albumIds: ['2'], volume: PRIMARY, dir: 'DCIM/Camera/Burst' },
    // The same relative path on two volumes: two distinct entries.
    { albumIds: ['3'], volume: PRIMARY, dir: 'Pictures/Screenshots' },
    { albumIds: ['4'], volume: SD, dir: 'Pictures/Screenshots' },
    { albumIds: ['5'], volume: PRIMARY, dir: 'Download' },
  ];

  it('collects ids recursively under the selected roots, volume-scoped', () => {
    expect(matchAlbumIds(albums, [{ volume: PRIMARY, dir: 'DCIM/Camera' }])).toEqual(['1', '2']);
    expect(matchAlbumIds(albums, [{ volume: PRIMARY, dir: 'Pictures' }])).toEqual(['3']);
    expect(matchAlbumIds(albums, [{ volume: SD, dir: 'Pictures' }])).toEqual(['4']);
    expect(
      matchAlbumIds(albums, [
        { volume: PRIMARY, dir: 'DCIM/Camera' },
        { volume: PRIMARY, dir: 'Download' },
      ]),
    ).toEqual(['1', '2', '5']);
  });

  it('matches nothing for roots with no buckets', () => {
    expect(matchAlbumIds(albums, [{ volume: PRIMARY, dir: 'Movies' }])).toEqual([]);
  });

  it('matchAlbumIdsByVolume groups ids per volume and keeps bucketless root volumes at []', () => {
    expect(
      matchAlbumIdsByVolume(albums, [
        { volume: PRIMARY, dir: 'DCIM/Camera' },
        { volume: SD, dir: 'Pictures' },
        // A root on a volume with no live bucket must still appear — the
        // tripwire reads it as 0, not as "unknown".
        { volume: SD, dir: 'Movies' },
      ]),
    ).toEqual({ [PRIMARY]: ['1', '2'], [SD]: ['4'] });
    expect(matchAlbumIdsByVolume(albums, [{ volume: OTHER_VOLUME, dir: 'DCIM' }])).toEqual({
      [OTHER_VOLUME]: [],
    });
  });
});

describe('foldAlbumsToDirs (catalog volume splitting)', () => {
  it('keeps the same relative path on two volumes as two entries', () => {
    const dirs = foldAlbumsToDirs([
      { volumeName: PRIMARY, bucketId: '1', relativePath: 'DCIM/Camera/', photoCount: 10 },
      { volumeName: SD, bucketId: '2', relativePath: 'DCIM/Camera/', photoCount: 3 },
    ]);
    expect(dirs).toEqual([
      { volume: SD, dir: 'DCIM/Camera', albumIds: ['2'], photoCount: 3 },
      { volume: PRIMARY, dir: 'DCIM/Camera', albumIds: ['1'], photoCount: 10 },
    ]);
  });

  it('merges buckets sharing a (volume, dir) and skips empties', () => {
    const dirs = foldAlbumsToDirs([
      { volumeName: PRIMARY, bucketId: '1', relativePath: 'Pictures/X/', photoCount: 4 },
      { volumeName: PRIMARY, bucketId: '2', relativePath: 'pictures/x/', photoCount: 2 },
      { volumeName: PRIMARY, bucketId: '3', relativePath: 'Pictures/Empty/', photoCount: 0 },
      { volumeName: PRIMARY, bucketId: '4', relativePath: '', photoCount: 9 },
    ]);
    expect(dirs).toEqual([
      { volume: PRIMARY, dir: 'Pictures/X', albumIds: ['1', '2'], photoCount: 6 },
    ]);
  });
});

describe('LIKE helpers', () => {
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });

  it('builds a containment pattern around the root dir', () => {
    expect(sourceLikePattern('DCIM/Camera')).toBe('%/DCIM/Camera/%');
    expect(sourceLikePattern('My_Folder')).toBe('%/My\\_Folder/%');
  });
});

describe('labels and keys', () => {
  it('tags non-primary volumes and only those', () => {
    expect(volumeTag(PRIMARY)).toBeNull();
    expect(volumeTag(SD)).toBe('SD card');
  });

  it('labels roots with their volume tag', () => {
    expect(rootLabel({ volume: PRIMARY, dir: 'DCIM/Camera' })).toBe('DCIM/Camera');
    expect(rootLabel({ volume: SD, dir: 'DCIM/100MSDCF' })).toBe('DCIM/100MSDCF (SD card)');
  });

  it('labels each setting shape', () => {
    expect(sourceLabel({ mode: 'all' })).toBe('All folders');
    expect(sourceLabel({ mode: 'dirs', dirs: [{ volume: PRIMARY, dir: 'DCIM/Camera' }] })).toBe(
      'DCIM/Camera',
    );
    expect(
      sourceLabel({
        mode: 'dirs',
        dirs: [
          { volume: SD, dir: 'DCIM/100MSDCF' },
          { volume: PRIMARY, dir: 'Pictures' },
          { volume: PRIMARY, dir: 'Download' },
        ],
      }),
    ).toBe('DCIM/100MSDCF (SD card) +2 more');
  });

  it('rootKey is volume-qualified and dir-case-insensitive', () => {
    expect(rootKey({ volume: SD, dir: 'DCIM/Camera' })).toBe(`${SD}|dcim/camera`);
    expect(rootKey({ volume: PRIMARY, dir: 'dcim/CAMERA' })).toBe(
      rootKey({ volume: PRIMARY, dir: 'DCIM/Camera' }),
    );
    expect(rootKey({ volume: SD, dir: 'DCIM/Camera' })).not.toBe(
      rootKey({ volume: PRIMARY, dir: 'DCIM/Camera' }),
    );
  });
});
