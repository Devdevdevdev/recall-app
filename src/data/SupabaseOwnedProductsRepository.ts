import type { OwnedProduct, OwnedProductInput } from '@/src/domain';
import { requireSupabaseClient } from '@/src/services/supabase';

import type { OwnedProductsRepository } from './OwnedProductsRepository';
import {
  toOwnedProduct,
  toOwnedProductWriteRow,
  type OwnedProductRow,
} from './ownedProductsMappers';

const ownedProductColumns =
  'id, user_id, brand, product_name, category, gtin, model_number, serial_number, lot_number, scan_date, purchase_date, purchase_country_code, image_path, identification_method, identification_confidence, created_at, updated_at';

type OwnedProductInsertRow = ReturnType<typeof toOwnedProductWriteRow> & {
  user_id: string;
  image_path: null;
  identification_method: 'manual' | 'barcode_scan' | 'ocr_assisted';
  identification_confidence: null;
};

/** Mobile adapter. RLS remains the authority for every returned or changed row. */
export class SupabaseOwnedProductsRepository implements OwnedProductsRepository {
  async getCurrentUserCount(): Promise<number> {
    const { count, error } = await requireSupabaseClient()
      .from('owned_products')
      .select('id', { count: 'exact', head: true });

    if (error) throw error;
    return count ?? 0;
  }

  async listForCurrentUser(): Promise<readonly OwnedProduct[]> {
    const { data, error } = await requireSupabaseClient()
      .from('owned_products')
      .select(ownedProductColumns)
      .order('updated_at', { ascending: false });

    if (error) {
      throw error;
    }

    return (data as OwnedProductRow[]).map(toOwnedProduct);
  }

  async getById(id: string): Promise<OwnedProduct | null> {
    const { data, error } = await requireSupabaseClient()
      .from('owned_products')
      .select(ownedProductColumns)
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? toOwnedProduct(data as OwnedProductRow) : null;
  }

  async create(input: OwnedProductInput): Promise<OwnedProduct> {
    const client = requireSupabaseClient();
    const { data: userData, error: userError } = await client.auth.getUser();

    if (userError) {
      throw userError;
    }

    if (!userData.user) {
      throw new Error('An authenticated user is required to create a product.');
    }

    const insertRow: OwnedProductInsertRow = {
      ...toOwnedProductWriteRow(input),
      user_id: userData.user.id,
      image_path: null,
      identification_method: input.identificationMethod ?? 'manual',
      identification_confidence: null,
    };
    const { data, error } = await client
      .from('owned_products')
      .insert(insertRow)
      .select(ownedProductColumns)
      .single();

    if (error) {
      throw error;
    }

    return toOwnedProduct(data as OwnedProductRow);
  }

  async update(id: string, input: OwnedProductInput): Promise<OwnedProduct> {
    const { data, error } = await requireSupabaseClient()
      .from('owned_products')
      .update(toOwnedProductWriteRow(input))
      .eq('id', id)
      .select(ownedProductColumns)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new Error('The product is no longer available.');
    }

    return toOwnedProduct(data as OwnedProductRow);
  }

  async delete(id: string): Promise<void> {
    const { error } = await requireSupabaseClient().from('owned_products').delete().eq('id', id);

    if (error) {
      throw error;
    }
  }
}

export const ownedProductsRepository: OwnedProductsRepository =
  new SupabaseOwnedProductsRepository();
