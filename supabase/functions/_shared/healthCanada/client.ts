import type {
  JsonObject,
  RecallSourceRetrievalRequest,
  RecallSourceRetrievalResult,
} from '../recallSources/types.ts';
import { dateOnlyFromSource, isJsonObject } from '../recallSources/validation.ts';
import type { HealthCanadaRecord } from './types.ts';

export const HEALTH_CANADA_DATA_URL =
  'https://recalls-rappels.canada.ca/sites/default/files/opendata-donneesouvertes/HCRSAMOpenData.json';

const maximumResponseBytes = 24 * 1024 * 1024;
const requestTimeoutMs = 30_000;
const cacheVersionParameter = 'recall_snapshot_date';
const diagnosticHeaderNames = [
  'content-type',
  'content-length',
  'etag',
  'last-modified',
  'cache-control',
  'age',
  'cf-cache-status',
  'x-cache',
  'x-cache-hits',
  'x-served-by',
  'via',
] as const;

function isHealthCanadaRecord(value: unknown): value is HealthCanadaRecord {
  if (!isJsonObject(value)) return false;
  return [
    'NID',
    'Title',
    'URL',
    'Organization',
    'Product',
    'Issue',
    'What you should do',
    'Category',
    'Recall class',
    'Last updated',
    'Archived',
  ].every((key) => typeof value[key] === 'string');
}

export function healthCanadaDataUrl(request: RecallSourceRetrievalRequest): string {
  const url = new URL(HEALTH_CANADA_DATA_URL);
  url.searchParams.set(cacheVersionParameter, request.endDate);
  return url.toString();
}

export function filterHealthCanadaRecords(
  records: readonly JsonObject[],
  request: RecallSourceRetrievalRequest,
): JsonObject[] {
  return records.filter((record) => {
    const updated = record['Last updated'];
    return (
      typeof updated === 'string' && updated >= request.startDate && updated <= request.endDate
    );
  });
}

async function sha256Hex(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function responseHeaders(response: Response): JsonObject {
  return Object.fromEntries(
    diagnosticHeaderNames.flatMap((name) => {
      const value = response.headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  );
}

export async function fetchHealthCanadaSnapshot(
  request: RecallSourceRetrievalRequest,
  fetchImplementation: typeof fetch = fetch,
): Promise<RecallSourceRetrievalResult<HealthCanadaRecord>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImplementation(healthCanadaDataUrl(request), {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Health Canada returned HTTP ${response.status}.`);
    const contentLengthHeader = response.headers.get('content-length');
    const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
    if (
      contentLength !== null &&
      Number.isFinite(contentLength) &&
      contentLength > maximumResponseBytes
    ) {
      throw new Error('Health Canada response exceeded the allowed size.');
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > maximumResponseBytes) {
      throw new Error('Health Canada response exceeded the allowed size.');
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!Array.isArray(parsed)) {
      throw new Error('Health Canada returned an unexpected JSON response shape.');
    }
    if (!parsed.every(isJsonObject)) {
      throw new Error('Health Canada returned a record with an unexpected schema.');
    }
    const records = filterHealthCanadaRecords(parsed, request);
    if (!records.every(isHealthCanadaRecord)) {
      throw new Error('Health Canada returned an in-window record with an unexpected schema.');
    }
    records.sort((left, right) =>
      left['Last updated'] === right['Last updated']
        ? left.NID.localeCompare(right.NID)
        : left['Last updated'].localeCompare(right['Last updated']),
    );
    if (records.length > request.maxRecords) {
      throw new Error('Health Canada response exceeds the bounded automation record limit.');
    }
    const updateDates = parsed.flatMap((record) => {
      const date = dateOnlyFromSource(record['Last updated']);
      return date ? [date] : [];
    });
    updateDates.sort();
    return {
      records,
      diagnostics: {
        status: response.status,
        finalUrl: response.url,
        headers: responseHeaders(response),
        bodyBytes: body.byteLength,
        bodySha256: await sha256Hex(body),
        totalParsedRecords: parsed.length,
        minimumParsedUpdateDate: updateDates[0] ?? null,
        maximumParsedUpdateDate: updateDates.at(-1) ?? null,
        windowRecordCount: records.length,
      },
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Health Canada request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchHealthCanadaRecalls(
  request: RecallSourceRetrievalRequest,
): Promise<readonly HealthCanadaRecord[]> {
  return (await fetchHealthCanadaSnapshot(request)).records;
}
