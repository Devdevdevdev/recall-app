import { useState } from 'react';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, typography } from '@/src/design/tokens';

import {
  dateOnlyToLocalDate,
  dateToDateOnly,
  formatPurchaseDate,
  todayDateOnly,
} from './purchaseDate';

type PurchaseDateFieldProps = {
  error?: string;
  onChange: (value: string) => void;
  value: string;
};

export function PurchaseDateField({ error, onChange, value }: PurchaseDateFieldProps) {
  const [pickerVisible, setPickerVisible] = useState(false);
  const selectedDate = dateOnlyToLocalDate(value);
  const pickerDate = selectedDate ?? new Date();

  function handleChange(_: unknown, nextDate?: Date) {
    if (Platform.OS === 'android') {
      setPickerVisible(false);
    }

    if (nextDate) {
      onChange(dateToDateOnly(nextDate));
    }
  }

  return (
    <View style={styles.field}>
      <Text style={styles.label}>Purchase date</Text>
      <Pressable
        accessibilityHint="Opens the native purchase date selector"
        accessibilityLabel="Purchase date"
        accessibilityRole="button"
        onPress={() => setPickerVisible(true)}
        style={({ pressed }) => [
          styles.dateButton,
          error && styles.inputError,
          pressed && styles.pressed,
        ]}>
        <Text style={[styles.dateValue, !selectedDate && styles.placeholder]}>
          {selectedDate ? formatPurchaseDate(value) : 'Select purchase date'}
        </Text>
      </Pressable>
      {pickerVisible ? (
        <View style={styles.pickerContainer}>
          <DateTimePicker
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            maximumDate={dateOnlyToLocalDate(todayDateOnly()) ?? new Date()}
            mode="date"
            onChange={handleChange}
            value={pickerDate}
          />
          {Platform.OS === 'ios' ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setPickerVisible(false)}
              style={({ pressed }) => [styles.doneButton, pressed && styles.pressed]}>
              <Text style={styles.doneLabel}>Done</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {selectedDate ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onChange('')}
          style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}>
          <Text style={styles.clearLabel}>Clear purchase date</Text>
        </Pressable>
      ) : null}
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
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
  dateButton: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.strong,
    borderRadius: radius.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  dateValue: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  placeholder: { color: colors.text.muted },
  inputError: { borderColor: colors.semantic.danger },
  pickerContainer: {
    backgroundColor: colors.surface.sunken,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  doneButton: { alignSelf: 'flex-end', paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  doneLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.bold,
  },
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
