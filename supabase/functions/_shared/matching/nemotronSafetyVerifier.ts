import {
  compareIdentifierRange,
  isValidGtin,
  normalizeGtin,
  normalizeIdentifier,
  productNameOverlap,
} from './normalization.ts';
import {
  ownedFieldForCriterion,
  type GuardedEvidenceClaim,
  type GuardedNemotronOutput,
} from './guardedNemotronSchema.ts';
import type { NemotronMatchingInput } from './nemotronPrompt.ts';
import type { JsonObject } from './types.ts';

export type VerifiedNemotronEvidence = {
  criterion: GuardedEvidenceClaim['criterion'];
  ownedValue: string;
  officialValue: string;
  sourceKind: GuardedEvidenceClaim['sourceKind'];
  scopeIndex: number | null;
  sourceField: GuardedEvidenceClaim['sourceField'];
  sourceIndex: number | null;
};

export type NemotronConfirmationVerification = {
  accepted: boolean;
  verifiedEvidence: readonly VerifiedNemotronEvidence[];
  rejectionReasons: readonly string[];
};

type ExplicitCriterion = {
  criterion: GuardedEvidenceClaim['criterion'];
  value?: string;
  from?: string;
  to?: string;
  productName: string;
  brand?: string;
  context: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function hasIdentitySupport(
  owned: NemotronMatchingInput['ownedProduct'],
  productName: string | null | undefined,
  brand: string | null | undefined,
): boolean {
  if (
    !owned.productName ||
    !productName ||
    productNameOverlap(owned.productName, productName) < 0.35
  ) {
    return false;
  }
  const ownedBrand = normalizeIdentifier(owned.brand);
  const officialBrand = normalizeIdentifier(brand);
  return !(ownedBrand && officialBrand && ownedBrand !== officialBrand);
}

function parseExplicitCriterion(value: unknown): ExplicitCriterion | null {
  if (!isRecord(value)) return null;
  const criterion = value.criterion;
  if (
    ![
      'gtin',
      'modelNumber',
      'serialNumber',
      'lotNumber',
      'serialPrefix',
      'serialRange',
      'lotRange',
    ].includes(criterion as string)
  )
    return null;
  const productName = string(value.productName);
  const context = string(value.context);
  if (!productName || !context) return null;
  const parsed: ExplicitCriterion = {
    criterion: criterion as ExplicitCriterion['criterion'],
    productName,
    context,
  };
  const exactValue = string(value.value);
  const from = string(value.from);
  const to = string(value.to);
  const brand = string(value.brand);
  if (exactValue) parsed.value = exactValue;
  if (from) parsed.from = from;
  if (to) parsed.to = to;
  if (brand) parsed.brand = brand;
  return parsed;
}

function compareExact(
  criterion: GuardedEvidenceClaim['criterion'],
  owned: string,
  official: string,
): boolean {
  if (criterion === 'gtin') {
    const left = normalizeGtin(owned);
    const right = normalizeGtin(official);
    return Boolean(left && right && isValidGtin(left) && isValidGtin(right) && left === right);
  }
  return normalizeIdentifier(owned) === normalizeIdentifier(official);
}

function verifyScopeClaim(
  input: NemotronMatchingInput,
  claim: GuardedEvidenceClaim,
): VerifiedNemotronEvidence | null {
  if (claim.scopeIndex === null) return null;
  const scope = input.officialRecall.scopes[claim.scopeIndex];
  if (!scope) return null;
  const unsupportedCriteria = scope.additionalCriteria
    ? Object.keys(scope.additionalCriteria).filter(
        (key) => !['association', 'evidence_level', 'manufacturer_names'].includes(key),
      )
    : [];
  if (scope.manufacturedFrom || scope.manufacturedTo || unsupportedCriteria.length) return null;
  const ownedValue = input.ownedProduct[claim.ownedField];
  if (!ownedValue || claim.ownedField !== ownedFieldForCriterion(claim.criterion)) return null;

  let officialValue: string | null = null;
  let matches = false;
  if (['gtin', 'modelNumber', 'serialNumber', 'lotNumber'].includes(claim.criterion)) {
    if (claim.sourceField !== claim.criterion) return null;
    officialValue = string(
      scope[claim.sourceField as 'gtin' | 'modelNumber' | 'serialNumber' | 'lotNumber'],
    );
    matches = Boolean(officialValue && compareExact(claim.criterion, ownedValue, officialValue));
    if (claim.criterion === 'modelNumber') {
      matches &&= hasIdentitySupport(input.ownedProduct, scope.productName, scope.brand);
    }
  } else if (claim.criterion === 'serialRange' && claim.sourceField === 'serialFrom') {
    officialValue = `${scope.serialFrom ?? '?'}..${scope.serialTo ?? '?'}`;
    matches = compareIdentifierRange(ownedValue, scope.serialFrom, scope.serialTo) === 'inside';
  } else if (claim.criterion === 'lotRange' && claim.sourceField === 'lotFrom') {
    officialValue = `${scope.lotFrom ?? '?'}..${scope.lotTo ?? '?'}`;
    matches = compareIdentifierRange(ownedValue, scope.lotFrom, scope.lotTo) === 'inside';
  }
  if (!matches || !officialValue) return null;
  return {
    criterion: claim.criterion,
    ownedValue,
    officialValue,
    sourceKind: 'scope',
    scopeIndex: claim.scopeIndex,
    sourceField: claim.sourceField,
    sourceIndex: null,
  };
}

function explicitCriteria(rawEvidence: JsonObject | null): readonly unknown[] {
  return rawEvidence && Array.isArray(rawEvidence.explicitCriteria)
    ? rawEvidence.explicitCriteria
    : [];
}

function verifyRawClaim(
  input: NemotronMatchingInput,
  claim: GuardedEvidenceClaim,
): VerifiedNemotronEvidence | null {
  if (claim.sourceIndex === null || claim.sourceField !== 'explicitCriteria') return null;
  const criterion = parseExplicitCriterion(
    explicitCriteria(input.officialRecall.rawEvidence)[claim.sourceIndex],
  );
  if (!criterion || criterion.criterion !== claim.criterion) return null;
  const ownedValue = input.ownedProduct[claim.ownedField];
  if (!ownedValue || claim.ownedField !== ownedFieldForCriterion(claim.criterion)) return null;
  if (!hasIdentitySupport(input.ownedProduct, criterion.productName, criterion.brand)) return null;

  let matches = false;
  let officialValue: string | null = null;
  if (criterion.value) {
    officialValue = criterion.value;
    matches =
      criterion.criterion === 'serialPrefix'
        ? Boolean(
            normalizeIdentifier(ownedValue)?.startsWith(
              normalizeIdentifier(criterion.value) ?? '\u0000',
            ),
          )
        : compareExact(criterion.criterion, ownedValue, criterion.value);
  } else if (criterion.from && criterion.to) {
    officialValue = `${criterion.from}..${criterion.to}`;
    matches = compareIdentifierRange(ownedValue, criterion.from, criterion.to) === 'inside';
  }
  if (!matches || !officialValue) return null;
  return {
    criterion: claim.criterion,
    ownedValue,
    officialValue,
    sourceKind: 'rawEvidence',
    scopeIndex: null,
    sourceField: 'explicitCriteria',
    sourceIndex: claim.sourceIndex,
  };
}

export function verifyNemotronConfirmation(
  input: NemotronMatchingInput,
  modelEvaluation: GuardedNemotronOutput,
): NemotronConfirmationVerification {
  if (modelEvaluation.decision !== 'confirmed') {
    return {
      accepted: false,
      verifiedEvidence: [],
      rejectionReasons: ['Model decision is not confirmed.'],
    };
  }
  if (!modelEvaluation.evidenceClaims.length) {
    return {
      accepted: false,
      verifiedEvidence: [],
      rejectionReasons: ['Confirmation contains no machine-verifiable evidence references.'],
    };
  }

  const verifiedEvidence: VerifiedNemotronEvidence[] = [];
  const rejectionReasons: string[] = [];
  for (const [index, claim] of modelEvaluation.evidenceClaims.entries()) {
    if (
      normalizeIdentifier(claim.ownedValue) !==
      normalizeIdentifier(input.ownedProduct[claim.ownedField])
    ) {
      rejectionReasons.push(`Claim ${index} does not copy the supplied owned value.`);
      continue;
    }
    const verified =
      claim.sourceKind === 'scope' ? verifyScopeClaim(input, claim) : verifyRawClaim(input, claim);
    if (!verified) {
      rejectionReasons.push(
        `Claim ${index} could not be independently verified from its referenced authoritative source field.`,
      );
      continue;
    }
    if (
      normalizeIdentifier(claim.claimedOfficialValue) !==
      normalizeIdentifier(verified.officialValue)
    ) {
      rejectionReasons.push(`Claim ${index} does not copy the referenced official value.`);
      continue;
    }
    verifiedEvidence.push(verified);
  }
  if (rejectionReasons.length || !verifiedEvidence.length) {
    return {
      accepted: false,
      verifiedEvidence: [],
      rejectionReasons: rejectionReasons.length
        ? rejectionReasons
        : ['No strong evidence claim was independently verified.'],
    };
  }
  return { accepted: true, verifiedEvidence, rejectionReasons: [] };
}
