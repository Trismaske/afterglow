import { describe, expect, it } from 'vitest';
import {
  ACCENT_PRESETS,
  accentMutedFor,
  accentTokens,
  AMBER_ACCENT,
  DEFAULT_ACCENT_CHOICE,
  mixHex,
  onAccentFor,
  parseAccentChoice,
  parseHexColor,
  relativeLuminance,
  resolveAccentBase,
  serializeAccentChoice,
} from './accentTheme';

describe('parseAccentChoice', () => {
  it('round-trips every choice through serialize/parse', () => {
    for (const id of ['system', ...ACCENT_PRESETS.map((p) => p.id)] as const) {
      expect(parseAccentChoice(serializeAccentChoice(id))).toBe(id);
    }
  });

  it('falls back to the default on absent or garbage values', () => {
    expect(parseAccentChoice(null)).toBe(DEFAULT_ACCENT_CHOICE);
    expect(parseAccentChoice('')).toBe(DEFAULT_ACCENT_CHOICE);
    expect(parseAccentChoice('  ')).toBe(DEFAULT_ACCENT_CHOICE);
    expect(parseAccentChoice('magenta')).toBe(DEFAULT_ACCENT_CHOICE);
    expect(parseAccentChoice('#e8a54b')).toBe(DEFAULT_ACCENT_CHOICE);
    expect(parseAccentChoice('AMBER')).toBe(DEFAULT_ACCENT_CHOICE);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseAccentChoice(' violet ')).toBe('violet');
  });
});

describe('ACCENT_PRESETS', () => {
  it('starts with the classic amber and has unique ids and valid hexes', () => {
    expect(ACCENT_PRESETS[0]).toMatchObject({ id: 'amber', hex: AMBER_ACCENT });
    const ids = ACCENT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of ACCENT_PRESETS) expect(parseHexColor(p.hex)).not.toBeNull();
  });
});

describe('resolveAccentBase', () => {
  it('uses the system accent when chosen and available', () => {
    expect(resolveAccentBase('system', '#aac7ff')).toBe('#aac7ff');
  });

  it('degrades system to amber when unavailable or invalid', () => {
    expect(resolveAccentBase('system', null)).toBe(AMBER_ACCENT);
    expect(resolveAccentBase('system', 'not-a-color')).toBe(AMBER_ACCENT);
  });

  it('resolves presets to their hex, ignoring the system accent', () => {
    for (const p of ACCENT_PRESETS) {
      expect(resolveAccentBase(p.id, '#aac7ff')).toBe(p.hex);
    }
  });
});

describe('parseHexColor / mixHex', () => {
  it('parses 6- and 3-digit hex, rejects everything else', () => {
    expect(parseHexColor('#e8a54b')).toEqual({ r: 0xe8, g: 0xa5, b: 0x4b });
    expect(parseHexColor('#FFF')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor('e8a54b')).toBeNull();
    expect(parseHexColor('#e8a54')).toBeNull();
    expect(parseHexColor('#gggggg')).toBeNull();
    expect(parseHexColor('')).toBeNull();
  });

  it('mixes with exact endpoints and clamps t', () => {
    expect(mixHex('#e8a54b', '#000000', 0)).toBe('#e8a54b');
    expect(mixHex('#e8a54b', '#000000', 1)).toBe('#000000');
    expect(mixHex('#e8a54b', '#000000', -3)).toBe('#e8a54b');
    expect(mixHex('#e8a54b', '#000000', 3)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('never throws on invalid input', () => {
    expect(mixHex('junk', '#ffffff', 0.5)).toBe('#000000');
    expect(mixHex('#e8a54b', 'junk', 0.5)).toBe('#e8a54b');
  });
});

describe('relativeLuminance', () => {
  it('orders black < mid < white', () => {
    const black = relativeLuminance('#000000');
    const mid = relativeLuminance('#808080');
    const white = relativeLuminance('#ffffff');
    expect(black).toBe(0);
    expect(white).toBeCloseTo(1, 5);
    expect(mid).toBeGreaterThan(black);
    expect(mid).toBeLessThan(white);
  });

  it('returns 0 for invalid hex', () => {
    expect(relativeLuminance('nope')).toBe(0);
  });
});

describe('onAccentFor', () => {
  it('gives near-black tinted text on light accents (amber ≈ the old #1a1205)', () => {
    const on = onAccentFor(AMBER_ACCENT);
    expect(relativeLuminance(on)).toBeLessThan(0.05);
    // 11% of the accent: keeps a whisper of the hue.
    expect(on).toBe('#1a1208');
  });

  it('gives near-white text on dark accents', () => {
    expect(onAccentFor('#1d4ed8')).toBe('#f2f4f8');
    expect(onAccentFor('#000000')).toBe('#f2f4f8');
  });

  it('every shipped preset takes the dark-text branch', () => {
    for (const p of ACCENT_PRESETS) {
      expect(onAccentFor(p.hex)).not.toBe('#f2f4f8');
      expect(relativeLuminance(onAccentFor(p.hex))).toBeLessThan(0.05);
    }
  });
});

describe('accentMutedFor', () => {
  it('sinks the accent most of the way toward the background', () => {
    const muted = accentMutedFor(AMBER_ACCENT);
    // Close to the old hand-picked #3d3116 selected-fill hue.
    expect(muted).toBe('#3d301f');
    expect(relativeLuminance(muted)).toBeLessThan(relativeLuminance(AMBER_ACCENT));
  });

  it('respects a custom background', () => {
    expect(accentMutedFor('#ffffff', '#000000')).toBe('#383838');
  });
});

describe('accentTokens', () => {
  it('derives a consistent token set for a valid base', () => {
    const t = accentTokens(AMBER_ACCENT);
    expect(t).toEqual({
      accent: AMBER_ACCENT,
      onAccent: onAccentFor(AMBER_ACCENT),
      accentMuted: accentMutedFor(AMBER_ACCENT),
    });
  });

  it('falls back to amber tokens for an invalid base', () => {
    expect(accentTokens('garbage')).toEqual(accentTokens(AMBER_ACCENT));
  });
});
