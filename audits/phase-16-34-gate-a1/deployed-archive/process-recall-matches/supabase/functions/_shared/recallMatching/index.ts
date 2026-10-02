export { buildEvidenceFingerprint, PRODUCTION_MATCHING_POLICY_VERSION } from './fingerprint.ts';
export { processRecallMatches, safeMatchingSummary } from './orchestrator.ts';
export { projectAuthoritativeRecall, projectOwnedProduct } from './projection.ts';
export {
  DEFAULT_MATCHING_LIMITS,
  MAX_MATCHING_LIMITS,
  parseMatchingRunRequest,
} from './request.ts';
export type {
  AuthoritativeRecallRow,
  FinalizePairInput,
  FinalizePairResult,
  MatchingLimits,
  MatchingRunOptions,
  OwnedProductRow,
  PairClaim,
  RecallMatchingStore,
  RecallScopeRow,
} from './types.ts';
