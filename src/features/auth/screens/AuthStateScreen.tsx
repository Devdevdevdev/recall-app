import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { SupabaseConfiguration } from '@/src/services/supabase';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

export function AuthLoadingScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View
        accessibilityLabel="Loading Recall"
        accessibilityRole="progressbar"
        style={styles.loadingContent}>
        <ActivityIndicator color={colors.brand.primary} size="large" />
        <Text style={styles.loadingLabel}>Loading Recall…</Text>
      </View>
    </SafeAreaView>
  );
}

type AuthConfigurationScreenProps = {
  configuration: Exclude<SupabaseConfiguration, { status: 'configured' }>;
};

export function AuthConfigurationScreen({ configuration }: AuthConfigurationScreenProps) {
  const detail =
    configuration.status === 'unconfigured'
      ? `Add ${configuration.missingVariables.join(' and ')} to your ignored .env.local file, then restart Expo.`
      : configuration.message;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.configurationContent}>
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.configurationTitle}>
            Supabase configuration needed
          </Text>
          <Text style={styles.configurationCopy}>
            Recall needs public Supabase settings before authentication can start. {detail}
          </Text>
          <Text style={styles.configurationNote}>
            Never add a Supabase secret key or other privileged credential to the mobile app.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.surface.background, flex: 1 },
  loadingContent: {
    alignItems: 'center',
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  loadingLabel: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  configurationContent: { flex: 1, justifyContent: 'center', padding: spacing.lg },
  card: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.md,
    maxWidth: 560,
    padding: spacing.lg,
    width: '100%',
  },
  configurationTitle: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
  },
  configurationCopy: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  configurationNote: {
    color: colors.text.muted,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
});
