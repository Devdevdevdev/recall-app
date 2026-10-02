// Production-safe remote pgTAP runner (Phase 16.15).
//
// Production has pgTAP available but not installed, and it must never be installed
// permanently. This wrapper runs ONE remote-safe suite as a single transaction:
//
//   BEGIN                                      (the suite's own first statement)
//   CREATE EXTENSION pgtap WITH SCHEMA extensions   (injected right after BEGIN)
//   ...suite...
//   ROLLBACK                                   (the suite's own last statement)
//
// so the final ROLLBACK removes the extension together with every fixture. The suite
// file itself is not modified. The runner refuses a suite that does not start with
// BEGIN and end with ROLLBACK, or that contains COMMIT; it refuses to run when pgTAP
// is already installed (it would otherwise be ambiguous whether the transient install
// happened); and afterwards it verifies pgTAP is absent and no session is left idle in
// a transaction. The database URL is read from SUPABASE_DB_URL and never printed.
//
// Usage: npm run test:remote-pgtap [-- --file supabase/tests/remote/<suite>.sql]
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const DEFAULT_SUITE = 'supabase/tests/remote/phase-16-production-compatibility.sql';
export const TRANSIENT_PGTAP = 'create extension pgtap with schema extensions;';

/** The suite text with the transient extension injected directly after its BEGIN. */
export function wrapRemoteSuite(sql, migrationSql = null) {
  const lines = sql.split('\n');
  const statements = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--'));
  if (statements[0]?.toLowerCase() !== 'begin;') {
    throw new Error('The remote suite must start with BEGIN;');
  }
  if (statements.at(-1)?.toLowerCase() !== 'rollback;') {
    throw new Error('The remote suite must end with ROLLBACK;');
  }
  if (statements.some((line) => /^commit\b/i.test(line))) {
    throw new Error('The remote suite must not COMMIT.');
  }
  if (/create\s+extension|drop\s+extension/i.test(sql)) {
    throw new Error('The remote suite must not manage extensions itself.');
  }
  const beginIndex = lines.findIndex((line) => line.trim().toLowerCase() === 'begin;');
  let migrationBody = '';
  if (migrationSql !== null) {
    const migrationLines = migrationSql.split('\n');
    const commands = migrationLines
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith('--'));
    if (commands[0] !== 'begin;' || commands.at(-1) !== 'commit;') {
      throw new Error('The migration must have its own BEGIN/COMMIT wrapper.');
    }
    const first = migrationLines.findIndex((line) => line.trim().toLowerCase() === 'begin;');
    const last = migrationLines.findLastIndex((line) => line.trim().toLowerCase() === 'commit;');
    if (commands.filter((line) => /^begin;|^commit;|^rollback;/iu.test(line)).length !== 2) {
      throw new Error('The migration has an unexpected transaction command.');
    }
    migrationBody = migrationLines.slice(first + 1, last).join('\n');
  }
  return [
    ...lines.slice(0, beginIndex + 1),
    TRANSIENT_PGTAP,
    ...(migrationSql === null ? [] : [migrationBody]),
    ...lines.slice(beginIndex + 1),
  ].join('\n');
}

/** Summarize psql TAP output; `passed` requires the complete plan and a ROLLBACK. */
export function summarizeTap(output) {
  const plan = Number(/^\s*1\.\.(\d+)\s*$/mu.exec(output)?.[1] ?? NaN);
  const ok = (output.match(/^\s*ok \d+/gmu) ?? []).length;
  const notOk = (output.match(/^\s*not ok \d+/gmu) ?? []).length;
  const rolledBack = /^ROLLBACK$/mu.test(output);
  const extensionCreated = /^CREATE EXTENSION$/mu.test(output);
  return {
    plan,
    ok,
    notOk,
    extensionCreated,
    rolledBack,
    passed: Number.isInteger(plan) && ok === plan && notOk === 0 && rolledBack && extensionCreated,
  };
}

const probe = (url) => {
  const result = spawnSync(
    'psql',
    [
      url,
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      "select json_build_object('pgtapInstalled', (select count(*) from pg_extension where extname = 'pgtap'), 'idleInTransaction', (select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state like 'idle in transaction%'), 'sourceGuard', (select count(*) from pg_trigger where tgname = 'guard_recall_source_watermark_forward' and not tgisinternal), 'automationGuard', (select count(*) from pg_trigger where tgname = 'guard_recall_automation_watermark_forward' and not tgisinternal), 'migrationHistory', (select count(*) from supabase_migrations.schema_migrations where version = '20260927124132'))",
    ],
    { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' } },
  );
  if (result.status !== 0) throw new Error(`Read-only probe failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout.trim());
};

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('SUPABASE_DB_URL is required.');
  const fileIndex = process.argv.indexOf('--file');
  const file = fileIndex > 0 ? process.argv[fileIndex + 1] : DEFAULT_SUITE;
  const migrationIndex = process.argv.indexOf('--migration');
  const migrationFile = migrationIndex > 0 ? process.argv[migrationIndex + 1] : null;
  const wrapped = wrapRemoteSuite(
    await readFile(file, 'utf8'),
    migrationFile ? await readFile(migrationFile, 'utf8') : null,
  );

  const before = probe(url);
  if (before.pgtapInstalled !== 0) {
    throw new Error(
      'pgTAP is already installed; refusing to run (install state would be ambiguous).',
    );
  }
  if (migrationFile && (before.sourceGuard !== 0 || before.automationGuard !== 0)) {
    throw new Error('The forward-only guard already exists; refusing rollback-only rehearsal.');
  }
  const run = spawnSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1'], {
    input: wrapped,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  const after = probe(url);
  const summary = {
    file,
    ...(migrationFile ? { migrationFile } : {}),
    psqlExit: run.status,
    ...summarizeTap(output),
    pgtapInstalledBefore: before.pgtapInstalled,
    pgtapInstalledAfter: after.pgtapInstalled,
    idleInTransactionAfter: after.idleInTransaction,
    guardsUnchanged:
      before.sourceGuard === after.sourceGuard && before.automationGuard === after.automationGuard,
    migrationHistoryUnchanged: before.migrationHistory === after.migrationHistory,
    failures: output
      .split('\n')
      .filter((line) => /^\s*not ok|ERROR|# Looks like/u.test(line))
      .slice(0, 20),
  };
  summary.passed =
    summary.passed &&
    run.status === 0 &&
    after.pgtapInstalled === 0 &&
    after.idleInTransaction === 0 &&
    summary.guardsUnchanged &&
    summary.migrationHistoryUnchanged;
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
