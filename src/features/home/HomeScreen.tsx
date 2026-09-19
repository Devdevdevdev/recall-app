import { useCallback, useState } from 'react';
import { router, useFocusEffect, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/src/components/ui/AppIcon';
import { PrimaryButton } from '@/src/components/ui/PrimaryButton';
import { Screen } from '@/src/components/ui/Screen';
import {
  alertsRepository,
  coverageRepository,
  monitoringStatusRepository,
  ownedProductsRepository,
} from '@/src/data';
import { colors, radius, spacing, typography } from '@/src/design/tokens';
import {
  formatMonitoringStatus,
  toCoverageSource,
} from '@/src/features/coverage/coveragePresentation';

const protectionSteps = [
  { number: '01', label: 'Scan or photograph a product' },
  { number: '02', label: 'Confirm its exact identity' },
  { number: '03', label: 'Get alerted if a trusted source reports a match' },
] as const;

export function HomeScreen() {
  const [summary, setSummary] = useState<{
    products: number | null;
    alerts: number | null;
    sources: number | null;
  }>({ products: null, alerts: null, sources: null });
  const [monitoringState, setMonitoringState] = useState<'active' | 'checking' | 'unavailable'>(
    'checking',
  );
  const [statusLabel, setStatusLabel] = useState('Checking monitoring status…');
  const [lastCheckedLabel, setLastCheckedLabel] = useState<string | null>(null);
  const [coverageLabel, setCoverageLabel] = useState('Loading official coverage…');
  const [error, setError] = useState<string | null>(null);

  const loadSummary = useCallback(async (isActive?: () => boolean) => {
    const [productsResult, alertsResult, monitoringResult, coverageResult] =
      await Promise.allSettled([
        ownedProductsRepository.getCurrentUserCount(),
        alertsRepository.getActiveCount(),
        monitoringStatusRepository.getStatus(),
        coverageRepository.listActiveSources(),
      ]);

    if (!(isActive?.() ?? true)) return;

    setSummary((current) => ({
      products: productsResult.status === 'fulfilled' ? productsResult.value : current.products,
      alerts: alertsResult.status === 'fulfilled' ? alertsResult.value : current.alerts,
      sources:
        monitoringResult.status === 'fulfilled'
          ? monitoringResult.value.activeSourceCount
          : current.sources,
    }));

    if (monitoringResult.status === 'fulfilled') {
      const presentation = formatMonitoringStatus(monitoringResult.value);
      setStatusLabel(presentation.statusLabel);
      setLastCheckedLabel(presentation.lastCheckedLabel);
      setMonitoringState(presentation.isActive ? 'active' : 'unavailable');
    } else {
      setStatusLabel('Monitoring status unavailable');
      setLastCheckedLabel(null);
      setMonitoringState('unavailable');
    }

    if (coverageResult.status === 'fulfilled') {
      setCoverageLabel(
        coverageResult.value.length > 0
          ? coverageResult.value
              .map(toCoverageSource)
              .map((source) => `${source.jurisdiction} · ${source.authority}`)
              .join(', ')
          : 'No active official source',
      );
    } else {
      setCoverageLabel('Coverage temporarily unavailable');
    }

    const hasFailure = [productsResult, alertsResult, monitoringResult, coverageResult].some(
      (result) => result.status === 'rejected',
    );
    setError(hasFailure ? 'Some summary data could not be refreshed. Please try again.' : null);
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void loadSummary(() => active);
      return () => {
        active = false;
      };
    }, [loadSummary]),
  );

  return (
    <Screen>
      <View style={styles.brandRow}>
        <View style={styles.brandMark}>
          <AppIcon
            android="verified_user"
            color={colors.text.inverse}
            ios="checkmark.shield.fill"
          />
        </View>
        <Text style={styles.brandName}>Recall</Text>
      </View>

      <View style={styles.hero}>
        <View
          style={[
            styles.statusPill,
            monitoringState === 'active' && styles.statusPillActive,
            monitoringState === 'unavailable' && styles.statusPillUnavailable,
          ]}>
          <View
            style={[
              styles.statusDot,
              monitoringState === 'active' && styles.statusDotActive,
              monitoringState === 'unavailable' && styles.statusDotUnavailable,
            ]}
          />
          <Text
            accessibilityLiveRegion="polite"
            style={[
              styles.statusText,
              monitoringState === 'active' && styles.statusTextActive,
              monitoringState === 'unavailable' && styles.statusTextUnavailable,
            ]}>
            {statusLabel}
          </Text>
        </View>
        <Text accessibilityRole="header" style={styles.title}>
          Scan it once. Recall watches it for you.
        </Text>
        <Text style={styles.subtitle}>
          Save the details that identify a product. Recall automatically checks active official
          safety sources and explains relevant matches.
        </Text>
        {lastCheckedLabel ? <Text style={styles.lastChecked}>{lastCheckedLabel}</Text> : null}
      </View>

      <PrimaryButton label="Scan a product" onPress={() => router.push('/scan')} />

      {error ? (
        <View style={styles.errorCard}>
          <Text accessibilityLiveRegion="polite" accessibilityRole="alert" style={styles.errorText}>
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void loadSummary()}
            style={styles.retryButton}>
            <Text style={styles.retryLabel}>Refresh</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.summary}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryValue}>{summary.products ?? '—'}</Text>
          <Text style={styles.summaryLabel}>Products</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text
            style={[
              styles.summaryValue,
              summary.alerts === 0 && styles.safeValue,
              summary.alerts !== null && summary.alerts > 0 && styles.warningValue,
            ]}>
            {summary.alerts ?? '—'}
          </Text>
          <Text style={styles.summaryLabel}>Active alerts</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={styles.summaryValue}>{summary.sources ?? '—'}</Text>
          <Text style={styles.summaryLabel}>Official sources</Text>
        </View>
      </View>

      <Pressable
        accessibilityHint="Shows current official recall source coverage"
        accessibilityRole="button"
        onPress={() => router.push('/coverage' as Href)}
        style={({ pressed }) => [styles.coverageCard, pressed && styles.coveragePressed]}>
        <View style={styles.coverageCopy}>
          <Text style={styles.coverageTitle}>Current coverage</Text>
          <Text style={styles.coverageText}>{coverageLabel}</Text>
        </View>
        <Text accessibilityElementsHidden style={styles.coverageChevron}>
          ›
        </Text>
      </Pressable>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>How it works</Text>
        <View style={styles.steps}>
          {protectionSteps.map((step) => (
            <View key={step.number} style={styles.step}>
              <Text style={styles.stepNumber}>{step.number}</Text>
              <Text style={styles.stepLabel}>{step.label}</Text>
            </View>
          ))}
        </View>
      </View>

      <Text style={styles.disclaimer}>
        Recall will only report safety notices retrieved from trusted sources. AI helps match
        products; it is never the source of a recall.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  brandRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  brandMark: {
    alignItems: 'center',
    backgroundColor: colors.brand.primary,
    borderRadius: radius.md,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  brandName: {
    color: colors.brand.ink,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    letterSpacing: -0.3,
  },
  hero: {
    gap: spacing.md,
    paddingTop: spacing.sm,
  },
  statusPill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.surface.sunken,
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  statusPillActive: { backgroundColor: colors.semantic.safeSoft },
  statusPillUnavailable: { backgroundColor: colors.semantic.warningSoft },
  statusDot: {
    backgroundColor: colors.text.muted,
    borderRadius: radius.pill,
    height: 8,
    width: 8,
  },
  statusDotActive: { backgroundColor: colors.semantic.safe },
  statusDotUnavailable: { backgroundColor: colors.semantic.warning },
  statusText: {
    color: colors.text.secondary,
    fontSize: typography.size.caption,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.lineHeight.caption,
  },
  statusTextActive: { color: colors.semantic.safe },
  statusTextUnavailable: { color: colors.semantic.warning },
  title: {
    color: colors.text.primary,
    fontSize: typography.size.display,
    fontWeight: typography.weight.bold,
    letterSpacing: -1.1,
    lineHeight: typography.lineHeight.display,
    maxWidth: 620,
  },
  subtitle: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    maxWidth: 560,
  },
  lastChecked: {
    color: colors.text.muted,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
  errorCard: {
    backgroundColor: colors.semantic.dangerSoft,
    borderColor: colors.semantic.danger,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  errorText: {
    color: colors.text.primary,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
  },
  retryButton: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44 },
  retryLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.bold,
  },
  summary: {
    alignItems: 'center',
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.lg,
  },
  summaryItem: {
    alignItems: 'center',
    flex: 1,
    gap: spacing.xxs,
    minWidth: 0,
  },
  summaryDivider: {
    alignSelf: 'stretch',
    backgroundColor: colors.border.subtle,
    width: 1,
  },
  summaryValue: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
  },
  safeValue: {
    color: colors.semantic.safe,
  },
  warningValue: {
    color: colors.semantic.warning,
  },
  coverageCard: {
    alignItems: 'center',
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 72,
    padding: spacing.md,
  },
  coveragePressed: { backgroundColor: colors.brand.soft },
  coverageCopy: { flex: 1, gap: spacing.xxs },
  coverageTitle: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
  },
  coverageText: {
    color: colors.text.secondary,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
  },
  coverageChevron: { color: colors.text.muted, fontSize: 28, lineHeight: 28 },
  summaryLabel: {
    color: colors.text.muted,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
    textAlign: 'center',
  },
  section: {
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
  },
  steps: {
    gap: spacing.xs,
  },
  step: {
    alignItems: 'center',
    borderBottomColor: colors.border.subtle,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  stepNumber: {
    color: colors.brand.primary,
    fontSize: typography.size.caption,
    fontWeight: typography.weight.bold,
    letterSpacing: 0.6,
    width: 28,
  },
  stepLabel: {
    color: colors.text.primary,
    flex: 1,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  disclaimer: {
    color: colors.text.muted,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
});
