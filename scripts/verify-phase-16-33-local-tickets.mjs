// Phase 16.33, LOCAL ONLY. End-to-end proof of scheduler tickets through the
// real pg_net queue, the local API gateway and both Edge Functions served by
// `supabase functions serve`. v1 automation control stays disabled and the
// fresh local database has no eligible page identity, so no child function,
// CPSC API or CPSC page is contacted. Run after `supabase db reset --local`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';

const status = JSON.parse(
  spawnSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8' }).stdout,
);
for (const value of [status.API_URL, status.DB_URL]) {
  const host = new URL(value.replace(/^postgresql:/u, 'http:')).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('Local stack only.');
}
const db = postgres(status.DB_URL, { max: 1, onnotice: () => {} });
const results = [];
const check = (name, condition, detail) => {
  results.push({ name, ok: Boolean(condition), ...(detail === undefined ? {} : { detail }) });
  assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
};
const OPERATOR = '16339000-0000-4000-8000-00000000e001';

async function waitForServe(url) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.status === 405) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('functions serve did not become ready');
}

async function responseFor(requestId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const [row] = await db`select status_code, content::text as content, error_msg
      from net._http_response where id = ${requestId}`;
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no pg_net response for request ${requestId}`);
}

const password = randomBytes(24).toString('hex');
const dir = mkdtempSync(join(tmpdir(), 'p1633-serve-'));
const envFile = join(dir, 'functions.env');
let serve;
try {
  // Local-only worker login, random per run; the static page key is unset.
  await db.unsafe(`alter role cpsc_page_worker password '${password}'`);
  writeFileSync(
    envFile,
    [
      `CPSC_PAGE_DB_URL=postgresql://cpsc_page_worker:${password}@db:5432/postgres`,
      'RECALL_INGESTION_KEY=local-unused-ingestion',
      'RECALL_MATCHING_KEY=local-unused-matching',
      'RECALL_PUSH_DELIVERY_KEY=local-unused-push',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  serve = spawn('npx', ['supabase', 'functions', 'serve', '--env-file', envFile], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitForServe(`${status.API_URL}/functions/v1/run-recall-automation`);

  // Fixtures: an operator in a live aal2 session, healthy CPSC source state,
  // and the Vault endpoint (URL plus the local publishable key; no static key).
  await db.begin(async (tx) => {
    await tx`insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (${OPERATOR}, 'authenticated', 'authenticated', 'p1633-e2e-operator@example.test',
        '', now(), '{}', '{}', now(), now())`;
    await tx`insert into auth.sessions (id, user_id, aal, created_at, updated_at)
      values (${OPERATOR}, ${OPERATOR}, 'aal2', now(), now())`;
    await tx`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status,
        created_at, updated_at)
      values (${OPERATOR}, ${OPERATOR}, 'e2e TOTP', 'totp', 'verified', now(), now())`;
    await tx`insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at,
        updated_at) values (gen_random_uuid(), ${OPERATOR}, 'totp', now(), now())`;
    await tx`insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason)
      values (${OPERATOR}, 'operational_scheduler_control', now() - interval '1 hour',
        'Phase 16.33 local e2e operator')`;
    await tx`select public.ensure_cpsc_recall_source()`;
    await tx`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`;
    await tx`select public.record_recall_source_sync_result('cpsc', 'success', null, null,
      '{"fetched":0}'::jsonb, now())`;
    await tx`select set_config('request.jwt.claims', '', true)`;
    await tx`select vault.create_secret('http://kong:8000/functions/v1/process-cpsc-page-evidence',
      'cpsc_page_worker_url', 'Phase 16.33 local e2e')`;
    await tx`select vault.create_secret(${status.ANON_KEY}, 'cpsc_page_worker_apikey',
      'Phase 16.33 local e2e')`;
    await tx`select vault.create_secret('http://kong:8000/functions/v1/run-recall-automation',
      'recall_automation_url', 'Phase 16.33 local e2e')`;
  });
  await db.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({
      role: 'authenticated',
      sub: OPERATOR,
      aal: 'aal2',
      session_id: OPERATOR,
    })}, true)`;
    await tx`select public.start_cpsc_page_stage('Phase 16.33 local e2e', 1, 1, 2, 2)`;
  });

  // Page stage: tick -> pg_net -> gateway -> worker -> DB consumption.
  const [{ tick }] = await db`select private.cpsc_page_stage_tick() as tick`;
  check('the page tick dispatches after its policy passes', tick.decision === 'dispatched', tick);
  const [pageTicket] = await db`select id, request_id from private.scheduler_invocation_tickets
    where job = 'cpsc_page_stage' order by ticket_seq desc limit 1`;
  const page = await responseFor(pageTicket.request_id);
  const pageBody = JSON.parse(page.content ?? '{}');
  check(
    'the worker accepts the ticket and runs a DB-bounded cycle (no eligible page)',
    page.status_code === 200 && pageBody.claimed === 0,
    { status: page.status_code, pageBody },
  );
  const [pageConsumed] = await db`select consumer, consumed_at is not null as consumed,
      rejected_attempts from private.scheduler_invocation_tickets where id = ${pageTicket.id}`;
  check(
    'the page ticket was consumed once by the worker',
    pageConsumed.consumed &&
      pageConsumed.consumer === 'process-cpsc-page-evidence' &&
      pageConsumed.rejected_attempts === 0,
    pageConsumed,
  );

  // v1: tick -> pg_net -> gateway -> automation -> DB consumption -> disabled.
  const [{ v1 }] = await db`select private.recall_automation_tick() as v1`;
  const v1Response = await responseFor(v1.requestId);
  const v1Body = JSON.parse(v1Response.content ?? '{}');
  check(
    'the automation accepts the ticket; disabled control stops before any child call',
    v1Response.status_code === 200 && v1Body.status === 'skipped_disabled',
    { status: v1Response.status_code, v1Body },
  );
  const [v1Consumed] = await db`select consumer, consumed_at is not null as consumed
    from private.scheduler_invocation_tickets where request_id = ${v1.requestId}`;
  check(
    'the v1 ticket was consumed once by the automation function',
    v1Consumed.consumed && v1Consumed.consumer === 'run-recall-automation',
    v1Consumed,
  );

  // Forged tickets over HTTP: refused, and nothing is claimed or run.
  const [{ runs: runsBefore }] = await db`select count(*)::int as runs
    from private.recall_automation_runs`;
  for (const [path, header] of [
    ['process-cpsc-page-evidence', 'x-cpsc-page-ticket'],
    ['run-recall-automation', 'x-recall-automation-ticket'],
  ]) {
    const response = await fetch(`${status.API_URL}/functions/v1/${path}`, {
      method: 'POST',
      headers: {
        apikey: status.ANON_KEY,
        authorization: `Bearer ${status.ANON_KEY}`,
        'content-type': 'application/json',
        [header]: randomBytes(32).toString('hex'),
      },
      body: '{"maxPages":10}',
    });
    check(`${path}: a forged ticket is refused`, response.status === 401, response.status);
  }
  const [{ runs: runsAfter }] = await db`select count(*)::int as runs
    from private.recall_automation_runs`;
  const [{ attempts }] = await db`select count(*)::int as attempts from private.cpsc_page_attempts`;
  check(
    'forged tickets created no run and no page attempt',
    runsAfter === runsBefore && attempts === 0,
    { runsBefore, runsAfter, attempts },
  );

  // A stop between issue and delivery: the kill switch wins over the ticket.
  await db`select private.stop_cpsc_page_stage_as_owner('Phase 16.33 local e2e stop')`;
  const [{ stopped }] = await db`select private.cpsc_page_stage_tick() as stopped`;
  check('a stopped stage issues no ticket', stopped.decision === 'skipped', stopped);

  // What pg_net retained: responses only, never a ticket or key.
  const [{ leaked }] = await db`select count(*)::int as leaked from net._http_response
    where content like '%x-cpsc-page-ticket%' or content like '%x-recall-automation-%'`;
  check('pg_net responses hold no ticket header', leaked === 0, { leaked });
  process.stdout.write(
    `${JSON.stringify(
      { checks: results.length, passed: results.filter((r) => r.ok).length, results },
      null,
      2,
    )}\n`,
  );
} finally {
  serve?.kill('SIGINT');
  await db.unsafe('alter role cpsc_page_worker password null').catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  await db.end({ timeout: 1 });
}
