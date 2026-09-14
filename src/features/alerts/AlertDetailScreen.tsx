import { useCallback, useState } from 'react';
import * as Linking from 'expo-linking';
import { router, useFocusEffect, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/src/components/ui/Screen';
import { alertsRepository } from '@/src/data';
import { colors, radius, spacing, typography } from '@/src/design/tokens';
import type { RecallAlert } from '@/src/domain';

import {
  formatRecallDate,
  getAlertMatchPresentation,
  getMatchMethodLabel,
  toOfficialRecallUrl,
} from './alertPresentation';

function MessageCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.messageCard}>
      <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.messageText}>
        {message}
      </Text>
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => [styles.retryButton, pressed && styles.buttonPressed]}>
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
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

export function AlertDetailScreen({ id }: { id: string | null }) {
  const [alert, setAlert] = useState<RecallAlert | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const loadAlert = useCallback(
    async (isActive?: () => boolean) => {
      if (!id) {
        setAlert(null);
        setError('This recall alert link is invalid.');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      try {
        const nextAlert = await alertsRepository.getById(id);
        if (isActive?.() ?? true) {
          setAlert(nextAlert);
          setError(nextAlert ? null : 'This recall alert is no longer available.');
        }
      } catch {
        if (isActive?.() ?? true) {
          setError('Unable to load this recall alert. Please try again.');
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
      void loadAlert(() => active);
      return () => {
        active = false;
      };
    }, [loadAlert]),
  );

  const openOfficialRecall = useCallback(async () => {
    if (!alert) {
      return;
    }

    const officialUrl = toOfficialRecallUrl(alert.notice.officialUrl);
    if (!officialUrl) {
      setLinkError('The official recall link is unavailable.');
      return;
    }

    try {
      setLinkError(null);
      await Linking.openURL(officialUrl);
    } catch {
      setLinkError('Unable to open the official recall link on this device.');
    }
  }, [alert]);

  const presentation = alert ? getAlertMatchPresentation(alert.match.status) : null;
  const productTitle = alert?.product.productName ?? alert?.product.brand ?? 'Your product';

  return (
    <Screen contentContainerStyle={styles.content}>
      <Pressable
        accessibilityLabel="Back to alerts"
        accessibilityRole="button"
        onPress={() => router.replace('/alerts' as Href)}
        style={({ pressed }) => [styles.backButton, pressed && styles.buttonPressed]}>
        <Text style={styles.backLabel}>‹ Alerts</Text>
      </Pressable>

      {isLoading && !alert ? <MessageCard message="Loading recall alert…" /> : null}
      {error && !alert ? (
        <MessageCard message={error} onRetry={id ? () => void loadAlert() : undefined} />
      ) : null}

      {alert && presentation ? (
        <>
          <View style={styles.titleBlock}>
            <Text
              style={[
                styles.eyebrow,
                presentation.isConfirmed ? styles.confirmedText : styles.changedText,
              ]}>
              {presentation.listLabel}
            </Text>
            <Text accessibilityRole="header" style={styles.title}>
              {alert.notice.title}
            </Text>
            <Text style={styles.subtitle}>Official recall notice for {productTitle}</Text>
          </View>

          {error ? <MessageCard message={error} onRetry={() => void loadAlert()} /> : null}

          <View
            style={[
              styles.statusCard,
              presentation.isConfirmed ? styles.confirmedCard : styles.changedCard,
            ]}>
            <Text style={styles.statusTitle}>{presentation.statusLabel}</Text>
            <Text style={styles.statusCopy}>
              {presentation.isConfirmed
                ? 'Review the hazard and remedy below, and follow the official CPSC instructions.'
                : 'This alert was raised by an earlier confirmed evaluation. The latest evaluation no longer confirms the match; the alert is retained for transparency.'}
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Affected product</Text>
            <View style={styles.detailCard}>
              <DetailRow label="Product" value={alert.product.productName} />
              <DetailRow label="Brand" value={alert.product.brand} />
              <DetailRow label="GTIN / barcode" value={alert.product.gtin} />
              <DetailRow label="Model number" value={alert.product.modelNumber} />
              <DetailRow label="Serial number" value={alert.product.serialNumber} />
              <DetailRow label="Lot / batch number" value={alert.product.lotNumber} />
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Official safety notice</Text>
            <View style={styles.detailCard}>
              <DetailRow label="Recall date" value={formatRecallDate(alert.notice.recallDate)} />
              <DetailRow label="Hazard" value={alert.notice.hazard ?? 'See the official notice.'} />
              <DetailRow label="Remedy" value={alert.notice.remedy ?? 'See the official notice.'} />
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Why you received this alert</Text>
            <View style={styles.detailCard}>
              <DetailRow label="Current status" value={presentation.statusLabel} />
              <DetailRow label="Matching method" value={getMatchMethodLabel(alert.match.method)} />
              <DetailRow label="Evidence summary" value={alert.match.reasoningSummary} />
            </View>
          </View>

          {linkError ? <MessageCard message={linkError} /> : null}
          <Pressable
            accessibilityHint="Opens the recall on the CPSC website"
            accessibilityRole="link"
            onPress={() => void openOfficialRecall()}
            style={({ pressed }) => [styles.officialButton, pressed && styles.officialPressed]}>
            <Text style={styles.officialLabel}>Open official CPSC recall</Text>
          </Pressable>

          <Text style={styles.disclaimer}>
            Recall only reports safety notices from authoritative sources. Always follow the
            instructions on the official recall page.
          </Text>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.lg },
  backButton: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  backLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.lineHeight.label,
  },
  buttonPressed: { opacity: 0.7 },
  messageCard: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
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
  titleBlock: { gap: spacing.xs },
  eyebrow: {
    fontSize: typography.size.caption,
    fontWeight: typography.weight.bold,
    letterSpacing: 0.8,
    lineHeight: typography.lineHeight.caption,
  },
  confirmedText: { color: colors.semantic.danger },
  changedText: { color: colors.semantic.warning },
  title: {
    color: colors.text.primary,
    fontSize: typography.size.title,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.title,
  },
  subtitle: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  statusCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  confirmedCard: {
    backgroundColor: colors.semantic.dangerSoft,
    borderColor: colors.semantic.danger,
  },
  changedCard: {
    backgroundColor: colors.semantic.warningSoft,
    borderColor: colors.semantic.warning,
  },
  statusTitle: {
    color: colors.text.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.label,
  },
  statusCopy: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  section: { gap: spacing.sm },
  sectionTitle: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
  },
  detailCard: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
    borderWidth: 1,
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
  officialButton: {
    alignItems: 'center',
    backgroundColor: colors.brand.primary,
    borderRadius: radius.md,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.md,
  },
  officialPressed: { backgroundColor: colors.brand.primaryPressed },
  officialLabel: {
    color: colors.text.inverse,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.body,
    textAlign: 'center',
  },
  disclaimer: {
    color: colors.text.muted,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
});
