import type { RecallMatch } from '@/src/domain';

export interface RecallMatchesRepository {
  findForProductAndNotice(
    ownedProductId: string,
    recallNoticeId: string,
  ): Promise<RecallMatch | null>;
  listForOwnedProduct(ownedProductId: string): Promise<readonly RecallMatch[]>;
}
