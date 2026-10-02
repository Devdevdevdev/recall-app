// CPSC historical backfill manifest builder (Phase 16.13 algorithm, Phase 16.15
// explicit provenance). Every input and output path is supplied by the caller and
// recorded in the manifest exactly as given, with the SHA-256 of the bytes that
// were read. No path is ever defaulted or inferred from an earlier phase.
//
// Inputs:
//   notices    stored CPSC notices ({ external_id, recall_number, ... }[]), a
//              read-only production snapshot
//   capture    fresh, read-only CPSC API capture corroborated against the current
//              official pages (capture-phase-16-13-cpsc-fresh.mjs)
//   pagesFrom  the manifest whose Phase 16.8 official page captures supply the
//              historical page revisions (unchanged since Phase 16.12)
import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalCpscUrl } from '../../supabase/functions/_shared/cpsc/identity.ts';

export const MANIFEST_VERSION = 'phase-16.12-cpsc-backfill-v1';
export const MANIFEST_GENERATION = 'phase-16.15-explicit-provenance-v1';
export const KNOWN_NUMERIC_ID_COLLISIONS = ['10965', '10966', '10967', '10968', '10969', '10970'];

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const REQUIRED_FLAGS = {
  '--notices': 'notices',
  '--capture': 'capture',
  '--pages-from': 'pagesFrom',
  '--out': 'out',
  '--diff-out': 'diffOut',
};

/**
 * Parse explicit CLI paths. Every flag is required; paths are returned relative to
 * `repoRoot` in POSIX form, which is how the manifest records them.
 */
export function parseManifestArgs(argv, { repoRoot, cwd = process.cwd() }) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = REQUIRED_FLAGS[argv[index]];
    if (!key) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argv[index]} requires a path.`);
    if (values[key]) throw new Error(`${argv[index]} was given more than once.`);
    values[key] = value;
    index += 1;
  }
  const missing = Object.entries(REQUIRED_FLAGS)
    .filter(([, key]) => !values[key])
    .map(([flag]) => flag);
  if (missing.length) {
    throw new Error(`Missing required path argument(s): ${missing.join(', ')}.`);
  }
  const resolved = {};
  for (const [key, value] of Object.entries(values)) {
    const relative = path.relative(repoRoot, path.resolve(cwd, value));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`${value} is outside the repository.`);
    }
    resolved[key] = relative.split(path.sep).join('/');
  }
  const outputs = new Set([resolved.out, resolved.diffOut]);
  if (outputs.size !== 2) throw new Error('--out and --diff-out must differ.');
  for (const key of ['notices', 'capture', 'pagesFrom']) {
    if (outputs.has(resolved[key])) throw new Error(`An output path overwrites the ${key} input.`);
  }
  return resolved;
}

/**
 * Build the manifest and its diff against `pagesFrom`. Inputs are
 * `{ path, text }` pairs; `path` is recorded verbatim and `text` is hashed.
 * `legacyPayloads` is optional local Phase 16.8 raw API evidence for the diff only.
 */
export function buildBackfillManifest({
  notices,
  capture: captureInput,
  pagesFrom,
  manifestPath,
  identityAudit,
  sourceAudit,
  legacyPayloads = new Map(),
}) {
  for (const [name, input] of Object.entries({ notices, capture: captureInput, pagesFrom })) {
    if (!input?.path || typeof input.text !== 'string') {
      throw new Error(`The ${name} input needs an explicit path and its text.`);
    }
  }
  if (!manifestPath) throw new Error('The output manifest path is required.');

  const stored = JSON.parse(notices.text);
  const capture = JSON.parse(captureInput.text);
  const previous = JSON.parse(pagesFrom.text);

  // The capture must be of these notices: every stored recall number was captured.
  const captured = new Set(capture.recallNumbers ?? []);
  const uncaptured = [...new Set(stored.map((row) => row.recall_number))]
    .filter((number) => !captured.has(number))
    .sort();
  if (uncaptured.length) {
    throw new Error(
      `STOP: ${captureInput.path} does not cover stored recalls ${uncaptured.join(', ')}.`,
    );
  }

  const entries = capture.recalls.flatMap((recall) =>
    recall.records.map((record) => ({ recallNumber: recall.recallNumber, ...record })),
  );
  const corroborated = entries.filter((entry) => entry.identityStatus === 'corroborated');
  const unresolved = entries.filter((entry) => entry.identityStatus !== 'corroborated');

  const currentObservations = corroborated
    .map((entry) => ({
      apiId: entry.api.apiId,
      recallNumber: entry.recallNumber,
      observedUrl: entry.api.url,
      title: entry.api.title,
      publicationDate: entry.api.recallDate,
      payloadHash: entry.api.payloadHash,
      observedAt: capture.capturedAtUtc,
      corroboration: {
        officialCanonicalUrl: entry.page.canonicalUrl,
        officialPageRawHash: entry.page.rawPageHash,
        officialPageFetchedAt: entry.page.fetchedAt,
        displayedRecallNumber: entry.page.displayedRecallNumber,
      },
    }))
    .sort((a, b) => a.recallNumber.localeCompare(b.recallNumber) || a.apiId.localeCompare(b.apiId));

  for (const observation of currentObservations) {
    if (
      canonicalCpscUrl(observation.observedUrl) !== observation.corroboration.officialCanonicalUrl
    ) {
      throw new Error(`Corroboration mismatch for ${observation.recallNumber}.`);
    }
  }

  const freshApiId = new Map(entries.map((entry) => [entry.recallNumber, entry.api.apiId]));
  const byRecall = new Map();
  for (const row of stored)
    byRecall.set(row.recall_number, [...(byRecall.get(row.recall_number) ?? []), row]);
  const withObservation = new Set(currentObservations.map((item) => item.recallNumber));

  // Consistency of the known structure with the fresh API.
  const apiDriftRows = stored
    .filter((row) => freshApiId.get(row.recall_number) !== row.external_id)
    .map((row) => row.external_id)
    .sort();
  const exercisedDriftRows = stored
    .filter(
      (row) =>
        withObservation.has(row.recall_number) &&
        freshApiId.get(row.recall_number) !== row.external_id,
    )
    .map((row) => row.external_id)
    .sort();
  const duplicateGroups = [...byRecall]
    .filter(([, rows]) => rows.length > 1)
    .map(([number]) => number)
    .sort();
  const collisions = entries
    .filter((entry) =>
      stored.some(
        (row) => row.external_id === entry.api.apiId && row.recall_number !== entry.recallNumber,
      ),
    )
    .map((entry) => entry.api.apiId)
    .sort((a, b) => Number(a) - Number(b));
  const knownDrift = identityAudit.driftCases.map((item) => item.storedExternalId).sort();
  const knownGroups = identityAudit.duplicateGroups.map((item) => item.officialRecallNumber).sort();
  const consistency = {
    driftRows: {
      known: knownDrift.length,
      freshApi: apiDriftRows.length,
      consistent: JSON.stringify(apiDriftRows) === JSON.stringify(knownDrift),
      exercisedByManifest: exercisedDriftRows.length,
      withheldWithUnresolvedObservation: apiDriftRows.filter(
        (id) => !exercisedDriftRows.includes(id),
      ),
    },
    duplicateGroups: {
      known: knownGroups,
      fresh: duplicateGroups,
      consistent: JSON.stringify(duplicateGroups) === JSON.stringify(knownGroups),
    },
    numericIdCollisions: {
      known: KNOWN_NUMERIC_ID_COLLISIONS,
      fresh: collisions,
      consistent: JSON.stringify(collisions) === JSON.stringify(KNOWN_NUMERIC_ID_COLLISIONS),
    },
  };
  if (
    !consistency.driftRows.consistent ||
    !consistency.duplicateGroups.consistent ||
    !consistency.numericIdCollisions.consistent
  ) {
    const error = new Error(
      'STOP: the fresh capture is materially different from the known identity structure.',
    );
    error.consistency = consistency;
    throw error;
  }

  const unresolvedIdentities = unresolved.map((entry) => ({
    recallNumber: entry.recallNumber,
    apiId: entry.api.apiId,
    apiUrl: entry.api.url,
    apiCanonicalUrl: entry.page?.canonicalUrl ?? null,
    officialPageFinalUrl: entry.page?.finalUrl ?? null,
    officialPageDeclaredCanonicalUrl: entry.page?.declaredCanonicalUrl ?? null,
    officialPageRawHash: entry.page?.rawPageHash ?? null,
    redirectChain: entry.page?.redirectChain ?? [],
    reasons: entry.reasons,
    storedExternalIds: (byRecall.get(entry.recallNumber) ?? [])
      .map((row) => row.external_id)
      .sort(),
    disposition:
      'current observation withheld from the backfill; historical structure and page capture unchanged',
    requiredAction:
      'Human identity reconciliation of the official URL change before any live page ingestion, ' +
      'review, or current observation for this recall.',
  }));

  const manifest = {
    // Schema consumed by private.cpsc_historical_backfill (unchanged since 16.12).
    manifestVersion: MANIFEST_VERSION,
    manifestGeneration: MANIFEST_GENERATION,
    source:
      `Phase 16.8 official page captures (historical page revisions, from ${pagesFrom.path}) + ` +
      `fresh CPSC API capture ${captureInput.path} corroborated against the current official ` +
      'pages (public data only)',
    freshCapture: {
      file: captureInput.path,
      capturedAtUtc: capture.capturedAtUtc,
      sha256: sha256(captureInput.text),
    },
    noticeSnapshot: {
      file: notices.path,
      notices: stored.length,
      sha256: sha256(notices.text),
    },
    pagesSource: {
      file: pagesFrom.path,
      sha256: sha256(pagesFrom.text),
    },
    expected: {
      storedNotices: stored.length,
      canonicalIdentities: byRecall.size,
      canonicalPages: previous.pages.length,
      recallsWithoutPageCapture: [...byRecall.keys()]
        .filter((number) => !previous.pages.some((page) => page.recallNumber === number))
        .sort(),
      duplicateGroups: duplicateGroups.length,
      currentObservations: currentObservations.length,
      driftRows: exercisedDriftRows.length,
      apiDriftRows: apiDriftRows.length,
      collisions: collisions.length,
      unresolvedIdentities: unresolvedIdentities.length,
    },
    consistency,
    pages: previous.pages,
    currentObservations,
    unresolvedIdentities,
  };

  // --- Old vs fresh diff (manifest observations, and 16.8 API vs fresh API).
  const oldByKey = new Map(previous.currentObservations.map((item) => [item.recallNumber, item]));
  const freshByKey = new Map(currentObservations.map((item) => [item.recallNumber, item]));
  const reconstructed = new Set(
    previous.currentObservations
      .filter(
        (item) =>
          !identityAudit.driftCases.some(
            (drift) => drift.officialRecallNumber === item.recallNumber,
          ),
      )
      .map((item) => item.recallNumber),
  );
  const rows = [];
  for (const entry of entries) {
    const before = oldByKey.get(entry.recallNumber);
    const after = freshByKey.get(entry.recallNumber);
    const legacy = legacyPayloads.get(entry.recallNumber);
    const audit = sourceAudit.noticeRows.find((row) => row.cpscRecallNumber === entry.recallNumber);
    rows.push({
      recallNumber: entry.recallNumber,
      identityStatus: entry.identityStatus,
      apiId: { old: before?.apiId ?? null, fresh: entry.api.apiId },
      observedUrl: {
        old: before?.observedUrl ?? null,
        fresh: entry.api.url,
        oldWasReconstructed: reconstructed.has(entry.recallNumber),
      },
      title: {
        old: before?.title ?? null,
        fresh: entry.api.title,
        oldSource: 'official page (16.12 manifest)',
        freshSource: 'CPSC API',
      },
      publicationDate: { old: before?.publicationDate ?? null, fresh: entry.api.recallDate },
      payloadHash: {
        old: before?.payloadHash ?? null,
        fresh: entry.api.payloadHash,
        phase168: audit?.liveApiPayloadSha256 ?? null,
      },
      phase168Api: legacy
        ? {
            apiId: String(legacy.RecallID),
            url: legacy.URL,
            title: legacy.Title,
            recallDate: String(legacy.RecallDate).slice(0, 10),
            lastPublishDate: String(legacy.LastPublishDate).slice(0, 10),
          }
        : null,
      freshApi: {
        url: entry.api.url,
        title: entry.api.title,
        recallDate: entry.api.recallDate,
        lastPublishDate: entry.api.lastPublishDate,
      },
      includedInFreshManifest: Boolean(after),
    });
  }
  const changed = (field) =>
    rows
      .filter((row) => row[field].old !== null && row[field].old !== row[field].fresh)
      .map((row) => row.recallNumber);
  const apiChanged = (field) =>
    rows
      .filter((row) => row.phase168Api && row.phase168Api[field] !== row.freshApi[field])
      .map((row) => row.recallNumber);
  const diff = {
    diffVersion: 'phase-16.13-manifest-diff-v1',
    oldManifest: pagesFrom.path,
    freshManifest: manifestPath,
    summary: {
      recallNumbers: rows.length,
      unchangedIdentities: rows
        .filter(
          (row) =>
            row.identityStatus === 'corroborated' &&
            row.apiId.old === row.apiId.fresh &&
            row.observedUrl.old === row.observedUrl.fresh &&
            row.publicationDate.old === row.publicationDate.fresh,
        )
        .map((row) => row.recallNumber),
      changedApiIds: changed('apiId'),
      changedUrls: changed('observedUrl'),
      changedTitles: changed('title'),
      changedDates: changed('publicationDate'),
      changedPayloadHashes: changed('payloadHash'),
      reconstructedUrlsReplaced: rows.filter((row) => row.observedUrl.oldWasReconstructed).length,
      reconstructedUrlsThatDifferedFromFreshApi: rows
        .filter(
          (row) =>
            row.observedUrl.oldWasReconstructed && row.observedUrl.old !== row.observedUrl.fresh,
        )
        .map((row) => row.recallNumber),
      newRecalls: rows
        .filter((row) => !oldByKey.has(row.recallNumber))
        .map((row) => row.recallNumber),
      disappearedRecalls: previous.currentObservations
        .filter(
          (item) =>
            !capture.recalls.some(
              (recall) => recall.recallNumber === item.recallNumber && recall.apiRecordCount > 0,
            ),
        )
        .map((item) => item.recallNumber),
      unresolvedIdentityConflicts: unresolvedIdentities.map((item) => item.recallNumber),
      phase168ApiVsFresh: {
        compared: rows.filter((row) => row.phase168Api).length,
        changedApiIds: rows
          .filter((row) => row.phase168Api && row.phase168Api.apiId !== row.apiId.fresh)
          .map((row) => row.recallNumber),
        changedUrls: apiChanged('url'),
        changedTitles: apiChanged('title'),
        changedRecallDates: apiChanged('recallDate'),
        changedLastPublishDates: apiChanged('lastPublishDate'),
        changedPayloadHashes: rows
          .filter(
            (row) => row.payloadHash.phase168 && row.payloadHash.phase168 !== row.payloadHash.fresh,
          )
          .map((row) => row.recallNumber),
      },
    },
    consistency,
    rows,
  };

  return { manifest, diff };
}

// Semantic (operational) content: everything private.cpsc_historical_backfill reads,
// plus the identity-structure expectations. Provenance metadata is excluded.
export function manifestOperationalView(manifest) {
  return {
    manifestVersion: manifest.manifestVersion,
    expected: manifest.expected,
    consistency: manifest.consistency,
    pages: manifest.pages,
    currentObservations: manifest.currentObservations,
    unresolvedIdentities: manifest.unresolvedIdentities,
  };
}
