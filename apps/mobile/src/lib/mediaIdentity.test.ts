/**
 * Mechanism D volume parser (m0.8.3, D7) + canonical-id helpers.
 *
 * The uri shapes here are the spike-A-observed ones (S10e, Android 12,
 * SD UUID 0A91-E18D) plus every STORAGE_PREFIX variant sources.ts
 * recognizes — the parser must agree with the dir-stripping side about
 * which prefixes exist.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalContentUri,
  canonicalPhotoId,
  PRIMARY_VOLUME,
  rawIdOf,
  volumeOf,
  volumeOfUriPath,
} from './mediaIdentity';

describe('volumeOfUriPath (mechanism D)', () => {
  it('maps primary emulated storage to external_primary (spike A1)', () => {
    expect(volumeOfUriPath('file:///storage/emulated/0/DCIM/Camera/IMG_0001.jpg')).toBe(
      PRIMARY_VOLUME,
    );
  });

  it('maps any emulated Android-user index to primary', () => {
    expect(volumeOfUriPath('file:///storage/emulated/10/Pictures/a.jpg')).toBe(PRIMARY_VOLUME);
  });

  it('maps an SD-card path to the lowercased UUID (spike A1/A2)', () => {
    expect(volumeOfUriPath('file:///storage/0A91-E18D/DCIM/100MSDCF/DSC00001.JPG')).toBe(
      '0a91-e18d',
    );
  });

  it('keeps an already-lowercase volume segment as-is', () => {
    expect(volumeOfUriPath('file:///storage/0a91-e18d/DCIM/x.jpg')).toBe('0a91-e18d');
  });

  it('maps the legacy primary aliases to primary (STORAGE_PREFIX variants)', () => {
    expect(volumeOfUriPath('file:///sdcard/DCIM/Camera/a.jpg')).toBe(PRIMARY_VOLUME);
    expect(volumeOfUriPath('file:///mnt/sdcard/DCIM/Camera/a.jpg')).toBe(PRIMARY_VOLUME);
    expect(volumeOfUriPath('file:///storage/self/primary/DCIM/Camera/a.jpg')).toBe(PRIMARY_VOLUME);
  });

  it('accepts a raw path without the file:// prefix', () => {
    expect(volumeOfUriPath('/storage/emulated/0/DCIM/Camera/a.jpg')).toBe(PRIMARY_VOLUME);
    expect(volumeOfUriPath('/storage/ABCD-1234/DCIM/a.jpg')).toBe('abcd-1234');
  });

  it('fails closed on everything else', () => {
    // iOS asset uris, malformed values, and shapes with no volume prefix.
    expect(volumeOfUriPath('ph://ABCD-1234/L0/001')).toBeNull();
    expect(volumeOfUriPath('content://media/external_primary/images/media/42')).toBeNull();
    expect(volumeOfUriPath('')).toBeNull();
    expect(volumeOfUriPath('DCIM/Camera/a.jpg')).toBeNull();
    // A file directly at a mount root has no dir segment — no trailing
    // slash after the volume, so the prefix match must not fire.
    expect(volumeOfUriPath('file:///storage/emulated/0')).toBeNull();
    // /storage/emulated without a user index is not a volume.
    expect(volumeOfUriPath('file:///storage/emulated/x/DCIM/a.jpg')).toBeNull();
    // /storage/self without the primary alias tail is not a volume.
    expect(volumeOfUriPath('file:///storage/self/other/a.jpg')).toBeNull();
  });
});

describe('canonical id helpers', () => {
  it('round-trips volume and raw id', () => {
    const id = canonicalPhotoId('0a91-e18d', '12345');
    expect(id).toBe('0a91-e18d/12345');
    expect(volumeOf(id)).toBe('0a91-e18d');
    expect(rawIdOf(id)).toBe('12345');
  });

  it('maps bare legacy ids to primary', () => {
    expect(volumeOf('9876')).toBe(PRIMARY_VOLUME);
    expect(rawIdOf('9876')).toBe('9876');
  });

  it('constructs volume-qualified content uris — the anti-aliasing shape (codex r1)', () => {
    // Raw MediaStore ids collide across volumes, so every action must
    // address `content://media/<volume>/…`, never a merged-collection
    // resolution. Spike A6: the volume-qualified uri resolves the right
    // row and a wrong-volume uri does NOT resolve (fail-closed).
    expect(canonicalContentUri('external_primary/42')).toBe(
      'content://media/external_primary/images/media/42',
    );
    expect(canonicalContentUri('0a91-e18d/42')).toBe('content://media/0a91-e18d/images/media/42');
    // Bare legacy ids address primary.
    expect(canonicalContentUri('42')).toBe('content://media/external_primary/images/media/42');
  });
});
