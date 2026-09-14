import { CPSC_API_ROOT } from './validation.ts';
import type { CpscIngestionRequest } from './types.ts';

const requestTimeoutMs = 15_000;
const maxResponseBytes = 8 * 1024 * 1024;

export function buildCpscRecallUrl({ startDate, endDate }: CpscIngestionRequest): URL {
  const url = new URL(CPSC_API_ROOT);
  url.searchParams.set('format', 'json');
  url.searchParams.set('LastPublishDateStart', startDate);
  url.searchParams.set('LastPublishDateEnd', endDate);
  return url;
}

export async function fetchCpscRecalls(request: CpscIngestionRequest): Promise<readonly unknown[]> {
  const url = buildCpscRecallUrl(request);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`CPSC returned HTTP ${response.status}.`);
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
      throw new Error('CPSC response exceeded the allowed size.');
    }

    const body = await response.arrayBuffer();
    if (body.byteLength > maxResponseBytes) {
      throw new Error('CPSC response exceeded the allowed size.');
    }

    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!Array.isArray(parsed)) {
      throw new Error('CPSC returned an unexpected JSON response shape.');
    }

    return parsed;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('CPSC request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
