import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/src/components/ui/AppIcon';
import { PrimaryButton } from '@/src/components/ui/PrimaryButton';
import { Screen } from '@/src/components/ui/Screen';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

const protectionSteps = [
  { number: '01', label: 'Scan or photograph a product' },
  { number: '02', label: 'Confirm its exact identity' },
  { number: '03', label: 'Get alerted if a trusted source reports a match' },
] as const;

export function HomeScreen() {
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
        <View style={styles.statusPill}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>Ready to protect your products</Text>
        </View>
        <Text accessibilityRole="header" style={styles.title}>
          Know when something you own is unsafe.
        </Text>
        <Text style={styles.subtitle}>
          Add a product once. Recall will help monitor trusted safety notices and explain any exact
          match.
        </Text>
      </View>

      <PrimaryButton label="Scan a product" onPress={() => router.push('/scan')} />

      <View style={styles.summary}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryValue}>0</Text>
          <Text style={styles.summaryLabel}>Products</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryValue, styles.safeValue]}>0</Text>
          <Text style={styles.summaryLabel}>Active alerts</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <AppIcon android="shield" color={colors.semantic.safe} ios="shield.fill" size={25} />
          <Text style={styles.summaryLabel}>Protected</Text>
        </View>
      </View>

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
    backgroundColor: colors.semantic.safeSoft,
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  statusDot: {
    backgroundColor: colors.semantic.safe,
    borderRadius: radius.pill,
    height: 8,
    width: 8,
  },
  statusText: {
    color: colors.semantic.safe,
    fontSize: typography.size.caption,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.lineHeight.caption,
  },
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
