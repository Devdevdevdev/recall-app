import { StyleSheet, Text, View } from 'react-native';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';

import { AppIcon } from './AppIcon';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

type EmptyStateProps = {
  title: string;
  description: string;
  icon: {
    ios: SFSymbol;
    android: AndroidSymbol;
  };
};

export function EmptyState({ description, icon, title }: EmptyStateProps) {
  return (
    <View style={styles.container}>
      <View style={styles.iconContainer}>
        <AppIcon android={icon.android} color={colors.brand.primary} ios={icon.ios} size={30} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
  },
  iconContainer: {
    alignItems: 'center',
    backgroundColor: colors.brand.soft,
    borderRadius: radius.pill,
    height: 64,
    justifyContent: 'center',
    width: 64,
  },
  copy: {
    alignItems: 'center',
    gap: spacing.xs,
  },
  title: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
    textAlign: 'center',
  },
  description: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    maxWidth: 420,
    textAlign: 'center',
  },
});
