import type { MatchEvaluationCore, OwnedProductEvidence } from './types.ts';
import { NEMOTRON_MATCH_OUTPUT_SCHEMA, validateNemotronOutput } from './nemotronSchema.ts';

export const GUARDED_CLAIM_CRITERIA = [
  'gtin',
  'modelNumber',
  'serialNumber',
  'lotNumber',
  'serialPrefix',
  'serialRange',
  'lotRange',
] as const;

export const GUARDED_SOURCE_FIELDS = [
  'gtin',
  'modelNumber',
  'serialNumber',
  'lotNumber',
  'serialFrom',
  'lotFrom',
  'explicitCriteria',
] as const;

export type GuardedClaimCriterion = (typeof GUARDED_CLAIM_CRITERIA)[number];
export type GuardedSourceField = (typeof GUARDED_SOURCE_FIELDS)[number];

export type GuardedEvidenceClaim = {
  criterion: GuardedClaimCriterion;
  ownedField: 'gtin' | 'modelNumber' | 'serialNumber' | 'lotNumber';
  ownedValue: string;
  claimedOfficialValue: string;
  sourceKind: 'scope' | 'rawEvidence';
  scopeIndex: number | null;
  sourceField: GuardedSourceField;
  sourceIndex: number | null;
};

export type GuardedNemotronOutput = MatchEvaluationCore & {
  evidenceClaims: readonly GuardedEvidenceClaim[];
};

export const GUARDED_NEMOTRON_OUTPUT_SCHEMA = {
  name: 'guarded_recall_match_evaluation',
  strict: true,
  schema: {
    ...NEMOTRON_MATCH_OUTPUT_SCHEMA.schema,
    properties: {
      ...NEMOTRON_MATCH_OUTPUT_SCHEMA.schema.properties,
      evidenceClaims: {
        type: 'array',
        maxItems: 32,
        items: {
          type: 'object',
          properties: {
            criterion: { enum: [...GUARDED_CLAIM_CRITERIA] },
            ownedField: {
              enum: ['gtin', 'modelNumber', 'serialNumber', 'lotNumber'],
            },
            ownedValue: { type: 'string', minLength: 1 },
            claimedOfficialValue: { type: 'string', minLength: 1 },
            sourceKind: { enum: ['scope', 'rawEvidence'] },
            scopeIndex: { type: ['integer', 'null'], minimum: 0 },
            sourceField: { enum: [...GUARDED_SOURCE_FIELDS] },
            sourceIndex: { type: ['integer', 'null'], minimum: 0 },
          },
          required: [
            'criterion',
            'ownedField',
            'ownedValue',
            'claimedOfficialValue',
            'sourceKind',
            'scopeIndex',
            'sourceField',
            'sourceIndex',
          ],
          additionalProperties: false,
        },
      },
    },
    required: [...NEMOTRON_MATCH_OUTPUT_SCHEMA.schema.required, 'evidenceClaims'],
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length && actual.every((key, i) => key === sortedExpected[i])
  );
}

function nullableIndex(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

const claimKeys = [
  'criterion',
  'ownedField',
  'ownedValue',
  'claimedOfficialValue',
  'sourceKind',
  'scopeIndex',
  'sourceField',
  'sourceIndex',
] as const;

function parseClaim(value: unknown): GuardedEvidenceClaim | null {
  if (!isRecord(value) || !exactKeys(value, claimKeys)) return null;
  if (!GUARDED_CLAIM_CRITERIA.includes(value.criterion as GuardedClaimCriterion)) return null;
  if (!['gtin', 'modelNumber', 'serialNumber', 'lotNumber'].includes(value.ownedField as string))
    return null;
  if (typeof value.ownedValue !== 'string' || !value.ownedValue.trim()) return null;
  if (typeof value.claimedOfficialValue !== 'string' || !value.claimedOfficialValue.trim())
    return null;
  if (!['scope', 'rawEvidence'].includes(value.sourceKind as string)) return null;
  if (!nullableIndex(value.scopeIndex) || !nullableIndex(value.sourceIndex)) return null;
  if (!GUARDED_SOURCE_FIELDS.includes(value.sourceField as GuardedSourceField)) return null;
  if (value.sourceKind === 'scope' && (value.scopeIndex === null || value.sourceIndex !== null))
    return null;
  if (
    value.sourceKind === 'rawEvidence' &&
    (value.scopeIndex !== null ||
      value.sourceField !== 'explicitCriteria' ||
      value.sourceIndex === null)
  )
    return null;

  return value as GuardedEvidenceClaim;
}

export type ParsedGuardedNemotronOutput =
  { ok: true; value: GuardedNemotronOutput } | { ok: false; errors: readonly string[] };

export function validateGuardedNemotronOutput(value: unknown): ParsedGuardedNemotronOutput {
  if (!isRecord(value)) return { ok: false, errors: ['Output must be an object.'] };
  const { evidenceClaims, ...core } = value;
  const validatedCore = validateNemotronOutput(core);
  if (!validatedCore.ok) return validatedCore;
  if (!Array.isArray(evidenceClaims) || evidenceClaims.length > 32) {
    return { ok: false, errors: ['evidenceClaims must be an array with at most 32 items.'] };
  }
  const parsedClaims = evidenceClaims.map(parseClaim);
  if (parsedClaims.some((claim) => claim === null)) {
    return {
      ok: false,
      errors: ['evidenceClaims contains a malformed or inconsistent reference.'],
    };
  }
  return {
    ok: true,
    value: {
      ...validatedCore.value,
      evidenceClaims: parsedClaims as GuardedEvidenceClaim[],
    },
  };
}

export function ownedFieldForCriterion(
  criterion: GuardedClaimCriterion,
): GuardedEvidenceClaim['ownedField'] {
  if (criterion === 'serialPrefix' || criterion === 'serialRange') return 'serialNumber';
  if (criterion === 'lotRange') return 'lotNumber';
  return criterion as keyof Pick<
    OwnedProductEvidence,
    'gtin' | 'modelNumber' | 'serialNumber' | 'lotNumber'
  >;
}
