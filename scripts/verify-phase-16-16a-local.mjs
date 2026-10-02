// Phase 16.16A real local proof (disposable local stack only; refuses any
// non-loopback URL). Requires a fresh `npx supabase db reset --local --yes`.
//
// 1. Rebuilds production-shaped CPSC state: the 41-notice 16.14 snapshot plus the
//    real 16.15 backfill manifest, which reproduces the six API-ID reuse
//    quarantines with their production hashes (legacy, hash-only).
// 2. Proves the CPSC watermark is refused while they are hash-only.
// 3. Runs the bounded attachment (dry run, execute, re-execute).
// 4. Drives the REAL worker gate (ingestCpscRecallIdentity) over local PostgREST
//    with every captured collision payload, twice: each replay reuses its
//    existing review item and adds no observation, payload, or alias.
// 5. Reads each packet as a real reconciler JWT: the exact stored payload.
// 6. Changed-payload regression on one collision (A, A, B, B, A).
// 7. HTTP authorization: anon, consumer, criterion reviewer, worker.
// It commits fixtures to the local database; reset afterwards.
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import { ingestCpscRecallIdentity } from '../supabase/functions/_shared/cpsc/ingestionGate.ts';
import { mapCpscRecall } from '../supabase/functions/_shared/cpsc/mapper.ts';
import {
  classifyCpscIngestion,
  emptyOutcomeCounts,
  sourceRunComplete,
} from '../supabase/functions/_shared/cpsc/sourceOutcome.ts';
import { sourcePayloadSha256 } from '../supabase/functions/_shared/recallMatching/reviewedCriteriaV2.ts';

const status = JSON.parse(
  spawnSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8' }).stdout,
);
for (const value of [status.API_URL, status.DB_URL]) {
  const host = new URL(value.replace(/^postgresql:/u, 'http:')).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('Local stack only.');
}
const api = status.API_URL;
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) });
  if (!ok)
    console.error(`FAIL ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};
const sql = (query) => {
  const result = spawnSync(
    'psql',
    [status.DB_URL, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
    {
      input: query,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const one = (query) => JSON.parse(sql(query).split('\n').at(-1));
const literal = (value) =>
  `'${(typeof value === 'string' ? value : JSON.stringify(value)).replaceAll("'", "''")}'`;

async function rpc(credential, name, body) {
  const headers = credential.startsWith('sb_')
    ? { apikey: credential }
    : { apikey: status.ANON_KEY, authorization: `Bearer ${credential}` };
  const response = await fetch(`${api}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}
const denied = (result) =>
  [401, 403, 404].includes(result.status) ||
  (result.status >= 400 &&
    (result.data?.code === '42501' ||
      /permission denied|authorization required/iu.test(JSON.stringify(result.data))));

async function user(label) {
  const email = `phase1616a-${label}-${Date.now()}-${randomInt(1e9)}@example.invalid`;
  const password = `P-${randomInt(1e12)}-local-only`;
  const created = await fetch(`${api}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: status.SERVICE_ROLE_KEY,
      authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  }).then((response) => response.json());
  const session = await fetch(`${api}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: status.ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((response) => response.json());
  if (!created.id || !session.access_token) throw new Error(`Could not create ${label}.`);
  return { id: created.id, token: session.access_token };
}

// ---------------------------------------------------------------------------
// 1. Production-shaped state from the real 16.15 manifest.
// ---------------------------------------------------------------------------
if (
  sql(
    "select count(*) from public.recall_notices n join public.recall_sources s on s.id = n.source_id where s.source_key = 'cpsc';",
  ) !== '0'
) {
  throw new Error('Requires a fresh local reset (CPSC notices already present).');
}
const notices = JSON.parse(await readFile('docs/phase-16-14-cpsc-notice-snapshot.json', 'utf8'));
const manifestText = await readFile('docs/phase-16-15-backfill-manifest.json', 'utf8');
const attachment = JSON.parse(
  await readFile('docs/phase-16-16a-payload-attachment-manifest.json', 'utf8'),
);
const seed = [
  'begin;',
  "select set_config('r.source', public.ensure_cpsc_recall_source()::text, true);",
];
for (const row of notices) {
  seed.push(
    'insert into public.recall_notices (id,source_id,external_id,title,recall_date,official_url,' +
      `retrieved_at,raw_payload) values (${literal(row.id)},current_setting('r.source')::uuid,` +
      `${literal(row.external_id)},${literal(row.title)},${literal(row.recall_date)},` +
      `${literal(row.official_url)},'2026-09-20T00:00:00Z',` +
      `${literal({ RecallID: Number(row.external_id), RecallNumber: row.recall_number })}::jsonb);`,
  );
  for (const scope of row.scopes) {
    seed.push(
      'insert into public.recall_scopes (id,recall_notice_id,product_name,gtin,model_number) values ' +
        `(${literal(scope.id)},${literal(row.id)},${literal(scope.product_name ?? 'Fixture product')},` +
        `${scope.gtin ? literal(scope.gtin) : 'null'},${scope.model_number ? literal(scope.model_number) : 'null'});`,
    );
  }
}
seed.push('commit;');
sql(seed.join('\n'));
const backfill = one(
  `select private.cpsc_historical_backfill(${literal(manifestText)}::jsonb,'all',true,'Phase 16.16A local rehearsal',5000);`,
);
check(
  '16.15 manifest backfill completes locally',
  backfill.structure?.complete !== false,
  backfill,
);

const STATE = `select json_build_object(
  'observations',(select count(*) from private.cpsc_identity_observations),
  'quarantined',(select count(*) from private.cpsc_identity_observations where resolution='quarantined'),
  'payloads',(select count(*) from private.cpsc_observation_payloads),
  'identities',(select md5(string_agg(i::text,'|' order by i.id)) from private.cpsc_source_identities i),
  'aliases',(select md5(string_agg(a::text,'|' order by a.id)) from private.cpsc_source_aliases a),
  'apiRevisions',(select md5(string_agg(r::text,'|' order by r.id)) from private.cpsc_api_revisions r),
  'noticeRevisions',(select count(*) from private.cpsc_notice_revisions),
  'notices',(select md5(string_agg(n::text,'|' order by n.id)) from public.recall_notices n),
  'scopes',(select md5(string_agg(s::text,'|' order by s.id)) from public.recall_scopes s),
  'reconciliations',(select count(*) from private.cpsc_identity_reconciliations),
  'criteria',(select count(*) from private.recall_scope_criteria_v2)
    + (select count(*) from private.recall_scope_rule_sets_v2)
    + (select count(*) from private.cpsc_candidate_review_ledger),
  'safety',private.cpsc_watermark_safety());`;
const seeded = one(STATE);
const legacy = JSON.parse(
  sql(`select json_agg(json_build_object('id',id,'api',upstream_api_id,'num',official_recall_number,
    'hash',payload_hash) order by official_recall_number) from private.cpsc_identity_observations
    where resolution='quarantined';`),
);
check(
  'local rebuild reproduces 78 observations and 6 quarantines',
  seeded.observations === 78 && seeded.quarantined === 6,
  seeded,
);
check(
  'local quarantine hashes equal the six production hashes (via attachment manifest)',
  attachment.items.every((i) =>
    legacy.some((o) => o.api === i.apiId && o.num === i.recallNumber && o.hash === i.payloadSha256),
  ) && legacy.length === 6,
);
check(
  'all six start as legacy hash-only and unsafe',
  !seeded.safety.safe && seeded.safety.legacyHashOnly === 6,
);

// ---------------------------------------------------------------------------
// 2. Watermark refused while hash-only (worker path over HTTP).
// ---------------------------------------------------------------------------
const worker = status.SERVICE_ROLE_KEY;
const blocked = await rpc(worker, 'record_recall_source_sync_result', {
  p_source_key: 'cpsc',
  p_status: 'success',
  p_watermark: { kind: 'last_publish_date', value: '2026-09-27' },
  p_metrics: { fetched: 0 },
});
check(
  'HTTP: CPSC watermark advance refused while six quarantines are hash-only',
  blocked.status >= 400 && /watermark cannot advance/u.test(JSON.stringify(blocked.data)),
  blocked,
);

// ---------------------------------------------------------------------------
// 3. Bounded attachment.
// ---------------------------------------------------------------------------
const attachSql = (execute) =>
  one(`select private.cpsc_attach_captured_payloads(${literal(attachment)}::jsonb, ${execute});`);
const dry = attachSql(false);
check(
  'attachment dry run would attach six and stores nothing',
  dry.wouldAttach === 6 && one(STATE).payloads === 0,
  dry,
);
const run1 = attachSql(true);
const run2 = attachSql(true);
check('attachment execution attaches six', run1.attached === 6 && run1.watermarkSafety.safe, run1);
check('attachment is idempotent', run2.attached === 0 && run2.alreadyRetained === 6);
const attached = one(STATE);
check(
  'attachment wrote only payload rows',
  attached.payloads === 6 &&
    [
      'observations',
      'quarantined',
      'identities',
      'aliases',
      'apiRevisions',
      'notices',
      'scopes',
      'reconciliations',
      'criteria',
    ].every((key) => attached[key] === seeded[key]),
  { seeded, attached },
);

// ---------------------------------------------------------------------------
// 4. The real worker gate over HTTP, twice per collision.
// ---------------------------------------------------------------------------
const database = {
  rpc: (name, parameters) =>
    rpc(worker, name, parameters).then((result) =>
      result.status < 300 ? { data: result.data, error: null } : { data: null, error: result.data },
    ),
};
const counts = emptyOutcomeCounts();
const sixResults = [];
for (const item of attachment.items) {
  const legacyRow = legacy.find((o) => o.num === item.recallNumber);
  const record = mapCpscRecall(item.payload);
  const first = await ingestCpscRecallIdentity(database, record);
  const second = await ingestCpscRecallIdentity(database, record);
  counts[classifyCpscIngestion(first)] += 1;
  const result = {
    recallNumber: item.recallNumber,
    apiId: item.apiId,
    firstStatus: first.status,
    reusedLegacyObservation:
      first.observation.observationId === legacyRow.id &&
      second.observation.observationId === legacyRow.id,
    replayed: first.observation.replayed === true && second.observation.replayed === true,
    seenCounts: [first.observation.seenCount, second.observation.seenCount],
    payloadSha256: first.observation.payloadSha256,
  };
  sixResults.push(result);
  check(
    `${item.recallNumber}: worker replay reuses the existing quarantine`,
    first.status === 'quarantined' &&
      result.reusedLegacyObservation &&
      result.replayed &&
      result.seenCounts.join() === '2,3' &&
      result.payloadSha256 === item.payloadSha256,
    result,
  );
}
check(
  'six collisions classify as non-fatal quarantined outcomes',
  counts.quarantined === 6 && sourceRunComplete(6, counts),
  counts,
);
const replayed = one(STATE);
check(
  'twelve replays add no observation, payload, alias, identity, notice, or review item',
  [
    'observations',
    'quarantined',
    'payloads',
    'identities',
    'aliases',
    'apiRevisions',
    'notices',
    'scopes',
    'reconciliations',
    'criteria',
  ].every((key) => replayed[key] === attached[key]),
  { attached, replayed },
);
const aliasOwners = JSON.parse(
  sql(`select json_agg(json_build_object('api',a.alias_value,'num',i.official_recall_number))
    from private.cpsc_source_aliases a join private.cpsc_source_identities i on i.id=a.identity_id
    where a.alias_kind='api_id' and a.alias_value in (${attachment.items.map((i) => literal(i.apiId)).join(',')});`),
);
check(
  'no reused API ID is aliased to the quarantined recall (no identity hijack)',
  aliasOwners.every(
    (a) => !attachment.items.some((i) => i.apiId === a.api && i.recallNumber === a.num),
  ) && aliasOwners.length >= 6,
  aliasOwners,
);

// ---------------------------------------------------------------------------
// 5. Reconciler packet over HTTP (real JWT).
// ---------------------------------------------------------------------------
const reconciler = await user('reconciler');
const consumer = await user('consumer');
const criterionReviewer = await user('criterion-reviewer');
sql(`insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason) values
  ('${reconciler.id}','identity_reconciliation', now() - interval '1 hour','Phase 16.16A local HTTP');
  insert into private.cpsc_reviewer_authorizations (user_id, authorized_at, reason) values
  ('${criterionReviewer.id}', now() - interval '1 hour', 'Phase 16.16A local HTTP');`);
for (const item of attachment.items) {
  const legacyRow = legacy.find((o) => o.num === item.recallNumber);
  const packet = await rpc(reconciler.token, 'get_cpsc_quarantine_packet', {
    p_observation_id: legacyRow.id,
  });
  const p = packet.data ?? {};
  check(
    `${item.recallNumber}: reconciler reads the exact stored payload without refetching`,
    packet.status === 200 &&
      isDeepStrictEqual(p.sourceRevision?.payload, item.payload) &&
      p.sourceRevision?.hashVerified === true &&
      p.sourceRevision?.payloadSha256 === item.payloadSha256 &&
      p.payloadRetention === 'retained' &&
      p.sourceRevision?.recordedVia === 'captured_payload_attachment' &&
      p.sightings?.seenCount === 3 &&
      p.incomingApiId === item.apiId &&
      p.officialRecallNumber === item.recallNumber &&
      (p.conflictingAliases ?? []).some(
        (a) =>
          a.aliasKind === 'api_id' &&
          a.aliasValue === item.apiId &&
          a.officialRecallNumber !== item.recallNumber,
      ),
    { status: packet.status, keys: Object.keys(p) },
  );
}

// ---------------------------------------------------------------------------
// 6. Changed payload on one collision: A, A, B, B, A.
// ---------------------------------------------------------------------------
const target = attachment.items.find((i) => i.recallNumber === '26756');
const legacyTarget = legacy.find((o) => o.num === '26756');
const revisedPayload = {
  ...target.payload,
  Description: `${target.payload.Description} [Phase 16.16A regression: materially changed]`,
};
const revisedHash = await sourcePayloadSha256(revisedPayload);
const b1 = await ingestCpscRecallIdentity(database, mapCpscRecall(revisedPayload));
const b2 = await ingestCpscRecallIdentity(database, mapCpscRecall(revisedPayload));
const a3 = await ingestCpscRecallIdentity(database, mapCpscRecall(target.payload));
check(
  'B is a new review item with a different verified hash',
  b1.status === 'quarantined' &&
    b1.observation.observationId !== legacyTarget.id &&
    b1.observation.replayed === false &&
    b1.observation.payloadSha256 === revisedHash &&
    revisedHash !== target.payloadSha256,
  b1,
);
check(
  'replaying B reuses B',
  b2.observation.observationId === b1.observation.observationId && b2.observation.replayed,
);
check(
  'replaying A after B still reuses A',
  a3.observation.observationId === legacyTarget.id && a3.observation.seenCount === 4,
);
const packetA = (
  await rpc(reconciler.token, 'get_cpsc_quarantine_packet', { p_observation_id: legacyTarget.id })
).data;
const packetB = (
  await rpc(reconciler.token, 'get_cpsc_quarantine_packet', {
    p_observation_id: b1.observation.observationId,
  })
).data;
check(
  'A remains stored unchanged; B is stored separately; lineage is A then B',
  isDeepStrictEqual(packetA.sourceRevision.payload, target.payload) &&
    isDeepStrictEqual(packetB.sourceRevision.payload, revisedPayload) &&
    packetA.sourceRevisionLineage.map((r) => r.payloadSha256).join() ===
      [target.payloadSha256, revisedHash].join() &&
    packetB.sourceRevisionLineage.map((r) => r.payloadSha256).join() ===
      [target.payloadSha256, revisedHash].join() &&
    packetA.sourceRevisionLineage[0].thisObservation &&
    packetB.sourceRevisionLineage[1].thisObservation,
  { lineageA: packetA.sourceRevisionLineage, lineageB: packetB.sourceRevisionLineage },
);
const afterChange = one(STATE);
check(
  'changed payload adds exactly one observation and one payload',
  afterChange.observations === replayed.observations + 1 &&
    afterChange.payloads === replayed.payloads + 1 &&
    afterChange.aliases === replayed.aliases &&
    afterChange.identities === replayed.identities,
  afterChange,
);
check(
  'watermark stays safe with the retained revision B',
  afterChange.safety.safe && afterChange.safety.quarantined === 7,
);
const advanced = await rpc(worker, 'record_recall_source_sync_result', {
  p_source_key: 'cpsc',
  p_status: 'success',
  p_watermark: { kind: 'last_publish_date', value: '2026-09-27' },
  p_metrics: { fetched: 7 },
});
check(
  'HTTP: CPSC watermark advances once every quarantine is retained',
  advanced.status < 300,
  advanced,
);

// ---------------------------------------------------------------------------
// 7. HTTP authorization.
// ---------------------------------------------------------------------------
const forgedArgs = {
  p_api_id: target.apiId,
  p_recall_number: target.recallNumber,
  p_observed_url: target.payload.URL,
  p_canonical_url: target.payload.URL.replace('https://cpsc.gov/', 'https://www.cpsc.gov/'),
  p_title: target.payload.Title,
  p_publication_date: target.payload.RecallDate.slice(0, 10),
  p_payload_hash: 'a'.repeat(64),
  p_observed_at: new Date().toISOString(),
  p_provenance: 'Phase 16.16A HTTP forged hash',
  p_raw_payload: target.payload,
};
const forged = await rpc(worker, 'record_cpsc_retained_observation', forgedArgs);
check(
  'HTTP: worker cannot store a payload under a forged hash',
  forged.status >= 400 && /hash does not match/u.test(JSON.stringify(forged.data)),
  forged,
);
const oversize = await rpc(worker, 'record_cpsc_retained_observation', {
  ...forgedArgs,
  p_raw_payload: { ...target.payload, Description: 'x'.repeat(270_000) },
});
check(
  'HTTP: oversized payload fails closed',
  oversize.status >= 400 && /Invalid CPSC source payload/u.test(JSON.stringify(oversize.data)),
  oversize,
);
const validArgs = {
  ...forgedArgs,
  p_payload_hash: target.payloadSha256,
  p_provenance: 'Phase 16.16A HTTP auth',
};
for (const [label, credential] of [
  ['anon (legacy key)', status.ANON_KEY],
  ['anon (publishable key)', status.PUBLISHABLE_KEY],
  ['consumer', consumer.token],
  ['criterion reviewer', criterionReviewer.token],
  ['reconciler', reconciler.token],
]) {
  check(
    `HTTP: ${label} cannot record observations`,
    denied(await rpc(credential, 'record_cpsc_retained_observation', validArgs)),
  );
}
for (const [label, credential] of [
  ['anon', status.ANON_KEY],
  ['consumer', consumer.token],
  ['criterion reviewer', criterionReviewer.token],
  ['worker', worker],
]) {
  check(
    `HTTP: ${label} cannot read the reconciliation packet`,
    denied(
      await rpc(credential, 'get_cpsc_quarantine_packet', { p_observation_id: legacyTarget.id }),
    ),
  );
}
check(
  'HTTP: worker cannot reconcile',
  denied(
    await rpc(worker, 'reconcile_cpsc_quarantined_observation', {
      p_observation_id: legacyTarget.id,
      p_decision: 'reject_observation',
      p_rationale: 'worker',
    }),
  ),
);
check(
  'HTTP: worker cannot record human review',
  denied(
    await rpc(worker, 'decide_cpsc_candidate', {
      p_candidate_id: legacyTarget.id,
      p_decision: 'reviewed',
      p_mandatory_eligibility: true,
      p_review_note: 'worker',
    }),
  ),
);
check(
  'HTTP: worker cannot run the attachment',
  denied(
    await rpc(worker, 'cpsc_attach_captured_payloads', {
      p_attachment: attachment,
      p_execute: true,
    }),
  ),
);
for (const [label, credential] of [
  ['anon', status.ANON_KEY],
  ['worker', worker],
]) {
  const response = await fetch(`${api}/rest/v1/cpsc_observation_payloads?select=*`, {
    headers: credential.startsWith('sb_')
      ? { apikey: credential }
      : { apikey: status.ANON_KEY, authorization: `Bearer ${credential}` },
  });
  check(
    `HTTP: ${label} cannot read payload rows directly`,
    response.status >= 400,
    response.status,
  );
}
const final = one(STATE);
check(
  'no reconciliation, criterion, or review row was created',
  final.reconciliations === 0 && final.criteria === 0,
);

const passed = checks.every((c) => c.ok);
const report = {
  passed,
  checks: checks.length,
  failures: checks.filter((c) => !c.ok),
  seeded: { observations: seeded.observations, quarantined: seeded.quarantined },
  attachment: { dryRun: dry.wouldAttach, run1: run1.attached, run2: run2.alreadyRetained },
  sixCollisions: sixResults,
  changedPayload: {
    recallNumber: '26756',
    revisionA: target.payloadSha256,
    revisionB: revisedHash,
    observationA: legacyTarget.id,
    observationB: b1.observation.observationId,
  },
  final: {
    observations: final.observations,
    quarantined: final.quarantined,
    payloads: final.payloads,
    safety: {
      safe: final.safety.safe,
      quarantined: final.safety.quarantined,
      retained: final.safety.retained,
    },
  },
};
const out = process.argv[2];
if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed, checks: checks.length, failed: report.failures.length }));
if (!passed) process.exit(1);
