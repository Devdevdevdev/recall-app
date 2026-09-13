import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router, useFocusEffect, type Href } from 'expo-router';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/src/components/ui/AppIcon';
import { Screen } from '@/src/components/ui/Screen';
import { ScreenHeader } from '@/src/components/ui/ScreenHeader';
import { colors, radius, spacing, typography } from '@/src/design/tokens';
import {
  parseProductLabel,
  productBarcodeFormats,
  toScannedBarcode,
  type ProductBarcodeFormat,
  type ProductLabelCandidates,
  type ScannedBarcode,
} from '@/src/domain';
import {
  deleteTemporaryImage,
  recognizeTextFromImage,
  type OcrTextResult,
} from '@/src/services/ocr';

type ScanMode = 'barcode' | 'label';
type BarcodeScannerState = 'scanning' | 'detected' | 'error';
type LabelScannerState =
  | 'idle'
  | 'camera_ready'
  | 'capturing'
  | 'recognizing_text'
  | 'reviewing'
  | 'no_text_found'
  | 'error';

type LabelReview = {
  candidates: ProductLabelCandidates;
  result: OcrTextResult;
};

const barcodeTypeLabels: Record<ProductBarcodeFormat, string> = {
  ean13: 'EAN-13',
  ean8: 'EAN-8',
  upc_a: 'UPC-A',
  upc_e: 'UPC-E',
  itf14: 'ITF-14',
  code128: 'Code 128',
};

function ActionButton({
  disabled = false,
  label,
  onPress,
  secondary = false,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        secondary && styles.secondaryAction,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}>
      <Text style={[styles.actionLabel, secondary && styles.secondaryActionLabel]}>{label}</Text>
    </Pressable>
  );
}

export function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [isFocused, setIsFocused] = useState(false);
  const [mode, setMode] = useState<ScanMode>('barcode');
  const [barcodeState, setBarcodeState] = useState<BarcodeScannerState>('scanning');
  const [detectedBarcode, setDetectedBarcode] = useState<ScannedBarcode | null>(null);
  const [labelState, setLabelState] = useState<LabelScannerState>('idle');
  const [labelReview, setLabelReview] = useState<LabelReview | null>(null);
  const [showRecognizedText, setShowRecognizedText] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const cameraRef = useRef<CameraView | null>(null);
  const scanLocked = useRef(false);
  const captureLocked = useRef(false);
  const operationId = useRef(0);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      operationId.current += 1;
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => {
        operationId.current += 1;
        setIsFocused(false);
        setTorchEnabled(false);
        setLabelReview(null);
        setShowRecognizedText(false);
        setLabelState('idle');
      };
    }, []),
  );

  const scanAgain = () => {
    scanLocked.current = false;
    setDetectedBarcode(null);
    setCameraError(null);
    setBarcodeState('scanning');
  };

  const resetLabelScan = () => {
    operationId.current += 1;
    setLabelReview(null);
    setShowRecognizedText(false);
    setCameraError(null);
    setLabelState('idle');
  };

  const chooseMode = (nextMode: ScanMode) => {
    if (nextMode === mode) {
      return;
    }

    setMode(nextMode);
    setTorchEnabled(false);
    if (nextMode === 'barcode') {
      scanAgain();
    } else {
      resetLabelScan();
    }
  };

  const enterManually = () => router.push('/products/new' as Href);

  const handleBarcodeScanned = (event: BarcodeScanningResult) => {
    if (barcodeState !== 'scanning' || scanLocked.current) {
      return;
    }

    const format = event.type as ProductBarcodeFormat;
    if (!productBarcodeFormats.includes(format)) {
      return;
    }

    // The synchronous lock and state transition prevent duplicate native callbacks from stacking.
    scanLocked.current = true;
    setBarcodeState('detected');
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

  const captureLabel = async () => {
    if (labelState !== 'camera_ready' || captureLocked.current || !cameraRef.current) {
      return;
    }

    captureLocked.current = true;
    const currentOperation = operationId.current + 1;
    operationId.current = currentOperation;
    let imageUri: string | null = null;
    setLabelState('capturing');

    try {
      const picture = await cameraRef.current.takePictureAsync({
        base64: false,
        exif: false,
        quality: 0.85,
        skipProcessing: false,
      });
      imageUri = picture.uri;

      if (mounted.current && operationId.current === currentOperation) {
        setLabelState('recognizing_text');
      }

      const result = await recognizeTextFromImage(imageUri);
      if (!mounted.current || operationId.current !== currentOperation) {
        return;
      }

      if (result.text.trim().length === 0) {
        setLabelReview(null);
        setLabelState('no_text_found');
        return;
      }

      setLabelReview({ result, candidates: parseProductLabel(result.text) });
      setLabelState('reviewing');
    } catch {
      if (mounted.current && operationId.current === currentOperation) {
        setCameraError(
          'Recall could not read this label. Try another photo or enter the product manually.',
        );
        setLabelState('error');
      }
    } finally {
      if (imageUri) {
        await deleteTemporaryImage(imageUri);
      }
      captureLocked.current = false;
    }
  };

  const continueWithLabel = () => {
    if (!labelReview) {
      return;
    }

    const { lotNumber, modelNumber, serialNumber } = labelReview.candidates;
    if (!lotNumber && !modelNumber && !serialNumber) {
      enterManually();
      return;
    }

    router.push({
      pathname: '/products/new',
      params: {
        source: 'ocr_assisted',
        ...(modelNumber ? { modelNumber } : {}),
        ...(serialNumber ? { serialNumber } : {}),
        ...(lotNumber ? { lotNumber } : {}),
      },
    });
  };

  const requestCameraAccess = () => {
    void requestPermission().catch(() => {
      setCameraError('Camera access could not be requested. You can still add a product manually.');
      if (mode === 'barcode') {
        setBarcodeState('error');
      } else {
        setLabelState('error');
      }
    });
  };

  const labelCameraVisible =
    mode === 'label' && ['idle', 'camera_ready', 'capturing'].includes(labelState);
  const cameraIsActive =
    permission?.granted &&
    isFocused &&
    ((mode === 'barcode' && barcodeState === 'scanning') || labelCameraVisible);

  let experience: ReactNode;
  if (mode === 'label' && Platform.OS === 'web') {
    experience = (
      <StateCard
        title="Use the mobile app"
        message="Product label OCR is available in the Android and iOS app. You can still enter this product manually."
      />
    );
  } else if (!permission) {
    experience = (
      <StateCard title="Preparing camera" message="Checking whether camera access is available." />
    );
  } else if (!permission.granted) {
    experience = (
      <StateCard
        title="Camera access is needed"
        message="Recall uses your camera to scan barcodes or photograph a label for on-device text recognition. You can always enter a product manually instead."
        actions={
          permission.canAskAgain ? (
            <ActionButton label="Allow camera access" onPress={requestCameraAccess} />
          ) : (
            <ActionButton label="Open app settings" onPress={() => void Linking.openSettings()} />
          )
        }
      />
    );
  } else if (mode === 'barcode' && barcodeState === 'detected' && detectedBarcode) {
    experience = (
      <ConfirmationCard
        barcode={detectedBarcode}
        onReadProductLabel={() => chooseMode('label')}
        onScanAgain={scanAgain}
        onUseBarcode={useBarcode}
      />
    );
  } else if (mode === 'barcode' && barcodeState === 'error') {
    experience = (
      <StateCard
        title="Camera unavailable"
        message={
          cameraError ??
          'The camera preview could not start. Try again or add the product manually.'
        }
        actions={<ActionButton label="Try camera again" onPress={scanAgain} />}
      />
    );
  } else if (mode === 'label' && labelState === 'recognizing_text') {
    experience = (
      <StateCard
        title="Reading label"
        message="Recognizing visible text on this device. The photo is not uploaded."
      />
    );
  } else if (mode === 'label' && labelState === 'reviewing' && labelReview) {
    experience = (
      <LabelReviewCard
        candidates={labelReview.candidates}
        onContinue={continueWithLabel}
        onRetake={resetLabelScan}
        onToggleText={() => setShowRecognizedText((current) => !current)}
        recognizedText={labelReview.result.text}
        showRecognizedText={showRecognizedText}
      />
    );
  } else if (mode === 'label' && labelState === 'no_text_found') {
    experience = (
      <StateCard
        title="No readable text found"
        message="Move closer, improve the lighting, keep the label flat, and avoid glare."
        actions={
          <View style={styles.cardActions}>
            <ActionButton label="Try again" onPress={resetLabelScan} />
            <ActionButton label="Enter product manually" onPress={enterManually} secondary />
          </View>
        }
      />
    );
  } else if (mode === 'label' && labelState === 'error') {
    experience = (
      <StateCard
        title="Label could not be read"
        message={cameraError ?? 'Try another photo or enter the product manually.'}
        actions={
          <View style={styles.cardActions}>
            <ActionButton label="Retake photo" onPress={resetLabelScan} />
            <ActionButton label="Enter product manually" onPress={enterManually} secondary />
          </View>
        }
      />
    );
  } else {
    experience = (
      <View style={styles.cameraCard}>
        {cameraIsActive ? (
          <CameraView
            ref={cameraRef}
            barcodeScannerSettings={
              mode === 'barcode' ? { barcodeTypes: [...productBarcodeFormats] } : undefined
            }
            enableTorch={torchEnabled}
            facing="back"
            onBarcodeScanned={mode === 'barcode' ? handleBarcodeScanned : undefined}
            onCameraReady={() => {
              if (mode === 'label') {
                setLabelState((current) => (current === 'idle' ? 'camera_ready' : current));
              }
            }}
            onMountError={({ message }) => {
              setCameraError(message);
              if (mode === 'barcode') {
                setBarcodeState('error');
              } else {
                setLabelState('error');
              }
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
            {mode === 'barcode'
              ? 'Position the product barcode inside the frame.'
              : 'Photograph the label showing the model, serial number, or lot number.'}
          </Text>
          {mode === 'label' ? (
            <Pressable
              accessibilityRole="button"
              disabled={labelState !== 'camera_ready'}
              onPress={() => void captureLabel()}
              style={({ pressed }) => [
                styles.captureButton,
                pressed && styles.pressed,
                labelState !== 'camera_ready' && styles.disabled,
              ]}>
              <Text style={styles.captureLabel}>
                {labelState === 'capturing' ? 'Capturing…' : 'Capture label'}
              </Text>
            </Pressable>
          ) : null}
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
    );
  }

  return (
    <Screen contentContainerStyle={styles.content}>
      <ScreenHeader
        title="Scan"
        description="Capture a barcode or read identifiers printed on a product label."
      />

      <View accessibilityRole="tablist" style={styles.modeSelector}>
        <ModeButton
          active={mode === 'barcode'}
          label="Scan barcode"
          onPress={() => chooseMode('barcode')}
        />
        <ModeButton
          active={mode === 'label'}
          label="Read product label"
          onPress={() => chooseMode('label')}
        />
      </View>

      {experience}

      <ActionButton label="Enter product manually" onPress={enterManually} secondary />
      <Text style={styles.privacyNote}>
        {mode === 'barcode'
          ? 'Recall does not take or upload photos in barcode mode. Only a barcode you confirm is passed to the product form.'
          : 'Label photos stay in temporary app cache, are read on device, and are deleted on best effort after recognition. Only text you confirm can reach the product form.'}
      </Text>
    </Screen>
  );
}

function ModeButton({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.modeButton,
        active && styles.modeButtonActive,
        pressed && styles.pressed,
      ]}>
      <Text style={[styles.modeLabel, active && styles.modeLabelActive]}>{label}</Text>
    </Pressable>
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
  onReadProductLabel,
  onScanAgain,
  onUseBarcode,
}: {
  barcode: ScannedBarcode;
  onReadProductLabel: () => void;
  onScanAgain: () => void;
  onUseBarcode: () => void;
}) {
  const label = barcodeTypeLabels[barcode.format];

  return (
    <View style={styles.stateCard}>
      <Text accessibilityRole="header" style={styles.stateTitle}>
        {barcode.classification === 'valid_gtin'
          ? 'Product barcode detected'
          : 'Product code detected'}
      </Text>
      <Text style={styles.format}>{label}</Text>
      <Text selectable style={styles.barcodeValue}>
        {barcode.normalizedValue ?? barcode.rawValue}
      </Text>
      {barcode.classification === 'valid_gtin' ? (
        <>
          <Text style={styles.stateMessage}>
            This barcode has a valid GTIN check digit. Recall has not identified the product yet.
          </Text>
          <ActionButton label="Use this barcode" onPress={onUseBarcode} />
        </>
      ) : barcode.classification === 'non_gtin_product_code' ? (
        <>
          <Text accessibilityLiveRegion="polite" style={styles.stateMessage}>
            This code is not a standard GTIN. It may be another manufacturer identifier, such as a
            model, serial, or logistics code.
          </Text>
          <ActionButton label="Read product label" onPress={onReadProductLabel} />
        </>
      ) : (
        <Text accessibilityLiveRegion="polite" style={styles.invalidMessage}>
          This barcode data is not a supported product identifier. Scan again or enter the product
          manually.
        </Text>
      )}
      <ActionButton label="Scan again" onPress={onScanAgain} secondary />
    </View>
  );
}

function CandidateRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.candidateRow}>
      <Text style={styles.candidateLabel}>{label}</Text>
      <Text selectable style={styles.candidateValue}>
        {value}
      </Text>
    </View>
  );
}

function LabelReviewCard({
  candidates,
  onContinue,
  onRetake,
  onToggleText,
  recognizedText,
  showRecognizedText,
}: {
  candidates: ProductLabelCandidates;
  onContinue: () => void;
  onRetake: () => void;
  onToggleText: () => void;
  recognizedText: string;
  showRecognizedText: boolean;
}) {
  const hasPersistedCandidate = Boolean(
    candidates.modelNumber || candidates.serialNumber || candidates.lotNumber,
  );

  return (
    <View style={styles.stateCard}>
      <Text accessibilityRole="header" style={styles.stateTitle}>
        Text detected
      </Text>
      {hasPersistedCandidate || candidates.referenceNumber ? (
        <View style={styles.candidateList}>
          {candidates.modelNumber ? (
            <CandidateRow label="Possible model" value={candidates.modelNumber} />
          ) : null}
          {candidates.serialNumber ? (
            <CandidateRow label="Possible serial number" value={candidates.serialNumber} />
          ) : null}
          {candidates.lotNumber ? (
            <CandidateRow label="Possible lot / batch" value={candidates.lotNumber} />
          ) : null}
          {candidates.referenceNumber ? (
            <CandidateRow label="Possible reference" value={candidates.referenceNumber} />
          ) : null}
        </View>
      ) : (
        <Text style={styles.stateMessage}>
          We found text, but couldn&apos;t identify a model, serial number, or lot automatically.
        </Text>
      )}
      <Text style={styles.reviewCaution}>
        These are label-based suggestions, not a confirmed product identity. Check every value.
      </Text>
      {candidates.referenceNumber ? (
        <Text style={styles.referenceNote}>
          Recall has no dedicated reference-number field yet, so this value will not be placed in
          another field.
        </Text>
      ) : null}
      <Pressable accessibilityRole="button" onPress={onToggleText} style={styles.textToggle}>
        <Text style={styles.textToggleLabel}>
          {showRecognizedText ? 'Hide recognized text' : 'Show recognized text'}
        </Text>
      </Pressable>
      {showRecognizedText ? (
        <Text selectable style={styles.recognizedText}>
          {recognizedText}
        </Text>
      ) : null}
      <ActionButton
        label={hasPersistedCandidate ? 'Continue with these details' : 'Continue manually'}
        onPress={onContinue}
      />
      <ActionButton label="Retake photo" onPress={onRetake} secondary />
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
  modeSelector: {
    backgroundColor: colors.surface.sunken,
    borderRadius: radius.pill,
    flexDirection: 'row',
    padding: spacing.xxs,
  },
  modeButton: {
    alignItems: 'center',
    borderRadius: radius.pill,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  modeButtonActive: { backgroundColor: colors.surface.raised },
  modeLabel: {
    color: colors.text.secondary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
    textAlign: 'center',
  },
  modeLabelActive: { color: colors.brand.primary },
  cameraCard: {
    backgroundColor: colors.text.primary,
    borderRadius: radius.lg,
    minHeight: 430,
    overflow: 'hidden',
    position: 'relative',
  },
  camera: { ...StyleSheet.absoluteFill },
  guide: { ...StyleSheet.absoluteFill },
  corner: { ...cornerBase },
  topLeft: { borderLeftWidth: 3, borderTopWidth: 3, left: spacing.xl, top: spacing.xl },
  topRight: { borderRightWidth: 3, borderTopWidth: 3, right: spacing.xl, top: spacing.xl },
  bottomLeft: { borderBottomWidth: 3, borderLeftWidth: 3, bottom: 142, left: spacing.xl },
  bottomRight: { borderBottomWidth: 3, borderRightWidth: 3, bottom: 142, right: spacing.xl },
  cameraFooter: {
    alignItems: 'center',
    backgroundColor: 'rgba(16, 35, 31, 0.78)',
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
  captureButton: {
    alignItems: 'center',
    backgroundColor: colors.surface.raised,
    borderRadius: radius.pill,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: spacing.xl,
  },
  captureLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
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
  cardActions: { gap: spacing.sm },
  candidateList: { gap: spacing.sm },
  candidateRow: {
    backgroundColor: colors.brand.soft,
    borderRadius: radius.md,
    gap: spacing.xxs,
    padding: spacing.md,
  },
  candidateLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.caption,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.caption,
    textTransform: 'uppercase',
  },
  candidateValue: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.lineHeight.body,
  },
  reviewCaution: {
    color: colors.text.secondary,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
  },
  referenceNote: {
    backgroundColor: colors.semantic.warningSoft,
    borderRadius: radius.sm,
    color: colors.semantic.warning,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
    padding: spacing.sm,
  },
  textToggle: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  textToggleLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
  },
  recognizedText: {
    backgroundColor: colors.surface.sunken,
    borderRadius: radius.sm,
    color: colors.text.secondary,
    fontFamily: Platform.select({ android: 'monospace', ios: 'Menlo', web: 'monospace' }),
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
    padding: spacing.md,
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
  disabled: { opacity: 0.55 },
  privacyNote: {
    color: colors.text.muted,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
    textAlign: 'center',
  },
});
