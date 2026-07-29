/**
 * The in-deck goal moment (m0.8.2, F14): fires once per day at the
 * decision that crosses the daily goal — where the work happened, not
 * back on Home. Accent edges "power up" from the bottom of the screen
 * (side rails grow upward, the top edge lights last), converging into
 * the goal ring popping to full with a small overshoot; everything
 * fades and the parent unmounts it. Accent is correct here: transient
 * interaction feedback (rule 3), not a stable meaning-carrier.
 *
 * Non-blocking by construction: pointerEvents="none" throughout, so the
 * swipe that earned the moment never waits on it. All animation is
 * driven FROM JS (shared values written in an effect, a plain
 * setTimeout ends it) — nothing here touches the worklets→JS bridge,
 * keeping to the deck's no-runOnJS rule even though these are not
 * gesture callbacks. One haptic tick via the built-in Vibration API.
 */
import React, { useEffect } from 'react';
import { StyleSheet, Vibration, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { GoalRing } from './GoalRing';

const TOTAL_MS = 1700;
const EDGE = 3;

export function GoalCelebration({
  goal,
  accent,
  onDone,
}: {
  goal: number;
  accent: string;
  /** Called (from JS, via setTimeout) when the moment is over. */
  onDone: () => void;
}) {
  const glow = useSharedValue(0);
  const pop = useSharedValue(0);

  useEffect(() => {
    Vibration.vibrate(60);
    glow.value = withSequence(
      withTiming(1, { duration: 420, easing: Easing.out(Easing.quad) }),
      withDelay(800, withTiming(0, { duration: 380 })),
    );
    pop.value = withDelay(
      180,
      withSequence(
        withTiming(1, { duration: 420, easing: Easing.out(Easing.back(2)) }),
        withDelay(700, withTiming(0, { duration: 300 })),
      ),
    );
    const timer = setTimeout(onDone, TOTAL_MS);
    return () => clearTimeout(timer);
    // Mount-only: the values live for exactly one celebration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bottomStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, glow.value * 3) }));
  const sideStyle = useAnimatedStyle(() => ({ height: `${glow.value * 100}%` }));
  const topStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, (glow.value - 0.75) * 4) }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, pop.value * 2),
    transform: [{ scale: 0.85 + 0.15 * pop.value }],
  }));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Animated.View
        style={[styles.edge, styles.bottom, { backgroundColor: accent }, bottomStyle]}
      />
      <Animated.View style={[styles.edge, styles.left, { backgroundColor: accent }, sideStyle]} />
      <Animated.View style={[styles.edge, styles.right, { backgroundColor: accent }, sideStyle]} />
      <Animated.View style={[styles.edge, styles.top, { backgroundColor: accent }, topStyle]} />
      <Animated.View style={[styles.center, ringStyle]}>
        <GoalRing
          size={150}
          strokeWidth={13}
          progress={1}
          color={accent}
          centerTitle={`${goal}`}
          centerSubtitle={`of ${goal} today`}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  edge: { position: 'absolute', borderRadius: EDGE },
  bottom: { left: 0, right: 0, bottom: 0, height: EDGE },
  top: { left: 0, right: 0, top: 0, height: EDGE },
  left: { left: 0, bottom: 0, width: EDGE },
  right: { right: 0, bottom: 0, width: EDGE },
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
