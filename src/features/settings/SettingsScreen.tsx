import { StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/src/components/ui/AppIcon';
import { Screen } from '@/src/components/ui/Screen';
import { ScreenHeader } from '@/src/components/ui/ScreenHeader';
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
  return (
    <Screen>
      <ScreenHeader
        title="Settings"
        description="Manage Recall preferences, notifications, and privacy controls."
      />
      <View style={styles.list}>
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
      <Text style={styles.version}>Recall · Phase 1 foundation</Text>
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
});
