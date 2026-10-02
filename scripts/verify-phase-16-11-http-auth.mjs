// Real local HTTP authorization proof for the Phase 16.11 CPSC trust boundary.
// Uses real GoTrue users/JWTs against local PostgREST. Local stack only: it refuses
// any non-loopback API or database URL. It commits fixtures to the disposable
// local database; run `npx supabase db reset --local --yes` afterwards.
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { ownerLegacyObservationFixture } from './lib/legacyObservationFixture.mjs';

import {
  evaluateProductionPairV2,
  projectOwnedProductForProductionV2,
  projectRecallForProductionV2,
} from '../supabase/functions/_shared/recallMatching/productionPolicyV2.ts';
import { validateLiveReviewedCriteriaV2 } from '../supabase/functions/_shared/recallMatching/reviewedCriteriaV2.ts';

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
  const result = spawnSync(
    'psql',
    [status.DB_URL, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

function headers(credential) {
  if (credential.startsWith('sb_')) {
    return { apikey: credential, 'content-type': 'application/json' };
  }
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
  const email = `phase1611-${label}-${Date.now()}-${randomInt(1e9)}@example.invalid`;
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
const consumer = await user('consumer');
const revoked = await user('revoked');
sql(`insert into private.cpsc_reviewer_authorizations (user_id, authorized_at, reason) values
  ('${reviewer.id}', now() - interval '1 hour', 'Phase 16.11 local HTTP reviewer'),
  ('${revoked.id}', now() - interval '2 hours', 'Phase 16.11 local HTTP revoked reviewer');
  update private.cpsc_reviewer_authorizations set revoked_at = now() - interval '1 hour'
  where user_id = '${revoked.id}';
  -- Phase 16.12: identity reconciliation is a separately granted capability.
  insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason)
  values ('${reviewer.id}', 'identity_reconciliation', now() - interval '1 hour',
    'Phase 16.11 local HTTP reconciler');
  select public.ensure_cpsc_recall_source();`);

// --- Direct worker access is denied; the owner fixture creates the identity.
const recallNumber = `9${String(randomInt(10_000)).padStart(4, '0')}`;
const apiId = String(900_000 + randomInt(90_000));
const url = `https://www.cpsc.gov/Recalls/2026/Phase-16-11-Http-${recallNumber}`;
const observationInput = {
  p_api_id: apiId,
  p_recall_number: recallNumber,
  p_observed_url: url,
  p_canonical_url: url,
  p_title: 'Phase 16.11 HTTP fixture recall',
  p_publication_date: '2026-09-25',
  p_payload_hash: 'a'.repeat(64),
  p_observed_at: new Date().toISOString(),
  p_provenance: 'Phase 16.11 HTTP verification',
};
check(
  'worker direct legacy observation is denied',
  denied(await rpc(worker, 'record_cpsc_identity_observation', observationInput)),
);
const observation = ownerLegacyObservationFixture(sql, observationInput);
check(
  'owner fixture creates new canonical identity',
  observation.data?.status === 'created',
  JSON.stringify(observation.data),
);
const notice = await rpc(workerSecret, 'ingest_cpsc_identity_notice', {
  p_observation_id: observation.data.observationId,
  p_description: 'HTTP fixture',
  p_hazard: null,
  p_remedy: null,
  p_retrieved_at: new Date().toISOString(),
  p_raw_payload: { RecallID: apiId, RecallNumber: recallNumber },
  p_scopes: [{ productName: 'HTTP fixture product' }],
});
check(
  'worker (sb_secret key) ingests identity-bound notice',
  notice.data?.status === 'inserted',
  JSON.stringify(notice.data),
);
const noticeId = notice.data.noticeId;
const targets = await rpc(worker, 'get_cpsc_page_fetch_targets', { p_limit: 50 });
const target = targets.data.find((row) => row.official_recall_number === recallNumber);
check(
  'fetch target is authority-derived with sole scope',
  target?.canonical_url === url && target?.sole_scope_id,
);

const evidence = { recallNumber, canonicalUrl: url, title: 'Phase 16.11 HTTP fixture recall' };
const revision = await rpc(worker, 'record_cpsc_page_revision', {
  p_identity_id: target.identity_id,
  p_evidence_hash: 'c'.repeat(64),
  p_normalized_evidence: evidence,
  p_section_hashes: {},
  p_table_identities: [],
  p_parser_version: 'phase-16.11-structured-v1',
});
check(
  'worker records semantic page revision',
  revision.data?.status === 'created',
  JSON.stringify(revision.data),
);
const propose = (credential, kind, value, field) =>
  rpc(credential, 'propose_cpsc_candidate_criterion', {
    p_revision_id: revision.data.revisionId,
    p_proposed_scope_id: target.sole_scope_id,
    p_evidence_address: {
      source: 'cpsc',
      recallNumber,
      canonicalUrl: url,
      sourceSemanticRevision: 'c'.repeat(64),
      sectionIdentity: 'description',
      tableIdentity: 'http-table',
      rowIdentity: 'row-1',
      fieldIdentity: field,
    },
    p_evidence_fingerprint: 'd'.repeat(64),
    p_criterion_kind: kind,
    p_criterion_value: value,
    p_conjunction_key: 'http-table/row-1',
    p_authoritative_excerpt: 'HTTP-MODEL | 2510, 2511',
    p_parser_version: 'phase-16.11-structured-v1',
  });
const model = await propose(worker, 'model_exact', 'HTTP-MODEL', 'model');
const dateCode = await propose(worker, 'date_code_set', ['2510', '2511'], 'date code');
check(
  'worker proposes unreviewed model + date code',
  model.data?.status === 'created' && dateCode.data?.status === 'created',
);
const modelId = model.data.candidateId;
const dateId = dateCode.data.candidateId;

// --- Denials by role.
const decide = (credential, id) =>
  rpc(credential, 'decide_cpsc_candidate', {
    p_candidate_id: id,
    p_decision: 'reviewed',
    p_mandatory_eligibility: true,
    p_review_note: 'HTTP',
  });
check('anon cannot decide', denied(await decide(anon, modelId)));
check(
  'anon cannot read matcher scopes',
  denied(await rpc(anon, 'get_recall_v2_scopes', { p_recall_notice_id: noticeId })),
);
check(
  'anon cannot record observations',
  denied(await rpc(anon, 'get_cpsc_page_fetch_targets', { p_limit: 1 })),
);
check('consumer cannot decide', denied(await decide(consumer.token, modelId)));
check(
  'consumer cannot read review packet',
  denied(
    await rpc(consumer.token, 'get_cpsc_candidate_review_packet', { p_candidate_id: modelId }),
  ),
);
check(
  'consumer cannot read matcher scopes',
  denied(await rpc(consumer.token, 'get_recall_v2_scopes', { p_recall_notice_id: noticeId })),
);
check(
  'consumer cannot propose',
  denied(await propose(consumer.token, 'model_exact', 'X', 'model')),
);
for (const [label, credential] of [
  ['service_role JWT', worker],
  ['sb_secret key', workerSecret],
]) {
  check(`${label} cannot perform human approval`, denied(await decide(credential, modelId)));
  check(
    `${label} cannot materialize`,
    denied(
      await rpc(credential, 'materialize_cpsc_reviewed_conjunction', { p_candidate_id: modelId }),
    ),
  );
  check(
    `${label} cannot use retired free-text approval`,
    denied(
      await rpc(credential, 'approve_cpsc_product_model_criterion_v2', {
        p_scope_id: target.sole_scope_id,
        p_product_index: 0,
        p_reviewer_id: 'automation',
        p_eligibility_statement: 'automated',
        p_source_payload_sha256: 'a'.repeat(64),
      }),
    ),
  );
}
check('revoked reviewer cannot decide', denied(await decide(revoked.token, modelId)));
check(
  'reviewer cannot run worker ingestion',
  denied(await propose(reviewer.token, 'model_exact', 'X', 'model')),
);

// --- Human review over HTTP.
const packet = await rpc(reviewer.token, 'get_cpsc_candidate_review_packet', {
  p_candidate_id: modelId,
});
check(
  'reviewer reads packet with every conjunct',
  packet.status === 200 && packet.data?.allConjuncts?.length === 2,
);
check('reviewer approves model', (await decide(reviewer.token, modelId)).status === 200);
const partial = await rpc(reviewer.token, 'materialize_cpsc_reviewed_conjunction', {
  p_candidate_id: modelId,
});
check(
  'partial conjunction cannot materialize over HTTP',
  partial.status === 400 && /not fully human-reviewed/u.test(partial.data?.message ?? ''),
);
const scopesPartial = await rpc(worker, 'get_recall_v2_scopes', { p_recall_notice_id: noticeId });
check(
  'matcher sees nothing for a partial conjunction',
  scopesPartial.data?.every((row) => row.reviewed_criteria === null),
);
check('reviewer approves date code', (await decide(reviewer.token, dateId)).status === 200);
const materialized = await rpc(reviewer.token, 'materialize_cpsc_reviewed_conjunction', {
  p_candidate_id: dateId,
});
check(
  'reviewer materializes complete conjunction',
  materialized.data?.status === 'materialized',
  JSON.stringify(materialized.data),
);

// --- The real served criterion drives the TypeScript deterministic_v2 contract.
const served = await rpc(worker, 'get_recall_v2_scopes', { p_recall_notice_id: noticeId });
const scopeRow = served.data.find((row) => row.scope_id === target.sole_scope_id);
// Phase 16.12 serves an any_of envelope; this conjunction is its single rule set.
const servedRuleSet = scopeRow?.reviewed_criteria?.ruleSets?.[0];
check(
  'worker matcher RPC serves the ledger conjunction',
  servedRuleSet?.review?.origin === 'human_review_ledger',
);
const recallRow = {
  recall_notice_id: noticeId,
  recall_notice_updated_at: new Date().toISOString(),
  source_authority: 'U.S. Consumer Product Safety Commission (CPSC)',
  source_external_id: `cpsc:${recallNumber}`,
  source_official_url: url,
  source_is_authoritative: true,
  title: 'Phase 16.11 HTTP fixture recall',
  description: null,
  hazard: null,
  remedy: null,
  recall_date: '2026-09-25',
  raw_payload: {},
  scopes: [],
};
const validated = await validateLiveReviewedCriteriaV2(recallRow, scopeRow, servedRuleSet);
const official = projectRecallForProductionV2({ ...recallRow, scopes: [scopeRow] }, [validated]);
const owned = (modelNumber, attributes) =>
  projectOwnedProductForProductionV2({
    owned_product_id: 'p',
    owned_product_updated_at: new Date().toISOString(),
    user_id: consumer.id,
    product_name: 'HTTP fixture product',
    brand: null,
    category: null,
    gtin: null,
    model_number: modelNumber,
    serial_number: null,
    lot_number: null,
    purchase_date: null,
    identification_method: 'manual',
    safety_attributes: attributes,
  });
check(
  'served criterion confirms MODEL AND DATE CODE',
  evaluateProductionPairV2(owned('HTTP-MODEL', { date_code: '2511' }), official).decision ===
    'confirmed',
);
check(
  'served criterion does not confirm a wrong date code',
  evaluateProductionPairV2(owned('HTTP-MODEL', { date_code: '2601' }), official).decision !==
    'confirmed',
);

// --- A material source revision makes it unusable immediately.
const newer = await rpc(worker, 'record_cpsc_page_revision', {
  p_identity_id: target.identity_id,
  p_evidence_hash: 'e'.repeat(64),
  p_normalized_evidence: evidence,
  p_section_hashes: {},
  p_table_identities: [],
  p_parser_version: 'phase-16.11-structured-v1',
});
check('worker records material revision', newer.data?.status === 'created');
const stale = await rpc(worker, 'get_recall_v2_scopes', { p_recall_notice_id: noticeId });
check(
  'stale criterion is no longer served',
  stale.data?.every((row) => row.reviewed_criteria === null),
);

// --- Quarantine reconciliation roles.
const conflict = ownerLegacyObservationFixture(sql, {
  p_api_id: apiId,
  p_recall_number: `8${recallNumber.slice(1)}`,
  p_observed_url: `${url}-Other`,
  p_canonical_url: `${url}-Other`,
  p_title: 'Conflicting claimant',
  p_publication_date: '2026-09-25',
  p_payload_hash: 'f'.repeat(64),
  p_observed_at: new Date().toISOString(),
  p_provenance: 'Phase 16.11 HTTP verification',
});
check(
  'reused API ID quarantines through owner fixture',
  conflict.data?.decisionClass === 'D_api_id_reuse',
);
const reconcile = (credential) =>
  rpc(credential, 'reconcile_cpsc_quarantined_observation', {
    p_observation_id: conflict.data.observationId,
    p_decision: 'reject_observation',
    p_rationale: 'HTTP verification',
  });
check('worker cannot reconcile', denied(await reconcile(worker)));
check('consumer cannot reconcile', denied(await reconcile(consumer.token)));
check('revoked reviewer cannot reconcile', denied(await reconcile(revoked.token)));
check(
  'reviewer reconciles with audit',
  (await reconcile(reviewer.token)).data?.decision === 'reject_observation',
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
