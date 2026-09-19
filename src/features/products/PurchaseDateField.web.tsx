import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, typography } from '@/src/design/tokens';

import { todayDateOnly } from './purchaseDate';

type PurchaseDateFieldProps = {
  error?: string;
  onChange: (value: string) => void;
  value: string;
};

type CalendarDateFieldProps = PurchaseDateFieldProps & {
  allowClear: boolean;
  id: string;
  label: string;
};

function CalendarDateField({
  allowClear,
  error,
  id,
  label,
  onChange,
  value,
}: CalendarDateFieldProps) {
  const errorId = `${id}-error`;
  const labelId = `${id}-label`;
  return (
    <View style={styles.field}>
      <Text nativeID={labelId} style={styles.label}>
        {label}
      </Text>
      <input
        aria-describedby={error ? errorId : undefined}
        aria-labelledby={labelId}
        max={todayDateOnly()}
        onChange={(event) => onChange(event.currentTarget.value)}
        style={{ ...styles.input, ...(error ? styles.inputError : {}) }}
        type="date"
        value={value}
      />
      {allowClear && value ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onChange('')}
          style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}>
          <Text style={styles.clearLabel}>Clear purchase date</Text>
        </Pressable>
      ) : null}
      {error ? (
        <Text accessibilityLiveRegion="polite" nativeID={errorId} style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** Browser-native date inputs stay separate so the native picker is never bundled for web. */
export function PurchaseDateField(props: PurchaseDateFieldProps) {
  return <CalendarDateField {...props} allowClear id="purchase-date" label="Purchase date" />;
}

export function ScanDateField(props: PurchaseDateFieldProps) {
  return <CalendarDateField {...props} allowClear={false} id="scan-date" label="Scan date" />;
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
