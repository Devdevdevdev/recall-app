import type { PropsWithChildren } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/src/components/ui/AppIcon';
import { Screen } from '@/src/components/ui/Screen';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

type AuthScreenFrameProps = PropsWithChildren<{
  description: string;
  title: string;
}>;

export function AuthScreenFrame({ children, description, title }: AuthScreenFrameProps) {
  return (
    <Screen contentContainerStyle={styles.content}>
      <View style={styles.brandRow}>
        <View style={styles.brandMark}>
          <AppIcon
            android="verified_user"
            color={colors.text.inverse}
            ios="checkmark.shield.fill"
          />
        </View>
        <Text style={styles.brandName}>Recall</Text>
      </View>
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        <Text style={styles.description}>{description}</Text>
      </View>
      {children}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, justifyContent: 'center', maxWidth: 560, width: '100%' },
  brandRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  brandMark: {
    alignItems: 'center',
    backgroundColor: colors.brand.primary,
    borderRadius: radius.md,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  brandName: {
    color: colors.brand.ink,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
  },
  heading: { gap: spacing.xs, marginTop: spacing.xxl },
  title: {
    color: colors.text.primary,
    fontSize: typography.size.title,
    fontWeight: typography.weight.bold,
    letterSpacing: -0.6,
    lineHeight: typography.lineHeight.title,
  },
  description: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
});
