import { StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/src/components/ui/AppIcon';
import { Screen } from '@/src/components/ui/Screen';
import { ScreenHeader } from '@/src/components/ui/ScreenHeader';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

const identifiers = [
  'Barcode / EAN / UPC',
  'Brand and product name',
  'Model, lot, or serial details',
];

export function ScanScreen() {
  return (
    <Screen>
      <ScreenHeader
        title="Scan"
        description="Capture one clear view of your product. Scanning will be enabled in a later phase."
      />

      <View style={styles.scannerPlaceholder}>
        <View style={styles.cornerTopLeft} />
        <View style={styles.cornerTopRight} />
        <View style={styles.cornerBottomLeft} />
        <View style={styles.cornerBottomRight} />
        <View style={styles.iconContainer}>
          <AppIcon
            android="photo_camera"
            color={colors.brand.primary}
            ios="camera.fill"
            size={34}
          />
        </View>
        <Text style={styles.placeholderTitle}>Scanner coming next</Text>
        <Text style={styles.placeholderBody}>
          Camera, barcode, and OCR access are intentionally not connected in Phase 1.
        </Text>
      </View>

      <View style={styles.identifierList}>
        <Text style={styles.sectionTitle}>Recall will look for</Text>
        {identifiers.map((identifier) => (
          <View key={identifier} style={styles.identifierRow}>
            <AppIcon android="check" color={colors.semantic.safe} ios="checkmark" size={18} />
            <Text style={styles.identifierText}>{identifier}</Text>
          </View>
        ))}
      </View>
    </Screen>
  );
}

const cornerBase = {
  borderColor: colors.brand.primary,
  height: 28,
  position: 'absolute' as const,
  width: 28,
};

const styles = StyleSheet.create({
  scannerPlaceholder: {
    alignItems: 'center',
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
    justifyContent: 'center',
    minHeight: 300,
    padding: spacing.xl,
  },
  cornerTopLeft: {
    ...cornerBase,
    borderLeftWidth: 3,
    borderTopWidth: 3,
    left: spacing.lg,
    top: spacing.lg,
  },
  cornerTopRight: {
    ...cornerBase,
    borderRightWidth: 3,
    borderTopWidth: 3,
    right: spacing.lg,
    top: spacing.lg,
  },
  cornerBottomLeft: {
    ...cornerBase,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    bottom: spacing.lg,
    left: spacing.lg,
  },
  cornerBottomRight: {
    ...cornerBase,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    bottom: spacing.lg,
    right: spacing.lg,
  },
  iconContainer: {
    alignItems: 'center',
    backgroundColor: colors.brand.soft,
    borderRadius: radius.pill,
    height: 72,
    justifyContent: 'center',
    marginBottom: spacing.xs,
    width: 72,
  },
  placeholderTitle: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
    textAlign: 'center',
  },
  placeholderBody: {
    color: colors.text.secondary,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
    maxWidth: 340,
    textAlign: 'center',
  },
  identifierList: {
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
    marginBottom: spacing.xs,
  },
  identifierRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  identifierText: {
    color: colors.text.secondary,
    flex: 1,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
});
