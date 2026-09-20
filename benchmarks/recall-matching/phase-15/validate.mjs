import { writeFile } from 'node:fs/promises';

import { auditPhase15Benchmark, validatePhase15Split } from './dataset.ts';

const load = async (name) =>
  JSON.parse(
    await (await import('node:fs/promises')).readFile(new URL(name, import.meta.url), 'utf8'),
  );
const schema = await load('./benchmark.schema.json');
const sources = await load('./sources.normalized.json');
const splits = {
  development: await load('./development.v2.json'),
  holdout: await load('./holdout.v2.json'),
  stress: await load('./stress.v2.json'),
};
const historicalDatasets = await Promise.all([
  load('../cases.v1.json'),
  load('../phase-9-1/development.v1.json'),
  load('../phase-9-1/holdout.v1.json'),
]);
const errors = Object.entries(splits).flatMap(([name, dataset]) =>
  validatePhase15Split(dataset, schema, sources, name).map((error) => `${name}: ${error}`),
);
const audit = auditPhase15Benchmark(splits, sources);
const historicalRecallIds = new Set(
  historicalDatasets.flatMap((dataset) =>
    dataset.recalls.map((recall) => String(recall.source.externalId)),
  ),
);
audit.historicalRecallOverlap = sources.sources
  .map((source) => source.externalRecallId)
  .filter((externalRecallId) => historicalRecallIds.has(externalRecallId));
if (audit.crossSplitRecallFamilyOverlap.length)
  errors.push('Cross-split recall-family overlap is nonzero.');
if (audit.historicalRecallOverlap.length)
  errors.push('Phase 15 reuses historical benchmark recalls.');
if (audit.duplicateCaseIds.length) errors.push('Duplicate case IDs are present.');
if (audit.duplicateEvidenceFingerprints.length)
  errors.push('Duplicate controlled evidence is present.');
if (audit.unsupportedLabelCount) errors.push('Unsupported labels are present.');
if (errors.length) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
await writeFile(new URL('./audit.json', import.meta.url), `${JSON.stringify(audit, null, 2)}\n`);
console.log(JSON.stringify({ valid: true, ...audit }, null, 2));
