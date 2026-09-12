import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing, typography } from '@/src/design/tokens';

type ScreenHeaderProps = {
  title: string;
  description: string;
};

export function ScreenHeader({ description, title }: ScreenHeaderProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.eyebrow}>RECALL</Text>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      <Text style={styles.description}>{description}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
  },
  eyebrow: {
    color: colors.brand.primary,
    fontSize: typography.size.caption,
    fontWeight: typography.weight.bold,
    letterSpacing: 1.6,
    lineHeight: typography.lineHeight.caption,
  },
  title: {
    color: colors.text.primary,
    fontSize: typography.size.title,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.title,
  },
  description: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    maxWidth: 560,
  },
});
