import { lookupProduct } from './lookup.ts';
import type { ProductLookupCacheStore, ProductLookupProvider } from './types.ts';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Exactly `{ "gtin": "<string>" }`: the matching GTIN, nothing about the user or the scan. */
export function parseIdentifyProductRequest(value: unknown): { gtin: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object.');
  }
  const keys = Object.keys(value);
  const gtin = (value as Record<string, unknown>).gtin;
  if (keys.length !== 1 || keys[0] !== 'gtin' || typeof gtin !== 'string' || gtin.length > 14) {
    throw new Error('Request body must contain exactly one gtin string.');
  }
  return { gtin };
}

export type IdentifyProductDependencies = {
  /** Verifies the bearer token with the auth server; returns the user id or null. */
  authenticate(token: string): Promise<string | null>;
  /** Kill switch: false => OFF is never called. */
  enabled(): boolean;
  /** Null when the OFF User-Agent contact is not configured: OFF is then never called. */
  provider(): ProductLookupProvider | null;
  cache: ProductLookupCacheStore;
  now?: () => Date;
};

/**
 * `identify-product`: suggests a name and brand for one GTIN. The caller must be signed in (to
 * keep the endpoint from being an open proxy), but the user id is neither used, stored, logged
 * nor forwarded: OFF sees this function's address and the GTIN, never the user.
 */
export function createIdentifyProductHandler(deps: IdentifyProductDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return json(405, { error: 'Only POST is allowed.' });
    const token = BEARER.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
    if (!token) return json(401, { error: 'Unauthorized.' });
    let userId: string | null;
    try {
      userId = await deps.authenticate(token);
    } catch {
      userId = null;
    }
    if (!userId) return json(401, { error: 'Unauthorized.' });

    let gtin: string;
    try {
      gtin = parseIdentifyProductRequest(await request.json()).gtin;
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : 'Invalid request.' });
    }

    let provider: ProductLookupProvider;
    if (!deps.enabled()) {
      provider = async () => ({ status: 'unavailable', reason: 'disabled' });
    } else {
      provider =
        deps.provider() ?? (async () => ({ status: 'unavailable', reason: 'not_configured' }));
    }
    const result = await lookupProduct(gtin, { cache: deps.cache, provider, now: deps.now });
    return json(200, result);
  };
}
