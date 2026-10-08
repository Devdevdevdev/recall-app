// Phase 17.3b: reproducible GTIN -> name + brand provider benchmark (research only).
//
//   node scripts/bench-product-lookup.mjs --run --out <file> [--providers off,upcitemdb]
//                                          [--upc-budget 70] [--include-rcn]
//   node scripts/bench-product-lookup.mjs --score [--results <file>]
//
// The historical run (2026-10-08, before the RCN decision, RCN-8 included) is kept unchanged in
// docs/phase-17-3b-product-lookup-benchmark-results.json; --run never overwrites an existing
// file. New runs skip RCN-8 GTINs (17.3c contract: not_eligible, 0 provider calls) unless
// --include-rcn is given to re-measure providers on them.
//
// --run sends ONLY a GTIN representation to each provider (no user, device, account or
// inventory data; no cookies; no API keys) and writes every response, trimmed to the identity
// fields, to docs/phase-17-3b-product-lookup-benchmark-results.json. --score is offline: it
// re-scores that file against the ground truth in
// tests/fixtures/phase-17-3b-product-lookup-benchmark.json and prints the report tables.
//
// Providers that need a key, a contract or a membership are not called (BLOCKED in the report).
// Nothing here is used by the app or by an Edge Function.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { toScannedBarcode } from '../src/domain/barcode.ts';

const fixturePath = new URL(
  '../tests/fixtures/phase-17-3b-product-lookup-benchmark.json',
  import.meta.url,
);
const historicalResultsPath = new URL(
  '../docs/phase-17-3b-product-lookup-benchmark-results.json',
  import.meta.url,
);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

// A non-personal project identifier: the public repository URL. Never a user's email, and never
// a personal address.
const userAgent = 'RecallProductLookupBenchmark/0.1 (https://github.com/Devdevdevdev/recall-app)';
const requestTimeoutMs = 8000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Identity: the 17.3a contract is the only source of provider inputs.

function identityOf(testCase) {
  const scan = toScannedBarcode(testCase.symbology, testCase.raw);
  return {
    rawValue: testCase.raw,
    symbology: testCase.symbology,
    classification: scan.classification,
    matchingGtin: scan.matchingGtin,
    canonicalGtin14: scan.canonicalGtin14,
  };
}

/** Distinct provider inputs, each labelled with every representation that produces it. */
function representationsOf(identity) {
  const candidates = [
    ['raw', identity.rawValue],
    ['matchingGtin', identity.matchingGtin],
    [
      'gtin13',
      identity.matchingGtin && identity.matchingGtin.length === 12
        ? `0${identity.matchingGtin}`
        : null,
    ],
    ['canonicalGtin14', identity.canonicalGtin14],
  ];
  const byValue = new Map();
  for (const [label, value] of candidates) {
    if (!value) continue;
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(label);
  }
  return [...byValue.entries()].map(([value, labels]) => ({ value, labels }));
}

/**
 * GS1 Restricted Circulation Numbers are assigned locally and are not globally unique, so a
 * catalogue answer for one may describe a different product.
 *
 * - RCN-8: a GTIN-8 whose GS1-8 prefix starts with 0 or 2 (decided 17.3b closeout: no automatic
 *   lookup). Decided on the matching GTIN's length, never on the zero-filled GTIN-14, which
 *   cannot tell a GTIN-8 from a GTIN-12 that starts with zeroes.
 * - RCN-12/13: GS1 prefix 02, 04 or 20-29. Flagged only; the policy is still to be decided.
 */
function restrictedCirculation(identity) {
  const gtin = identity.matchingGtin;
  if (!gtin) return null;
  if (gtin.length === 8) return /^[02]/u.test(gtin) ? 'RCN-8' : null;
  if (gtin.length === 14) return null;
  return /^(02|04|2)/u.test(gtin.padStart(13, '0')) ? 'RCN-12/13' : null;
}

/** 17.3c contract: RCN-8 is `not_eligible` (0 provider calls, 0 global cache rows). */
function lookupEligibility(identity) {
  const restricted = restrictedCirculation(identity);
  if (restricted === 'RCN-8') return { eligible: false, status: 'not_eligible', reason: 'RCN-8' };
  return { eligible: true, status: 'eligible', reason: restricted };
}

// ---------------------------------------------------------------------------------------------
// Providers (no-key endpoints only).

async function timedFetch(url, init = {}) {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'follow',
      headers: { 'User-Agent': userAgent, Accept: 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await response.text();
    return {
      status: response.status,
      finalUrl: response.url,
      text,
      latencyMs: Math.round(performance.now() - started),
      headers: Object.fromEntries(
        [...response.headers.entries()].filter(([key]) =>
          key.toLowerCase().startsWith('x-ratelimit'),
        ),
      ),
    };
  } catch (error) {
    return {
      status: null,
      error: String(error?.name ?? error),
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

const offFields = [
  'code',
  'product_name',
  'product_name_en',
  'product_name_fr',
  'generic_name',
  'brands',
  'quantity',
  'categories_tags',
  'image_front_url',
  'product_type',
].join(',');

const providers = {
  off: {
    label: 'Open Food Facts family (v3, product_type=all)',
    minIntervalMs: 4300, // documented limit: 15 product reads / minute / IP
    async lookup(value) {
      const url = `https://world.openfoodfacts.org/api/v3/product/${value}?product_type=all&fields=${offFields}`;
      const response = await timedFetch(url);
      if (response.status === null) return { outcome: 'error', ...response };
      let body = null;
      try {
        body = JSON.parse(response.text);
      } catch {
        return {
          outcome: 'error',
          status: response.status,
          latencyMs: response.latencyMs,
          error: 'non-json',
        };
      }
      const base = {
        status: response.status,
        latencyMs: response.latencyMs,
        finalHost: new URL(response.finalUrl).host,
      };
      if (response.status === 404 || body?.result?.id === 'product_not_found')
        return { outcome: 'not_found', ...base, returnedCode: body?.code ?? null };
      if (response.status !== 200 || !body?.product)
        return { outcome: 'error', ...base, error: body?.result?.id ?? `http ${response.status}` };
      const product = body.product;
      const name =
        product.product_name ||
        product.product_name_en ||
        product.product_name_fr ||
        product.generic_name ||
        '';
      return {
        outcome: 'found',
        ...base,
        returnedCode: body.code,
        items: [
          {
            name,
            brand: product.brands || '',
            category: (product.categories_tags ?? []).slice(0, 4),
            image: Boolean(product.image_front_url),
            quantity: product.quantity || '',
            productType: product.product_type ?? null,
          },
        ],
      };
    },
  },
  upcitemdb: {
    label: 'UPCitemdb (free trial endpoint)',
    minIntervalMs: 11000, // documented FREE burst limit: 6 requests / minute / IP
    async lookup(value) {
      const response = await timedFetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${value}`);
      if (response.status === null) return { outcome: 'error', ...response };
      let body = null;
      try {
        body = JSON.parse(response.text);
      } catch {
        return {
          outcome: 'error',
          status: response.status,
          latencyMs: response.latencyMs,
          error: 'non-json',
        };
      }
      const base = {
        status: response.status,
        latencyMs: response.latencyMs,
        rateLimit: response.headers,
      };
      if (response.status === 429) return { outcome: 'error', ...base, error: 'rate_limited' };
      if (response.status === 400 && body?.code === 'INVALID_UPC')
        return { outcome: 'rejected', ...base, error: body.code };
      if (response.status !== 200)
        return { outcome: 'error', ...base, error: body?.code ?? `http ${response.status}` };
      const items = (body.items ?? []).map((item) => ({
        name: item.title ?? '',
        brand: item.brand ?? '',
        category: item.category ? [item.category] : [],
        image: Array.isArray(item.images) && item.images.length > 0,
        model: item.model ?? '',
        ean: item.ean ?? '',
        upc: item.upc ?? '',
        offers: Array.isArray(item.offers) ? item.offers.length : 0,
      }));
      return {
        outcome: items.length > 0 ? 'found' : 'not_found',
        ...base,
        total: body.total ?? items.length,
        items,
      };
    },
  },
};

async function run() {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const selected = option('--providers', 'off,upcitemdb').split(',');
  const upcBudget = Number(option('--upc-budget', '70'));
  const requests = [];
  const normalization = [];

  const cases = fixture.cases.map((testCase) => ({ testCase, identity: identityOf(testCase) }));
  for (const { testCase, identity } of cases) {
    if (testCase.scoring === 'NORMALIZATION_ONLY') {
      normalization.push({
        id: testCase.id,
        identity,
        providerInput: identity.matchingGtin,
        pass:
          identity.matchingGtin === testCase.expectedMatchingGtin &&
          identity.canonicalGtin14 === testCase.expectedCanonicalGtin14,
      });
    }
  }

  const outPath = new URL(option('--out', ''), `file://${process.cwd()}/`);
  if (!option('--out', '') || existsSync(outPath)) {
    throw new Error('--run needs --out <new file>; existing results are never overwritten');
  }
  const includeRcn = flag('--include-rcn');
  const lookupCases = cases.filter(
    ({ testCase, identity }) =>
      testCase.scoring !== 'NORMALIZATION_ONLY' &&
      (includeRcn || lookupEligibility(identity).eligible),
  );

  for (const providerId of selected) {
    const provider = providers[providerId];
    if (!provider) throw new Error(`unknown provider ${providerId}`);
    // OFF: every distinct representation. UPCitemdb (100/day): matchingGtin for every case, then
    // the other representations for a small, fixed subset while the budget allows.
    const plan = [];
    for (const { testCase, identity } of lookupCases) {
      const reps = representationsOf(identity);
      if (providerId === 'off') {
        for (const rep of reps) plan.push({ testCase, identity, rep });
      } else {
        const primary = reps.find((rep) => rep.labels.includes('matchingGtin'));
        plan.push({ testCase, identity, rep: primary });
      }
    }
    if (providerId === 'upcitemdb') {
      const representationSubset = fixture.representationSubset ?? [];
      for (const { testCase, identity } of lookupCases) {
        if (!representationSubset.includes(testCase.id)) continue;
        for (const rep of representationsOf(identity)) {
          if (!rep.labels.includes('matchingGtin')) plan.push({ testCase, identity, rep });
        }
      }
    }
    const capped = providerId === 'upcitemdb' ? plan.slice(0, upcBudget) : plan;
    console.error(
      `${providerId}: ${capped.length} requests planned (${plan.length} before budget)`,
    );

    for (const [index, { testCase, identity, rep }] of capped.entries()) {
      let result = await provider.lookup(rep.value);
      if (result.error === 'rate_limited' || result.status === 429) {
        console.error(`${providerId}: 429, backing off 65 s`);
        await sleep(65000);
        result = await provider.lookup(rep.value);
      }
      requests.push({
        provider: providerId,
        caseId: testCase.id,
        sent: rep.value,
        representations: rep.labels,
        restricted: restrictedCirculation(identity),
        at: new Date().toISOString(),
        ...result,
      });
      console.error(
        `${providerId} ${index + 1}/${capped.length} ${testCase.id} ${rep.value} -> ${result.outcome} ${result.status ?? ''} ${result.latencyMs}ms`,
      );
      await sleep(provider.minIntervalMs);
    }
  }

  const output = {
    schema: 'phase-17-3b-product-lookup-benchmark-results/v1',
    generatedAt: new Date().toISOString(),
    userAgent,
    rcnIncluded: includeRcn,
    privacy:
      'Each request carried only a GTIN in the URL path/query. No user, account, device, inventory, lot, serial or date data. No cookies, no API keys.',
    licenseNote:
      'Open Food Facts family responses: ODbL (data) / CC BY-SA (images), (c) Open Food Facts contributors. UPCitemdb responses are kept trimmed to identity fields for benchmark audit only.',
    normalization,
    requests,
  };
  writeFileSync(outPath, `${JSON.stringify(output, null, 1)}\n`);
  console.error(`wrote ${outPath.pathname}`);
}

// ---------------------------------------------------------------------------------------------
// Scoring.

function norm(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/ø/gu, 'o')
    .replace(/[^a-z0-9가-힯]+/gu, ' ')
    .trim();
}
const compact = (value) => norm(value).replace(/ /gu, '');

// Provider placeholders that mean "no brand", not a brand.
const placeholderBrands = new Set([
  'unknown',
  'na',
  'none',
  'generic',
  'doesnotapply',
  'unbranded',
]);
const isBlankBrand = (brand) => !norm(brand) || placeholderBrands.has(compact(brand));

function brandVerdict(brand, aliases) {
  if (isBlankBrand(brand)) return 'MISSING';
  const parts = String(brand).split(/[,;]/u).map(compact).filter(Boolean);
  const wanted = aliases.map(compact);
  if (parts.some((part) => wanted.includes(part))) return 'EXACT';
  if (
    parts.some((part) =>
      wanted.some(
        (alias) =>
          alias.length >= 3 && (part.includes(alias) || (part.length >= 3 && alias.includes(part))),
      ),
    )
  ) {
    return 'ACCEPTABLE';
  }
  return 'WRONG';
}

function nameVerdict(name, testCase) {
  if (!norm(name)) return 'MISSING';
  if (norm(name) === norm(testCase.expectedName)) return 'EXACT';
  const haystack = norm(name);
  const haystackCompact = compact(name);
  const matched = testCase.nameGroups.filter((group) =>
    group.some(
      (alternative) =>
        haystack.includes(norm(alternative)) || haystackCompact.includes(compact(alternative)),
    ),
  ).length;
  if (matched === testCase.nameGroups.length) return 'ACCEPTABLE';
  return matched > 0 ? 'PARTIAL' : 'WRONG';
}

const good = (verdict) => verdict === 'EXACT' || verdict === 'ACCEPTABLE';

function itemVerdict(item, testCase) {
  const brand = brandVerdict(item.brand, testCase.brandAliases);
  // A brand missing from the brand field but present in the title is still "missing" as a
  // structured brand: the adapter must not guess the brand out of free text.
  if (testCase.scoring === 'BRAND_ONLY') {
    const verdict = brand === 'WRONG' ? 'WRONG' : good(brand) ? 'ACCEPTABLE' : 'PARTIAL';
    return { name: 'NOT_SCORED', brand, verdict };
  }
  const name = nameVerdict(item.name, testCase);
  let verdict;
  if (brand === 'WRONG' || name === 'WRONG') verdict = 'WRONG';
  else if (good(name) && good(brand))
    verdict = name === 'EXACT' && brand === 'EXACT' ? 'EXACT' : 'ACCEPTABLE';
  else verdict = 'PARTIAL';
  return { name, brand, verdict };
}

function scoreRequest(request, testCase, reviews) {
  if (request.outcome === 'error') return { verdict: 'ERROR' };
  if (request.outcome === 'rejected') return { verdict: 'REJECTED_INPUT' };
  if (request.outcome === 'not_found') return { verdict: 'NOT_FOUND' };
  // A record that exists but carries neither a name nor a brand identifies nothing.
  if (request.items.every((item) => !norm(item.name) && isBlankBrand(item.brand))) {
    return { verdict: 'NOT_FOUND', emptyRecord: true };
  }
  const scored = request.items.map((item) => itemVerdict(item, testCase));
  // Internal conflict: several items for one GTIN whose brands disagree with each other.
  const distinctBrands = new Set(request.items.map((item) => compact(item.brand)).filter(Boolean));
  let result = scored[0];
  if (request.items.length > 1 && distinctBrands.size > 1)
    result = { ...result, verdict: 'CONFLICT' };
  const review = reviews[`${request.provider}:${testCase.id}`];
  if (review) result = { ...result, ...review, reviewed: true };
  return result;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

const pct = (count, total) => (total === 0 ? 'n/a' : `${((100 * count) / total).toFixed(1)} %`);

function summarize(label, rows) {
  const count = (predicate) => rows.filter(predicate).length;
  const total = rows.length;
  const found = count((row) =>
    ['EXACT', 'ACCEPTABLE', 'PARTIAL', 'WRONG', 'CONFLICT'].includes(row.score.verdict),
  );
  return {
    label,
    attempts: total,
    httpSuccess: count((row) => row.request.status === 200 || row.request.status === 404),
    found,
    notFound: count((row) => row.score.verdict === 'NOT_FOUND'),
    errors: count((row) => row.score.verdict === 'ERROR'),
    rejected: count((row) => row.score.verdict === 'REJECTED_INPUT'),
    name: Object.fromEntries(
      ['EXACT', 'ACCEPTABLE', 'PARTIAL', 'WRONG', 'MISSING'].map((key) => [
        key,
        count((row) => row.score.name === key),
      ]),
    ),
    brand: Object.fromEntries(
      ['EXACT', 'ACCEPTABLE', 'WRONG', 'MISSING'].map((key) => [
        key,
        count((row) => row.score.brand === key),
      ]),
    ),
    verdicts: Object.fromEntries(
      ['EXACT', 'ACCEPTABLE', 'PARTIAL', 'CONFLICT', 'WRONG', 'NOT_FOUND', 'ERROR'].map((key) => [
        key,
        count((row) => row.score.verdict === key),
      ]),
    ),
    coverage: pct(found, total),
    correctBoth: pct(
      count((row) => good(row.score.verdict)),
      total,
    ),
    wrongPositive: pct(
      count((row) => row.score.verdict === 'WRONG'),
      total,
    ),
    conflict: pct(
      count((row) => row.score.verdict === 'CONFLICT'),
      total,
    ),
    partial: pct(
      count((row) => row.score.verdict === 'PARTIAL'),
      total,
    ),
    notFoundPct: pct(
      count((row) => row.score.verdict === 'NOT_FOUND'),
      total,
    ),
    errorPct: pct(
      count((row) => row.score.verdict === 'ERROR'),
      total,
    ),
    multipleItems: count((row) => (row.request.items?.length ?? 0) > 1),
    images: count((row) => row.request.items?.[0]?.image),
    category: count((row) => (row.request.items?.[0]?.category?.length ?? 0) > 0),
  };
}

function providerSummary(rows, all) {
  const latencies = all
    .filter((request) => request.outcome !== 'error')
    .map((request) => request.latencyMs);
  const region = (regions) => rows.filter((row) => regions.includes(row.testCase.region));
  return {
    overall: summarize('all', rows),
    beEu: summarize('BE/EU', region(['BE', 'EU'])),
    usCa: summarize('US/CA', region(['US', 'CA'])),
    byCategory: Object.fromEntries(
      [...new Set(rows.map((row) => row.testCase.category))].map((category) => [
        category,
        summarize(
          category,
          rows.filter((row) => row.testCase.category === category),
        ),
      ]),
    ),
    latency: {
      requests: latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: Math.max(...latencies),
    },
    perCase: rows.map((row) => ({
      id: row.testCase.id,
      region: row.testCase.region,
      category: row.testCase.category,
      expected: `${row.testCase.expectedBrand} | ${row.testCase.expectedName}`,
      got: row.request.items?.map((item) => `${item.brand} | ${item.name}`) ?? [],
      ...row.score,
    })),
  };
}

/** Chain simulation: OFF first, then UPCitemdb only when OFF has no usable answer. */
function chainSummary(offRows, upcRows) {
  if (!offRows || !upcRows) return null;
  const upcById = new Map(upcRows.map((row) => [row.testCase.id, row]));
  const chainRows = offRows.map((offRow) => {
    if (offRow.score.verdict !== 'NOT_FOUND' && offRow.score.verdict !== 'ERROR')
      return { ...offRow, source: 'off' };
    const upcRow = upcById.get(offRow.testCase.id);
    return upcRow ? { ...upcRow, source: 'upcitemdb' } : { ...offRow, source: 'none' };
  });
  return { order: 'off -> upcitemdb', ...summarize('chain', chainRows) };
}

function score() {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const resultsOption = option('--results', '');
  const resultsPath = resultsOption
    ? new URL(resultsOption, `file://${process.cwd()}/`)
    : historicalResultsPath;
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const reviews = fixture.manualReviews ?? {};
  const byId = new Map(fixture.cases.map((testCase) => [testCase.id, testCase]));
  const eligibilityById = new Map(
    fixture.cases.map((testCase) => [testCase.id, lookupEligibility(identityOf(testCase))]),
  );
  const scoredKinds = new Set(['SCORED', 'BRAND_ONLY']);
  const lookupCases = fixture.cases.filter((testCase) => testCase.scoring !== 'NORMALIZATION_ONLY');
  const report = {
    results: resultsPath.pathname.split('/').slice(-2).join('/'),
    normalization: results.normalization,
    eligibility: lookupCases.map((testCase) => ({
      id: testCase.id,
      raw: testCase.raw,
      scoring: testCase.scoring,
      ...eligibilityById.get(testCase.id),
    })),
    providerFound: {},
    raw: { providers: {}, chain: null },
    recallEligible: { providers: {}, chain: null },
    representations: {},
    unscored: [],
  };

  const providerIds = [...new Set(results.requests.map((request) => request.provider))];
  const rawRows = {};
  const eligibleRows = {};
  for (const providerId of providerIds) {
    const all = results.requests.filter((request) => request.provider === providerId);
    // One request per case: the matchingGtin request (the input the future adapter would send).
    const primary = (caseId) =>
      all.find(
        (candidate) =>
          candidate.caseId === caseId && candidate.representations.includes('matchingGtin'),
      );

    // "Provider found" (a catalogue answered) vs "eligible for automatic lookup" (Recall may
    // use the answer to pre-fill name/brand). An RCN-8 answer is found but never eligible.
    const attempted = lookupCases.filter((testCase) => primary(testCase.id));
    const found = attempted.filter((testCase) => primary(testCase.id).outcome === 'found');
    report.providerFound[providerId] = {
      attempted: attempted.length,
      providerFound: found.length,
      eligibleFound: found.filter((testCase) => eligibilityById.get(testCase.id).eligible).length,
      foundButNotEligible: found
        .filter((testCase) => !eligibilityById.get(testCase.id).eligible)
        .map((testCase) => ({
          id: testCase.id,
          raw: testCase.raw,
          reason: eligibilityById.get(testCase.id).reason,
          providerAnswer: primary(testCase.id).items.map((item) => `${item.brand} | ${item.name}`),
          recallUse: 'none: not_eligible, never pre-filled, never cached globally',
        })),
    };

    rawRows[providerId] = fixture.cases
      .filter((testCase) => scoredKinds.has(testCase.scoring) && primary(testCase.id))
      .map((testCase) => {
        const request = primary(testCase.id);
        return { testCase, request, score: scoreRequest(request, testCase, reviews) };
      });
    eligibleRows[providerId] = rawRows[providerId].filter(
      (row) => eligibilityById.get(row.testCase.id).eligible,
    );
    report.raw.providers[providerId] = providerSummary(rawRows[providerId], all);
    report.recallEligible.providers[providerId] = providerSummary(
      eligibleRows[providerId],
      all.filter((request) => eligibilityById.get(request.caseId)?.eligible),
    );

    // Representation acceptance: for each label, how often a lookup by that representation
    // found something, and whether it agreed with the matchingGtin lookup.
    const labels = ['raw', 'matchingGtin', 'gtin13', 'canonicalGtin14'];
    report.representations[providerId] = Object.fromEntries(
      labels.map((label) => {
        const subset = all.filter(
          (request) =>
            request.representations.includes(label) &&
            byId.get(request.caseId)?.scoring !== 'NORMALIZATION_ONLY',
        );
        const casesTried = new Set(subset.map((request) => request.caseId));
        const agree = [...casesTried].filter((caseId) => {
          const mine = subset.find((request) => request.caseId === caseId);
          const reference = primary(caseId);
          return (
            reference &&
            mine &&
            mine.outcome === reference.outcome &&
            (mine.items?.[0]?.name ?? null) === (reference.items?.[0]?.name ?? null)
          );
        }).length;
        return [
          label,
          {
            requests: subset.length,
            found: subset.filter((request) => request.outcome === 'found').length,
            notFound: subset.filter((request) => request.outcome === 'not_found').length,
            rejected: subset.filter((request) => request.outcome === 'rejected').length,
            errors: subset.filter((request) => request.outcome === 'error').length,
            agreesWithMatchingGtin: `${agree}/${casesTried.size}`,
          },
        ];
      }),
    );
  }
  report.raw.chain = chainSummary(rawRows.off, rawRows.upcitemdb);
  report.recallEligible.chain = chainSummary(eligibleRows.off, eligibleRows.upcitemdb);

  // Unscored cases (no confirmed ground truth): provider answers are listed for the record and
  // are never counted as correct; a provider answer is never ground truth.
  for (const testCase of lookupCases.filter((candidate) => !scoredKinds.has(candidate.scoring))) {
    report.unscored.push({
      id: testCase.id,
      raw: testCase.raw,
      scoring: testCase.scoring,
      eligibility: eligibilityById.get(testCase.id).status,
      answers: results.requests
        .filter((request) => request.caseId === testCase.id)
        .map((request) => ({
          provider: request.provider,
          sent: request.sent,
          outcome: request.outcome,
          items: (request.items ?? []).map((item) => `${item.brand} | ${item.name}`),
        })),
    });
  }

  console.log(JSON.stringify(report, null, 1));
}

if (flag('--run')) await run();
else if (flag('--score')) score();
else {
  console.error(
    'usage: node scripts/bench-product-lookup.mjs --run --out <file> [--providers off,upcitemdb] [--upc-budget 70] [--include-rcn] | --score [--results <file>]',
  );
  process.exit(2);
}
