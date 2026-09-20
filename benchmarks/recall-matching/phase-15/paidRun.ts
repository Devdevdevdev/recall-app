import type { NemotronMatchingInput } from '../../../supabase/functions/_shared/matching/nemotronPrompt.ts';
import type { NebiusUsage } from '../../../supabase/functions/_shared/nebius/types.ts';
import type { JsonValue } from '../../../supabase/functions/_shared/matching/types.ts';

type Phase15CaseLike = {
  ownedProduct: NemotronMatchingInput['ownedProduct'];
};

type Phase15SourceLike = {
  sourceKey: string;
  authority: string;
  externalRecallId: string;
  officialUrl: string;
  referenceDate: string;
  title: string;
  productName: string;
  recallDate: string;
  matcherScopes: NemotronMatchingInput['officialRecall']['scopes'];
  scopeRules: JsonValue;
  scopeEvidence: { summary: string };
};

type Pricing = { inputRate: number; outputRate: number };

type TechnicalAttempt = {
  apiSucceeded: boolean;
  structuredOutputValid: boolean;
  failureKind: string | null;
  retries: number;
};

type OrderedBenchmarkCase = { caseId: string };
type HybridCheckpointCase = {
  caseId: string;
  predicted: string;
  decision: string;
  structuredOutputValid: boolean | null;
  orchestrationRetries: number;
  attemptHistory: Array<{
    apiSucceeded: boolean;
    structuredOutputValid: boolean;
    failureKind: string | null;
  }>;
  [key: string]: unknown;
};
type HybridStoppedCheckpoint = {
  stopped: boolean;
  reason: string;
  cases: HybridCheckpointCase[];
};

/** Projects a v2 case into the unchanged production Nemotron input boundary. */
export function projectPhase15Case(
  benchmarkCase: Phase15CaseLike,
  source: Phase15SourceLike,
): NemotronMatchingInput {
  return {
    ownedProduct: structuredClone(benchmarkCase.ownedProduct),
    officialRecall: {
      recallNoticeId: source.sourceKey,
      source: {
        authority: source.authority,
        externalId: source.externalRecallId,
        officialUrl: source.officialUrl,
        retrievedAt: source.referenceDate,
      },
      title: source.title,
      description: source.productName,
      hazard: null,
      remedy: null,
      recallDate: source.recallDate,
      scopes: structuredClone(source.matcherScopes),
      rawEvidence: {
        controlledScopeRules: structuredClone(source.scopeRules),
        evidenceSummary: source.scopeEvidence.summary,
      },
    },
  };
}

export function calculateActualCost(
  usage: Pick<NebiusUsage, 'inputTokens' | 'outputTokens'>,
  pricing: Pricing | null,
): number | null {
  if (!pricing || usage.inputTokens === null || usage.outputTokens === null) return null;
  return (
    (usage.inputTokens * pricing.inputRate + usage.outputTokens * pricing.outputRate) / 1_000_000
  );
}

export function enforcePaidRunGuardrails(input: {
  requests: number;
  requestCap: number;
  currentRunCostUsd: number | null;
  priorPaidCostUsd: number;
  combinedCostCapUsd: number;
}): void {
  if (input.requests > input.requestCap) {
    throw new Error(
      `Paid benchmark request cap exceeded: ${input.requests} > ${input.requestCap}.`,
    );
  }
  if (
    input.currentRunCostUsd !== null &&
    input.currentRunCostUsd + input.priorPaidCostUsd > input.combinedCostCapUsd
  ) {
    throw new Error(
      `Paid benchmark combined cost cap exceeded: USD ${(input.currentRunCostUsd + input.priorPaidCostUsd).toFixed(6)} > USD ${input.combinedCostCapUsd.toFixed(2)}.`,
    );
  }
}

export function addUsage(left: NebiusUsage, right: NebiusUsage): NebiusUsage {
  const add = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : a + b;
  return {
    inputTokens: add(left.inputTokens, right.inputTokens),
    outputTokens: add(left.outputTokens, right.outputTokens),
    totalTokens: add(left.totalTokens, right.totalTokens),
    reasoningTokens: add(left.reasoningTokens, right.reasoningTokens),
  };
}

export function summarizeTechnicalFailures(attempts: readonly TechnicalAttempt[]) {
  return {
    providerFailures: attempts.filter((attempt) => !attempt.apiSucceeded).length,
    timeouts: attempts.filter((attempt) => attempt.failureKind === 'timeout').length,
    invalidStructuredOutput: attempts.filter(
      (attempt) => attempt.apiSucceeded && !attempt.structuredOutputValid,
    ).length,
    retries: attempts.reduce((total, attempt) => total + attempt.retries, 0),
    exhaustedRetries: attempts.filter((attempt) => !attempt.apiSucceeded && attempt.retries >= 2)
      .length,
  };
}

/** Validates the separately authorized fail-closed resume boundary before any network request. */
export function validateHybridContinuationCheckpoint<T extends OrderedBenchmarkCase>(
  orderedCases: readonly T[],
  checkpoint: HybridStoppedCheckpoint,
) {
  if (!checkpoint.stopped || checkpoint.reason !== 'final_ai_technical_failure') {
    throw new Error('Hybrid continuation requires the original technical-failure checkpoint.');
  }
  if (checkpoint.cases.length !== 113 || orderedCases.length !== 200) {
    throw new Error('Hybrid continuation checkpoint case counts do not match authorization.');
  }
  const completedIds = checkpoint.cases.map((item) => item.caseId);
  const expectedCompletedIds = orderedCases
    .slice(0, checkpoint.cases.length)
    .map((item) => item.caseId);
  if (
    new Set(completedIds).size !== completedIds.length ||
    JSON.stringify(completedIds) !== JSON.stringify(expectedCompletedIds)
  ) {
    throw new Error('Hybrid continuation completed case IDs are duplicated or out of order.');
  }
  const exhaustedCase = checkpoint.cases.at(-1);
  if (
    !exhaustedCase ||
    exhaustedCase.caseId !== 'p15-hol-29-1' ||
    exhaustedCase.predicted !== 'needs_review' ||
    exhaustedCase.decision !== 'needs_review' ||
    exhaustedCase.structuredOutputValid !== false ||
    exhaustedCase.orchestrationRetries !== 1 ||
    exhaustedCase.attemptHistory.length !== 2 ||
    !exhaustedCase.attemptHistory.every(
      (attempt) =>
        attempt.apiSucceeded &&
        !attempt.structuredOutputValid &&
        attempt.failureKind === 'schema_violation',
    )
  ) {
    throw new Error('Authorized exhausted case is not finalized fail-closed as needs_review.');
  }
  return {
    completedCases: checkpoint.cases,
    remainingCases: orderedCases.slice(checkpoint.cases.length),
    exhaustedCase,
  };
}
