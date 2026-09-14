import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const repositoryRoot = new URL('../../../', import.meta.url);
const manifestUrl = new URL('./holdout-manifest.json', import.meta.url);

async function hashFile(path) {
  return createHash('sha256')
    .update(await readFile(new URL(path, repositoryRoot)))
    .digest('hex');
}

export async function verifyPhase91Freeze() {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const checks = {
    [manifest.development.path]: manifest.development.sha256,
    [manifest.holdout.path]: manifest.holdout.sha256,
    ...manifest.historicalArtifacts,
    ...manifest.frozenPolicyFiles,
  };
  for (const [path, expected] of Object.entries(checks)) {
    const actual = await hashFile(path);
    if (actual !== expected) throw new Error(`Phase 9.1 freeze mismatch for ${path}.`);
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const manifest = await verifyPhase91Freeze();
  console.log(
    JSON.stringify({
      frozen: true,
      holdoutSha256: manifest.holdout.sha256,
      policyFileCount: Object.keys(manifest.frozenPolicyFiles).length,
      historicalArtifactCount: Object.keys(manifest.historicalArtifacts).length,
    }),
  );
}
