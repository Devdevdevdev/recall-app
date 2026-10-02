import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  processCpscPageClaim,
  runCpscPageWorker,
  validatePageWorkerOptions,
} from '../supabase/functions/_shared/cpsc/scheduledPageWorker.ts';
import { extractCpscPageStructure } from '../supabase/functions/_shared/cpsc/htmlExtractor.ts';
import { semanticCpscRevision } from '../supabase/functions/_shared/cpsc/pageEvidence.ts';
import {
  buildCpscSourceCoverage,
  summarizeCpscCoverageLedger,
} from '../supabase/functions/_shared/cpsc/sourceCoverage.ts';

const canonical =
  'https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock';
const fixture = readFileSync(
  new URL('fixtures/cpsc-pages/char-broil.html', import.meta.url),
  'utf8',
);
const claim = (id = 'claim-1') => ({
  claim_id: id,
  identity_id: 'identity-1',
  official_recall_number: '26773',
  canonical_url: canonical,
  sole_scope_id: null,
});
const htmlResponse = (body = fixture) =>
  new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
function databaseFor(claims = []) {
  const calls = [];
  const database = {
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      if (name === 'claim_cpsc_page_evidence') return { data: claims.splice(0, 1), error: null };
      if (name === 'finish_cpsc_page_attempt') {
        return { data: { outcome: parameters.p_outcome }, error: null };
      }
      if (name === 'retain_cpsc_page_transport') {
        return { data: { rawPageHash: parameters.p_snapshot.rawPageHash }, error: null };
      }
      if (name === 'commit_cpsc_page_evidence_verified') {
        const coverage = await summarizeCpscCoverageLedger(parameters.p_ledger);
        return { data: { outcome: 'fetched_changed', coverage }, error: null };
      }
      return { data: null, error: new Error('unexpected RPC') };
    },
  };
  return { database, calls };
}

test('worker input is bounded and cannot specify an arbitrary URL', () => {
  assert.deepEqual(validatePageWorkerOptions({}), {
    dryRun: false,
    maxPages: 10,
    timeBudgetMs: 20_000,
  });
  for (const input of [
    { url: canonical },
    { maxPages: 11 },
    { maxPages: 0 },
    { timeBudgetMs: 20_001 },
    { timeBudgetMs: -1 },
    { dryRun: 'false' },
  ])
    assert.throws(() => validatePageWorkerOptions(input));
});

test('dry run makes no claim and a valid page commits once atomically', async () => {
  const { database, calls } = databaseFor([claim()]);
  const dry = await runCpscPageWorker(database, { dryRun: true });
  assert.equal(dry.claimed, 0);
  assert.equal(calls.length, 0);
  const outcome = await processCpscPageClaim(database, claim(), async () => htmlResponse());
  assert.equal(outcome, 'fetched_changed');
  assert.deepEqual(
    calls.map((item) => item.name),
    ['retain_cpsc_page_transport', 'commit_cpsc_page_evidence_verified'],
  );
  const payload = calls[1].parameters;
  assert.equal(payload.p_revision.normalized.recallNumber, '26773');
  assert.equal(payload.p_snapshot.finalUrl, canonical);
  assert.equal(payload.p_raw_page_hex, Buffer.from(fixture, 'utf8').toString('hex'));
  assert.ok(payload.p_candidates.length > 0);
  assert.ok(payload.p_candidates.every((candidate) => !('status' in candidate)));
});

test('26777-shaped wrong recall is an attempt only, never a revision or review', async () => {
  const { database, calls } = databaseFor();
  const wrong = { ...claim(), official_recall_number: '26777' };
  assert.equal(
    await processCpscPageClaim(database, wrong, async () => htmlResponse()),
    'identity_redirect',
  );
  assert.deepEqual(
    calls.map((item) => item.name),
    ['retain_cpsc_page_transport', 'finish_cpsc_page_attempt'],
  );
  assert.equal(calls[1].parameters.p_error_code, 'recall_number_mismatch');
});

test('a page declaring another canonical URL is an identity question, not structure', async () => {
  const { database, calls } = databaseFor();
  const moved = fixture.replace(
    `<link rel="canonical" href="${canonical}" />`,
    `<link rel="canonical" href="${canonical}-0" />`,
  );
  assert.notEqual(moved, fixture);
  const outcome = await processCpscPageClaim(database, claim(), async () => htmlResponse(moved));
  assert.equal(outcome, 'identity_redirect');
  assert.deepEqual(
    calls.map((item) => item.name),
    ['retain_cpsc_page_transport', 'finish_cpsc_page_attempt'],
  );
  assert.equal(calls[1].parameters.p_error_code, 'canonical_link_mismatch');
  assert.equal(calls[1].parameters.p_final_url, canonical);
  assert.ok(!calls.some((item) => item.name === 'commit_cpsc_page_evidence_verified'));
});

test('safe redirect to another recall ends as identity_redirect before commit', async () => {
  const { database, calls } = databaseFor();
  let requests = 0;
  const outcome = await processCpscPageClaim(database, claim(), async () => {
    requests++;
    return requests === 1
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://www.cpsc.gov/Recalls/2026/Other-Recall' },
        })
      : htmlResponse();
  });
  assert.equal(requests, 2);
  assert.equal(outcome, 'identity_redirect');
  assert.deepEqual(
    calls.map((item) => item.name),
    ['finish_cpsc_page_attempt'],
  );
  assert.equal(calls[0].parameters.p_error_code, 'final_url_mismatch');
});

test('three redirect hops are accepted and a fourth is refused', async () => {
  const accepted = databaseFor();
  let hops = 0;
  const redirects = async () => {
    if (hops++ < 3) return new Response(null, { status: 302, headers: { location: canonical } });
    return htmlResponse();
  };
  assert.equal(
    await processCpscPageClaim(accepted.database, claim(), redirects),
    'fetched_changed',
  );
  assert.equal(hops, 4);
  assert.equal(accepted.calls[1].name, 'commit_cpsc_page_evidence_verified');
  const refused = databaseFor();
  assert.equal(
    await processCpscPageClaim(
      refused.database,
      claim(),
      async () => new Response(null, { status: 302, headers: { location: canonical } }),
    ),
    'identity_redirect',
  );
  assert.equal(refused.calls[0].name, 'finish_cpsc_page_attempt');
});

test('DOM attribute order does not create a semantic revision', async () => {
  const reordered = fixture.replace('<html lang="en" dir="ltr"', '<html dir="ltr" lang="en"');
  assert.notEqual(reordered, fixture);
  const originalPage = extractCpscPageStructure(fixture, canonical).page;
  const reorderedPage = extractCpscPageStructure(reordered, canonical).page;
  assert.equal(
    (await semanticCpscRevision(originalPage)).semanticHash,
    (await semanticCpscRevision(reorderedPage)).semanticHash,
  );
});

test('temporary and unsupported fetch outcomes record attempts without evidence', async () => {
  const cases = [
    [async () => new Response('', { status: 500 }), 'temporary_failure'],
    [async () => new Response('', { status: 429 }), 'temporary_failure'],
    [async () => new Response('', { status: 404 }), 'permanent_unsupported'],
    [
      async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
      'permanent_unsupported',
    ],
    [
      async () => {
        throw new Error('network unavailable');
      },
      'temporary_failure',
    ],
  ];
  for (const [fetchImpl, expected] of cases) {
    const { database, calls } = databaseFor();
    assert.equal(await processCpscPageClaim(database, claim(), fetchImpl), expected);
    assert.deepEqual(
      calls.map((item) => item.name),
      ['finish_cpsc_page_attempt'],
    );
  }
});

test('unsupported HTML structure is durable without a semantic revision', async () => {
  const { database, calls } = databaseFor();
  const outcome = await processCpscPageClaim(database, claim(), async () =>
    htmlResponse('<html><body>No recall fields</body></html>'),
  );
  assert.equal(outcome, 'unresolved_structure');
  assert.deepEqual(
    calls.map((item) => item.name),
    ['retain_cpsc_page_transport', 'finish_cpsc_page_attempt'],
  );
  assert.equal(calls[1].parameters.p_error_code, 'extractor_rejected');
});

test('time budget and page cap independently stop further claims', async () => {
  let clock = 0;
  const slow = databaseFor([claim('a'), claim('b'), claim('c')]);
  const originalRpc = slow.database.rpc;
  slow.database.rpc = async (name, parameters) => {
    const response = await originalRpc(name, parameters);
    if (name === 'claim_cpsc_page_evidence') clock = 20_000;
    return response;
  };
  const timed = await runCpscPageWorker(
    slow.database,
    { maxPages: 10 },
    {
      fetchImpl: async () => htmlResponse(),
      now: () => clock,
    },
  );
  assert.equal(timed.claimed, 1);
  assert.equal(timed.stoppedBy, 'time_limit');
  assert.deepEqual(timed.outcomes, ['budget_deferred']);

  const capped = databaseFor([claim('d'), claim('e')]);
  const result = await runCpscPageWorker(
    capped.database,
    { maxPages: 1 },
    {
      fetchImpl: async () => htmlResponse(),
    },
  );
  assert.equal(result.claimed, 1);
  assert.equal(result.stoppedBy, 'page_limit');
});

test('three claimed pages never exceed two concurrent fetches', async () => {
  const { database } = databaseFor([claim('a'), claim('b'), claim('c')]);
  let active = 0;
  let maximum = 0;
  const result = await runCpscPageWorker(
    database,
    { maxPages: 3 },
    {
      fetchImpl: async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return htmlResponse();
      },
    },
  );
  assert.equal(result.claimed, 3);
  assert.equal(result.outcomes.length, 3);
  assert.equal(maximum, 2);
});

test('Intertex legacy semantic revision has one canonical table but no stored table identity', async () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../docs/phase-16-14-backfill-manifest.json', import.meta.url), 'utf8'),
  );
  const historical = manifest.pages.find((item) => item.recallNumber === '20162');
  const page = historical.normalizedEvidence;
  const revision = await semanticCpscRevision(page);
  const rows = page.tables[0].map((row, index) => ({
    cells: row.length,
    headerCells: index === 0 ? row.length : 0,
    inHead: index === 0,
    colspanCells: 0,
    rowspans: [],
    nestedTables: 0,
    blank: false,
  }));
  const coverage = await buildCpscSourceCoverage(
    page,
    {
      version: 'phase-16.13-census-v1',
      descriptionTables: [{ rows, nestedTables: 0 }],
      descriptionUnaccountedText: '',
      detailTablesOutsideDescription: 0,
    },
    revision,
  );
  const ledgerTables = coverage.ledger.structures.filter((item) => item.kind === 'table');
  assert.equal(revision.semanticHash, historical.evidenceHash);
  assert.equal(revision.tableIdentities.length, 1);
  assert.equal(ledgerTables.length, 1);
  assert.equal(ledgerTables[0].tableIdentity, revision.tableIdentities[0].identity);
  assert.equal(
    revision.tableIdentities[0].identity,
    'description/table/0/6f3697c62ebe05214054ed28ba707b7c88532805fc54be5af0dcda93d8ec22b7',
  );
});

test('rejected semantic commit terminalizes after transport retention', async () => {
  const { database, calls } = databaseFor();
  const original = database.rpc;
  let rejectedPayload;
  database.rpc = (name, parameters) => {
    if (name === 'commit_cpsc_page_evidence_verified') {
      rejectedPayload = parameters;
      return Promise.resolve({ data: null, error: { code: 'P0001' } });
    }
    return original(name, parameters);
  };
  const outcome = await processCpscPageClaim(database, claim(), async () => htmlResponse());
  assert.equal(outcome, 'evidence_rejected');
  assert.deepEqual(
    calls.map((item) => item.name),
    ['retain_cpsc_page_transport', 'finish_cpsc_page_attempt'],
  );
  assert.equal(calls[1].parameters.p_error_code, 'semantic_commit_rejected');
  assert.equal(calls[1].parameters.p_raw_page_hash, calls[0].parameters.p_snapshot.rawPageHash);
  const retainedBytes = Buffer.from(calls[0].parameters.p_raw_page_hex, 'hex');
  const replay = extractCpscPageStructure(retainedBytes.toString('utf8'), canonical);
  const replayRevision = await semanticCpscRevision(replay.page);
  const replayCoverage = await buildCpscSourceCoverage(replay.page, replay.census, replayRevision);
  assert.equal(replayRevision.semanticHash, rejectedPayload.p_revision.semanticHash);
  assert.deepEqual(replayCoverage.ledger, rejectedPayload.p_ledger);
});

test('database timeout and transport-retention failure have stable terminal outcomes', async () => {
  for (const [stage, code, expected] of [
    ['commit_cpsc_page_evidence_verified', '57014', 'database_timeout'],
    ['commit_cpsc_page_evidence_verified', '42501', 'internal_failure'],
    ['retain_cpsc_page_transport', 'XX000', 'internal_failure'],
  ]) {
    const { database, calls } = databaseFor();
    const original = database.rpc;
    database.rpc = (name, parameters) =>
      name === stage
        ? Promise.resolve({ data: null, error: { code } })
        : original(name, parameters);
    assert.equal(
      await processCpscPageClaim(database, claim(), async () => htmlResponse()),
      expected,
    );
    assert.equal(calls.at(-1).name, 'finish_cpsc_page_attempt');
    assert.equal(
      calls.at(-1).parameters.p_error_code,
      code === '42501' ? 'claim_inactive' : expected,
    );
  }
});

test('unexpected post-claim exception still attempts terminalization and reports failure counts', async () => {
  const { database, calls } = databaseFor([claim()]);
  const original = database.rpc;
  database.rpc = (name, parameters) =>
    name === 'commit_cpsc_page_evidence_verified'
      ? Promise.resolve({ data: { outcome: 'impossible', coverage: {} }, error: null })
      : original(name, parameters);
  const result = await runCpscPageWorker(
    database,
    { maxPages: 1 },
    {
      fetchImpl: async () => htmlResponse(),
    },
  );
  assert.equal(result.claimed, 1);
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.errorCategories, ['internal_failure']);
  assert.equal(calls.at(-1).parameters.p_error_code, 'worker_exception');
});
