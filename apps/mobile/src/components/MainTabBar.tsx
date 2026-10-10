/**
 * Custom bottom tab bar (m0.8.1): Edit · Favourite · HOME · Organize ·
 * Share, with Home as a bigger raised accent circle protruding above the
 * bar — the Material "docked center button" in overlap mode (the inset
 * variant carves an SVG notch; this app has no SVG dependency, so a
 * background-colored cradle ring behind the circle produces the same
 * cut-out read with plain Views).
 *
 * Hit-testing: Android does not reliably hit-test children outside a
 * parent's bounds, so the wrapper is RAISE taller than the visible bar
 * and transparent above it — the whole circle stays inside the wrapper.
 * The transparent strip and the overlay containers are pointerEvents
 * "box-none" so scene content behind them stays touchable.
 *
 * Options consumed per route: `title` (label), `tabBarBadge` (count).
 * Colors: bar = surface/border; items = accent when focused, textDim
 * otherwise; the Home circle is always accent-filled with the onAccent
 * icon (it is the bar's one primary action, not a toggling tab icon).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Icon } from './Icon';
import { colors, radius, type, useTheme } from '../theme';
import { useHugeText } from './useLargeText';
import { useTextOverflow } from './useTextOverflow';

export const TAB_ICONS = {
  Home: 'home-variant',
  EditQueue: 'pencil',
  FavouritesQueue: 'heart',
  ShareQueue: 'share-variant',
  OrganizeQueue: 'folder-move',
} as const;

/** Visible bar height (above the system inset). */
const BAR_HEIGHT = 58;
/** The count badge's disc: fixed, never scaled (see countFits). */
const BADGE_DP = 16;
/** How far the Home circle protrudes above the bar. */
const RAISE = 18;
/** Home circle diameter (theme touch.action-sized primary target). */
const HOME_SIZE = 64;
/** Cradle ring width around the circle (the fake notch). */
const CRADLE = 6;

export function MainTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const { accent, onAccent, accentMuted } = useTheme();
  /** Huge text (lib/textScale.ts): the labels go — a fifth of the bar
   * cannot hold "Favourite" past 1.6× on 360 dp — and the icons carry
   * the tab (the content-desc names it to a screen reader); the badge
   * keeps its disc; a dot replaces the count once the digit outgrows it. */
  const hugeText = useHugeText();
  /** Measured lever: any label needing a second line drops all five. */
  const labels = useTextOverflow(hugeText);
  const fontScale = useWindowDimensions().fontScale;
  /** The badge is a work indicator, not reading text (Tristan, 2026-10-09:
   * a count grown beside or over its icon wrecked the bar). The 16 dp
   * corner disc keeps its count while the scaled digit's line fits the
   * disc; past that the same corner shows a plain dot, and the count
   * stays in the queue's title and in this tab's accessibility label. */
  const countFits = type.caption.lineHeight * fontScale <= BADGE_DP;
  const barHeight = BAR_HEIGHT + insets.bottom;

  const pressHandlers = (routeKey: string, routeName: string, isFocused: boolean) => ({
    onPress: () => {
      const event = navigation.emit({
        type: 'tabPress',
        target: routeKey,
        canPreventDefault: true,
      });
      if (!isFocused && !event.defaultPrevented) navigation.navigate(routeName);
    },
    onLongPress: () => {
      navigation.emit({ type: 'tabLongPress', target: routeKey });
    },
  });

  return (
    <View style={{ height: barHeight + RAISE }} pointerEvents="box-none">
      <View
        style={[
          styles.bar,
          { height: barHeight, paddingBottom: insets.bottom, borderTopColor: colors.border },
        ]}
      >
        {state.routes.map((route, index) => {
          const isFocused = state.index === index;
          if (route.name === 'Home') {
            // Spacer under the raised circle keeps the four items evenly
            // spread; the circle itself renders in the overlay below.
            return <View key={route.key} style={styles.item} />;
          }
          const options = descriptors[route.key]!.options;
          const badge = options.tabBarBadge;
          const tint = isFocused ? accent : colors.textDim;
          return (
            <Pressable
              key={route.key}
              style={styles.item}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
              accessibilityLabel={
                badge !== undefined && badge !== 0
                  ? `${options.title ?? route.name}, ${badge} waiting`
                  : (options.title ?? route.name)
              }
              {...pressHandlers(route.key, route.name, isFocused)}
            >
              {/* Active indicator (tester decision): accent-muted pill
                  PLUS an accent outline matching the icon — the fill
                  alone was too subtle next to the raised Home circle.
                  The badge anchors to a sibling wrapper so the pill can
                  keep fixed dimensions (fully rounded ends). */}
              <View>
                <View
                  style={[
                    styles.iconPill,
                    isFocused && { backgroundColor: accentMuted, borderColor: accent },
                  ]}
                >
                  <Icon
                    name={TAB_ICONS[route.name as keyof typeof TAB_ICONS]}
                    size={24}
                    color={tint}
                  />
                </View>
                {badge !== undefined && badge !== 0 && countFits && (
                  <View style={[styles.badge, { backgroundColor: accent }]}>
                    <Text style={styles.badgeText}>{badge}</Text>
                  </View>
                )}
                {badge !== undefined && badge !== 0 && !countFits && (
                  <View style={[styles.dot, { backgroundColor: accent }]} />
                )}
              </View>
              {!labels.overflow && (
                <Text
                  style={[styles.label, { color: tint }, isFocused && styles.labelFocused]}
                  onTextLayout={labels.watch(route.name)}
                >
                  {options.title ?? route.name}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
      {/* Raised Home circle + cradle ring, centered over the bar. */}
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={[styles.cradle, { backgroundColor: colors.background }]} />
        {state.routes.map((route, index) => {
          if (route.name !== 'Home') return null;
          // Focused = filled accent circle (you are home). Elsewhere the
          // circle goes fully GREY (tester decision, matches Material
          // research: the center button is an action, not a tab state —
          // an accent ring here outshone the real selected tab).
          const isFocused = state.index === index;
          return (
            <Pressable
              key={route.key}
              style={[
                styles.homeButton,
                isFocused
                  ? { backgroundColor: accent }
                  : {
                      backgroundColor: colors.surface,
                      borderWidth: 2,
                      borderColor: colors.textDim,
                    },
              ]}
              accessibilityRole="button"
              accessibilityState={isFocused ? { selected: true } : {}}
              accessibilityLabel="Home"
              {...pressHandlers(route.key, route.name, isFocused)}
            >
              <Icon name={TAB_ICONS.Home} size={32} color={isFocused ? onAccent : colors.textDim} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingTop: 4,
  },
  label: { ...type.caption, fontWeight: '600' },
  labelFocused: { fontWeight: '800' },
  // Near-circle around the icon (tester decision — the wide pill pushed
  // the badge so far out it read as Home's). M3 keeps the LABEL outside
  // the indicator, below it. NOT radius = size/2: exactly half renders
  // SQUARE on this RN/Fabric version, hence 17 on 36 (invisible flats).
  iconPill: {
    width: 36,
    height: 36,
    // A circle, as in 0.9 (its 17 dp radius on 36 dp): the token pass
    // mapped it to the card radius and the pill read as a rounded square
    // beside the round Home cradle (Tristan's pick, 2026-10-11).
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: 'transparent',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    // Anchored to the 36 px icon circle — hugs the icon it counts.
    position: 'absolute',
    top: -3,
    right: -7,
    minWidth: BADGE_DP,
    height: BADGE_DP,
    borderRadius: radius.pill,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.background, ...type.caption, fontWeight: '700' },
  /** Large text: the count's place, no number. */
  dot: { position: 'absolute', top: 0, right: -3, width: 10, height: 10, borderRadius: 5 },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  cradle: {
    // Absolute with left/right unset: RN keeps the parent's centered
    // static position on the horizontal axis.
    position: 'absolute',
    top: -CRADLE,
    width: HOME_SIZE + CRADLE * 2,
    height: HOME_SIZE + CRADLE * 2,
    borderRadius: (HOME_SIZE + CRADLE * 2) / 2,
  },
  homeButton: {
    width: HOME_SIZE,
    height: HOME_SIZE,
    borderRadius: HOME_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
  },
});
