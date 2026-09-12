import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppIcon } from './AppIcon';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

type PrimaryButtonProps = {
  label: string;
  onPress: () => void;
};

export function PrimaryButton({ label, onPress }: PrimaryButtonProps) {
  return (
    <Pressable
      accessibilityHint="Opens the product scanning screen"
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
      <View style={styles.iconContainer}>
        <AppIcon
          android="qr_code_scanner"
          color={colors.brand.primary}
          ios="viewfinder"
          size={24}
        />
      </View>
      <Text style={styles.label}>{label}</Text>
      <AppIcon android="arrow_forward" color={colors.text.inverse} ios="arrow.right" size={20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: colors.brand.primary,
    borderRadius: radius.lg,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 64,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  buttonPressed: {
    backgroundColor: colors.brand.primaryPressed,
    transform: [{ scale: 0.99 }],
  },
  iconContainer: {
    alignItems: 'center',
    backgroundColor: colors.surface.raised,
    borderRadius: radius.md,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  label: {
    color: colors.text.inverse,
    flex: 1,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.body,
  },
});
