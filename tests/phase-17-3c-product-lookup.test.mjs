// Phase 17.3c: OFF-only product lookup. Name/brand suggestion for ProductForm, never recall
// evidence. No network (OFF is a fake fetch), no database, no AI.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { toScannedBarcode } from '../src/domain/barcode.ts';
import {
  emptyProductFormValues,
  validateProductForm,
} from '../src/features/products/productFormUtils.ts';
import {
  applyLookupSuggestion,
  productLookupNotice,
} from '../src/features/products/productLookupPrefill.ts';
import {
  createKeyValueProductLookupCache,
  createMemoryProductLookupCache,
  NEGATIVE_TTL_MS,
  parseCacheEntry,
  POSITIVE_TTL_MS,
} from '../supabase/functions/_shared/productLookup/cache.ts';
import {
  isRcn8,
  productLookupEligibility,
} from '../supabase/functions/_shared/productLookup/eligibility.ts';
import { createIdentifyProductHandler } from '../supabase/functions/_shared/productLookup/handler.ts';
import {
  lookupProduct,
  providerOutcomeFromResult,
} from '../supabase/functions/_shared/productLookup/lookup.ts';
import {
  createOpenFoodFactsProvider,
  OFF_CIRCUIT_OPEN_MS,
  offProductUrl,
  offUserAgent,
} from '../supabase/functions/_shared/productLookup/openFoodFacts.ts';
import {
  cleanSuggestedBrand,
  cleanSuggestedName,
} from '../supabase/functions/_shared/productLookup/quality.ts';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const NUTELLA = '3017620422003';
const NUTELLA_KEY = '03017620422003';
const RCN_8 = '27044193';
const EAN_8 = '96385074';
// Explicitly non-deployable placeholder (RFC 6761 `.invalid`): offUserAgent() refuses it.
const TEST_USER_AGENT = 'Recall/1.0.0 (product-lookup-tests@example.invalid)';
const T0 = new Date('2026-10-08T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms) => () => new Date(T0.getTime() + ms);

const offBody = (code, product) => ({
  code,
  status: 'success',
  result: { id: 'product_found' },
  product,
});
const jsonResponse = (status, body) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const redirectTo = (location, status = 302) =>
  new Response(null, { status, headers: location ? { location } : {} });

/** Fake OFF: records every request, answers with the queued responses (or a factory). */
function fakeFetch(...answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(url, init) : answer.clone();
  };
  return { fetch, calls };
}

/** Cache wrapper counting reads and writes. */
function spyCache(inner = createMemoryProductLookupCache()) {
  const spy = { gets: 0, sets: [] };
  spy.store = {
    get: async (key) => {
      spy.gets += 1;
      return inner.get(key);
    },
    set: async (entry) => {
      spy.sets.push(entry);
      return inner.set(entry);
    },
  };
  return spy;
}

function offProvider(fetch, now = () => T0.getTime()) {
  return createOpenFoodFactsProvider({ fetch, userAgent: TEST_USER_AGENT, now });
}

const nutellaFound = jsonResponse(
  200,
  offBody(NUTELLA, { product_name: 'Nutella', brands: 'Nutella, Ferrero' }),
);

// ---------------------------------------------------------------------------------------------
// A. Eligible GTIN + OFF found

test('A: eligible GTIN + OFF found => name and brand suggested, attributed, only the GTIN sent', async () => {
  const { fetch, calls } = fakeFetch(nutellaFound);
  const cache = spyCache();
  const result = await lookupProduct(NUTELLA, {
    cache: cache.store,
    provider: offProvider(fetch),
    now: () => T0,
  });

  assert.equal(result.status, 'found');
  assert.equal(result.name, 'Nutella');
  assert.equal(result.brand, 'Nutella');
  assert.equal(result.key, NUTELLA_KEY);
  assert.equal(result.cache, 'miss');
  assert.deepEqual(result.attribution, {
    provider: 'open_food_facts',
    database: 'openfoodfacts',
    sourceName: 'Open Food Facts',
    sourceUrl: `https://world.openfoodfacts.org/product/${NUTELLA}`,
    license: { database: 'ODbL-1.0', contents: 'DbCL-1.0', images: 'CC-BY-SA-3.0' },
  });

  // Exactly one OFF v3 request, product_type=all, the matching GTIN, a UA, nothing else.
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://world.openfoodfacts.org/api/v3/product/${NUTELLA}?product_type=all&fields=code,product_name,product_name_en,product_name_fr,brands`,
  );
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(calls[0].init.headers['User-Agent'], TEST_USER_AGENT);

  const form = { ...emptyProductFormValues(T0), gtin: NUTELLA };
  const { values, applied } = applyLookupSuggestion(form, new Set(), result);
  assert.equal(values.productName, 'Nutella');
  assert.equal(values.brand, 'Nutella');
  assert.deepEqual(applied, { productName: 'Nutella', brand: 'Nutella' });
  assert.equal(productLookupNotice(result, values).kind, 'attribution');
});

test('A: product_type=all redirect to a sister database is attributed to that database', async () => {
  const sister = 'https://world.openbeautyfacts.org/api/v3/product/3700509700124?product_type=all';
  const { fetch, calls } = fakeFetch(
    redirectTo(sister),
    jsonResponse(
      200,
      offBody('3700509700124', { product_name: 'Shampooing', brands: 'Activilong' }),
    ),
  );
  const outcome = await offProvider(fetch)('3700509700124', '03700509700124');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, sister);
  assert.equal(calls[1].init.redirect, 'manual');
  assert.equal(outcome.status, 'found');
  assert.equal(outcome.attribution.database, 'openbeautyfacts');
  assert.equal(outcome.attribution.sourceName, 'Open Beauty Facts');
  assert.equal(
    outcome.attribution.sourceUrl,
    'https://world.openbeautyfacts.org/product/3700509700124',
  );
});

test('A: UPC-E scan sends its expanded UPC-A and keys the cache on the canonical GTIN-14', async () => {
  const scanned = toScannedBarcode('upc_e', '04252614');
  const { fetch, calls } = fakeFetch(
    jsonResponse(200, offBody('0042100005264', { product_name: 'Cereal', brands: 'Brand' })),
  );
  const result = await lookupProduct(scanned.matchingGtin, {
    cache: createMemoryProductLookupCache(),
    provider: offProvider(fetch),
    now: () => T0,
  });
  assert.equal(result.key, scanned.canonicalGtin14);
  assert.equal(result.key, '00042100005264');
  assert.match(calls[0].url, /\/product\/042100005264\?/u);
});

// ---------------------------------------------------------------------------------------------
// B. Eligible GTIN + OFF not found

test('B: OFF not found (404 or empty record) => not_found, negative cache, manual entry', async () => {
  for (const response of [
    jsonResponse(404, { code: NUTELLA, result: { id: 'product_not_found' } }),
    jsonResponse(200, offBody(NUTELLA, { product_name: '', brands: '' })),
    jsonResponse(200, offBody(NUTELLA, { product_name: 'unknown', brands: 'N/A' })),
  ]) {
    const cache = spyCache();
    const result = await lookupProduct(NUTELLA, {
      cache: cache.store,
      provider: offProvider(fakeFetch(response).fetch),
      now: () => T0,
    });
    assert.equal(result.status, 'not_found');
    assert.equal(cache.sets.length, 1);
    assert.equal(cache.sets[0].status, 'not_found');
    assert.equal(cache.sets[0].attribution, null);
    assert.equal(Date.parse(cache.sets[0].expiresAt) - T0.getTime(), NEGATIVE_TTL_MS);

    const form = { ...emptyProductFormValues(T0), gtin: NUTELLA };
    assert.equal(applyLookupSuggestion(form, new Set(), result).values, form);
    assert.match(productLookupNotice(result, form).text, /Enter the name and brand yourself/u);
    const saved = validateProductForm({ ...form, productName: 'My spread' });
    assert.equal(saved.input?.productName, 'My spread');
    assert.equal(saved.input?.brand, null);
  }
});

// ---------------------------------------------------------------------------------------------
// C. OFF failure never blocks product creation

test('C: every OFF failure is `unavailable`, never cached, never thrown, never blocks saving', async () => {
  const timeout = new DOMException('The operation timed out.', 'TimeoutError');
  const failures = [
    [timeout, 'timeout'],
    [new TypeError('fetch failed'), 'network'],
    [jsonResponse(500, 'Internal Server Error'), 'http_error'],
    [jsonResponse(503, { error: 'busy' }), 'http_error'],
    [jsonResponse(429, 'Too Many Requests'), 'rate_limited'],
    [jsonResponse(200, '<html>not json</html>'), 'invalid_response'],
    [jsonResponse(200, { code: NUTELLA, result: { id: 'product_found' } }), 'invalid_response'],
    [jsonResponse(200, offBody('5400141472714', { product_name: 'Other' })), 'invalid_response'],
    [redirectTo('https://evil.test/x'), 'invalid_response'],
  ];
  for (const [answer, reason] of failures) {
    const cache = spyCache();
    const result = await lookupProduct(NUTELLA, {
      cache: cache.store,
      provider: offProvider(fakeFetch(answer).fetch),
      now: () => T0,
    });
    assert.deepEqual(result, { status: 'unavailable', reason }, String(reason));
    assert.equal(cache.sets.length, 0);
  }

  const thrown = await lookupProduct(NUTELLA, {
    cache: createMemoryProductLookupCache(),
    provider: async () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(thrown, { status: 'unavailable', reason: 'network' });

  const brokenCache = {
    get: async () => {
      throw new Error('storage');
    },
    set: async () => {
      throw new Error('storage');
    },
  };
  const stillFound = await lookupProduct(NUTELLA, {
    cache: brokenCache,
    provider: offProvider(fakeFetch(nutellaFound).fetch),
  });
  assert.equal(stillFound.status, 'found');

  const form = { ...emptyProductFormValues(T0), gtin: NUTELLA, productName: 'Spread' };
  const unavailable = { status: 'unavailable', reason: 'timeout' };
  assert.equal(applyLookupSuggestion(form, new Set(), unavailable).values, form);
  assert.match(productLookupNotice(unavailable, form).text, /unavailable/u);
  assert.equal(validateProductForm(form).input?.productName, 'Spread');
});

test('C: redirects are followed only over HTTPS to OFF family hosts, at most 3 hops', async () => {
  const off = 'https://world.openfoodfacts.org/api/v3/product/1';
  const refused = [
    'https://evil.test/x',
    'http://world.openbeautyfacts.org/x',
    'https://world.openbeautyfacts.org:8443/x',
    'https://world.openbeautyfacts.org.evil.test/x',
    'https://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    null,
  ];
  for (const location of refused) {
    const { fetch, calls } = fakeFetch(redirectTo(location), nutellaFound);
    const outcome = await offProvider(fetch)(NUTELLA, NUTELLA_KEY);
    assert.deepEqual(outcome, { status: 'unavailable', reason: 'invalid_response' }, location);
    assert.equal(calls.length, 1, String(location));
  }

  const loop = fakeFetch(redirectTo(off));
  assert.equal((await offProvider(loop.fetch)(NUTELLA, NUTELLA_KEY)).reason, 'invalid_response');
  assert.equal(loop.calls.length, 4);
  assert.equal(
    loop.calls.every(({ url }) => url.startsWith('https://world.openfoodfacts.org/')),
    true,
  );
});

test('C: one attempt, no retry; 429 or 3 failures open the circuit for 5 minutes', async () => {
  let clock = T0.getTime();
  const rateLimited = fakeFetch(jsonResponse(429, ''), nutellaFound);
  const provider = offProvider(rateLimited.fetch, () => clock);
  assert.equal((await provider(NUTELLA, NUTELLA_KEY)).reason, 'rate_limited');
  assert.equal(rateLimited.calls.length, 1);
  assert.equal((await provider(NUTELLA, NUTELLA_KEY)).reason, 'circuit_open');
  assert.equal(rateLimited.calls.length, 1);
  clock += OFF_CIRCUIT_OPEN_MS;
  assert.equal((await provider(NUTELLA, NUTELLA_KEY)).status, 'found');
  assert.equal(rateLimited.calls.length, 2);

  const failing = fakeFetch(new TypeError('down'));
  const flaky = offProvider(failing.fetch, () => clock);
  for (let attempt = 0; attempt < 3; attempt += 1) await flaky(NUTELLA, NUTELLA_KEY);
  assert.equal(failing.calls.length, 3);
  assert.equal((await flaky(NUTELLA, NUTELLA_KEY)).reason, 'circuit_open');
  assert.equal(failing.calls.length, 3);
});

// ---------------------------------------------------------------------------------------------
// D/E. Cache hit and expiry

test('D: fresh cache hit => 0 OFF call (positive and negative)', async () => {
  const { fetch, calls } = fakeFetch(nutellaFound);
  const deps = { cache: createMemoryProductLookupCache(), provider: offProvider(fetch) };
  await lookupProduct(NUTELLA, { ...deps, now: () => T0 });
  const hit = await lookupProduct(NUTELLA, { ...deps, now: at(29 * DAY) });
  assert.equal(hit.status, 'found');
  assert.equal(hit.cache, 'hit');
  assert.equal(calls.length, 1);

  const missing = fakeFetch(jsonResponse(404, { result: { id: 'product_not_found' } }));
  const negative = {
    cache: createMemoryProductLookupCache(),
    provider: offProvider(missing.fetch),
  };
  await lookupProduct(NUTELLA, { ...negative, now: () => T0 });
  assert.equal((await lookupProduct(NUTELLA, { ...negative, now: at(6 * DAY) })).cache, 'hit');
  assert.equal(missing.calls.length, 1);
});

test('E: expired cache entry => OFF may be called again (30 d positive, 7 d negative)', async () => {
  const { fetch, calls } = fakeFetch(nutellaFound);
  const deps = { cache: createMemoryProductLookupCache(), provider: offProvider(fetch) };
  const first = await lookupProduct(NUTELLA, { ...deps, now: () => T0 });
  assert.equal(Date.parse(first.expiresAt) - Date.parse(first.fetchedAt), POSITIVE_TTL_MS);
  const refreshed = await lookupProduct(NUTELLA, { ...deps, now: at(30 * DAY) });
  assert.equal(refreshed.cache, 'miss');
  assert.equal(calls.length, 2);

  const missing = fakeFetch(jsonResponse(404, { result: { id: 'product_not_found' } }));
  const negative = {
    cache: createMemoryProductLookupCache(),
    provider: offProvider(missing.fetch),
  };
  await lookupProduct(NUTELLA, { ...negative, now: () => T0 });
  await lookupProduct(NUTELLA, { ...negative, now: at(7 * DAY) });
  assert.equal(missing.calls.length, 2);
});

test('D: device key-value cache round-trips, rejects corrupt rows, is bounded and clearable', async () => {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  const cache = createKeyValueProductLookupCache(() => storage, 'k', 2);
  let providerCalls = 0;
  const provider = async () => {
    providerCalls += 1;
    return offProvider(fakeFetch(nutellaFound).fetch)(NUTELLA, NUTELLA_KEY);
  };
  const now = () => new Date();
  await lookupProduct(NUTELLA, { cache, provider, now });
  const hit = await lookupProduct(NUTELLA, { cache, provider, now });
  assert.equal(hit.cache, 'hit');
  assert.equal(providerCalls, 1);

  // Stored row: exactly the documented non-personal fields, no raw OFF response.
  const [row] = JSON.parse(data.get('k'));
  assert.deepEqual(Object.keys(row).sort(), [
    'attribution',
    'brand',
    'expiresAt',
    'fetchedAt',
    'key',
    'name',
    'provider',
    'schema',
    'status',
  ]);
  assert.equal(row.provider, 'open_food_facts');

  // Corrupt or tampered rows are misses.
  data.set('k', JSON.stringify([{ ...row, name: '   ' }]));
  assert.equal(await cache.get(NUTELLA_KEY), null);
  data.set(
    'k',
    JSON.stringify([
      { ...row, attribution: { ...row.attribution, sourceUrl: 'https://evil.test/product/1' } },
    ]),
  );
  assert.equal(await cache.get(NUTELLA_KEY), null);
  data.set('k', '{not json');
  assert.equal(await cache.get(NUTELLA_KEY), null);

  // Bounded to maxEntries.
  data.delete('k');
  const fresh = new Date().toISOString();
  const later = new Date(Date.now() + DAY).toISOString();
  for (const key of ['00000000000017', '00000000000024', '00000000000031']) {
    await cache.set({
      ...row,
      key,
      status: 'not_found',
      name: null,
      brand: null,
      attribution: null,
      fetchedAt: fresh,
      expiresAt: later,
    });
  }
  assert.equal(JSON.parse(data.get('k')).length, 2);
  cache.clear();
  assert.equal(data.has('k'), false);

  // Unavailable storage: misses, no throw.
  const none = createKeyValueProductLookupCache(() => null, 'k');
  assert.equal(await none.get(NUTELLA_KEY), null);
  await none.set(row);
});

// ---------------------------------------------------------------------------------------------
// F. RCN-8

test('F: RCN-8 27044193 => not_eligible, 0 OFF call, 0 cache read/write, manual entry allowed', async () => {
  const scanned = toScannedBarcode('ean8', RCN_8);
  assert.equal(scanned.classification, 'valid_gtin');
  assert.equal(scanned.matchingGtin, RCN_8);
  assert.equal(scanned.canonicalGtin14, '00000027044193');
  assert.deepEqual(productLookupEligibility(scanned.matchingGtin), {
    eligible: false,
    reason: 'rcn_8',
  });

  const { fetch, calls } = fakeFetch(
    jsonResponse(200, offBody(RCN_8, { product_name: 'Citroensap', brands: 'Regalo' })),
  );
  const cache = spyCache();
  const result = await lookupProduct(scanned.matchingGtin, {
    cache: cache.store,
    provider: offProvider(fetch),
  });
  assert.deepEqual(result, { status: 'not_eligible', reason: 'rcn_8' });
  assert.equal(calls.length, 0);
  assert.equal(cache.gets, 0);
  assert.equal(cache.sets.length, 0);

  // Server side too: the Edge handler never calls OFF nor writes its cache for an RCN-8.
  const serverCache = spyCache();
  const handler = createIdentifyProductHandler({
    authenticate: async () => 'user',
    enabled: () => true,
    provider: () => offProvider(fetch),
    cache: serverCache.store,
  });
  const response = await handler(
    new Request('http://local/identify-product', {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: JSON.stringify({ gtin: RCN_8 }),
    }),
  );
  assert.deepEqual(await response.json(), { status: 'not_eligible', reason: 'rcn_8' });
  assert.equal(calls.length, 0);
  assert.equal(serverCache.sets.length, 0);

  // The scan stays valid and the product can be saved with a manual name and brand.
  const form = { ...emptyProductFormValues(T0), gtin: RCN_8 };
  assert.match(productLookupNotice(result, form).text, /Store-specific/u);
  const saved = validateProductForm({ ...form, productName: 'Citroensap', brand: 'Regalo' });
  assert.equal(saved.input?.gtin, RCN_8);
  assert.equal(saved.input?.brand, 'Regalo');
});

test('F: RCN-8 is decided on the 8-digit matching GTIN, never on a zero-filled GTIN-14', () => {
  assert.equal(isRcn8(RCN_8), true);
  assert.equal(isRcn8('00000027044193'), false);
  assert.equal(productLookupEligibility(EAN_8).eligible, true); // GS1-8 prefix 9: not an RCN
  assert.equal(productLookupEligibility('93456785').reason, 'invalid_gtin'); // bad check digit
  for (const invalid of [null, 42, '', ' 3017620422003', '301762042200', 'abcdefgh']) {
    assert.equal(productLookupEligibility(invalid).eligible, false);
  }
});

// ---------------------------------------------------------------------------------------------
// G. Partial data and quality rules

test('G: name only / brand only => partial, only the found field is prefilled', async () => {
  const cases = [
    [{ product_name: 'Aiguillettes de poulet', brands: '' }, 'Aiguillettes de poulet', null],
    [{ product_name: '', product_name_fr: '', brands: 'Kraft' }, null, 'Kraft'],
  ];
  for (const [product, name, brand] of cases) {
    const result = await lookupProduct(NUTELLA, {
      cache: createMemoryProductLookupCache(),
      provider: offProvider(fakeFetch(jsonResponse(200, offBody(NUTELLA, product))).fetch),
      now: () => T0,
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.name, name);
    assert.equal(result.brand, brand);

    const form = { ...emptyProductFormValues(T0), gtin: NUTELLA };
    const { values, applied } = applyLookupSuggestion(form, new Set(), result);
    assert.equal(values.productName, name ?? '');
    assert.equal(values.brand, brand ?? '');
    assert.deepEqual(Object.keys(applied), name ? ['productName'] : ['brand']);
  }
});

test('G: quality rules never invent, truncate or accept placeholders', () => {
  assert.equal(cleanSuggestedName('  Light\u0000 margarine \n'), 'Light margarine');
  assert.equal(cleanSuggestedName('12345'), null);
  assert.equal(cleanSuggestedName('x'), null);
  assert.equal(cleanSuggestedName('Unknown'), null);
  assert.equal(cleanSuggestedName('a'.repeat(201)), null);
  assert.equal(cleanSuggestedName(42), null);
  assert.equal(cleanSuggestedBrand('Nutella, Ferrero'), 'Nutella');
  assert.equal(cleanSuggestedBrand('unknown, Kraft'), 'Kraft');
  assert.equal(cleanSuggestedBrand('Sans marque'), null);
  assert.equal(cleanSuggestedBrand('COCA-COLA SERVICES SA/NV'), 'COCA-COLA SERVICES SA/NV');
});

// ---------------------------------------------------------------------------------------------
// H/I. User input wins

const found = {
  status: 'found',
  key: NUTELLA_KEY,
  name: 'Nutella',
  brand: 'Ferrero',
  attribution: {
    provider: 'open_food_facts',
    database: 'openfoodfacts',
    sourceName: 'Open Food Facts',
    sourceUrl: `https://world.openfoodfacts.org/product/${NUTELLA}`,
    license: { database: 'ODbL-1.0', contents: 'DbCL-1.0', images: 'CC-BY-SA-3.0' },
  },
  fetchedAt: T0.toISOString(),
  expiresAt: new Date(T0.getTime() + POSITIVE_TTL_MS).toISOString(),
  cache: 'miss',
};

test('H: values edited by the user are never rewritten, even when cleared', () => {
  const form = { ...emptyProductFormValues(T0), gtin: NUTELLA, productName: 'My jar' };
  const typed = applyLookupSuggestion(form, new Set(['productName']), found);
  assert.equal(typed.values.productName, 'My jar');
  assert.equal(typed.values.brand, 'Ferrero');

  const cleared = applyLookupSuggestion(
    { ...form, productName: '' },
    new Set(['productName', 'brand']),
    found,
  );
  assert.equal(cleared.values.productName, '');
  assert.equal(cleared.values.brand, '');
  assert.deepEqual(cleared.applied, {});

  // A suggested value the user then edits stays edited; the attribution goes away with it.
  const applied = applyLookupSuggestion({ ...form, productName: '' }, new Set(), found).values;
  const edited = { ...applied, productName: 'Nutella 400 g', brand: 'Ferrero SpA' };
  assert.equal(
    applyLookupSuggestion(edited, new Set(['productName', 'brand']), found).values,
    edited,
  );
  assert.equal(productLookupNotice(found, edited), null);
});

test('I: a lookup that resolves after manual typing never overwrites the user input', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const lookup = lookupProduct(NUTELLA, {
    cache: createMemoryProductLookupCache(),
    provider: async () => {
      await pending;
      return {
        status: 'found',
        name: 'Nutella',
        brand: 'Ferrero',
        attribution: found.attribution,
      };
    },
    now: () => T0,
  });

  // 1. scan, 2. lookup started, 3. the user types, 4. OFF answers.
  const edited = new Set();
  let form = { ...emptyProductFormValues(T0), gtin: NUTELLA };
  form = { ...form, productName: 'Hazelnut spread' };
  edited.add('productName');
  release();
  const result = await lookup;
  assert.equal(result.status, 'found');

  const merged = applyLookupSuggestion(form, edited, result);
  assert.equal(merged.values.productName, 'Hazelnut spread');
  assert.equal(merged.values.brand, 'Ferrero');
  // Deterministic and idempotent: re-applying the same answer changes nothing.
  assert.equal(applyLookupSuggestion(merged.values, edited, result).values, merged.values);

  // The user replaced the GTIN while the lookup ran: nothing from the old GTIN is applied.
  const otherGtin = { ...emptyProductFormValues(T0), gtin: '5400141472714' };
  assert.equal(applyLookupSuggestion(otherGtin, new Set(), result).values, otherGtin);
});

// ---------------------------------------------------------------------------------------------
// Edge handler, transport re-validation, User-Agent

test('identify-product: auth required, strict body, kill switch and missing UA never call OFF', async () => {
  const { fetch, calls } = fakeFetch(nutellaFound);
  const make = (overrides = {}) =>
    createIdentifyProductHandler({
      authenticate: async (token) => (token === 'a.b.c' ? 'user-1' : null),
      enabled: () => true,
      provider: () => offProvider(fetch),
      cache: createMemoryProductLookupCache(),
      now: () => T0,
      ...overrides,
    });
  const post = (body, token = 'a.b.c') =>
    new Request('http://local/identify-product', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  assert.equal((await make()(new Request('http://local', { method: 'GET' }))).status, 405);
  assert.equal((await make()(post({ gtin: NUTELLA }, 'x.y.z'))).status, 401);
  assert.equal((await make()(post({ gtin: NUTELLA, userId: 'u' }))).status, 400);
  assert.equal((await make()(post({ gtin: 3017620422003 }))).status, 400);

  const disabled = await make({ enabled: () => false })(post({ gtin: NUTELLA }));
  assert.deepEqual(await disabled.json(), { status: 'unavailable', reason: 'disabled' });
  const unconfigured = await make({ provider: () => null })(post({ gtin: NUTELLA }));
  assert.deepEqual(await unconfigured.json(), { status: 'unavailable', reason: 'not_configured' });
  assert.equal(calls.length, 0);

  const ok = await make()(post({ gtin: NUTELLA }));
  const body = await ok.json();
  assert.equal(body.status, 'found');
  assert.equal(JSON.stringify(body).includes('user-1'), false);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0]).includes('user-1'), false);
  assert.equal(JSON.stringify(calls[0]).includes('a.b.c'), false);

  // The app re-validates the server answer before using or caching it.
  assert.equal(providerOutcomeFromResult(body, NUTELLA_KEY).status, 'found');
  assert.equal(providerOutcomeFromResult(body, '00000000000017').status, 'unavailable');
  assert.equal(
    providerOutcomeFromResult({ ...body, name: 'x' }, NUTELLA_KEY).status,
    'unavailable',
  );
  assert.equal(providerOutcomeFromResult(null, NUTELLA_KEY).status, 'unavailable');
  assert.deepEqual(
    providerOutcomeFromResult({ status: 'unavailable', reason: '??' }, NUTELLA_KEY),
    {
      status: 'unavailable',
      reason: 'invalid_response',
    },
  );
  assert.equal(
    parseCacheEntry({ ...body, schema: 1, provider: 'open_food_facts' })?.name,
    'Nutella',
  );
});

test('User-Agent: AppName/Version (ContactEmail); never deployable without a real project contact', () => {
  assert.equal(offUserAgent('contact@domain.tld'), 'Recall/1.0.0 (contact@domain.tld)');
  for (const contact of [
    undefined,
    null,
    '',
    'not an email',
    'https://github.com/Devdevdevdev/recall-app',
    'product-lookup-tests@example.invalid',
    'someone@example.com',
    'someone@lookup.test',
    'a(b)@domain.tld',
  ]) {
    assert.equal(offUserAgent(contact), null, String(contact));
  }
  assert.equal(offProductUrl(NUTELLA).includes('product_type=all'), true);
});

// ---------------------------------------------------------------------------------------------
// Separation: product lookup is never read by recall matching, F-4 or product checks

async function filesUnder(dir) {
  const entries = await readdir(new URL(dir, root), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mjs|sql)$/u.test(entry.name))
    .map((entry) => `${entry.parentPath ?? entry.path}/${entry.name}`);
}

test('separation: matching, product checks, automation and SQL never reference product lookup', async () => {
  const guarded = [
    'supabase/functions/_shared/matching/',
    'supabase/functions/_shared/recallMatching/',
    'supabase/functions/_shared/productCheck/',
    'supabase/functions/_shared/automation/',
    'supabase/functions/process-recall-matches/',
    'supabase/functions/process-recall-matches-v2-cohort/',
    'supabase/functions/check-owned-product/',
    'supabase/functions/process-owned-product-checks/',
    'supabase/migrations/',
  ];
  for (const dir of guarded) {
    for (const file of await filesUnder(dir)) {
      const source = await readFile(file, 'utf8');
      assert.equal(/productLookup|identify-product|open_food_facts/u.test(source), false, file);
    }
  }

  // Product lookup reuses only the Phase 17.3-S GTIN primitive from matching.
  for (const file of await filesUnder('supabase/functions/_shared/productLookup/')) {
    const imports = [...(await readFile(file, 'utf8')).matchAll(/from '([^']+)'/gu)].map(
      (match) => match[1],
    );
    for (const path of imports.filter((path) => path.includes('/matching/'))) {
      assert.equal(path, '../matching/gtin.ts', file);
    }
    assert.equal(
      imports.some((path) => /recallMatching|productCheck\/(?!server)/u.test(path)),
      false,
    );
  }

  // The app sends the matching GTIN only and never persists lookup data with the product.
  const service = await read('src/services/productLookup/index.ts');
  assert.match(service, /body: \{ gtin: providerGtin \}/u);
  const mappers = await read('src/data/ownedProductsMappers.ts');
  assert.equal(/lookup|open_food_facts/iu.test(mappers), false);
});
