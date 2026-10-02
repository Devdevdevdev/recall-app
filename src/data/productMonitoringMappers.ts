import {
  PRODUCT_MONITORING_STATES,
  type ProductMonitoringState,
  type ProductMonitoringStatus,
} from '../domain/types.ts';

export type ProductMonitoringRow = {
  owned_product_id: string;
  state: string;
  checked_at: string | null;
  possible_matches: number;
  confirmed_alerts: number;
  retrying: boolean;
};

export type CheckOwnedProductResponse = {
  state: string;
  checkedAt: string | null;
  possibleMatches: number;
  confirmedAlerts: number;
  retrying: boolean;
};

function monitoringState(value: string): ProductMonitoringState {
  if (!(PRODUCT_MONITORING_STATES as readonly string[]).includes(value)) {
    throw new Error('Unknown product monitoring state.');
  }
  return value as ProductMonitoringState;
}

function count(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

/** Maps get_my_product_monitoring_states rows; unknown states are refused, not guessed. */
export function toProductMonitoringStatus(row: ProductMonitoringRow): ProductMonitoringStatus {
  return {
    ownedProductId: row.owned_product_id,
    state: monitoringState(row.state),
    checkedAt: row.checked_at ?? null,
    possibleMatches: count(row.possible_matches),
    confirmedAlerts: count(row.confirmed_alerts),
    retrying: row.retrying === true,
  };
}

/** Maps the bounded check-owned-product response for one product. */
export function fromCheckOwnedProductResponse(
  ownedProductId: string,
  body: CheckOwnedProductResponse,
): ProductMonitoringStatus {
  return toProductMonitoringStatus({
    owned_product_id: ownedProductId,
    state: body.state,
    checked_at: body.checkedAt,
    possible_matches: body.possibleMatches,
    confirmed_alerts: body.confirmedAlerts,
    retrying: body.retrying,
  });
}
