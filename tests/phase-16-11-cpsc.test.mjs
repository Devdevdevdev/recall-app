import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import {
  extractCpscPage,
  extractCpscPageStructure,
  parseHtml,
  unescapeHtml,
} from '../supabase/functions/_shared/cpsc/htmlExtractor.ts';
import { ingestCpscRecallIdentity } from '../supabase/functions/_shared/cpsc/ingestionGate.ts';
import {
  proposeCpscTableCriteria,
  semanticCpscRevision,
} from '../supabase/functions/_shared/cpsc/pageEvidence.ts';
import {
  CpscPageFetchError,
  fetchCpscOfficialPage,
} from '../supabase/functions/_shared/cpsc/pageFetcher.ts';
import { ingestCpscOfficialPage } from '../supabase/functions/_shared/cpsc/pageIngestion.ts';
import { buildCpscSourceCoverage } from '../supabase/functions/_shared/cpsc/sourceCoverage.ts';
import {
  evaluateProductionPairV2,
  projectOwnedProductForProductionV2,
  projectRecallForProductionV2,
} from '../supabase/functions/_shared/recallMatching/productionPolicyV2.ts';
import { validateLiveReviewedCriteriaV2 } from '../supabase/functions/_shared/recallMatching/reviewedCriteriaV2.ts';

const root = new URL('../', import.meta.url);
const dataset = JSON.parse(readFileSync(new URL('docs/phase-16-9-prototype-dataset.json', root)));
const fixtures = { 26756: 'aga', 26773: 'char-broil', 26776: 'friedrich' };
const page = (number) => dataset.pages.find((entry) => entry.recallNumber === number);
const html = (number) =>
  readFileSync(new URL(`tests/fixtures/cpsc-pages/${fixtures[number]}.html`, root), 'utf8');
const extracted = (number) => extractCpscPage(html(number), page(number).canonicalUrl);

test('TS extractor reproduces the frozen Python evidence for all three fixtures', () => {
  for (const number of Object.keys(fixtures)) {
    const raw = readFileSync(new URL(`tests/fixtures/cpsc-pages/${fixtures[number]}.html`, root));
    assert.equal(createHash('sha256').update(raw).digest('hex'), page(number).rawPageHash, number);
    const actual = extracted(number);
    for (const key of [
      'recallNumber',
      'canonicalUrl',
      'title',
      'publicationDate',
      'description',
      'recallDetails',
      'tables',
    ]) {
      assert.deepEqual(actual[key], page(number)[key], `${number} ${key}`);
    }
  }
});

test('AGA keeps six model/date rows and defers the production-date class', async () => {
  const aga = extracted('26756');
  assert.equal(aga.tables[0].length, 7);
  const revision = await semanticCpscRevision(aga);
  assert.equal(new Set(revision.tableIdentities[0].rows.map((row) => row.identity)).size, 6);
  const result = await proposeCpscTableCriteria(aga);
  assert.deepEqual(result.candidates, []);
  assert.ok(result.unresolved.includes('production_date_range deferred: 6 paired rows'));
});

test('Char-Broil yields nine model AND date-code conjunctions and no cross product', async () => {
  const result = await proposeCpscTableCriteria(extracted('26773'));
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.candidates.length, 18);
  const groups = new Map();
  for (const candidate of result.candidates) {
    assert.equal(candidate.status, 'unreviewed');
    groups.set(candidate.conjunctionKey, [
      ...(groups.get(candidate.conjunctionKey) ?? []),
      candidate,
    ]);
  }
  assert.equal(groups.size, 9);
  const models = new Set();
  for (const pair of groups.values()) {
    assert.deepEqual(
      pair.map((entry) => entry.kind),
      ['model_exact', 'date_code_set'],
    );
    assert.deepEqual(pair[1].value, ['2510', '2511', '2512']);
    models.add(pair[0].value);
  }
  assert.equal(models.size, 9);
});

test('Friedrich serial subset stays unresolved with no proposal', async () => {
  const friedrich = extracted('26776');
  assert.deepEqual(friedrich.tables, []);
  const result = await proposeCpscTableCriteria(friedrich);
  assert.deepEqual(result.candidates, []);
  assert.ok(result.unresolved.some((reason) => /Only some serial numbers/u.test(reason)));
});

test('cosmetic DOM changes keep the semantic revision; a row edit changes it', async () => {
  const original = html('26773');
  const baseline = (await semanticCpscRevision(extracted('26773'))).semanticHash;
  const cosmetic = original
    .replace('<td', '<td data-tracking="ignored"')
    .replace('<table', '<!-- tracking --><table class="  extra  "')
    .replaceAll('</p>', ' </p>');
  assert.notEqual(cosmetic, original);
  const cosmeticPage = extractCpscPage(cosmetic, page('26773').canonicalUrl);
  assert.equal((await semanticCpscRevision(cosmeticPage)).semanticHash, baseline);
  const model = page('26773').tables[0][1][1];
  const edited = extractCpscPage(original.replace(model, '25302199'), page('26773').canonicalUrl);
  assert.notEqual((await semanticCpscRevision(edited)).semanticHash, baseline);
  const codes = extractCpscPage(
    original.replace('2512 (Dec-2025)', '2512 (Dec-2025) and 2601 (Jan-2026)'),
    page('26773').canonicalUrl,
  );
  assert.notEqual((await semanticCpscRevision(codes)).semanticHash, baseline);
});

test('extractor fails closed on identity contradictions and missing evidence', () => {
  const charBroil = html('26773');
  assert.throws(
    () => extractCpscPage(charBroil, page('26756').canonicalUrl),
    /canonical link contradicts/u,
  );
  assert.throws(
    () =>
      extractCpscPage(charBroil.replace('page-title', 'other-title'), page('26773').canonicalUrl),
    /no title/u,
  );
  assert.throws(
    () => extractCpscPage(charBroil.replaceAll('26-773', '26-7x3'), page('26773').canonicalUrl),
    /recall number/u,
  );
  assert.throws(() => extractCpscPage('<html></html>', page('26773').canonicalUrl));
});

test('HTML decoding matches Python html.unescape semantics', () => {
  assert.equal(unescapeHtml('A&amp;B &nbsp;&#x27;&#39;&euro;&#128;'), "A&B  ''€€");
  assert.equal(unescapeHtml('&notit; &amp &unknown;'), '¬it; & &unknown;');
  const tree = parseHtml('<p>a<script>if (a < b) { "<p>" }</script><br/>b</p>');
  assert.equal(tree.children[0].children[1].children[0], 'if (a < b) { "<p>" }');
  assert.equal(tree.children[0].children.at(-1), 'b');
});

test('production CPSC parser code contains no benchmark recall-specific branching', () => {
  const directory = new URL('supabase/functions/_shared/cpsc/', root);
  const forbidden =
    /\b(?:26756|26773|26776|26748|20164|253021\d*)\b|Char-?Broil|Bistro|\bAGA\b|Friedrich|K[ÜU]HL/iu;
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
    if (file === 'htmlEntities.ts') continue;
    const body = readFileSync(new URL(file, directory), 'utf8');
    assert.doesNotMatch(body, forbidden, file);
  }
});

const official = 'https://www.cpsc.gov/Recalls/2026/Example';

test('fetch deadline holds even when the transport ignores the abort signal', async () => {
  const started = Date.now();
  await assert.rejects(
    fetchCpscOfficialPage(official, () => new Promise(() => {}), { timeoutMs: 50 }),
    /timed out/u,
  );
  assert.ok(Date.now() - started < 2_000);
});

test('fetch deadline aborts a signal-honoring transport', async () => {
  let aborted = false;
  await assert.rejects(
    fetchCpscOfficialPage(
      official,
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      { timeoutMs: 50 },
    ),
    /timed out|aborted/u,
  );
  assert.equal(aborted, true);
});

test('fetch deadline covers a stalled response body', async () => {
  const stalled = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('<html>'));
    },
  });
  await assert.rejects(
    fetchCpscOfficialPage(
      official,
      async () => new Response(stalled, { headers: { 'content-type': 'text/html' } }),
      { timeoutMs: 50 },
    ),
    /timed out/u,
  );
});

test('fetch timeout bounds and HTTP status reporting', async () => {
  for (const timeoutMs of [0, 10_001, 1.5]) {
    await assert.rejects(
      fetchCpscOfficialPage(official, async () => new Response(''), { timeoutMs }),
    );
  }
  const failure = await fetchCpscOfficialPage(
    official,
    async () => new Response('gone', { status: 404 }),
  ).catch((error) => error);
  assert.ok(failure instanceof CpscPageFetchError);
  assert.equal(failure.httpStatus, 404);
});

function fakeDatabase(handlers) {
  const calls = [];
  return {
    calls,
    rpc(name, parameters) {
      calls.push({ name, parameters });
      const handler = handlers[name];
      if (!handler)
        return Promise.resolve({ data: null, error: { message: `unexpected ${name}` } });
      return Promise.resolve({ data: handler(parameters), error: null });
    },
  };
}

const record = {
  externalId: '20021',
  title: 'Recall C',
  description: 'Description',
  hazard: 'Hazard',
  remedy: 'Remedy',
  recallDate: '2026-09-18',
  officialUrl: 'https://cpsc.gov/Recalls/2026/Recall-C',
  rawPayload: { RecallID: 20021, RecallNumber: '26-803' },
  scopes: [{ productName: 'Product', gtin: null, modelNumber: 'C-1', additionalCriteria: null }],
};
// Phase 16.16A: the retaining RPC echoes the database-verified payload hash.
const retained = (parameters) => ({
  payloadSha256: parameters.p_payload_hash,
  payloadRetention: 'retained',
});
const observation = (status, extra = {}) => ({
  status,
  observationId: 'a0000000-0000-4000-8000-000000000001',
  identityId: 'a0000000-0000-4000-8000-000000000002',
  canonicalNoticeId: null,
  decisionClass: status === 'created' ? 'C_new_identity' : 'A_known_alias',
  revisionFlags: [],
  ...extra,
});

test('a new canonical identity proceeds to identity-bound notice creation', async () => {
  const database = fakeDatabase({
    record_cpsc_retained_observation: (p) => ({ ...observation('created'), ...retained(p) }),
    ingest_cpsc_identity_notice: () => ({ status: 'inserted', noticeId: 'notice-1' }),
  });
  const outcome = await ingestCpscRecallIdentity(database, record);
  assert.equal(outcome.status, 'inserted');
  assert.equal(outcome.noticeId, 'notice-1');
  const [observe, ingest] = database.calls;
  assert.equal(observe.parameters.p_recall_number, '26803');
  assert.equal(observe.parameters.p_canonical_url, 'https://www.cpsc.gov/Recalls/2026/Recall-C');
  assert.equal(ingest.parameters.p_observation_id, observation('created').observationId);
  assert.deepEqual(ingest.parameters.p_scopes, record.scopes);
});

test('a known identity with a notice is never rewritten; quarantine is reported', async () => {
  const known = fakeDatabase({
    record_cpsc_retained_observation: (p) =>
      observation('resolved', {
        canonicalNoticeId: 'historical-notice',
        revisionFlags: ['title_revised'],
        ...retained(p),
      }),
    // Phase 16.12: a content change is appended as a notice revision, not a rewrite.
    record_cpsc_notice_revision: () => ({
      status: 'created',
      revisionId: 'a0000000-0000-4000-8000-000000000009',
      changedFields: ['title'],
      identifierChanged: false,
    }),
  });
  const outcome = await ingestCpscRecallIdentity(known, record);
  assert.deepEqual([outcome.status, outcome.noticeId], ['unchanged', 'historical-notice']);
  assert.deepEqual(outcome.noticeRevision.changedFields, ['title']);
  assert.deepEqual(
    known.calls.map((call) => call.name),
    ['record_cpsc_retained_observation', 'record_cpsc_notice_revision'],
  );
  assert.equal(known.calls[1].parameters.p_observation_id, observation('resolved').observationId);
  const quarantined = fakeDatabase({
    record_cpsc_retained_observation: (p) => ({
      status: 'quarantined',
      observationId: 'a0000000-0000-4000-8000-000000000003',
      reason: 'API ID belongs to another historical recall',
      decisionClass: 'D_api_id_reuse',
      replayed: false,
      seenCount: 1,
      ...retained(p),
    }),
  });
  const held = await ingestCpscRecallIdentity(quarantined, record);
  assert.equal(held.status, 'quarantined');
  assert.equal(quarantined.calls.length, 1);
  await assert.rejects(
    ingestCpscRecallIdentity(
      fakeDatabase({
        record_cpsc_retained_observation: (p) => ({ status: 'resolved', ...retained(p) }),
      }),
      record,
    ),
    /invalid result/u,
  );
});

test('page worker persists evidence and unreviewed proposals through narrow RPCs only', async () => {
  const target = {
    identityId: 'a0000000-0000-4000-8000-000000000010',
    officialRecallNumber: '26773',
    canonicalUrl: page('26773').canonicalUrl,
    soleScopeId: 'a0000000-0000-4000-8000-000000000011',
  };
  const body = html('26773');
  // Phase 16.13: the database recomputes the worker's coverage ledger.
  const { page: extractedPage, census } = extractCpscPageStructure(body, target.canonicalUrl);
  const { summary } = await buildCpscSourceCoverage(extractedPage, census);
  const database = fakeDatabase({
    record_cpsc_page_revision: () => ({ status: 'created', revisionId: 'revision-1' }),
    record_cpsc_page_fetch: () => 'fetch-1',
    propose_cpsc_candidate_criterion: () => ({ status: 'created', candidateId: 'c' }),
    record_cpsc_page_coverage: () => ({ status: 'created', ...summary }),
  });
  const result = await ingestCpscOfficialPage(
    database,
    target,
    async () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  );
  assert.equal(result.status, 'recorded');
  assert.equal(result.proposalsCreated, 18);
  const names = new Set(database.calls.map((call) => call.name));
  assert.deepEqual([...names].sort(), [
    'propose_cpsc_candidate_criterion',
    'record_cpsc_page_coverage',
    'record_cpsc_page_fetch',
    'record_cpsc_page_revision',
  ]);
  // The ledger is recorded last, once every proposal it must bind to exists.
  assert.equal(database.calls.at(-1).name, 'record_cpsc_page_coverage');
  assert.equal(database.calls.at(-1).parameters.p_revision_id, 'revision-1');
  assert.equal(result.coverage.coverageStatus, 'complete');
  const revision = database.calls.find((call) => call.name === 'record_cpsc_page_revision');
  assert.equal(revision.parameters.p_normalized_evidence.recallNumber, '26773');
  for (const call of database.calls.filter(
    (entry) => entry.name === 'propose_cpsc_candidate_criterion',
  )) {
    assert.equal(call.parameters.p_revision_id, 'revision-1');
    assert.equal(call.parameters.p_proposed_scope_id, target.soleScopeId);
    assert.equal(
      call.parameters.p_evidence_address.sourceSemanticRevision,
      revision.parameters.p_evidence_hash,
    );
  }
});

test('page worker records nothing for a contradicting page and records HTTP failures', async () => {
  const database = fakeDatabase({ record_cpsc_page_fetch: () => 'fetch-404' });
  const wrong = await ingestCpscOfficialPage(
    database,
    {
      identityId: 'a0000000-0000-4000-8000-000000000010',
      officialRecallNumber: '26756',
      canonicalUrl: page('26756').canonicalUrl,
      soleScopeId: null,
    },
    async () => new Response(html('26773'), { headers: { 'content-type': 'text/html' } }),
  );
  assert.equal(wrong.status, 'extraction_failed');
  assert.equal(database.calls.length, 0);
  const missing = await ingestCpscOfficialPage(
    database,
    {
      identityId: 'a0000000-0000-4000-8000-000000000010',
      officialRecallNumber: '26756',
      canonicalUrl: page('26756').canonicalUrl,
      soleScopeId: null,
    },
    async () => new Response('gone', { status: 404 }),
  );
  assert.equal(missing.status, 'fetch_failed');
  assert.deepEqual(
    database.calls.map((call) => [call.name, call.parameters.p_http_status]),
    [['record_cpsc_page_fetch', 404]],
  );
});

test('a ledger-built MODEL AND DATE CODE conjunction is consumable by deterministic_v2', async () => {
  const url = 'https://www.cpsc.gov/Recalls/2026/Recall-A';
  const scope = { scope_id: 'a0000000-0000-4000-8000-000000000021', product_name: 'Grill' };
  const recall = {
    recall_notice_id: 'a0000000-0000-4000-8000-000000000020',
    recall_notice_updated_at: '2026-09-25T00:00:00Z',
    source_authority: 'U.S. Consumer Product Safety Commission (CPSC)',
    source_external_id: '20001',
    source_official_url: url,
    source_is_authoritative: true,
    title: 'Recall A',
    description: null,
    hazard: null,
    remedy: null,
    recall_date: '2026-09-10',
    raw_payload: {},
    scopes: [],
  };
  const ids = ['a0000000-0000-4000-8000-000000000031', 'a0000000-0000-4000-8000-000000000032'];
  const provenance = {
    authority: 'CPSC',
    officialUrl: url,
    sourceField: 'cpsc-page:table/row/model',
    normalizationRule: 'identifier_v2',
  };
  const set = {
    semantics: 'all_of',
    review: {
      origin: 'human_review_ledger',
      revisionId: 'a0000000-0000-4000-8000-000000000040',
      sourceRevisionHash: 'a'.repeat(64),
      conjunctionGroup: 'table/row',
      scopeId: scope.scope_id,
      scopeFingerprint: 'b'.repeat(64),
      candidateIds: ids,
      reviewEventIds: [
        'a0000000-0000-4000-8000-000000000051',
        'a0000000-0000-4000-8000-000000000052',
      ],
      reviewerIds: ['a0000000-0000-4000-8000-000000000061', 'a0000000-0000-4000-8000-000000000061'],
      reviewedAt: '2026-09-25T00:00:00Z',
    },
    criteria: [
      {
        id: `cpsc-ledger-${ids[0]}`,
        kind: 'model_number',
        operator: 'equals',
        required: true,
        value: 'MODEL-3',
        provenance,
      },
      {
        id: `cpsc-ledger-${ids[1]}`,
        kind: 'date_code',
        operator: 'one_of',
        required: true,
        values: ['2510', '2511'],
        provenance,
      },
    ],
  };
  const validated = await validateLiveReviewedCriteriaV2(recall, scope, set);
  const official = projectRecallForProductionV2({ ...recall, scopes: [scope] }, [validated]);
  const product = (model, attributes) =>
    projectOwnedProductForProductionV2({
      owned_product_id: 'p',
      owned_product_updated_at: '2026-09-25T00:00:00Z',
      user_id: 'u',
      product_name: 'Grill',
      brand: null,
      category: null,
      gtin: null,
      model_number: model,
      serial_number: null,
      lot_number: null,
      purchase_date: null,
      identification_method: 'manual',
      safety_attributes: attributes,
    });
  const decide = (model, attributes) =>
    evaluateProductionPairV2(product(model, attributes), official).decision;
  assert.equal(decide('MODEL-3', { date_code: '2510' }), 'confirmed');
  assert.notEqual(decide('MODEL-3', { date_code: '2601' }), 'confirmed');
  assert.notEqual(decide('MODEL-3', {}), 'confirmed');
  assert.notEqual(decide('MODEL-9', { date_code: '2510' }), 'confirmed');
  const unreviewed = projectRecallForProductionV2({ ...recall, scopes: [scope] }, [null]);
  assert.notEqual(
    evaluateProductionPairV2(product('MODEL-3', { date_code: '2510' }), unreviewed).decision,
    'confirmed',
  );
});
