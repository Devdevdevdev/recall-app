import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { asPhase91Dataset } from './dataset.ts';

const setName = process.argv[2];
if (!['development', 'holdout'].includes(setName)) {
  throw new Error('Usage: validate.mjs development|holdout');
}

const schema = JSON.parse(
  await readFile(new URL('../benchmark.schema.json', import.meta.url), 'utf8'),
);
const historical = JSON.parse(await readFile(new URL('../cases.v1.json', import.meta.url), 'utf8'));
const development = JSON.parse(
  await readFile(new URL('./development.v1.json', import.meta.url), 'utf8'),
);
const forbiddenRecallIds = new Set(historical.recalls.map((recall) => recall.source.externalId));
if (setName === 'holdout') {
  for (const recall of development.recalls) forbiddenRecallIds.add(recall.source.externalId);
}

const datasetUrl = new URL(`./${setName}.v1.json`, import.meta.url);
const datasetText = await readFile(datasetUrl, 'utf8');
const dataset = asPhase91Dataset(JSON.parse(datasetText), schema, {
  name: setName,
  expectedCaseCount: setName === 'development' ? 24 : 36,
  expectedPerClass: setName === 'development' ? 8 : 12,
  forbiddenRecallIds,
});
const sha256 = createHash('sha256').update(datasetText).digest('hex');
console.log(
  JSON.stringify({
    set: setName,
    caseCount: dataset.cases.length,
    sourceCount: dataset.recalls.length,
    distribution: Object.fromEntries(
      ['match', 'no_match', 'needs_review'].map((expected) => [
        expected,
        dataset.cases.filter((benchmarkCase) => benchmarkCase.expected === expected).length,
      ]),
    ),
    sha256,
  }),
);
