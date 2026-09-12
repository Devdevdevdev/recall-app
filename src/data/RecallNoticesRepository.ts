import type { OwnedProduct, RecallNotice, RecallScope } from '@/src/domain';

export type RecallNoticeCandidate = {
  notice: RecallNotice;
  scopes: readonly RecallScope[];
};

export interface RecallNoticesRepository {
  findById(id: string): Promise<RecallNotice | null>;
  findCandidates(product: OwnedProduct): Promise<readonly RecallNoticeCandidate[]>;
}
