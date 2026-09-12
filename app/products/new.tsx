import { useLocalSearchParams } from 'expo-router';

import { validateGtin } from '@/src/domain';
import { NewProductScreen } from '@/src/features/products/ProductScreens';

export default function NewProductRoute() {
  const { gtin, source } = useLocalSearchParams<{ gtin?: string; source?: string }>();
  const validation = typeof gtin === 'string' ? validateGtin(gtin) : null;
  const wasScanned = source === 'barcode_scan' && validation?.isValid === true;
  const scannedGtin = wasScanned ? validation.normalizedValue : null;

  return <NewProductScreen scannedGtin={scannedGtin} wasScanned={wasScanned} />;
}
