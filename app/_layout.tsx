import { Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { navigationTheme } from '@/src/design/navigation-theme';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

export default function RootLayout() {
  return (
    <ThemeProvider value={navigationTheme}>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{ contentStyle: { backgroundColor: navigationTheme.colors.background } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </ThemeProvider>
  );
}
