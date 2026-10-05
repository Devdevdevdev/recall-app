// Phase 17.7a-2: product-check stage inside run-recall-automation. Local only.
// The disabled path is the reference behaviour: with the flag false the run must
// be indistinguishable from a pre-17.7a-2 run apart from one lease-bound read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  parseAutomationRunRequest,
  PRODUCT_CHECK_LATEST_START_MS,
  PRODUCT_CHECK_MAX_PRODUCTS_PER_RUN,
  runRecallAutomation,
} from '../supabase/functions/_shared/automation/index.ts';

const root = new URL('../', import.meta.url);
const runId = '10000000-0000-4000-8000-000000000001';
const leaseToken = '20000000-0000-4000-8000-000000000002';
const recallId = '30000000-0000-4000-8000-000000000003';
const MIGRATION =
  'supabase/migrations/20261003090000_phase_17_7a_2_automation_product_check_plan.sql';

const claimed = {
  status: 'claimed',
  runId,
  leaseToken,
  windowStart: '2026-09-10',
  windowEnd: '2026-09-16',
  maxRecalls: 20,
  maxCandidatePairs: 200,
  maxAiEscalations: 5,
  notificationBatchSize: 25,
  aiEnabled: false,
  pushEnabled: true,
};
const ingestion = {
  fetched: 2,
  inserted: 1,
  updated: 0,
  unchanged: 1,
  rejected: 0,
  affectedRecallIds: [recallId],
  sourceFailures: 0,
  successfulSources: 2,
};
const matching = {
  recallsProcessed: 1,
  candidatePairs: 1,
  deterministicResolved: 1,
  nemotronEscalated: 0,
  confirmed: 0,
  rejected: 1,
  needsReview: 0,
  alertsCreated: 0,
  failures: 0,
  providerFailures: 0,
  limitsReached: 0,
  resolvedRecallIds: [recallId],
  unresolvedRecalls: [],
};
const push = { claimed: 0, accepted: 0, failed: 0, invalidDevices: 0, transientFailures: 0 };
const workerSummary = (overrides = {}) => ({
  claimed: 1,
  completed: 1,
  continued: 0,
  retrying: 0,
  exhausted: 0,
  rearmed: 0,
  staleLeases: 0,
  confirmed: 0,
  rejected: 0,
  possibleMatches: 1,
  alertsCreated: 0,
  aiCalls: 0,
  ...overrides,
});

/**
 * A small in-memory job queue standing in for the worker: it only changes when the
 * worker is actually invoked, so "no call" provably means "no claim, no change".
 */
function jobQueue(count) {
  const jobs = Array.from({ length: count }, (_, index) => ({ id: index, status: 'pending' }));
  return {
    jobs,
    snapshot: () => JSON.stringify(jobs),
    claim(limit) {
      const due = jobs.filter((job) => job.status === 'pending').slice(0, limit);
      for (const job of due) job.status = 'running';
      return due;
    },
  };
}

function fixture({ enabled = false, queue = jobQueue(0), worker, plan, overrides = {} } = {}) {
  const calls = [];
  let clock = 0;
  const store = {
    async claimRun(input) {
      calls.push(['claim', input]);
      return claimed;
    },
    async recordIngestion(input) {
      calls.push(['record-ingestion', input]);
    },
    async listPendingRecalls(input) {
      calls.push(['pending', input]);
      return [recallId];
    },
    async recordMatching(input) {
      calls.push(['record-matching', input]);
    },
    async completeRun(input) {
      calls.push(['complete', input]);
    },
    ...overrides.store,
  };
  const dependencies = {
    store,
    async ingest(input) {
      calls.push(['ingest', input]);
      return ingestion;
    },
    async match(input) {
      calls.push(['match', input]);
      return matching;
    },
    async push(input) {
      calls.push(['push', input]);
      return push;
    },
    pushDeliveryGateEnabled: true,
    now: () => clock,
    productCheck: {
      async readPlan(input) {
        calls.push(['product-plan', input]);
        if (plan) return plan(input);
        return { enabled };
      },
      async runWorker(input) {
        calls.push(['product-worker', input]);
        if (worker) return worker(input, queue);
        const claimedJobs = queue.claim(input.maxProducts);
        for (const job of claimedJobs) job.status = 'complete';
        return workerSummary({
          claimed: claimedJobs.length,
          completed: claimedJobs.length,
          possibleMatches: 0,
        });
      },
    },
    ...overrides.dependencies,
  };
  return {
    calls,
    dependencies,
    names: () => calls.map(([name]) => name),
    advance: (ms) => {
      clock += ms;
    },
  };
}

const run = (dependencies) => runRecallAutomation(parseAutomationRunRequest({}), dependencies);
const completion = (calls) => calls.find(([name]) => name === 'complete')?.[1];
const without = (names, removed) => names.filter((name) => !removed.includes(name));

// ---------------------------------------------------------------------------
// A, Q: disabled is the reference behaviour
// ---------------------------------------------------------------------------
test('A. flag false: the worker is never called, no job is claimed or changed', async () => {
  const queue = jobQueue(4);
  const before = queue.snapshot();
  const { calls, dependencies, names } = fixture({ enabled: false, queue });
  const result = await run(dependencies);
  assert.equal(names().includes('product-worker'), false);
  assert.equal(queue.snapshot(), before, 'no claim and no job modification');
  assert.deepEqual(calls.find(([name]) => name === 'product-plan')?.[1], { runId, leaseToken });
  assert.equal(result.status, 'success');
  assert.equal(result.errorStep, null);
  assert.equal(result.productCheck.status, 'disabled');
  assert.equal(result.productCheck.enabled, false);
  assert.equal(result.productCheck.attempted, false);
  assert.equal(result.productCheck.claimed, 0);
});

test('A. flag false: the run is identical to a run without the stage (calls, status, push)', async () => {
  const withStage = fixture({ enabled: false });
  const reference = fixture();
  delete reference.dependencies.productCheck;
  const a = await run(withStage.dependencies);
  const b = await run(reference.dependencies);
  assert.deepEqual(without(withStage.names(), ['product-plan']), reference.names());
  assert.deepEqual(completion(withStage.calls), completion(reference.calls));
  assert.equal(b.productCheck, null);
  assert.deepEqual({ ...a, productCheck: null }, b);
});

test('A. flag false on every partial/failed path changes no status and calls no worker', async () => {
  const failing = Object.assign(new Error('x'), { code: 'child_http_502' });
  const scenarios = {
    ingestion: { dependencies: { ingest: async () => Promise.reject(failing) } },
    pending: {
      store: { listPendingRecalls: async () => Promise.reject(new Error('db')) },
    },
    matching: { dependencies: { match: async () => Promise.reject(failing) } },
    source: {
      dependencies: { ingest: async () => ({ ...ingestion, sourceFailures: 1 }) },
    },
    push: { dependencies: { push: async () => Promise.reject(failing) } },
  };
  for (const [label, overrides] of Object.entries(scenarios)) {
    const withStage = fixture({ enabled: false, overrides });
    const reference = fixture({ overrides });
    delete reference.dependencies.productCheck;
    const a = await run(withStage.dependencies);
    const b = await run(reference.dependencies);
    assert.equal(withStage.names().includes('product-worker'), false, label);
    assert.deepEqual(completion(withStage.calls), completion(reference.calls), label);
    assert.deepEqual({ ...a, productCheck: null }, b, label);
  }
});

test('Q. the product-check flag ships false and nothing in 17.7a-2 enables it', async () => {
  const p17 = await readFile(
    new URL(
      'supabase/migrations/20261002120000_phase_17_7a_1_owned_product_recall_checks.sql',
      root,
    ),
    'utf8',
  );
  assert.match(p17, /add column product_check_enabled boolean not null default false/u);
  const enabling = /product_check_enabled\s*(=|:=)\s*true|product_check_enabled\s+true/iu;
  for (const file of [
    MIGRATION,
    'supabase/functions/run-recall-automation/index.ts',
    'supabase/functions/run-recall-automation/children.ts',
    'supabase/functions/run-recall-automation/store.ts',
    'supabase/functions/_shared/automation/orchestrator.ts',
  ]) {
    assert.doesNotMatch(await readFile(new URL(file, root), 'utf8'), enabling, file);
  }
  const migration = await readFile(new URL(MIGRATION, root), 'utf8');
  assert.doesNotMatch(migration, /\b(update|insert|alter)\b[^;]*recall_automation_control/iu);
});

// ---------------------------------------------------------------------------
// B, C, D: enabled, bounded
// ---------------------------------------------------------------------------
test('B. flag true with no due job: success, worker summary zero, nothing changed', async () => {
  const queue = jobQueue(0);
  const { dependencies, names } = fixture({ enabled: true, queue });
  const result = await run(dependencies);
  assert.equal(result.status, 'success');
  assert.equal(result.productCheck.status, 'completed');
  assert.equal(result.productCheck.claimed, 0);
  assert.equal(names().filter((name) => name === 'product-worker').length, 1);
});

test('C. flag true with one due job: the worker is called exactly once', async () => {
  const queue = jobQueue(1);
  const { calls, dependencies, names } = fixture({ enabled: true, queue });
  const result = await run(dependencies);
  assert.equal(names().filter((name) => name === 'product-worker').length, 1);
  assert.deepEqual(calls.find(([name]) => name === 'product-worker')?.[1], {
    maxProducts: PRODUCT_CHECK_MAX_PRODUCTS_PER_RUN,
  });
  assert.equal(result.productCheck.claimed, 1);
  assert.equal(result.productCheck.completed, 1);
  assert.equal(queue.jobs[0].status, 'complete');
});

test('D. more due jobs than the budget: one call, at most the per-run budget', async () => {
  assert.ok(PRODUCT_CHECK_MAX_PRODUCTS_PER_RUN >= 1 && PRODUCT_CHECK_MAX_PRODUCTS_PER_RUN <= 5);
  const queue = jobQueue(10);
  const { dependencies, names } = fixture({ enabled: true, queue });
  const result = await run(dependencies);
  assert.equal(names().filter((name) => name === 'product-worker').length, 1);
  assert.equal(result.productCheck.claimed, PRODUCT_CHECK_MAX_PRODUCTS_PER_RUN);
  assert.equal(
    queue.jobs.filter((job) => job.status === 'pending').length,
    10 - PRODUCT_CHECK_MAX_PRODUCTS_PER_RUN,
    'the rest stays due for the next run',
  );
});

test('D. a worker that claims more than asked is refused (fail closed)', async () => {
  const { dependencies } = fixture({
    enabled: true,
    worker: () => workerSummary({ claimed: 9, completed: 9 }),
  });
  const result = await run(dependencies);
  assert.equal(result.productCheck.status, 'failed');
  assert.equal(result.productCheck.errorCode, 'invalid_child_response');
  assert.equal(result.status, 'partial_success');
});

test('D. a run already past its start budget defers the stage without calling the worker', async () => {
  const queue = jobQueue(2);
  const fx = fixture({ enabled: true, queue });
  fx.dependencies.ingest = async (input) => {
    fx.calls.push(['ingest', input]);
    fx.advance(PRODUCT_CHECK_LATEST_START_MS + 1);
    return ingestion;
  };
  const result = await run(fx.dependencies);
  assert.equal(fx.names().includes('product-worker'), false);
  assert.equal(result.productCheck.status, 'deferred');
  assert.equal(result.status, 'success', 'a deferral is not a failure');
  assert.equal(
    queue.jobs.every((job) => job.status === 'pending'),
    true,
  );
});

// ---------------------------------------------------------------------------
// E, F, G, H: failure isolation (the worker side keeps every job)
// ---------------------------------------------------------------------------
for (const [label, code] of [
  ['E. worker timeout', 'child_timeout'],
  ['F. worker 500', 'child_http_500'],
  ['G. worker 401', 'child_http_401'],
  ['G. worker 403', 'child_http_403'],
  ['H. invalid worker response', 'invalid_child_response'],
  ['worker unavailable', 'child_unavailable'],
]) {
  test(`${label}: stage failed, run partial_success, ingestion and push kept`, async () => {
    const queue = jobQueue(2);
    const { calls, dependencies, names } = fixture({
      enabled: true,
      queue,
      worker: (input, jobs) => {
        // The worker may have claimed before failing: the jobs stay leased, not lost.
        if (code === 'child_timeout') jobs.claim(input.maxProducts);
        throw Object.assign(new Error(code), { code });
      },
    });
    const result = await run(dependencies);
    assert.equal(result.status, 'partial_success');
    assert.equal(result.errorStep, 'product_check');
    assert.equal(result.errorCode, code);
    assert.equal(result.productCheck.status, 'failed');
    assert.equal(result.productCheck.attempted, true);
    assert.deepEqual(result.ingestion, ingestion, 'ingestion results are kept');
    assert.ok(names().includes('record-ingestion'));
    assert.ok(names().includes('record-matching'));
    assert.ok(names().includes('push'), 'notifications still run');
    assert.equal(names().filter((name) => name === 'product-worker').length, 1, 'no retry loop');
    assert.equal(completion(calls).errorStep, 'product_check');
    assert.equal(queue.jobs.length, 2, 'no job is ever deleted');
    assert.ok(queue.jobs.every((job) => job.status !== 'complete'));
  });
}

test('E. timeout keeps a claimed job retryable (lease, not deletion)', async () => {
  const queue = jobQueue(1);
  const { dependencies } = fixture({
    enabled: true,
    queue,
    worker: (input, jobs) => {
      jobs.claim(input.maxProducts);
      throw Object.assign(new Error('t'), { code: 'child_timeout' });
    },
  });
  await run(dependencies);
  assert.equal(queue.jobs[0].status, 'running', 'leased; the 17.7a-1 lease expiry reclaims it');
});

test('DB error reading the flag: fail closed, worker never called', async () => {
  const { dependencies, names } = fixture({
    plan: () => {
      throw new Error('Product check plan retrieval failed.');
    },
  });
  const result = await run(dependencies);
  assert.equal(names().includes('product-worker'), false);
  assert.equal(result.productCheck.status, 'failed');
  assert.equal(result.productCheck.enabled, null);
  assert.equal(result.productCheck.errorCode, 'product_check_plan_unavailable');
  assert.equal(result.status, 'partial_success');
  assert.equal(result.errorStep, 'product_check');
});

test('a malformed plan is treated as unknown, never as enabled', async () => {
  for (const plan of [{}, { enabled: 'true' }, { enabled: 1 }, null]) {
    const { dependencies, names } = fixture({ plan: () => plan });
    const result = await run(dependencies);
    assert.equal(names().includes('product-worker'), false, JSON.stringify(plan));
    assert.equal(result.productCheck.status, 'failed');
  }
});

test('retrying and exhausted jobs are reported, not hidden, and do not fail the run', async () => {
  const { dependencies } = fixture({
    enabled: true,
    worker: () =>
      workerSummary({ claimed: 3, completed: 1, retrying: 1, exhausted: 1, possibleMatches: 0 }),
  });
  const result = await run(dependencies);
  assert.equal(result.status, 'success');
  assert.equal(result.productCheck.retrying, 1);
  assert.equal(result.productCheck.failed, 1);
  assert.equal(result.productCheck.completed, 1);
});

test('a worker reporting an AI call is refused', async () => {
  const { dependencies } = fixture({ enabled: true, worker: () => workerSummary({ aiCalls: 1 }) });
  const result = await run(dependencies);
  assert.equal(result.productCheck.status, 'failed');
  assert.equal(result.productCheck.confirmedAlerts, 0);
});

// ---------------------------------------------------------------------------
// I, J: independent states
// ---------------------------------------------------------------------------
test('I. product check failed, ingestion success: partial_success, ingestion persisted', async () => {
  const { calls, dependencies } = fixture({
    enabled: true,
    worker: () => {
      throw Object.assign(new Error('x'), { code: 'child_http_500' });
    },
  });
  const result = await run(dependencies);
  assert.equal(result.status, 'partial_success');
  assert.equal(result.errorStep, 'product_check');
  assert.ok(calls.some(([name]) => name === 'record-ingestion'));
  assert.notEqual(completion(calls).status, 'failed');
});

test('J. product check success while a source partially failed: both states reflected', async () => {
  const queue = jobQueue(1);
  const { dependencies, names } = fixture({
    enabled: true,
    queue,
    overrides: {
      dependencies: { ingest: async () => ({ ...ingestion, sourceFailures: 1 }) },
    },
  });
  const result = await run(dependencies);
  assert.equal(result.status, 'partial_success');
  assert.equal(result.errorStep, 'ingestion');
  assert.equal(result.errorCode, 'source_partial_failure');
  assert.equal(result.productCheck.status, 'completed');
  assert.equal(result.productCheck.completed, 1);
  assert.equal(names().includes('push'), false, 'unchanged: no push after a source failure');
});

test('J. the stage still runs (as a catch-up net) when ingestion failed or matching was partial', async () => {
  const failing = Object.assign(new Error('x'), { code: 'child_http_502' });
  for (const overrides of [
    { dependencies: { ingest: async () => Promise.reject(failing) } },
    { dependencies: { match: async () => Promise.reject(failing) } },
  ]) {
    const { dependencies, names } = fixture({ enabled: true, queue: jobQueue(1), overrides });
    const result = await run(dependencies);
    assert.ok(names().includes('product-worker'));
    assert.equal(result.productCheck.status, 'completed');
    assert.notEqual(result.errorStep, 'product_check', 'the first error is kept');
  }
});

test('J. a product-check failure never overrides an earlier error', async () => {
  const failing = Object.assign(new Error('x'), { code: 'child_http_502' });
  const { dependencies } = fixture({
    enabled: true,
    worker: () => {
      throw Object.assign(new Error('x'), { code: 'child_timeout' });
    },
    overrides: { dependencies: { ingest: async () => Promise.reject(failing) } },
  });
  const result = await run(dependencies);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorStep, 'ingestion');
  assert.equal(result.errorCode, 'child_http_502');
  assert.equal(result.productCheck.status, 'failed');
});

// ---------------------------------------------------------------------------
// K: ordering and notifications
// ---------------------------------------------------------------------------
test('K. order: ingestion -> matching -> product checks -> notifications -> completion', async () => {
  const { dependencies, names } = fixture({ enabled: true, queue: jobQueue(1) });
  await run(dependencies);
  const order = names().filter((name) =>
    ['ingest', 'match', 'product-plan', 'product-worker', 'push', 'complete'].includes(name),
  );
  assert.deepEqual(order, [
    'ingest',
    'match',
    'product-plan',
    'product-worker',
    'push',
    'complete',
  ]);
});

test('K. notifications are invoked with the same input whatever the product stage does', async () => {
  const pushInputs = [];
  for (const config of [
    { enabled: false },
    { enabled: true },
    {
      enabled: true,
      worker: () => {
        throw Object.assign(new Error('x'), { code: 'child_http_500' });
      },
    },
  ]) {
    const { calls, dependencies } = fixture(config);
    await run(dependencies);
    pushInputs.push(calls.filter(([name]) => name === 'push').map(([, input]) => input));
  }
  assert.deepEqual(pushInputs, [[{ batchSize: 25 }], [{ batchSize: 25 }], [{ batchSize: 25 }]]);
});

test('K. a push failure stays the reported error; the product summary is still returned', async () => {
  const failing = Object.assign(new Error('x'), { code: 'child_http_503' });
  const { dependencies } = fixture({
    enabled: true,
    overrides: { dependencies: { push: async () => Promise.reject(failing) } },
  });
  const result = await run(dependencies);
  assert.equal(result.errorStep, 'push');
  assert.equal(result.productCheck.status, 'completed');
});

test('an unclaimed run (disabled automation or already running) never reads the flag', async () => {
  for (const status of ['skipped_disabled', 'already_running']) {
    const { dependencies, names } = fixture({
      enabled: true,
      overrides: { store: { claimRun: async () => ({ status, runId }) } },
    });
    const result = await run(dependencies);
    assert.deepEqual(names(), []);
    assert.equal(result.productCheck, null);
  }
});

test('the stage summary carries counters only, never an identifier', async () => {
  const { dependencies } = fixture({ enabled: true, queue: jobQueue(2) });
  const result = await run(dependencies);
  const text = JSON.stringify(result.productCheck);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/u);
  assert.deepEqual(Object.keys(result.productCheck).sort(), [
    'attempted',
    'claimed',
    'completed',
    'confirmedAlerts',
    'continued',
    'durationMs',
    'enabled',
    'errorCode',
    'failed',
    'maxProducts',
    'possibleMatches',
    'rearmed',
    'retrying',
    'staleLeases',
    'status',
  ]);
  const index = await readFile(
    new URL('supabase/functions/run-recall-automation/index.ts', root),
    'utf8',
  );
  const log = index.slice(index.indexOf("console.info('recall_automation_run_complete'"));
  assert.doesNotMatch(log.slice(0, log.indexOf('});')), /runId|ownedProduct|userId|recallId/u);
});

// ---------------------------------------------------------------------------
// M: no AI; worker invocation does not reuse the automation key or add a secret
// ---------------------------------------------------------------------------
test('M. AI escalations stay governed by the existing control; the stage adds none', async () => {
  const { calls, dependencies } = fixture({ enabled: true, queue: jobQueue(1) });
  await run(dependencies);
  assert.equal(calls.find(([name]) => name === 'match')?.[1].maxAiEscalations, 0);
  const sources = await Promise.all(
    [
      'supabase/functions/_shared/automation/orchestrator.ts',
      'supabase/functions/run-recall-automation/children.ts',
      'supabase/functions/run-recall-automation/store.ts',
      'supabase/functions/run-recall-automation/index.ts',
    ].map((file) => readFile(new URL(file, root), 'utf8')),
  );
  for (const source of sources) {
    for (const target of [...source.matchAll(/from '([^']+)'/gu)].map((match) => match[1])) {
      assert.doesNotMatch(target, /nebius|nemotron|matching\/|recallMatching|productCheck/iu);
    }
  }
});

test('worker invocation: matching key only, no new secret, not the automation key', async () => {
  const children = await readFile(
    new URL('supabase/functions/run-recall-automation/children.ts', root),
    'utf8',
  );
  const index = await readFile(
    new URL('supabase/functions/run-recall-automation/index.ts', root),
    'utf8',
  );
  const method = children.slice(children.indexOf('async checkProducts'));
  assert.match(method, /process-owned-product-checks/u);
  assert.match(method, /'x-recall-matching-key',\s*this\.secrets\.matching/u);
  assert.doesNotMatch(children, /RECALL_AUTOMATION_KEY|x-recall-automation/u);
  const envReads = [
    ...index.matchAll(/Deno\.env\.get\('([A-Z_]+)'\)|requiredEnvironment\('([A-Z_]+)'\)/gu),
  ]
    .map((match) => match[1] ?? match[2])
    .sort();
  assert.deepEqual(
    [...new Set(envReads)],
    [
      'RECALL_AUTOMATION_KEY',
      'RECALL_INGESTION_KEY',
      'RECALL_MATCHING_KEY',
      'RECALL_PUSH_DELIVERY_ENABLED',
      'RECALL_PUSH_DELIVERY_KEY',
      'SUPABASE_SECRET_KEYS',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_URL',
    ],
    'the same server configuration as the deployed v14: no new secret',
  );
  const worker = await readFile(
    new URL('supabase/functions/process-owned-product-checks/index.ts', root),
    'utf8',
  );
  assert.match(worker, /Deno\.env\.get\('RECALL_MATCHING_KEY'\)/u);
  assert.match(worker, /'x-recall-matching-key'/u);
});

// ---------------------------------------------------------------------------
// L, N, O, P and the migration
// ---------------------------------------------------------------------------
test('L. no new cron: neither the migration nor the automation schedules anything', async () => {
  const migration = await readFile(new URL(MIGRATION, root), 'utf8');
  assert.doesNotMatch(migration, /cron\.|pg_net|net\.http_/iu);
  for (const file of [
    'supabase/functions/_shared/automation/orchestrator.ts',
    'supabase/functions/run-recall-automation/index.ts',
  ]) {
    assert.doesNotMatch(await readFile(new URL(file, root), 'utf8'), /cron\.schedule|setInterval/u);
  }
});

test('migration: one additive, read-only, lease-bound, service_role-only function', async () => {
  const migrations = (await readdir(new URL('supabase/migrations/', root))).sort();
  // Only reviewed later phases may follow 17.7a-2, each bound to its reviewed bytes
  // (Phase 17.3-S: canonical GTIN equivalence; Phase 17.3a: scan provenance columns).
  // Anything else after 17.7a-2 fails.
  const LATER_PHASES = {
    '20261004090000_phase_17_3_s_canonical_gtin_equivalence.sql':
      'd58d8438dcf2e0358bc62fd66d067bf05e32f92c86085acd2786bced3c4407e0',
    '20261005090000_phase_17_3a_scan_identity_provenance.sql':
      '419e69eb8d57dae72efab2fb9a8ed312c34a9b9ddb96b1929dcc37ae38b7474e',
  };
  assert.ok(migrations.includes(MIGRATION.split('/').at(-1)));
  assert.deepEqual(
    migrations.slice(migrations.indexOf(MIGRATION.split('/').at(-1)) + 1),
    Object.keys(LATER_PHASES),
  );
  for (const [file, digest] of Object.entries(LATER_PHASES)) {
    const bytes = await readFile(new URL(`supabase/migrations/${file}`, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, file);
  }
  assert.ok(
    migrations.indexOf(MIGRATION.split('/').at(-1)) >
      migrations.indexOf('20261002120000_phase_17_7a_1_owned_product_recall_checks.sql'),
  );
  const sql = await readFile(new URL(MIGRATION, root), 'utf8');
  assert.match(sql, /^begin;$/mu);
  assert.match(sql, /^commit;$/mu);
  assert.doesNotMatch(sql, /create or replace|drop |alter table|insert |update |delete /iu);
  assert.equal([...sql.matchAll(/create function/giu)].length, 1);
  assert.match(sql, /security definer\s+set search_path = ''/u);
  assert.match(sql, /automation_lease\.lease_token = p_lease_token/u);
  assert.match(sql, /expires_at > pg_catalog\.now\(\)/u);
  assert.match(sql, /from public, anon, authenticated/u);
  assert.match(sql, /to service_role;/u);
});

const sha = async (file) =>
  createHash('sha256')
    .update(await readFile(new URL(file, root)))
    .digest('hex');

// SHA-256 at HEAD c254ccb (F-4 closed in production, 17.7a-1 local). 17.7a-2 must
// not touch the F-4 migration, the 17.7a-1 schema, the safe gate or either worker.
const UNTOUCHED = {
  'supabase/functions/_shared/productCheck/gate.ts':
    '8097405a8acbd9b569954f6badf0549f60c5539d456133c842607266519f9c16',
  'supabase/functions/_shared/productCheck/orchestrator.ts':
    '6dd6c76a778d399912092b73db83104c89bf25dc807d317a989289e98e8559aa',
  'supabase/functions/_shared/productCheck/handler.ts':
    'a866409e16fcf71945e5de457bd9176b72675195efde30d15783034a85ea1f66',
  'supabase/functions/_shared/productCheck/supabaseStore.ts':
    '0d15e27bf397dd85ffbcb05a1b5a6eabc560a3993a1a805a214696dcdd3831cd',
  'supabase/functions/_shared/productCheck/server.ts':
    '0ee0234f743b44d5b8bb51c2ad12754ede40d61a6e6272bf2cb14cb97d4f1f3a',
  'supabase/functions/process-owned-product-checks/index.ts':
    '0f753a1dc4aa58ac8183196e54e2d09511835fc72fb17b087204e9194b39bd62',
  'supabase/functions/check-owned-product/index.ts':
    'a9c3b3c4dc28f0f0500f7ace6f455ab5da8e1ba178129d86da17f56696d3772a',
  'supabase/migrations/20261002110000_phase_17_7a_f4_automatic_alert_safety.sql':
    '622dc3893d47875c68899970b9724832ff9be872c4b75867a522854a210ca457',
  'supabase/migrations/20261002120000_phase_17_7a_1_owned_product_recall_checks.sql':
    '61639ab4445cf42897217ecd5b31f7b66fd88ef2f3cc63537f51c3848ec219be',
};

test('N, P. F-4, the 17.7a-1 schema, the safe gate and both workers are untouched', async () => {
  for (const [file, expected] of Object.entries(UNTOUCHED)) {
    assert.equal(await sha(file), expected, file);
  }
});

test('O. v2 stays globally inactive (default matcher policy is v1)', async () => {
  const { productionMatcherPolicy } =
    await import('../supabase/functions/_shared/recallMatching/policySelector.ts');
  assert.equal(productionMatcherPolicy(undefined), 'phase_10_guarded_v1');
});

// ---------------------------------------------------------------------------
// Production baseline and controlled deploy tree
// ---------------------------------------------------------------------------
// Runtime (bundled) files of run-recall-automation; types.ts is erased at bundle.
const RUNTIME = [
  'supabase/functions/_shared/automation/index.ts',
  'supabase/functions/_shared/automation/orchestrator.ts',
  'supabase/functions/_shared/automation/request.ts',
  'supabase/functions/run-recall-automation/children.ts',
  'supabase/functions/run-recall-automation/index.ts',
  'supabase/functions/run-recall-automation/store.ts',
];
// Production v14, ezbr 42d8a0dc…b659b5 (= the Gate A3 deploy of 2026-10-01; files
// read back from production on 2026-10-03 and equal to releases/phase-16-34-gate-a).
const PRODUCTION_RUNTIME_TREE = '37a79b95bf01bb37d7af54d0c0337fc981c63ff2f5dd2adb74092196fafda515';

async function treeHash(base) {
  const lines = [];
  for (const file of [...RUNTIME].sort()) {
    const digest = createHash('sha256')
      .update(await readFile(new URL(`${base}${file}`, root)))
      .digest('hex');
    lines.push(`${digest}  ${file}`);
  }
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

test('the recorded production bytes (Gate A release) still hash to the v14 runtime tree', async () => {
  assert.equal(await treeHash('releases/phase-16-34-gate-a/'), PRODUCTION_RUNTIME_TREE);
});

test('the only difference from production is the 17.7a-2 diff (request.ts untouched)', async () => {
  assert.equal(
    await sha('supabase/functions/_shared/automation/request.ts'),
    await sha('releases/phase-16-34-gate-a/supabase/functions/_shared/automation/request.ts'),
  );
  assert.notEqual(await treeHash(''), PRODUCTION_RUNTIME_TREE);
});

// The reviewed 17.7a-2 runtime tree (stage script output, same manifest method).
const TARGET_RUNTIME_TREE = '96875b00ba96b3721f43c48a98e1f9912fb41196f417e111f466d44de5455e57';

test('the working tree is exactly the reviewed 17.7a-2 runtime tree', async () => {
  assert.equal(await treeHash(''), TARGET_RUNTIME_TREE);
});

async function deployedFromGateA() {
  return {
    slug: 'run-recall-automation',
    files: await Promise.all(
      RUNTIME.map(async (path) => ({
        name: path.replace(/^supabase\//u, ''),
        content: await readFile(new URL(`releases/phase-16-34-gate-a/${path}`, root), 'utf8'),
      })),
    ),
  };
}
const readWorktree = (path) => readFileSync(new URL(path, root));

test('stage script: production bytes + the 17.7a-2 diff give the reviewed tree', async () => {
  const { stage, treeHash: stagedHash } =
    await import('../scripts/stage-17-7a-2-automation-bundle.mjs');
  const deployed = await deployedFromGateA();
  const tree = stage(deployed, undefined, readWorktree);
  assert.equal(stagedHash(tree), TARGET_RUNTIME_TREE);
  assert.deepEqual(
    Object.keys(tree).sort(),
    [...RUNTIME, 'supabase/functions/_shared/automation/types.ts'].sort(),
  );
  assert.equal(
    tree['supabase/functions/_shared/automation/request.ts'].toString(),
    deployed.files.find((file) => file.name.endsWith('request.ts')).content,
    'request.ts is the deployed byte copy',
  );
  assert.equal(stagedHash(stage(deployed, '--as-deployed', readWorktree)), PRODUCTION_RUNTIME_TREE);
});

test('stage script: refuses a bundle that is not the recorded v14 tree', async () => {
  const { stage } = await import('../scripts/stage-17-7a-2-automation-bundle.mjs');
  const tampered = await deployedFromGateA();
  tampered.files[0].content += '\n';
  assert.throws(() => stage(tampered, undefined, readWorktree), /not the recorded v14/u);
  const extra = await deployedFromGateA();
  extra.files.push({ name: 'functions/_shared/productCheck/gate.ts', content: '' });
  assert.throws(() => stage(extra, undefined, readWorktree), /unexpected deployed files/u);
  assert.throws(
    () => stage({ ...tampered, slug: 'process-recall-matches' }, undefined, readWorktree),
    /not the run-recall-automation bundle/u,
  );
});
