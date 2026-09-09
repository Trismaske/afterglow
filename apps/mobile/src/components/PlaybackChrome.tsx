/**
 * PlaybackChrome — the DECK-TIER playback controls (m0.9 phase 5, M4),
 * shared by a video page and a motion photo's clip overlay because the
 * media model gives both kinds the same playback machinery and chrome:
 * a speaker toggle, a thin non-interactive progress hairline, and a
 * play/replay control. The expanded (immersive) stage renders none of
 * this — expo-video's native controller supplies the full transport
 * there — so callers omit it in immersive mode.
 *
 * Exempt from the eye (M21's "functional labels never hideable" rule):
 * these operate the clip, they do not annotate it.
 */
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, useTheme } from '../theme';

export function PlaybackChrome({
  showPlayControl,
  ended,
  muted,
  progress,
  onPlay,
  onToggleMuted,
  playLabel = 'Play',
}: {
  /** Paused, not started, or ended — the centre control is offered. */
  showPlayControl: boolean;
  /** The clip played to its end: the control reads Replay. */
  ended: boolean;
  muted: boolean;
  /** 0–1 of the clip's duration. */
  progress: number;
  onPlay: () => void;
  onToggleMuted: () => void;
  /** The accessibility label of a fresh play (the replay label is fixed). */
  playLabel?: string;
}) {
  const theme = useTheme();
  return (
    <>
      {showPlayControl && (
        <Pressable
          style={styles.playControl}
          onPress={onPlay}
          accessibilityLabel={ended ? 'Replay' : playLabel}
        >
          <MaterialCommunityIcons name={ended ? 'replay' : 'play'} size={44} color={colors.text} />
        </Pressable>
      )}
      <Pressable
        style={styles.speaker}
        onPress={onToggleMuted}
        accessibilityLabel={muted ? 'Unmute' : 'Mute'}
      >
        <MaterialCommunityIcons
          name={muted ? 'volume-off' : 'volume-high'}
          size={22}
          color={colors.text}
        />
      </Pressable>
      <View style={styles.hairlineTrack} pointerEvents="none">
        <View
          style={[styles.hairline, { width: `${progress * 100}%`, backgroundColor: theme.accent }]}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  playControl: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    marginLeft: -36,
    marginTop: -36,
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  speaker: {
    position: 'absolute',
    right: 10,
    bottom: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  hairlineTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  hairline: { height: 2 },
});
