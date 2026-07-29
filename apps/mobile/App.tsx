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
import { DATABASE_NAME, migrateDatabase } from './src/db/database';
import { ReviewProvider, useReview } from './src/review/ReviewContext';
import { HomeScreen } from './src/screens/HomeScreen';
import { GroupsScreen } from './src/screens/GroupsScreen';
import { DeckScreen, SinglesDeckScreen } from './src/screens/DeckScreen';
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
    const load = async () => {
      // v18: one grouped query for all four badges, where there used to
      // be four separate count functions over four different shapes.
      const queues = await countQueues(db);
      if (cancelled) return;
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
      if (next === 'active') void load();
    });
    return () => {
      cancelled = true;
      subscription.remove();
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
  const { writeError, clearWriteError } = useReview();
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
        <Stack.Screen name="Groups" component={GroupsScreen} options={{ title: 'Review' }} />
        <Stack.Screen name="Deck" component={DeckScreen} options={{ title: 'Group review' }} />
        <Stack.Screen name="Compare" component={CompareScreen} options={{ title: 'Compare' }} />
        <Stack.Screen
          name="Singles"
          component={SinglesDeckScreen}
          options={{ title: 'Singles review' }}
        />
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
