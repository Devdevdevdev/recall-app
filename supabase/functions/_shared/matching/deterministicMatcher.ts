import { aggregateScopeEvaluations } from './aggregation.ts';
import { evaluateRecallScope } from './evidence.ts';
import type { MatchEvaluation, OfficialRecallEvidence, OwnedProductEvidence } from './types.ts';

/** Pure deterministic_v1 evaluation. It performs no I/O, persistence, alerting, or text inference. */
export function evaluateDeterministicMatch(
  ownedProduct: OwnedProductEvidence,
  officialRecall: OfficialRecallEvidence,
): MatchEvaluation {
  const evaluations = officialRecall.scopes.map((scope, index) =>
    evaluateRecallScope(ownedProduct, officialRecall, scope, index),
  );
  return aggregateScopeEvaluations(evaluations);
}
