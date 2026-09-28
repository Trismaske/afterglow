import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERLAY_PREFS,
  OVERLAY_KEYS,
  OVERLAY_ROWS,
  parseOverlayPrefs,
  serializeOverlayPref,
} from './overlayPrefs';

describe('overlayPrefs', () => {
  it('defaults everything on except megapixels (M19)', () => {
    expect(DEFAULT_OVERLAY_PREFS).toEqual({
      dateTime: true,
      folder: true,
      position: true,
      pixels: true,
      megapixels: false,
      extension: true,
      duration: true,
      kindChips: true,
      statusBadges: true,
    });
  });

  it('has nine rows with distinct settings keys', () => {
    expect(OVERLAY_ROWS).toHaveLength(9);
    expect(new Set(OVERLAY_KEYS).size).toBe(9);
  });

  it('reads 1/0 rows and keeps the default for unset or odd rows', () => {
    const raw = new Map<string, string | null>([
      ['overlay_megapixels', '1'],
      ['overlay_position', '0'],
      ['overlay_duration', 'maybe'],
      ['overlay_extension', null],
    ]);
    const prefs = parseOverlayPrefs(raw);
    expect(prefs.megapixels).toBe(true);
    expect(prefs.position).toBe(false);
    expect(prefs.duration).toBe(true);
    expect(prefs.extension).toBe(true);
    expect(prefs.statusBadges).toBe(true);
  });

  it('round-trips through the serializer', () => {
    const raw = new Map(OVERLAY_ROWS.map((r) => [r.key, serializeOverlayPref(!r.defaultOn)]));
    const prefs = parseOverlayPrefs(raw);
    for (const r of OVERLAY_ROWS) expect(prefs[r.row]).toBe(!r.defaultOn);
  });
});
