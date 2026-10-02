import type { ProductMonitoringStatus } from '@/src/domain';

export interface ProductMonitoringRepository {
  /** Asks the server to check one owned product now. Never affects whether it is saved. */
  requestCheck(ownedProductId: string): Promise<ProductMonitoringStatus>;
  listForCurrentUser(
    ownedProductIds?: readonly string[],
  ): Promise<readonly ProductMonitoringStatus[]>;
}
