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
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, useTheme } from '../theme';

export const TAB_ICONS = {
  Home: 'home-variant',
  EditQueue: 'pencil',
  FavouritesQueue: 'heart',
  ShareQueue: 'share-variant',
  OrganizeQueue: 'folder-move',
} as const;

/** Visible bar height (above the system inset). */
const BAR_HEIGHT = 58;
/** How far the Home circle protrudes above the bar. */
const RAISE = 18;
/** Home circle diameter (theme touch.action-sized primary target). */
const HOME_SIZE = 64;
/** Cradle ring width around the circle (the fake notch). */
const CRADLE = 6;

export function MainTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const { accent, onAccent, accentMuted } = useTheme();
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
              accessibilityLabel={options.title ?? route.name}
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
                  <MaterialCommunityIcons
                    name={TAB_ICONS[route.name as keyof typeof TAB_ICONS]}
                    size={24}
                    color={tint}
                  />
                </View>
                {badge !== undefined && badge !== 0 && (
                  <View style={[styles.badge, { backgroundColor: accent }]}>
                    <Text style={styles.badgeText}>{badge}</Text>
                  </View>
                )}
              </View>
              <Text style={[styles.label, { color: tint }, isFocused && styles.labelFocused]}>
                {options.title ?? route.name}
              </Text>
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
              <MaterialCommunityIcons
                name={TAB_ICONS.Home}
                size={32}
                color={isFocused ? onAccent : colors.textDim}
              />
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
  label: { fontSize: 11, fontWeight: '600' },
  labelFocused: { fontWeight: '800' },
  // Near-circle around the icon (tester decision — the wide pill pushed
  // the badge so far out it read as Home's). M3 keeps the LABEL outside
  // the indicator, below it. NOT radius = size/2: exactly half renders
  // SQUARE on this RN/Fabric version, hence 17 on 36 (invisible flats).
  iconPill: {
    width: 36,
    height: 36,
    borderRadius: 17,
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
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.background, fontSize: 10, fontWeight: '700' },
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
