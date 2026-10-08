import { useRef, useState } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
} from 'react-native';

import type { OwnedProductInput, ScannedBarcode } from '@/src/domain';
import type { CountryCode } from '@/src/domain/countries';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

import { CountrySelector } from './CountrySelector';
import { PurchaseDateField, ScanDateField } from './PurchaseDateField';
import {
  applyLookupSuggestion,
  productLookupNotice,
  type ProductLookupNotice,
  type ProductLookupState,
} from './productLookupPrefill';
import {
  emptyProductFormValues,
  mergeOptionalDefaultCountry,
  scannedGtinNote,
  validateProductForm,
  type ProductFormErrors,
  type ProductFormValues,
} from './productFormUtils';

type ProductFormProps = {
  initialValues?: ProductFormValues;
  isSubmitting: boolean;
  onSubmit: (input: OwnedProductInput) => Promise<void>;
  /** Name/brand suggestion for a scanned GTIN (Phase 17.3c); never overrides user input. */
  productLookup?: ProductLookupState;
  /** The scan this product came from, used only to explain a transformed GTIN. */
  scannedBarcode?: ScannedBarcode | null;
  submitLabel: string;
};

type FieldProps = {
  autoCapitalize?: 'characters' | 'none' | 'sentences' | 'words';
  error?: string;
  hint?: string | null;
  keyboardType?: KeyboardTypeOptions;
  label: string;
  maxLength: number;
  onChangeText: (value: string) => void;
  placeholder?: string;
  value: string;
};

function FormSection({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          {title}
        </Text>
        <Text style={styles.sectionDescription}>{description}</Text>
      </View>
      <View style={styles.sectionFields}>{children}</View>
    </View>
  );
}

function FormField({
  autoCapitalize = 'sentences',
  error,
  hint,
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
      {hint && !error ? <Text style={styles.hint}>{hint}</Text> : null}
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function LookupNotice({ notice }: { notice: ProductLookupNotice }) {
  if (notice.kind === 'info') {
    return (
      <Text accessibilityLiveRegion="polite" style={styles.hint}>
        {notice.text}
      </Text>
    );
  }
  const { attribution } = notice;
  return (
    <Text accessibilityLiveRegion="polite" style={styles.hint}>
      Suggested from{' '}
      <Text
        accessibilityRole="link"
        onPress={() => void Linking.openURL(attribution.sourceUrl).catch(() => undefined)}
        style={styles.link}>
        {attribution.sourceName}
      </Text>{' '}
      (ODbL). Community data: check it matches your product.
    </Text>
  );
}

const idleLookup: ProductLookupState = { status: 'idle' };

export function ProductForm({
  initialValues,
  isSubmitting,
  onSubmit,
  productLookup = idleLookup,
  scannedBarcode = null,
  submitLabel,
}: ProductFormProps) {
  const [values, setValues] = useState<ProductFormValues>(
    initialValues ?? emptyProductFormValues(),
  );
  const [errors, setErrors] = useState<ProductFormErrors>({});
  const [showSafetyDetails, setShowSafetyDetails] = useState(
    Boolean(
      initialValues &&
      [
        initialValues.variant,
        initialValues.color,
        initialValues.size,
        initialValues.capacity,
        initialValues.batteryModel,
        initialValues.chargingPortType,
        initialValues.screwState,
        initialValues.dateCode,
        initialValues.manufactureDate,
        initialValues.productionDate,
      ].some(Boolean),
    ),
  );
  const [appliedDefaultCountry, setAppliedDefaultCountry] = useState(
    initialValues?.purchaseCountryCode ?? '',
  );
  const countryWasEdited = useRef(false);
  const submissionInFlight = useRef(false);
  const editedFields = useRef(new Set<keyof ProductFormValues>());
  const [appliedLookup, setAppliedLookup] = useState<ProductLookupState>(idleLookup);

  const incomingDefaultCountry = initialValues?.purchaseCountryCode ?? '';
  if (incomingDefaultCountry !== appliedDefaultCountry) {
    setAppliedDefaultCountry(incomingDefaultCountry);
    setValues((current) =>
      mergeOptionalDefaultCountry(current, incomingDefaultCountry, countryWasEdited.current),
    );
  }

  if (productLookup !== appliedLookup) {
    setAppliedLookup(productLookup);
    // Updater form: decided against the latest values, so a keystroke still queued wins.
    setValues(
      (current) => applyLookupSuggestion(current, editedFields.current, productLookup).values,
    );
  }
  const lookupNotice = productLookupNotice(productLookup, values);

  function updateValue(field: keyof ProductFormValues, value: string) {
    editedFields.current.add(field);
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
      <FormSection description="The familiar details you use to recognize it." title="Product">
        {lookupNotice ? <LookupNotice notice={lookupNotice} /> : null}
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
        <ScanDateField
          error={errors.scanDate}
          onChange={(value) => updateValue('scanDate', value)}
          value={values.scanDate}
        />
        <FormField
          autoCapitalize="none"
          error={errors.gtin}
          hint={scannedGtinNote(scannedBarcode, values.gtin)}
          keyboardType="number-pad"
          label="GTIN / barcode"
          maxLength={14}
          onChangeText={(value) => updateValue('gtin', value)}
          placeholder="8, 12, 13, or 14 digits"
          value={values.gtin}
        />
        <FormField
          error={errors.category}
          label="Category"
          maxLength={120}
          onChangeText={(value) => updateValue('category', value)}
          placeholder="e.g. Kitchen appliance"
          value={values.category}
        />
      </FormSection>

      <FormSection
        description="Exact identifiers make recall matching more reliable."
        title="Identification">
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
      </FormSection>

      <View style={styles.section}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showSafetyDetails }}
          onPress={() => setShowSafetyDetails((current) => !current)}
          style={({ pressed }) => [styles.optionalHeader, pressed && styles.optionalHeaderPressed]}>
          <View style={styles.sectionHeading}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              Additional safety details
            </Text>
            <Text style={styles.sectionDescription}>
              Optional label details can help check narrowly scoped recalls.
            </Text>
          </View>
          <Text style={styles.optionalIndicator}>{showSafetyDetails ? '−' : '+'}</Text>
        </Pressable>
        {showSafetyDetails ? (
          <View style={styles.sectionFields}>
            <FormField
              label="Variant"
              maxLength={120}
              onChangeText={(value) => updateValue('variant', value)}
              value={values.variant}
            />
            <FormField
              label="Color"
              maxLength={120}
              onChangeText={(value) => updateValue('color', value)}
              value={values.color}
            />
            <FormField
              label="Size"
              maxLength={120}
              onChangeText={(value) => updateValue('size', value)}
              value={values.size}
            />
            <FormField
              label="Capacity"
              maxLength={120}
              onChangeText={(value) => updateValue('capacity', value)}
              value={values.capacity}
            />
            <FormField
              autoCapitalize="characters"
              label="Battery model"
              maxLength={120}
              onChangeText={(value) => updateValue('batteryModel', value)}
              value={values.batteryModel}
            />
            <FormField
              label="Charging port"
              maxLength={120}
              onChangeText={(value) => updateValue('chargingPortType', value)}
              value={values.chargingPortType}
            />
            <FormField
              label="Screw state"
              maxLength={120}
              onChangeText={(value) => updateValue('screwState', value)}
              value={values.screwState}
            />
            <FormField
              autoCapitalize="characters"
              label="Date code"
              maxLength={120}
              onChangeText={(value) => updateValue('dateCode', value)}
              value={values.dateCode}
            />
            <FormField
              autoCapitalize="none"
              error={errors.manufactureDate}
              label="Manufacture date"
              maxLength={10}
              onChangeText={(value) => updateValue('manufactureDate', value)}
              placeholder="YYYY-MM-DD"
              value={values.manufactureDate}
            />
            <FormField
              autoCapitalize="none"
              error={errors.productionDate}
              label="Production date"
              maxLength={10}
              onChangeText={(value) => updateValue('productionDate', value)}
              placeholder="YYYY-MM-DD"
              value={values.productionDate}
            />
          </View>
        ) : null}
      </View>

      <FormSection
        description="Purchase context is saved for future multi-authority coverage."
        title="Purchase">
        <CountrySelector
          label="Country of purchase"
          onChange={(value: CountryCode | '') => {
            countryWasEdited.current = true;
            updateValue('purchaseCountryCode', value);
          }}
          value={values.purchaseCountryCode as CountryCode | ''}
        />
        {errors.purchaseCountryCode ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {errors.purchaseCountryCode}
          </Text>
        ) : null}
        <PurchaseDateField
          error={errors.purchaseDate}
          onChange={(value) => updateValue('purchaseDate', value)}
          value={values.purchaseDate}
        />
      </FormSection>
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
  form: { gap: spacing.lg },
  section: { gap: spacing.md },
  sectionHeading: { gap: spacing.xxs },
  sectionTitle: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
  },
  sectionDescription: {
    color: colors.text.secondary,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
  },
  sectionFields: { gap: spacing.md },
  optionalHeader: {
    alignItems: 'center',
    borderColor: colors.border.subtle,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    padding: spacing.md,
  },
  optionalHeaderPressed: { backgroundColor: colors.surface.raised },
  optionalIndicator: {
    color: colors.brand.primary,
    fontSize: typography.size.title,
    fontWeight: typography.weight.bold,
  },
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
  hint: {
    color: colors.text.secondary,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
  link: { color: colors.brand.primary, textDecorationLine: 'underline' },
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
