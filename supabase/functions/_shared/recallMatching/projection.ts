import type {
  OfficialRecallEvidence,
  OfficialRecallScopeEvidence,
  OwnedProductEvidence,
} from '../matching/types.ts';
import type { AuthoritativeRecallRow, OwnedProductRow, RecallScopeRow } from './types.ts';

function nullableText(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredText(value: string, field: string): string {
  const text = nullableText(value);
  if (!text) throw new Error(`Authoritative recall ${field} is required.`);
  return text;
}

function projectScope(row: RecallScopeRow): OfficialRecallScopeEvidence {
  return {
    brand: nullableText(row.brand),
    productName: nullableText(row.product_name),
    gtin: nullableText(row.gtin),
    modelNumber: nullableText(row.model_number),
    serialNumber: nullableText(row.serial_number),
    lotNumber: nullableText(row.lot_number),
    serialFrom: nullableText(row.serial_from),
    serialTo: nullableText(row.serial_to),
    lotFrom: nullableText(row.lot_from),
    lotTo: nullableText(row.lot_to),
    manufacturedFrom: nullableText(row.manufactured_from),
    manufacturedTo: nullableText(row.manufactured_to),
    additionalCriteria: row.additional_criteria ?? null,
  };
}

export function projectOwnedProduct(row: OwnedProductRow): OwnedProductEvidence {
  return {
    productName: nullableText(row.product_name),
    brand: nullableText(row.brand),
    category: nullableText(row.category),
    gtin: nullableText(row.gtin),
    modelNumber: nullableText(row.model_number),
    serialNumber: nullableText(row.serial_number),
    lotNumber: nullableText(row.lot_number),
    purchaseDate: nullableText(row.purchase_date),
    identificationMethod: nullableText(row.identification_method),
  };
}

/**
 * Builds the production inference projection. Raw CPSC payloads are deliberately excluded from
 * model input in Phase 10; their canonical hash is handled separately by the fingerprint module.
 */
export function projectAuthoritativeRecall(row: AuthoritativeRecallRow): OfficialRecallEvidence {
  if (row.source_is_authoritative !== true) {
    throw new Error('Production matching accepts only an authoritative recall source.');
  }
  return {
    recallNoticeId: requiredText(row.recall_notice_id, 'database identifier'),
    source: {
      authority: requiredText(row.source_authority, 'authority'),
      externalId: requiredText(row.source_external_id, 'external identifier'),
      officialUrl: requiredText(row.source_official_url, 'official URL'),
    },
    title: requiredText(row.title, 'title'),
    description: nullableText(row.description),
    hazard: nullableText(row.hazard),
    remedy: nullableText(row.remedy),
    recallDate: requiredText(row.recall_date, 'date'),
    scopes: row.scopes.map(projectScope),
    rawEvidence: null,
  };
}
