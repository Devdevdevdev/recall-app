// Phase 17.7a install: exact source trees for the two NEW product-check Edge Functions,
// and a read-only check of any deployed 17.7a bundle (get_edge_function JSON).
//
//   node scripts/stage-17-7a-edge-bundles.mjs stage <function> <out-dir> [rev]
//   node scripts/stage-17-7a-edge-bundles.mjs verify <function> <deployed.json> [rev]
//
// <function>: check-owned-product | process-owned-product-checks | run-recall-automation
// (run-recall-automation is staged from the production v14 bytes by
// stage-17-7a-2-automation-bundle.mjs; here it is only verified after deploy).
// Files come from the reviewed commit, never from the working tree. The module closure
// is recomputed and must equal the pinned lists below; anything else stops the script.
// Runtime files are what the deployed bundle contains; type-only modules are uploaded
// as sources by the CLI but erased at bundle (they hold no executable code).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const REVIEWED = '6bab7d340ab6c42bdb6dd41fe14e929a7801b31c';
const F = 'supabase/functions';
const PRODUCT_RUNTIME = [
  `${F}/_shared/matching/candidateRetrieval.ts`,
  `${F}/_shared/matching/criterionEvaluatorV2.ts`,
  `${F}/_shared/matching/deterministicMatcherV2.ts`,
  `${F}/_shared/matching/deterministicRuleSetsV2.ts`,
  `${F}/_shared/matching/evidence.ts`,
  `${F}/_shared/matching/normalization.ts`,
  `${F}/_shared/matching/typesV2.ts`,
  `${F}/_shared/productCheck/gate.ts`,
  `${F}/_shared/productCheck/handler.ts`,
  `${F}/_shared/productCheck/orchestrator.ts`,
  `${F}/_shared/productCheck/server.ts`,
  `${F}/_shared/productCheck/supabaseStore.ts`,
  `${F}/_shared/recallMatching/productionPolicyV2.ts`,
  `${F}/_shared/recallMatching/projection.ts`,
  `${F}/_shared/recallMatching/reviewedCriteriaV2.ts`,
  `${F}/_shared/recallMatching/ruleSetsV2.ts`,
];
const PRODUCT_TYPE_ONLY = [
  `${F}/_shared/matching/guardedNemotronMatcher.ts`,
  `${F}/_shared/matching/guardedNemotronPrompt.ts`,
  `${F}/_shared/matching/guardedNemotronSchema.ts`,
  `${F}/_shared/matching/nemotronMatcher.ts`,
  `${F}/_shared/matching/nemotronPrompt.ts`,
  `${F}/_shared/matching/nemotronSchema.ts`,
  `${F}/_shared/matching/types.ts`,
  `${F}/_shared/nebius/errors.ts`,
  `${F}/_shared/nebius/types.ts`,
  `${F}/_shared/recallMatching/orchestratorV2.ts`,
  `${F}/_shared/recallMatching/types.ts`,
];
export const TARGETS = {
  'check-owned-product': {
    runtime: [...PRODUCT_RUNTIME, `${F}/check-owned-product/index.ts`],
    typeOnly: PRODUCT_TYPE_ONLY,
    runtimeTree: 'b029ef383cd4717d81fa3d2ca778f9039e5a93f796adbf7195f9508fe5f99ca0',
  },
  'process-owned-product-checks': {
    runtime: [...PRODUCT_RUNTIME, `${F}/process-owned-product-checks/index.ts`],
    typeOnly: PRODUCT_TYPE_ONLY,
    runtimeTree: '1b02f9706eb638804b354810a4b70922db452476be63d575c742794ba2eb1a78',
  },
  'run-recall-automation': {
    runtime: [
      `${F}/_shared/automation/index.ts`,
      `${F}/_shared/automation/orchestrator.ts`,
      `${F}/_shared/automation/request.ts`,
      `${F}/run-recall-automation/children.ts`,
      `${F}/run-recall-automation/index.ts`,
      `${F}/run-recall-automation/store.ts`,
    ],
    typeOnly: [`${F}/_shared/automation/types.ts`],
    runtimeTree: '96875b00ba96b3721f43c48a98e1f9912fb41196f417e111f466d44de5455e57',
  },
};

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const treeHash = (files) =>
  sha(
    Object.keys(files)
      .sort()
      .map((path) => `${sha(files[path])}  ${path}`)
      .join('\n'),
  );

/** Static imports; an edge is type-only when it is `import type` or every name is `type X`. */
function imports(source) {
  const out = [];
  const pattern = /(^|\n)\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+'([^']+)'/gu;
  for (const match of source.matchAll(pattern)) {
    let typeOnly = Boolean(match[3]);
    const clause = match[4].trim();
    if (!typeOnly && clause.startsWith('{') && clause.endsWith('}')) {
      const names = clause
        .slice(1, -1)
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
      typeOnly = names.length > 0 && names.every((name) => name.startsWith('type '));
    }
    out.push({ spec: match[5], typeOnly });
  }
  // import('...') inside a type position is a type-only edge; a runtime dynamic import
  // (await import / then) would escape the static closure and is refused.
  for (const match of source.matchAll(/\bimport\(\s*'([^']+)'\s*\)/gu)) {
    out.push({ spec: match[1], typeOnly: true });
  }
  if (/await\s+import\s*\(|\bimport\s*\([^)]*\)\s*\.then\b/u.test(source)) {
    throw new Error('runtime dynamic import found; refusing');
  }
  return out;
}

export function closure(entry, read) {
  const runtime = new Set();
  const typeOnly = new Set();
  const external = new Set();
  const walk = (file, viaType) => {
    if (runtime.has(file) || (viaType && typeOnly.has(file))) return;
    if (viaType) typeOnly.add(file);
    else {
      runtime.add(file);
      typeOnly.delete(file);
    }
    for (const { spec, typeOnly: edgeIsType } of imports(read(file).toString('utf8'))) {
      if (spec.startsWith('.')) walk(normalize(join(dirname(file), spec)), viaType || edgeIsType);
      else external.add(spec);
    }
  };
  walk(entry, false);
  return { runtime: [...runtime].sort(), typeOnly: [...typeOnly].sort(), external: [...external] };
}

function expectTree(name, rev) {
  const target = TARGETS[name];
  if (!target) throw new Error(`unknown function ${name}`);
  const read = (path) => execFileSync('git', ['show', `${rev}:${path}`]);
  const found = closure(`${F}/${name}/index.ts`, read);
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (!same(found.runtime, target.runtime)) throw new Error(`${name}: runtime closure changed`);
  if (!same(found.typeOnly, target.typeOnly)) throw new Error(`${name}: type-only closure changed`);
  if (!same(found.external, ['npm:@supabase/supabase-js@2'])) {
    throw new Error(`${name}: unexpected external import ${found.external.join(', ')}`);
  }
  const runtime = Object.fromEntries(target.runtime.map((path) => [path, read(path)]));
  if (treeHash(runtime) !== target.runtimeTree)
    throw new Error(`${name}: runtime tree hash differs`);
  const typeOnly = Object.fromEntries(target.typeOnly.map((path) => [path, read(path)]));
  return { target, runtime, typeOnly };
}

function stage(name, outDir, rev) {
  if (name === 'run-recall-automation') {
    throw new Error('stage run-recall-automation with stage-17-7a-2-automation-bundle.mjs');
  }
  const { target, runtime, typeOnly } = expectTree(name, rev);
  for (const [path, bytes] of Object.entries({ ...runtime, ...typeOnly })) {
    mkdirSync(dirname(join(outDir, path)), { recursive: true });
    writeFileSync(join(outDir, path), bytes);
  }
  // Authorization is enforced in the handler (verified JWT / matching key); the
  // platform JWT check stays off, exactly as declared in supabase/config.toml.
  writeFileSync(
    join(outDir, 'supabase/config.toml'),
    `project_id = "RECALL"\n\n[functions.${name}]\nverify_jwt = false\n`,
  );
  return {
    function: name,
    rev,
    runtimeFiles: target.runtime.length,
    typeOnlyFiles: target.typeOnly.length,
    runtimeTreeSha256: treeHash(runtime),
    sourceTreeSha256: treeHash({ ...runtime, ...typeOnly }),
  };
}

/** Deployed bundle must hold every runtime file byte-for-byte; extras only type-only, byte-equal. */
function verify(name, deployedPath, rev) {
  const { target, runtime, typeOnly } = expectTree(name, rev);
  const deployed = JSON.parse(readFileSync(deployedPath, 'utf8'));
  if (deployed.slug !== name) throw new Error(`not the ${name} bundle`);
  if (deployed.verify_jwt !== false) throw new Error(`${name}: verify_jwt must be false`);
  const files = {};
  for (const file of deployed.files) {
    const path = file.name.startsWith('functions/') ? `supabase/${file.name}` : file.name;
    files[path] = Buffer.from(file.content);
  }
  const problems = [];
  for (const path of target.runtime) {
    if (!(path in files)) problems.push(`missing ${path}`);
    else if (sha(files[path]) !== sha(runtime[path])) problems.push(`differs ${path}`);
  }
  for (const path of Object.keys(files)) {
    if (target.runtime.includes(path)) continue;
    if (!(path in typeOnly)) problems.push(`unexpected ${path}`);
    else if (sha(files[path]) !== sha(typeOnly[path])) problems.push(`differs ${path}`);
  }
  const deployedRuntime = Object.fromEntries(
    target.runtime.map((path) => [path, files[path] ?? '']),
  );
  return {
    function: name,
    version: deployed.version,
    ezbr_sha256: deployed.ezbr_sha256,
    deployedFiles: Object.keys(files).length,
    runtimeTreeSha256: treeHash(deployedRuntime),
    expectedRuntimeTreeSha256: target.runtimeTree,
    ok: problems.length === 0 && treeHash(deployedRuntime) === target.runtimeTree,
    problems,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, name, path, rev = REVIEWED] = process.argv.slice(2);
  if (!mode || !name || !path) {
    throw new Error(
      'usage: stage <function> <out-dir> [rev] | verify <function> <deployed.json> [rev]',
    );
  }
  const result = mode === 'stage' ? stage(name, path, rev) : verify(name, path, rev);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (mode === 'verify' && !result.ok) process.exitCode = 1;
}
