import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { processRecallMatches } from '../supabase/functions/_shared/recallMatching/orchestrator.ts';
import { runRecallAutomation } from '../supabase/functions/_shared/automation/index.ts';

const MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';
const R1 = '10000000-0000-4000-8000-000000000001';
const R2 = '10000000-0000-4000-8000-000000000002';
const R3 = '10000000-0000-4000-8000-000000000003';

function recall(id, overrides = {}) {
  return {
    recall_notice_id: id,
    recall_notice_updated_at: '2026-09-30T06:17:00.000001+00:00',
    source_authority: 'U.S. Consumer Product Safety Commission (CPSC)',
    source_external_id: id.slice(-4),
    source_official_url: `https://www.cpsc.gov/Recalls/2026/${id.slice(-4)}`,
    source_is_authoritative: true,
    title: 'Sleek stroller recalled',
    description: 'An official description.',
    hazard: 'A safety hazard.',
    remedy: 'Stop use.',
    recall_date: '2026-08-20',
    raw_payload: { id },
    scopes: [
      {
        brand: 'Thule',
        product_name: 'Sleek stroller',
        gtin: '091021037090',
        model_number: null,
        serial_number: null,
        lot_number: null,
        serial_from: null,
        serial_to: null,
        lot_from: null,
        lot_to: null,
        manufactured_from: null,
        manufactured_to: null,
        additional_criteria: { evidence_level: 'product' },
      },
    ],
    ...overrides,
  };
}

function product(id) {
  return {
    owned_product_id: id,
    owned_product_updated_at: '2026-09-29T00:00:00.000001+00:00',
    product_name: 'Sleek stroller',
    brand: 'Thule',
    category: 'Stroller',
    gtin: '091021037090',
    model_number: null,
    serial_number: null,
    lot_number: null,
    purchase_date: null,
    identification_method: 'barcode',
    exact_rank: 4,
  };
}

// A store whose claim/finalize outcomes are scripted per product.
function store({ recalls, products, claim = {}, finalize = {} }) {
  const finalized = [];
  return {
    finalized,
    async listAuthoritativeRecalls({ afterRecallId, limit, recallNoticeIds }) {
      return recalls
        .filter((row) => !recallNoticeIds || recallNoticeIds.includes(row.recall_notice_id))
        .filter((row) => afterRecallId === null || row.recall_notice_id > afterRecallId)
        .slice(0, limit);
    },
    async listRecallCandidateProducts({ recallNoticeId, afterProductId }) {
      const rows = products[recallNoticeId] ?? [];
      return afterProductId === null ? rows : [];
    },
    async claimPair(input) {
      const scripted = claim[input.ownedProductId];
      if (scripted === 'throw') throw new Error('database unavailable');
      return scripted ? { status: scripted } : { status: 'claimed', leaseToken: 'lease' };
    },
    async finalizePair(input) {
      finalized.push(input);
      const status = finalize[input.ownedProductId] ?? 'finalized';
      return { status, alertOutcome: status === 'finalized' ? 'created' : 'none' };
    },
  };
}

const limits = (ids, overrides = {}) => ({
  maxRecalls: ids.length,
  maxCandidatePairs: 50,
  maxNebiusCalls: 0,
  recallNoticeIds: ids,
  ...overrides,
});
const run = (input, s) =>
  processRecallMatches(input, {
    store: s,
    modelId: MODEL_ID,
    createNemotronEvaluator() {
      throw new Error('AI must not be used');
    },
  });

test('a pair made stale by a concurrent notice update leaves its recall unresolved', async () => {
  const s = store({
    recalls: [recall(R1), recall(R2)],
    products: { [R1]: [product('p1'), product('p2')], [R2]: [product('p3')] },
    claim: { p2: 'stale' },
  });
  const summary = await run(limits([R1, R2]), s);
  assert.equal(summary.staleSkipped, 1);
  assert.deepEqual(summary.resolvedRecallIds, [R2]);
  assert.deepEqual(summary.unresolvedRecalls, [{ recallNoticeId: R1, reason: 'stale' }]);
  // The Phase 12 automation counters never saw this as unfinished work.
  assert.equal(summary.failures + summary.providerFailures + summary.limitsReached, 0);
});

test('stale at finalization, busy, and failures are unresolved; missing is not', async () => {
  const s = store({
    recalls: [recall(R1), recall(R2), recall(R3)],
    products: {
      [R1]: [product('p1')],
      [R2]: [product('p2'), product('p3')],
      [R3]: [product('p4'), product('p5')],
    },
    claim: { p2: 'busy', p4: 'missing', p5: 'throw' },
    finalize: { p1: 'stale' },
  });
  const summary = await run(limits([R1, R2, R3]), s);
  assert.deepEqual(summary.resolvedRecallIds, []);
  assert.deepEqual(summary.unresolvedRecalls, [
    { recallNoticeId: R1, reason: 'stale' },
    { recallNoticeId: R2, reason: 'busy' },
    { recallNoticeId: R3, reason: 'failure' },
  ]);
  assert.equal(summary.busySkipped, 1);
  assert.equal(summary.staleSkipped, 2); // stale finalization + missing claim (Phase 10 counter)
});

test('a vanished product or recall leaves no work: the recall resolves', async () => {
  const s = store({
    recalls: [recall(R1)],
    products: { [R1]: [product('p1'), product('p2')] },
    claim: { p1: 'missing' },
    finalize: { p2: 'missing' },
  });
  const summary = await run(limits([R1]), s);
  assert.deepEqual(summary.resolvedRecallIds, [R1]);
  assert.deepEqual(summary.unresolvedRecalls, []);
});

test('unchanged and unrelated recalls resolve without new evaluations', async () => {
  const s = store({
    recalls: [recall(R1), recall(R2)],
    products: { [R1]: [product('p1')], [R2]: [] },
    claim: { p1: 'unchanged' },
  });
  const summary = await run(limits([R1, R2]), s);
  assert.deepEqual(summary.resolvedRecallIds.sort(), [R1, R2]);
  assert.equal(summary.unchangedSkipped, 1);
  assert.equal(s.finalized.length, 0);
});

test('the pair cap leaves the current recall and every unreached recall unresolved', async () => {
  const s = store({
    recalls: [recall(R1), recall(R2), recall(R3)],
    products: {
      [R1]: [product('p1')],
      [R2]: [product('p2'), product('p3')],
      [R3]: [product('p4')],
    },
  });
  const summary = await run(limits([R1, R2, R3], { maxCandidatePairs: 2 }), s);
  assert.deepEqual(summary.resolvedRecallIds, [R1]);
  assert.deepEqual(summary.unresolvedRecalls, [
    { recallNoticeId: R2, reason: 'limit' },
    { recallNoticeId: R3, reason: 'not_reached' },
  ]);
});

test('a requested recall absent from an exhausted listing is no longer matchable', async () => {
  const s = store({ recalls: [recall(R1)], products: { [R1]: [] } });
  const summary = await run(limits([R1, R2]), s);
  assert.deepEqual(summary.resolvedRecallIds.sort(), [R1, R2]);
  assert.deepEqual(summary.unresolvedRecalls, []);
});

test('historical decisions are unchanged: the confirmed deterministic_v1 evaluation', async () => {
  const s = store({ recalls: [recall(R1)], products: { [R1]: [product('p1')] } });
  const summary = await run(limits([R1]), s);
  assert.equal(summary.confirmed, 1);
  assert.equal(s.finalized[0].status, 'confirmed');
  assert.equal(s.finalized[0].matchMethod, 'deterministic_v1');
  assert.equal(s.finalized[0].aiProvider, null);
});

// ---------------------------------------------------------------------------
// Automation: nothing unresolved is ever acknowledged.
// ---------------------------------------------------------------------------
const claimed = {
  status: 'claimed',
  runId: 'run',
  leaseToken: 'lease',
  windowStart: '2026-09-30',
  windowEnd: '2026-09-30',
  maxRecalls: 20,
  maxCandidatePairs: 200,
  maxAiEscalations: 0,
  notificationBatchSize: 10,
  aiEnabled: false,
  pushEnabled: true,
};
const baseMatching = {
  recallsProcessed: 2,
  candidatePairs: 2,
  deterministicResolved: 1,
  nemotronEscalated: 0,
  confirmed: 1,
  rejected: 0,
  needsReview: 0,
  alertsCreated: 1,
  failures: 0,
  providerFailures: 0,
  limitsReached: 0,
};
async function automate(matching) {
  const calls = [];
  const result = await runRecallAutomation(
    {
      trigger: 'cron',
      verificationMode: false,
      maxRecalls: null,
      maxCandidatePairs: null,
      maxAiEscalations: null,
      notificationBatchSize: null,
    },
    {
      store: {
        async claimRun() {
          return claimed;
        },
        async recordIngestion() {},
        async listPendingRecalls() {
          return [R1, R2];
        },
        async recordMatching(input) {
          calls.push(['record', input]);
        },
        async completeRun(input) {
          calls.push(['complete', input]);
        },
      },
      async ingest() {
        return {
          fetched: 0,
          inserted: 0,
          updated: 0,
          unchanged: 0,
          rejected: 0,
          affectedRecallIds: [],
        };
      },
      async match() {
        return matching;
      },
      async push() {
        calls.push(['push']);
        return { claimed: 0, accepted: 0, failed: 0, invalidDevices: 0, transientFailures: 0 };
      },
      pushDeliveryGateEnabled: true,
    },
  );
  return { result, record: calls.find(([n]) => n === 'record')?.[1], calls };
}

test('per-recall outcomes: only resolved recalls are acknowledged; the run is partial', async () => {
  const { result, record, calls } = await automate({
    ...baseMatching,
    staleSkipped: 1,
    busySkipped: 0,
    resolvedRecallIds: [R2],
    unresolvedRecalls: [{ recallNoticeId: R1, reason: 'stale' }],
  });
  assert.deepEqual(record.resolvedRecallIds, [R2]);
  assert.deepEqual(record.unresolvedRecalls, [{ recallNoticeId: R1, reason: 'stale' }]);
  assert.equal(result.status, 'partial_success');
  assert.equal(result.errorCode, 'matching_retry_pending');
  assert.equal(
    calls.some(([n]) => n === 'push'),
    false,
  );
});

test('a pre-16.33 matcher response: stale or busy counters keep the whole batch pending', async () => {
  for (const counters of [{ staleSkipped: 1 }, { busySkipped: 2 }]) {
    const { result, record } = await automate({ ...baseMatching, ...counters });
    assert.deepEqual(record.resolvedRecallIds, []);
    assert.deepEqual(
      record.unresolvedRecalls.map((item) => item.recallNoticeId),
      [R1, R2],
    );
    assert.equal(result.status, 'partial_success');
  }
});

test('contradictory counters fail closed even when every recall claims resolution', async () => {
  const { record } = await automate({
    ...baseMatching,
    staleSkipped: 1,
    resolvedRecallIds: [R1, R2],
    unresolvedRecalls: [],
  });
  assert.deepEqual(record.resolvedRecallIds, []);
  assert.ok(record.unresolvedRecalls.every((item) => item.reason === 'inconsistent_summary'));
});

test('a requested recall missing from the matcher report stays pending', async () => {
  const { record } = await automate({
    ...baseMatching,
    staleSkipped: 0,
    busySkipped: 0,
    resolvedRecallIds: [R2],
    unresolvedRecalls: [],
  });
  assert.deepEqual(record.unresolvedRecalls, [
    { recallNoticeId: R1, reason: 'inconsistent_summary' },
  ]);
});

test('a clean run acknowledges every recall and delivers push as before', async () => {
  const { result, record, calls } = await automate({
    ...baseMatching,
    staleSkipped: 0,
    busySkipped: 0,
    resolvedRecallIds: [R1, R2],
    unresolvedRecalls: [],
  });
  assert.deepEqual(record.resolvedRecallIds, [R1, R2]);
  assert.equal(result.status, 'success');
  assert.ok(calls.some(([n]) => n === 'push'));
});

// ---------------------------------------------------------------------------
// Source guards for the tickets, MFA and the outside-census gate.
// ---------------------------------------------------------------------------
test('Phase 16.33 sources keep static keys out of pg_net and gate humans on MFA', async () => {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const [migration, worker, automation, store] = await Promise.all([
    read('supabase/migrations/20260930200000_phase_16_33_security_and_v1_correctness.sql'),
    read('supabase/functions/process-cpsc-page-evidence/index.ts'),
    read('supabase/functions/run-recall-automation/index.ts'),
    read('supabase/functions/run-recall-automation/store.ts'),
  ]);
  const tick = migration.slice(
    migration.indexOf('create or replace function private.cpsc_page_stage_tick'),
  );
  assert.equal(/cpsc_page_worker_key|x-cpsc-page-worker-key/u.test(tick.slice(0, 3000)), false);
  const v1Tick = migration.slice(
    migration.indexOf('create function private.recall_automation_tick'),
  );
  assert.equal(/recall_automation_key|x-recall-automation-key/u.test(v1Tick.slice(0, 1600)), false);
  assert.match(migration, /ticket_sha256 text not null unique/u);
  assert.match(migration, /s\.aal = 'aal2'/u);
  assert.match(migration, /interval '12 hours'/u);
  assert.match(migration, /and outside_attested\)/u);
  assert.equal(
    /cron\.schedule\(/u.test(
      migration.replace(/select cron\.schedule\('cpsc-page-evidence-shadow'/u, ''),
    ),
    false,
  );
  assert.equal(
    /insert into private\.cpsc_admin_capabilities|insert into private\.cpsc_reviewer_authorizations/u.test(
      migration,
    ),
    false,
  );
  assert.match(worker, /x-cpsc-page-ticket/u);
  assert.match(worker, /consume_cpsc_page_stage_ticket/u);
  assert.match(automation, /x-recall-automation-ticket/u);
  assert.match(automation, /parseAutomationRunRequest\(\{ trigger: 'cron' \}\)/u);
  assert.match(store, /record_recall_automation_matching_outcome/u);
  assert.equal(/record_recall_automation_matching'/u.test(store), false);
});
