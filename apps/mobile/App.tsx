import React, { Suspense, useMemo } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SQLiteProvider } from 'expo-sqlite';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { RootStackParamList } from './src/navigation';
import { DATABASE_NAME, migrateDatabase } from './src/db/database';
import { SessionProvider } from './src/session/SessionContext';
import { HomeScreen } from './src/screens/HomeScreen';
import { GroupsScreen } from './src/screens/GroupsScreen';
import { DeckScreen } from './src/screens/DeckScreen';
import { CompareScreen } from './src/screens/CompareScreen';
import { SinglesScreen } from './src/screens/SinglesScreen';
import { ReconsiderScreen } from './src/screens/ReconsiderScreen';
import { CullListScreen } from './src/screens/CullListScreen';
import { SummaryScreen } from './src/screens/SummaryScreen';
import { EditQueueScreen } from './src/screens/EditQueueScreen';
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
                  <Stack.Screen
                    name="Compare"
                    component={CompareScreen}
                    options={{ title: 'Compare' }}
                  />
                  <Stack.Screen
                    name="Reconsider"
                    component={ReconsiderScreen}
                    options={{ title: 'Reconsider' }}
                  />
                  <Stack.Screen name="Singles" component={SinglesScreen} options={{ title: 'Singles' }} />
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
                    name="DayProgress"
                    component={DayProgressScreen}
                    options={{ title: 'Day progress' }}
                  />
                  <Stack.Screen
                    name="Progress"
                    component={ProgressScreen}
                    options={{ title: 'Progress' }}
                  />
                  <Stack.Screen
                    name="SourcePicker"
                    component={SourcePickerScreen}
                    options={{ title: 'Photo source' }}
                  />
                  <Stack.Screen
                    name="Settings"
                    component={SettingsScreen}
                    options={{ title: 'Settings' }}
                  />
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
