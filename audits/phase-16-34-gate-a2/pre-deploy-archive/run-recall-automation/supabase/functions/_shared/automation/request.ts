import type { AutomationRunRequest } from './types.ts';

const hardMaximums = {
  maxRecalls: 100,
  maxCandidatePairs: 1_000,
  maxAiEscalations: 5,
  notificationBatchSize: 50,
} as const;

function optionalLimit(
  value: unknown,
  name: keyof typeof hardMaximums,
  minimum: number,
): number | null {
  if (value === undefined || value === null) return null;
  const maximum = hardMaximums[name];
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

export function parseAutomationRunRequest(value: unknown): AutomationRunRequest {
  if (value === null || value === undefined) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object.');
  }

  const input = value as Record<string, unknown>;
  const allowed = new Set([
    'trigger',
    'verificationMode',
    'maxRecalls',
    'maxCandidatePairs',
    'maxAiEscalations',
    'notificationBatchSize',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error('Request body contains unsupported fields.');
  }

  const trigger = input.trigger ?? 'manual';
  if (trigger !== 'cron' && trigger !== 'manual') {
    throw new Error('trigger must be cron or manual.');
  }
  const verificationMode = input.verificationMode ?? false;
  if (typeof verificationMode !== 'boolean') {
    throw new Error('verificationMode must be a boolean.');
  }

  const maxAiEscalations = optionalLimit(input.maxAiEscalations, 'maxAiEscalations', 0);
  if (verificationMode && maxAiEscalations !== null && maxAiEscalations !== 0) {
    throw new Error('verificationMode requires maxAiEscalations to be zero.');
  }

  return {
    trigger,
    verificationMode,
    maxRecalls: optionalLimit(input.maxRecalls, 'maxRecalls', 1),
    maxCandidatePairs: optionalLimit(input.maxCandidatePairs, 'maxCandidatePairs', 1),
    maxAiEscalations,
    notificationBatchSize: optionalLimit(input.notificationBatchSize, 'notificationBatchSize', 1),
  };
}
