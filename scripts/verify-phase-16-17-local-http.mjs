// Local-only HTTP proof. Requires the local Supabase stack and functions serve
// with RECALL_INGESTION_KEY=local-phase-16-17. No remote project URL is accepted.
import { spawnSync } from 'node:child_process';

const command = spawnSync('npx', ['supabase', 'status', '-o', 'json'], {
  encoding: 'utf8',
});
if (command.status !== 0) throw new Error('Local Supabase status is unavailable.');
const status = JSON.parse(command.stdout);
for (const value of [status.API_URL, status.DB_URL]) {
  const host = new URL(value.replace(/^postgresql:/u, 'http:')).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('Local stack only.');
}

function sql(query) {
  const result = spawnSync(
    'psql',
    [status.DB_URL, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
    {
      input: query,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return result.stdout.trim().split('\n').at(-1);
}

sql(`select public.ensure_cpsc_recall_source();
update public.recall_sources set is_active=true where source_key='health_canada';`);

const cursor = (source) =>
  sql(`select watermark->>'value' from private.recall_source_sync_state st
    join public.recall_sources s on s.id=st.source_id where s.source_key='${source}'`);
const outcome = [];
async function ingest(sourceKey, endDate, key = 'local-phase-16-17') {
  const response = await fetch(`${status.API_URL}/functions/v1/ingest-recall-source`, {
    method: 'POST',
    headers: {
      apikey: status.ANON_KEY,
      authorization: `Bearer ${status.ANON_KEY}`,
      'content-type': 'application/json',
      ...(key ? { 'x-recall-ingestion-key': key } : {}),
    },
    body: JSON.stringify({
      sourceKey,
      startDate: endDate,
      endDate,
      maxRecords: 100,
      dryRun: false,
    }),
    signal: AbortSignal.timeout(45000),
  });
  const body = await response.json();
  return { status: response.status, body };
}
function check(name, passed, detail) {
  outcome.push({ name, passed, detail });
  if (!passed) process.exitCode = 1;
}

for (const sourceKey of ['cpsc', 'health_canada']) {
  const kind = sourceKey === 'cpsc' ? 'last_publish_date' : 'last_updated_date';
  if (!cursor(sourceKey)) {
    sql(`select public.record_recall_source_sync_result('${sourceKey}','success',
      '{"kind":"${kind}","value":"2026-09-27"}');`);
  }
  const baseline = cursor(sourceKey);
  const forward = new Date(`${baseline}T00:00:00.000Z`);
  forward.setUTCDate(forward.getUTCDate() + 1);
  const forwardDate = forward.toISOString().slice(0, 10);
  const missingKey = await ingest(sourceKey, '2026-09-17', null);
  check(`${sourceKey} missing key`, missingKey.status === 401, missingKey.status);
  const backward = await ingest(sourceKey, '2026-09-17');
  check(
    `${sourceKey} backward`,
    backward.status === 409 && backward.body.code === 'watermark_regression',
    { status: backward.status, code: backward.body.code, cursor: cursor(sourceKey) },
  );
  check(`${sourceKey} backward unchanged`, cursor(sourceKey) === baseline, cursor(sourceKey));
  for (const date of [baseline, forwardDate]) {
    const result = await ingest(sourceKey, date);
    check(`${sourceKey} ${date}`, result.status === 200 && cursor(sourceKey) === date, {
      status: result.status,
      code: result.body.code,
      cursor: cursor(sourceKey),
      fetched: result.body.stats?.fetched,
      rejected: result.body.stats?.rejected,
    });
  }
}

console.log(
  JSON.stringify({ checks: outcome, passed: outcome.every((item) => item.passed) }, null, 2),
);
