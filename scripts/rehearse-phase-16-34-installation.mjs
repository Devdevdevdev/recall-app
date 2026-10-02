// Phase 16.34, LOCAL ONLY. Rehearses the gated production installation in its
// intended order on the local stack and checks every intermediate state:
//
//   S0  production-equivalent: 29 migrations, Phase 12 job 2 (static key),
//       deployed function bytes
//   S1  + 16.32 migration            S2  + 16.33 migration (Gate A, DB part)
//   S2x mixed-version failure drill: ticket command with the OLD automation,
//       then recovery to the Phase 12 command
//   S3a + release process-recall-matches (old automation)
//   S3b + release run-recall-automation (Gate A complete; B verification)
//   S4  Gate C cutover to tickets    S5  Gate D verification probes
//   S6  Gate E key retirement        S7  Gate F staged migration + key unset
//
// v1 is exercised end to end: the job's own command is executed exactly as
// pg_cron would run it, through the real pg_net, the local gateway and the
// served functions. Ingestion (unchanged by the installation) is a contract
// stub, so no external source is contacted; AI and push are disabled locally.
//
// Usage: node scripts/rehearse-phase-16-34-installation.mjs <deployed-root> <release-dir>
// Leaves the local database in a rehearsal state: reset it afterwards.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import postgres from 'postgres';

const [deployedRoot, releaseDir] = process.argv.slice(2);
if (!deployedRoot || !releaseDir) throw new Error('usage: <deployed-root> <release-dir>');
const PRODUCTION = {
  migrationFingerprint: '55e234ef8df694953c659c6297afa1b9',
  job2CommandMd5: '07549bf985a3034a5ef9c645692097b6',
  lastMigration: '20260929110000',
};
const results = [];
const check = (state, name, condition, detail) => {
  results.push({
    state,
    name,
    ok: Boolean(condition),
    ...(detail === undefined ? {} : { detail }),
  });
  process.stderr.write(`${condition ? 'PASS' : 'FAIL'} [${state}] ${name}\n`);
  assert.ok(condition, `[${state}] ${name}: ${JSON.stringify(detail)}`);
};
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};
const status = () => JSON.parse(run('npx', ['supabase', 'status', '-o', 'json']));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Served function trees.
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'p1634-rehearsal-'));
function tree(name, overlayRelease) {
  const dir = join(work, name);
  mkdirSync(join(dir, 'supabase'), { recursive: true });
  // Serve only the four functions of the v1 path; other declared functions have
  // divergent shared copies in production and are not part of this rehearsal.
  const served = new Set([
    'run-recall-automation',
    'ingest-recall-sources',
    'process-recall-matches',
    'send-recall-notifications',
  ]);
  const config = readFileSync('supabase/config.toml', 'utf8').split('\n');
  const kept = [];
  let skip = false;
  for (const line of config) {
    const header = /^\[functions\.([a-z0-9-]+)\]/u.exec(line);
    if (header) skip = !served.has(header[1]);
    else if (/^\[/u.test(line)) skip = false;
    if (!skip) kept.push(line);
  }
  writeFileSync(join(dir, 'supabase/config.toml'), kept.join('\n'));
  for (const slug of [
    'run-recall-automation',
    'ingest-recall-sources',
    'process-recall-matches',
    'send-recall-notifications',
  ]) {
    cpSync(join(deployedRoot, slug, 'supabase/functions'), join(dir, 'supabase/functions'), {
      recursive: true,
    });
  }
  // Type-only modules are erased from deployed bundles but must exist to serve.
  // Any relative import missing from a deployed tree is type-only by
  // construction (otherwise the bundle would contain it); the committed (HEAD)
  // version stands in, and it is runtime-inert.
  closeTypeImports(dir);
  writeFileSync(join(dir, 'supabase/functions/ingest-recall-sources/index.ts'), INGESTION_STUB);
  if (overlayRelease) {
    const manifest = JSON.parse(readFileSync(join(releaseDir, 'MANIFEST.json'), 'utf8'));
    const slugs =
      overlayRelease === 'both'
        ? ['process-recall-matches', 'run-recall-automation']
        : [overlayRelease];
    const wanted = new Set(slugs.flatMap((slug) => manifest.functions[slug]));
    for (const rel of Object.keys(manifest.files)) {
      if (!wanted.has(rel) && !manifest.files[rel].kind.startsWith('type-only')) continue;
      cpSync(join(releaseDir, rel), join(dir, rel));
    }
  }
  return dir;
}
function closeTypeImports(dir) {
  const root = join(dir, 'supabase/functions');
  for (let changed = true; changed;) {
    changed = false;
    const pending = [];
    const walk = (folder) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.ts')) pending.push(path);
      }
    };
    walk(root);
    for (const file of pending) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '(\.{1,2}\/[^']+\.ts)'/gu)) {
        const target = resolve(dirname(file), match[1]);
        if (existsSync(target)) continue;
        const rel = relative(dir, target);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, run('git', ['show', `HEAD:${rel}`]));
        changed = true;
      }
    }
  }
}
// The installation does not change ingestion, and the deployed ingestion chain
// (ingest-recall-sources -> ingest-recall-source) bundles divergent copies of
// shared modules that cannot share one local edge runtime. A contract stub
// stands in: it enforces the real child key and returns a valid summary with
// no affected recalls; pending work is seeded in the database instead.
const INGESTION_STUB = `const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
Deno.serve(async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Only POST is allowed.' });
  const expected = Deno.env.get('RECALL_INGESTION_KEY');
  if (!expected || request.headers.get('x-recall-ingestion-key') !== expected) {
    return json(401, { error: 'Unauthorized.' });
  }
  await request.json();
  return json(200, {
    stats: { fetched: 0, inserted: 0, updated: 0, unchanged: 0, rejected: 0 },
    affectedRecallIds: [], sourceFailures: 0, successfulSources: 2,
    sources: [{ sourceKey: 'cpsc', status: 'success' }, { sourceKey: 'health_canada', status: 'success' }],
  });
});
`;
let serveProcess = null;
async function serve(dir, env) {
  await stopServe();
  const envFile = join(work, 'functions.env');
  writeFileSync(
    envFile,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
    { mode: 0o600 },
  );
  const logFd = openSync(join(work, 'serve.log'), 'w');
  serveProcess = spawn(
    'npx',
    ['supabase', 'functions', 'serve', '--workdir', dir, '--env-file', envFile],
    { stdio: ['ignore', logFd, logFd], detached: true },
  );
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`${API}/functions/v1/run-recall-automation`);
      if (response.status === 405) return;
    } catch {
      // not ready
    }
    await sleep(1000);
  }
  const log = readFileSync(join(work, 'serve.log'), 'utf8')
    .split('\n')
    .filter((line) => !/key|secret|password/iu.test(line))
    .slice(-15)
    .join('\n');
  throw new Error(`functions serve did not start:\n${log}`);
}
async function stopServe() {
  if (!serveProcess) return;
  try {
    process.kill(-serveProcess.pid, 'SIGINT');
  } catch {
    // already gone
  }
  serveProcess = null;
  for (let i = 0; i < 60; i += 1) {
    const names = run('docker', ['ps', '--format', '{{.Names}}']);
    if (!names.includes('edge_runtime')) return;
    await sleep(1000);
  }
  throw new Error('edge runtime did not stop');
}

// ---------------------------------------------------------------------------
// Database helpers.
// ---------------------------------------------------------------------------
let API;
let db;
const one = async (query, params = []) => (await db.unsafe(query, params))[0];
async function fireJob2() {
  // Exactly what pg_cron executes: the stored command of job 2.
  const { command } = await one(`select command from cron.job
    where jobname = 'recall-automation-every-6h'`);
  const [{ max: before }] = await db`select coalesce(max(started_at)::text, '-infinity') as max
    from private.recall_automation_runs`;
  const row = await one(command);
  const requestId = Number(row.request_id ?? row.recall_automation_tick?.requestId);
  let response = null;
  for (let i = 0; i < 120 && !response; i += 1) {
    response = await one(
      'select status_code, timed_out, content from net._http_response where id = $1',
      [requestId],
    );
    if (!response) await sleep(1000);
  }
  // A run can outlive the 30 s pg_net timeout; wait for the run itself.
  let runRow = null;
  for (let i = 0; i < 180; i += 1) {
    runRow = await one(
      `select id, status, error_step, error_code, completed_at is not null as done
      from private.recall_automation_runs where started_at > $1::text::timestamptz
      order by started_at desc limit 1`,
      [before],
    );
    if (!runRow || runRow.done) break;
    await sleep(1000);
  }
  return { requestId, response, run: runRow };
}
const healthyRun = (fired) =>
  fired.run?.done &&
  (fired.run.status === 'success' ||
    (fired.run.status === 'partial_success' && fired.run.error_code === 'source_partial_failure'));
const watermark = async () =>
  (
    await one(`select last_successful_watermark::text as w
  from private.recall_automation_state`)
  ).w;
const job2 = async () =>
  one(`select jobid, schedule, active, md5(command) as md5, command
  from cron.job where jobname = 'recall-automation-every-6h'`);

async function main() {
  // S0: production-equivalent database.
  run('npx', [
    'supabase',
    'db',
    'reset',
    '--local',
    '--no-seed',
    '--version',
    PRODUCTION.lastMigration,
  ]);
  const local = status();
  API = local.API_URL;
  db = postgres(local.DB_URL, { max: 2, onnotice: () => {} });
  const fp = await one(`select count(*)::int as n, md5(string_agg(version || coalesce(name, ''), ','
    order by version)) as fp from supabase_migrations.schema_migrations`);
  check(
    'S0',
    'local migration history equals production (29, same fingerprint)',
    fp.n === 29 && fp.fp === PRODUCTION.migrationFingerprint,
    fp,
  );
  const keys = { automation: randomBytes(32).toString('hex') };
  const baseEnv = {
    RECALL_AUTOMATION_KEY: keys.automation,
    RECALL_INGESTION_KEY: randomBytes(32).toString('hex'),
    RECALL_MATCHING_KEY: randomBytes(32).toString('hex'),
    RECALL_PUSH_DELIVERY_KEY: randomBytes(32).toString('hex'),
  };
  const [{ source }] = await db`select public.ensure_cpsc_recall_source() as source`;
  // Three local recall notices (no owned product anywhere) to carry pending work.
  for (const number of ['93401', '93402', '93403']) {
    await db`insert into public.recall_notices (source_id, external_id, title, description, hazard,
        remedy, recall_date, official_url, retrieved_at, raw_payload)
      values (${source}, ${`cpsc:${number}`}, ${`Rehearsal ${number}`}, 'Description.', 'Hazard.',
        'Refund.', '2026-09-20', ${`https://www.cpsc.gov/Recalls/2026/P1634-${number}`}, now(),
        ${db.json({ RecallNumber: number })})`;
  }
  await db`update private.recall_automation_control
    set enabled = true, ai_enabled = false, push_enabled = false, updated_at = now()`;
  await db`select vault.create_secret('http://kong:8000/functions/v1/run-recall-automation',
    'recall_automation_url', 'Phase 16.34 rehearsal')`;
  await db`select vault.create_secret(${keys.automation}, 'recall_automation_key',
    'Phase 16.34 rehearsal')`;
  await db`select private.install_recall_automation_cron()`;
  const s0Job = await job2();
  check(
    'S0',
    'the Phase 12 installer reproduces production job 2 byte-for-byte (command MD5)',
    s0Job.md5 === PRODUCTION.job2CommandMd5 && s0Job.schedule === '17 */6 * * *',
    {
      md5: s0Job.md5,
      schedule: s0Job.schedule,
    },
  );
  await serve(tree('prod', null), baseEnv);
  const s0 = await fireJob2();
  check('S0', 'deployed v1 runs from the job 2 command (static key)', healthyRun(s0), s0.run);
  const w0 = await watermark();

  // S1: 16.32 migration only (applied as db push would, then recorded).
  const m32 = 'supabase/migrations/20260930120000_phase_16_32_page_stage_operational_control.sql';
  run('psql', [local.DB_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', m32]);
  await db`insert into supabase_migrations.schema_migrations (version, name)
    values ('20260930120000', 'phase_16_32_page_stage_operational_control')`;
  check(
    'S1',
    'page stage installs stopped with no job',
    (await one(`select private.cpsc_page_stage_control_state(now())->>'state' as s`)).s ===
      'never_started' &&
      (
        await one(`select count(*)::int as n from cron.job
        where jobname = 'cpsc-page-evidence-shadow'`)
      ).n === 0,
  );
  const s1 = await fireJob2();
  check('S1', 'v1 unchanged after 16.32 (deployed code, static key)', healthyRun(s1), s1.run);

  // S2: 16.33 through the CLI (the Gate A database state).
  run('npx', ['supabase', 'migration', 'up', '--local']);
  check(
    'S2',
    'both migrations recorded; job 2 untouched',
    (await one(`select count(*)::int as n from supabase_migrations.schema_migrations`)).n === 31 &&
      (await job2()).md5 === PRODUCTION.job2CommandMd5,
  );
  await db`insert into private.recall_automation_pending_recalls (recall_notice_id)
    select id from public.recall_notices where external_id like 'cpsc:934%'
    on conflict do nothing`;
  check(
    'S2',
    'three recalls are pending before the run',
    (await one('select count(*)::int as n from private.recall_automation_pending_recalls')).n === 3,
  );
  const s2 = await fireJob2();
  check(
    'S2',
    'deployed (pre-16.33) v1 still runs on the 16.33 schema; old RPC path acknowledges',
    healthyRun(s2) &&
      (
        await one(`select count(*)::int as n
      from private.recall_automation_pending_recalls`)
      ).n === 0 &&
      (await one(`select count(*)::int as n from private.recall_automation_matching_outcomes`))
        .n === 0,
    s2.run,
  );

  // S2x: cutting over BEFORE the automation accepts tickets fails closed, and
  // the Phase 12 command is restored exactly.
  await db`select private.convert_recall_automation_cron_to_tickets()`;
  const s2x = await fireJob2();
  check(
    'S2x',
    'old automation rejects a ticket (401) and starts no run',
    s2x.response?.status_code === 401 && s2x.run === undefined,
    {
      status: s2x.response?.status_code,
    },
  );
  await db`select private.install_recall_automation_cron()`;
  await db`select private.set_recall_automation_cron_active(true)`;
  const restored = await job2();
  check(
    'S2x',
    'recovery restores the exact Phase 12 command and the active flag',
    restored.md5 === PRODUCTION.job2CommandMd5 && restored.active,
    { md5: restored.md5 },
  );
  await db`select private.set_recall_automation_cron_active(false)`;
  const [{ tickets: s2xTickets }] = await db`select count(*)::int as tickets
    from private.scheduler_invocation_tickets where consumed_at is null`;
  check('S2x', 'the refused ticket stays unconsumed and expires (observable)', s2xTickets === 1);

  // S3a: new matcher, old automation (the extra response fields are ignored).
  await serve(tree('mixed', 'process-recall-matches'), baseEnv);
  const s3a = await fireJob2();
  check('S3a', 'mixed state (new matcher, old automation) runs', healthyRun(s3a), s3a.run);

  // S3b: both release functions (Gate A complete). Static key still accepted.
  await serve(tree('release', 'both'), baseEnv);
  await db`insert into private.recall_automation_pending_recalls (recall_notice_id)
    select id from public.recall_notices where external_id like 'cpsc:934%'
    on conflict do nothing`;
  check(
    'S3b',
    'three recalls are pending before the run',
    (await one('select count(*)::int as n from private.recall_automation_pending_recalls')).n === 3,
  );
  const s3b = await fireJob2();
  const outcomes = await one(
    `select count(*)::int as n, bool_and(outcome = 'resolved') as resolved
    from private.recall_automation_matching_outcomes where run_id = $1`,
    [s3b.run?.id],
  );
  check(
    'S3b',
    'release v1 runs on the static key and records per-recall outcomes',
    healthyRun(s3b) && outcomes.n === 3 && outcomes.resolved,
    { run: s3b.run, outcomes },
  );
  check('S3b', 'watermark never moves backwards', (await watermark()) >= w0);

  // S4: Gate C cutover.
  const before = await job2();
  await db`select private.convert_recall_automation_cron_to_tickets()`;
  const after = await job2();
  check(
    'S4',
    'cutover changes only the command (same job, schedule, active flag)',
    after.jobid === before.jobid &&
      after.schedule === before.schedule &&
      after.active === before.active &&
      after.command === 'select private.recall_automation_tick();',
  );
  const s4 = await fireJob2();
  const consumed = await one(
    `select consumer, consumed_at is not null as consumed
    from private.scheduler_invocation_tickets where request_id = $1`,
    [s4.requestId],
  );
  check(
    'S4',
    'a ticket-based run succeeds and the ticket is consumed once',
    healthyRun(s4) &&
      s4.response?.status_code === 200 &&
      consumed?.consumed &&
      consumed.consumer === 'run-recall-automation',
    { run: s4.run, consumed },
  );

  // S5: Gate D probes (rollback-only; nothing is sent).
  const probe = await db
    .begin(async (tx) => {
      const [{ tick }] = await tx`select private.recall_automation_tick() as tick`;
      const headers = await tx`select array_agg(k order by k) as keys
      from net.http_request_queue q, jsonb_object_keys(q.headers) k where q.id = ${tick.requestId}`;
      await tx`select set_config('p1634.probe', ${String(tick.requestId)}, false)`;
      throw Object.assign(new Error('rollback'), {
        keys: headers[0].keys,
        requestId: tick.requestId,
      });
    })
    .catch((error) => error);
  await sleep(3000);
  const probeResponse = await one(
    'select count(*)::int as n from net._http_response where id = $1',
    [probe.requestId],
  );
  check(
    'S5',
    'a new request carries only content-type and a ticket; rolled back, nothing sent',
    JSON.stringify(probe.keys) === JSON.stringify(['content-type', 'x-recall-automation-ticket']) &&
      probeResponse.n === 0,
    { keys: probe.keys },
  );
  // Concurrent consumption of one ticket is atomic.
  const ticket = randomBytes(32).toString('hex');
  await db`insert into private.scheduler_invocation_tickets (job, ticket_sha256, parameters,
    request_id, expires_at) values ('recall_automation', private.scheduler_ticket_hash(${ticket}),
    '{"trigger":"cron"}', 0, now() + interval '120 seconds')`;
  const racers = [postgres(local.DB_URL, { max: 1 }), postgres(local.DB_URL, { max: 1 })];
  const race = await Promise.all(
    racers.map((sql) =>
      sql.begin(async (tx) => {
        await tx`set local role service_role`;
        const [{ r }] = await tx`select public.consume_recall_automation_ticket(${ticket}) as r`;
        return r;
      }),
    ),
  );
  await Promise.all(racers.map((sql) => sql.end({ timeout: 1 })));
  check(
    'S5',
    'two concurrent consumers: exactly one accepted, the other sees a replay',
    race.filter((r) => r.accepted).length === 1 &&
      race.filter((r) => r.reason === 'replayed').length === 1,
    race,
  );
  // Theft before delivery: a queue reader deletes the request and uses the ticket.
  const stolen = await db.begin(async (tx) => {
    const [{ tick }] = await tx`select private.recall_automation_tick() as tick`;
    const [{ t }] = await tx`select headers->>'x-recall-automation-ticket' as t
      from net.http_request_queue where id = ${tick.requestId}`;
    await tx`delete from net.http_request_queue where id = ${tick.requestId}`;
    return { ticket: t, requestId: tick.requestId };
  });
  const theft = await fetch(`${API}/functions/v1/run-recall-automation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-recall-automation-ticket': stolen.ticket },
    body: '{"trigger":"manual","maxAiEscalations":5,"maxRecalls":7}',
  });
  const theftBody = await theft.json();
  const lastRun = await one(`select trigger, max_recalls, max_ai_escalations from
    private.recall_automation_runs order by started_at desc limit 1`);
  check(
    'S5',
    'a stolen ticket only triggers the same cron-bounded run (body ignored)',
    theft.status === 200 &&
      lastRun.trigger === 'cron' &&
      lastRun.max_recalls !== 7 &&
      lastRun.max_ai_escalations === 0,
    {
      status: theft.status,
      runStatus: theftBody.status,
      lastRun,
    },
  );
  await sleep(2000);
  const detection = await one(
    `select count(*)::int as n from private.scheduler_invocation_tickets k
    where k.consumed_at is not null and not exists (select 1 from net._http_response r
      where r.id = k.request_id and r.status_code = 200) and k.request_id = $1`,
    [stolen.requestId],
  );
  check(
    'S5',
    'theft is detectable: consumed ticket without its own delivered 200 response',
    detection.n === 1,
  );

  // S6: Gate E — retire the exposed key: new edge secret, Vault copy deleted.
  const newKey = randomBytes(32).toString('hex');
  await db`delete from vault.secrets where name = 'recall_automation_key'`;
  await serve(tree('release-e', 'both'), { ...baseEnv, RECALL_AUTOMATION_KEY: newKey });
  const s6 = await fireJob2();
  check('S6', 'ticket runs are unaffected by the key rotation', healthyRun(s6), s6.run);
  const oldKey = await fetch(`${API}/functions/v1/run-recall-automation`, {
    method: 'POST',
    headers: { 'x-recall-automation-key': keys.automation },
    body: '{}',
  });
  check('S6', 'the exposed key is refused (401)', oldKey.status === 401, oldKey.status);
  const reinstall = await db`select private.install_recall_automation_cron()`.then(
    () => 'ok',
    (error) => error.message,
  );
  check(
    'S6',
    'the Phase 12 installer can no longer put a key back in the queue',
    /Vault secrets are unavailable/u.test(reinstall),
    reinstall,
  );

  // S7: Gate F — staged migration, then the static path removed entirely.
  run('psql', [
    local.DB_URL,
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    'supabase/gated-migrations/20261001090000_phase_16_34_gate_f_retire_v1_key_installer.sql',
  ]);
  await db`select private.install_recall_automation_cron()`;
  const fJob = await job2();
  check(
    'S7',
    'the retired installer recreates the ticket command (inactive until activated)',
    fJob.command === 'select private.recall_automation_tick();' && !fJob.active,
  );
  const { RECALL_AUTOMATION_KEY: _unused, ...withoutKey } = baseEnv;
  await serve(tree('release-f', 'both'), withoutKey);
  const s7 = await fireJob2();
  check('S7', 'ticket runs work with no static key configured', healthyRun(s7), s7.run);
  const newKeyCall = await fetch(`${API}/functions/v1/run-recall-automation`, {
    method: 'POST',
    headers: { 'x-recall-automation-key': newKey },
    body: '{}',
  });
  check('S7', 'with the key unset every static-key call is refused', newKeyCall.status === 401);
  check('S7', 'watermark never moved backwards across every state', (await watermark()) >= w0);
  const [{ n: page }] = await db`select count(*)::int as n from private.cpsc_page_attempts`;
  check('S7', 'no page attempt anywhere in the rehearsal', page === 0);

  process.stdout.write(
    `${JSON.stringify(
      { checks: results.length, passed: results.filter((r) => r.ok).length, results },
      null,
      2,
    )}\n`,
  );
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServe().catch(() => {});
    await db?.end({ timeout: 1 });
    if (process.env.P1634_KEEP_LOG) {
      try {
        cpSync(join(work, 'serve.log'), process.env.P1634_KEEP_LOG);
      } catch {
        // no serve log
      }
    }
    rmSync(work, { recursive: true, force: true });
  });
