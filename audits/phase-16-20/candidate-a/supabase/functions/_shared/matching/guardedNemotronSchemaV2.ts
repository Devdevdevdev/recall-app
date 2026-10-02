import type { MatchDecision } from './types.ts';
import type { GuardedAiDecisionV2 } from './typesV2.ts';

const decisions = new Set<MatchDecision>(['confirmed', 'rejected', 'needs_review']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateGuardedAiDecisionV2(value: unknown): GuardedAiDecisionV2 | null {
  if (!isRecord(value)) return null;
  const allowedKeys = new Set(['decision', 'claimedCriterionIds', 'reasoningSummary']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  if (!decisions.has(value.decision as MatchDecision)) return null;
  if (!Array.isArray(value.claimedCriterionIds) || value.claimedCriterionIds.length > 64) {
    return null;
  }
  if (
    value.claimedCriterionIds.some(
      (item) => typeof item !== 'string' || item.length === 0 || item.length > 200,
    ) ||
    new Set(value.claimedCriterionIds).size !== value.claimedCriterionIds.length
  ) {
    return null;
  }
  if (
    value.reasoningSummary !== undefined &&
    (typeof value.reasoningSummary !== 'string' || value.reasoningSummary.length > 1_000)
  ) {
    return null;
  }
  return {
    decision: value.decision as MatchDecision,
    claimedCriterionIds: value.claimedCriterionIds as string[],
    ...(typeof value.reasoningSummary === 'string'
      ? { reasoningSummary: value.reasoningSummary }
      : {}),
  };
}
