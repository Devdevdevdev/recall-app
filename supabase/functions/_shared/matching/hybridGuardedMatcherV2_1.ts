import { evaluateDeterministicMatchV2 } from './deterministicMatcherV2.ts';
import { validateGuardedAiDecisionV2_1 } from './guardedNemotronSchemaV2_1.ts';
import { verifyNemotronConfirmationV2_1 } from './nemotronSafetyVerifierV2_1.ts';
import type { OwnedProductEvidenceV2 } from './typesV2.ts';
import {
  HYBRID_GUARDED_MATCH_METHOD_V2_1,
  VERIFIER_VERSION_V2_1,
  type HybridGuardedResultV2_1,
  type OfficialRecallEvidenceV2_1,
} from './typesV2_1.ts';

type HybridInputV2_1 = {
  ownedProduct: OwnedProductEvidenceV2;
  officialRecall: OfficialRecallEvidenceV2_1;
};

type GuardedEvaluatorV2_1 = (input: HybridInputV2_1) => Promise<unknown>;

function failedEscalation(
  deterministic: ReturnType<typeof evaluateDeterministicMatchV2>,
  failure: 'provider_error' | 'schema_violation',
): HybridGuardedResultV2_1 {
  return {
    evaluation: {
      ...deterministic,
      decision: 'needs_review',
      reasoningSummary: 'AI escalation failed safely; review remains required.',
      matchMethod: HYBRID_GUARDED_MATCH_METHOD_V2_1,
    },
    trace: {
      deterministicDecision: deterministic.decision,
      aiEscalated: true,
      aiDecision: null,
      aiTechnicalFailure: failure,
      verifierVersion: VERIFIER_VERSION_V2_1,
      verifierAccepted: false,
      verifierRejectionReasons: ['AI output was unavailable or invalid.'],
    },
  };
}

export async function evaluateHybridGuardedMatchV2_1(
  input: HybridInputV2_1,
  evaluateAi: GuardedEvaluatorV2_1,
): Promise<HybridGuardedResultV2_1> {
  const deterministic = evaluateDeterministicMatchV2(input.ownedProduct, input.officialRecall);
  if (deterministic.decision !== 'needs_review') {
    return {
      evaluation: { ...deterministic, matchMethod: HYBRID_GUARDED_MATCH_METHOD_V2_1 },
      trace: {
        deterministicDecision: deterministic.decision,
        aiEscalated: false,
        aiDecision: null,
        aiTechnicalFailure: null,
        verifierVersion: VERIFIER_VERSION_V2_1,
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
  const aiDecision = validateGuardedAiDecisionV2_1(rawDecision);
  if (!aiDecision) return failedEscalation(deterministic, 'schema_violation');
  const verification = verifyNemotronConfirmationV2_1({ ...input, aiDecision });
  return {
    evaluation: {
      ...deterministic,
      decision: verification.accepted ? 'confirmed' : 'needs_review',
      confidence: verification.accepted ? 1 : deterministic.confidence,
      reasoningSummary: verification.accepted
        ? 'AI selected a supplied association whose mandatory claims were all recomputed locally.'
        : 'AI claims did not satisfy the v2.1 local verifier; review remains required.',
      matchMethod: HYBRID_GUARDED_MATCH_METHOD_V2_1,
    },
    trace: {
      deterministicDecision: deterministic.decision,
      aiEscalated: true,
      aiDecision: aiDecision.decision,
      aiTechnicalFailure: null,
      verifierVersion: VERIFIER_VERSION_V2_1,
      verifierAccepted: verification.accepted,
      verifierRejectionReasons: verification.rejectionReasons,
    },
  };
}
