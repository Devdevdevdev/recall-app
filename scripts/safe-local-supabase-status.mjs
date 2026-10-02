import { spawnSync } from 'node:child_process';

// `supabase status` prints disposable local keys. Container names and health
// are sufficient for the local preflight and contain no connection secrets.
const result = spawnSync(
  'docker',
  ['ps', '--filter', 'name=supabase_', '--format', '{{.Names}} {{.Status}}'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 },
);

if (result.status !== 0) {
  process.stderr.write('Local Supabase container status is unavailable.\n');
  process.exitCode = 1;
} else {
  const services = result.stdout
    .split('\n')
    .filter((line) => /^supabase_[A-Za-z0-9_]+ Up\b/u.test(line))
    .map((line) => line.split(' ')[0]);
  process.stdout.write(
    JSON.stringify({
      localSupabaseRunning: services.includes('supabase_db_RECALL'),
      healthyServiceNames: services,
    }) + '\n',
  );
}
