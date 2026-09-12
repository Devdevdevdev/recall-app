import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/src/components/ui/AppIcon';
import { Screen } from '@/src/components/ui/Screen';
import { ScreenHeader } from '@/src/components/ui/ScreenHeader';
import { AuthButton } from '@/src/features/auth/components/AuthButton';
import { useAuth } from '@/src/providers/AuthProvider';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

const settings = [
  {
    title: 'Notifications',
    description: 'Alert preferences will be available after notifications are connected.',
    ios: 'bell.fill',
    android: 'notifications',
  },
  {
    title: 'Data & privacy',
    description: 'Inventory and account controls will arrive with secure authentication.',
    ios: 'lock.shield.fill',
    android: 'security',
  },
] as const;

export function SettingsScreen() {
  const { signOut, user } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  async function handleSignOut() {
    if (isSigningOut) {
      return;
    }

    setSignOutError(null);
    setIsSigningOut(true);
    try {
      const result = await signOut();
      if (result.status === 'error') {
        setSignOutError(result.message);
      }
    } catch {
      setSignOutError('Unable to sign out. Please try again.');
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader
        title="Settings"
        description="Manage Recall preferences, notifications, and privacy controls."
      />
      <View style={styles.list}>
        <View style={styles.accountRow}>
          <View style={styles.iconContainer}>
            <AppIcon android="person" color={colors.brand.primary} ios="person.fill" size={22} />
          </View>
          <View style={styles.copy}>
            <Text style={styles.title}>Signed in</Text>
            <Text style={styles.description}>{user?.email ?? 'Email unavailable'}</Text>
          </View>
        </View>
        {settings.map((setting) => (
          <View key={setting.title} style={styles.row}>
            <View style={styles.iconContainer}>
              <AppIcon
                android={setting.android}
                color={colors.brand.primary}
                ios={setting.ios}
                size={22}
              />
            </View>
            <View style={styles.copy}>
              <Text style={styles.title}>{setting.title}</Text>
              <Text style={styles.description}>{setting.description}</Text>
            </View>
          </View>
        ))}
      </View>
      <View style={styles.signOutSection}>
        {signOutError ? (
          <Text accessibilityLiveRegion="polite" style={styles.signOutError}>
            {signOutError}
          </Text>
        ) : null}
        <AuthButton
          label="Sign out"
          loading={isSigningOut}
          onPress={() => void handleSignOut()}
          tone="secondary"
        />
      </View>
      <Text style={styles.version}>Recall · Phase 3 authentication</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  row: {
    alignItems: 'center',
    borderBottomColor: colors.border.subtle,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  accountRow: {
    alignItems: 'center',
    borderBottomColor: colors.border.subtle,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  iconContainer: {
    alignItems: 'center',
    backgroundColor: colors.brand.soft,
    borderRadius: radius.md,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  copy: {
    flex: 1,
    gap: spacing.xxs,
  },
  title: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.lineHeight.body,
  },
  description: {
    color: colors.text.secondary,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
  },
  version: {
    color: colors.text.muted,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
    textAlign: 'center',
  },
  signOutSection: {
    gap: spacing.sm,
  },
  signOutError: {
    color: colors.semantic.danger,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
  },
});
