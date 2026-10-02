import type { CanonicalRecallNotice, JsonObject } from '../recallSources/types.ts';
import { dateOnlyFromSource, isOfficialHttpsUrl } from '../recallSources/validation.ts';
import type { HealthCanadaRecord } from './types.ts';

const officialHost = 'recalls-rappels.canada.ca';

function required(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`Health Canada record is missing ${label}.`);
  return text;
}

function optional(value: string): string | null {
  const text = value.trim();
  return text ? text : null;
}

function criteria(record: HealthCanadaRecord): JsonObject {
  return {
    source_organization: record.Organization,
    source_category: record.Category,
    source_recall_class: optional(record['Recall class']),
    source_archived: record.Archived === '1',
    source_date_semantics: 'last_updated',
  };
}

/** Maps only explicit feed fields; titles are never mined for brands, GTINs, or model numbers. */
export function mapHealthCanadaRecall(record: HealthCanadaRecord): CanonicalRecallNotice {
  const externalId = required(record.NID, 'NID');
  if (!/^\d+$/u.test(externalId)) throw new Error('Health Canada NID is malformed.');
  const title = required(record.Title, 'Title');
  const productName = required(record.Product, 'Product');
  const updatedAt = dateOnlyFromSource(record['Last updated']);
  if (!updatedAt) throw new Error('Health Canada Last updated date is malformed.');
  const officialUrl = required(record.URL, 'URL');
  if (!isOfficialHttpsUrl(officialUrl, officialHost)) {
    throw new Error('Health Canada URL is not on the official recall host.');
  }

  return {
    externalId,
    title,
    description: productName,
    hazard: optional(record.Issue),
    remedy: optional(record['What you should do']),
    recallDate: updatedAt,
    updatedAt,
    officialUrl,
    rawPayload: record,
    scopes: [
      {
        brand: null,
        productName,
        gtin: null,
        modelNumber: null,
        lotFrom: null,
        lotTo: null,
        serialFrom: null,
        serialTo: null,
        additionalCriteria: criteria(record),
      },
    ],
    jurisdictions: [{ type: 'country', code: 'CA' }],
  };
}

export function healthCanadaSourceIdentifier(record: HealthCanadaRecord): string | null {
  const value = record.NID.trim();
  return /^\d+$/u.test(value) ? value : null;
}
