import { useCallback, useState } from 'react';
import { router, useFocusEffect, type Href } from 'expo-router';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { EmptyState } from '@/src/components/ui/EmptyState';
import { Screen } from '@/src/components/ui/Screen';
import { ScreenHeader } from '@/src/components/ui/ScreenHeader';
import { ownedProductsRepository } from '@/src/data';
import { colors, radius, spacing, typography } from '@/src/design/tokens';
import type { OwnedProduct } from '@/src/domain';

function ProductCard({ product }: { product: OwnedProduct }) {
  const details = [product.brand, product.modelNumber, product.category].filter(
    (value): value is string => Boolean(value),
  );

  return (
    <Pressable
      accessibilityHint="Opens this product's details"
      accessibilityLabel={`Open ${product.productName ?? 'product'}`}
      accessibilityRole="button"
      onPress={() => router.push(`/products/${product.id}` as Href)}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}>
      <View style={styles.cardCopy}>
        <Text numberOfLines={2} style={styles.productName}>
          {product.productName ?? 'Unnamed product'}
        </Text>
        {details.length > 0 ? (
          <Text numberOfLines={2} style={styles.productDetails}>
            {details.join(' · ')}
          </Text>
        ) : null}
      </View>
      <Text accessibilityElementsHidden style={styles.chevron}>
        ›
      </Text>
    </Pressable>
  );
}

export function ProductsScreen() {
  const [products, setProducts] = useState<readonly OwnedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProducts = useCallback(async (refresh = false, isActive?: () => boolean) => {
    if (refresh) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const nextProducts = await ownedProductsRepository.listForCurrentUser();
      if (isActive?.() ?? true) {
        setProducts(nextProducts);
        setError(null);
      }
    } catch {
      if (isActive?.() ?? true) {
        setError('Unable to load your products. Please try again.');
      }
    } finally {
      if (isActive?.() ?? true) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void loadProducts(false, () => active);
      return () => {
        active = false;
      };
    }, [loadProducts]),
  );

  const showEmptyState = !isLoading && !error && products.length === 0;

  return (
    <Screen
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          onRefresh={() => void loadProducts(true)}
          refreshing={isRefreshing}
          tintColor={colors.brand.primary}
        />
      }>
      <View style={styles.headerRow}>
        <ScreenHeader
          description="Keep the details that identify the products you own."
          title="My Products"
        />
        <Pressable
          accessibilityLabel="Add product"
          accessibilityRole="button"
          onPress={() => router.push('/products/new' as Href)}
          style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}>
          <Text style={styles.addButtonLabel}>Add product</Text>
        </Pressable>
      </View>

      {isLoading && products.length === 0 ? (
        <View style={styles.stateCard}>
          <Text style={styles.stateText}>Loading your products…</Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorCard}>
          <Text accessibilityLiveRegion="polite" style={styles.errorText}>
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void loadProducts()}
            style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}>
            <Text style={styles.retryLabel}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {showEmptyState ? (
        <View style={styles.emptyContainer}>
          <EmptyState
            description="Add a product to start building your Recall inventory."
            icon={{ ios: 'shippingbox.fill', android: 'inventory_2' }}
            title="No products yet"
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/products/new' as Href)}
            style={({ pressed }) => [styles.emptyAction, pressed && styles.addButtonPressed]}>
            <Text style={styles.emptyActionLabel}>Add a product</Text>
          </Pressable>
        </View>
      ) : null}

      {products.length > 0 ? (
        <View style={styles.list}>
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.lg },
  headerRow: { gap: spacing.md },
  addButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.brand.primary,
    borderRadius: radius.md,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  addButtonPressed: { backgroundColor: colors.brand.primaryPressed },
  addButtonLabel: {
    color: colors.text.inverse,
    fontSize: typography.size.label,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.label,
  },
  stateCard: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
  },
  stateText: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  errorCard: {
    backgroundColor: colors.semantic.dangerSoft,
    borderColor: colors.semantic.danger,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  errorText: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  retryButton: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  retryButtonPressed: { opacity: 0.7 },
  retryLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.label,
  },
  emptyContainer: { gap: spacing.md },
  emptyAction: {
    alignItems: 'center',
    backgroundColor: colors.brand.primary,
    borderRadius: radius.md,
    justifyContent: 'center',
    minHeight: 52,
  },
  emptyActionLabel: {
    color: colors.text.inverse,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.body,
  },
  list: { gap: spacing.sm },
  card: {
    alignItems: 'center',
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 76,
    padding: spacing.md,
  },
  cardPressed: { backgroundColor: colors.brand.soft },
  cardCopy: { flex: 1, gap: spacing.xxs },
  productName: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.body,
  },
  productDetails: {
    color: colors.text.secondary,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
  },
  chevron: { color: colors.text.muted, fontSize: 32, lineHeight: 32 },
});
