// Real local HTTP proof for Phase 16.13: the source-coverage ledger recorded by
// the production worker path (TS ledger recomputed by SQL; the worker fails closed
// on any fingerprint difference), and the reviewer pending-candidate queue behind
// real GoTrue JWTs and local PostgREST. The frozen Char-Broil, AGA, and Friedrich
// pages are re-keyed to fresh synthetic recall numbers so the script can re-run.
// Local stack only: it refuses any non-loopback URL. It commits fixtures to the
// disposable local database; run `npx supabase db reset --local --yes` afterwards.
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
  const email = `phase1613-${label}-${Date.now()}-${randomInt(1e9)}@example.invalid`;
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
const revoked = await user('revoked');
const reconciler = await user('reconciler');
const invalidator = await user('invalidator');
const consumer = await user('consumer');
sql(`insert into private.cpsc_reviewer_authorizations (user_id, authorized_at, reason) values
  ('${reviewer.id}', now() - interval '1 hour', 'Phase 16.13 local HTTP reviewer'),
  ('${reviewer2.id}', now() - interval '1 hour', 'Phase 16.13 local HTTP reviewer'),
  ('${revoked.id}', now() - interval '1 hour', 'Phase 16.13 local HTTP reviewer');
  insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason) values
  ('${reconciler.id}', 'identity_reconciliation', now() - interval '1 hour', 'Phase 16.13 HTTP'),
  ('${invalidator.id}', 'decision_invalidation', now() - interval '1 hour', 'Phase 16.13 HTTP');
  select public.ensure_cpsc_recall_source();`);

const database = {
  rpc: (name, parameters) =>
    rpc(worker, name, parameters).then((result) =>
      result.status < 300 ? { data: result.data, error: null } : { data: null, error: result.data },
    ),
};

/** A fresh canonical identity whose official page is one frozen page, re-keyed. */
const usedNumbers = new Set(
  sql(
    `select coalesce(string_agg(official_recall_number, ' '), '') from private.cpsc_source_identities;`,
  )
    .split(' ')
    .filter(Boolean),
);
async function ingestFrozen(fixture, displayed) {
  let recallNumber;
  do recallNumber = `9${String(randomInt(10_000)).padStart(4, '0')}`;
  while (usedNumbers.has(recallNumber));
  usedNumbers.add(recallNumber);
  const apiId = String(9_000_000 + randomInt(900_000));
  const slug = `Phase-16-13-Http-${fixture}-${recallNumber}`;
  const url = `https://www.cpsc.gov/Recalls/2026/${slug}`;
  const original = await readFile(
    new URL(`../tests/fixtures/cpsc-pages/${fixture}.html`, import.meta.url),
    'utf8',
  );
  const canonical = /<link rel="canonical" href="([^"]+)"/u.exec(original)[1];
  const html = original
    .replaceAll(canonical, url)
    .replace(displayed, `${recallNumber.slice(0, 2)}-${recallNumber.slice(2)}`);
  const payload = { RecallID: apiId, RecallNumber: recallNumber, Products: [{ Name: fixture }] };
  const observationInput = {
    p_api_id: apiId,
    p_recall_number: recallNumber,
    p_observed_url: url,
    p_canonical_url: url,
    p_title: `Phase 16.13 ${fixture}`,
    p_publication_date: '2026-09-18',
    p_payload_hash: await sourcePayloadSha256(payload),
    p_observed_at: new Date().toISOString(),
    p_provenance: 'Phase 16.13 HTTP verification',
  };
  check(
    'worker direct legacy observation is denied',
    denied(await rpc(worker, 'record_cpsc_identity_observation', observationInput)),
  );
  const observation = ownerLegacyObservationFixture(sql, observationInput);
  const notice = await rpc(workerSecret, 'ingest_cpsc_identity_notice', {
    p_observation_id: observation.data.observationId,
    p_description: fixture,
    p_hazard: 'Hazard',
    p_remedy: 'Refund',
    p_retrieved_at: new Date().toISOString(),
    p_raw_payload: payload,
    p_scopes: [{ productName: fixture }],
  });
  const targets = await rpc(worker, 'get_cpsc_page_fetch_targets', { p_limit: 50 });
  const row = targets.data.find((item) => item.official_recall_number === recallNumber);
  const target = {
    identityId: row.identity_id,
    officialRecallNumber: row.official_recall_number,
    canonicalUrl: row.canonical_url,
    soleScopeId: row.sole_scope_id,
  };
  const ingested = await ingestCpscOfficialPage(
    database,
    target,
    async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
  );
  return { recallNumber, noticeId: notice.data.noticeId, scopeId: row.sole_scope_id, ingested };
}

// --- The worker records a ledger for every page; SQL recomputes it (parity).
const charBroil = await ingestFrozen('char-broil', '26-773');
const aga = await ingestFrozen('aga', '26-756');
const friedrich = await ingestFrozen('friedrich', '26-776');
check(
  'Char-Broil: worker records 18 proposals and a complete ledger accepted by SQL',
  charBroil.ingested.status === 'recorded' &&
    charBroil.ingested.proposalsCreated === 18 &&
    charBroil.ingested.coverage.coverageStatus === 'complete' &&
    charBroil.ingested.coverage.negativeEvidenceEligible === true,
  JSON.stringify(charBroil.ingested.coverage),
);
check(
  'AGA: structural complete, criterion unresolved, no proposal',
  aga.ingested.proposalsCreated === 0 &&
    aga.ingested.coverage.structuralStatus === 'complete' &&
    aga.ingested.coverage.criterionStatus === 'unresolved' &&
    aga.ingested.coverage.positiveStatus === 'blocked',
  JSON.stringify(aga.ingested.coverage),
);
check(
  'Friedrich: unresolved and blocked, no proposal',
  friedrich.ingested.proposalsCreated === 0 &&
    friedrich.ingested.coverage.coverageStatus === 'unresolved' &&
    friedrich.ingested.coverage.positiveStatus === 'blocked',
  JSON.stringify(friedrich.ingested.coverage),
);
const ledgerRows = JSON.parse(
  sql(`select json_agg(json_build_object('revision', revision_id, 'authoritative', authoritative_records,
      'accounted', accounted_records, 'counts', summary->'dispositionCounts') order by recorded_seq)
    from private.cpsc_page_coverage_ledgers where revision_id in (${[charBroil, aga, friedrich]
      .map((item) => literal(item.ingested.revisionId))
      .join(',')});`),
);
check(
  'three ledgers persisted; every record accounted for',
  ledgerRows.length === 3 && ledgerRows.every((row) => row.authoritative === row.accounted),
  JSON.stringify(ledgerRows),
);
check(
  'Char-Broil ledger: 9 reviewable rows + 1 governing restriction; AGA: 6 deferred rows',
  ledgerRows[0].counts.parsed_reviewable === 10 && ledgerRows[1].counts.parsed_deferred === 6,
  JSON.stringify(ledgerRows.map((row) => row.counts)),
);
const replay = await ingestCpscOfficialPage(
  database,
  {
    identityId: sql(
      `select identity_id from private.cpsc_page_revisions where id = ${literal(charBroil.ingested.revisionId)};`,
    ),
    officialRecallNumber: charBroil.recallNumber,
    canonicalUrl: `https://www.cpsc.gov/Recalls/2026/Phase-16-13-Http-char-broil-${charBroil.recallNumber}`,
    soleScopeId: charBroil.scopeId,
  },
  async () =>
    new Response(
      (
        await readFile(
          new URL('../tests/fixtures/cpsc-pages/char-broil.html', import.meta.url),
          'utf8',
        )
      )
        .replaceAll(
          'https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock',
          `https://www.cpsc.gov/Recalls/2026/Phase-16-13-Http-char-broil-${charBroil.recallNumber}`,
        )
        .replace(
          '26-773',
          `${charBroil.recallNumber.slice(0, 2)}-${charBroil.recallNumber.slice(2)}`,
        ),
      { status: 200, headers: { 'content-type': 'text/html' } },
    ),
);
check(
  're-fetching the same page is idempotent (no new ledger, no new proposal)',
  replay.revisionStatus === 'unchanged' &&
    replay.proposalsCreated === 0 &&
    sql(
      `select count(*) from private.cpsc_page_coverage_ledgers where revision_id = ${literal(charBroil.ingested.revisionId)};`,
    ) === '1',
);

// --- Ledger RPC authorization.
const ledgerCall = (credential) =>
  rpc(credential, 'record_cpsc_page_coverage', {
    p_revision_id: charBroil.ingested.revisionId,
    p_ledger: {},
  });
for (const [label, credential] of [
  ['anon', anon],
  ['consumer', consumer.token],
  ['reviewer', reviewer.token],
]) {
  check(`${label} cannot record a coverage ledger`, denied(await ledgerCall(credential)));
}

// --- Reviewer queue authorization.
const queue = (credential, size = 50, cursor = null) =>
  rpc(credential, 'list_cpsc_pending_review_candidates', { p_page_size: size, p_cursor: cursor });
for (const [label, credential] of [
  ['anon', anon],
  ['consumer', consumer.token],
  ['service_role JWT', worker],
  ['sb_secret key', workerSecret],
  ['reconciler', reconciler.token],
  ['invalidator', invalidator.token],
]) {
  check(`${label} cannot list review candidates`, denied(await queue(credential)));
}
const allowed = await queue(reviewer.token);
check(
  'authorized reviewer lists review candidates',
  allowed.status === 200 && Array.isArray(allowed.data?.items),
);
sql(
  `update private.cpsc_reviewer_authorizations set revoked_at = now() where user_id = '${revoked.id}';`,
);
check('revoked reviewer cannot list review candidates', denied(await queue(revoked.token)));

// --- Bounds and pagination.
const tooLarge = await queue(reviewer.token, 51);
check(
  'page size above 50 is refused',
  tooLarge.status >= 400 && /between 1 and 50/u.test(JSON.stringify(tooLarge.data)),
);
const badCursor = await queue(reviewer.token, 10, "x' or 1=1 --");
check('a malformed cursor is refused', badCursor.status >= 400);
const empty = await queue(reviewer.token, 10, '99999|999999999999|~|~');
check(
  'a cursor past the end returns an empty final page',
  empty.status === 200 &&
    empty.data.items.length === 0 &&
    !empty.data.hasMore &&
    empty.data.nextCursor === null,
);
async function allPages(credential, size) {
  const items = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await queue(credential, size, cursor);
    if (page.status !== 200) throw new Error(JSON.stringify(page.data));
    if (page.data.items.length > size) throw new Error('page exceeded its bound');
    items.push(...page.data.items);
    cursor = page.data.nextCursor;
    pages += 1;
  } while (cursor && pages < 1000);
  return { items, pages };
}
const paged = await allPages(reviewer.token, 4);
const sortKeys = paged.items.map((item) => item.sortKey);
check(
  'multi-page traversal: no duplicate across pages',
  new Set(sortKeys).size === sortKeys.length,
);
check(
  'multi-page traversal: strictly increasing deterministic order',
  sortKeys.every(
    (key, index) =>
      index === 0 || Buffer.compare(Buffer.from(sortKeys[index - 1]), Buffer.from(key)) < 0,
  ),
);
const single = await allPages(reviewer.token, 50);
check(
  'page size does not change the result set',
  JSON.stringify(single.items.map((item) => item.sortKey)) === JSON.stringify(sortKeys),
);

// --- Multi-rule presentation: 9 separate row associations, never a flattened bag.
const mine = paged.items.filter((item) => item.recallNumber === charBroil.recallNumber);
const models = [
  '25302145',
  '25302146',
  '25302147',
  '25302148',
  '25302149',
  '25302150',
  '25302151',
  '25302159',
  '25302163',
];
check('Char-Broil: the queue shows 9 separate rule sets', mine.length === 9, `${mine.length}`);
check(
  'each rule set is exactly one model AND the date-code set, in document order',
  mine.every(
    (item, index) =>
      item.ruleSetNumber === index + 1 &&
      item.ruleSetCount === 9 &&
      item.insideRuleSet === 'AND' &&
      item.semantics === 'OR between rule sets; AND inside each rule set' &&
      item.members.length === 2 &&
      item.members[0].kind === 'model_exact' &&
      item.members[0].value === models[index] &&
      JSON.stringify(item.members[1].value) === JSON.stringify(['2510', '2511', '2512']) &&
      item.criterionPreview ===
        `model_number equals "${models[index]}" AND date_code one of ["2510", "2511", "2512"]`,
  ),
  JSON.stringify(mine.map((item) => item.criterionPreview)),
);
check(
  'items carry recall, URL, source revision, evidence location, and parser coverage',
  mine.every(
    (item) =>
      item.officialUrl.endsWith(charBroil.recallNumber) &&
      /^[0-9a-f]{64}$/u.test(item.sourceRevision) &&
      item.evidenceLocation.tableIdentity?.startsWith('description/table/0/') &&
      /^[0-9a-f]{64}$/u.test(item.evidenceLocation.rowIdentity) &&
      item.parserCoverage.coverageStatus === 'complete' &&
      item.parserCoverage.state === 'recorded',
  ),
);
const itemText = JSON.stringify(paged.items);
check(
  'queue exposes no owned-product, user, or secret data',
  !/owned|user_?id|email|serial_number|purchase|secret|reviewerId|attestation/iu.test(itemText) &&
    ![reviewer.id, reviewer2.id, consumer.id].some((id) => itemText.includes(id)),
);
check(
  'AGA and Friedrich produce no reviewable items',
  !paged.items.some((item) =>
    [aga.recallNumber, friedrich.recallNumber].includes(item.recallNumber),
  ),
);

// --- Decide and materialize every Char-Broil rule set over HTTP.
const decide = (credential, id) =>
  rpc(credential, 'decide_cpsc_candidate', {
    p_candidate_id: id,
    p_decision: 'reviewed',
    p_mandatory_eligibility: true,
    p_review_note: 'Phase 16.13 HTTP',
  });
const eventIds = new Map();
for (const item of mine) {
  for (const member of item.members) {
    const decided = await decide(reviewer.token, member.candidateId);
    eventIds.set(member.candidateId, decided.data);
  }
  await rpc(reviewer.token, 'materialize_cpsc_reviewed_conjunction', {
    p_candidate_id: item.members[0].candidateId,
  });
}
const afterReview = (await allPages(reviewer.token, 50)).items.filter(
  (item) => item.recallNumber === charBroil.recallNumber,
);
check('decided rule sets leave the queue', afterReview.length === 0);

async function served() {
  const scopes = await rpc(worker, 'get_recall_v2_scopes', {
    p_recall_notice_id: charBroil.noticeId,
  });
  const scopeRow = scopes.data.find((row) => row.scope_id === charBroil.scopeId);
  const envelope = scopeRow.reviewed_criteria;
  const recall = {
    recall_notice_id: charBroil.noticeId,
    recall_notice_updated_at: new Date().toISOString(),
    source_authority: 'U.S. Consumer Product Safety Commission (CPSC)',
    source_external_id: `cpsc:${charBroil.recallNumber}`,
    source_official_url: `https://www.cpsc.gov/Recalls/2026/Phase-16-13-Http-char-broil-${charBroil.recallNumber}`,
    source_is_authoritative: true,
    title: 'Phase 16.13 char-broil',
    description: null,
    hazard: null,
    remedy: null,
    recall_date: '2026-09-18',
    raw_payload: {},
    scopes: [],
  };
  const scope = { scope_id: charBroil.scopeId, product_name: 'char-broil', model_number: null };
  const validated = await validateLiveRuleSetEnvelopeV2(recall, scope, envelope);
  const projection = projectRecallRuleSetsForProductionV2({ ...recall, scopes: [scope] }, [
    validated,
  ]);
  const owned = (model, code) =>
    projectOwnedProductForProductionV2({
      owned_product_id: 'owned',
      owned_product_updated_at: '2026-09-26T10:00:00Z',
      user_id: 'user',
      product_name: 'Grill',
      brand: null,
      category: null,
      gtin: null,
      model_number: model,
      serial_number: null,
      lot_number: null,
      purchase_date: null,
      identification_method: 'manual',
      safety_attributes: code ? { date_code: code } : {},
    });
  return {
    envelope,
    validated,
    decide: (model, code) => evaluateRuleSetsPairV2(owned(model, code), projection).decision,
  };
}
const full = await served();
check(
  'PostgREST serves 9 rule sets with complete coverage and a complete source ledger',
  full.envelope.ruleSets.length === 9 &&
    full.envelope.coverage.complete === true &&
    full.envelope.coverage.sourceCoverage.coverageStatus === 'complete' &&
    full.validated.coverageComplete === true,
);
check(
  'complete proof: listed rows confirm, an unlisted code is safely rejected',
  models.every((model) => full.decide(model, '2511') === 'confirmed') &&
    full.decide('25302145', '2509') === 'rejected',
);

// --- Revoke-for-cause regression: invalidation re-queues and withholds rejection.
const target = mine[4];
const dateEvent = eventIds.get(target.members[1].candidateId);
check(
  'reviewer cannot revoke for cause',
  denied(
    await rpc(reviewer.token, 'invalidate_cpsc_review_decision', {
      p_review_event_id: dateEvent,
      p_reason: 'x',
    }),
  ),
);
check(
  'service role cannot revoke for cause',
  denied(
    await rpc(worker, 'invalidate_cpsc_review_decision', {
      p_review_event_id: dateEvent,
      p_reason: 'x',
    }),
  ),
);
const revokedDecision = await rpc(invalidator.token, 'invalidate_cpsc_review_decision', {
  p_review_event_id: dateEvent,
  p_reason: 'Phase 16.13 HTTP for-cause invalidation',
});
check(
  'invalidator revokes one decision for cause',
  revokedDecision.status === 200,
  JSON.stringify(revokedDecision.data),
);
const requeued = (await allPages(reviewer2.token, 50)).items.filter(
  (item) => item.recallNumber === charBroil.recallNumber,
);
check(
  'the revoked rule set is back in the queue with one pending member',
  requeued.length === 1 &&
    requeued[0].ruleSetNumber === 5 &&
    requeued[0].pendingMembers === 1 &&
    requeued[0].members[1].latestDecisionInvalidated === true,
);
const partial = await served();
check(
  '8 rule sets serve; coverage incomplete; the revoked row is withheld, not rejected',
  partial.envelope.ruleSets.length === 8 &&
    partial.envelope.coverage.complete === false &&
    partial.decide(models[4], '2510') === 'needs_review' &&
    partial.decide(models[0], '2510') === 'confirmed',
);
check(
  'the invalidated reviewer cannot replace their own decision',
  (await decide(reviewer.token, target.members[1].candidateId)).status >= 400,
);
check(
  'append-only audit: the invalidated ledger event is retained',
  sql(
    `select count(*) from private.cpsc_candidate_review_ledger where id = ${literal(dateEvent)};`,
  ) === '1',
);

const passed = checks.filter((item) => item.ok).length;
console.log(
  JSON.stringify(
    {
      checksPassed: passed,
      checksTotal: checks.length,
      recallNumbers: {
        charBroil: charBroil.recallNumber,
        aga: aga.recallNumber,
        friedrich: friedrich.recallNumber,
      },
      coverage: {
        charBroil: charBroil.ingested.coverage,
        aga: aga.ingested.coverage,
        friedrich: friedrich.ingested.coverage,
      },
      queue: { pagesAtSize4: paged.pages, items: paged.items.length },
    },
    null,
    2,
  ),
);
process.exit(passed === checks.length ? 0 : 1);
