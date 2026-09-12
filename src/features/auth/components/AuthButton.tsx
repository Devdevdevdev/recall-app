import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { colors, radius, spacing, typography } from '@/src/design/tokens';

type AuthButtonProps = {
  disabled?: boolean;
  label: string;
  loading?: boolean;
  onPress: () => void;
  tone?: 'primary' | 'secondary';
};

export function AuthButton({
  disabled = false,
  label,
  loading = false,
  onPress,
  tone = 'primary',
}: AuthButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        tone === 'secondary' && styles.secondaryButton,
        isDisabled && styles.disabledButton,
        pressed && !isDisabled && styles.pressedButton,
      ]}>
      {loading ? (
        <ActivityIndicator
          color={tone === 'primary' ? colors.text.inverse : colors.brand.primary}
        />
      ) : (
        <Text style={[styles.label, tone === 'secondary' && styles.secondaryLabel]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: colors.brand.primary,
    borderRadius: radius.md,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
  secondaryButton: { backgroundColor: colors.brand.soft },
  disabledButton: { opacity: 0.5 },
  pressedButton: { backgroundColor: colors.brand.primaryPressed },
  label: {
    color: colors.text.inverse,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.body,
  },
  secondaryLabel: { color: colors.brand.primary },
});
