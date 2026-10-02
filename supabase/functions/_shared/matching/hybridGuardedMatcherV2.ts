import { evaluateDeterministicMatchV2 } from './deterministicMatcherV2.ts';
import { validateGuardedAiDecisionV2 } from './guardedNemotronSchemaV2.ts';
import { verifyNemotronConfirmationV2 } from './nemotronSafetyVerifierV2.ts';
import {
  HYBRID_GUARDED_MATCH_METHOD_V2,
  type HybridGuardedResultV2,
  type OfficialRecallEvidenceV2,
  type OwnedProductEvidenceV2,
} from './typesV2.ts';

type HybridInputV2 = {
  ownedProduct: OwnedProductEvidenceV2;
  officialRecall: OfficialRecallEvidenceV2;
};

type GuardedEvaluatorV2 = (input: HybridInputV2) => Promise<unknown>;

function failedEscalation(
  deterministic: ReturnType<typeof evaluateDeterministicMatchV2>,
  failure: 'provider_error' | 'schema_violation',
): HybridGuardedResultV2 {
  return {
    evaluation: {
      ...deterministic,
      decision: 'needs_review',
      reasoningSummary: 'AI escalation failed safely; review remains required.',
      matchMethod: HYBRID_GUARDED_MATCH_METHOD_V2,
    },
    trace: {
      deterministicDecision: deterministic.decision,
      aiEscalated: true,
      aiDecision: null,
      aiTechnicalFailure: failure,
      verifierAccepted: false,
      verifierRejectionReasons: ['AI output was unavailable or invalid.'],
    },
  };
}

export async function evaluateHybridGuardedMatchV2(
  input: HybridInputV2,
  evaluateAi: GuardedEvaluatorV2,
): Promise<HybridGuardedResultV2> {
  const deterministic = evaluateDeterministicMatchV2(input.ownedProduct, input.officialRecall);
  if (deterministic.decision !== 'needs_review') {
    return {
      evaluation: { ...deterministic, matchMethod: HYBRID_GUARDED_MATCH_METHOD_V2 },
      trace: {
        deterministicDecision: deterministic.decision,
        aiEscalated: false,
        aiDecision: null,
        aiTechnicalFailure: null,
        verifierAccepted: false,
        verifierRejectionReasons: [],
      },
    };
  }

  let rawDecision: unknown;
  try {
    rawDecision = await evaluateAi(input);
  } catch {
    return failedEscalation(deterministic, 'provider_error');
  }
  const aiDecision = validateGuardedAiDecisionV2(rawDecision);
  if (!aiDecision) return failedEscalation(deterministic, 'schema_violation');
  const verification = verifyNemotronConfirmationV2({ ...input, aiDecision });
  return {
    evaluation: {
      ...deterministic,
      decision: verification.accepted ? 'confirmed' : 'needs_review',
      confidence: verification.accepted ? 1 : deterministic.confidence,
      reasoningSummary: verification.accepted
        ? 'AI confirmation was accepted only after local v2 criterion verification.'
        : 'AI could not satisfy the local v2 safety verifier; review remains required.',
      matchMethod: HYBRID_GUARDED_MATCH_METHOD_V2,
    },
    trace: {
      deterministicDecision: deterministic.decision,
      aiEscalated: true,
      aiDecision: aiDecision.decision,
      aiTechnicalFailure: null,
      verifierAccepted: verification.accepted,
      verifierRejectionReasons: verification.rejectionReasons,
    },
  };
}
