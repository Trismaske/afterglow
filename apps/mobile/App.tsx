import React, { Suspense } from 'react';
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
import { DuelScreen } from './src/screens/DuelScreen';
import { SinglesScreen } from './src/screens/SinglesScreen';
import { ReconsiderScreen } from './src/screens/ReconsiderScreen';
import { CullListScreen } from './src/screens/CullListScreen';
import { SummaryScreen } from './src/screens/SummaryScreen';
import { EditQueueScreen } from './src/screens/EditQueueScreen';
import { DayProgressScreen } from './src/screens/DayProgressScreen';
import { colors } from './src/theme';

const Stack = createNativeStackNavigator<RootStackParamList>();

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
  },
};

function Loading() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: 'center' }}>
      <ActivityIndicator color={colors.accent} size="large" />
    </View>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <Suspense fallback={<Loading />}>
          <SQLiteProvider databaseName={DATABASE_NAME} onInit={migrateDatabase} useSuspense>
            <SessionProvider>
              <NavigationContainer theme={theme}>
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
                  <Stack.Screen name="Duel" component={DuelScreen} options={{ title: 'Duel' }} />
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
                </Stack.Navigator>
              </NavigationContainer>
            </SessionProvider>
          </SQLiteProvider>
        </Suspense>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
