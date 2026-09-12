import type { OwnedProduct, OwnedProductInput } from '@/src/domain';

export type OwnedProductRow = {
  id: string;
  user_id: string;
  brand: string | null;
  product_name: string | null;
  category: string | null;
  gtin: string | null;
  model_number: string | null;
  serial_number: string | null;
  lot_number: string | null;
  purchase_date: string | null;
  image_path: string | null;
  identification_method: string | null;
  identification_confidence: number | string | null;
  created_at: string;
  updated_at: string;
};

export type OwnedProductWriteRow = {
  brand: string | null;
  product_name: string;
  category: string | null;
  gtin: string | null;
  model_number: string | null;
  serial_number: string | null;
  lot_number: string | null;
  purchase_date: string | null;
};

export function toOwnedProduct(row: OwnedProductRow): OwnedProduct {
  return {
    id: row.id,
    userId: row.user_id,
    brand: row.brand,
    productName: row.product_name,
    category: row.category,
    gtin: row.gtin,
    modelNumber: row.model_number,
    serialNumber: row.serial_number,
    lotNumber: row.lot_number,
    purchaseDate: row.purchase_date,
    imagePath: row.image_path,
    identificationMethod: row.identification_method,
    identificationConfidence:
      row.identification_confidence === null ? null : Number(row.identification_confidence),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toOwnedProductWriteRow(input: OwnedProductInput): OwnedProductWriteRow {
  return {
    brand: input.brand,
    product_name: input.productName,
    category: input.category,
    gtin: input.gtin,
    model_number: input.modelNumber,
    serial_number: input.serialNumber,
    lot_number: input.lotNumber,
    purchase_date: input.purchaseDate,
  };
}
