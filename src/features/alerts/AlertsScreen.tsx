import { memo, useCallback, useState } from 'react';
import { router, useFocusEffect, type Href } from 'expo-router';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type ListRenderItem,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EmptyState } from '@/src/components/ui/EmptyState';
import { ScreenHeader } from '@/src/components/ui/ScreenHeader';
import { alertsRepository } from '@/src/data';
import { colors, radius, spacing, typography } from '@/src/design/tokens';
import type { RecallAlert } from '@/src/domain';

import { formatRecallDate, getAlertMatchPresentation } from './alertPresentation';

const AlertCard = memo(function AlertCard({ alert }: { alert: RecallAlert }) {
  const presentation = getAlertMatchPresentation(alert.match.status);
  const productName = alert.product.productName ?? alert.product.brand ?? 'Your product';

  return (
    <Pressable
      accessibilityHint="Opens the official recall alert details"
      accessibilityLabel={`Open recall alert for ${productName}`}
      accessibilityRole="button"
      onPress={() => router.push(`/alerts/${alert.id}` as Href)}
      style={({ pressed }) => [
        styles.card,
        !presentation.isConfirmed && styles.changedCard,
        pressed && styles.cardPressed,
      ]}>
      <View style={styles.cardTopRow}>
        <Text style={[styles.cardEyebrow, !presentation.isConfirmed && styles.changedCardEyebrow]}>
          {presentation.listLabel}
        </Text>
        <Text style={styles.cardDate}>{formatRecallDate(alert.notice.recallDate)}</Text>
      </View>
      <Text numberOfLines={2} style={styles.cardTitle}>
        {alert.notice.title}
      </Text>
      <Text numberOfLines={2} style={styles.productName}>
        {productName}
        {alert.product.modelNumber ? ` · ${alert.product.modelNumber}` : ''}
      </Text>
      {!presentation.isConfirmed ? (
        <Text style={styles.changedCopy}>
          This previously raised alert is currently unconfirmed. Open it for the latest evaluation.
        </Text>
      ) : alert.notice.hazard ? (
        <Text numberOfLines={2} style={styles.hazard}>
          {alert.notice.hazard}
        </Text>
      ) : null}
      <View style={styles.cardFooter}>
        <Text style={styles.sourceLabel}>Official CPSC recall</Text>
        <Text accessibilityElementsHidden style={styles.chevron}>
          ›
        </Text>
      </View>
    </Pressable>
  );
});

const renderAlert: ListRenderItem<RecallAlert> = ({ item }) => <AlertCard alert={item} />;

function ItemSeparator() {
  return <View style={styles.separator} />;
}

export function AlertsScreen() {
  const [alerts, setAlerts] = useState<readonly RecallAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAlerts = useCallback(async (refresh = false, isActive?: () => boolean) => {
    if (refresh) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const nextAlerts = await alertsRepository.listForCurrentUser();
      if (isActive?.() ?? true) {
        setAlerts(nextAlerts);
        setError(null);
      }
    } catch {
      if (isActive?.() ?? true) {
        setError('Unable to load your recall alerts. Please try again.');
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
      void loadAlerts(false, () => active);
      return () => {
        active = false;
      };
    }, [loadAlerts]),
  );

  const header = (
    <View style={styles.header}>
      <ScreenHeader
        title="Alerts"
        description="Recall matches for products you own, backed by official CPSC safety notices."
      />
      {error ? (
        <View style={styles.errorCard}>
          <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.errorText}>
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void loadAlerts()}
            style={({ pressed }) => [styles.retryButton, pressed && styles.buttonPressed]}>
            <Text style={styles.retryLabel}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <FlatList
        contentContainerStyle={styles.content}
        data={alerts}
        ItemSeparatorComponent={ItemSeparator}
        keyExtractor={(alert) => alert.id}
        ListHeaderComponent={header}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.stateCard}>
              <Text accessibilityLiveRegion="polite" style={styles.stateText}>
                Loading recall alerts…
              </Text>
            </View>
          ) : error ? null : (
            <EmptyState
              description="There are no confirmed recall matches for your products. Pull down to check again."
              icon={{ ios: 'checkmark.shield.fill', android: 'verified_user' }}
              title="All clear"
            />
          )
        }
        refreshControl={
          <RefreshControl
            onRefresh={() => void loadAlerts(true)}
            refreshing={isRefreshing}
            tintColor={colors.brand.primary}
          />
        }
        renderItem={renderAlert}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.surface.background, flex: 1 },
  content: {
    flexGrow: 1,
    paddingBottom: spacing.xxl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  header: { gap: spacing.lg, marginBottom: spacing.lg },
  separator: { height: spacing.sm },
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
    gap: spacing.sm,
    padding: spacing.md,
  },
  errorText: {
    color: colors.text.primary,
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
  buttonPressed: { opacity: 0.7 },
  card: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.semantic.danger,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  changedCard: {
    backgroundColor: colors.semantic.warningSoft,
    borderColor: colors.semantic.warning,
  },
  cardPressed: { opacity: 0.76 },
  cardTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  cardEyebrow: {
    color: colors.semantic.danger,
    flexShrink: 1,
    fontSize: typography.size.caption,
    fontWeight: typography.weight.bold,
    letterSpacing: 0.8,
    lineHeight: typography.lineHeight.caption,
  },
  changedCardEyebrow: { color: colors.semantic.warning },
  cardDate: {
    color: colors.text.muted,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
  cardTitle: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
  },
  productName: {
    color: colors.text.secondary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.lineHeight.label,
  },
  hazard: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  changedCopy: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  cardFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: spacing.xxs,
  },
  sourceLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.lineHeight.label,
  },
  chevron: { color: colors.text.muted, fontSize: 28, lineHeight: 28 },
});
