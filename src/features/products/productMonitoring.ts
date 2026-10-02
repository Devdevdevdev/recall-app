import type {
  OwnedProduct,
  ProductMonitoringState,
  ProductMonitoringStatus,
} from '@/src/domain/types';

/** Temporary Phase 17.7a labels; the full experience is Phase 17.5. */
export function monitoringLabel(state: ProductMonitoringState): string {
  switch (state) {
    case 'pending_check':
      return 'Saved — checking known recalls…';
    case 'checking':
      return 'Checking known recalls…';
    case 'monitored_no_known_recall':
      return 'Monitored — no matching recall found in the sources currently monitored';
    case 'possible_match_needs_verification':
      return 'Possible match with an official recall — verification needed';
    case 'recall_detected':
      return 'Recall detected';
    case 'check_failed_retrying':
      return 'Check pending — retrying automatically';
    case 'check_failed':
      return 'Check unavailable for now — retrying later';
  }
}

export type MonitoringTone = 'neutral' | 'safe' | 'warning' | 'danger';

export function monitoringTone(state: ProductMonitoringState): MonitoringTone {
  if (state === 'recall_detected') return 'danger';
  if (state === 'possible_match_needs_verification') return 'warning';
  if (state === 'monitored_no_known_recall') return 'safe';
  return 'neutral';
}

export const MAX_RESUMED_CHECKS = 3;

/** Products whose check should be resumed on inventory focus, at most three. */
export function productsToResume(
  statuses: readonly ProductMonitoringStatus[],
  max = MAX_RESUMED_CHECKS,
): readonly string[] {
  return statuses
    .filter((item) => item.state === 'pending_check' || item.state === 'check_failed_retrying')
    .slice(0, max)
    .map((item) => item.ownedProductId);
}

/**
 * Mirrors the server arming trigger columns (Phase 17.7a-1 migration). The server stays
 * authoritative; this only decides whether to request an immediate check after an edit.
 */
export function hasMatchingAttributeChange(before: OwnedProduct, after: OwnedProduct): boolean {
  return (
    before.brand !== after.brand ||
    before.productName !== after.productName ||
    before.gtin !== after.gtin ||
    before.modelNumber !== after.modelNumber ||
    before.serialNumber !== after.serialNumber ||
    before.lotNumber !== after.lotNumber ||
    before.purchaseCountryCode !== after.purchaseCountryCode ||
    JSON.stringify(sortedAttributes(before)) !== JSON.stringify(sortedAttributes(after))
  );
}

function sortedAttributes(product: OwnedProduct): [string, string | undefined][] {
  return Object.entries(product.safetyAttributes ?? {}).sort(([a], [b]) => a.localeCompare(b));
}
