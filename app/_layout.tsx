import { Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { navigationTheme } from '@/src/design/navigation-theme';
import {
  AuthLoadingScreen,
  AuthConfigurationScreen,
} from '@/src/features/auth/screens/AuthStateScreen';
import { AuthProvider, useAuth } from '@/src/providers/AuthProvider';
import { PushNotificationCoordinator } from '@/src/providers/PushNotificationCoordinator';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(auth)',
};

export default function RootLayout() {
  return (
    <ThemeProvider value={navigationTheme}>
      <StatusBar style="dark" />
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </ThemeProvider>
  );
}

function RootNavigator() {
  const { configuration, isAuthenticated, isLoading, user } = useAuth();

  if (configuration.status !== 'configured') {
    return <AuthConfigurationScreen configuration={configuration} />;
  }

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  return (
    <>
      <PushNotificationCoordinator
        isAuthenticated={isAuthenticated}
        isLoading={isLoading}
        userId={user?.id ?? null}
      />
      <Stack
        screenOptions={{ contentStyle: { backgroundColor: navigationTheme.colors.background } }}>
        <Stack.Protected guard={isAuthenticated}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="products/new" options={{ headerShown: false }} />
          <Stack.Screen name="products/[id]" options={{ headerShown: false }} />
          <Stack.Screen name="products/[id]/edit" options={{ headerShown: false }} />
          <Stack.Screen name="alerts/[id]" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={!isAuthenticated}>
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}
