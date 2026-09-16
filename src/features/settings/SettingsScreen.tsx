import { useCallback, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, type Href } from 'expo-router';

import { AppIcon } from '@/src/components/ui/AppIcon';
import { Screen } from '@/src/components/ui/Screen';
import { ScreenHeader } from '@/src/components/ui/ScreenHeader';
import { AuthButton } from '@/src/features/auth/components/AuthButton';
import { CountrySelector } from '@/src/features/products/CountrySelector';
import { useAuth } from '@/src/providers/AuthProvider';
import { userPreferencesRepository } from '@/src/data';
import { colors, radius, spacing, typography } from '@/src/design/tokens';
import type { CountryCode } from '@/src/domain';
import {
  disableRecallPushNotifications,
  enableRecallPushNotifications,
  getRecallPushNotificationStatus,
  type PushNotificationStatus,
} from '@/src/services/pushNotifications';

const settings = [
  {
    title: 'Data & privacy',
    description: 'Your inventory and preferences are protected by account-level access controls.',
    ios: 'lock.shield.fill',
    android: 'security',
  },
] as const;

export function SettingsScreen() {
  const { signOut, user } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [pushStatus, setPushStatus] = useState<PushNotificationStatus | null>(null);
  const [isUpdatingPush, setIsUpdatingPush] = useState(false);
  const [defaultCountry, setDefaultCountry] = useState<CountryCode | ''>('');
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [isSavingPreference, setIsSavingPreference] = useState(false);

  const refreshPushStatus = useCallback(async () => {
    try {
      setPushStatus(await getRecallPushNotificationStatus());
    } catch {
      setPushStatus({ status: 'error', message: 'Unable to check notification settings.' });
    }
  }, []);

  const refreshPreference = useCallback(async () => {
    try {
      const country = await userPreferencesRepository.getDefaultPurchaseCountryCode();
      setDefaultCountry(country ?? '');
      setPreferenceError(null);
    } catch {
      setPreferenceError('Unable to load your default country. Please try again.');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshPushStatus();
      void refreshPreference();
    }, [refreshPreference, refreshPushStatus]),
  );

  async function updateDefaultCountry(value: CountryCode | '') {
    if (isSavingPreference) return;
    const previous = defaultCountry;
    setDefaultCountry(value);
    setPreferenceError(null);
    setIsSavingPreference(true);
    try {
      await userPreferencesRepository.setDefaultPurchaseCountryCode(value || null);
    } catch {
      setDefaultCountry(previous);
      setPreferenceError('Unable to save your default country. Please try again.');
    } finally {
      setIsSavingPreference(false);
    }
  }

  async function updatePush(enabled: boolean) {
    if (isUpdatingPush) return;
    setIsUpdatingPush(true);
    const status = enabled
      ? await enableRecallPushNotifications()
      : await disableRecallPushNotifications();
    setPushStatus(status);
    setIsUpdatingPush(false);
  }

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
        <View style={styles.notificationRow}>
          <View style={styles.iconContainer}>
            <AppIcon
              android="notifications"
              color={colors.brand.primary}
              ios="bell.fill"
              size={22}
            />
          </View>
          <View style={styles.notificationCopy}>
            <Text style={styles.title}>Recall notifications</Text>
            <Text style={styles.description}>
              Receive an alert when one of your saved products is affected by an official recall.
            </Text>
            {pushStatus ? (
              <Text
                accessibilityLiveRegion="polite"
                style={pushStatus.status === 'error' ? styles.pushError : styles.pushStatus}>
                {pushStatus.message}
              </Text>
            ) : null}
            {pushStatus?.status === 'enabled' ? (
              <AuthButton
                label="Disable notifications"
                loading={isUpdatingPush}
                onPress={() => void updatePush(false)}
                tone="secondary"
              />
            ) : pushStatus?.status === 'unsupported' ? null : pushStatus?.status === 'denied' &&
              !pushStatus.canAskAgain ? (
              <AuthButton
                label="Open system settings"
                loading={isUpdatingPush}
                onPress={() => void Linking.openSettings()}
                tone="secondary"
              />
            ) : (
              <AuthButton
                label="Enable notifications"
                loading={isUpdatingPush}
                onPress={() => void updatePush(true)}
              />
            )}
          </View>
        </View>
        <View style={styles.preferenceRow}>
          <CountrySelector
            label="Default country of purchase"
            onChange={(value) => void updateDefaultCountry(value)}
            value={defaultCountry}
          />
          <Text style={styles.description}>
            New products start with this country. Existing products are never changed.
          </Text>
          {isSavingPreference ? (
            <Text accessibilityLiveRegion="polite" style={styles.pushStatus}>
              Saving preference…
            </Text>
          ) : null}
          {preferenceError ? (
            <View style={styles.preferenceErrorBlock}>
              <Text
                accessibilityLiveRegion="polite"
                accessibilityRole="alert"
                style={styles.pushError}>
                {preferenceError}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void refreshPreference()}
                style={styles.retryButton}>
                <Text style={styles.retryLabel}>Retry</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        <Pressable
          accessibilityHint="Shows current official recall source coverage"
          accessibilityRole="button"
          onPress={() => router.push('/coverage' as Href)}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
          <View style={styles.iconContainer}>
            <AppIcon android="public" color={colors.brand.primary} ios="globe" size={22} />
          </View>
          <View style={styles.copy}>
            <Text style={styles.title}>Coverage</Text>
            <Text style={styles.description}>
              See which official sources Recall monitors today.
            </Text>
          </View>
          <Text accessibilityElementsHidden style={styles.chevron}>
            ›
          </Text>
        </Pressable>
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
      <Text style={styles.version}>Recall · Global-ready product model</Text>
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
  notificationRow: {
    alignItems: 'flex-start',
    borderBottomColor: colors.border.subtle,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  preferenceRow: {
    borderBottomColor: colors.border.subtle,
    borderBottomWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  preferenceErrorBlock: { alignItems: 'flex-start', gap: spacing.xs },
  retryButton: { minHeight: 44, justifyContent: 'center' },
  retryLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.bold,
  },
  rowPressed: { backgroundColor: colors.brand.soft },
  chevron: { color: colors.text.muted, fontSize: 28, lineHeight: 28 },
  notificationCopy: {
    flex: 1,
    gap: spacing.sm,
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
  pushStatus: {
    color: colors.text.secondary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.lineHeight.label,
  },
  pushError: {
    color: colors.semantic.danger,
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
