import React, { Suspense, useEffect, useMemo } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SQLiteProvider } from 'expo-sqlite';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { RootStackParamList } from './src/navigation';
import { DATABASE_NAME, migrateDatabase } from './src/db/database';
import { SessionProvider, useSession } from './src/session/SessionContext';
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
  const { persistenceError, retryPersistence } = useSession();
  useEffect(() => {
    if (!persistenceError) return;
    Alert.alert(
      'Decision not saved',
      `Afterglow could not write the decision to its database. Review is paused until the queued write succeeds.\n\n${persistenceError.message}`,
      [{ text: 'Retry', onPress: retryPersistence }],
      { cancelable: false },
    );
  }, [persistenceError, retryPersistence]);
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
        initialRouteName="Home"
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Groups" component={GroupsScreen} options={{ title: 'Session' }} />
        <Stack.Screen name="Deck" component={DeckScreen} options={{ title: 'Group review' }} />
        <Stack.Screen name="Compare" component={CompareScreen} options={{ title: 'Compare' }} />
        <Stack.Screen name="Singles" component={SinglesDeckScreen} options={{ title: 'Singles' }} />
        <Stack.Screen name="CullList" component={CullListScreen} options={{ title: 'Cull list' }} />
        <Stack.Screen
          name="Summary"
          component={SummaryScreen}
          options={{ title: 'Summary', headerBackVisible: false }}
        />
        <Stack.Screen
          name="EditQueue"
          component={EditQueueScreen}
          options={{ title: 'Edit queue' }}
        />
        <Stack.Screen
          name="FavouritesQueue"
          component={FavouritesQueueScreen}
          options={{ title: 'Favourite queue' }}
        />
        <Stack.Screen
          name="ShareQueue"
          component={ShareQueueScreen}
          options={{ title: 'Share queue' }}
        />
        <Stack.Screen
          name="OrganizeQueue"
          component={OrganizeQueueScreen}
          options={{ title: 'Organize queue' }}
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
              <SessionProvider>
                <ThemedNavigator />
              </SessionProvider>
            </ThemeProvider>
          </SQLiteProvider>
        </Suspense>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
