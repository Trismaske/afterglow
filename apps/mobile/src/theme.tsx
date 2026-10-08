/**
 * Dark, photo-first palette with big touch targets (hotel-at-night UX).
 *
 * Split (m0.4): the background/surface/text neutrals and the FIXED
 * semantic colors (keep-green = success, cull-red = destructive,
 * edit-blue, favourite-pink, share-teal, organize-amber — one hue per
 * queue action, shared by its button and its badge) live in the static
 * `colors` object; the ACCENT — chips,
 * primary buttons, chevrons, links — is dynamic (Material You "System"
 * or a fixed preset, user-chosen in Settings) and comes from
 * `useTheme()`: `accent`, `onAccent`, `accentMuted`. Danger stays red
 * and keep stays green regardless of the chosen accent.
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import {
  ACCENT_SETTING_KEY,
  accentTokens,
  DEFAULT_ACCENT_CHOICE,
  parseAccentChoice,
  parseHexColor,
  resolveAccentBase,
  serializeAccentChoice,
  type AccentChoice,
  type AccentTokens,
} from './lib/accentTheme';
import { setSetting } from './db/store';
import { getSystemAccents } from '../modules/material-you-accent';

export const colors = {
  background: '#0d0f12',
  surface: '#1a1d23',
  surfaceRaised: '#242830',
  border: '#2e333d',
  text: '#f2f4f8',
  textDim: '#9aa3b2',
  keep: '#3fb96a',
  keepDim: '#2a4a36',
  cull: '#e05252',
  cullDim: '#5a2a2a',
  edit: '#5f8fe8',
  editDim: '#22334f',
  fav: '#e668a7',
  favDim: '#4f2238',
  share: '#3fbccc',
  shareDim: '#1c4048',
  organize: '#d9a13c',
  organizeDim: '#4a3a1c',
} as const;

export const touch = {
  /** Minimum height for primary action buttons. */
  action: 64,
  radius: 14,
} as const;

/**
 * The type scale (m0.9.1): six named text styles, each a size and the
 * line height that fits it. Every Text site spreads one of them
 * (`...type.body`) and keeps its own weight and colour, so the app has
 * six sizes instead of sixteen and a line height that scales with the
 * OS font setting (React Native scales both with `fontScale`). Sizes are
 * dp before scaling; the accessibility walk (docs/accessibility-audit.md)
 * measured how each surface survives the scale.
 */
export const type = {
  /** The one big number or headline on a screen (Home's ring, Summary). */
  display: { fontSize: 28, lineHeight: 34 },
  /** A screen or card title. */
  title: { fontSize: 22, lineHeight: 28 },
  /** A section heading, a row title, a button label. */
  heading: { fontSize: 17, lineHeight: 22 },
  /** Body copy, hints, explainers. */
  body: { fontSize: 15, lineHeight: 20 },
  /** Secondary labels, chips, badges, table cells. */
  label: { fontSize: 13, lineHeight: 18 },
  /** Captions, timestamps, axis ticks, tab labels. */
  caption: { fontSize: 11, lineHeight: 15 },
} as const;

/** Spacing on a 4-dp grid: a screen's horizontal inset, a card's inner
 * padding, the gap between cards or sections, and the gap between the
 * rows inside one. */
export const space = {
  page: 16,
  card: 16,
  gap: 12,
  tight: 8,
} as const;

/** Corner radii by role: the stage's boxes and badge tags, thumbnails,
 * chips, cards and sheets, and the fully round pill. */
export const radius = {
  box: 6,
  thumb: 8,
  chip: 10,
  card: 14,
  pill: 999,
} as const;

/** The two darkening scrims: a sheet's backdrop over the screen, and a
 * mark's backdrop over a photo (the stage boxes, thumbnail marks,
 * playback chrome). */
export const scrim = {
  sheet: 'rgba(0,0,0,0.65)',
  mark: 'rgba(0,0,0,0.55)',
} as const;

export interface AccentTheme extends AccentTokens {
  /** The persisted selection ("system" may still resolve to amber when unavailable). */
  choice: AccentChoice;
  /** Wallpaper accent from Material You, or null when unavailable (iOS, Android < 12). */
  systemAccent: string | null;
  /** Persist + live-apply a new selection. */
  setChoice: (choice: AccentChoice) => void;
}

const ThemeContext = createContext<AccentTheme | null>(null);

/**
 * Provides the accent tokens. Must sit inside SQLiteProvider (reads the
 * persisted choice synchronously on first render — no accent flash) and
 * above every screen. The system palette is read once per app launch;
 * a wallpaper change re-applies on next launch.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const db = useSQLiteContext();

  // Static per mount: Android re-creates the activity on wallpaper/theme
  // changes, so a fresh launch re-reads the palette.
  const [systemAccent] = useState<string | null>(() => {
    const sys = getSystemAccents();
    return sys && parseHexColor(sys.accent200) ? sys.accent200 : null;
  });

  const [choice, setChoiceState] = useState<AccentChoice>(() => {
    try {
      const row = db.getFirstSync<{ value: string }>(
        'SELECT value FROM settings WHERE key = ?',
        ACCENT_SETTING_KEY,
      );
      return parseAccentChoice(row?.value ?? null);
    } catch {
      return DEFAULT_ACCENT_CHOICE;
    }
  });

  const setChoice = useCallback(
    (next: AccentChoice) => {
      setChoiceState(next);
      void setSetting(db, ACCENT_SETTING_KEY, serializeAccentChoice(next)).catch(() => {});
    },
    [db],
  );

  const value = useMemo<AccentTheme>(
    () => ({
      ...accentTokens(resolveAccentBase(choice, systemAccent)),
      choice,
      systemAccent,
      setChoice,
    }),
    [choice, systemAccent, setChoice],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The current accent tokens; throws outside ThemeProvider. */
export function useTheme(): AccentTheme {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used within ThemeProvider');
  return value;
}
