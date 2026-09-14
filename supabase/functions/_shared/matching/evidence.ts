import {
  compareIdentifierRange,
  isValidGtin,
  normalizeGtin,
  normalizeIdentifier,
  productNameOverlap,
} from './normalization.ts';
import type {
  IdentifierEvidence,
  IdentifierKind,
  MatchEvidence,
  OfficialRecallEvidence,
  OfficialRecallScopeEvidence,
  OwnedProductEvidence,
  ScopeEvaluation,
} from './types.ts';

type MutableIdentifierEvidence = Partial<Record<IdentifierKind, string[]>>;

function addIdentifier(
  target: MutableIdentifierEvidence,
  kind: IdentifierKind,
  value: string,
): void {
  const values = target[kind] ?? [];
  if (!values.includes(value)) {
    values.push(value);
  }
  target[kind] = values;
}

function evidence(scopeIndex: number, input: Omit<MatchEvidence, 'scopeIndex'>): MatchEvidence {
  return { scopeIndex, ...input };
}

function hasComplexCriteria(scope: OfficialRecallScopeEvidence): boolean {
  const criteria = scope.additionalCriteria;
  if (!criteria) {
    return false;
  }

  return Object.keys(criteria).some(
    (key) => !['association', 'evidence_level', 'manufacturer_names'].includes(key),
  );
}

function evaluateExactIdentifier(
  scopeIndex: number,
  kind: Exclude<IdentifierKind, 'gtin'>,
  ownedValue: string | null,
  officialValue: string | null | undefined,
  matched: MutableIdentifierEvidence,
  conflicting: MutableIdentifierEvidence,
  items: MatchEvidence[],
): void {
  const owned = normalizeIdentifier(ownedValue);
  const official = normalizeIdentifier(officialValue);
  if (!owned || !official) {
    return;
  }

  if (owned === official) {
    addIdentifier(matched, kind, owned);
    items.push(
      evidence(scopeIndex, {
        kind,
        outcome: 'matched',
        strength: 'strong',
        ownedValue: owned,
        officialValue: official,
        detail: `Exact normalized ${kind} match.`,
      }),
    );
  } else {
    addIdentifier(conflicting, kind, `${owned} != ${official}`);
    items.push(
      evidence(scopeIndex, {
        kind,
        outcome: 'conflicting',
        strength: 'strong',
        ownedValue: owned,
        officialValue: official,
        detail: `Explicit normalized ${kind} mismatch.`,
      }),
    );
  }
}

function evaluateRange(
  scopeIndex: number,
  kind: 'serialNumber' | 'lotNumber',
  value: string | null,
  from: string | null | undefined,
  to: string | null | undefined,
  matched: MutableIdentifierEvidence,
  conflicting: MutableIdentifierEvidence,
  items: MatchEvidence[],
): void {
  const comparison = compareIdentifierRange(value, from, to);
  const normalizedValue = normalizeIdentifier(value);
  const range = `${normalizeIdentifier(from) ?? '?'}..${normalizeIdentifier(to) ?? '?'}`;
  if (!normalizedValue || comparison === 'unavailable') {
    return;
  }
  if (comparison === 'inside') {
    addIdentifier(matched, kind, normalizedValue);
    items.push(
      evidence(scopeIndex, {
        kind,
        outcome: 'matched',
        strength: 'strong',
        ownedValue: normalizedValue,
        officialValue: range,
        detail: `${kind} is within a safely comparable official range.`,
      }),
    );
  } else if (comparison === 'outside') {
    addIdentifier(conflicting, kind, `${normalizedValue} outside ${range}`);
    items.push(
      evidence(scopeIndex, {
        kind,
        outcome: 'conflicting',
        strength: 'strong',
        ownedValue: normalizedValue,
        officialValue: range,
        detail: `${kind} is outside a safely comparable official range.`,
      }),
    );
  } else {
    items.push(
      evidence(scopeIndex, {
        kind,
        outcome: 'unresolved',
        strength: 'contextual',
        ownedValue: normalizedValue,
        officialValue: range,
        detail: `${kind} range cannot be compared safely without manufacturer-specific semantics.`,
      }),
    );
  }
}

export function evaluateRecallScope(
  owned: OwnedProductEvidence,
  recall: OfficialRecallEvidence,
  scope: OfficialRecallScopeEvidence,
  scopeIndex: number,
): ScopeEvaluation {
  const matched: MutableIdentifierEvidence = {};
  const conflicting: MutableIdentifierEvidence = {};
  const items: MatchEvidence[] = [];

  const ownedGtin = normalizeGtin(owned.gtin);
  const officialGtin = normalizeGtin(scope.gtin);
  if (owned.gtin && scope.gtin) {
    if (ownedGtin && officialGtin && isValidGtin(ownedGtin) && isValidGtin(officialGtin)) {
      if (ownedGtin === officialGtin) {
        addIdentifier(matched, 'gtin', ownedGtin);
        items.push(
          evidence(scopeIndex, {
            kind: 'gtin',
            outcome: 'matched',
            strength: 'strong',
            ownedValue: ownedGtin,
            officialValue: officialGtin,
            detail: 'Exact valid GTIN match in an authoritative recall scope.',
          }),
        );
      } else {
        addIdentifier(conflicting, 'gtin', `${ownedGtin} != ${officialGtin}`);
        items.push(
          evidence(scopeIndex, {
            kind: 'gtin',
            outcome: 'conflicting',
            strength: 'strong',
            ownedValue: ownedGtin,
            officialValue: officialGtin,
            detail: 'Both GTINs are valid and explicitly differ.',
          }),
        );
      }
    } else {
      items.push(
        evidence(scopeIndex, {
          kind: 'gtin',
          outcome: 'unresolved',
          strength: 'contextual',
          ownedValue: owned.gtin,
          officialValue: scope.gtin,
          detail: 'A provided GTIN is not a valid GTIN-8, GTIN-12, GTIN-13, or GTIN-14.',
        }),
      );
    }
  }

  evaluateExactIdentifier(
    scopeIndex,
    'modelNumber',
    owned.modelNumber,
    scope.modelNumber,
    matched,
    conflicting,
    items,
  );
  evaluateExactIdentifier(
    scopeIndex,
    'serialNumber',
    owned.serialNumber,
    scope.serialNumber,
    matched,
    conflicting,
    items,
  );
  evaluateExactIdentifier(
    scopeIndex,
    'lotNumber',
    owned.lotNumber,
    scope.lotNumber,
    matched,
    conflicting,
    items,
  );
  if (!scope.serialNumber) {
    evaluateRange(
      scopeIndex,
      'serialNumber',
      owned.serialNumber,
      scope.serialFrom,
      scope.serialTo,
      matched,
      conflicting,
      items,
    );
  }
  if (!scope.lotNumber) {
    evaluateRange(
      scopeIndex,
      'lotNumber',
      owned.lotNumber,
      scope.lotFrom,
      scope.lotTo,
      matched,
      conflicting,
      items,
    );
  }

  const nameScore = productNameOverlap(owned.productName, scope.productName);
  if (owned.productName && scope.productName) {
    items.push(
      evidence(scopeIndex, {
        kind: 'productName',
        outcome: nameScore > 0 ? 'supporting' : 'conflicting',
        strength: 'supporting',
        ownedValue: owned.productName,
        officialValue: scope.productName,
        detail: `Product-name Jaccard token overlap is ${nameScore.toFixed(3)}.`,
      }),
    );
  }

  const ownedBrand = normalizeIdentifier(owned.brand);
  const officialBrand = normalizeIdentifier(scope.brand);
  if (ownedBrand && officialBrand) {
    items.push(
      evidence(scopeIndex, {
        kind: 'brand',
        outcome: ownedBrand === officialBrand ? 'supporting' : 'conflicting',
        strength: 'supporting',
        ownedValue: ownedBrand,
        officialValue: officialBrand,
        detail:
          ownedBrand === officialBrand
            ? 'Explicit scope brand matches as supporting evidence.'
            : 'Explicit scope brand differs.',
      }),
    );
  }

  const manufacturerNames = scope.additionalCriteria?.manufacturer_names;
  if (owned.brand && Array.isArray(manufacturerNames) && manufacturerNames.length) {
    items.push(
      evidence(scopeIndex, {
        kind: 'manufacturerContext',
        outcome: 'supporting',
        strength: 'contextual',
        ownedValue: owned.brand,
        officialValue: manufacturerNames.filter((value) => typeof value === 'string').join('; '),
        detail:
          'Manufacturer names are contextual only and are not treated as authoritative brand equality.',
      }),
    );
  }

  if (owned.purchaseDate && (scope.manufacturedFrom || scope.manufacturedTo)) {
    items.push(
      evidence(scopeIndex, {
        kind: 'purchaseDateContext',
        outcome: 'unresolved',
        strength: 'contextual',
        ownedValue: owned.purchaseDate,
        officialValue: `${scope.manufacturedFrom ?? '?'}..${scope.manufacturedTo ?? '?'}`,
        detail:
          'Purchase date is not manufacture date and is not compared to this manufacturing range.',
      }),
    );
  }

  const containsComplexCriteria = hasComplexCriteria(scope);
  if (containsComplexCriteria) {
    items.push(
      evidence(scopeIndex, {
        kind: 'additionalCriteria',
        outcome: 'unresolved',
        strength: 'contextual',
        detail: 'Structured additional criteria require interpretation beyond deterministic_v1.',
      }),
    );
  }

  const matchedKinds = Object.keys(matched) as IdentifierKind[];
  const conflictKinds = Object.keys(conflicting) as IdentifierKind[];
  const hasGtinMatch = Boolean(matched.gtin?.length);
  const hasSerialOrLotMatch = Boolean(matched.serialNumber?.length || matched.lotNumber?.length);
  const hasModelMatch = Boolean(matched.modelNumber?.length);
  const hasStrongConflict = conflictKinds.length > 0;
  const hasExplicitBrandConflict = Boolean(
    ownedBrand && officialBrand && ownedBrand !== officialBrand,
  );
  const hasAmbiguousRange = items.some(
    (item) =>
      item.outcome === 'unresolved' && (item.kind === 'serialNumber' || item.kind === 'lotNumber'),
  );
  if (
    (hasStrongConflict || hasExplicitBrandConflict || containsComplexCriteria) &&
    matchedKinds.length > 0
  ) {
    return {
      scopeIndex,
      relevant: true,
      decision: 'needs_review',
      confidence: 0.75,
      matchedIdentifiers: matched,
      conflictingIdentifiers: conflicting,
      evidenceUsed: items,
      reasoningSummary: hasStrongConflict
        ? 'This scope contains conflicting structured identifiers.'
        : hasExplicitBrandConflict
          ? 'An identifier matches, but the explicit scope brand conflicts.'
          : 'An identifier matches, but additional structured criteria remain unresolved.',
    };
  }
  if (hasGtinMatch) {
    return {
      scopeIndex,
      relevant: true,
      decision: 'confirmed',
      confidence: 1,
      matchedIdentifiers: matched,
      conflictingIdentifiers: conflicting,
      evidenceUsed: items,
      reasoningSummary: 'An exact valid GTIN matched an authoritative recall scope.',
    };
  }
  if (hasSerialOrLotMatch) {
    return {
      scopeIndex,
      relevant: true,
      decision: 'confirmed',
      confidence: 0.96,
      matchedIdentifiers: matched,
      conflictingIdentifiers: conflicting,
      evidenceUsed: items,
      reasoningSummary: 'An exact or safely ranged serial/lot identifier matched.',
    };
  }
  if (hasModelMatch && nameScore >= 0.35) {
    return {
      scopeIndex,
      relevant: true,
      decision: 'confirmed',
      confidence: 0.9,
      matchedIdentifiers: matched,
      conflictingIdentifiers: conflicting,
      evidenceUsed: items,
      reasoningSummary: 'An exact model matched with compatible product-name evidence.',
    };
  }
  if (hasModelMatch || hasAmbiguousRange) {
    return {
      scopeIndex,
      relevant: true,
      decision: 'needs_review',
      confidence: hasModelMatch ? 0.72 : 0.5,
      matchedIdentifiers: matched,
      conflictingIdentifiers: conflicting,
      evidenceUsed: items,
      reasoningSummary: hasModelMatch
        ? 'The model matches, but surrounding product identity is insufficient.'
        : 'The serial/lot range cannot be interpreted safely.',
    };
  }
  if (hasStrongConflict) {
    return {
      scopeIndex,
      relevant: true,
      decision: 'rejected',
      confidence: conflicting.gtin?.length ? 0.98 : 0.92,
      matchedIdentifiers: matched,
      conflictingIdentifiers: conflicting,
      evidenceUsed: items,
      reasoningSummary: 'Explicit structured identifiers contradict this scope.',
    };
  }
  if (nameScore > 0 || (ownedBrand && officialBrand && ownedBrand === officialBrand)) {
    return {
      scopeIndex,
      relevant: true,
      decision: 'needs_review',
      confidence: Math.min(0.65, 0.35 + nameScore * 0.3),
      matchedIdentifiers: matched,
      conflictingIdentifiers: conflicting,
      evidenceUsed: items,
      reasoningSummary: 'Descriptive evidence is plausible but cannot confirm a recalled product.',
    };
  }

  return {
    scopeIndex,
    relevant: false,
    decision: 'rejected',
    confidence: 0.4,
    matchedIdentifiers: matched,
    conflictingIdentifiers: conflicting,
    evidenceUsed: items,
    reasoningSummary: `Scope ${scopeIndex + 1} has no comparable plausible evidence for this product or ${recall.source.authority}.`,
  };
}

export function mergeIdentifierEvidence(
  evaluations: readonly ScopeEvaluation[],
  property: 'matchedIdentifiers' | 'conflictingIdentifiers',
): IdentifierEvidence {
  const merged: MutableIdentifierEvidence = {};
  for (const evaluation of evaluations) {
    for (const [kind, values] of Object.entries(evaluation[property]) as Array<
      [IdentifierKind, readonly string[]]
    >) {
      for (const value of values) {
        addIdentifier(merged, kind, value);
      }
    }
  }
  return merged;
}
