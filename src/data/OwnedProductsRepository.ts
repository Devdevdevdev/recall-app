import type { OwnedProduct, OwnedProductInput } from '@/src/domain';

export interface OwnedProductsRepository {
  create(input: OwnedProductInput): Promise<OwnedProduct>;
  delete(id: string): Promise<void>;
  getById(id: string): Promise<OwnedProduct | null>;
  getCurrentUserCount(): Promise<number>;
  listForCurrentUser(): Promise<readonly OwnedProduct[]>;
  update(id: string, input: OwnedProductInput): Promise<OwnedProduct>;
}
