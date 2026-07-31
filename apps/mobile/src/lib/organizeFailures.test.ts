import { describe, expect, it } from 'vitest';
import {
  appOwningPackage,
  describeOrganizeFailures,
  type OrganizeFailure,
} from './organizeFailures';

/** The real shapes, from the S10e (2026-07-31): a WhatsApp photo under
 * Android/media, and an ordinary camera photo. */
const WHATSAPP =
  'file:///storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-20260731-WA0004.jpg';
const CAMERA = 'file:///storage/emulated/0/DCIM/Camera/20260609_150226.jpg';
const SD_CARD = 'file:///storage/0a91-e18d/DCIM/x.jpg';

function failure(over: Partial<OrganizeFailure> = {}): OrganizeFailure {
  return { uri: CAMERA, status: 'error', message: 'boom', ...over };
}

describe('appOwningPackage', () => {
  it('names the package owning an app-storage photo', () => {
    expect(appOwningPackage(WHATSAPP)).toBe('com.whatsapp');
    // Android/data is the private sibling of Android/media; same rule.
    expect(
      appOwningPackage('file:///storage/emulated/0/Android/data/com.foo.bar/files/a.jpg'),
    ).toBe('com.foo.bar');
  });

  it('is null for ordinary shared media on either volume', () => {
    expect(appOwningPackage(CAMERA)).toBeNull();
    expect(appOwningPackage(SD_CARD)).toBeNull();
    // A folder merely NAMED Android is not app storage.
    expect(appOwningPackage('file:///storage/emulated/0/Pictures/Android/a.jpg')).toBeNull();
  });
});

describe('describeOrganizeFailures', () => {
  it('reports nothing when nothing failed', () => {
    expect(describeOrganizeFailures([])).toBeNull();
  });

  it('explains an app-storage photo from its PATH, not from Android’s wording', () => {
    // The message here is deliberately unrecognisable — the diagnosis
    // must come from the uri alone, which is what makes it survive a
    // reworded exception on a future Android or another OEM.
    const report = describeOrganizeFailures([
      failure({ uri: WHATSAPP, message: 'SomeVendorException: totally different words' }),
    ])!;
    expect(report.title).toBe('Could not move 1 photo');
    expect(report.body).toContain("another app's own storage (com.whatsapp)");
    expect(report.body).toContain('remove it from the queue');
  });

  it('always quotes Android verbatim, last', () => {
    const report = describeOrganizeFailures([
      failure({
        uri: WHATSAPP,
        message: 'IllegalArgumentException: Primary directory not allowed',
      }),
    ])!;
    expect(report.body).toContain('IllegalArgumentException: Primary directory not allowed');
    // Tier 3 sits under the explanation, never instead of it.
    expect(report.body.indexOf("another app's own storage")).toBeLessThan(
      report.body.indexOf('Android said:'),
    );
  });

  it('groups one cause into one sentence with a count', () => {
    const report = describeOrganizeFailures([
      failure({ uri: WHATSAPP, message: 'same' }),
      failure({ uri: WHATSAPP.replace('WA0004', 'WA0005'), message: 'same' }),
      failure({ uri: WHATSAPP.replace('WA0004', 'WA0006'), message: 'same' }),
    ])!;
    expect(report.title).toBe('Could not move 3 photos');
    expect(report.body).toContain('3 photos live in');
    // One cause, one sentence — not three.
    expect(report.body.match(/live in another app/g)).toHaveLength(1);
    // One distinct message, quoted once.
    expect(report.body.match(/• same/g)).toHaveLength(1);
  });

  it('names every distinct package it actually found', () => {
    const report = describeOrganizeFailures([
      failure({ uri: WHATSAPP }),
      failure({ uri: 'file:///storage/emulated/0/Android/media/com.zed/a.jpg' }),
    ])!;
    expect(report.body).toContain('(com.whatsapp, com.zed)');
  });

  it('separates the module-absent case from a platform refusal', () => {
    const report = describeOrganizeFailures([
      failure({ uri: CAMERA, status: 'unsupported', message: 'module unavailable' }),
      failure({ uri: CAMERA, status: 'error', message: 'IllegalStateException: nope' }),
    ])!;
    expect(report.body).toContain('media module is not available in this build');
    expect(report.body).toContain('Android refused to move 1 photo');
  });

  it('says an unconfirmed move is unconfirmed, not failed', () => {
    const report = describeOrganizeFailures([
      failure({ uri: CAMERA, message: 'verification failed' }),
    ])!;
    expect(report.body).toContain('did not confirm the new location');
    expect(report.body).toContain('may or may not have moved');
  });

  it('falls back to the generic line for a cause it cannot prove', () => {
    const report = describeOrganizeFailures([
      failure({ uri: CAMERA, message: 'IOException: No space left on device' }),
    ])!;
    expect(report.body).toContain('Android refused to move 1 photo');
    // ...but the real reason still reaches the user through tier 3.
    expect(report.body).toContain('IOException: No space left on device');
  });

  // The device pass shipped "1 photo live in another app's own storage"
  // because the plural sentence was tested and the singular one was not.
  // Every cause line can be reached with a count of exactly 1, so every
  // one of them is asserted here — the counts in these sentences are the
  // whole point of grouping, and bad agreement reads as a broken app.
  describe('reads correctly for a single photo', () => {
    it.each([
      ['app storage', failure({ uri: WHATSAPP }), ['1 photo lives in', 'remove it from the queue']],
      ['module absent', failure({ status: 'unsupported' }), ['so 1 photo was left untouched']],
      [
        'unconfirmed',
        failure({ message: 'verification failed' }),
        ['for 1 photo. It may or may not', 'so it stays queued'],
      ],
      ['generic', failure({ message: 'IOException: nope' }), ['move 1 photo. It stays queued']],
    ])('%s', (_name, only, expected) => {
      const body = describeOrganizeFailures([only])!.body;
      for (const phrase of expected) expect(body).toContain(phrase);
    });
  });

  it('reads correctly for several photos', () => {
    const many = (over: Partial<OrganizeFailure>) => [failure(over), failure(over)];
    expect(describeOrganizeFailures(many({ uri: WHATSAPP }))!.body).toContain('2 photos live in');
    expect(describeOrganizeFailures(many({ status: 'unsupported' }))!.body).toContain(
      'so 2 photos were left untouched',
    );
    expect(describeOrganizeFailures(many({ message: 'verification failed' }))!.body).toContain(
      'for 2 photos. They may or may not',
    );
    expect(describeOrganizeFailures(many({ message: 'nope' }))!.body).toContain(
      'move 2 photos. They stay queued',
    );
  });

  it('caps the quoted messages instead of printing a log', () => {
    const report = describeOrganizeFailures([
      failure({ message: 'one' }),
      failure({ message: 'two' }),
      failure({ message: 'three' }),
      failure({ message: 'four' }),
    ])!;
    expect(report.body).toContain('• one');
    expect(report.body).toContain('• two');
    expect(report.body).not.toContain('• three');
    expect(report.body).toContain('…and 2 other messages');
  });

  it('omits the quote block entirely when nothing came back', () => {
    const report = describeOrganizeFailures([failure({ uri: WHATSAPP, message: '   ' })])!;
    expect(report.body).not.toContain('Android said:');
    expect(report.body).toContain("another app's own storage");
  });
});
