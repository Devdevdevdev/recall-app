import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const manifestUrl = new URL('./freeze-manifest.json', import.meta.url);

const hashPath = async (path) =>
  createHash('sha256')
    .update(await readFile(new URL(path, root)))
    .digest('hex');

export async function verifyPhase16Freeze() {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const checks = {
    ...manifest.implementationArtifacts,
    ...manifest.benchmarkArtifacts,
    ...manifest.reviewArtifacts,
  };
  for (const [path, expected] of Object.entries(checks)) {
    const actual = await hashPath(path);
    if (actual !== expected) {
      throw new Error(`Phase 16 freeze mismatch for ${path}: expected ${expected}, got ${actual}.`);
    }
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const manifest = await verifyPhase16Freeze();
  console.log(
    JSON.stringify(
      {
        frozen: true,
        implementationArtifactCount: Object.keys(manifest.implementationArtifacts).length,
        benchmarkArtifactCount: Object.keys(manifest.benchmarkArtifacts).length,
        reviewArtifactCount: Object.keys(manifest.reviewArtifacts).length,
      },
      null,
      2,
    ),
  );
}
