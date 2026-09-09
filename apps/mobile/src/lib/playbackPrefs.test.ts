import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAYBACK_MODE,
  PLAYBACK_KEYS,
  parsePlaybackMode,
  serializePlaybackMode,
} from './playbackPrefs';

describe('playback modes (M5)', () => {
  it('round-trips every mode and defaults everything else to Once', () => {
    for (const mode of ['once', 'loop', 'off'] as const) {
      expect(parsePlaybackMode(serializePlaybackMode(mode))).toBe(mode);
    }
    expect(parsePlaybackMode(null)).toBe('once');
    expect(parsePlaybackMode('looped')).toBe('once');
    expect(parsePlaybackMode('')).toBe('once');
    expect(DEFAULT_PLAYBACK_MODE).toBe('once');
  });

  it('keeps the two kinds on distinct settings rows', () => {
    expect(PLAYBACK_KEYS.video).not.toBe(PLAYBACK_KEYS.motion);
  });
});
