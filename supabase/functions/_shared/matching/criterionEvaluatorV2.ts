import { isValidGtin, normalizeGtin, normalizeIdentifier } from './normalization.ts';
import { gtinsEquivalent } from './gtin.ts';
import type {
  CriterionEvaluation,
  OfficialRecallScopeEvidenceV2,
  OwnedProductEvidenceV2,
  RecallCriterion,
  RecallCriterionKind,
} from './typesV2.ts';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

function isCanonicalDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function attributeValue(owned: OwnedProductEvidenceV2, key: string): string | null {
  return owned.attributes.find((attribute) => attribute.key === key)?.value ?? null;
}

function ownedValue(owned: OwnedProductEvidenceV2, kind: RecallCriterionKind): string | null {
  if (kind === 'gtin') return owned.gtin;
  if (kind === 'model_number') return owned.modelNumber;
  if (kind === 'serial_number') return owned.serialNumber;
  if (kind === 'lot_number') return owned.lotNumber;
  if (kind === 'date_code_prefix') return attributeValue(owned, 'date_code');
  return attributeValue(owned, kind);
}

function officialValue(criterion: RecallCriterion): string {
  if (criterion.value) return criterion.value;
  if (criterion.values) return criterion.values.join(' | ');
  if (criterion.range) return `${criterion.range.from}..${criterion.range.to}`;
  return '(invalid criterion)';
}

function normalize(kind: RecallCriterionKind, value: string | null | undefined): string | null {
  if (kind === 'gtin') return normalizeGtin(value);
  if (kind === 'manufacture_date' || kind === 'production_date') {
    return typeof value === 'string' && isCanonicalDate(value) ? value : null;
  }
  return normalizeIdentifier(value);
}

/** Phase 17.3-S: two valid GTINs with the same canonical GTIN-14 are the same identifier. */
function sameValue(kind: RecallCriterionKind, actual: string, expected: string): boolean {
  return actual === expected || (kind === 'gtin' && gtinsEquivalent(actual, expected));
}

function compareFixedWidthRange(
  actual: string,
  fromValue: string,
  toValue: string,
): boolean | null {
  if (actual.length !== fromValue.length || fromValue.length !== toValue.length) return null;
  if (fromValue > toValue) return null;
  return actual >= fromValue && actual <= toValue;
}

function compare(criterion: RecallCriterion, rawOwned: string): boolean | null {
  const actual = normalize(criterion.kind, rawOwned);
  if (!actual) return null;

  if (criterion.kind === 'gtin' && !isValidGtin(actual)) return null;
  if (criterion.operator === 'equals') {
    const expected = normalize(criterion.kind, criterion.value);
    return expected ? sameValue(criterion.kind, actual, expected) : null;
  }
  if (criterion.operator === 'one_of') {
    const expected = criterion.values?.map((value) => normalize(criterion.kind, value));
    return expected?.length && expected.every(Boolean)
      ? expected.some((value) => sameValue(criterion.kind, actual, value as string))
      : null;
  }
  if (criterion.operator === 'prefix') {
    const expected = criterion.values?.length
      ? criterion.values.map((value) => normalize(criterion.kind, value))
      : [normalize(criterion.kind, criterion.value)];
    return expected.every(Boolean)
      ? expected.some((value) => actual.startsWith(value as string))
      : null;
  }
  if (criterion.operator === 'range') {
    const from = normalize(criterion.kind, criterion.range?.from);
    const to = normalize(criterion.kind, criterion.range?.to);
    return from && to ? compareFixedWidthRange(actual, from, to) : null;
  }
  if (criterion.operator === 'date_range') {
    const from = normalize(criterion.kind, criterion.range?.from);
    const to = normalize(criterion.kind, criterion.range?.to);
    if (!from || !to || from > to || !DATE_ONLY.test(actual)) return null;
    return actual >= from && actual <= to;
  }
  return null;
}

export function evaluateCriterionV2(
  owned: OwnedProductEvidenceV2,
  criterion: RecallCriterion,
): CriterionEvaluation {
  const rawOwned = ownedValue(owned, criterion.kind);
  const result = rawOwned === null ? undefined : compare(criterion, rawOwned);
  const outcome =
    rawOwned === null
      ? 'missing'
      : result === null
        ? 'unresolved'
        : result
          ? 'matched'
          : 'conflicting';
  return {
    criterionId: criterion.id,
    kind: criterion.kind,
    required: criterion.required,
    outcome,
    ownedValue: rawOwned,
    officialValue: officialValue(criterion),
    detail:
      outcome === 'matched'
        ? 'Owned evidence satisfies the authoritative criterion.'
        : outcome === 'conflicting'
          ? 'Owned evidence safely contradicts the authoritative criterion.'
          : outcome === 'missing'
            ? 'Required comparable owned evidence is absent.'
            : 'Owned and official evidence cannot be compared safely.',
    provenance: criterion.provenance,
  };
}

export function evaluateCriterionSetV2(
  owned: OwnedProductEvidenceV2,
  scope: OfficialRecallScopeEvidenceV2,
): readonly CriterionEvaluation[] {
  return scope.criteria?.criteria.map((criterion) => evaluateCriterionV2(owned, criterion)) ?? [];
}
