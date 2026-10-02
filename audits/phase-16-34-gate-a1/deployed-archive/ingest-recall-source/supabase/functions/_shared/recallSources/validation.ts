import type { JsonObject, JsonValue, RecallSourceRetrievalRequest } from './types.ts';

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && Object.values(value).every(isJsonValue);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === 'object' && isJsonValue(value);
}

export function dateOnlyFromSource(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const dateOnly = value.slice(0, 10);
  if (!datePattern.test(dateOnly)) return null;
  const parsed = new Date(`${dateOnly}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateOnly
    ? null
    : dateOnly;
}

export function validateRetrievalRequest(
  request: RecallSourceRetrievalRequest,
  limits: { maximumWindowDays: number; maximumRecords: number },
): void {
  const startDate = dateOnlyFromSource(request.startDate);
  const endDate = dateOnlyFromSource(request.endDate);
  if (!startDate || startDate !== request.startDate || !endDate || endDate !== request.endDate) {
    throw new Error('Source retrieval dates must use valid YYYY-MM-DD values.');
  }
  if (startDate > endDate)
    throw new Error('Source retrieval start date must not be after end date.');
  const days =
    Math.floor(
      (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1;
  if (days > limits.maximumWindowDays) {
    throw new Error(`Source retrieval exceeds the ${limits.maximumWindowDays}-day window.`);
  }
  if (
    !Number.isInteger(request.maxRecords) ||
    request.maxRecords < 1 ||
    request.maxRecords > limits.maximumRecords
  ) {
    throw new Error(`Source retrieval maxRecords must be between 1 and ${limits.maximumRecords}.`);
  }
}

export function isOfficialHttpsUrl(value: string, host: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === host.toLowerCase() &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
