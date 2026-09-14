export { aggregateScopeEvaluations } from './aggregation.ts';
export { retrieveRecallCandidates } from './candidateRetrieval.ts';
export { evaluateDeterministicMatch } from './deterministicMatcher.ts';
export { evaluateRecallScope } from './evidence.ts';
export {
  compareIdentifierRange,
  isValidGtin,
  normalizeGtin,
  normalizeIdentifier,
  normalizeProductName,
  productNameOverlap,
  productNameTokens,
} from './normalization.ts';
export {
  DETERMINISTIC_MATCH_METHOD,
  MATCH_EVALUATION_SCHEMA_VERSION,
  type CandidateSignal,
  type IdentifierEvidence,
  type MatchDecision,
  type MatchEvaluation,
  type MatchEvidence,
  type OfficialRecallEvidence,
  type OfficialRecallScopeEvidence,
  type OwnedProductEvidence,
  type RecallCandidate,
  type ScopeEvaluation,
} from './types.ts';
