import React, { Suspense, useEffect, useMemo } from 'react';
import { ActivityIndicator, Alert, AppState, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SQLiteProvider } from 'expo-sqlite';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSQLiteContext } from 'expo-sqlite';
import type { MainTabParamList, RootStackParamList } from './src/navigation';
import { countQueues } from './src/db/actions';
import { mountedVolumeSet, onVolumesChanged } from './src/lib/mountedVolumes';
import { DATABASE_NAME, migrateDatabase } from './src/db/database';
import { installShareResolution } from './src/lib/shareResolution';
import { ReviewProvider, useReview } from './src/review/ReviewContext';
import { HomeScreen } from './src/screens/HomeScreen';
import { TimelineScreen } from './src/screens/TimelineScreen';
import { DeckScreen } from './src/screens/DeckScreen';
import { CompareScreen } from './src/screens/CompareScreen';
import { CullListScreen } from './src/screens/CullListScreen';
import { SummaryScreen } from './src/screens/SummaryScreen';
import { EditQueueScreen } from './src/screens/EditQueueScreen';
import { FavouritesQueueScreen } from './src/screens/FavouritesQueueScreen';
import { ShareQueueScreen } from './src/screens/ShareQueueScreen';
import { OrganizeQueueScreen } from './src/screens/OrganizeQueueScreen';
import { HistoryScreen } from './src/screens/HistoryScreen';
import { StatsScreen } from './src/screens/StatsScreen';
import { DayProgressScreen } from './src/screens/DayProgressScreen';
import { ProgressScreen } from './src/screens/ProgressScreen';
import { SourcePickerScreen } from './src/screens/SourcePickerScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { colors, ThemeProvider, useTheme } from './src/theme';
import { MainTabBar } from './src/components/MainTabBar';
import { AMBER_ACCENT } from './src/lib/accentTheme';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

/**
 * The five count-badged bottom tabs, rendered by the custom MainTabBar
 * (m0.8.1): Edit · Favourite · HOME (raised center circle) · Organize ·
 * Share. Badges re-count on every review mutation (version) and when the
 * app returns to the foreground (external editor/gallery work) — never
 * on a timer.
 */
function MainTabs() {
  const db = useSQLiteContext();
  const { version } = useReview();
  const [badges, setBadges] = React.useState<Partial<Record<keyof MainTabParamList, number>>>({});
  useEffect(() => {
    let cancelled = false;
    // ONE retry per trigger (codex r8): a retry whose own failure
    // rescheduled again was an unbounded 4 s polling loop against a
    // persistently failing database.
    let retried = false;
    // Only the LATEST trigger may commit (final cycle N6): an older load
    // holding a pre-eject mounted set must not overwrite fresher badges.
    let loadGen = 0;
    const load = async () => {
      const myGen = ++loadGen;
      // v18: one grouped query for all four badges, where there used to
      // be four separate count functions over four different shapes.
      // FAIL CLOSED (codex r5): a rejected count keeps the last rendered
      // badges (absent renders as zero, and four synthetic zeroes would
      // hide real waiting work) and retries once shortly — beyond that,
      // the next review mutation or foreground return retries anyway.
      let queues: Awaited<ReturnType<typeof countQueues>>;
      try {
        queues = await countQueues(db, await mountedVolumeSet());
      } catch (error) {
        console.warn('[tabs] queue badge count failed — badges kept:', String(error));
        if (!cancelled && !retried) {
          retried = true;
          setTimeout(() => void load(), 4000);
        }
        return;
      }
      retried = false;
      if (cancelled || myGen !== loadGen) return;
      setBadges({
        EditQueue: queues.edit,
        FavouritesQueue: queues.favourite,
        ShareQueue: queues.share,
        OrganizeQueue: queues.organize,
      });
    };
    void load();
    // EVENT-DRIVEN, not polled (m0.8.1): review mutations bump `version`
    // (this effect's dep) and the only other source of change is work
    // done OUTSIDE the app — an editor, the gallery — which always
    // returns through an AppState 'active' transition. The old 15 s
    // interval re-ran four COUNT queries forever while foregrounded.
    const subscription = AppState.addEventListener('change', (next) => {
      // Mount-state invalidation on foreground lives in
      // lib/mountedVolumes.ts (module-scope listener, O6) — this reload
      // always reads a fresh set.
      if (next === 'active') void load();
    });
    // Live mount changes move the badges too (Tristan, m0.8.3 matrix):
    // a card swap with the app foregrounded fires no AppState event.
    const unsubscribeVolumes = onVolumesChanged(() => void load());
    return () => {
      cancelled = true;
      subscription.remove();
      unsubscribeVolumes();
    };
  }, [db, version]);
  const screenOptions = ({ route }: { route: { name: keyof MainTabParamList } }) => ({
    headerShown: false,
    tabBarBadge: badges[route.name] ? badges[route.name] : undefined,
  });
  const renderTabBar = (props: BottomTabBarProps) => <MainTabBar {...props} />;
  return (
    // Child order IS the bar order; Home is no longer first, so the
    // initial route is pinned explicitly — and so is the BACK history
    // (m0.8.2, F1): the router's default backBehavior seeds history with
    // routes[0] (EditQueue since the reorder), which made Android back
    // exit through the Edit queue. `initialRoute` makes Home the last
    // stop before the app closes, matching what initialRouteName already
    // promises about where the app starts.
    <Tab.Navigator
      initialRouteName="Home"
      backBehavior="initialRoute"
      screenOptions={screenOptions}
      tabBar={renderTabBar}
    >
      <Tab.Screen name="EditQueue" component={EditQueueScreen} options={{ title: 'Edit' }} />
      <Tab.Screen
        name="FavouritesQueue"
        component={FavouritesQueueScreen}
        options={{ title: 'Favourite' }}
      />
      <Tab.Screen name="Home" component={HomeScreen} options={{ title: 'Home' }} />
      <Tab.Screen
        name="OrganizeQueue"
        component={OrganizeQueueScreen}
        options={{ title: 'Organize' }}
      />
      <Tab.Screen name="ShareQueue" component={ShareQueueScreen} options={{ title: 'Share' }} />
    </Tab.Navigator>
  );
}

function Loading() {
  // Renders outside ThemeProvider (Suspense fallback while the DB opens),
  // so it uses the static fallback accent.
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: 'center' }}>
      <ActivityIndicator color={AMBER_ACCENT} size="large" />
    </View>
  );
}

function ThemedNavigator() {
  const { accent } = useTheme();
  const db = useSQLiteContext();
  const { writeError, clearWriteError } = useReview();
  // Share resolution is APP-GLOBAL (m0.8.6 D10): the chooser's
  // chosen-target event and the abandonment sweep must outlive the
  // Share screen — a choice can land after it unmounted, and
  // abandonment is only visible on foreground return.
  useEffect(() => installShareResolution(db), [db]);
  useEffect(() => {
    if (!writeError) return;
    Alert.alert(
      'Decision not saved',
      `Afterglow could not write the decision to its database. Nothing was changed — please retry the action.\n\n${writeError}`,
      [{ text: 'OK', onPress: clearWriteError }],
      { cancelable: false },
    );
  }, [writeError, clearWriteError]);
  const navTheme = useMemo(
    () => ({
      ...DarkTheme,
      colors: {
        ...DarkTheme.colors,
        background: colors.background,
        card: colors.surface,
        text: colors.text,
        border: colors.border,
        primary: accent,
      },
    }),
    [accent],
  );
  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar style="light" />
      <Stack.Navigator
        initialRouteName="Main"
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
        <Stack.Screen name="Timeline" component={TimelineScreen} options={{ title: 'Timeline' }} />
        {/* ONE deck route for both unit kinds (m0.8.5, L4). The title is
            per-unit, so the screen sets it itself as it advances. */}
        <Stack.Screen name="Deck" component={DeckScreen} options={{ title: 'Review' }} />
        <Stack.Screen name="Compare" component={CompareScreen} options={{ title: 'Compare' }} />
        <Stack.Screen name="CullList" component={CullListScreen} options={{ title: 'Cull list' }} />
        <Stack.Screen
          name="Summary"
          component={SummaryScreen}
          options={{ title: 'Summary', headerBackVisible: false }}
        />
        <Stack.Screen name="History" component={HistoryScreen} options={{ title: 'History' }} />
        <Stack.Screen name="Stats" component={StatsScreen} options={{ title: 'Stats' }} />
        <Stack.Screen
          name="DayProgress"
          component={DayProgressScreen}
          options={{ title: 'Day progress' }}
        />
        <Stack.Screen name="Progress" component={ProgressScreen} options={{ title: 'Progress' }} />
        <Stack.Screen
          name="SourcePicker"
          component={SourcePickerScreen}
          options={{ title: 'Photo source' }}
        />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <Suspense fallback={<Loading />}>
          <SQLiteProvider databaseName={DATABASE_NAME} onInit={migrateDatabase} useSuspense>
            <ThemeProvider>
              <ReviewProvider>
                <ThemedNavigator />
              </ReviewProvider>
            </ThemeProvider>
          </SQLiteProvider>
        </Suspense>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
