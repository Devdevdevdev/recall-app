// Real local HTTP proof for the Phase 16.12 multi-rule scope model and role split.
// Real GoTrue users/JWTs against local PostgREST; the worker page path is the
// production TS module fed the frozen Char-Broil page (re-keyed to a fresh
// synthetic recall number so the script can be re-run). Local stack only: it
// refuses any non-loopback URL. It commits fixtures to the disposable local
// database; run `npx supabase db reset --local --yes` afterwards.
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ownerLegacyObservationFixture } from './lib/legacyObservationFixture.mjs';

import { ingestCpscOfficialPage } from '../supabase/functions/_shared/cpsc/pageIngestion.ts';
import { projectOwnedProductForProductionV2 } from '../supabase/functions/_shared/recallMatching/productionPolicyV2.ts';
import { sourcePayloadSha256 } from '../supabase/functions/_shared/recallMatching/reviewedCriteriaV2.ts';
import {
  evaluateRuleSetsPairV2,
  projectRecallRuleSetsForProductionV2,
  validateLiveRuleSetEnvelopeV2,
} from '../supabase/functions/_shared/recallMatching/ruleSetsV2.ts';

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
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) console.error(`FAIL ${name} ${detail}`);
};
const sql = (query) => {
  const result = spawnSync('psql', [status.DB_URL, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
    input: query,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

function headers(credential) {
  if (credential.startsWith('sb_'))
    return { apikey: credential, 'content-type': 'application/json' };
  return {
    apikey: status.ANON_KEY,
    authorization: `Bearer ${credential}`,
    'content-type': 'application/json',
  };
}
async function rpc(credential, name, body) {
  const response = await fetch(`${api}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: headers(credential),
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
  [401, 403].includes(result.status) &&
  (result.data?.code === '42501' ||
    /permission denied|authorization required/iu.test(JSON.stringify(result.data)));

async function user(label) {
  const email = `phase1612-${label}-${Date.now()}-${randomInt(1e9)}@example.invalid`;
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

const anon = status.ANON_KEY;
const worker = status.SERVICE_ROLE_KEY;
const workerSecret = status.SECRET_KEY;
const reviewer = await user('reviewer');
const reviewer2 = await user('reviewer-two');
const reconciler = await user('reconciler');
const invalidator = await user('invalidator');
const consumer = await user('consumer');
sql(`insert into private.cpsc_reviewer_authorizations (user_id, authorized_at, reason) values
  ('${reviewer.id}', now() - interval '1 hour', 'Phase 16.12 local HTTP reviewer'),
  ('${reviewer2.id}', now() - interval '1 hour', 'Phase 16.12 local HTTP reviewer');
  insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason) values
  ('${reconciler.id}', 'identity_reconciliation', now() - interval '1 hour', 'Phase 16.12 HTTP'),
  ('${invalidator.id}', 'decision_invalidation', now() - interval '1 hour', 'Phase 16.12 HTTP');
  select public.ensure_cpsc_recall_source();`);

// --- A fresh identity whose official page is the frozen Char-Broil structure.
const recallNumber = `9${String(randomInt(10_000)).padStart(4, '0')}`;
const apiId = String(9_000_000 + randomInt(900_000));
const slug = `Phase-16-12-Http-${recallNumber}`;
const url = `https://www.cpsc.gov/Recalls/2026/${slug}`;
const html = (
  await readFile(new URL('../tests/fixtures/cpsc-pages/char-broil.html', import.meta.url), 'utf8')
)
  .replaceAll('Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock', slug)
  .replace('26-773', `${recallNumber.slice(0, 2)}-${recallNumber.slice(2)}`);
const title = 'Char-Broil Recalls Bistro Pro Electric Grills Due to Risk of Electric Shock';
const payload = {
  RecallID: apiId,
  RecallNumber: recallNumber,
  Products: [{ Name: 'Bistro Pro Electric Grill', Model: '25302145' }],
  Manufacturers: [{ Name: 'Char-Broil' }],
};
const observationInput = {
  p_api_id: apiId,
  p_recall_number: recallNumber,
  p_observed_url: url,
  p_canonical_url: url,
  p_title: title,
  p_publication_date: '2026-09-18',
  p_payload_hash: await sourcePayloadSha256(payload),
  p_observed_at: new Date().toISOString(),
  p_provenance: 'Phase 16.12 HTTP verification',
};
check(
  'worker direct legacy observation is denied',
  denied(await rpc(worker, 'record_cpsc_identity_observation', observationInput)),
);
const observation = ownerLegacyObservationFixture(sql, observationInput);
check('owner fixture creates the canonical identity', observation.data?.status === 'created');
const notice = await rpc(workerSecret, 'ingest_cpsc_identity_notice', {
  p_observation_id: observation.data.observationId,
  p_description: 'Bistro Pro electric grills.',
  p_hazard: 'Electric shock',
  p_remedy: 'Refund',
  p_retrieved_at: new Date().toISOString(),
  p_raw_payload: payload,
  p_scopes: [{ productName: 'Bistro Pro Electric Grill' }],
});
check('worker ingests the identity-bound notice', notice.data?.status === 'inserted');
const noticeId = notice.data.noticeId;
const targets = await rpc(worker, 'get_cpsc_page_fetch_targets', { p_limit: 50 });
const row = targets.data.find((item) => item.official_recall_number === recallNumber);
const target = {
  identityId: row.identity_id,
  officialRecallNumber: row.official_recall_number,
  canonicalUrl: row.canonical_url,
  soleScopeId: row.sole_scope_id,
};
check('fetch target carries the sole scope', target.canonicalUrl === url && target.soleScopeId);
const database = {
  rpc: (name, parameters) =>
    rpc(worker, name, parameters).then((result) =>
      result.status < 300 ? { data: result.data, error: null } : { data: null, error: result.data },
    ),
};
const ingested = await ingestCpscOfficialPage(
  database,
  target,
  async () =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
);
check(
  'production page worker records 18 unreviewed proposals',
  ingested.status === 'recorded' && ingested.proposalsCreated === 18,
  JSON.stringify(ingested),
);
const firstCandidate = sql(`select c.id from private.cpsc_candidate_criteria c
  where c.revision_id = ${literal(ingested.revisionId)} order by c.created_at, c.id limit 1;`);

// --- Role denials.
const decide = (credential, id) =>
  rpc(credential, 'decide_cpsc_candidate', {
    p_candidate_id: id,
    p_decision: 'reviewed',
    p_mandatory_eligibility: true,
    p_review_note: 'HTTP',
  });
const invalidate = (credential, eventId) =>
  rpc(credential, 'invalidate_cpsc_review_decision', {
    p_review_event_id: eventId,
    p_reason: 'Phase 16.12 HTTP for-cause invalidation',
  });
const reconcileAs = (credential, observationId) =>
  rpc(credential, 'reconcile_cpsc_quarantined_observation', {
    p_observation_id: observationId,
    p_decision: 'reject_observation',
    p_rationale: 'Phase 16.12 HTTP verification',
  });
const someId = '00000000-0000-4000-8000-000000000000';
for (const [label, credential] of [
  ['anon', anon],
  ['consumer', consumer.token],
]) {
  check(`${label} cannot decide`, denied(await decide(credential, firstCandidate)));
  check(`${label} cannot revoke for cause`, denied(await invalidate(credential, someId)));
  check(`${label} cannot reconcile`, denied(await reconcileAs(credential, someId)));
  check(
    `${label} cannot read matcher rule sets`,
    denied(await rpc(credential, 'get_recall_v2_scopes', { p_recall_notice_id: noticeId })),
  );
  check(
    `${label} cannot record notice revisions`,
    denied(
      await rpc(credential, 'record_cpsc_notice_revision', {
        p_observation_id: someId,
        p_description: null,
        p_hazard: null,
        p_remedy: null,
        p_raw_payload: {},
      }),
    ),
  );
}
for (const [label, credential] of [
  ['service_role JWT', worker],
  ['sb_secret key', workerSecret],
]) {
  check(`${label} cannot human-review`, denied(await decide(credential, firstCandidate)));
  check(
    `${label} cannot materialize`,
    denied(
      await rpc(credential, 'materialize_cpsc_reviewed_conjunction', {
        p_candidate_id: firstCandidate,
      }),
    ),
  );
  check(`${label} cannot revoke for cause`, denied(await invalidate(credential, someId)));
  check(
    `${label} cannot bulk revoke for cause`,
    denied(
      await rpc(credential, 'invalidate_cpsc_reviewer_decisions', {
        p_reviewer_user_id: reviewer.id,
        p_decided_from: '2026-01-01T00:00:00Z',
        p_decided_to: '2027-01-01T00:00:00Z',
        p_reason: 'automation',
      }),
    ),
  );
  check(`${label} cannot reconcile quarantine`, denied(await reconcileAs(credential, someId)));
}
const backfill = await rpc(worker, 'cpsc_historical_backfill', {});
check(
  'the owner-only backfill is not reachable over the API',
  backfill.status === 404 || denied(backfill),
  `${backfill.status}`,
);
check('reviewer cannot revoke for cause', denied(await invalidate(reviewer.token, someId)));
check('reviewer cannot reconcile identity', denied(await reconcileAs(reviewer.token, someId)));
check(
  'reviewer cannot run worker ingestion',
  denied(await rpc(reviewer.token, 'get_cpsc_page_fetch_targets', { p_limit: 1 })),
);
check('reconciler cannot review criteria', denied(await decide(reconciler.token, firstCandidate)));
check('reconciler cannot revoke for cause', denied(await invalidate(reconciler.token, someId)));
check(
  'invalidator cannot review criteria',
  denied(await decide(invalidator.token, firstCandidate)),
);
check(
  'invalidator cannot materialize',
  denied(
    await rpc(invalidator.token, 'materialize_cpsc_reviewed_conjunction', {
      p_candidate_id: firstCandidate,
    }),
  ),
);
check(
  'invalidator cannot reconcile identity',
  denied(await reconcileAs(invalidator.token, someId)),
);

// --- The multi-rule reviewer packet.
const packet = await rpc(reviewer.token, 'get_cpsc_candidate_review_packet', {
  p_candidate_id: firstCandidate,
});
const presented = packet.data?.ruleSetPresentation;
check(
  'packet presents 9 rule sets, OR between and AND inside',
  packet.status === 200 &&
    presented?.ruleSetCount === 9 &&
    presented?.semantics === 'OR between rule sets; AND inside each rule set' &&
    presented.ruleSets.every(
      (set) =>
        set.insideRuleSet === 'AND' &&
        set.members.length === 2 &&
        set.members[0].kind === 'model_exact' &&
        set.members[1].kind === 'date_code_set',
    ),
);
check(
  'packet lists rule sets in authoritative table order',
  JSON.stringify(presented?.ruleSets.map((set) => set.members[0].value)) ===
    JSON.stringify([
      '25302145',
      '25302146',
      '25302147',
      '25302148',
      '25302149',
      '25302150',
      '25302151',
      '25302159',
      '25302163',
    ]),
);

// --- Human review of all 18 members; 9 independent materializations.
const members = presented.ruleSets.flatMap((set) =>
  set.members.map((member) => member.candidateId),
);
let decided = 0;
for (const id of members) if ((await decide(reviewer.token, id)).status === 200) decided += 1;
check('reviewer decides all 18 members', decided === 18);
let materialized = 0;
for (const set of presented.ruleSets) {
  const result = await rpc(reviewer.token, 'materialize_cpsc_reviewed_conjunction', {
    p_candidate_id: set.members[0].candidateId,
  });
  if (result.data?.status === 'materialized') materialized += 1;
}
check('9 rule sets materialize on the same scope', materialized === 9);

const recallRow = {
  recall_notice_id: noticeId,
  recall_notice_updated_at: new Date().toISOString(),
  source_authority: 'U.S. Consumer Product Safety Commission (CPSC)',
  source_external_id: `cpsc:${recallNumber}`,
  source_official_url: url,
  source_is_authoritative: true,
  title,
  description: null,
  hazard: null,
  remedy: null,
  recall_date: '2026-09-18',
  raw_payload: {},
  scopes: [],
};
async function servedProjection() {
  const served = await rpc(worker, 'get_recall_v2_scopes', { p_recall_notice_id: noticeId });
  const scope = served.data.find((item) => item.scope_id === target.soleScopeId);
  const validated = await validateLiveRuleSetEnvelopeV2(recallRow, scope, scope.reviewed_criteria);
  return {
    envelope: scope.reviewed_criteria,
    validated,
    projection: projectRecallRuleSetsForProductionV2({ ...recallRow, scopes: [scope] }, [
      validated,
    ]),
  };
}
const owned = (modelNumber, dateCode) =>
  projectOwnedProductForProductionV2({
    owned_product_id: 'p',
    owned_product_updated_at: new Date().toISOString(),
    user_id: consumer.id,
    product_name: 'Bistro Pro Electric Grill',
    brand: null,
    category: null,
    gtin: null,
    model_number: modelNumber,
    serial_number: null,
    lot_number: null,
    purchase_date: null,
    identification_method: 'manual',
    safety_attributes: dateCode ? { date_code: dateCode } : {},
  });

let served = await servedProjection();
check(
  'PostgREST serves 9 rule sets with complete coverage',
  served.envelope?.ruleSets?.length === 9 && served.envelope.coverage.complete === true,
);
check(
  'TS validator accepts 9 / 9 database rule sets (SQL and TS fingerprints agree)',
  served.validated.ruleSets.length === 9 &&
    served.validated.droppedRuleSets === 0 &&
    served.validated.coverageComplete,
);
const decisionOf = (model, code) =>
  evaluateRuleSetsPairV2(owned(model, code), served.projection).decision;
const models = presented.ruleSets.map((set) => set.members[0].value);
check(
  'each model with a listed date code confirms through exactly its rule set',
  models.every((model) => {
    const evaluation = evaluateRuleSetsPairV2(owned(model, '2511'), served.projection);
    return (
      evaluation.decision === 'confirmed' &&
      evaluation.ruleSetTrace.filter((unit) => unit.decision === 'confirmed').length === 1
    );
  }),
);
check(
  'correct model + unlisted date code does not confirm',
  decisionOf('25302145', '2509') !== 'confirmed',
);
check(
  'wrong model + valid date code does not confirm',
  decisionOf('25302199', '2510') !== 'confirmed',
);
check('missing model does not confirm', decisionOf(null, '2510') !== 'confirmed');
check('missing date code does not confirm', decisionOf('25302145', null) !== 'confirmed');

// --- SQL canonical JSON digest parity with the TS payload digest.
const records = JSON.parse(
  await readFile(
    new URL('../supabase/functions/_shared/cpsc/fixtures/cpsc-real-records.json', import.meta.url),
    'utf8',
  ),
);
const samples = [payload, ...(Array.isArray(records) ? records : [records]), { é: 'ü\n"q"' }];
let parity = 0;
for (const sample of samples) {
  const databaseDigest = sql(
    `select private.cpsc_canonical_json_sha256(${literal(JSON.stringify(sample))}::jsonb);`,
  );
  if (databaseDigest === (await sourcePayloadSha256(sample))) parity += 1;
}
check('SQL canonical JSON digest equals the TS payload digest', parity === samples.length);

// --- Revoke-for-cause of one specific decision.
const rowOneModel = presented.ruleSets[0].members[0].candidateId;
const rowOneDate = presented.ruleSets[0].members[1].candidateId;
const eventId = sql(`select id from private.cpsc_candidate_review_ledger
  where candidate_id = ${literal(rowOneDate)} order by event_seq desc limit 1;`);
const before = sql(`select updated_at from public.recall_notices where id = ${literal(noticeId)};`);
const originalFingerprint = served.envelope.ruleSets.find((set) =>
  set.criteria.some((criterion) => criterion.value === '25302145'),
).review.ruleSetFingerprint;
const invalidated = await invalidate(invalidator.token, eventId);
check('invalidator revokes one decision for cause', invalidated.data?.reviewEventId === eventId);
check(
  'revoke-for-cause requires a reason',
  (
    await rpc(invalidator.token, 'invalidate_cpsc_review_decision', {
      p_review_event_id: eventId,
      p_reason: ' ',
    })
  ).status === 400,
);
const after = sql(`select updated_at from public.recall_notices where id = ${literal(noticeId)};`);
check('invalidation advances the notice revision for in-flight claims', after > before);
served = await servedProjection();
check(
  'the dependent rule set is unusable; the other eight stay served',
  served.envelope.ruleSets.length === 8 && served.envelope.coverage.complete === false,
);
check(
  'its product is withheld from rejection, others still confirm',
  decisionOf('25302145', '2511') === 'needs_review' &&
    decisionOf('25302146', '2511') === 'confirmed',
);
const again = await decide(reviewer.token, rowOneDate);
check(
  'the invalidated reviewer cannot re-decide',
  again.status === 400 && /different reviewer/u.test(again.data?.message ?? ''),
);
check('a second reviewer re-decides', (await decide(reviewer2.token, rowOneDate)).status === 200);
const restored = await rpc(reviewer2.token, 'materialize_cpsc_reviewed_conjunction', {
  p_candidate_id: rowOneModel,
});
check(
  're-review restores the same semantic rule-set identity',
  restored.data?.status === 'materialized' &&
    restored.data?.ruleSetFingerprint === originalFingerprint,
);

// --- Prospective revocation keeps history; bulk for-cause revocation does not.
sql(`update private.cpsc_reviewer_authorizations set revoked_at = now()
  where user_id = '${reviewer2.id}';`);
served = await servedProjection();
check(
  'reviewer access revoked prospectively: decisions stay valid',
  served.envelope.ruleSets.length === 9,
);
check('revoked reviewer can no longer decide', denied(await decide(reviewer2.token, rowOneModel)));
const bulk = await rpc(invalidator.token, 'invalidate_cpsc_reviewer_decisions', {
  p_reviewer_user_id: reviewer2.id,
  p_decided_from: new Date(Date.now() - 3_600_000).toISOString(),
  p_decided_to: new Date(Date.now() + 60_000).toISOString(),
  p_reason: 'Reviewer account compromised',
});
check('bulk revoke-for-cause invalidates that reviewer only', bulk.data?.invalidated === 1);
served = await servedProjection();
check('unrelated reviewer decisions remain valid', served.envelope.ruleSets.length === 8);

// --- Notice revision over HTTP (worker) and identity reconciliation (reconciler).
const corrected = ownerLegacyObservationFixture(sql, {
  p_api_id: apiId,
  p_recall_number: recallNumber,
  p_observed_url: url,
  p_canonical_url: url,
  p_title: `${title} (Corrected)`,
  p_publication_date: '2026-09-18',
  p_payload_hash: await sourcePayloadSha256(payload),
  p_observed_at: new Date().toISOString(),
  p_provenance: 'Phase 16.12 HTTP verification',
});
const revision = await rpc(worker, 'record_cpsc_notice_revision', {
  p_observation_id: corrected.data.observationId,
  p_description: 'Bistro Pro electric grills.',
  p_hazard: 'Electric shock',
  p_remedy: 'Refund or repair',
  p_raw_payload: payload,
});
check(
  'worker records a title + remedy correction as a new revision',
  revision.data?.status === 'created' &&
    JSON.stringify(revision.data.changedFields) === JSON.stringify(['title', 'remedy']),
  JSON.stringify(revision.data),
);
const current = await rpc(worker, 'get_cpsc_current_notice_revision', { p_notice_id: noticeId });
check(
  'current read returns the latest authoritative revision',
  current.data?.remedy === 'Refund or repair' && current.data?.revisionCount === 2,
);
check(
  'consumer cannot read notice revisions',
  denied(await rpc(consumer.token, 'get_cpsc_current_notice_revision', { p_notice_id: noticeId })),
);
check(
  'corrections keep the canonical identity and create no recall',
  sql(`select count(*) from public.recall_notices where external_id = 'cpsc:${recallNumber}';`) ===
    '1',
);
const collision = ownerLegacyObservationFixture(sql, {
  p_api_id: apiId,
  p_recall_number: `8${recallNumber.slice(1)}`,
  p_observed_url: `${url}-Other`,
  p_canonical_url: `${url}-Other`,
  p_title: 'Conflicting claimant',
  p_publication_date: '2026-09-25',
  p_payload_hash: 'f'.repeat(64),
  p_observed_at: new Date().toISOString(),
  p_provenance: 'Phase 16.12 HTTP verification',
});
check('reused API ID quarantines', collision.data?.decisionClass === 'D_api_id_reuse');
check(
  'reviewer cannot read quarantine evidence',
  denied(
    await rpc(reviewer.token, 'get_cpsc_quarantine_packet', {
      p_observation_id: collision.data.observationId,
    }),
  ),
);
check(
  'reconciler reads quarantine evidence',
  (
    await rpc(reconciler.token, 'get_cpsc_quarantine_packet', {
      p_observation_id: collision.data.observationId,
    })
  ).data?.incomingApiId === apiId,
);
check(
  'reconciler reconciles with audit',
  (await reconcileAs(reconciler.token, collision.data.observationId)).data?.decision ===
    'reject_observation',
);

const failed = checks.filter((item) => !item.ok);
console.log(
  JSON.stringify(
    {
      checks: checks.length,
      passed: checks.length - failed.length,
      failed: failed.map((item) => item.name),
    },
    null,
    2,
  ),
);
process.exit(failed.length ? 1 : 0);
