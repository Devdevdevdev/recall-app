import type { CpscRecallInput, CpscScopeInput, JsonObject, JsonValue } from './types.ts';
import { dateOnlyFromSource, isCpscOfficialUrl, isJsonObject, validateGtin } from './validation.ts';

function optionalText(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function textValues(value: JsonValue | undefined, property: string): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isJsonObject(item)) {
      return [];
    }
    const text = optionalText(item[property]);
    return text ? [text] : [];
  });
}

function joinOfficialText(value: JsonValue | undefined, property: string): string | null {
  const values = [...new Set(textValues(value, property))];
  return values.length ? values.join('\n\n') : null;
}

function stableExternalId(raw: JsonObject): string | null {
  const recallId = raw.RecallID;
  if (typeof recallId === 'number' && Number.isInteger(recallId) && recallId > 0) {
    return String(recallId);
  }
  if (typeof recallId === 'string' && recallId.trim()) {
    return recallId.trim();
  }

  const recallNumber = optionalText(raw.RecallNumber);
  return recallNumber ? `recall-number:${recallNumber}` : null;
}

function additionalCriteria(values: Record<string, JsonValue | null>): JsonObject | null {
  const kept = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== null && value !== ''),
  ) as JsonObject;
  return Object.keys(kept).length ? kept : null;
}

function productScopes(raw: JsonObject, manufacturerNames: string[]): CpscScopeInput[] {
  if (!Array.isArray(raw.Products)) {
    return [];
  }

  return raw.Products.flatMap((product) => {
    if (!isJsonObject(product)) {
      return [];
    }

    const productName = optionalText(product.Name);
    const modelNumber = optionalText(product.Model);
    const criteria = additionalCriteria({
      source_product_description: optionalText(product.Description),
      source_product_type: optionalText(product.Type),
      source_category_id: optionalText(product.CategoryID),
      manufacturer_names: manufacturerNames.length ? manufacturerNames : null,
    });

    return productName || modelNumber || criteria
      ? [{ productName, gtin: null, modelNumber, additionalCriteria: criteria }]
      : [];
  });
}

function recallLevelUpcScopes(raw: JsonObject): CpscScopeInput[] {
  const upcs = textValues(raw.ProductUPCs, 'UPC');
  return [...new Set(upcs)].map((upc) => ({
    productName: null,
    gtin: validateGtin(upc) ? upc : null,
    modelNumber: null,
    additionalCriteria: additionalCriteria({
      evidence_level: 'recall',
      association:
        'CPSC ProductUPCs are recall-level and are not associated with a specific product.',
      source_upc: validateGtin(upc) ? null : upc,
    }),
  }));
}

/** Converts only explicit CPSC fields; free-form recall prose is never interpreted as identifiers. */
export function mapCpscRecall(raw: JsonObject): CpscRecallInput {
  const externalId = stableExternalId(raw);
  if (!externalId) {
    throw new Error('missing stable RecallID or RecallNumber');
  }

  const title = optionalText(raw.Title);
  if (!title) {
    throw new Error('missing Title');
  }

  const recallDate = dateOnlyFromSource(raw.RecallDate);
  if (!recallDate) {
    throw new Error('missing or malformed RecallDate');
  }

  const officialUrl = optionalText(raw.URL);
  if (!officialUrl || !isCpscOfficialUrl(officialUrl)) {
    throw new Error('official URL is not on an allowed HTTPS CPSC host');
  }

  const manufacturerNames = [...new Set(textValues(raw.Manufacturers, 'Name'))];
  const remedies = [
    ...textValues(raw.Remedies, 'Name'),
    ...textValues(raw.RemedyOptions, 'Option'),
  ];

  return {
    externalId,
    title,
    description: optionalText(raw.Description),
    hazard: joinOfficialText(raw.Hazards, 'Name'),
    remedy: remedies.length ? [...new Set(remedies)].join('\n\n') : null,
    recallDate,
    officialUrl,
    rawPayload: raw,
    scopes: [...productScopes(raw, manufacturerNames), ...recallLevelUpcScopes(raw)],
  };
}

export function sourceIdentifier(raw: JsonObject): string | null {
  return stableExternalId(raw);
}
