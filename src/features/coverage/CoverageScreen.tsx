import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/src/components/ui/Screen';
import { coverageRepository, monitoringStatusRepository } from '@/src/data';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

import {
  formatMonitoringStatus,
  toCoverageSource,
  type CoverageSource,
  type MonitoringStatusPresentation,
} from './coveragePresentation';

export function CoverageScreen() {
  const [sources, setSources] = useState<readonly CoverageSource[]>([]);
  const [monitoring, setMonitoring] = useState<MonitoringStatusPresentation | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isActive?: () => boolean) => {
    setIsLoading(true);
    const [sourcesResult, monitoringResult] = await Promise.allSettled([
      coverageRepository.listActiveSources(),
      monitoringStatusRepository.getStatus(),
    ]);
    if (!(isActive?.() ?? true)) return;

    if (sourcesResult.status === 'fulfilled') {
      setSources(sourcesResult.value.map(toCoverageSource));
    }
    if (monitoringResult.status === 'fulfilled') {
      setMonitoring(formatMonitoringStatus(monitoringResult.value));
    }

    setError(
      sourcesResult.status === 'rejected' || monitoringResult.status === 'rejected'
        ? 'Some coverage data could not be loaded. Please try again.'
        : null,
    );
    setIsLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void load(() => active);
      return () => {
        active = false;
      };
    }, [load]),
  );

  return (
    <Screen contentContainerStyle={styles.content}>
      <Pressable
        accessibilityLabel="Back"
        accessibilityRole="button"
        onPress={() => {
          if (router.canGoBack()) router.back();
          else router.replace('/settings');
        }}
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}>
        <Text style={styles.backLabel}>‹ Back</Text>
      </Pressable>

      <View style={styles.titleBlock}>
        <Text accessibilityRole="header" style={styles.title}>
          Coverage
        </Text>
        <Text style={styles.description}>
          Recall currently monitors official United States recall data. Product purchase country is
          saved for future multi-jurisdiction coverage.
        </Text>
      </View>

      {isLoading && sources.length === 0 ? (
        <View style={styles.messageCard}>
          <Text accessibilityLiveRegion="polite" style={styles.messageText}>
            Loading official coverage…
          </Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorCard}>
          <Text
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
            style={styles.messageText}>
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void load()}
            style={styles.retryButton}>
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {monitoring ? (
        <View
          style={[styles.monitoringCard, !monitoring.isActive && styles.monitoringCardUnavailable]}>
          <Text
            style={[
              styles.monitoringTitle,
              !monitoring.isActive && styles.monitoringTitleUnavailable,
            ]}>
            {monitoring.statusLabel}
          </Text>
          <Text style={styles.monitoringText}>{monitoring.lastCheckedLabel}</Text>
          <Text style={styles.monitoringText}>{monitoring.activeSourcesLabel}</Text>
        </View>
      ) : null}

      {sources.map((source) => (
        <View key={source.id} style={styles.sourceCard}>
          <View style={styles.sourceHeader}>
            <View style={styles.activeDot} />
            <Text style={styles.activeLabel}>{source.status}</Text>
          </View>
          <Text style={styles.jurisdiction}>{source.jurisdiction}</Text>
          <Text style={styles.authority}>{source.authority}</Text>
          <View style={styles.metadataRow}>
            <Text style={styles.metadataLabel}>Source language</Text>
            <Text style={styles.metadataValue}>{source.sourceLanguage}</Text>
          </View>
        </View>
      ))}

      {!isLoading && !error && sources.length === 0 ? (
        <View style={styles.messageCard}>
          <Text style={styles.messageText}>
            No active official source is available right now. Refresh to try again.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void load()}
            style={styles.retryButton}>
            <Text style={styles.retryLabel}>Refresh</Text>
          </Pressable>
        </View>
      ) : null}

      <Text style={styles.footnote}>
        More official sources can be added through the global-ready source model. Recall does not
        claim worldwide coverage today.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.lg },
  backButton: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44 },
  backLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
  },
  pressed: { opacity: 0.7 },
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
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  errorCard: {
    backgroundColor: colors.semantic.dangerSoft,
    borderColor: colors.semantic.danger,
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
  retryButton: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44 },
  retryLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.bold,
  },
  monitoringCard: {
    backgroundColor: colors.semantic.safeSoft,
    borderColor: colors.semantic.safe,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xxs,
    padding: spacing.md,
  },
  monitoringCardUnavailable: {
    backgroundColor: colors.semantic.warningSoft,
    borderColor: colors.semantic.warning,
  },
  monitoringTitle: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
  },
  monitoringTitleUnavailable: { color: colors.semantic.warning },
  monitoringText: {
    color: colors.text.secondary,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
  },
  sourceCard: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.lg,
  },
  sourceHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  activeDot: {
    backgroundColor: colors.semantic.safe,
    borderRadius: radius.pill,
    height: 8,
    width: 8,
  },
  activeLabel: {
    color: colors.semantic.safe,
    fontSize: typography.size.caption,
    fontWeight: typography.weight.bold,
    textTransform: 'uppercase',
  },
  jurisdiction: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
  },
  authority: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  metadataRow: {
    borderTopColor: colors.border.subtle,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
  },
  metadataLabel: { color: colors.text.muted, fontSize: typography.size.caption },
  metadataValue: {
    color: colors.text.primary,
    fontSize: typography.size.caption,
    fontWeight: typography.weight.semibold,
  },
  footnote: {
    color: colors.text.muted,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
});
