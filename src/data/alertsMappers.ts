import type { AlertStatus, RecallAlert, RecallMatchStatus } from '@/src/domain';

type PostgrestRelation<T> = T | T[] | null;

type AlertProductRow = {
  id: string;
  brand: string | null;
  product_name: string | null;
  gtin: string | null;
  model_number: string | null;
  serial_number: string | null;
  lot_number: string | null;
};

type AlertNoticeRow = {
  id: string;
  title: string;
  hazard: string | null;
  remedy: string | null;
  recall_date: string;
  official_url: string;
  recall_source: PostgrestRelation<{
    name: string;
    source_language_code: string | null;
  }>;
  jurisdictions:
    | {
        jurisdiction_type: 'country' | 'global' | 'region';
        jurisdiction_code: string;
      }[]
    | null;
};

type AlertMatchRow = {
  id: string;
  status: RecallMatchStatus;
  confidence: number | string;
  match_method: string;
  reasoning_summary: string;
  evaluated_at: string;
  owned_product: PostgrestRelation<AlertProductRow>;
  recall_notice: PostgrestRelation<AlertNoticeRow>;
};

export type RecallAlertRow = {
  id: string;
  user_id: string;
  recall_match_id: string;
  status: AlertStatus;
  created_at: string;
  read_at: string | null;
  dismissed_at: string | null;
  recall_match: PostgrestRelation<AlertMatchRow>;
};

function requireSingleRelation<T>(value: PostgrestRelation<T>, label: string): T {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new Error(`Expected one ${label} relationship.`);
    }

    return value[0] as T;
  }

  if (!value) {
    throw new Error(`Missing ${label} relationship.`);
  }

  return value;
}

export function toRecallAlert(row: RecallAlertRow): RecallAlert {
  const match = requireSingleRelation(row.recall_match, 'recall match');
  const product = requireSingleRelation(match.owned_product, 'owned product');
  const notice = requireSingleRelation(match.recall_notice, 'recall notice');
  const source = requireSingleRelation(notice.recall_source, 'recall source');

  return {
    id: row.id,
    userId: row.user_id,
    recallMatchId: row.recall_match_id,
    status: row.status,
    createdAt: row.created_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
    match: {
      id: match.id,
      status: match.status,
      confidence: Number(match.confidence),
      method: match.match_method,
      reasoningSummary: match.reasoning_summary,
      evaluatedAt: match.evaluated_at,
    },
    product: {
      id: product.id,
      brand: product.brand,
      productName: product.product_name,
      gtin: product.gtin,
      modelNumber: product.model_number,
      serialNumber: product.serial_number,
      lotNumber: product.lot_number,
    },
    notice: {
      id: notice.id,
      authority: source.name,
      title: notice.title,
      hazard: notice.hazard,
      remedy: notice.remedy,
      recallDate: notice.recall_date,
      officialUrl: notice.official_url,
      sourceLanguageCode: source.source_language_code,
      jurisdictions: (notice.jurisdictions ?? []).map((jurisdiction) => ({
        type: jurisdiction.jurisdiction_type,
        code: jurisdiction.jurisdiction_code,
      })),
    },
  };
}
