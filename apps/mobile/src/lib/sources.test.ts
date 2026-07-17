import { describe, expect, it } from 'vitest';
import {
  dirOfUri,
  escapeLike,
  isUnderAnyRoot,
  isUnderRoot,
  matchAlbumIds,
  parsePhotoSourceSetting,
  serializePhotoSourceSetting,
  sourceDirOfUri,
  sourceLabel,
  sourceLikePattern,
  storageRelativeDir,
  type PhotoSourceSetting,
} from './sources';

describe('parse/serialize round trip', () => {
  it('round-trips both modes', () => {
    const settings: PhotoSourceSetting[] = [
      { mode: 'all' },
      { mode: 'dirs', dirs: ['DCIM/Camera', 'Pictures/Screenshots'] },
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
    expect(parsePhotoSourceSetting('{"mode":"dirs","dirs":[""]}')).toBeNull();
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

  it('isUnderAnyRoot checks every root', () => {
    expect(isUnderAnyRoot('Pictures/Editor', ['DCIM/Camera', 'Pictures'])).toBe(true);
    expect(isUnderAnyRoot('Download', ['DCIM/Camera', 'Pictures'])).toBe(false);
  });
});

describe('matchAlbumIds', () => {
  const albums = [
    { albumIds: ['1'], dir: 'DCIM/Camera' },
    { albumIds: ['2'], dir: 'DCIM/Camera/Burst' },
    { albumIds: ['3', '4'], dir: 'Pictures/Screenshots' }, // two volumes, same dir
    { albumIds: ['5'], dir: 'Download' },
  ];

  it('collects ids recursively under the selected roots', () => {
    expect(matchAlbumIds(albums, ['DCIM/Camera'])).toEqual(['1', '2']);
    expect(matchAlbumIds(albums, ['Pictures'])).toEqual(['3', '4']);
    expect(matchAlbumIds(albums, ['DCIM/Camera', 'Download'])).toEqual(['1', '2', '5']);
  });

  it('matches nothing for roots with no buckets', () => {
    expect(matchAlbumIds(albums, ['Movies'])).toEqual([]);
  });
});

describe('LIKE helpers', () => {
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });

  it('builds a containment pattern around the root', () => {
    expect(sourceLikePattern('DCIM/Camera')).toBe('%/DCIM/Camera/%');
    expect(sourceLikePattern('My_Folder')).toBe('%/My\\_Folder/%');
  });
});

describe('sourceLabel', () => {
  it('labels each shape', () => {
    expect(sourceLabel({ mode: 'all' })).toBe('All folders');
    expect(sourceLabel({ mode: 'dirs', dirs: ['DCIM/Camera'] })).toBe('DCIM/Camera');
    expect(sourceLabel({ mode: 'dirs', dirs: ['DCIM/Camera', 'Pictures', 'Download'] })).toBe(
      'DCIM/Camera +2 more',
    );
  });
});
