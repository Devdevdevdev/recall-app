import { useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
} from 'react-native';

import type { OwnedProductInput } from '@/src/domain';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

import { PurchaseDateField } from './PurchaseDateField';
import {
  emptyProductFormValues,
  validateProductForm,
  type ProductFormErrors,
  type ProductFormValues,
} from './productFormUtils';

type ProductFormProps = {
  initialValues?: ProductFormValues;
  isSubmitting: boolean;
  onSubmit: (input: OwnedProductInput) => Promise<void>;
  submitLabel: string;
};

type FieldProps = {
  autoCapitalize?: 'characters' | 'none' | 'sentences' | 'words';
  error?: string;
  keyboardType?: KeyboardTypeOptions;
  label: string;
  maxLength: number;
  onChangeText: (value: string) => void;
  placeholder?: string;
  value: string;
};

function FormField({
  autoCapitalize = 'sentences',
  error,
  keyboardType = 'default',
  label,
  maxLength,
  onChangeText,
  placeholder,
  value,
}: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
        maxLength={maxLength}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.text.muted}
        style={[styles.input, error && styles.inputError]}
        value={value}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function ProductForm({
  initialValues,
  isSubmitting,
  onSubmit,
  submitLabel,
}: ProductFormProps) {
  const [values, setValues] = useState<ProductFormValues>(initialValues ?? emptyProductFormValues);
  const [errors, setErrors] = useState<ProductFormErrors>({});
  const submissionInFlight = useRef(false);

  function updateValue(field: keyof ProductFormValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  async function handleSubmit() {
    if (isSubmitting || submissionInFlight.current) {
      return;
    }

    const result = validateProductForm(values);
    setErrors(result.errors);

    if (!result.input) {
      return;
    }

    submissionInFlight.current = true;
    try {
      await onSubmit(result.input);
    } finally {
      submissionInFlight.current = false;
    }
  }

  return (
    <View style={styles.form}>
      <FormField
        error={errors.productName}
        label="Product name *"
        maxLength={200}
        onChangeText={(value) => updateValue('productName', value)}
        placeholder="e.g. Airfryer Essential"
        value={values.productName}
      />
      <FormField
        autoCapitalize="words"
        error={errors.brand}
        label="Brand"
        maxLength={120}
        onChangeText={(value) => updateValue('brand', value)}
        placeholder="e.g. Philips"
        value={values.brand}
      />
      <FormField
        error={errors.category}
        label="Category"
        maxLength={120}
        onChangeText={(value) => updateValue('category', value)}
        placeholder="e.g. Kitchen appliance"
        value={values.category}
      />
      <FormField
        autoCapitalize="none"
        error={errors.gtin}
        keyboardType="number-pad"
        label="GTIN / barcode"
        maxLength={14}
        onChangeText={(value) => updateValue('gtin', value)}
        placeholder="8, 12, 13, or 14 digits"
        value={values.gtin}
      />
      <FormField
        autoCapitalize="characters"
        error={errors.modelNumber}
        label="Model number"
        maxLength={120}
        onChangeText={(value) => updateValue('modelNumber', value)}
        value={values.modelNumber}
      />
      <FormField
        autoCapitalize="characters"
        error={errors.serialNumber}
        label="Serial number"
        maxLength={120}
        onChangeText={(value) => updateValue('serialNumber', value)}
        value={values.serialNumber}
      />
      <FormField
        autoCapitalize="characters"
        error={errors.lotNumber}
        label="Lot / batch number"
        maxLength={120}
        onChangeText={(value) => updateValue('lotNumber', value)}
        value={values.lotNumber}
      />
      <PurchaseDateField
        error={errors.purchaseDate}
        onChange={(value) => updateValue('purchaseDate', value)}
        value={values.purchaseDate}
      />
      <Pressable
        accessibilityRole="button"
        disabled={isSubmitting}
        onPress={() => void handleSubmit()}
        style={({ pressed }) => [
          styles.submit,
          (pressed || isSubmitting) && styles.submitPressed,
          isSubmitting && styles.submitDisabled,
        ]}>
        <Text style={styles.submitLabel}>{isSubmitting ? 'Saving…' : submitLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
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
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    minHeight: 52,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  inputError: { borderColor: colors.semantic.danger },
  error: {
    color: colors.semantic.danger,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
  submit: {
    alignItems: 'center',
    backgroundColor: colors.brand.primary,
    borderRadius: radius.md,
    justifyContent: 'center',
    marginTop: spacing.sm,
    minHeight: 54,
    paddingHorizontal: spacing.lg,
  },
  submitPressed: { backgroundColor: colors.brand.primaryPressed },
  submitDisabled: { opacity: 0.7 },
  submitLabel: {
    color: colors.text.inverse,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.body,
  },
});
