import { useCallback, useEffect, useState } from 'react';
import { router, useFocusEffect, type Href } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/src/components/ui/Screen';
import {
  ownedProductsRepository,
  productMonitoringRepository,
  userPreferencesRepository,
} from '@/src/data';
import { colors, radius, spacing, typography } from '@/src/design/tokens';
import { getCountryName, type OwnedProduct, type OwnedProductInput } from '@/src/domain';

import { ProductForm } from './ProductForm';
import {
  barcodeScanForSubmission,
  productFormValuesFromProduct,
  productCreationPrefillFromParams,
  scannedBarcodeDetail,
  scannedBarcodeForGtin,
  type ProductCreationParams,
  type ProductCreationPrefill,
} from './productFormUtils';
import { hasMatchingAttributeChange } from './productMonitoring';
import { formatPurchaseDate, formatScanDate } from './purchaseDate';

/** Never blocks or fails the save; the server keeps the durable job and retries it. */
function requestCheckInBackground(productId: string) {
  void productMonitoringRepository.requestCheck(productId).catch(() => undefined);
}

function BackButton({
  href = '/products',
  label = 'My Products',
}: {
  href?: Href;
  label?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={`Back to ${label}`}
      accessibilityRole="button"
      onPress={() => router.replace(href)}
      style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}>
      <Text style={styles.backLabel}>‹ {label}</Text>
    </Pressable>
  );
}

function PageTitle({ description, title }: { description: string; title: string }) {
  return (
    <View style={styles.titleBlock}>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      <Text style={styles.description}>{description}</Text>
    </View>
  );
}

function LoadingOrError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.messageCard}>
      <Text accessibilityLiveRegion="polite" style={styles.messageText}>
        {message}
      </Text>
      {onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retryButton}>
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

type NewProductScreenProps = {
  creationParams?: ProductCreationParams;
};

export function NewProductScreen({ creationParams = {} }: NewProductScreenProps) {
  const {
    barcodeRawValue,
    barcodeSymbology,
    gtin,
    lotNumber,
    modelNumber,
    serialNumber,
    source,
    variant,
    color,
    size,
    capacity,
    batteryModel,
    chargingPortType,
    screwState,
    dateCode,
    manufactureDate,
    productionDate,
  } = creationParams;
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<ProductCreationPrefill>(() =>
    productCreationPrefillFromParams(creationParams),
  );

  useEffect(() => {
    let active = true;
    const currentParams = {
      barcodeRawValue,
      barcodeSymbology,
      gtin,
      lotNumber,
      modelNumber,
      serialNumber,
      source,
      variant,
      color,
      size,
      capacity,
      batteryModel,
      chargingPortType,
      screwState,
      dateCode,
      manufactureDate,
      productionDate,
    };
    void (async () => {
      try {
        const defaultCountry = await userPreferencesRepository.getDefaultPurchaseCountryCode();
        if (active) {
          setPrefill(productCreationPrefillFromParams(currentParams, defaultCountry));
        }
      } catch {
        if (active) {
          setError('Your default country could not be loaded. You can still choose one below.');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [
    barcodeRawValue,
    barcodeSymbology,
    gtin,
    lotNumber,
    modelNumber,
    serialNumber,
    source,
    variant,
    color,
    size,
    capacity,
    batteryModel,
    chargingPortType,
    screwState,
    dateCode,
    manufactureDate,
    productionDate,
  ]);

  const identificationMethod = prefill.identificationMethod;
  const scannedBarcode = prefill.scannedBarcode;

  const createProduct = useCallback(
    async (input: OwnedProductInput) => {
      if (isSaving) {
        return;
      }

      setIsSaving(true);
      setError(null);
      try {
        const barcodeScan = barcodeScanForSubmission(scannedBarcode, input.gtin);
        const product = await ownedProductsRepository.create({
          ...input,
          ...(identificationMethod ? { identificationMethod } : {}),
          ...(barcodeScan ? { barcodeScan } : {}),
        });
        // The product is saved. The recall check is best-effort and retried server-side.
        requestCheckInBackground(product.id);
        router.replace(`/products/${product.id}` as Href);
      } catch {
        setError('Unable to save this product. Please try again.');
      } finally {
        setIsSaving(false);
      }
    },
    [identificationMethod, isSaving, scannedBarcode],
  );

  return (
    <Screen contentContainerStyle={styles.screenContent}>
      <BackButton />
      <PageTitle
        description={
          identificationMethod === 'barcode_scan'
            ? 'Your barcode is ready. Add a product name and any details you know.'
            : identificationMethod === 'ocr_assisted'
              ? 'Review the label details, then add the product name yourself.'
              : 'Add the details you have now. You can update them later.'
        }
        title="Add product"
      />
      {error ? <LoadingOrError message={error} /> : null}
      <ProductForm
        initialValues={prefill.values}
        isSubmitting={isSaving}
        onSubmit={createProduct}
        scannedBarcode={scannedBarcode}
        submitLabel="Save product"
      />
    </Screen>
  );
}

type DetailRowProps = { label: string; value: string | null };

function DetailRow({ label, value }: DetailRowProps) {
  if (!value) {
    return null;
  }

  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text selectable style={styles.detailValue}>
        {value}
      </Text>
    </View>
  );
}

function identificationMethodLabel(value: string | null): string | null {
  if (value === 'barcode_scan') return 'Barcode scan';
  if (value === 'ocr_assisted') return 'Label scan, reviewed by you';
  if (value === 'manual') return 'Entered manually';
  return value;
}

type ProductDetailScreenProps = { id: string };

export function ProductDetailScreen({ id }: ProductDetailScreenProps) {
  const [product, setProduct] = useState<OwnedProduct | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const loadProduct = useCallback(
    async (isActive?: () => boolean) => {
      setIsLoading(true);
      try {
        const nextProduct = await ownedProductsRepository.getById(id);
        if (isActive?.() ?? true) {
          setProduct(nextProduct);
          setError(nextProduct ? null : 'This product is no longer available.');
        }
      } catch {
        if (isActive?.() ?? true) {
          setError('Unable to load this product. Please try again.');
        }
      } finally {
        if (isActive?.() ?? true) {
          setIsLoading(false);
        }
      }
    },
    [id],
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void loadProduct(() => active);
      return () => {
        active = false;
      };
    }, [loadProduct]),
  );

  function confirmDelete() {
    if (!product || isDeleting) {
      return;
    }

    Alert.alert(
      `Delete ${product.productName ?? 'this product'}?`,
      'This removes the product from Recall.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setIsDeleting(true);
              try {
                await ownedProductsRepository.delete(product.id);
                router.replace('/products');
              } catch {
                setError('Unable to delete this product. Please try again.');
                setIsDeleting(false);
              }
            })();
          },
        },
      ],
    );
  }

  return (
    <Screen contentContainerStyle={styles.screenContent}>
      <BackButton />
      {isLoading && !product ? <LoadingOrError message="Loading product…" /> : null}
      {error && !product ? (
        <LoadingOrError message={error} onRetry={() => void loadProduct()} />
      ) : null}
      {product ? (
        <>
          <PageTitle description="Product details" title={product.productName ?? 'Product'} />
          {error ? <LoadingOrError message={error} onRetry={() => void loadProduct()} /> : null}
          <View style={styles.detailCard}>
            <DetailRow label="Brand" value={product.brand} />
            <DetailRow label="Scanned on" value={formatScanDate(product.scanDate)} />
            <DetailRow label="GTIN" value={product.gtin} />
            <DetailRow label="Scanned barcode" value={scannedBarcodeDetail(product)} />
            <DetailRow
              label="Country of purchase"
              value={
                product.purchaseCountryCode ? getCountryName(product.purchaseCountryCode) : null
              }
            />
            <DetailRow label="Model number" value={product.modelNumber} />
            <DetailRow label="Serial number" value={product.serialNumber} />
            <DetailRow label="Lot / batch number" value={product.lotNumber} />
            <DetailRow
              label="Purchase date"
              value={product.purchaseDate ? formatPurchaseDate(product.purchaseDate) : null}
            />
            <DetailRow label="Category" value={product.category} />
            <DetailRow
              label="Identification method"
              value={identificationMethodLabel(product.identificationMethod)}
            />
          </View>
          {Object.keys(product.safetyAttributes ?? {}).length ? (
            <View style={styles.detailSection}>
              <Text accessibilityRole="header" style={styles.detailSectionTitle}>
                Additional safety details
              </Text>
              <View style={styles.detailCard}>
                <DetailRow label="Variant" value={product.safetyAttributes?.variant ?? null} />
                <DetailRow label="Color" value={product.safetyAttributes?.color ?? null} />
                <DetailRow label="Size" value={product.safetyAttributes?.size ?? null} />
                <DetailRow label="Capacity" value={product.safetyAttributes?.capacity ?? null} />
                <DetailRow
                  label="Battery model"
                  value={product.safetyAttributes?.battery_model ?? null}
                />
                <DetailRow
                  label="Charging port"
                  value={product.safetyAttributes?.charging_port_type ?? null}
                />
                <DetailRow
                  label="Screw state"
                  value={product.safetyAttributes?.screw_state ?? null}
                />
                <DetailRow label="Date code" value={product.safetyAttributes?.date_code ?? null} />
                <DetailRow
                  label="Manufacture date"
                  value={product.safetyAttributes?.manufacture_date ?? null}
                />
                <DetailRow
                  label="Production date"
                  value={product.safetyAttributes?.production_date ?? null}
                />
              </View>
            </View>
          ) : null}
          <View style={styles.monitoringCard}>
            <Text style={styles.monitoringTitle}>Automatic recall checks</Text>
            <Text style={styles.monitoringText}>
              Recall checks active official sources automatically. Country of purchase is saved as
              context and does not override an exact identifier match.
            </Text>
          </View>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(`/products/${id}/edit` as Href)}
              style={({ pressed }) => [styles.editButton, pressed && styles.editButtonPressed]}>
              <Text style={styles.editLabel}>Edit product</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={isDeleting}
              onPress={confirmDelete}
              style={({ pressed }) => [
                styles.deleteButton,
                pressed && styles.deleteButtonPressed,
                isDeleting && styles.deleteButtonDisabled,
              ]}>
              <Text style={styles.deleteLabel}>{isDeleting ? 'Deleting…' : 'Delete product'}</Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </Screen>
  );
}

type EditProductScreenProps = { id: string };

export function EditProductScreen({ id }: EditProductScreenProps) {
  const [product, setProduct] = useState<OwnedProduct | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProduct = useCallback(
    async (isActive?: () => boolean) => {
      setIsLoading(true);
      try {
        const nextProduct = await ownedProductsRepository.getById(id);
        if (isActive?.() ?? true) {
          setProduct(nextProduct);
          setError(nextProduct ? null : 'This product is no longer available.');
        }
      } catch {
        if (isActive?.() ?? true) {
          setError('Unable to load this product. Please try again.');
        }
      } finally {
        if (isActive?.() ?? true) {
          setIsLoading(false);
        }
      }
    },
    [id],
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void loadProduct(() => active);
      return () => {
        active = false;
      };
    }, [loadProduct]),
  );

  const updateProduct = useCallback(
    async (input: OwnedProductInput) => {
      if (isSaving) {
        return;
      }

      setIsSaving(true);
      setError(null);
      try {
        const updated = await ownedProductsRepository.update(id, input);
        if (!product || hasMatchingAttributeChange(product, updated)) {
          requestCheckInBackground(id);
        }
        router.replace(`/products/${id}` as Href);
      } catch {
        setError('Unable to save this product. Please try again.');
      } finally {
        setIsSaving(false);
      }
    },
    [id, isSaving, product],
  );

  return (
    <Screen contentContainerStyle={styles.screenContent}>
      <BackButton href={`/products/${id}` as Href} label="Product" />
      <PageTitle
        description="Update the details that identify this product."
        title="Edit product"
      />
      {isLoading ? <LoadingOrError message="Loading product…" /> : null}
      {error && !product ? (
        <LoadingOrError message={error} onRetry={() => void loadProduct()} />
      ) : null}
      {error && product ? <LoadingOrError message={error} /> : null}
      {product ? (
        <ProductForm
          initialValues={productFormValuesFromProduct(product)}
          isSubmitting={isSaving}
          onSubmit={updateProduct}
          scannedBarcode={scannedBarcodeForGtin(product.barcodeScan, product.gtin)}
          submitLabel="Save changes"
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  screenContent: { gap: spacing.lg },
  backButton: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  backButtonPressed: { opacity: 0.7 },
  backLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.lineHeight.label,
  },
  titleBlock: { gap: spacing.xs },
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
  },
  messageCard: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  messageText: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  retryButton: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  retryLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.label,
  },
  detailCard: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  detailSection: { gap: spacing.sm },
  detailSectionTitle: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
  },
  detailRow: {
    borderBottomColor: colors.border.subtle,
    borderBottomWidth: 1,
    gap: spacing.xxs,
    padding: spacing.md,
  },
  detailLabel: {
    color: colors.text.muted,
    fontSize: typography.size.caption,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.lineHeight.caption,
  },
  detailValue: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  monitoringCard: {
    backgroundColor: colors.semantic.safeSoft,
    borderColor: colors.semantic.safe,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  monitoringTitle: {
    color: colors.text.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.label,
  },
  monitoringText: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  actions: { gap: spacing.sm },
  editButton: {
    alignItems: 'center',
    backgroundColor: colors.brand.primary,
    borderRadius: radius.md,
    justifyContent: 'center',
    minHeight: 52,
  },
  editButtonPressed: { backgroundColor: colors.brand.primaryPressed },
  editLabel: {
    color: colors.text.inverse,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.body,
  },
  deleteButton: {
    alignItems: 'center',
    borderColor: colors.semantic.danger,
    borderRadius: radius.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 52,
  },
  deleteButtonPressed: { backgroundColor: colors.semantic.dangerSoft },
  deleteButtonDisabled: { opacity: 0.6 },
  deleteLabel: {
    color: colors.semantic.danger,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.body,
  },
});
