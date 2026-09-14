import { mergeIdentifierEvidence } from './evidence.ts';
import {
  DETERMINISTIC_MATCH_METHOD,
  MATCH_EVALUATION_SCHEMA_VERSION,
  type MatchEvaluation,
  type ScopeEvaluation,
} from './types.ts';

export function aggregateScopeEvaluations(
  evaluations: readonly ScopeEvaluation[],
): MatchEvaluation {
  const relevant = evaluations.filter((evaluation) => evaluation.relevant);
  const confirmed = relevant.filter((evaluation) => evaluation.decision === 'confirmed');
  const unresolved = relevant.filter((evaluation) => evaluation.decision === 'needs_review');

  let decision: MatchEvaluation['decision'];
  let confidence: number;
  let reasoningSummary: string;

  if (confirmed.length) {
    decision = 'confirmed';
    confidence = Math.max(...confirmed.map((evaluation) => evaluation.confidence));
    reasoningSummary = `${confirmed.length} of ${evaluations.length} scopes provided strong compatible evidence; other scopes cannot override an exact compatible scope.`;
  } else if (unresolved.length) {
    decision = 'needs_review';
    confidence = Math.max(...unresolved.map((evaluation) => evaluation.confidence));
    reasoningSummary = `${unresolved.length} plausible scope(s) remain unresolved and no scope confirmed the match.`;
  } else if (
    relevant.length &&
    relevant.every((evaluation) => evaluation.decision === 'rejected')
  ) {
    decision = 'rejected';
    confidence = Math.min(...relevant.map((evaluation) => evaluation.confidence));
    reasoningSummary = `All ${relevant.length} relevant scope(s) contain concrete contradictory evidence.`;
  } else {
    decision = 'needs_review';
    confidence = 0;
    reasoningSummary = evaluations.length
      ? 'No scope supplied enough comparable evidence for a safe deterministic decision.'
      : 'The authoritative notice has no normalized scopes to evaluate.';
  }

  // Sibling recall scopes are alternatives. Once one scope confirms, expected mismatches from
  // other scopes are not notice-level identifier conflicts.
  const identifierEvaluations = confirmed.length ? confirmed : relevant;

  return {
    decision,
    confidence,
    matchedIdentifiers: mergeIdentifierEvidence(identifierEvaluations, 'matchedIdentifiers'),
    conflictingIdentifiers: mergeIdentifierEvidence(
      identifierEvaluations,
      'conflictingIdentifiers',
    ),
    evidenceUsed: evaluations.flatMap((evaluation) => evaluation.evidenceUsed),
    reasoningSummary,
    matchMethod: DETERMINISTIC_MATCH_METHOD,
    schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION,
  };
}
