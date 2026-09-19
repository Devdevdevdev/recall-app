import { isSupportedCountryCode } from '../domain/countries.ts';
import type { OwnedProduct, OwnedProductInput } from '../domain/types.ts';

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
  scan_date: string;
  purchase_date: string | null;
  purchase_country_code: string | null;
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
  scan_date: string;
  purchase_date: string | null;
  purchase_country_code: string | null;
};

export function toOwnedProduct(row: OwnedProductRow): OwnedProduct {
  if (row.purchase_country_code !== null && !isSupportedCountryCode(row.purchase_country_code)) {
    throw new Error('Owned product has an unsupported purchase country code.');
  }

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
    scanDate: row.scan_date,
    purchaseDate: row.purchase_date,
    purchaseCountryCode: row.purchase_country_code,
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
    scan_date: input.scanDate,
    purchase_date: input.purchaseDate,
    purchase_country_code: input.purchaseCountryCode,
  };
}
