import { memo, useCallback, useState } from 'react';
import * as Linking from 'expo-linking';
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
import {
  listSafetyObservationsV2,
  markSafetyAlertReadV2,
  type SafetyObservationV2,
} from '@/src/data/safetyFeedV2';
import { colors, radius, spacing, typography } from '@/src/design/tokens';
import type { RecallAlert } from '@/src/domain';
import { getAuthorityDisplayName } from '@/src/features/coverage/coveragePresentation';

import {
  formatRecallDate,
  getAlertMatchPresentation,
  toOfficialRecallUrl,
} from './alertPresentation';

function SafetyObservationCard({
  item,
  onRead,
}: {
  item: SafetyObservationV2;
  onRead: (id: string) => void;
}) {
  const corrected = item.displayState === 'no_longer_confirmed';
  const label = corrected
    ? 'Previous match no longer confirmed'
    : item.displayState === 'confirmed_alert'
      ? 'Confirmed recall alert'
      : item.displayState === 'confirmed_pending_alert'
        ? 'Confirmed match'
        : item.displayState === 'rejected'
          ? 'Match not confirmed'
          : 'Needs review';
  const copy = corrected
    ? 'Recall re-evaluated this product with newer matching rules. The previous match is no longer confirmed. Review the official recall information.'
    : item.displayState === 'confirmed_alert'
      ? 'A matching recall alert was created. Review the official recall information.'
      : item.displayState === 'confirmed_pending_alert'
        ? 'This match is confirmed; an alert is being prepared.'
        : 'The available evidence does not confirm this product is affected. Review the official notice if concerned.';
  const officialUrl = toOfficialRecallUrl(item.officialUrl);
  return (
    <View style={[styles.card, corrected && styles.changedCard]}>
      <Text style={[styles.cardEyebrow, corrected && styles.changedCardEyebrow]}>{label}</Text>
      <Text style={styles.cardTitle}>{item.title}</Text>
      <Text style={styles.productName}>{item.productName ?? 'Your product'}</Text>
      <Text style={styles.changedCopy}>{copy}</Text>
      <Text style={styles.sourceLabel}>Official · {getAuthorityDisplayName(item.authority)}</Text>
      {officialUrl ? (
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(officialUrl)}>
          <Text style={styles.retryLabel}>Open official recall notice</Text>
        </Pressable>
      ) : null}
      {item.alertId && item.alertState === 'unread' ? (
        <Pressable accessibilityRole="button" onPress={() => onRead(item.alertId as string)}>
          <Text style={styles.retryLabel}>Mark alert as read</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const AlertCard = memo(function AlertCard({
  alert,
  corrected,
}: {
  alert: RecallAlert;
  corrected: boolean;
}) {
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
        (corrected || !presentation.isConfirmed) && styles.changedCard,
        pressed && styles.cardPressed,
      ]}>
      <View style={styles.cardTopRow}>
        <Text
          style={[
            styles.cardEyebrow,
            (corrected || !presentation.isConfirmed) && styles.changedCardEyebrow,
          ]}>
          {corrected ? 'Previous match no longer confirmed' : presentation.listLabel}
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
      {corrected ? (
        <Text style={styles.changedCopy}>
          A newer safety evaluation changed this alert&apos;s status. Review the official recall.
        </Text>
      ) : !presentation.isConfirmed ? (
        <Text style={styles.changedCopy}>
          This previously raised alert is currently unconfirmed. Open it for the latest evaluation.
        </Text>
      ) : alert.notice.hazard ? (
        <Text numberOfLines={2} style={styles.hazard}>
          {alert.notice.hazard}
        </Text>
      ) : null}
      <View style={styles.cardFooter}>
        <Text style={styles.sourceLabel}>
          Official · {getAuthorityDisplayName(alert.notice.authority)}
        </Text>
        <Text accessibilityElementsHidden style={styles.chevron}>
          ›
        </Text>
      </View>
    </Pressable>
  );
});

function ItemSeparator() {
  return <View style={styles.separator} />;
}

export function AlertsScreen() {
  const [alerts, setAlerts] = useState<readonly RecallAlert[]>([]);
  const [observations, setObservations] = useState<readonly SafetyObservationV2[]>([]);
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
      const [nextAlerts, nextObservations] = await Promise.all([
        alertsRepository.listForCurrentUser(),
        listSafetyObservationsV2(),
      ]);
      if (isActive?.() ?? true) {
        setAlerts(nextAlerts);
        setObservations(nextObservations);
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
        description="Recall matches for products you own, backed by official product-safety notices."
      />
      {observations.map((item) => (
        <SafetyObservationCard
          item={item}
          key={`${item.ownedProductId}:${item.recallNoticeId}`}
          onRead={(alertId) => {
            void markSafetyAlertReadV2(alertId)
              .then(() => loadAlerts())
              .catch(() => {
                setError('Unable to mark this alert as read. Please try again.');
              });
          }}
        />
      ))}
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
  const renderAlert: ListRenderItem<RecallAlert> = ({ item }) => (
    <AlertCard
      alert={item}
      corrected={observations.some(
        (observation) =>
          observation.previousAlertId === item.id &&
          observation.displayState === 'no_longer_confirmed',
      )}
    />
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
          ) : error || observations.length ? null : (
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
