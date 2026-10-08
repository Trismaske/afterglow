/**
 * The immersive flip as a continuous animation (m0.9.1 phase 4): the
 * photo or clip stays on screen and glides between the framed stage and
 * the edge-to-edge one while the chrome collapses or returns. The
 * geometry is lib/immersiveFlight.ts; this is the impure half — shared
 * values, the measured host, the commit and the timing.
 *
 * How a flight works (both directions):
 *
 * 1. `fly(next)` snapshots the photo's aspect (the stage's `imageAspect`
 *    is cleared by the host's resetZoom at the commit, so the flight
 *    keeps its own copy), reads the photo's CURRENT rect (the contain fit
 *    inside the stage box, in window coordinates, from the host's last
 *    JS measurement) as the path's start and the pre-commit host rect as
 *    the mark of the OLD layout, sets the next layout's gutter and border
 *    on the UI thread, commits the layout (the host's `commit`:
 *    setImmersive plus resetZoom) and runs the progress 0 → 1.
 * 2. The animated style MEASURES THE HOST ON THE UI THREAD EVERY FRAME
 *    (Reanimated's `measure` on the untransformed host) and holds the
 *    identity while the host still has the old layout's rect — React's
 *    commit lands one or two frames after `fly()`, and a transform drawn
 *    over the old layout showed the photo enlarged in place (the S10e
 *    recording, 2026-10-09). The moment the committed layout is on
 *    screen, the style maps "where this layout puts the photo" onto
 *    "where the path says it is", with the path's end being the current
 *    layout's own rect — so a late layout (the status bar, a resize)
 *    re-targets the path by itself and the transform is the identity the
 *    instant the path ends. No prediction, nothing to correct.
 * 3. Nothing is remounted and no host view is inserted under the
 *    detectors (MediaStage.tsx's rules): the two wrappers are
 *    always-present views around the stage, the inner one with a
 *    transform that is empty when idle. The HOST is the measured one:
 *    measureInWindow and measure() include transforms, so the animated
 *    view itself can never be what is measured (codex round 1).
 *
 * The one native reflow this design removes rather than absorbs: the
 * stack header is TRANSPARENT on the Deck route (App.tsx) and the deck
 * pads its root by the header's height itself, so hiding the header no
 * longer moves the content a beat after the commit (the "second flash"
 * the dip-to-black was built to mask). The status bar hides without a
 * reflow under edge-to-edge.
 *
 * The framed layout's gutter and border are remembered whenever the
 * framed layout measures, so the exit flight sets the framed constants on
 * the UI thread before its commit; the immersive ones are zero.
 *
 * Reduce motion keeps the dip-to-black cut: the host decides which flip
 * to run (components/useReduceMotion).
 */
import { useCallback, useEffect, useRef } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  measure,
  ReduceMotion,
  runOnJS,
  useAnimatedRef,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import {
  FLIGHT_MS,
  fitRect,
  flightEase,
  flightTransform,
  lerpRect,
  type Rect,
} from '../lib/immersiveFlight';

const ZERO: Rect = { x: 0, y: 0, w: 0, h: 0 };

function rectText(r: Rect): string {
  'worklet';
  return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}`;
}

interface FramedConstants {
  gutter: number;
  border: number;
}

export function useImmersiveFlight({
  immersive,
  imageAspect,
  gutter,
  border,
  windowWidth,
  commit,
}: {
  immersive: boolean;
  /** The current photo's aspect (w / h; 0 while unknown) — the stage's. */
  imageAspect: SharedValue<number>;
  /** The stage's gutter inside each page, for the CURRENT layout. */
  gutter: number;
  /** The frame's border for the CURRENT layout (0 in immersive). */
  border: number;
  /** The application window's width (what measureInWindow reports). */
  windowWidth: number;
  /** Applies the layout change (setImmersive and whatever rides it). */
  commit: (next: boolean) => void;
}) {
  const hostRef = useAnimatedRef<Animated.View>();
  const flying = useSharedValue(0);
  const progress = useSharedValue(0);
  const startRect = useSharedValue<Rect>(ZERO);
  /** The host's rect under the OLD layout: while the UI thread still
   * measures this, the commit has not landed and the style holds. */
  const preRect = useSharedValue<Rect>(ZERO);
  /** The host's last JS measurement (the path's start comes from it). */
  const hostRect = useSharedValue<Rect>(ZERO);
  const gutterSv = useSharedValue(gutter);
  const borderSv = useSharedValue(border);
  const windowW = useSharedValue(windowWidth);
  /** The aspect the flight was started with (resetZoom clears the stage's). */
  const flightAspect = useSharedValue(0);
  /** Diagnostics: 0 until the UI thread first saw the committed layout,
   * then 1; -1 when measure() answered null. */
  const seen = useSharedValue(0);
  /** The framed layout's constants, for the exit flight. */
  const framedRef = useRef<FramedConstants | null>(null);
  const immersiveRef = useRef(immersive);
  immersiveRef.current = immersive;
  const gutterRef = useRef(gutter);
  gutterRef.current = gutter;
  const borderRef = useRef(border);
  borderRef.current = border;
  const windowWidthRef = useRef(windowWidth);
  windowWidthRef.current = windowWidth;
  const flyingRef = useRef(false);

  // Between flights the UI thread follows the layout's constants; during
  // one it keeps the NEXT layout's, set by fly(), and lands on the real
  // ones in land().
  useEffect(() => {
    if (flyingRef.current) return;
    gutterSv.value = gutter;
    borderSv.value = border;
    windowW.value = windowWidth;
  }, [gutter, border, windowWidth, gutterSv, borderSv, windowW]);

  const stageBoxOf = useCallback(
    (host: Rect, g: number, b: number): Rect => ({
      x: g,
      y: host.y + b,
      w: windowWidth - 2 * g,
      h: host.h - 2 * b,
    }),
    [windowWidth],
  );

  const onHostLayout = useCallback(
    (_event: LayoutChangeEvent) => {
      // measureInWindow on the UNtransformed host: the rect on the window,
      // which is what the path is drawn in (onLayout's x/y are relative to
      // the parent, which itself moves when the root's padding changes).
      hostRef.current?.measureInWindow((x, y, w, h) => {
        if (!(w > 0 && h > 0)) return;
        hostRect.value = { x, y, w, h };
        if (!immersiveRef.current)
          framedRef.current = { gutter: gutterRef.current, border: borderRef.current };
        if (!flyingRef.current) {
          gutterSv.value = gutterRef.current;
          borderSv.value = borderRef.current;
        }
        // The width too: a resize during a flight (split-screen) must not
        // leave the UI thread on the old width (codex round 2).
        windowW.value = windowWidthRef.current;
      });
    },
    [hostRef, hostRect, gutterSv, borderSv, windowW],
  );

  const log = useCallback((line: string) => console.log(`[flight] ${line}`), []);
  const land = useCallback(() => {
    flyingRef.current = false;
    log(`landed, seen ${seen.value}`);
    // Whatever the sync effect skipped while flying lands now.
    gutterSv.value = gutterRef.current;
    borderSv.value = borderRef.current;
    windowW.value = windowWidthRef.current;
  }, [gutterSv, borderSv, windowW, log, seen]);

  /** Start a flight to `next`: 'in-flight' while one is in the air (the
   * tap is dropped), 'unmeasured' before the host ever laid out (the
   * host falls back to its cut). */
  const fly = useCallback(
    (next: boolean): 'started' | 'in-flight' | 'unmeasured' => {
      if (flyingRef.current) return 'in-flight';
      const host = hostRect.value;
      if (!(host.w > 0 && host.h > 0)) return 'unmeasured';
      const aspect = imageAspect.value;
      flightAspect.value = aspect;
      const g = gutterRef.current;
      const b = borderRef.current;
      const start = fitRect(aspect, stageBoxOf(host, g, b));
      startRect.value = start;
      preRect.value = host;
      // The NEXT layout's constants, read by the UI thread once the commit
      // has landed: immersive has none; framed has what it last measured.
      const framed = framedRef.current ?? { gutter: g, border: b };
      const nextG = next ? 0 : framed.gutter;
      const nextB = next ? 0 : framed.border;
      gutterSv.value = nextG;
      borderSv.value = nextB;
      flyingRef.current = true;
      flying.value = 1;
      progress.value = 0;
      seen.value = 0;
      // Field diagnostics (every build until v1, like the scan's): what
      // the flight started from, then what the UI thread measured first.
      // Locals, not shared-value reads: a JS read right after a JS write
      // can still answer the previous value.
      console.log(
        `[flight] ${next ? 'enter' : 'leave'} aspect ${aspect.toFixed(3)} pre ${rectText(host)} start ${rectText(start)} next g${nextG} b${nextB}`,
      );
      commit(next);
      // The host chose the mechanism from the LIVE reduce-motion setting;
      // Reanimated's own policy is a startup snapshot and would cut this
      // flight short after the setting was switched off (codex round 3).
      progress.value = withTiming(
        1,
        { duration: FLIGHT_MS, easing: Easing.linear, reduceMotion: ReduceMotion.Never },
        () => {
          flying.value = 0;
          runOnJS(land)();
        },
      );
      return 'started';
    },
    [
      hostRect,
      imageAspect,
      flightAspect,
      seen,
      startRect,
      preRect,
      gutterSv,
      borderSv,
      flying,
      progress,
      stageBoxOf,
      commit,
      land,
    ],
  );

  const flightStyle = useAnimatedStyle(() => {
    if (flying.value === 0) return { transform: [] };
    const m = measure(hostRef);
    if (m === null || !(m.width > 0 && m.height > 0)) {
      if (seen.value !== -1) {
        seen.value = -1;
        runOnJS(log)('measure() answered null on the UI thread');
      }
      return { transform: [] };
    }
    const host: Rect = { x: m.pageX, y: m.pageY, w: m.width, h: m.height };
    const pre = preRect.value;
    // The commit has not landed: the host still has the old layout's
    // rect, and the old layout must stay exactly as it is.
    if (
      Math.abs(host.h - pre.h) < 1 &&
      Math.abs(host.y - pre.y) < 1 &&
      Math.abs(host.w - pre.w) < 1
    )
      return { transform: [] };
    if (seen.value !== 1) {
      seen.value = 1;
      runOnJS(log)(
        `committed layout seen at progress ${progress.value.toFixed(2)}: host ${rectText(host)}`,
      );
    }
    const g = gutterSv.value;
    const b = borderSv.value;
    const layout = fitRect(flightAspect.value, {
      x: g,
      y: host.y + b,
      w: windowW.value - 2 * g,
      h: host.h - 2 * b,
    });
    const visual = lerpRect(startRect.value, layout, flightEase(progress.value));
    const t = flightTransform(layout, host, visual);
    return { transform: [{ translateX: t.tx }, { translateY: t.ty }, { scale: t.scale }] };
  });

  return { hostRef, onHostLayout, flightStyle, fly, flyingRef };
}
