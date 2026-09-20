import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const hashPath = async (path) =>
  createHash('sha256')
    .update(await readFile(new URL(path, root)))
    .digest('hex');
async function filesUnder(relativeDirectory) {
  const output = [];
  async function walk(relativePath) {
    for (const entry of await readdir(new URL(relativePath, root), { withFileTypes: true })) {
      const child = `${relativePath}${entry.name}`;
      if (entry.isDirectory()) await walk(`${child}/`);
      else output.push(child);
    }
  }
  await walk(relativeDirectory);
  return output.sort();
}
const historicalPaths = [
  'benchmarks/recall-matching/cases.v1.json',
  ...(await filesUnder('benchmarks/recall-matching/results/')),
  ...(await filesUnder('benchmarks/recall-matching/phase-9-1/')),
];
const phase15Paths = [
  'benchmarks/recall-matching/phase-15/development.v2.json',
  'benchmarks/recall-matching/phase-15/holdout.v2.json',
  'benchmarks/recall-matching/phase-15/stress.v2.json',
  'benchmarks/recall-matching/phase-15/sources.normalized.json',
  'benchmarks/recall-matching/phase-15/benchmark.schema.json',
  'benchmarks/recall-matching/phase-15/policy.v1.json',
];
const promptPolicyPaths = [
  'supabase/functions/_shared/matching/deterministicMatcher.ts',
  'supabase/functions/_shared/matching/evidence.ts',
  'supabase/functions/_shared/matching/aggregation.ts',
  'supabase/functions/_shared/matching/normalization.ts',
  'supabase/functions/_shared/matching/nemotronMatcher.ts',
  'supabase/functions/_shared/matching/nemotronPrompt.ts',
  'supabase/functions/_shared/matching/nemotronSchema.ts',
  'supabase/functions/_shared/matching/guardedNemotronMatcher.ts',
  'supabase/functions/_shared/matching/guardedNemotronPrompt.ts',
  'supabase/functions/_shared/matching/guardedNemotronSchema.ts',
  'supabase/functions/_shared/matching/hybridGuardedMatcher.ts',
  'supabase/functions/_shared/matching/types.ts',
];
const hashEntries = async (paths) =>
  Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await hashPath(path)])));
const manifest = {
  benchmarkVersion: 'recall_safety_benchmark_v2',
  frozenAt: '2026-09-20',
  phase15Artifacts: await hashEntries(phase15Paths),
  promptPolicyArtifacts: await hashEntries(promptPolicyPaths),
  historicalArtifacts: await hashEntries(historicalPaths),
};
await writeFile(
  new URL('./freeze-manifest.json', import.meta.url),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      phase15ArtifactCount: phase15Paths.length,
      promptPolicyArtifactCount: promptPolicyPaths.length,
      historicalArtifactCount: historicalPaths.length,
    },
    null,
    2,
  ),
);
