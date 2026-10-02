import type { IdentifierEvidence, MatchEvidence, MatchEvaluationCore } from './types.ts';

const identifierKinds = ['gtin', 'modelNumber', 'serialNumber', 'lotNumber'] as const;
const evidenceKinds = [
  ...identifierKinds,
  'productName',
  'brand',
  'manufacturerContext',
  'purchaseDateContext',
  'additionalCriteria',
] as const;
const evidenceOutcomes = ['matched', 'conflicting', 'supporting', 'unresolved'] as const;
const evidenceStrengths = ['strong', 'supporting', 'contextual'] as const;

const identifierSchema = {
  type: 'object',
  properties: Object.fromEntries(
    identifierKinds.map((kind) => [
      kind,
      { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 32 },
    ]),
  ),
  required: [...identifierKinds],
  additionalProperties: false,
} as const;

export const NEMOTRON_MATCH_OUTPUT_SCHEMA = {
  name: 'recall_match_evaluation',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      decision: { enum: ['confirmed', 'rejected', 'needs_review'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      matchedIdentifiers: identifierSchema,
      conflictingIdentifiers: identifierSchema,
      evidenceUsed: {
        type: 'array',
        maxItems: 64,
        items: {
          type: 'object',
          properties: {
            kind: { enum: [...evidenceKinds] },
            outcome: { enum: [...evidenceOutcomes] },
            strength: { enum: [...evidenceStrengths] },
            scopeIndex: { type: 'integer', minimum: 0 },
            ownedValue: { type: ['string', 'null'] },
            officialValue: { type: ['string', 'null'] },
            detail: { type: 'string', minLength: 1 },
          },
          required: [
            'kind',
            'outcome',
            'strength',
            'scopeIndex',
            'ownedValue',
            'officialValue',
            'detail',
          ],
          additionalProperties: false,
        },
      },
      reasoningSummary: { type: 'string', minLength: 1, maxLength: 1200 },
    },
    required: [
      'decision',
      'confidence',
      'matchedIdentifiers',
      'conflictingIdentifiers',
      'evidenceUsed',
      'reasoningSummary',
    ],
    additionalProperties: false,
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function parseIdentifiers(value: unknown, path: string, errors: string[]): IdentifierEvidence {
  if (!isRecord(value) || !hasExactKeys(value, identifierKinds)) {
    errors.push(`${path} must contain exactly the four supported identifier arrays.`);
    return {};
  }
  const parsed: Record<string, readonly string[]> = {};
  for (const kind of identifierKinds) {
    const items = value[kind];
    if (
      !Array.isArray(items) ||
      items.length > 32 ||
      items.some((item) => typeof item !== 'string' || !item.trim())
    ) {
      errors.push(`${path}.${kind} must be an array of non-empty strings.`);
      continue;
    }
    parsed[kind] = items;
  }
  return parsed as IdentifierEvidence;
}

function parseEvidence(value: unknown, index: number, errors: string[]): MatchEvidence | null {
  const path = `evidenceUsed[${index}]`;
  const keys = [
    'kind',
    'outcome',
    'strength',
    'scopeIndex',
    'ownedValue',
    'officialValue',
    'detail',
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    errors.push(`${path} has missing or unexpected fields.`);
    return null;
  }
  if (!evidenceKinds.includes(value.kind as (typeof evidenceKinds)[number])) {
    errors.push(`${path}.kind is invalid.`);
  }
  if (!evidenceOutcomes.includes(value.outcome as (typeof evidenceOutcomes)[number])) {
    errors.push(`${path}.outcome is invalid.`);
  }
  if (!evidenceStrengths.includes(value.strength as (typeof evidenceStrengths)[number])) {
    errors.push(`${path}.strength is invalid.`);
  }
  if (!Number.isInteger(value.scopeIndex) || (value.scopeIndex as number) < 0) {
    errors.push(`${path}.scopeIndex must be a non-negative integer.`);
  }
  if (value.ownedValue !== null && typeof value.ownedValue !== 'string') {
    errors.push(`${path}.ownedValue must be a string or null.`);
  }
  if (value.officialValue !== null && typeof value.officialValue !== 'string') {
    errors.push(`${path}.officialValue must be a string or null.`);
  }
  if (typeof value.detail !== 'string' || !value.detail.trim()) {
    errors.push(`${path}.detail must be a non-empty string.`);
  }
  if (errors.some((error) => error.startsWith(path))) return null;

  return {
    kind: value.kind as MatchEvidence['kind'],
    outcome: value.outcome as MatchEvidence['outcome'],
    strength: value.strength as MatchEvidence['strength'],
    scopeIndex: value.scopeIndex as number,
    ...(typeof value.ownedValue === 'string' ? { ownedValue: value.ownedValue } : {}),
    ...(typeof value.officialValue === 'string' ? { officialValue: value.officialValue } : {}),
    detail: value.detail as string,
  };
}

export type ParsedNemotronOutput =
  { ok: true; value: MatchEvaluationCore } | { ok: false; errors: readonly string[] };

export function validateNemotronOutput(value: unknown): ParsedNemotronOutput {
  const requiredKeys = [
    'decision',
    'confidence',
    'matchedIdentifiers',
    'conflictingIdentifiers',
    'evidenceUsed',
    'reasoningSummary',
  ];
  if (!isRecord(value) || !hasExactKeys(value, requiredKeys)) {
    return { ok: false, errors: ['Output has missing or unexpected fields.'] };
  }

  const errors: string[] = [];
  if (!['confirmed', 'rejected', 'needs_review'].includes(value.decision as string)) {
    errors.push('decision is invalid.');
  }
  if (
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    errors.push('confidence must be a finite number in 0..1.');
  }
  const matchedIdentifiers = parseIdentifiers(
    value.matchedIdentifiers,
    'matchedIdentifiers',
    errors,
  );
  const conflictingIdentifiers = parseIdentifiers(
    value.conflictingIdentifiers,
    'conflictingIdentifiers',
    errors,
  );
  if (!Array.isArray(value.evidenceUsed) || value.evidenceUsed.length > 64) {
    errors.push('evidenceUsed must be an array with at most 64 items.');
  }
  const evidenceUsed = Array.isArray(value.evidenceUsed)
    ? value.evidenceUsed
        .map((item, index) => parseEvidence(item, index, errors))
        .filter((item): item is MatchEvidence => item !== null)
    : [];
  if (
    typeof value.reasoningSummary !== 'string' ||
    !value.reasoningSummary.trim() ||
    value.reasoningSummary.length > 1200
  ) {
    errors.push('reasoningSummary must be a non-empty string of at most 1200 characters.');
  }
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      decision: value.decision as MatchEvaluationCore['decision'],
      confidence: value.confidence as number,
      matchedIdentifiers,
      conflictingIdentifiers,
      evidenceUsed,
      reasoningSummary: value.reasoningSummary as string,
    },
  };
}
