import { readFile } from 'node:fs/promises';

import { validateBenchmarkDataset } from './dataset.ts';

const dataset = JSON.parse(await readFile(new URL('./cases.v1.json', import.meta.url), 'utf8'));
const schema = JSON.parse(
  await readFile(new URL('./benchmark.schema.json', import.meta.url), 'utf8'),
);
const errors = validateBenchmarkDataset(dataset, schema);
if (errors.length) {
  throw new Error(`Benchmark dataset validation failed:\n${errors.join('\n')}`);
}

console.log(`Recall matching benchmark dataset is valid (${dataset.cases.length} cases).`);
