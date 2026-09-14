import {
  compareIdentifierRange,
  isValidGtin,
  normalizeGtin,
  normalizeIdentifier,
  productNameOverlap,
} from './normalization.ts';
import type {
  CandidateSignal,
  OfficialRecallEvidence,
  OwnedProductEvidence,
  RecallCandidate,
} from './types.ts';

export type CandidateRetrievalOptions = {
  minimumNameOverlap?: number;
  maxCandidates?: number;
};

function retrievalPriority(candidate: RecallCandidate): number {
  if (candidate.signals.some((signal) => signal.kind === 'exact_gtin')) {
    return 4;
  }
  if (
    candidate.signals.some(
      (signal) => signal.kind === 'exact_serial' || signal.kind === 'exact_lot',
    )
  ) {
    return 3;
  }
  if (candidate.signals.some((signal) => signal.kind === 'exact_model')) {
    return 2;
  }
  return 1;
}

function manufacturerTextMatches(
  owned: OwnedProductEvidence,
  recall: OfficialRecallEvidence,
): boolean {
  const brand = normalizeIdentifier(owned.brand);
  if (!brand) {
    return false;
  }

  return recall.scopes.some((scope) => {
    const names = scope.additionalCriteria?.manufacturer_names;
    return (
      Array.isArray(names) &&
      names.some((name) => typeof name === 'string' && normalizeIdentifier(name)?.includes(brand))
    );
  });
}

/**
 * Conservative in-memory retrieval reference. A production data adapter should first use indexed
 * exact GTIN/model queries, then bounded name retrieval, and pass the resulting evidence here.
 */
export function retrieveRecallCandidates(
  owned: OwnedProductEvidence,
  recalls: readonly OfficialRecallEvidence[],
  options: CandidateRetrievalOptions = {},
): readonly RecallCandidate[] {
  const minimumNameOverlap = options.minimumNameOverlap ?? 0.15;
  const maxCandidates = options.maxCandidates ?? 100;
  const ownedGtin = normalizeGtin(owned.gtin);
  const ownedModel = normalizeIdentifier(owned.modelNumber);
  const ownedSerial = normalizeIdentifier(owned.serialNumber);
  const ownedLot = normalizeIdentifier(owned.lotNumber);

  return recalls
    .flatMap((recall): RecallCandidate[] => {
      const signals: CandidateSignal[] = [];
      if (
        ownedGtin &&
        isValidGtin(ownedGtin) &&
        recall.scopes.some((scope) => {
          const official = normalizeGtin(scope.gtin);
          return official === ownedGtin && isValidGtin(official);
        })
      ) {
        signals.push({ kind: 'exact_gtin', score: 1, detail: 'Exact valid GTIN candidate.' });
      }
      if (
        ownedModel &&
        recall.scopes.some((scope) => normalizeIdentifier(scope.modelNumber) === ownedModel)
      ) {
        signals.push({
          kind: 'exact_model',
          score: 0.85,
          detail: 'Exact normalized model candidate.',
        });
      }
      if (
        ownedSerial &&
        recall.scopes.some(
          (scope) =>
            normalizeIdentifier(scope.serialNumber) === ownedSerial ||
            compareIdentifierRange(ownedSerial, scope.serialFrom, scope.serialTo) === 'inside',
        )
      ) {
        signals.push({
          kind: 'exact_serial',
          score: 0.9,
          detail: 'Exact or safely ranged serial candidate.',
        });
      }
      if (
        ownedLot &&
        recall.scopes.some(
          (scope) =>
            normalizeIdentifier(scope.lotNumber) === ownedLot ||
            compareIdentifierRange(ownedLot, scope.lotFrom, scope.lotTo) === 'inside',
        )
      ) {
        signals.push({
          kind: 'exact_lot',
          score: 0.9,
          detail: 'Exact or safely ranged lot candidate.',
        });
      }

      const nameScore = Math.max(
        productNameOverlap(owned.productName, recall.title),
        ...recall.scopes.map((scope) => productNameOverlap(owned.productName, scope.productName)),
      );
      if (nameScore >= minimumNameOverlap) {
        signals.push({
          kind: 'name_overlap',
          score: Math.min(0.6, nameScore),
          detail: `Product-name token overlap ${nameScore.toFixed(3)}.`,
        });
      }
      if (manufacturerTextMatches(owned, recall)) {
        signals.push({
          kind: 'manufacturer_text',
          score: 0.1,
          detail: 'Brand text appears in manufacturer context; this is retrieval-only evidence.',
        });
      }
      if (!signals.length) {
        return [];
      }

      return [
        {
          recall,
          retrievalScore: Math.min(
            1,
            signals.reduce((sum, signal) => sum + signal.score, 0),
          ),
          signals,
        },
      ];
    })
    .sort(
      (left, right) =>
        retrievalPriority(right) - retrievalPriority(left) ||
        right.retrievalScore - left.retrievalScore ||
        left.recall.source.externalId.localeCompare(right.recall.source.externalId),
    )
    .slice(0, maxCandidates);
}
