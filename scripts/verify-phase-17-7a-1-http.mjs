// Real local HTTP proof for Phase 17.7a-1: check-owned-product behind real GoTrue
// JWTs, the admin worker behind its key, and the owner-only monitoring read model
// through local PostgREST. Requires `npx supabase functions serve` with a local
// RECALL_MATCHING_KEY (pass the same value in RECALL_MATCHING_KEY here).
// Local stack only: it refuses any non-loopback URL. It commits fixtures to the
// disposable local database; run `npx supabase db reset --local --no-seed` afterwards.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const status = JSON.parse(
  spawnSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8' }).stdout,
);
for (const value of [status.API_URL, status.DB_URL]) {
  const host = new URL(value.replace(/^postgresql:/u, 'http:')).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('Local stack only.');
}
const api = status.API_URL;
const matchingKey = process.env.RECALL_MATCHING_KEY;
if (!matchingKey) throw new Error('Set RECALL_MATCHING_KEY to the value served to the functions.');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
};
const sql = (query) => {
  const result = spawnSync('psql', [status.DB_URL, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
    input: query,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

async function signUp(label) {
  const response = await fetch(`${api}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: status.ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `p17-${label}-${randomUUID()}@example.invalid`,
      password: `P17-${randomUUID()}`,
    }),
  });
  const body = await response.json();
  if (!body.access_token || !body.user?.id) throw new Error(`signup failed: ${response.status}`);
  return { token: body.access_token, id: body.user.id };
}

async function checkProduct(productId, authorization) {
  const response = await fetch(`${api}/functions/v1/check-owned-product`, {
    method: 'POST',
    headers: {
      apikey: status.ANON_KEY,
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ ownedProductId: productId }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function worker(key, body = {}) {
  const response = await fetch(`${api}/functions/v1/process-owned-product-checks`, {
    method: 'POST',
    headers: {
      apikey: status.ANON_KEY,
      'content-type': 'application/json',
      ...(key ? { 'x-recall-matching-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const a = await signUp('a');
const b = await signUp('b');
const suffix = randomUUID().slice(0, 8);
const notice = randomUUID();
const [productA, productACanada, productB] = [randomUUID(), randomUUID(), randomUUID()];

// An official US notice whose only structured scope is a recall-level GTIN, like
// production notice 8877; no reviewed v2 rule set exists for it.
sql(`
insert into public.recall_sources (source_key, name, jurisdiction, base_url, is_authoritative)
values ('p17_http_${suffix}', 'P17 HTTP US authority ${suffix}', 'US', 'https://p17-${suffix}.example.gov', true);
insert into public.recall_notices (id, source_id, external_id, title, recall_date, official_url,
  retrieved_at, raw_payload)
select '${notice}', id, 'p17-http-${suffix}', 'Stroller recall ${suffix}', date '2020-08-12',
  'https://p17-${suffix}.example.gov/recall', now(), '{}'::jsonb
from public.recall_sources where source_key = 'p17_http_${suffix}';
insert into public.recall_scopes (recall_notice_id, gtin, additional_criteria)
values ('${notice}', '091021037090',
  '{"association":"recall-level","evidence_level":"recall"}');
insert into public.recall_notice_jurisdictions (recall_notice_id, jurisdiction_type, jurisdiction_code)
values ('${notice}', 'country', 'US');
insert into public.owned_products (id, user_id, product_name, gtin, purchase_country_code) values
  ('${productA}', '${a.id}', 'Sleek stroller', '091021037090', 'US'),
  ('${productACanada}', '${a.id}', 'Sleek stroller (Canada)', '091021037090', 'CA'),
  ('${productB}', '${b.id}', 'Sleek stroller', '091021037090', 'US');
update private.recall_automation_control set product_check_enabled = true where singleton;
`);

check(
  'trigger armed one pending job per new product',
  sql(`select count(*) from private.owned_product_recall_checks
    where owned_product_id in ('${productA}','${productACanada}','${productB}')
      and status = 'pending'`) === '3',
);

const noJwt = await checkProduct(productA, null);
check('no JWT -> 401', noJwt.status === 401, JSON.stringify(noJwt));
const serviceAsUser = await checkProduct(productA, `Bearer ${status.SERVICE_ROLE_KEY}`);
check(
  'service-role JWT is not a user -> 401',
  serviceAsUser.status === 401,
  JSON.stringify(serviceAsUser),
);
const anonAsUser = await checkProduct(productA, `Bearer ${status.ANON_KEY}`);
check('anon JWT is not a user -> 401', anonAsUser.status === 401, JSON.stringify(anonAsUser));

const foreign = await checkProduct(productB, `Bearer ${a.token}`);
check(
  "another user's product -> 404 without detail",
  foreign.status === 404 && JSON.stringify(foreign.body) === '{"error":"Product not found."}',
  JSON.stringify(foreign),
);
const missing = await checkProduct(randomUUID(), `Bearer ${a.token}`);
check('a missing product -> identical 404', missing.status === 404, JSON.stringify(missing));

const own = await checkProduct(productA, `Bearer ${a.token}`);
check(
  'own product: GTIN candidate without proven scope -> possible match, no alert',
  own.status === 200 &&
    own.body?.state === 'possible_match_needs_verification' &&
    own.body.possibleMatches === 1 &&
    own.body.confirmedAlerts === 0 &&
    own.body.retrying === false,
  JSON.stringify(own),
);
check(
  'response carries only the bounded state fields',
  JSON.stringify(Object.keys(own.body ?? {}).sort()) ===
    JSON.stringify(['checkedAt', 'confirmedAlerts', 'possibleMatches', 'retrying', 'state']),
);
check(
  'the persisted v2 evaluation is a withheld needs_review',
  sql(`select status || '|' || (reasoning_summary like '%unsupported_scope%')
    from private.recall_match_evaluations_v2 where owned_product_id = '${productA}'`) ===
    'needs_review|true',
);

const again = await checkProduct(productA, `Bearer ${a.token}`);
check(
  'a second request does no new work (idempotent)',
  again.status === 200 &&
    again.body?.state === 'possible_match_needs_verification' &&
    sql(`select count(*) from private.recall_match_evaluations_v2
      where owned_product_id = '${productA}'`) === '1',
  JSON.stringify(again),
);

const canada = await checkProduct(productACanada, `Bearer ${a.token}`);
check(
  'incompatible jurisdiction -> possible match, never an alert',
  canada.status === 200 &&
    canada.body?.state === 'possible_match_needs_verification' &&
    canada.body.confirmedAlerts === 0 &&
    sql(`select reasoning_summary like '%jurisdiction_mismatch%'
      from private.recall_match_evaluations_v2 where owned_product_id = '${productACanada}'`) ===
      't',
  JSON.stringify(canada),
);

const states = await fetch(`${api}/rest/v1/rpc/get_my_product_monitoring_states`, {
  method: 'POST',
  headers: {
    apikey: status.ANON_KEY,
    authorization: `Bearer ${a.token}`,
    'content-type': 'application/json',
  },
  body: '{}',
}).then((response) => response.json());
check(
  'the owner-only read model returns exactly the caller products',
  Array.isArray(states) &&
    states.length === 2 &&
    states.every((row) => [productA, productACanada].includes(row.owned_product_id)),
  JSON.stringify(states),
);
const anonStates = await fetch(`${api}/rest/v1/rpc/get_my_product_monitoring_states`, {
  method: 'POST',
  headers: { apikey: status.ANON_KEY, 'content-type': 'application/json' },
  body: '{}',
});
check('anon cannot read monitoring states', anonStates.status === 401 || anonStates.status === 403);

const noKey = await worker(null);
check('worker without key -> 401', noKey.status === 401, JSON.stringify(noKey));
const drained = await worker(matchingKey, { maxProducts: 5 });
check(
  'worker processes the remaining due job with zero AI calls',
  drained.status === 200 &&
    drained.body?.claimed >= 1 &&
    drained.body.aiCalls === 0 &&
    sql(`select status from private.owned_product_recall_checks
      where owned_product_id = '${productB}'`) === 'complete',
  JSON.stringify(drained),
);

check(
  'nothing was written to v1 matches/alerts, no v2 alert, no push queued',
  sql(`select (select count(*) from public.recall_matches)
    + (select count(*) from public.alerts)
    + (select count(*) from private.recall_alert_snapshots_v2)
    + (select count(*) from private.push_alert_queue)`) === '0',
);

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
