import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  parseAutomationRunRequest,
  runRecallAutomation,
} from '../supabase/functions/_shared/automation/index.ts';

const runId = '10000000-0000-4000-8000-000000000001';
const leaseToken = '20000000-0000-4000-8000-000000000002';
const recallId = '30000000-0000-4000-8000-000000000003';

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
  aiEnabled: true,
  pushEnabled: true,
};

const ingestion = {
  fetched: 2,
  inserted: 1,
  updated: 0,
  unchanged: 1,
  rejected: 0,
  affectedRecallIds: [recallId],
};

const matching = {
  recallsProcessed: 1,
  candidatePairs: 1,
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

const push = {
  claimed: 1,
  accepted: 1,
  failed: 0,
  invalidDevices: 0,
  transientFailures: 0,
};

function fixture(overrides = {}) {
  const calls = [];
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
  return {
    calls,
    dependencies: {
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
      ...overrides.dependencies,
    },
  };
}

test('automation request parsing accepts only lower bounded limits and a zero-AI verification mode', () => {
  assert.deepEqual(parseAutomationRunRequest(null), {
    trigger: 'manual',
    verificationMode: false,
    maxRecalls: null,
    maxCandidatePairs: null,
    maxAiEscalations: null,
    notificationBatchSize: null,
  });
  assert.deepEqual(
    parseAutomationRunRequest({
      trigger: 'cron',
      maxRecalls: 10,
      maxCandidatePairs: 50,
      maxAiEscalations: 0,
      notificationBatchSize: 5,
    }),
    {
      trigger: 'cron',
      verificationMode: false,
      maxRecalls: 10,
      maxCandidatePairs: 50,
      maxAiEscalations: 0,
      notificationBatchSize: 5,
    },
  );
  assert.throws(() => parseAutomationRunRequest({ maxAiEscalations: 6 }), /between 0 and 5/u);
  assert.throws(
    () => parseAutomationRunRequest({ verificationMode: true, maxAiEscalations: 1 }),
    /requires maxAiEscalations to be zero/u,
  );
  assert.throws(() => parseAutomationRunRequest({ enabled: true }), /unsupported/u);
});

test('disabled and overlapping claims stop before every child stage', async () => {
  for (const claim of [
    { status: 'skipped_disabled', runId },
    { status: 'already_running', runId },
  ]) {
    const { calls, dependencies } = fixture({
      store: {
        async claimRun() {
          return claim;
        },
      },
    });
    const result = await runRecallAutomation(parseAutomationRunRequest({}), dependencies);
    assert.match(result.status, /^skipped_/u);
    assert.equal(calls.length, 0);
  }
});

test('successful run shares one path across manual and Cron and preserves bounded child inputs', async () => {
  for (const trigger of ['manual', 'cron']) {
    const { calls, dependencies } = fixture();
    const result = await runRecallAutomation(parseAutomationRunRequest({ trigger }), dependencies);
    assert.equal(result.status, 'success');
    assert.deepEqual(result.window, { start: '2026-09-10', end: '2026-09-16' });
    assert.deepEqual(calls.find(([name]) => name === 'ingest')?.[1], {
      startDate: '2026-09-10',
      endDate: '2026-09-16',
      maxRecords: 20,
    });
    assert.deepEqual(calls.find(([name]) => name === 'match')?.[1], {
      recallNoticeIds: [recallId],
      maxRecalls: 1,
      maxCandidatePairs: 200,
      maxAiEscalations: 5,
    });
    assert.ok(calls.some(([name]) => name === 'push'));
    assert.equal(calls.at(-1)?.[1].status, 'success');
  }
});

test('verification mode and disabled AI control both enforce zero provider calls', async () => {
  for (const claim of [
    { ...claimed, aiEnabled: false },
    { ...claimed, aiEnabled: false, pushEnabled: false, maxAiEscalations: 0 },
  ]) {
    const { calls, dependencies } = fixture({
      store: {
        async claimRun() {
          return claim;
        },
      },
      dependencies: { pushDeliveryGateEnabled: false },
    });
    const result = await runRecallAutomation(parseAutomationRunRequest({}), dependencies);
    assert.equal(result.status, 'success');
    assert.equal(calls.find(([name]) => name === 'match')?.[1].maxAiEscalations, 0);
    assert.equal(
      calls.some(([name]) => name === 'push'),
      false,
    );
  }
});

test('unchanged ingestion does not create matching work and the push gate remains authoritative', async () => {
  const { calls, dependencies } = fixture({
    store: {
      async listPendingRecalls() {
        return [];
      },
    },
    dependencies: {
      pushDeliveryGateEnabled: false,
      async ingest() {
        return { ...ingestion, inserted: 0, unchanged: 2, affectedRecallIds: [] };
      },
    },
  });
  const result = await runRecallAutomation(parseAutomationRunRequest({}), dependencies);
  assert.equal(result.status, 'success');
  assert.equal(
    calls.some(([name]) => name === 'match'),
    false,
  );
  assert.equal(
    calls.some(([name]) => name === 'push'),
    false,
  );
});

test('incomplete or rejected ingestion never records a watermark and stops matching', async () => {
  for (const failure of [
    async () => {
      throw Object.assign(new Error('offline'), { code: 'cpsc_unavailable' });
    },
    async () => ({ ...ingestion, rejected: 1, unchanged: 0 }),
  ]) {
    const { calls, dependencies } = fixture({ dependencies: { ingest: failure } });
    const result = await runRecallAutomation(parseAutomationRunRequest({}), dependencies);
    assert.equal(result.status, 'failed');
    assert.equal(result.errorStep, 'ingestion');
    assert.equal(
      calls.some(([name]) => name === 'record-ingestion'),
      false,
    );
    assert.equal(
      calls.some(([name]) => name === 'match'),
      false,
    );
  }
});

test('matching failure, provider failure, and the AI hard cap fail closed without push', async () => {
  for (const matchResult of [
    { ...matching, failures: 1, needsReview: 1, confirmed: 0, deterministicResolved: 0 },
    { ...matching, providerFailures: 1, needsReview: 1, confirmed: 0, nemotronEscalated: 1 },
    { ...matching, limitsReached: 1, needsReview: 1, confirmed: 0, nemotronEscalated: 5 },
  ]) {
    const { calls, dependencies } = fixture({
      dependencies: {
        async match() {
          return matchResult;
        },
      },
    });
    const result = await runRecallAutomation(parseAutomationRunRequest({}), dependencies);
    assert.equal(result.status, 'partial_success');
    assert.equal(result.errorStep, 'matching');
    assert.equal(
      calls.some(([name]) => name === 'push'),
      false,
    );
    assert.equal(calls.find(([name]) => name === 'record-matching')?.[1].complete, false);
  }
});

test('an unexpected matching exception preserves ingestion and stops downstream delivery', async () => {
  const { calls, dependencies } = fixture({
    dependencies: {
      async match() {
        throw Object.assign(new Error('failed'), { code: 'matching_failed' });
      },
    },
  });
  const result = await runRecallAutomation(parseAutomationRunRequest({}), dependencies);
  assert.equal(result.status, 'partial_success');
  assert.equal(result.errorCode, 'matching_failed');
  assert.ok(calls.some(([name]) => name === 'record-ingestion'));
  assert.equal(
    calls.some(([name]) => name === 'push'),
    false,
  );
});

test('push failure is partial success and never rolls back completed matching', async () => {
  const { calls, dependencies } = fixture({
    dependencies: {
      async push() {
        throw Object.assign(new Error('failed'), { code: 'expo_unavailable' });
      },
    },
  });
  const result = await runRecallAutomation(parseAutomationRunRequest({}), dependencies);
  assert.equal(result.status, 'partial_success');
  assert.equal(result.errorStep, 'push');
  assert.ok(calls.some(([name]) => name === 'record-matching'));
  assert.equal(calls.find(([name]) => name === 'record-matching')?.[1].complete, true);
});

test('Phase 12 source keeps dedicated auth, Vault names, disabled controls, and no mobile secret', async () => {
  const [edge, config, migration, appConfig] = await Promise.all([
    readFile(
      new URL('../supabase/functions/run-recall-automation/index.ts', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8'),
    readFile(
      new URL(
        '../supabase/migrations/20260916100000_phase_12_autonomous_recall_monitoring.sql',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(new URL('../app.json', import.meta.url), 'utf8'),
  ]);
  assert.match(edge, /RECALL_AUTOMATION_KEY/u);
  assert.match(edge, /x-recall-automation-key/u);
  assert.match(config, /\[functions\.run-recall-automation\]\s+verify_jwt = false/u);
  assert.match(migration, /enabled boolean not null default false/u);
  assert.match(migration, /ai_enabled boolean not null default false/u);
  assert.match(migration, /push_enabled boolean not null default false/u);
  assert.match(migration, /recall_automation_url/u);
  assert.match(migration, /recall_automation_key/u);
  assert.match(migration, /17 \*\/6 \* \* \*/u);
  assert.match(migration, /update cron\.job set active = false/u);
  assert.equal(migration.includes('RECALL_AUTOMATION_KEY='), false);
  assert.equal(appConfig.includes('RECALL_AUTOMATION_KEY'), false);
});
