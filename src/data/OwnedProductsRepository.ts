import type { OwnedProduct } from '@/src/domain';

export interface OwnedProductsRepository {
  findById(id: string): Promise<OwnedProduct | null>;
  listForCurrentUser(): Promise<readonly OwnedProduct[]>;
}
