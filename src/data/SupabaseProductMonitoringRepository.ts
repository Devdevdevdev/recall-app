import type { ProductMonitoringStatus } from '@/src/domain';
import { requireSupabaseClient } from '@/src/services/supabase';

import type { ProductMonitoringRepository } from './ProductMonitoringRepository';
import {
  fromCheckOwnedProductResponse,
  toProductMonitoringStatus,
  type CheckOwnedProductResponse,
  type ProductMonitoringRow,
} from './productMonitoringMappers';

/** The session JWT authorizes the request; the server verifies product ownership. */
export class SupabaseProductMonitoringRepository implements ProductMonitoringRepository {
  async requestCheck(ownedProductId: string): Promise<ProductMonitoringStatus> {
    const { data, error } =
      await requireSupabaseClient().functions.invoke<CheckOwnedProductResponse>(
        'check-owned-product',
        { body: { ownedProductId } },
      );
    if (error || !data) throw error ?? new Error('Product check is unavailable.');
    return fromCheckOwnedProductResponse(ownedProductId, data);
  }

  async listForCurrentUser(
    ownedProductIds?: readonly string[],
  ): Promise<readonly ProductMonitoringStatus[]> {
    const { data, error } = await requireSupabaseClient().rpc('get_my_product_monitoring_states', {
      p_owned_product_ids: ownedProductIds?.length ? [...ownedProductIds] : null,
    });
    if (error) throw error;
    return ((data ?? []) as ProductMonitoringRow[]).map(toProductMonitoringStatus);
  }
}

export const productMonitoringRepository: ProductMonitoringRepository =
  new SupabaseProductMonitoringRepository();
