// Phase 17.7a-2: builds the MINIMAL controlled source tree for a future
// run-recall-automation deploy. It starts from the bundle currently deployed in
// production (saved JSON from the read-only get_edge_function call), refuses it
// unless it is exactly the recorded v14 runtime tree, replaces ONLY the 17.7a-2
// runtime files with their reviewed versions, adds the type-only module the
// bundler needs, and refuses anything else (product-check code, matching
// libraries, page worker, any unexpected file).
// Usage: node scripts/stage-17-7a-2-automation-bundle.mjs <deployed.json> <out-dir> [rev | --as-deployed]
// Without rev the reviewed files are read from the working tree (pre-commit
// rehearsal); after the commit, pass its SHA. --as-deployed rebuilds v14 unchanged
// (Edge rollback source).
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PRODUCTION_RUNTIME_TREE =
  '37a79b95bf01bb37d7af54d0c0337fc981c63ff2f5dd2adb74092196fafda515';
export const RUNTIME_FILES = [
  'supabase/functions/_shared/automation/index.ts',
  'supabase/functions/_shared/automation/orchestrator.ts',
  'supabase/functions/_shared/automation/request.ts',
  'supabase/functions/run-recall-automation/children.ts',
  'supabase/functions/run-recall-automation/index.ts',
  'supabase/functions/run-recall-automation/store.ts',
];
export const P17_7A_2_RUNTIME_FILES = RUNTIME_FILES.filter((path) => !path.endsWith('request.ts'));
const TYPE_ONLY = ['supabase/functions/_shared/automation/types.ts'];
const FORBIDDEN =
  /productCheck|check-owned-product|process-owned-product-checks|process-recall-matches|process-cpsc-page-evidence|_shared\/(cpsc|matching|recallMatching|nebius|push)\//u;

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const treeHash = (tree) =>
  sha(
    Object.keys(tree)
      .filter((path) => !TYPE_ONLY.includes(path))
      .sort()
      .map((path) => `${sha(tree[path])}  ${path}`)
      .join('\n'),
  );

export function stage(deployed, mode, read) {
  if (deployed.slug !== 'run-recall-automation') {
    throw new Error('not the run-recall-automation bundle');
  }
  const asDeployed = mode === '--as-deployed';
  const tree = {};
  for (const file of deployed.files) {
    const path = file.name.startsWith('functions/') ? `supabase/${file.name}` : file.name;
    tree[path] = Buffer.from(file.content);
  }
  const deployedPaths = Object.keys(tree).sort();
  if (JSON.stringify(deployedPaths) !== JSON.stringify([...RUNTIME_FILES].sort())) {
    throw new Error(`unexpected deployed files: ${deployedPaths.join(', ')}`);
  }
  if (treeHash(tree) !== PRODUCTION_RUNTIME_TREE) {
    throw new Error('the deployed bundle is not the recorded v14 runtime tree; stop');
  }
  if (!asDeployed) for (const path of P17_7A_2_RUNTIME_FILES) tree[path] = read(path);
  for (const path of TYPE_ONLY) tree[path] = read(path);
  const offenders = Object.keys(tree).filter((path) => FORBIDDEN.test(path));
  if (offenders.length) throw new Error(`forbidden files: ${offenders.join(', ')}`);
  return tree;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [deployedPath, outDir, mode] = process.argv.slice(2);
  if (!deployedPath || !outDir) {
    throw new Error('usage: <deployed.json> <out-dir> [rev|--as-deployed]');
  }
  const rev = mode && mode !== '--as-deployed' ? mode : null;
  const read = (path) =>
    rev ? execFileSync('git', ['show', `${rev}:${path}`]) : readFileSync(path);
  const tree = stage(JSON.parse(readFileSync(deployedPath, 'utf8')), mode, read);
  for (const [path, bytes] of Object.entries(tree)) {
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(
    join(outDir, 'supabase/config.toml'),
    'project_id = "RECALL"\n\n[functions.run-recall-automation]\nverify_jwt = false\n',
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        mode:
          mode === '--as-deployed' ? 'as-deployed (rollback)' : `17.7a-2 from ${rev ?? 'worktree'}`,
        baselineRuntimeTreeSha256: PRODUCTION_RUNTIME_TREE,
        runtimeFiles: RUNTIME_FILES.length,
        typeOnlyFiles: TYPE_ONLY.length,
        replaced:
          mode === '--as-deployed'
            ? {}
            : Object.fromEntries(P17_7A_2_RUNTIME_FILES.map((path) => [path, sha(tree[path])])),
        targetRuntimeTreeSha256: treeHash(tree),
      },
      null,
      2,
    )}\n`,
  );
}
