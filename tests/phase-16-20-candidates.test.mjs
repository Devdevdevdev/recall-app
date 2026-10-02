import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

import { classifySourceWatermarkDbError } from '../supabase/functions/_shared/recallSources/watermarkDbError.ts';

const regression = {
  code: '23514',
  message: 'source watermark cannot move backward from 2026-09-27 to 2026-09-26',
};

test('DB guard classification is exact and does not disclose database text', () => {
  assert.equal(classifySourceWatermarkDbError(regression), 'watermark_regression');
  assert.equal(
    classifySourceWatermarkDbError({
      code: '23514',
      message: 'source watermark cursor is malformed or has an unexpected kind',
    }),
    'watermark_invalid',
  );
  assert.equal(
    classifySourceWatermarkDbError({
      code: '23514',
      message: 'source watermark existing cursor is malformed or has an unexpected kind',
    }),
    'watermark_invalid',
  );
  for (const error of [
    { ...regression, code: 'XX000' },
    { code: '23514', message: 'unrelated constraint failed' },
    { code: '23514', message: 'source watermark cannot move backward: fake' },
    null,
  ]) {
    assert.equal(classifySourceWatermarkDbError(error), null);
  }
});

async function invokeChild({
  storedDate,
  requestedDate,
  storedKind = 'last_updated_date',
  dbError = null,
}) {
  const path = new URL(
    '../audits/phase-16-20/candidate-a/supabase/functions/ingest-recall-source/index.ts',
    import.meta.url,
  );
  const source = await readFile(path, 'utf8');
  const withoutImports = source.replace(/^import[\s\S]*?;\n/gmu, '');
  const js = ts.transpileModule(withoutImports, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  let handler;
  let watermark = { kind: storedKind, value: storedDate };
  const database = {
    rpc: async (name, args) => {
      if (name === 'get_recall_source_sync_state') {
        return { data: [{ is_active: true, watermark }], error: null };
      }
      if (name === 'record_recall_source_sync_result') {
        if (dbError) return { error: dbError };
        watermark = args.p_watermark;
        return { error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  vm.runInNewContext(js, {
    Deno: {
      env: {
        get: (key) =>
          ({
            SUPABASE_URL: 'http://localhost:54321',
            SUPABASE_SERVICE_ROLE_KEY: 'fixture',
            RECALL_INGESTION_KEY: 'fixture',
          })[key] ?? null,
      },
      serve: (callback) => {
        handler = callback;
      },
    },
    createClient: () => database,
    getRecallSourceAdapter: () => ({
      definition: { retrieval: { watermarkKind: 'last_updated_date' } },
      retrieve: async () => [],
      watermarkFor: (_notices, input) => ({ kind: 'last_updated_date', value: input.endDate }),
    }),
    ingestCpscRecallIdentity: () => {
      throw new Error('CPSC path not expected');
    },
    classifyCpscIngestion: () => {
      throw new Error('CPSC path not expected');
    },
    emptyOutcomeCounts: () => counts(0, 0, 0, 0, 0),
    sourceRunComplete: () => true,
    classifySourceWatermarkDbError,
    isJsonObject: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    Response,
    Date,
  });
  const response = await handler({
    method: 'POST',
    headers: { get: () => 'fixture' },
    json: async () => ({
      sourceKey: 'health_canada',
      startDate: requestedDate,
      endDate: requestedDate,
      maxRecords: 1,
      dryRun: false,
    }),
  });
  return { status: response.status, body: await response.json(), watermark };
}

test('child returns a sanitized non-retryable 409 and leaves a backward cursor unchanged', async () => {
  const result = await invokeChild({
    storedDate: '2026-09-27',
    requestedDate: '2026-09-26',
    dbError: regression,
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'watermark_regression');
  assert.equal(result.watermark.value, '2026-09-27');
  assert.doesNotMatch(
    JSON.stringify(result.body),
    /23514|trigger|schema|2026-09-27 to 2026-09-26/iu,
  );
});

test('child accepts the same and a forward cursor', async () => {
  for (const requestedDate of ['2026-09-27', '2026-09-28']) {
    const result = await invokeChild({ storedDate: '2026-09-27', requestedDate });
    assert.equal(result.status, 200);
    assert.equal(result.watermark.value, requestedDate);
  }
});

test('wrong-kind and unrelated DB errors never become watermark_regression', async () => {
  for (const [dbError, status, code] of [
    [
      { code: '23514', message: 'source watermark cursor is malformed or has an unexpected kind' },
      409,
      'watermark_invalid',
    ],
    [
      {
        code: '23514',
        message: 'source watermark existing cursor is malformed or has an unexpected kind',
      },
      409,
      'watermark_invalid',
    ],
    [{ code: '23514', message: 'other constraint' }, 500, undefined],
  ]) {
    const result = await invokeChild({
      storedDate: '2026-09-27',
      requestedDate: '2026-09-27',
      dbError,
    });
    assert.equal(result.status, status);
    assert.equal(result.body.code, code);
    assert.doesNotMatch(JSON.stringify(result.body), /23514|constraint|schema|trigger/iu);
  }
});

function sourceStats(outcomes) {
  return {
    fetched: Object.values(outcomes).reduce((sum, value) => sum + value, 0),
    inserted: outcomes.processed,
    updated: 0,
    unchanged: outcomes.unchanged,
    rejected: outcomes.failed,
    outcomes,
  };
}

const counts = (processed, unchanged, quarantined, unresolved, failed) => ({
  processed,
  unchanged,
  quarantined,
  unresolved,
  failed,
});

async function invokeAggregate(sourceResults) {
  const path = new URL(
    '../audits/phase-16-20/candidate-b/supabase/functions/ingest-recall-sources/index.ts',
    import.meta.url,
  );
  const source = await readFile(path, 'utf8');
  const withoutImports = source.replace(/^import[\s\S]*?;\n/gmu, '');
  const js = ts.transpileModule(withoutImports, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const keys = sourceResults.map((_, index) => `source_${index}`);
  let handler;
  let call = 0;
  const database = {
    rpc: async (name) => {
      if (name === 'get_active_recall_source_keys') {
        return { data: keys.map((source_key) => ({ source_key })), error: null };
      }
      if (name === 'get_recall_source_sync_state') {
        return { data: [{ watermark: null }], error: null };
      }
      if (name === 'record_recall_source_sync_result') return { data: null, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  vm.runInNewContext(js, {
    Deno: {
      env: {
        get: (key) =>
          ({
            SUPABASE_URL: 'http://localhost:54321',
            SUPABASE_SERVICE_ROLE_KEY: 'fixture',
            RECALL_INGESTION_KEY: 'fixture',
          })[key] ?? null,
      },
      serve: (callback) => {
        handler = callback;
      },
    },
    createClient: () => database,
    getRecallSourceAdapter: () => ({ definition: { retrieval: { maximumWindowDays: 14 } } }),
    isJsonObject: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    fetch: async () =>
      new Response(JSON.stringify({ stats: sourceResults[call++], affectedRecallIds: [] }), {
        status: 200,
      }),
    Response,
    URL,
    TextDecoder,
    Date,
  });
  const response = await handler({
    method: 'POST',
    headers: { get: () => 'fixture' },
    json: async () => ({ startDate: '2026-09-26', endDate: '2026-09-27', maxRecords: 100 }),
  });
  return { status: response.status, body: await response.json() };
}

for (const [name, outcomes] of [
  ['all unchanged', counts(0, 3, 0, 0, 0)],
  ['processed and unchanged', counts(2, 1, 0, 0, 0)],
  ['quarantined and unchanged', counts(0, 2, 1, 0, 0)],
  ['unresolved and processed', counts(1, 0, 0, 2, 0)],
]) {
  test(`aggregate accounts for ${name}`, async () => {
    const { status, body } = await invokeAggregate([sourceStats(outcomes)]);
    assert.equal(status, 200);
    assert.equal(body.stats.accountedRecords, 3);
    assert.deepEqual(body.stats.outcomes, outcomes);
    assert.deepEqual(body.sources[0].outcomes, outcomes);
    assert.equal(body.sources[0].accountedRecords, 3);
    assert.equal(
      Object.values(body.stats.outcomes).reduce((a, b) => a + b, 0),
      3,
    );
  });
}

test('failed row remains visible in a mixed two-source response', async () => {
  const first = counts(1, 1, 1, 1, 0);
  const second = counts(0, 1, 0, 0, 1);
  const { status, body } = await invokeAggregate([sourceStats(first), sourceStats(second)]);
  assert.equal(status, 200);
  assert.equal(body.sourceFailures, 1);
  assert.equal(body.successfulSources, 1);
  assert.equal(body.stats.accountedRecords, 6);
  assert.equal(body.stats.fetched, 3); // Existing accepted-record meaning is preserved.
  assert.deepEqual(body.stats.outcomes, counts(1, 2, 1, 1, 1));
  assert.equal(body.sources[1].status, 'failed');
  assert.equal(body.sources[1].outcomes.failed, 1);
});

test('inconsistent child accounting fails closed', async () => {
  const inconsistent = sourceStats(counts(1, 0, 0, 0, 0));
  inconsistent.fetched = 2;
  const { status, body } = await invokeAggregate([inconsistent]);
  assert.equal(status, 502);
  assert.equal(body.sources[0].status, 'failed');
  assert.equal(body.sources[0].errorCode, 'invalid source outcome metrics');
});
