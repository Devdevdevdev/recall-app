import type { NebiusUsage } from '../nebius/types.ts';
import {
  type GuardedNemotronAttempt,
  evaluateGuardedNemotronMatch,
  type GuardedNemotronClient,
} from './guardedNemotronMatcher.ts';
import type { GuardedEvidenceClaim } from './guardedNemotronSchema.ts';
import { evaluateDeterministicMatch } from './deterministicMatcher.ts';
import type { NemotronMatchingInput } from './nemotronPrompt.ts';
import {
  verifyNemotronConfirmation,
  type VerifiedNemotronEvidence,
} from './nemotronSafetyVerifier.ts';
import {
  GUARDED_NEMOTRON_PROMPT_VERSION,
  HYBRID_GUARDED_MATCH_METHOD,
  MATCH_EVALUATION_SCHEMA_VERSION,
  NEBIUS_AI_PROVIDER,
  type IdentifierEvidence,
  type MatchEvaluationCore,
} from './types.ts';

export const HYBRID_GUARDED_MAX_ORCHESTRATION_RETRIES = 1;

export type HybridGuardedEvaluation = MatchEvaluationCore & {
  matchMethod: typeof HYBRID_GUARDED_MATCH_METHOD;
  schemaVersion: typeof MATCH_EVALUATION_SCHEMA_VERSION;
};

export type HybridGuardedTrace = {
  deterministicDecision: 'confirmed' | 'rejected' | 'needs_review';
  deterministicEscalationReason: string | null;
  aiEscalated: boolean;
  aiModel: string | null;
  aiProvider: typeof NEBIUS_AI_PROVIDER | null;
  promptVersion: typeof GUARDED_NEMOTRON_PROMPT_VERSION | null;
  aiDecision: 'confirmed' | 'rejected' | 'needs_review' | null;
  aiTechnicalFailure: GuardedNemotronAttempt['failureKind'];
  nemotronReasoningSummary: string | null;
  nemotronClaimedEvidence: readonly GuardedEvidenceClaim[];
  verifierConfirmedEvidence: readonly VerifiedNemotronEvidence[];
  verifierRejectionReasons: readonly string[];
};

export type HybridGuardedResult = {
  evaluation: HybridGuardedEvaluation;
  trace: HybridGuardedTrace;
  nemotronRequestCount: number;
  orchestrationRetries: number;
  transportRetries: number;
  structuredOutputValid: boolean | null;
  attemptHistory: readonly {
    apiSucceeded: boolean;
    structuredOutputValid: boolean;
    failureKind: GuardedNemotronAttempt['failureKind'];
    latencyMs: number;
    usage: NebiusUsage;
  }[];
  latencyMs: number;
  nemotronLatencyMs: number;
  usage: NebiusUsage;
  usageComplete: boolean;
};

type GuardedEvaluator = (input: NemotronMatchingInput) => Promise<GuardedNemotronAttempt>;

const zeroUsage: NebiusUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: null,
};

function addUsage(left: NebiusUsage, right: NebiusUsage): NebiusUsage {
  const add = (a: number | null, b: number | null): number | null =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: add(left.inputTokens, right.inputTokens),
    outputTokens: add(left.outputTokens, right.outputTokens),
    totalTokens: add(left.totalTokens, right.totalTokens),
    reasoningTokens: add(left.reasoningTokens, right.reasoningTokens),
  };
}

function hybridEvaluation(core: MatchEvaluationCore): HybridGuardedEvaluation {
  return {
    ...core,
    matchMethod: HYBRID_GUARDED_MATCH_METHOD,
    schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION,
  };
}

function verifiedIdentifiers(evidence: readonly VerifiedNemotronEvidence[]): IdentifierEvidence {
  const values: Partial<Record<'gtin' | 'modelNumber' | 'serialNumber' | 'lotNumber', string[]>> =
    {};
  for (const item of evidence) {
    const kind =
      item.criterion === 'serialPrefix' || item.criterion === 'serialRange'
        ? 'serialNumber'
        : item.criterion === 'lotRange'
          ? 'lotNumber'
          : item.criterion;
    const existing = values[kind] ?? [];
    if (!existing.includes(item.ownedValue)) existing.push(item.ownedValue);
    values[kind] = existing;
  }
  return values;
}

function baseTrace(
  deterministicDecision: HybridGuardedTrace['deterministicDecision'],
  deterministicEscalationReason: string | null,
): HybridGuardedTrace {
  return {
    deterministicDecision,
    deterministicEscalationReason,
    aiEscalated: false,
    aiModel: null,
    aiProvider: null,
    promptVersion: null,
    aiDecision: null,
    aiTechnicalFailure: null,
    nemotronReasoningSummary: null,
    nemotronClaimedEvidence: [],
    verifierConfirmedEvidence: [],
    verifierRejectionReasons: [],
  };
}

export async function evaluateHybridGuardedMatch(
  input: NemotronMatchingInput,
  evaluateNemotron: GuardedEvaluator,
  modelId: string,
): Promise<HybridGuardedResult> {
  const startedAt = performance.now();
  const deterministic = evaluateDeterministicMatch(input.ownedProduct, input.officialRecall);
  if (deterministic.decision !== 'needs_review') {
    return {
      evaluation: hybridEvaluation(deterministic),
      trace: baseTrace(deterministic.decision, null),
      nemotronRequestCount: 0,
      orchestrationRetries: 0,
      transportRetries: 0,
      structuredOutputValid: null,
      attemptHistory: [],
      latencyMs: performance.now() - startedAt,
      nemotronLatencyMs: 0,
      usage: { ...zeroUsage },
      usageComplete: true,
    };
  }

  const attempts: GuardedNemotronAttempt[] = [];
  let attempt = await evaluateNemotron(input);
  attempts.push(attempt);
  if (attempt.retryEligible && HYBRID_GUARDED_MAX_ORCHESTRATION_RETRIES === 1) {
    attempt = await evaluateNemotron(input);
    attempts.push(attempt);
  }
  const usage = attempts.reduce<NebiusUsage>((total, item) => addUsage(total, item.usage), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    reasoningTokens: null,
  });
  const usageComplete = attempts.every(
    (item) =>
      item.usage.inputTokens !== null &&
      item.usage.outputTokens !== null &&
      item.usage.totalTokens !== null,
  );
  const nemotronLatencyMs = attempts.reduce((total, item) => total + item.latencyMs, 0);
  const transportRetries = attempts.reduce((total, item) => total + item.transportRetries, 0);
  const trace: HybridGuardedTrace = {
    ...baseTrace(deterministic.decision, deterministic.reasoningSummary),
    aiEscalated: true,
    aiModel: modelId,
    aiProvider: NEBIUS_AI_PROVIDER,
    promptVersion: GUARDED_NEMOTRON_PROMPT_VERSION,
    aiDecision: attempt.output?.decision ?? null,
    aiTechnicalFailure: attempt.failureKind,
    nemotronReasoningSummary: attempt.output?.reasoningSummary ?? null,
    nemotronClaimedEvidence: attempt.output?.evidenceClaims ?? [],
  };
  const attemptHistory = attempts.map((item) => ({
    apiSucceeded: item.apiSucceeded,
    structuredOutputValid: item.structuredOutputValid,
    failureKind: item.failureKind,
    latencyMs: item.latencyMs,
    usage: item.usage,
  }));

  if (!attempt.output) {
    return {
      evaluation: hybridEvaluation({
        decision: 'needs_review',
        confidence: 0,
        matchedIdentifiers: {},
        conflictingIdentifiers: {},
        evidenceUsed: deterministic.evidenceUsed,
        reasoningSummary: 'AI escalation failed safely; human review is required.',
      }),
      trace,
      nemotronRequestCount: attempts.length,
      orchestrationRetries: attempts.length - 1,
      transportRetries,
      structuredOutputValid: false,
      attemptHistory,
      latencyMs: performance.now() - startedAt,
      nemotronLatencyMs,
      usage,
      usageComplete,
    };
  }

  if (attempt.output.decision !== 'confirmed') {
    return {
      evaluation: hybridEvaluation({
        decision: 'needs_review',
        confidence: attempt.output.confidence,
        matchedIdentifiers: {},
        conflictingIdentifiers: {},
        evidenceUsed: deterministic.evidenceUsed,
        reasoningSummary:
          attempt.output.decision === 'rejected'
            ? 'AI rejection is advisory and lacks an independent deterministic contradiction.'
            : 'AI escalation remained unresolved; human review is required.',
      }),
      trace,
      nemotronRequestCount: attempts.length,
      orchestrationRetries: attempts.length - 1,
      transportRetries,
      structuredOutputValid: true,
      attemptHistory,
      latencyMs: performance.now() - startedAt,
      nemotronLatencyMs,
      usage,
      usageComplete,
    };
  }

  const verification = verifyNemotronConfirmation(input, attempt.output);
  trace.verifierConfirmedEvidence = verification.verifiedEvidence;
  trace.verifierRejectionReasons = verification.rejectionReasons;
  return {
    evaluation: hybridEvaluation({
      decision: verification.accepted ? 'confirmed' : 'needs_review',
      confidence: verification.accepted ? attempt.output.confidence : 0,
      matchedIdentifiers: verifiedIdentifiers(verification.verifiedEvidence),
      conflictingIdentifiers: {},
      evidenceUsed: deterministic.evidenceUsed,
      reasoningSummary: verification.accepted
        ? 'Nemotron confirmation was accepted only after deterministic verification of authoritative evidence references.'
        : 'Nemotron confirmation could not be independently verified; human review is required.',
    }),
    trace,
    nemotronRequestCount: attempts.length,
    orchestrationRetries: attempts.length - 1,
    transportRetries,
    structuredOutputValid: true,
    attemptHistory,
    latencyMs: performance.now() - startedAt,
    nemotronLatencyMs,
    usage,
    usageComplete,
  };
}

export function createGuardedNebiusEvaluator(
  client: GuardedNemotronClient,
  modelId: string,
): GuardedEvaluator {
  return (input) => evaluateGuardedNemotronMatch(input, client, modelId);
}
