import { canonicalCpscUrl } from './identity.ts';

export const CPSC_PAGE_MAX_BYTES = 1_000_000;
export const CPSC_PAGE_MAX_REDIRECTS = 3;
export const CPSC_PAGE_TIMEOUT_MS = 10_000;

export type CpscTransportSnapshot = {
  canonicalUrl: string;
  finalUrl: string;
  fetchedAt: string;
  status: 200;
  rawPageHash: string;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
  redirectChain: string[];
  html: string;
  rawBytes: Uint8Array;
};

/** Carries the HTTP status (when one was received) so failures can be recorded. */
export class CpscPageFetchError extends Error {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null = null) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

function redirectTarget(location: string | null, current: string): string {
  if (!location) throw new Error('CPSC redirect has no Location.');
  const target = new URL(location, current).href;
  canonicalCpscUrl(target);
  return target;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Worker-only: the URL comes from a validated canonical CPSC identity.
 *
 * The deadline covers the whole exchange (every redirect hop and the body). It
 * aborts the request and independently rejects, so a transport or stream that
 * ignores the abort signal still cannot hold the worker past the deadline.
 */
export async function fetchCpscOfficialPage(
  authoritativeUrl: string,
  fetchImpl: typeof fetch = fetch,
  options: { timeoutMs?: number } = {},
): Promise<CpscTransportSnapshot> {
  const timeoutMs = options.timeoutMs ?? CPSC_PAGE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CPSC_PAGE_TIMEOUT_MS) {
    throw new Error('CPSC page timeout is out of bounds.');
  }
  const canonicalUrl = canonicalCpscUrl(authoritativeUrl);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CpscPageFetchError('CPSC page fetch timed out.'));
    }, timeoutMs);
  });
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline]);
  try {
    return await bounded(fetchWithinDeadline(canonicalUrl, fetchImpl, controller.signal, bounded));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function fetchWithinDeadline(
  canonicalUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  bounded: <T>(work: Promise<T>) => Promise<T>,
): Promise<CpscTransportSnapshot> {
  let target = canonicalUrl;
  const redirectChain: string[] = [];
  for (let hop = 0; hop <= CPSC_PAGE_MAX_REDIRECTS; hop++) {
    canonicalCpscUrl(target);
    const response = await bounded(
      fetchImpl(target, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { accept: 'text/html' },
      }),
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === CPSC_PAGE_MAX_REDIRECTS) {
        throw new CpscPageFetchError('CPSC redirect limit exceeded.', response.status);
      }
      target = redirectTarget(response.headers.get('location'), target);
      redirectChain.push(target);
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new CpscPageFetchError(`CPSC page returned HTTP ${response.status}.`, response.status);
    }
    canonicalCpscUrl(response.url || target);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^text\/html(?:\s*;|$)/iu.test(contentType)) {
      throw new CpscPageFetchError('CPSC page content type is not HTML.', 200);
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > CPSC_PAGE_MAX_BYTES) {
      throw new CpscPageFetchError('CPSC page exceeds the response-size cap.', 200);
    }
    if (!response.body) throw new CpscPageFetchError('CPSC page has no response body.', 200);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await bounded(reader.read());
        if (done) break;
        size += value.byteLength;
        if (size > CPSC_PAGE_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new CpscPageFetchError('CPSC page exceeds the response-size cap.', 200);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const raw = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let html: string;
    try {
      html = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new CpscPageFetchError('CPSC page is not valid UTF-8.', 200);
    }
    return {
      canonicalUrl,
      finalUrl: canonicalCpscUrl(response.url || target),
      fetchedAt: new Date().toISOString(),
      status: 200,
      rawPageHash: hex(await crypto.subtle.digest('SHA-256', raw)),
      contentType,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      redirectChain,
      html,
      rawBytes: raw,
    };
  }
  throw new CpscPageFetchError('CPSC redirect limit exceeded.');
}
