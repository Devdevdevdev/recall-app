import type { MatchingLimits, MatchingRunOptions } from './types.ts';

export const DEFAULT_MATCHING_LIMITS: Readonly<MatchingLimits> = {
  maxRecalls: 20,
  maxCandidatePairs: 200,
  maxNebiusCalls: 10,
};

export const MAX_MATCHING_LIMITS: Readonly<MatchingLimits> = {
  maxRecalls: 100,
  maxCandidatePairs: 1_000,
  maxNebiusCalls: 100,
};

function limit(
  value: unknown,
  name: keyof MatchingLimits,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}.`);
  }
  return Number(value);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function optionalUuid(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
  return value.toLowerCase();
}

function recallNoticeIds(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error('recallNoticeIds must contain between 1 and 100 UUIDs.');
  }
  const ids = value.map((item) => optionalUuid(item, 'Each recallNoticeIds value'));
  return [...new Set(ids as string[])];
}

export function parseMatchingRunRequest(value: unknown): MatchingRunOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object.');
  }
  const input = value as Record<string, unknown>;
  return {
    maxRecalls: limit(
      input.maxRecalls,
      'maxRecalls',
      DEFAULT_MATCHING_LIMITS.maxRecalls,
      MAX_MATCHING_LIMITS.maxRecalls,
    ),
    maxCandidatePairs: limit(
      input.maxCandidatePairs,
      'maxCandidatePairs',
      DEFAULT_MATCHING_LIMITS.maxCandidatePairs,
      MAX_MATCHING_LIMITS.maxCandidatePairs,
    ),
    maxNebiusCalls: limit(
      input.maxNebiusCalls,
      'maxNebiusCalls',
      DEFAULT_MATCHING_LIMITS.maxNebiusCalls,
      MAX_MATCHING_LIMITS.maxNebiusCalls,
    ),
    afterRecallId: optionalUuid(input.afterRecallId, 'afterRecallId'),
    recallNoticeIds: recallNoticeIds(input.recallNoticeIds),
  };
}
