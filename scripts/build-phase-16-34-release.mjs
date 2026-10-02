// Phase 16.34: builds the Gate A release tree for the two v1 functions from the
// exact deployed sources plus only the reviewed Phase 16.33 v1 edits, so a
// deploy cannot ship unrelated worktree changes (e.g. the dormant v2 files).
//
// Usage:
//   node scripts/build-phase-16-34-release.mjs <deployed-root> <out-dir>
// <deployed-root>/<slug>/supabase/functions/... must come from
//   supabase functions download <slug> --use-api --workdir <deployed-root>/<slug>
// (one isolated workdir per function). The script refuses unless every
// deployed file of both functions is either byte-identical to the worktree or
// byte-identical to the recorded pre-16.33 source, and the 16.33 edit set is
// exactly the reviewed one.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

const [deployedRoot, outDir] = process.argv.slice(2);
if (!deployedRoot || !outDir) throw new Error('usage: <deployed-root> <out-dir>');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

// The reviewed Phase 16.33 v1 edits (16.33 report §14): pre -> post.
const EDITS = {
  'supabase/functions/_shared/recallMatching/orchestrator.ts': [
    '415dd0802152856b244cb07bfca3f4ffce88af4d5a687b9cc69b197152958854',
    '8b044008eedabdc2c3885c559867dd8cfabc5657ca9188a8da816d5cdfbf9a4c',
  ],
  'supabase/functions/_shared/recallMatching/index.ts': [
    '4ea4aab9abd69d80ec25657d3437c450ec8d705a6d610f37ddc6f606a907606c',
    'f22b4db701db5496cac9f5295d21eec912708805eac58310330c322ed7909704',
  ],
  'supabase/functions/process-recall-matches/legacyRun.ts': [
    '78b20cb2a20a65625df6614cdc38f3df754d0db9980a38cb8961bf48caa21dbd',
    'f1a8d0476a8e5f8b4c6e32bfe740eaa9629614992e7786de7742008f0a5b8e5a',
  ],
  'supabase/functions/_shared/automation/orchestrator.ts': [
    '492bfb74e237567c01563fd1316e8183892c4c3e84dd02df9aa3652b3513d301',
    '05133c737b07f93621fdfacd7ceb289ddb0de3ec1d43d703b79be197fa360222',
  ],
  'supabase/functions/_shared/automation/index.ts': [
    '199364b28cff7a62399947cc258123c8a1ac10b3f031804ebc65522bc5b94fe7',
    'f7b8c7855380acf73e7050f9240e58c5979a7ba9088021198c8c0640c11211e7',
  ],
  'supabase/functions/run-recall-automation/children.ts': [
    '42684f7ad82c3565f98e5b2866cf0e1c3dc0ef0854afff17dc72261c7e64a5c5',
    '70933ae64435581bbff83d3c30487f30fa52407596370ea09d73b267fad31f03',
  ],
  'supabase/functions/run-recall-automation/store.ts': [
    '500dd427dedc350896a32f1df530dd4b71da4d9baca2f008b0f259d723f6d1f9',
    '22a222e8647f2eee7231a04caf5428016bbd3074460a7ff8d462d119835f102e',
  ],
  'supabase/functions/run-recall-automation/index.ts': [
    '427a0fda04577a95dd3910fc549085e761a399679e9277f62984b63f9c4bb7c3',
    'ffda65effa45acf589c6f78bb9c4b1a9d2171d84edfdfbdcf0df8ecd03e8fc11',
  ],
};
// Type-only modules are erased from the deployed bundle but needed to type-check.
const TYPE_ONLY = {
  'supabase/functions/_shared/automation/types.ts':
    'b0d231c5077f5eb95d0eb503281a64f1447951853ca66fb528ba0e3f5a22efc4',
  'supabase/functions/_shared/recallMatching/types.ts':
    '7dcf0b84d98b0707baa968217b6b3d60c42debefddc05d483edb2417c106cd36',
  'supabase/functions/_shared/nebius/types.ts':
    '0c82ca0f898136016f744c9cbfec607064796ba139baa02f7bb519ce5e6d3469',
  'supabase/functions/_shared/push/types.ts':
    'eecfedf976344e526661572447b70021077dc138d43ef3a6c8b1dd8ae3cf6f91',
};

function files(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  return out;
}

const manifest = { functions: {}, files: {} };
for (const slug of ['process-recall-matches', 'run-recall-automation']) {
  const root = join(deployedRoot, slug);
  const deployed = files(join(root, 'supabase/functions')).map((path) => relative(root, path));
  manifest.functions[slug] = deployed.sort();
  for (const rel of deployed) {
    const deployedSha = sha(join(root, rel));
    const edit = EDITS[rel];
    let source;
    let kind;
    if (edit) {
      if (deployedSha !== edit[0])
        throw new Error(`${rel}: deployed bytes are not the reviewed pre-16.33 source`);
      if (sha(rel) !== edit[1])
        throw new Error(`${rel}: worktree is not the reviewed 16.33 source`);
      source = rel;
      kind = 'phase-16.33-edit';
    } else {
      source = join(root, rel);
      kind =
        sha(rel) === deployedSha ? 'deployed=worktree' : 'deployed bytes kept (worktree differs)';
    }
    const target = join(outDir, rel);
    const previous = manifest.files[rel];
    const outSha = sha(source);
    if (previous && previous.sha256 !== outSha) throw new Error(`${rel}: conflicting versions`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    manifest.files[rel] = { sha256: outSha, deployedSha256: deployedSha, kind };
  }
}
for (const [rel, expected] of Object.entries(TYPE_ONLY)) {
  if (sha(rel) !== expected) throw new Error(`${rel}: unexpected type-only source`);
  mkdirSync(dirname(join(outDir, rel)), { recursive: true });
  copyFileSync(rel, join(outDir, rel));
  manifest.files[rel] = {
    sha256: expected,
    deployedSha256: null,
    kind: 'type-only (erased at bundle)',
  };
}
const missing = Object.keys(EDITS).filter((rel) => !manifest.files[rel]);
if (missing.length)
  throw new Error(`reviewed edits missing from deployed set: ${missing.join(', ')}`);
// The deploy workdir needs the project config (function verify_jwt settings).
mkdirSync(join(outDir, 'supabase'), { recursive: true });
copyFileSync('supabase/config.toml', join(outDir, 'supabase/config.toml'));
manifest.files['supabase/config.toml'] = {
  sha256: sha('supabase/config.toml'),
  kind: 'project config',
};
const lines = Object.entries(manifest.files)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([rel, entry]) => `${rel}\t${entry.sha256}\n`)
  .join('');
manifest.releaseSha256 = createHash('sha256').update(lines).digest('hex');
if (existsSync(join(outDir, 'MANIFEST.json')))
  throw new Error('refusing to overwrite an existing release');
writeFileSync(join(outDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({
    releaseSha256: manifest.releaseSha256,
    files: Object.keys(manifest.files).length,
    edits: Object.values(manifest.files).filter((f) => f.kind === 'phase-16.33-edit').length,
    worktreeDiffersKeptDeployed: Object.entries(manifest.files)
      .filter(([, f]) => f.kind.startsWith('deployed bytes kept'))
      .map(([r]) => r),
  })}\n`,
);
