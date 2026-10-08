import { canonicalGtin14 } from '../matching/gtin.ts';

import { cleanSuggestedBrand, cleanSuggestedName, offAttribution } from './quality.ts';
import type { ProductLookupProvider, ProductLookupProviderOutcome } from './types.ts';

/**
 * Open Food Facts family, API v3, `product_type=all` (Phase 17.3b decision). Read-only, no key,
 * no cookie. The request carries the matching GTIN in the path and the User-Agent header, and
 * nothing else: no user, account, device, inventory, lot, serial or date data.
 */
export const OFF_ENDPOINT = 'https://world.openfoodfacts.org/api/v3/product/';
export const OFF_FIELDS = ['code', 'product_name', 'product_name_en', 'product_name_fr', 'brands'];
/** Phase 17.3b chain: provider timeout 1 500 ms. One attempt, never retried. */
export const OFF_TIMEOUT_MS = 1_500;
/** Phase 17.3b section 10: after a 429 or repeated failures, OFF is not called for 5 minutes. */
export const OFF_CIRCUIT_OPEN_MS = 5 * 60 * 1000;
export const OFF_CIRCUIT_FAILURE_THRESHOLD = 3;

export const RECALL_USER_AGENT_NAME = 'Recall';
export const RECALL_USER_AGENT_VERSION = '1.0.0';

// Reserved documentation/test domains (RFC 2606, RFC 6761): never a deployable contact.
const RESERVED_CONTACT = /(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test|localhost)$/iu;
const CONTACT_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;

/**
 * Official OFF API introduction (openfoodfacts.github.io/openfoodfacts-server/api/, read
 * 2026-10-08): "The User-Agent should be in the form of AppName/Version (ContactEmail)".
 * The contact is a project mailbox configured by the operator, never a user's address. A missing,
 * malformed or reserved (example/test) contact yields null, and OFF is then never called.
 */
export function offUserAgent(contactEmail: string | null | undefined): string | null {
  const contact = contactEmail?.trim() ?? '';
  if (contact.length > 254 || !CONTACT_EMAIL.test(contact)) return null;
  if (RESERVED_CONTACT.test(contact.split('@')[1] ?? '')) return null;
  return `${RECALL_USER_AGENT_NAME}/${RECALL_USER_AGENT_VERSION} (${contact})`;
}

export function offProductUrl(providerGtin: string): string {
  return `${OFF_ENDPOINT}${providerGtin}?product_type=all&fields=${OFF_FIELDS.join(',')}`;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type OffProviderOptions = {
  fetch: FetchLike;
  userAgent: string;
  timeoutMs?: number;
  now?: () => number;
};

/** Interprets one OFF v3 response. Pure: no I/O, no clock. */
export async function interpretOffResponse(
  response: Response,
  requestedUrl: string,
  key: string,
): Promise<ProductLookupProviderOutcome> {
  if (response.status === 429) return { status: 'unavailable', reason: 'rate_limited' };

  // `product_type=all` may redirect to a sister database; only the OFF family is accepted.
  let host: string;
  try {
    host = new URL(response.url || requestedUrl).host;
  } catch {
    return { status: 'unavailable', reason: 'invalid_response' };
  }

  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return { status: 'unavailable', reason: response.ok ? 'invalid_response' : 'http_error' };
  }
  const record =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const resultId =
    record.result && typeof record.result === 'object'
      ? (record.result as Record<string, unknown>).id
      : undefined;

  if (response.status === 404 || resultId === 'product_not_found') return { status: 'not_found' };
  if (response.status !== 200) return { status: 'unavailable', reason: 'http_error' };

  const code = typeof record.code === 'string' ? record.code : '';
  const product =
    record.product && typeof record.product === 'object' && !Array.isArray(record.product)
      ? (record.product as Record<string, unknown>)
      : null;
  // The answer must describe the GTIN that was asked for (OFF may re-pad it, never change it).
  if (!product || canonicalGtin14(code) !== key) {
    return { status: 'unavailable', reason: 'invalid_response' };
  }
  const attribution = offAttribution(host, code);
  if (!attribution) return { status: 'unavailable', reason: 'invalid_response' };

  const name =
    cleanSuggestedName(product.product_name) ??
    cleanSuggestedName(product.product_name_en) ??
    cleanSuggestedName(product.product_name_fr);
  const brand = cleanSuggestedBrand(product.brands);
  // An existing but empty record is "not found", never a guess.
  if (name === null && brand === null) return { status: 'not_found' };
  return { status: name && brand ? 'found' : 'partial', name, brand, attribution };
}

/**
 * OFF provider with a timeout and a small circuit breaker. Every failure is an `unavailable`
 * outcome (never thrown, never cached); there is no retry and no fallback provider.
 */
export function createOpenFoodFactsProvider(options: OffProviderOptions): ProductLookupProvider {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? OFF_TIMEOUT_MS;
  let openUntil = 0;
  let consecutiveFailures = 0;

  return async (providerGtin, key) => {
    if (now() < openUntil) return { status: 'unavailable', reason: 'circuit_open' };
    const url = offProductUrl(providerGtin);
    let outcome: ProductLookupProviderOutcome;
    try {
      const response = await options.fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { Accept: 'application/json', 'User-Agent': options.userAgent },
        signal: AbortSignal.timeout(timeoutMs),
      });
      outcome = await interpretOffResponse(response, url, key);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      outcome = {
        status: 'unavailable',
        reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      };
    }

    if (outcome.status !== 'unavailable') {
      consecutiveFailures = 0;
    } else if (outcome.reason === 'rate_limited') {
      openUntil = now() + OFF_CIRCUIT_OPEN_MS;
    } else if (++consecutiveFailures >= OFF_CIRCUIT_FAILURE_THRESHOLD) {
      consecutiveFailures = 0;
      openUntil = now() + OFF_CIRCUIT_OPEN_MS;
    }
    return outcome;
  };
}
