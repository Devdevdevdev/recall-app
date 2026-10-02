import type { RecallSourceRetrievalRequest } from '../recallSources/types.ts';
import { isJsonObject } from '../recallSources/validation.ts';
import type { HealthCanadaRecord } from './types.ts';

export const HEALTH_CANADA_DATA_URL =
  'https://recalls-rappels.canada.ca/sites/default/files/opendata-donneesouvertes/HCRSAMOpenData.json';

const maximumResponseBytes = 24 * 1024 * 1024;
const requestTimeoutMs = 30_000;

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

export async function fetchHealthCanadaRecalls(
  request: RecallSourceRetrievalRequest,
): Promise<readonly HealthCanadaRecord[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(HEALTH_CANADA_DATA_URL, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Health Canada returned HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maximumResponseBytes) {
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
    const records = parsed.filter((record) => {
      const updated = record['Last updated'];
      return (
        typeof updated === 'string' && updated >= request.startDate && updated <= request.endDate
      );
    });
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
    return records;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Health Canada request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
