import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { buildAttachment } from '../scripts/build-phase-16-16a-payload-attachment.mjs';
import { buildSuite } from '../scripts/build-phase-16-16a-rollback-validation.mjs';
import { ingestCpscRecallIdentity } from '../supabase/functions/_shared/cpsc/ingestionGate.ts';
import {
  classifyCpscIngestion,
  emptyOutcomeCounts,
  sourceRunComplete,
} from '../supabase/functions/_shared/cpsc/sourceOutcome.ts';
import { sourcePayloadSha256 } from '../supabase/functions/_shared/recallMatching/reviewedCriteriaV2.ts';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const MIGRATION = 'supabase/migrations/20260926210000_phase_16_16_quarantine_payload_retention.sql';

const record = {
  externalId: '10968',
  title: 'Recall',
  recallDate: '2026-09-10',
  officialUrl: 'https://www.cpsc.gov/Recalls/2026/Recall',
  rawPayload: { RecallID: 10968, RecallNumber: '26-756', Description: 'current' },
};
const quarantine = (parameters, extra = {}) => ({
  status: 'quarantined',
  observationId: 'a0000000-0000-4000-8000-000000000001',
  reason: 'API ID belongs to another historical recall',
  decisionClass: 'D_api_id_reuse',
  replayed: false,
  seenCount: 1,
  payloadSha256: parameters.p_payload_hash,
  payloadRetention: 'retained',
  ...extra,
});
function fakeDatabase(handler) {
  const calls = [];
  return {
    calls,
    rpc(name, parameters) {
      calls.push({ name, parameters });
      return Promise.resolve({ data: handler(name, parameters), error: null });
    },
  };
}

test('the gate sends the complete payload and its hash to the retaining RPC only', async () => {
  const database = fakeDatabase((name, p) => quarantine(p));
  const outcome = await ingestCpscRecallIdentity(database, record);
  assert.equal(outcome.status, 'quarantined');
  assert.deepEqual(
    database.calls.map((c) => c.name),
    ['record_cpsc_retained_observation'],
  );
  const [{ parameters }] = database.calls;
  assert.deepEqual(parameters.p_raw_payload, record.rawPayload);
  assert.equal(parameters.p_payload_hash, await sourcePayloadSha256(record.rawPayload));
  assert.equal(parameters.p_recall_number, '26756');
  assert.equal(outcome.observation.payloadSha256, parameters.p_payload_hash);
});

test('a hold is accepted only when the database confirms retention of this exact payload', async () => {
  for (const extra of [
    { payloadRetention: undefined },
    { payloadRetention: 'legacy_hash_only' },
    { payloadSha256: 'b'.repeat(64) },
    { replayed: undefined },
    { seenCount: 0 },
  ]) {
    await assert.rejects(
      ingestCpscRecallIdentity(
        fakeDatabase((name, p) => quarantine(p, extra)),
        record,
      ),
      /retention was not confirmed|invalid result/u,
      JSON.stringify(extra),
    );
  }
  await assert.rejects(
    ingestCpscRecallIdentity(
      fakeDatabase(() => ({ status: 'resolved', observationId: 'x' })),
      record,
    ),
    /retention was not confirmed/u,
  );
});

test('row outcomes: holds are durable and non-fatal; failures are fatal', async () => {
  const held = await ingestCpscRecallIdentity(
    fakeDatabase((name, p) => quarantine(p, { replayed: true, seenCount: 4 })),
    record,
  );
  assert.equal(classifyCpscIngestion(held), 'quarantined');
  assert.equal(
    classifyCpscIngestion({ status: 'inserted', noticeId: 'n', observation: {} }),
    'processed',
  );
  assert.equal(
    classifyCpscIngestion({
      status: 'unchanged',
      noticeId: 'n',
      observation: {},
      noticeRevision: { status: 'created' },
    }),
    'processed',
  );
  assert.equal(
    classifyCpscIngestion({
      status: 'unchanged',
      noticeId: 'n',
      observation: {},
      noticeRevision: { status: 'unchanged' },
    }),
    'unchanged',
  );
  assert.throws(
    () =>
      classifyCpscIngestion({
        status: 'quarantined',
        reason: 'x',
        observation: { status: 'quarantined', payloadSha256: 'not-a-hash' },
      }),
    /without a retained source payload/u,
  );

  const counts = emptyOutcomeCounts();
  Object.assign(counts, { processed: 2, unchanged: 3, quarantined: 6, unresolved: 1 });
  assert.equal(sourceRunComplete(12, counts), true, 'holds do not fail the run');
  assert.equal(sourceRunComplete(13, counts), false, 'an unaccounted row fails the run');
  assert.equal(
    sourceRunComplete(13, { ...counts, failed: 1 }),
    false,
    'a failed row fails the run',
  );
  assert.equal(sourceRunComplete(0, emptyOutcomeCounts()), true);
});

test('handlers no longer turn a durable hold into a rejection; aggregation reports holds', () => {
  for (const path of [
    'supabase/functions/ingest-recall-source/index.ts',
    'supabase/functions/ingest-cpsc-recalls/index.ts',
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /CPSC identity quarantined/u, path);
    assert.match(source, /classifyCpscIngestion\(outcome\)/u, path);
    assert.match(source, /stats\.outcomes\.failed \+= 1/u, path);
  }
  const single = read('supabase/functions/ingest-recall-source/index.ts');
  assert.match(single, /const complete = sourceRunComplete\(stats\.fetched, stats\.outcomes\)/u);
  assert.match(single, /p_watermark: complete \? adapter\.watermarkFor/u);
  const aggregate = read('supabase/functions/ingest-recall-sources/index.ts');
  assert.match(aggregate, /totals\.quarantined \+= quarantined/u);
  assert.match(aggregate, /status: rejected === 0 \? 'success' : 'failed'/u);
  // The automation-facing rejected total keeps its meaning.
  assert.doesNotMatch(aggregate, /totals\.rejected \+=/u);
});

test('the six-collision attachment is deterministic, bounded, and hash-verified', async () => {
  const file = JSON.parse(read('docs/phase-16-16a-payload-attachment-manifest.json'));
  assert.deepEqual(await buildAttachment(), file);
  assert.equal(file.attachmentVersion, 'phase-16.16a-captured-payload-attachment-v1');
  assert.equal(file.apiRoot, 'https://www.saferproducts.gov/RestWebServices/Recall');
  assert.equal(
    file.captureSha256,
    createHash('sha256')
      .update(readFileSync(new URL('docs/phase-16-14-cpsc-fresh-capture.json', root)))
      .digest('hex'),
  );
  assert.deepEqual(
    file.items.map((item) => `${item.recallNumber}/${item.apiId}`),
    ['26749/10969', '26753/10965', '26754/10967', '26756/10968', '26763/10966', '26766/10970'],
  );
  const recorded = JSON.parse(read('docs/phase-16-15-backfill-manifest.json')).currentObservations;
  for (const item of file.items) {
    assert.deepEqual(Object.keys(item).sort(), [
      'apiId',
      'payload',
      'payloadSha256',
      'recallNumber',
    ]);
    assert.equal(await sourcePayloadSha256(item.payload), item.payloadSha256);
    assert.equal(String(item.payload.RecallID), item.apiId);
    assert.ok(
      recorded.some(
        (o) =>
          o.apiId === item.apiId &&
          o.recallNumber === item.recallNumber &&
          o.payloadHash === item.payloadSha256,
      ),
      item.recallNumber,
    );
  }
});

test('the migration is additive and grants exactly one new worker RPC', () => {
  const sql = read(MIGRATION);
  const later = readdirSync(new URL('supabase/migrations/', root)).filter(
    (name) =>
      name > '20260926150000_phase_16_13_source_coverage_review_queue.sql' &&
      name <= '20260926210000_phase_16_16_quarantine_payload_retention.sql',
  );
  assert.deepEqual(later, ['20260926210000_phase_16_16_quarantine_payload_retention.sql']);
  assert.match(sql, /^-- Phase 16\.16A/u);
  assert.match(sql, /\nbegin;\n/u);
  assert.match(sql, /\ncommit;\n$/u);
  for (const forbidden of [
    /\bdrop\s+(table|function|column|trigger|index|view|policy)\b/iu,
    /(^|\n)\s*truncate\b/iu,
    /\bcron\./iu,
    /create\s+or\s+replace\s+function\s+public\.record_cpsc_identity_observation/iu,
    /\balter\s+table\s+private\.cpsc_identity_observations\b/iu,
    /\bupdate\s+private\.|\bdelete\s+from\s+private\./iu,
    /\bgrant\b[^;]*\bto\s+(anon|authenticated|public)\b/iu,
    /insert\s+into\s+private\.cpsc_(source_aliases|source_identities|identity_reconciliations|candidate)/iu,
  ]) {
    assert.doesNotMatch(sql, forbidden, String(forbidden));
  }
  const grants = [...sql.matchAll(/\ngrant\s+([^;]+);/giu)].map((m) => m[1].replace(/\s+/gu, ' '));
  assert.deepEqual(grants, [
    'execute on function public.record_cpsc_retained_observation( text, text, text, text, text, date, text, timestamptz, text, jsonb) to service_role',
  ]);
  assert.match(
    sql,
    /generated always as \(private\.cpsc_payload_sha256_v1\(payload\)\) stored primary key/u,
  );
  assert.match(sql, /canonical_payload_bytes <= 262144/u);
});

test('the rollback-only production suite embeds the exact migration body and ends in ROLLBACK', async () => {
  const suite = read('supabase/test-fixtures/phase-16-16a-rollback-validation.sql');
  assert.equal(
    await buildSuite(),
    suite,
    'regenerate with scripts/build-phase-16-16a-rollback-validation.mjs',
  );
  const body = read(MIGRATION).split('\n');
  const inner = body.slice(body.indexOf('begin;') + 1, body.lastIndexOf('commit;')).join('\n');
  assert.ok(suite.includes(`-- ===== BEGIN exact migration body =====\n${inner}\n-- ===== END`));
  assert.match(suite, /\nrollback;\n$/u);
  assert.doesNotMatch(suite, /^\s*commit\b/imu);
  assert.doesNotMatch(suite, /create\s+extension|drop\s+extension/iu);
  assert.doesNotMatch(
    suite,
    /record_cpsc_retained_observation\(\s*'/u,
    'no observation insert on production',
  );
});
