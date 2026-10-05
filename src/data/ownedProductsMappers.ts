import { canonicalGtin14 } from '../../supabase/functions/_shared/matching/gtin.ts';
import { isGtinCarrierSymbology, toScannedBarcode } from '../domain/barcode.ts';
import { isSupportedCountryCode } from '../domain/countries.ts';
import {
  PRODUCT_SAFETY_ATTRIBUTE_KEYS,
  type BarcodeScanProvenance,
  type OwnedProduct,
  type OwnedProductInput,
  type ProductSafetyAttributes,
} from '../domain/types.ts';

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
  safety_attributes?: Record<string, unknown>;
  barcode_raw_value?: string | null;
  barcode_symbology?: string | null;
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
  safety_attributes?: ProductSafetyAttributes;
};

function toSafetyAttributes(value: Record<string, unknown> = {}): ProductSafetyAttributes {
  const attributes: ProductSafetyAttributes = {};
  for (const key of PRODUCT_SAFETY_ATTRIBUTE_KEYS) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) attributes[key] = candidate;
  }
  return attributes;
}

/** Insert-only scan provenance columns; `toOwnedProductWriteRow` (also used by updates) omits them. */
export type OwnedProductScanProvenanceRow = {
  barcode_raw_value: string;
  barcode_symbology: BarcodeScanProvenance['symbology'];
};

/**
 * Defense in depth: exposes provenance only while it describes the current gtin (same canonical
 * GTIN-14). The database is the guarantee (owned_products_barcode_provenance_gtin_check, with
 * symbology-aware UPC-E expansion, and the clearing trigger); a row passing its constraints
 * never fails this check.
 */
function toBarcodeScanProvenance(row: OwnedProductRow): BarcodeScanProvenance | null {
  const { barcode_raw_value: rawValue, barcode_symbology: symbology } = row;
  if (typeof rawValue !== 'string' || !isGtinCarrierSymbology(symbology)) return null;
  const scanned = toScannedBarcode(symbology, rawValue);
  return scanned.canonicalGtin14 !== null && scanned.canonicalGtin14 === canonicalGtin14(row.gtin)
    ? { rawValue, symbology }
    : null;
}

export function toOwnedProductScanProvenanceRow(
  provenance: BarcodeScanProvenance | undefined,
): OwnedProductScanProvenanceRow | null {
  return provenance
    ? { barcode_raw_value: provenance.rawValue, barcode_symbology: provenance.symbology }
    : null;
}

export function toOwnedProduct(row: OwnedProductRow): OwnedProduct {
  if (row.purchase_country_code !== null && !isSupportedCountryCode(row.purchase_country_code)) {
    throw new Error('Owned product has an unsupported purchase country code.');
  }
  const barcodeScan = toBarcodeScanProvenance(row);

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
    ...(row.safety_attributes
      ? { safetyAttributes: toSafetyAttributes(row.safety_attributes) }
      : {}),
    ...(barcodeScan ? { barcodeScan } : {}),
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
    ...(input.safetyAttributes ? { safety_attributes: input.safetyAttributes } : {}),
  };
}
