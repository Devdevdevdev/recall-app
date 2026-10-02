// CPSC historical backfill manifest (Phase 16.13 algorithm) from
//   a read-only production snapshot of the stored CPSC notices (--notices)
// + the Phase 16.8 official page captures carried by an earlier manifest (--pages-from)
// + a fresh, read-only CPSC API capture corroborated against the current official
//   pages (--capture, from capture-phase-16-13-cpsc-fresh.mjs).
// No current observation is reconstructed: every one is a fresh API value whose
// identity the official page corroborates. A disagreement is listed as
// unresolved and withheld, never guessed. Public CPSC data only.
//
// Phase 16.15: every path is explicit and required; the manifest records each input
// path exactly as given with its SHA-256. Example:
//   npm run backfill:phase-16-13:manifest -- \
//     --notices docs/phase-16-14-cpsc-notice-snapshot.json \
//     --capture docs/phase-16-14-cpsc-fresh-capture.json \
//     --pages-from docs/phase-16-12-backfill-manifest.json \
//     --out docs/phase-16-15-backfill-manifest.json \
//     --diff-out docs/phase-16-15-manifest-diff.json
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { sourcePayloadSha256 } from '../supabase/functions/_shared/recallMatching/reviewedCriteriaV2.ts';
import { buildBackfillManifest, parseManifestArgs } from './lib/cpscBackfillManifest.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const at = (relative) => new URL(relative, new URL('../', import.meta.url));
const paths = parseManifestArgs(process.argv.slice(2), { repoRoot });
const input = async (relative) => ({ path: relative, text: await readFile(at(relative), 'utf8') });

const legacyPayloads = new Map();
for (const file of [
  'phase168-api-2026-09-10.json',
  'phase168-api-2026-09-17.json',
  'phase168-api-2020-08-12.json',
]) {
  try {
    for (const item of JSON.parse(await readFile(`/private/tmp/${file}`, 'utf8'))) {
      legacyPayloads.set(String(item.RecallNumber), item);
    }
  } catch {
    // Optional local evidence of the 16.8 raw API payloads (diff only).
  }
}

let built;
try {
  built = buildBackfillManifest({
    notices: await input(paths.notices),
    capture: await input(paths.capture),
    pagesFrom: await input(paths.pagesFrom),
    manifestPath: paths.out,
    identityAudit: JSON.parse(await readFile(at('docs/phase-16-9-identity-audit.json'), 'utf8')),
    sourceAudit: JSON.parse(await readFile(at('docs/phase-16-8-source-manifest.json'), 'utf8')),
    legacyPayloads,
  });
} catch (error) {
  if (error.consistency) console.error(JSON.stringify(error.consistency, null, 2));
  throw error;
}
const { manifest, diff } = built;

const write = async (relative, value) => {
  await writeFile(at(relative), `${JSON.stringify(value, null, 2)}\n`);
  spawnSync('npx', ['prettier', '--write', relative], { cwd: repoRoot, stdio: 'ignore' });
};
await write(paths.out, manifest);
await write(paths.diffOut, diff);
const written = JSON.parse(await readFile(at(paths.out), 'utf8'));
console.log(
  JSON.stringify(
    {
      manifest: paths.out,
      manifestFileSha256: createHash('sha256')
        .update(await readFile(at(paths.out)))
        .digest('hex'),
      // Equals private.cpsc_canonical_json_sha256(manifest), the DB run's manifestSha256.
      manifestCanonicalSha256: await sourcePayloadSha256(written),
      freshCapture: manifest.freshCapture,
      noticeSnapshot: manifest.noticeSnapshot,
      pagesSource: manifest.pagesSource,
      expected: manifest.expected,
      diff: diff.summary,
    },
    null,
    2,
  ),
);
