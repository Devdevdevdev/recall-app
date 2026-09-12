import { useCallback, useRef, useState, type ReactNode } from 'react';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router, useFocusEffect, type Href } from 'expo-router';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/src/components/ui/AppIcon';
import { Screen } from '@/src/components/ui/Screen';
import { ScreenHeader } from '@/src/components/ui/ScreenHeader';
import {
  productBarcodeFormats,
  toScannedBarcode,
  type ProductBarcodeFormat,
  type ScannedBarcode,
} from '@/src/domain';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

type ScannerState = 'scanning' | 'detected' | 'error';

const barcodeTypeLabels: Record<ProductBarcodeFormat, string> = {
  ean13: 'EAN-13',
  ean8: 'EAN-8',
  upc_a: 'UPC-A',
  upc_e: 'UPC-E',
  itf14: 'ITF-14',
  code128: 'Code 128',
};

function ActionButton({
  label,
  onPress,
  secondary = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        secondary && styles.secondaryAction,
        pressed && styles.pressed,
      ]}>
      <Text style={[styles.actionLabel, secondary && styles.secondaryActionLabel]}>{label}</Text>
    </Pressable>
  );
}

export function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [isFocused, setIsFocused] = useState(false);
  const [scannerState, setScannerState] = useState<ScannerState>('scanning');
  const [detectedBarcode, setDetectedBarcode] = useState<ScannedBarcode | null>(null);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const scanLocked = useRef(false);

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );

  const scanAgain = () => {
    scanLocked.current = false;
    setDetectedBarcode(null);
    setCameraError(null);
    setScannerState('scanning');
  };

  const enterManually = () => router.push('/products/new' as Href);

  const handleBarcodeScanned = (event: BarcodeScanningResult) => {
    if (scannerState !== 'scanning' || scanLocked.current) {
      return;
    }

    const format = event.type as ProductBarcodeFormat;
    if (!productBarcodeFormats.includes(format)) {
      return;
    }

    // The synchronous lock and state transition prevent duplicate native callbacks from stacking.
    scanLocked.current = true;
    setScannerState('detected');
    setTorchEnabled(false);
    setDetectedBarcode(toScannedBarcode(format, event.raw ?? event.data, event.data));
  };

  const useBarcode = () => {
    if (!detectedBarcode?.gtin) {
      return;
    }

    router.push({
      pathname: '/products/new',
      params: { gtin: detectedBarcode.gtin, source: 'barcode_scan' },
    });
  };

  const requestCameraAccess = () => {
    void requestPermission().catch(() => {
      setCameraError('Camera access could not be requested. You can still add a product manually.');
      setScannerState('error');
    });
  };

  const cameraIsActive = permission?.granted && isFocused && scannerState === 'scanning';

  return (
    <Screen contentContainerStyle={styles.content}>
      <ScreenHeader
        title="Scan"
        description="Scan a product barcode, then confirm its details yourself."
      />

      {!permission ? (
        <StateCard
          title="Preparing camera"
          message="Checking whether camera access is available."
        />
      ) : !permission.granted ? (
        <StateCard
          title="Camera access is needed"
          message="Recall uses your camera only to scan product barcodes. You can always enter a product manually instead."
          actions={
            permission.canAskAgain ? (
              <ActionButton label="Allow camera access" onPress={requestCameraAccess} />
            ) : (
              <ActionButton label="Open app settings" onPress={() => void Linking.openSettings()} />
            )
          }
        />
      ) : scannerState === 'detected' && detectedBarcode ? (
        <ConfirmationCard
          barcode={detectedBarcode}
          onScanAgain={scanAgain}
          onUseBarcode={useBarcode}
        />
      ) : scannerState === 'error' ? (
        <StateCard
          title="Camera unavailable"
          message={
            cameraError ??
            'The camera preview could not start. Try again or add the product manually.'
          }
          actions={<ActionButton label="Try camera again" onPress={scanAgain} />}
        />
      ) : (
        <View style={styles.cameraCard}>
          {cameraIsActive ? (
            <CameraView
              barcodeScannerSettings={{ barcodeTypes: [...productBarcodeFormats] }}
              enableTorch={torchEnabled}
              facing="back"
              onBarcodeScanned={handleBarcodeScanned}
              onMountError={({ message }) => {
                setCameraError(message);
                setScannerState('error');
              }}
              style={styles.camera}
            />
          ) : null}
          <View accessible={false} pointerEvents="none" style={styles.guide}>
            <View style={[styles.corner, styles.topLeft]} />
            <View style={[styles.corner, styles.topRight]} />
            <View style={[styles.corner, styles.bottomLeft]} />
            <View style={[styles.corner, styles.bottomRight]} />
          </View>
          <View style={styles.cameraFooter}>
            <Text style={styles.cameraInstruction}>
              Position the product barcode inside the frame.
            </Text>
            <Pressable
              accessibilityLabel={torchEnabled ? 'Turn torch off' : 'Turn torch on'}
              accessibilityRole="switch"
              accessibilityState={{ checked: torchEnabled }}
              onPress={() => setTorchEnabled((current) => !current)}
              style={({ pressed }) => [styles.torchButton, pressed && styles.pressed]}>
              <AppIcon
                android="flash_on"
                color={colors.text.inverse}
                ios="flashlight.on.fill"
                size={20}
              />
              <Text style={styles.torchLabel}>{torchEnabled ? 'Torch on' : 'Torch off'}</Text>
            </Pressable>
          </View>
        </View>
      )}

      <ActionButton label="Enter product manually" onPress={enterManually} secondary />
      <Text style={styles.privacyNote}>
        Recall does not take, save, or upload photos. Only a barcode you confirm is passed to the
        product form.
      </Text>
    </Screen>
  );
}

function StateCard({
  actions,
  message,
  title,
}: {
  actions?: ReactNode;
  message: string;
  title: string;
}) {
  return (
    <View style={styles.stateCard}>
      <Text accessibilityRole="header" style={styles.stateTitle}>
        {title}
      </Text>
      <Text accessibilityLiveRegion="polite" style={styles.stateMessage}>
        {message}
      </Text>
      {actions}
    </View>
  );
}

function ConfirmationCard({
  barcode,
  onScanAgain,
  onUseBarcode,
}: {
  barcode: ScannedBarcode;
  onScanAgain: () => void;
  onUseBarcode: () => void;
}) {
  const label = barcodeTypeLabels[barcode.format];

  return (
    <View style={styles.stateCard}>
      <Text accessibilityRole="header" style={styles.stateTitle}>
        Barcode detected
      </Text>
      <Text style={styles.format}>{label}</Text>
      <Text selectable style={styles.barcodeValue}>
        {barcode.normalizedValue ?? barcode.rawValue}
      </Text>
      {barcode.isValidGtin ? (
        <>
          <Text style={styles.stateMessage}>
            This barcode has a valid GTIN check digit. Recall has not identified the product yet.
          </Text>
          <ActionButton label="Use this barcode" onPress={onUseBarcode} />
        </>
      ) : (
        <Text accessibilityLiveRegion="polite" style={styles.invalidMessage}>
          We detected a barcode, but it does not appear to be a valid GTIN. Scan again or enter the
          product manually.
        </Text>
      )}
      <ActionButton label="Scan again" onPress={onScanAgain} secondary />
    </View>
  );
}

const cornerBase = {
  borderColor: colors.brand.primary,
  height: 28,
  position: 'absolute' as const,
  width: 28,
};

const styles = StyleSheet.create({
  content: { gap: spacing.lg },
  cameraCard: {
    backgroundColor: colors.text.primary,
    borderRadius: radius.lg,
    minHeight: 360,
    overflow: 'hidden',
    position: 'relative',
  },
  camera: { ...StyleSheet.absoluteFill },
  guide: { ...StyleSheet.absoluteFill },
  corner: { ...cornerBase },
  topLeft: { borderLeftWidth: 3, borderTopWidth: 3, left: spacing.xl, top: spacing.xl },
  topRight: { borderRightWidth: 3, borderTopWidth: 3, right: spacing.xl, top: spacing.xl },
  bottomLeft: { borderBottomWidth: 3, borderLeftWidth: 3, bottom: 92, left: spacing.xl },
  bottomRight: { borderBottomWidth: 3, borderRightWidth: 3, bottom: 92, right: spacing.xl },
  cameraFooter: {
    alignItems: 'center',
    backgroundColor: 'rgba(16, 35, 31, 0.74)',
    bottom: 0,
    gap: spacing.sm,
    left: 0,
    padding: spacing.md,
    position: 'absolute',
    right: 0,
  },
  cameraInstruction: {
    color: colors.text.inverse,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
    textAlign: 'center',
  },
  torchButton: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs, padding: spacing.xs },
  torchLabel: {
    color: colors.text.inverse,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
  },
  stateCard: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  stateTitle: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
  },
  stateMessage: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  invalidMessage: {
    color: colors.semantic.danger,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  format: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.bold,
    letterSpacing: 0.5,
  },
  barcodeValue: {
    color: colors.text.primary,
    fontSize: typography.size.title,
    fontWeight: typography.weight.bold,
    letterSpacing: 0.6,
    lineHeight: typography.lineHeight.title,
  },
  action: {
    alignItems: 'center',
    backgroundColor: colors.brand.primary,
    borderRadius: radius.md,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
  secondaryAction: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.brand.primary,
    borderWidth: 1,
  },
  actionLabel: {
    color: colors.text.inverse,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
  },
  secondaryActionLabel: { color: colors.brand.primary },
  pressed: { opacity: 0.78 },
  privacyNote: {
    color: colors.text.muted,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
    textAlign: 'center',
  },
});
