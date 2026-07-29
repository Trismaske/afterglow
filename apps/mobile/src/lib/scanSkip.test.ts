/** Scan-skip fingerprint (m0.8.1): every input the scan depends on must
 * break the match; no proof (empty generations) must never skip. */
import { describe, expect, it } from 'vitest';
import { scanCanSkip, scanFingerprint, scanStatusLine } from './scanSkip';

const base = {
  generations: { external_primary: 4211 },
  roots: ['DCIM/Camera'] as readonly string[] | null,
  strictness: null as string | null,
  modelSha: 'abc123',
};

describe('scanFingerprint', () => {
  it('is stable across key order and root order', () => {
    const a = scanFingerprint({
      ...base,
      generations: { a: 1, b: 2 },
      roots: ['DCIM/Camera', 'Pictures'],
    });
    const b = scanFingerprint({
      ...base,
      generations: { b: 2, a: 1 },
      roots: ['Pictures', 'DCIM/Camera'],
    });
    expect(a).toBe(b);
  });

  it('changes when any component changes', () => {
    const reference = scanFingerprint(base);
    expect(scanFingerprint({ ...base, generations: { external_primary: 4212 } })).not.toBe(
      reference,
    );
    expect(scanFingerprint({ ...base, roots: null })).not.toBe(reference);
    expect(scanFingerprint({ ...base, roots: ['Pictures'] })).not.toBe(reference);
    expect(scanFingerprint({ ...base, strictness: '2' })).not.toBe(reference);
    expect(scanFingerprint({ ...base, modelSha: 'def456' })).not.toBe(reference);
  });

  it('distinguishes all-folders from a named root', () => {
    expect(scanFingerprint({ ...base, roots: null })).not.toBe(
      scanFingerprint({ ...base, roots: [] }),
    );
  });
});

describe('scanCanSkip', () => {
  const current = scanFingerprint(base);

  it('skips only on an exact stored match', () => {
    expect(scanCanSkip({ generations: base.generations, stored: current, current })).toBe(true);
    expect(scanCanSkip({ generations: base.generations, stored: null, current })).toBe(false);
    expect(scanCanSkip({ generations: base.generations, stored: 'other', current })).toBe(false);
  });

  it('never skips without generation proof', () => {
    expect(scanCanSkip({ generations: {}, stored: current, current })).toBe(false);
  });
});

describe('multi-volume proof (m0.8.2)', () => {
  it('a volume that drops out changes the fingerprint, so it cannot skip', () => {
    // The S10e has an SD card, so two volumes is the normal case there.
    // Before the native call was made all-or-nothing, an unreadable
    // volume simply vanished from the map — and a map missing the SAME
    // volume on two launches compared equal, skipping the scan forever
    // while that volume's photos changed underneath.
    const both = scanFingerprint({
      generations: { external_primary: 12, '0a91-e18d': 7 },
      roots: ['DCIM/Camera'],
      strictness: null,
      modelSha: 'sha',
    });
    const primaryOnly = scanFingerprint({
      generations: { external_primary: 12 },
      roots: ['DCIM/Camera'],
      strictness: null,
      modelSha: 'sha',
    });
    expect(primaryOnly).not.toBe(both);
    // Stored under two volumes, seen with one: no skip.
    expect(
      scanCanSkip({
        generations: { external_primary: 12 },
        stored: both,
        current: primaryOnly,
      }),
    ).toBe(false);
    // And the SD volume changing alone is enough to force a pass.
    const sdMoved = scanFingerprint({
      generations: { external_primary: 12, '0a91-e18d': 8 },
      roots: ['DCIM/Camera'],
      strictness: null,
      modelSha: 'sha',
    });
    expect(scanCanSkip({ generations: { x: 1 }, stored: both, current: sdMoved })).toBe(false);
  });
});

describe('scanStatusLine', () => {
  const NOW = 1_800_000_000_000;

  it('states WHEN the library was last verified, and how big it is', () => {
    // The row answers "are my numbers current?" with a fact. Home
    // already re-checks on every open, so implying staleness with a bare
    // refresh button would be the wrong message. "Checked", not "full
    // pass": a SKIP verifies just as well and is the common case, so
    // wording it as a pass would report staleness that was disproved.
    expect(scanStatusLine({ verifiedAt: NOW - 2 * 3_600_000, corpus: 5795, now: NOW })).toBe(
      `Checked 2 hours ago · ${(5795).toLocaleString()} photos`,
    );
  });

  it('rounds the age down through minutes, hours and days', () => {
    const line = (ms: number) => scanStatusLine({ verifiedAt: NOW - ms, corpus: 1, now: NOW });
    expect(line(30_000)).toContain('just now');
    expect(line(60_000)).toContain('1 minute ago');
    expect(line(59 * 60_000)).toContain('59 minutes ago');
    expect(line(3_600_000)).toContain('1 hour ago');
    expect(line(47 * 3_600_000)).toContain('1 day ago');
    expect(line(72 * 3_600_000)).toContain('3 days ago');
  });

  it('never reports a NEGATIVE age from a clock that moved backwards', () => {
    expect(scanStatusLine({ verifiedAt: NOW + 60_000, corpus: 1, now: NOW })).toContain('just now');
  });

  it('says so plainly before anything has verified the library', () => {
    expect(scanStatusLine({ verifiedAt: null, corpus: 0 })).toBe('Not checked yet');
  });

  it('shows live percent progress while a full pass runs, whatever the last pass said', () => {
    expect(
      scanStatusLine({
        verifiedAt: NOW - 3_600_000,
        corpus: 5795,
        running: { scanned: 1200, total: 5795 },
        now: NOW,
      }),
    ).toBe(`Scanning 21% · ${(1200).toLocaleString()} of ${(5795).toLocaleString()} photos`);
    // Mid-scan arrivals can push `scanned` past the snapshot — clamp.
    expect(
      scanStatusLine({
        verifiedAt: null,
        corpus: 5795,
        running: { scanned: 6000, total: 5795 },
      }),
    ).toBe(`Scanning 100% · ${(5795).toLocaleString()} of ${(5795).toLocaleString()} photos`);
  });

  it('omits the total while the up-front count is unavailable', () => {
    expect(
      scanStatusLine({ verifiedAt: null, corpus: 0, running: { scanned: 40, total: null } }),
    ).toBe('Scanning now · 40 photos');
  });
});
