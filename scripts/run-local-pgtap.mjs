// Local pgTAP runner (check:all `test:database`). Runs every suite under
// supabase/tests except frozen historical artifacts that a newer contract superseded.
// A superseded file is skipped ONLY while its bytes still equal the SHA-256 recorded
// in its freeze manifest and its active successor exists; otherwise the run fails.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

export const SUPERSEDED = {
  'supabase/tests/phase-16-product-safety-evidence.sql': {
    successor: 'supabase/tests/phase-17-7a-f4-product-safety-evidence.sql',
    freezeManifest: 'benchmarks/recall-matching/phase-16/freeze-manifest.json',
    reason:
      'Frozen Phase 16 artifact. Its v1 fixture writes a confirmed match directly, which ' +
      'Phase 17.7a F-4 refuses for every role; the active successor keeps every assertion.',
  },
};

async function sqlFiles(relative) {
  const out = [];
  for (const entry of await readdir(new URL(`${relative}/`, root), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await sqlFiles(path)));
    else if (entry.name.endsWith('.sql')) out.push(path);
  }
  return out.sort();
}

/** Throws unless every superseded artifact is intact and has its successor. */
export async function verifySuperseded() {
  for (const [path, entry] of Object.entries(SUPERSEDED)) {
    const manifest = JSON.parse(await readFile(new URL(entry.freezeManifest, root), 'utf8'));
    const expected = {
      ...manifest.implementationArtifacts,
      ...manifest.benchmarkArtifacts,
      ...manifest.reviewArtifacts,
    }[path];
    const actual = createHash('sha256')
      .update(await readFile(new URL(path, root)))
      .digest('hex');
    if (!expected || actual !== expected) {
      throw new Error(`${path} is not byte-identical to its freeze manifest; refusing to skip it.`);
    }
    if (!existsSync(new URL(entry.successor, root))) {
      throw new Error(`${path} has no active successor (${entry.successor}).`);
    }
  }
}

export async function activeSuites() {
  await verifySuperseded();
  return (await sqlFiles('supabase/tests')).filter((path) => !(path in SUPERSEDED));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const suites = await activeSuites();
  const result = spawnSync('npx', ['supabase', 'test', 'db', '--local', ...suites], {
    stdio: 'inherit',
    cwd: new URL('.', root).pathname,
  });
  process.exit(result.status ?? 1);
}
