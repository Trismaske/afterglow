/**
 * The OS "Remove animations" setting as live state (m0.9.1 phase 4):
 * Android's animator duration scale at 0, read through
 * AccessibilityInfo and followed through its change event, so a user who
 * flips the setting while the app is alive gets the cut on their next
 * flip — Reanimated's own useReducedMotion is a startup snapshot that
 * never updates (codex round 1). Until the first read answers, motion is
 * assumed allowed.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (on) => {
        if (alive) setReduce(on);
      },
      () => {},
    );
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}
