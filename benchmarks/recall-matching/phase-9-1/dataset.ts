import {
  recallForCase,
  validateBenchmarkJsonSchema,
  type BenchmarkCase,
  type BenchmarkDataset,
  type BenchmarkExpected,
} from '../dataset.ts';
import { evaluateDeterministicMatch } from '../../../supabase/functions/_shared/matching/deterministicMatcher.ts';
import {
  normalizeIdentifier,
  productNameOverlap,
} from '../../../supabase/functions/_shared/matching/normalization.ts';
import type { GuardedEvidenceClaim } from '../../../supabase/functions/_shared/matching/guardedNemotronSchema.ts';
import { verifyNemotronConfirmation } from '../../../supabase/functions/_shared/matching/nemotronSafetyVerifier.ts';
import type {
  JsonObject,
  OwnedProductEvidence,
} from '../../../supabase/functions/_shared/matching/types.ts';

export const DIAGNOSTIC_V1_DATASET_SHA256 =
  'c547d61df8e9eacc1d47d46ec505e409d88cd23795abc20cbbfb4e96f67fb3f8';

type ValidationOptions = {
  name: string;
  expectedCaseCount: number;
  expectedPerClass: number;
  forbiddenRecallIds: ReadonlySet<string>;
};

type ExplicitCriterion = {
  criterion: GuardedEvidenceClaim['criterion'];
  value?: string;
  from?: string;
  to?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function explicitCriteria(rawEvidence: JsonObject | null): ExplicitCriterion[] {
  if (!rawEvidence || !Array.isArray(rawEvidence.explicitCriteria)) return [];
  return rawEvidence.explicitCriteria.flatMap((value) => {
    if (!isRecord(value)) return [];
    const criterion = text(value.criterion) as GuardedEvidenceClaim['criterion'] | null;
    if (
      !criterion ||
      ![
        'gtin',
        'modelNumber',
        'serialNumber',
        'lotNumber',
        'serialPrefix',
        'serialRange',
        'lotRange',
      ].includes(criterion)
    ) {
      return [];
    }
    return [
      {
        criterion,
        ...(text(value.value) ? { value: text(value.value) as string } : {}),
        ...(text(value.from) ? { from: text(value.from) as string } : {}),
        ...(text(value.to) ? { to: text(value.to) as string } : {}),
      },
    ];
  });
}

function ownedField(
  criterion: GuardedEvidenceClaim['criterion'],
): GuardedEvidenceClaim['ownedField'] {
  if (criterion === 'serialPrefix' || criterion === 'serialRange') return 'serialNumber';
  if (criterion === 'lotRange') return 'lotNumber';
  return criterion as GuardedEvidenceClaim['ownedField'];
}

function exactClaim(
  criterion: ExplicitCriterion,
  sourceIndex: number,
  product: OwnedProductEvidence,
): GuardedEvidenceClaim | null {
  const field = ownedField(criterion.criterion);
  const value = product[field];
  const officialValue =
    criterion.value ??
    (criterion.from && criterion.to ? `${criterion.from}..${criterion.to}` : null);
  if (!value || !officialValue) return null;
  return {
    criterion: criterion.criterion,
    ownedField: field,
    ownedValue: value,
    claimedOfficialValue: officialValue,
    sourceKind: 'rawEvidence',
    scopeIndex: null,
    sourceField: 'explicitCriteria',
    sourceIndex,
  };
}

function hasObjectiveConfirmation(
  dataset: BenchmarkDataset,
  benchmarkCase: BenchmarkCase,
): boolean {
  const recall = recallForCase(dataset, benchmarkCase);
  if (evaluateDeterministicMatch(benchmarkCase.ownedProduct, recall).decision === 'confirmed') {
    return true;
  }
  return explicitCriteria(recall.rawEvidence).some((criterion, sourceIndex) => {
    const claim = exactClaim(criterion, sourceIndex, benchmarkCase.ownedProduct);
    if (!claim) return false;
    return verifyNemotronConfirmation(
      { ownedProduct: benchmarkCase.ownedProduct, officialRecall: recall },
      {
        decision: 'confirmed',
        confidence: 1,
        matchedIdentifiers: {},
        conflictingIdentifiers: {},
        evidenceUsed: [],
        reasoningSummary: 'Dataset validation fixture.',
        evidenceClaims: [claim],
      },
    ).accepted;
  });
}

function hasObjectiveRawContradiction(
  product: OwnedProductEvidence,
  rawEvidence: JsonObject | null,
): boolean {
  if (!rawEvidence || !Array.isArray(rawEvidence.completeCriterionSets)) return false;
  return rawEvidence.completeCriterionSets.some((value) => {
    if (!isRecord(value)) return false;
    const criterion = text(value.criterion);
    const values = Array.isArray(value.values)
      ? value.values.filter(
          (item): item is string => typeof item === 'string' && Boolean(item.trim()),
        )
      : [];
    const productName = text(value.productName);
    const brand = text(value.brand);
    const context = text(value.context);
    if (!criterion || !values.length || !productName || !context) return false;
    if (!product.productName || productNameOverlap(product.productName, productName) < 0.35)
      return false;
    const ownedBrand = normalizeIdentifier(product.brand);
    const officialBrand = normalizeIdentifier(brand);
    if (ownedBrand && officialBrand && ownedBrand !== officialBrand) return false;
    const field = ownedField(criterion as GuardedEvidenceClaim['criterion']);
    const productValue = normalizeIdentifier(product[field]);
    if (!productValue) return false;
    const normalizedValues = values.map(normalizeIdentifier).filter(Boolean) as string[];
    return criterion === 'serialPrefix'
      ? !normalizedValues.some((prefix) => productValue.startsWith(prefix))
      : !normalizedValues.includes(productValue);
  });
}

function collectPrivatePaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectPrivatePaths(item, `${path}[${index}]`));
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    ...(/^(?:auth|email|imagePath|ocr|userId|user_id|uuid)$/iu.test(key) ? [`${path}.${key}`] : []),
    ...collectPrivatePaths(nested, `${path}.${key}`),
  ]);
}

export function validatePhase91Dataset(
  value: unknown,
  schema: unknown,
  options: ValidationOptions,
): string[] {
  const errors = validateBenchmarkJsonSchema(value, schema);
  if (!isRecord(value) || !Array.isArray(value.recalls) || !Array.isArray(value.cases)) {
    return [...errors, `${options.name} must contain recalls and cases arrays.`];
  }
  if (value.cases.length !== options.expectedCaseCount) {
    errors.push(`${options.name} must contain exactly ${options.expectedCaseCount} cases.`);
  }
  const counts = new Map<BenchmarkExpected, number>([
    ['match', 0],
    ['no_match', 0],
    ['needs_review', 0],
  ]);
  const recalls = value.recalls.filter(isRecord);
  const recallIds = new Set(
    recalls.flatMap((recall) =>
      isRecord(recall.source) && text(recall.source.externalId)
        ? [recall.source.externalId as string]
        : [],
    ),
  );
  for (const recallId of recallIds) {
    if (options.forbiddenRecallIds.has(recallId)) {
      errors.push(`${options.name} reuses forbidden recall ${recallId}.`);
    }
  }

  let dataset: BenchmarkDataset | null = null;
  if (!errors.length) {
    try {
      dataset = value as BenchmarkDataset;
      for (const benchmarkCase of dataset.cases) {
        counts.set(benchmarkCase.expected, (counts.get(benchmarkCase.expected) ?? 0) + 1);
        const expectedProvenance = {
          match: 'official_exact_evidence',
          no_match: 'controlled_counterfactual',
          needs_review: 'source_ambiguity',
        }[benchmarkCase.expected];
        if (benchmarkCase.labelProvenance !== expectedProvenance) {
          errors.push(`${options.name} case ${benchmarkCase.caseId} has incompatible provenance.`);
        }
        const recall = recallForCase(dataset, benchmarkCase);
        const deterministic = evaluateDeterministicMatch(benchmarkCase.ownedProduct, recall);
        const confirmation = hasObjectiveConfirmation(dataset, benchmarkCase);
        const contradiction =
          deterministic.decision === 'rejected' ||
          hasObjectiveRawContradiction(benchmarkCase.ownedProduct, recall.rawEvidence);
        if (benchmarkCase.expected === 'match' && !confirmation) {
          errors.push(`${options.name} case ${benchmarkCase.caseId} lacks objective support.`);
        }
        if (benchmarkCase.expected === 'no_match' && !contradiction) {
          errors.push(
            `${options.name} case ${benchmarkCase.caseId} lacks an objective contradiction.`,
          );
        }
        if (
          benchmarkCase.expected === 'needs_review' &&
          (deterministic.decision !== 'needs_review' || confirmation || contradiction)
        ) {
          errors.push(`${options.name} case ${benchmarkCase.caseId} is not genuinely unresolved.`);
        }
      }
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : `${options.name} could not be validated.`,
      );
    }
  }
  for (const expected of ['match', 'no_match', 'needs_review'] as const) {
    if ((counts.get(expected) ?? 0) !== options.expectedPerClass) {
      errors.push(`${options.name} must contain ${options.expectedPerClass} ${expected} cases.`);
    }
  }
  for (const path of collectPrivatePaths(value)) {
    errors.push(`${options.name} contains private-data-shaped field ${path}.`);
  }
  return errors;
}

export function asPhase91Dataset(
  value: unknown,
  schema: unknown,
  options: ValidationOptions,
): BenchmarkDataset {
  const errors = validatePhase91Dataset(value, schema, options);
  if (errors.length) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return value as BenchmarkDataset;
}
