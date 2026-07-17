/**
 * Accent-color setting + token derivation (m0.4) — pure logic,
 * unit-tested. The theme context (src/theme.tsx) resolves the persisted
 * choice against the Material You system palette (local Expo module)
 * and derives the semantic tokens; Settings renders the presets.
 *
 * Tokens:
 * - accent      — the base accent (chips, primary buttons, links, chevrons)
 * - onAccent    — text/icons ON an accent-filled surface, picked by
 *                 luminance: a near-black tint of the accent on light
 *                 accents, near-white on dark ones
 * - accentMuted — the accent blended far toward the app background;
 *                 used for subtle "selected" fills (e.g. deck Best pill)
 *
 * Success (keep-green) and destructive (cull-red) are NOT tokens here —
 * they stay fixed in src/theme.tsx regardless of the chosen accent.
 */

/** settings-table key for the persisted accent choice. */
export const ACCENT_SETTING_KEY = 'accent_color';

/** The classic Afterglow amber — the fallback whenever "system" is unavailable. */
export const AMBER_ACCENT = '#e8a54b';

export type AccentChoice = 'system' | 'amber' | 'coral' | 'green' | 'sky' | 'violet' | 'rose';

/**
 * Default is "system": on Android 12+ the accent follows the wallpaper;
 * anywhere the system palette is unavailable it resolves to amber, so
 * the default is always safe to store.
 */
export const DEFAULT_ACCENT_CHOICE: AccentChoice = 'system';

export interface AccentPreset {
  id: Exclude<AccentChoice, 'system'>;
  label: string;
  hex: string;
}

/** Fixed swatches offered beside "System", tuned for the dark surfaces. */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'amber', label: 'Amber', hex: AMBER_ACCENT },
  { id: 'coral', label: 'Coral', hex: '#ee8570' },
  { id: 'green', label: 'Green', hex: '#74c69d' },
  { id: 'sky', label: 'Sky blue', hex: '#6fb3e8' },
  { id: 'violet', label: 'Violet', hex: '#a49bef' },
  { id: 'rose', label: 'Rose', hex: '#e589b4' },
] as const;

const CHOICE_IDS: readonly AccentChoice[] = [
  'system',
  ...ACCENT_PRESETS.map((p) => p.id),
];

/** Parse a persisted choice; absent or unknown values fall back to the default. */
export function parseAccentChoice(raw: string | null): AccentChoice {
  const trimmed = raw?.trim() ?? '';
  return (CHOICE_IDS as readonly string[]).includes(trimmed)
    ? (trimmed as AccentChoice)
    : DEFAULT_ACCENT_CHOICE;
}

export function serializeAccentChoice(choice: AccentChoice): string {
  return choice;
}

/**
 * The base accent hex for a choice. `systemAccent` is the wallpaper
 * accent from the native module (null when unavailable — iOS, Android
 * < 12, module missing); "system" then degrades to amber. An invalid
 * hex from any source also degrades to amber rather than propagating.
 */
export function resolveAccentBase(choice: AccentChoice, systemAccent: string | null): string {
  const base =
    choice === 'system'
      ? systemAccent ?? AMBER_ACCENT
      : ACCENT_PRESETS.find((p) => p.id === choice)?.hex ?? AMBER_ACCENT;
  return parseHexColor(base) ? base : AMBER_ACCENT;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse #rgb / #rrggbb (case-insensitive); null for anything else. */
export function parseHexColor(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

function toHex(rgb: Rgb): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}

/**
 * Linear blend a→b in sRGB space; t=0 gives a, t=1 gives b. Invalid
 * inputs return `a` unchanged (or black when even `a` is invalid) so
 * derivation never throws at render time.
 */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHexColor(a);
  const cb = parseHexColor(b);
  if (!ca) return '#000000';
  if (!cb) return toHex(ca);
  const u = Math.max(0, Math.min(1, t));
  return toHex({
    r: ca.r + (cb.r - ca.r) * u,
    g: ca.g + (cb.g - ca.g) * u,
    b: ca.b + (cb.b - ca.b) * u,
  });
}

/** WCAG relative luminance, 0 (black) .. 1 (white). Invalid hex → 0. */
export function relativeLuminance(hex: string): number {
  const rgb = parseHexColor(hex);
  if (!rgb) return 0;
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** Matches colors.background / colors.text in src/theme.tsx. */
const DARK_BACKGROUND = '#0d0f12';
const NEAR_WHITE = '#f2f4f8';

/**
 * Accents lighter than this luminance take near-black text; darker ones
 * take near-white. All shipped presets (and Material You accent1_200,
 * tone 80) sit above it, matching the old hand-picked #1a1205-on-amber.
 */
const ON_ACCENT_LUMINANCE_CUTOFF = 0.35;

/**
 * Text color for content sitting on the accent. Light accents get a
 * 11%-of-accent near-black tint (keeps a whisper of the hue, like the
 * original amber's #1a1205); dark accents get the app's near-white.
 */
export function onAccentFor(accent: string): string {
  return relativeLuminance(accent) >= ON_ACCENT_LUMINANCE_CUTOFF
    ? mixHex(accent, '#000000', 0.89)
    : NEAR_WHITE;
}

/** The accent sunk 78% toward the app background — subtle selected fills. */
export function accentMutedFor(accent: string, background: string = DARK_BACKGROUND): string {
  return mixHex(accent, background, 0.78);
}

export interface AccentTokens {
  accent: string;
  onAccent: string;
  accentMuted: string;
}

/** Derive all semantic accent tokens from a base accent hex. */
export function accentTokens(base: string): AccentTokens {
  const accent = parseHexColor(base) ? base : AMBER_ACCENT;
  return {
    accent,
    onAccent: onAccentFor(accent),
    accentMuted: accentMutedFor(accent),
  };
}
