import React, { Suspense, useEffect, useMemo } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SQLiteProvider } from 'expo-sqlite';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import type { MainTabParamList, RootStackParamList } from './src/navigation';
import { countFavouriteQueue, countToEdit } from './src/db/store';
import { countShareQueue } from './src/db/shareStore';
import { countOrganizeQueue } from './src/db/organizeStore';
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
import { DayProgressScreen } from './src/screens/DayProgressScreen';
import { ProgressScreen } from './src/screens/ProgressScreen';
import { SourcePickerScreen } from './src/screens/SourcePickerScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { colors, ThemeProvider, useTheme } from './src/theme';
import { AMBER_ACCENT } from './src/lib/accentTheme';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

const TAB_ICONS = {
  Home: 'home-variant',
  EditQueue: 'pencil',
  FavouritesQueue: 'heart',
  ShareQueue: 'share-variant',
  OrganizeQueue: 'folder-move',
} as const;

/**
 * The five count-badged bottom tabs (m0.8 gate 4). Badges re-count on
 * every review mutation (version) and on an interval so external changes
 * (queue applies, detection) surface without a decision in between.
 */
function MainTabs() {
  const db = useSQLiteContext();
  const { version } = useReview();
  const { accent } = useTheme();
  const [badges, setBadges] = React.useState<Partial<Record<keyof MainTabParamList, number>>>({});
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [edit, favourite, share, organize] = await Promise.all([
        countToEdit(db),
        countFavouriteQueue(db),
        countShareQueue(db),
        countOrganizeQueue(db),
      ]);
      if (cancelled) return;
      setBadges({
        EditQueue: edit,
        FavouritesQueue: favourite,
        ShareQueue: share,
        OrganizeQueue: organize,
      });
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [db, version]);
  const screenOptions = ({ route }: { route: { name: keyof MainTabParamList } }) => ({
    headerShown: false,
    tabBarActiveTintColor: accent,
    tabBarInactiveTintColor: colors.textDim,
    tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
    tabBarBadge: badges[route.name] ? badges[route.name] : undefined,
    tabBarBadgeStyle: { backgroundColor: accent, color: colors.background, fontSize: 11 },
    tabBarIcon: ({ color, size }: { color: string; size: number }) => (
      <MaterialCommunityIcons name={TAB_ICONS[route.name]} size={size} color={color} />
    ),
  });
  return (
    <Tab.Navigator screenOptions={screenOptions}>
      <Tab.Screen name="Home" component={HomeScreen} options={{ title: 'Home' }} />
      <Tab.Screen name="EditQueue" component={EditQueueScreen} options={{ title: 'Edit' }} />
      <Tab.Screen
        name="FavouritesQueue"
        component={FavouritesQueueScreen}
        options={{ title: 'Favourite' }}
      />
      <Tab.Screen name="ShareQueue" component={ShareQueueScreen} options={{ title: 'Share' }} />
      <Tab.Screen
        name="OrganizeQueue"
        component={OrganizeQueueScreen}
        options={{ title: 'Organize' }}
      />
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
        <Stack.Screen name="Singles" component={SinglesDeckScreen} options={{ title: 'Singles' }} />
        <Stack.Screen name="CullList" component={CullListScreen} options={{ title: 'Cull list' }} />
        <Stack.Screen
          name="Summary"
          component={SummaryScreen}
          options={{ title: 'Summary', headerBackVisible: false }}
        />
        <Stack.Screen name="History" component={HistoryScreen} options={{ title: 'History' }} />
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
