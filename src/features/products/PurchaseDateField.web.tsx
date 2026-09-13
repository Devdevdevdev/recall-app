import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, typography } from '@/src/design/tokens';

import { todayDateOnly } from './purchaseDate';

type PurchaseDateFieldProps = {
  error?: string;
  onChange: (value: string) => void;
  value: string;
};

/** Browser-native date input kept separate so the mobile native module is never bundled for web. */
export function PurchaseDateField({ error, onChange, value }: PurchaseDateFieldProps) {
  return (
    <View style={styles.field}>
      <Text nativeID="purchase-date-label" style={styles.label}>
        Purchase date
      </Text>
      <input
        aria-describedby={error ? 'purchase-date-error' : undefined}
        aria-labelledby="purchase-date-label"
        max={todayDateOnly()}
        onChange={(event) => onChange(event.currentTarget.value)}
        style={{ ...styles.input, ...(error ? styles.inputError : {}) }}
        type="date"
        value={value}
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onChange('')}
          style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}>
          <Text style={styles.clearLabel}>Clear purchase date</Text>
        </Pressable>
      ) : null}
      {error ? (
        <Text accessibilityLiveRegion="polite" nativeID="purchase-date-error" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  label: {
    color: colors.text.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.lineHeight.label,
  },
  input: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.strong,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.text.primary,
    fontFamily: 'inherit',
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    minHeight: 52,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  inputError: { borderColor: colors.semantic.danger },
  clearButton: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  clearLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
  },
  error: {
    color: colors.semantic.danger,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
  pressed: { opacity: 0.75 },
});
