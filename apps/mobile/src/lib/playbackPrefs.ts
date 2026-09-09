/**
 * Playback modes (m0.9 phase 5, M5): two durable per-kind settings under
 * Settings › Playback — Videos and Motion photos — each Once · Loop ·
 * Off, both defaulting to Once (the reference galleries' behaviour).
 *
 *   once — play muted when the pager page settles; a video rests on its
 *          last frame, a motion photo rests on its still.
 *   loop — the same start, replaying until the page leaves.
 *   off  — the poster (a video's OS frame, a motion photo's still) with
 *          a play control; nothing moves until asked.
 *
 * GIFs are outside this setting by design (M14): they are photos that
 * animate natively everywhere, with no chrome and no still identity a
 * toggle could reveal.
 *
 * Pure: the keys and the parse/serialize pair. Reading and writing the
 * settings rows is the caller's (SettingsScreen, the stage's host).
 */

export type PlaybackMode = 'once' | 'loop' | 'off';

/** The kinds a playback setting governs — videos and motion photos. */
export type PlaybackKind = 'video' | 'motion';

export const PLAYBACK_KEYS: Record<PlaybackKind, string> = {
  video: 'playback_video',
  motion: 'playback_motion',
};

export const PLAYBACK_MODES: readonly { id: PlaybackMode; label: string }[] = [
  { id: 'once', label: 'Once' },
  { id: 'loop', label: 'Loop' },
  { id: 'off', label: 'Off' },
];

export const DEFAULT_PLAYBACK_MODE: PlaybackMode = 'once';

/** A stored value → mode; anything unrecognised (including a missing
 * row) is the default, so a corrupt row never disables playback. */
export function parsePlaybackMode(raw: string | null): PlaybackMode {
  return PLAYBACK_MODES.some((m) => m.id === raw) ? (raw as PlaybackMode) : DEFAULT_PLAYBACK_MODE;
}

export function serializePlaybackMode(mode: PlaybackMode): string {
  return mode;
}
