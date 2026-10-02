import { evaluateDeterministicMatchV2 } from '../matching/deterministicMatcherV2.ts';
import type { JsonObject, JsonValue, OfficialRecallEvidence } from '../matching/types.ts';
import {
  MATCH_EVALUATION_SCHEMA_VERSION_V2,
  PRODUCT_ATTRIBUTE_KEYS,
  type OfficialRecallEvidenceV2,
  type OwnedProductEvidenceV2,
  type RecallCriterionSet,
} from '../matching/typesV2.ts';
import type { AuthoritativeRecallRow, OwnedProductRow } from './types.ts';
import type { LiveReviewedCriterionSetV2 } from './reviewedCriteriaV2.ts';
import { projectAuthoritativeRecall, projectOwnedProduct } from './projection.ts';

/** Prepared policy identity. The deployed Edge entry point still selects phase_10_guarded_v1. */
export const PHASE_16_DETERMINISTIC_V2_POLICY = 'phase_16_deterministic_v2';

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
    .join(',')}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function matchingAttributes(row: OwnedProductRow): OwnedProductEvidenceV2['attributes'] {
  const source = row.safety_attributes ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Stored product safety evidence is invalid.');
  }
  for (const [key, value] of Object.entries(source)) {
    if (
      !PRODUCT_ATTRIBUTE_KEYS.includes(key as (typeof PRODUCT_ATTRIBUTE_KEYS)[number]) ||
      typeof value !== 'string' ||
      !value.trim() ||
      value !== value.trim()
    ) {
      throw new Error('Stored product safety evidence is invalid.');
    }
    if (key === 'manufacture_date' || key === 'production_date') {
      const date = new Date(`${value}T00:00:00.000Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
      ) {
        throw new Error('Stored product safety date is invalid.');
      }
    }
  }
  return PRODUCT_ATTRIBUTE_KEYS.flatMap((key) => {
    const value = source[key];
    if (typeof value !== 'string' || !value.trim()) return [];
    return [
      {
        key,
        value: value.trim(),
        valueType:
          key === 'manufacture_date' || key === 'production_date'
            ? ('date' as const)
            : ('text' as const),
        captureSource: 'manual' as const,
      },
    ];
  });
}

export function projectOwnedProductForProductionV2(row: OwnedProductRow): OwnedProductEvidenceV2 {
  const base = projectOwnedProduct(row);
  return { ...base, purchaseDate: null, attributes: matchingAttributes(row) };
}

/** No criterion is inferred from source prose, a scope column, or recall-level UPCs. */
export function projectRecallForProductionV2(
  row: AuthoritativeRecallRow,
  reviewedCriteria: readonly (RecallCriterionSet | null)[],
): OfficialRecallEvidenceV2 {
  const base: OfficialRecallEvidence = projectAuthoritativeRecall(row);
  if (reviewedCriteria.length !== base.scopes.length) {
    throw new Error('Reviewed criterion count must match canonical scope count.');
  }
  for (const set of reviewedCriteria) {
    if (!set) continue;
    if (!['all_of', 'ambiguous'].includes(set.semantics) || !set.criteria.length) {
      throw new Error('Reviewed criterion semantics are invalid.');
    }
    const ids = new Set<string>();
    for (const criterion of set.criteria) {
      const provenance = criterion.provenance;
      const authorityMatches =
        provenance?.authority === row.source_authority ||
        (provenance?.authority === 'CPSC' && row.source_authority.includes('CPSC')) ||
        (provenance?.authority === 'Health Canada' &&
          row.source_authority.includes('Health Canada'));
      if (
        !criterion.required ||
        !criterion.id ||
        ids.has(criterion.id) ||
        !authorityMatches ||
        provenance.officialUrl !== row.source_official_url ||
        !provenance.sourceField ||
        !provenance.normalizationRule
      ) {
        throw new Error('Reviewed criterion provenance or mandatory evidence is invalid.');
      }
      ids.add(criterion.id);
    }
  }
  return {
    ...base,
    scopes: base.scopes.map((scope, index) => ({
      ...scope,
      ...(reviewedCriteria[index] ? { criteria: reviewedCriteria[index] } : {}),
    })),
  };
}

export async function productionFingerprintV2(input: {
  ownedProduct: OwnedProductEvidenceV2;
  officialRecall: OfficialRecallEvidenceV2;
  productRevision?: string;
  recallRevision?: string;
}): Promise<string> {
  const { source, scopes, title } = input.officialRecall;
  const { retrievedAt: _retrievedAt, ...stableSource } = source;
  const orderedScopes = scopes
    .map(
      (scope) =>
        ({
          productName: scope.productName,
          gtin: scope.gtin,
          modelNumber: scope.modelNumber,
          serialNumber: scope.serialNumber,
          lotNumber: scope.lotNumber,
          serialFrom: scope.serialFrom,
          serialTo: scope.serialTo,
          lotFrom: scope.lotFrom,
          lotTo: scope.lotTo,
          manufacturerNames: Array.isArray(scope.additionalCriteria?.manufacturer_names)
            ? [...scope.additionalCriteria.manufacturer_names].sort()
            : [],
          criteria: scope.criteria
            ? {
                semantics: scope.criteria.semantics,
                review: (scope.criteria as LiveReviewedCriterionSetV2).review ?? null,
                criteria: scope.criteria.criteria
                  .map((criterion) => ({
                    ...criterion,
                    ...(criterion.values ? { values: [...criterion.values].sort() } : {}),
                  }))
                  .sort((a, b) =>
                    canonical(a as unknown as JsonObject).localeCompare(
                      canonical(b as unknown as JsonObject),
                    ),
                  ),
              }
            : null,
        }) as unknown as JsonObject,
    )
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const requiredAttributeKeys = new Set(
    scopes.flatMap(
      (scope) =>
        scope.criteria?.criteria.map((criterion) =>
          criterion.kind === 'date_code_prefix' ? 'date_code' : criterion.kind,
        ) ?? [],
    ),
  );
  const matchingOwnedProduct = {
    productName: input.ownedProduct.productName,
    brand: input.ownedProduct.brand,
    gtin: input.ownedProduct.gtin,
    modelNumber: input.ownedProduct.modelNumber,
    serialNumber: input.ownedProduct.serialNumber,
    lotNumber: input.ownedProduct.lotNumber,
    attributes: input.ownedProduct.attributes
      .filter((attribute) => requiredAttributeKeys.has(attribute.key))
      .map(({ key, value }) => ({ key, value }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
  const document = {
    policy: PHASE_16_DETERMINISTIC_V2_POLICY,
    matcher: 'deterministic_v2',
    schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION_V2,
    revisions: {
      product: input.productRevision ?? null,
      recall: input.recallRevision ?? null,
    },
    ownedProduct: matchingOwnedProduct,
    officialRecall: { title, source: stableSource, scopes: orderedScopes },
  } as unknown as JsonObject;
  return sha256(canonical(document));
}

export function evaluateProductionPairV2(
  ownedProduct: OwnedProductEvidenceV2,
  officialRecall: OfficialRecallEvidenceV2,
) {
  return evaluateDeterministicMatchV2(ownedProduct, officialRecall);
}
