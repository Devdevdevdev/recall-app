// Phase 17.7a F-4: builds the MINIMAL controlled source tree for the
// process-recall-matches deploy. It starts from the bundle currently deployed in
// production (saved JSON from the read-only get_edge_function call), replaces ONLY
// the three F-4 runtime files with their committed versions, adds the type-only
// modules the bundler needs to resolve, and refuses anything else (17.7a-1 code,
// product-check functions, page worker, newer v2 modules, any unexpected file).
// Usage: node scripts/stage-f4-edge-bundle.mjs <deployed.json> <out-dir> [rev | --as-deployed]
// --as-deployed rebuilds the deployed bundle unchanged (Edge rollback source).
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [deployedPath, outDir, mode = '553173c'] = process.argv.slice(2);
if (!deployedPath || !outDir)
  throw new Error('usage: <deployed.json> <out-dir> [rev|--as-deployed]');
const asDeployed = mode === '--as-deployed';
const rev = asDeployed ? '553173c' : mode;

export const F4_RUNTIME_FILES = [
  'supabase/functions/_shared/recallMatching/orchestrator.ts',
  'supabase/functions/process-recall-matches/legacyRun.ts',
  'supabase/functions/process-recall-matches/store.ts',
];
const TYPE_ONLY = [
  'supabase/functions/_shared/nebius/types.ts',
  'supabase/functions/_shared/push/types.ts',
  'supabase/functions/_shared/recallMatching/types.ts',
];
const FORBIDDEN =
  /productCheck|check-owned-product|process-owned-product-checks|process-cpsc-page-evidence|_shared\/cpsc\/|ruleSetsV2|deterministicRuleSetsV2/u;

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (path) => execFileSync('git', ['show', `${rev}:${path}`]);
const deployed = JSON.parse(readFileSync(deployedPath, 'utf8'));
if (deployed.slug !== 'process-recall-matches')
  throw new Error('not the process-recall-matches bundle');

const tree = {};
for (const file of deployed.files) {
  const path = file.name.startsWith('functions/') ? `supabase/${file.name}` : file.name;
  tree[path] =
    !asDeployed && F4_RUNTIME_FILES.includes(path) ? git(path) : Buffer.from(file.content);
}
for (const path of F4_RUNTIME_FILES)
  if (!(path in tree)) throw new Error(`${path} missing from bundle`);
for (const path of TYPE_ONLY) tree[path] = git(path);

const offenders = Object.keys(tree).filter((path) => FORBIDDEN.test(path));
if (offenders.length) throw new Error(`forbidden files in the F-4 tree: ${offenders.join(', ')}`);

for (const [path, bytes] of Object.entries(tree)) {
  const target = join(outDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
writeFileSync(
  join(outDir, 'supabase/config.toml'),
  'project_id = "RECALL"\n\n[functions.process-recall-matches]\nverify_jwt = false\n',
);

// The verified manifest covers the runtime (bundled) files only.
const runtime = Object.keys(tree)
  .filter((path) => !TYPE_ONLY.includes(path))
  .sort();
const manifest = runtime.map((path) => `${sha(tree[path])}  ${path}`).join('\n');
process.stdout.write(
  `${JSON.stringify(
    {
      mode: asDeployed ? 'as-deployed (rollback)' : `F-4 from ${rev}`,
      runtimeFiles: runtime.length,
      typeOnlyFiles: TYPE_ONLY.length,
      replaced: Object.fromEntries(F4_RUNTIME_FILES.map((path) => [path, sha(tree[path])])),
      targetRuntimeTreeSha256: sha(manifest),
    },
    null,
    2,
  )}\n`,
);
