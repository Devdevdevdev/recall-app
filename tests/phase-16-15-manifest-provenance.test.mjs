import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildBackfillManifest,
  manifestOperationalView,
  parseManifestArgs,
} from '../scripts/lib/cpscBackfillManifest.mjs';

const root = new URL('../', import.meta.url);
const repoRoot = fileURLToPath(root);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const input = async (path) => ({ path, text: await readFile(new URL(path, root), 'utf8') });
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));

const PHASE_16_14 = {
  notices: 'docs/phase-16-14-cpsc-notice-snapshot.json',
  capture: 'docs/phase-16-14-cpsc-fresh-capture.json',
  pagesFrom: 'docs/phase-16-12-backfill-manifest.json',
};
const OUT = 'docs/phase-16-15-backfill-manifest.json';

async function build(paths = PHASE_16_14, manifestPath = OUT) {
  return buildBackfillManifest({
    notices: await input(paths.notices),
    capture: await input(paths.capture),
    pagesFrom: await input(paths.pagesFrom),
    manifestPath,
    identityAudit: await json('docs/phase-16-9-identity-audit.json'),
    sourceAudit: await json('docs/phase-16-8-source-manifest.json'),
  });
}

const args = (overrides = {}) => {
  const values = {
    '--notices': PHASE_16_14.notices,
    '--capture': PHASE_16_14.capture,
    '--pages-from': PHASE_16_14.pagesFrom,
    '--out': OUT,
    '--diff-out': 'docs/phase-16-15-manifest-diff.json',
    ...overrides,
  };
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .flat();
};

test('every manifest path is required; none is defaulted to an earlier phase', () => {
  for (const flag of ['--notices', '--capture', '--pages-from', '--out', '--diff-out']) {
    assert.throws(
      () => parseManifestArgs(args({ [flag]: undefined }), { repoRoot }),
      new RegExp(`Missing required path argument\\(s\\): ${flag}`),
    );
  }
  assert.deepEqual(parseManifestArgs(args(), { repoRoot }), {
    notices: PHASE_16_14.notices,
    capture: PHASE_16_14.capture,
    pagesFrom: PHASE_16_14.pagesFrom,
    out: OUT,
    diffOut: 'docs/phase-16-15-manifest-diff.json',
  });
});

test('paths resolve from the working directory and outputs never overwrite inputs', () => {
  assert.equal(
    parseManifestArgs(args(), { repoRoot, cwd: `${repoRoot}docs` }).capture,
    'docs/docs/phase-16-14-cpsc-fresh-capture.json',
  );
  assert.throws(
    () => parseManifestArgs(args({ '--out': PHASE_16_14.capture }), { repoRoot }),
    /overwrites the capture input/,
  );
  assert.throws(
    () => parseManifestArgs(args({ '--diff-out': OUT }), { repoRoot }),
    /--out and --diff-out must differ/,
  );
  assert.throws(
    () => parseManifestArgs(args({ '--capture': '/tmp/capture.json' }), { repoRoot }),
    /outside the repository/,
  );
});

test('the CLI refuses to run without explicit paths (no hard-coded fallback)', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--experimental-strip-types',
      'scripts/build-phase-16-13-backfill-manifest.mjs',
      '--notices',
      PHASE_16_14.notices,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required path argument\(s\): --capture/);
});

test('Phase 16.14 capture input -> Phase 16.14 capture reference, never the 16.13 path', async () => {
  const { manifest, diff } = await build();
  const captureText = await readFile(new URL(PHASE_16_14.capture, root), 'utf8');
  assert.equal(manifest.freshCapture.file, 'docs/phase-16-14-cpsc-fresh-capture.json');
  assert.notEqual(manifest.freshCapture.file, 'docs/phase-16-13-cpsc-fresh-capture.json');
  assert.equal(manifest.freshCapture.sha256, sha(captureText));
  assert.equal(manifest.freshCapture.capturedAtUtc, JSON.parse(captureText).capturedAtUtc);
  assert.equal(manifest.noticeSnapshot.file, PHASE_16_14.notices);
  assert.equal(
    manifest.noticeSnapshot.sha256,
    sha(await readFile(new URL(PHASE_16_14.notices, root))),
  );
  assert.equal(manifest.pagesSource.file, PHASE_16_14.pagesFrom);
  const provenance = JSON.stringify({
    source: manifest.source,
    freshCapture: manifest.freshCapture,
    noticeSnapshot: manifest.noticeSnapshot,
    pagesSource: manifest.pagesSource,
  });
  assert.doesNotMatch(provenance, /phase-16-13/);
  assert.equal(diff.freshManifest, OUT);
  assert.equal(diff.oldManifest, PHASE_16_14.pagesFrom);
});

test('the recorded capture path always names the bytes that were hashed', async () => {
  for (const capture of [
    'docs/phase-16-14-cpsc-fresh-capture.json',
    'docs/phase-16-13-cpsc-fresh-capture.json',
  ]) {
    const notices =
      capture === PHASE_16_14.capture
        ? PHASE_16_14.notices
        : 'tests/fixtures/phase-16-10-notices.json';
    const { manifest } = await build({ ...PHASE_16_14, notices, capture });
    assert.equal(manifest.freshCapture.file, capture);
    assert.equal(manifest.freshCapture.sha256, sha(await readFile(new URL(capture, root))));
  }
});

test('the refactored builder reproduces the frozen Phase 16.13 manifest from its own inputs', async () => {
  const { manifest } = await build({
    notices: 'tests/fixtures/phase-16-10-notices.json',
    capture: 'docs/phase-16-13-cpsc-fresh-capture.json',
    pagesFrom: PHASE_16_14.pagesFrom,
  });
  const frozen = await json('docs/phase-16-13-backfill-manifest.json');
  assert.equal(frozen.freshCapture.sha256, manifest.freshCapture.sha256);
  assert.deepEqual(manifestOperationalView(manifest), manifestOperationalView(frozen));
});

test('an older capture that does not cover the snapshot is refused', async () => {
  await assert.rejects(
    build({ ...PHASE_16_14, capture: 'docs/phase-16-13-cpsc-fresh-capture.json' }),
    /does not cover stored recalls 26788, .*26799/,
  );
});

test('the provenance fix leaves the Phase 16.14 operational manifest unchanged', async () => {
  const { manifest } = await build();
  const frozen = await json('docs/phase-16-14-backfill-manifest.json');
  // The frozen 16.14 manifest carries the defect this phase fixes.
  assert.equal(frozen.freshCapture.file, 'docs/phase-16-13-cpsc-fresh-capture.json');
  assert.equal(frozen.freshCapture.sha256, manifest.freshCapture.sha256);
  assert.deepEqual(manifestOperationalView(manifest), manifestOperationalView(frozen));
  assert.equal(manifest.expected.canonicalIdentities, 38);
  assert.equal(manifest.expected.storedNotices, 41);
  assert.equal(manifest.expected.canonicalPages, 27);
  assert.equal(manifest.expected.currentObservations, 37);
  assert.equal(manifest.expected.collisions, 6);
  assert.deepEqual(
    manifest.unresolvedIdentities.map((item) => [item.recallNumber, item.apiId]),
    [['26777', '10987']],
  );
  assert.ok(!manifest.currentObservations.some((item) => item.recallNumber === '26777'));
});

test('remote pgTAP wrapper injects a transaction-scoped extension into the unchanged suite', async () => {
  const { DEFAULT_SUITE, TRANSIENT_PGTAP, summarizeTap, wrapRemoteSuite } =
    await import('../scripts/run-remote-pgtap.mjs');
  const suite = await readFile(new URL(DEFAULT_SUITE, root), 'utf8');
  const wrapped = wrapRemoteSuite(suite);
  const lines = wrapped.split('\n').filter((line) => line.trim() && !line.startsWith('--'));
  assert.deepEqual(lines.slice(0, 2), ['begin;', TRANSIENT_PGTAP]);
  assert.equal(lines.at(-1), 'rollback;');
  // Only the one injected line differs from the reviewed suite.
  assert.equal(wrapped.replace(`${TRANSIENT_PGTAP}\n`, ''), suite);
  assert.match(suite, /select extensions\.plan\(89\);/);

  assert.throws(() => wrapRemoteSuite('select 1;\nrollback;\n'), /must start with BEGIN/);
  assert.throws(() => wrapRemoteSuite('begin;\nselect 1;\ncommit;\n'), /must end with ROLLBACK/);
  assert.throws(() => wrapRemoteSuite('begin;\ncommit;\nrollback;\n'), /must not COMMIT/);
  assert.throws(
    () => wrapRemoteSuite('begin;\ncreate extension pgtap;\nrollback;\n'),
    /must not manage extensions/,
  );

  const tap = 'BEGIN\nCREATE EXTENSION\n 1..2\n ok 1 - a\n ok 2 - b\nROLLBACK\n';
  assert.equal(summarizeTap(tap).passed, true);
  assert.equal(summarizeTap(tap.replace('ROLLBACK\n', '')).passed, false);
  assert.equal(summarizeTap(tap.replace(' ok 2', ' not ok 2')).passed, false);
  assert.equal(summarizeTap(tap.replace('CREATE EXTENSION\n', '')).passed, false);
});
