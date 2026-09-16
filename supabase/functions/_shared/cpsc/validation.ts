import type { CpscIngestionRequest, JsonObject, JsonValue } from './types.ts';

export const CPSC_API_ROOT = 'https://www.saferproducts.gov/RestWebServices/Recall';
export const CPSC_OFFICIAL_HOST = 'www.cpsc.gov';
export const MAX_INGESTION_DAYS = 31;
export const MAX_INGESTION_RECORDS = 100;

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

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value !== 'object') {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === 'object' && isJsonValue(value);
}

export function dateOnlyFromSource(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const dateOnly = value.slice(0, 10);
  if (!datePattern.test(dateOnly)) {
    return null;
  }

  const parsed = new Date(`${dateOnly}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateOnly
    ? null
    : dateOnly;
}

export function requireDateOnly(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !datePattern.test(value) ||
    dateOnlyFromSource(value) !== value
  ) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date.`);
  }

  return value;
}

export function parseCpscIngestionRequest(value: unknown): CpscIngestionRequest {
  if (!isJsonObject(value)) {
    throw new Error('Request body must be a JSON object.');
  }

  const startDate = requireDateOnly(value.startDate, 'startDate');
  const endDate = requireDateOnly(value.endDate, 'endDate');
  const dryRun = value.dryRun === undefined ? true : value.dryRun;

  if (typeof dryRun !== 'boolean') {
    throw new Error('dryRun must be a boolean.');
  }

  if (startDate > endDate) {
    throw new Error('startDate must not be after endDate.');
  }

  const dayCount =
    Math.floor(
      (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1;
  if (dayCount > MAX_INGESTION_DAYS) {
    throw new Error(`The requested window exceeds the ${MAX_INGESTION_DAYS}-day maximum.`);
  }

  let maxRecords: number | undefined;
  if (value.maxRecords !== undefined) {
    if (
      !Number.isInteger(value.maxRecords) ||
      Number(value.maxRecords) < 1 ||
      Number(value.maxRecords) > MAX_INGESTION_RECORDS
    ) {
      throw new Error(`maxRecords must be an integer between 1 and ${MAX_INGESTION_RECORDS}.`);
    }
    maxRecords = Number(value.maxRecords);
  }

  return maxRecords === undefined
    ? { startDate, endDate, dryRun }
    : { startDate, endDate, dryRun, maxRecords };
}

export function isCpscOfficialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === CPSC_OFFICIAL_HOST &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function validateGtin(value: string): boolean {
  const normalized = value.trim();
  if (!/^\d{8}$|^\d{12,14}$/u.test(normalized)) {
    return false;
  }

  const body = normalized.slice(0, -1);
  const expectedCheckDigit = Number(normalized.at(-1));
  const weightedSum = [...body]
    .reverse()
    .reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);

  return (10 - (weightedSum % 10)) % 10 === expectedCheckDigit;
}
