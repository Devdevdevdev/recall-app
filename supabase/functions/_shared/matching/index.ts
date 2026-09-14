export { aggregateScopeEvaluations } from './aggregation.ts';
export { retrieveRecallCandidates } from './candidateRetrieval.ts';
export { evaluateDeterministicMatch } from './deterministicMatcher.ts';
export { evaluateRecallScope } from './evidence.ts';
export {
  createGuardedNebiusEvaluator,
  evaluateHybridGuardedMatch,
  HYBRID_GUARDED_MAX_ORCHESTRATION_RETRIES,
  type HybridGuardedEvaluation,
  type HybridGuardedResult,
  type HybridGuardedTrace,
} from './hybridGuardedMatcher.ts';
export {
  evaluateGuardedNemotronMatch,
  GUARDED_NEMOTRON_MAX_OUTPUT_TOKENS,
  GUARDED_NEMOTRON_RESULT_TOOL_NAME,
  type GuardedNemotronAttempt,
  type GuardedNemotronFailureKind,
} from './guardedNemotronMatcher.ts';
export {
  buildGuardedNemotronMessages,
  GUARDED_NEMOTRON_SYSTEM_PROMPT,
} from './guardedNemotronPrompt.ts';
export {
  GUARDED_CLAIM_CRITERIA,
  GUARDED_NEMOTRON_OUTPUT_SCHEMA,
  GUARDED_SOURCE_FIELDS,
  validateGuardedNemotronOutput,
  type GuardedEvidenceClaim,
  type GuardedNemotronOutput,
} from './guardedNemotronSchema.ts';
export {
  verifyNemotronConfirmation,
  type NemotronConfirmationVerification,
  type VerifiedNemotronEvidence,
} from './nemotronSafetyVerifier.ts';
export {
  evaluateNemotronMatch,
  extractNebiusUsage,
  NEMOTRON_MAX_OUTPUT_TOKENS,
  NEMOTRON_RESULT_TOOL_NAME,
  NEMOTRON_STRUCTURED_OUTPUT_METHOD,
  NEMOTRON_TEMPERATURE,
  type NemotronAttempt,
  type NemotronFailureKind,
} from './nemotronMatcher.ts';
export {
  buildNemotronMessages,
  NEMOTRON_SYSTEM_PROMPT,
  type NemotronMatchingInput,
} from './nemotronPrompt.ts';
export {
  NEMOTRON_MATCH_OUTPUT_SCHEMA,
  validateNemotronOutput,
  type ParsedNemotronOutput,
} from './nemotronSchema.ts';
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
  GUARDED_NEMOTRON_PROMPT_VERSION,
  HYBRID_GUARDED_MATCH_METHOD,
  MATCH_EVALUATION_SCHEMA_VERSION,
  NEBIUS_AI_PROVIDER,
  NEMOTRON_MATCH_METHOD,
  NEMOTRON_PROMPT_VERSION,
  type CandidateSignal,
  type DeterministicMatchEvaluation,
  type IdentifierEvidence,
  type MatchDecision,
  type MatchEvaluation,
  type MatchEvaluationCore,
  type MatchEvidence,
  type OfficialRecallEvidence,
  type OfficialRecallScopeEvidence,
  type NemotronMatchEvaluation,
  type OwnedProductEvidence,
  type RecallCandidate,
  type ScopeEvaluation,
} from './types.ts';
