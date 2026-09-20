import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { calculatePhase15Metrics } from './dataset.ts';
import { verifyPhase15Freeze } from './freezeGuard.mjs';
import { percentile } from '../metrics.ts';

export const PAID_COMBINED_COST_CAP_USD = 1.6;
export const PHASE_15_MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';
export const splitNames = ['development', 'holdout', 'stress'];

const readJson = async (url) => JSON.parse(await readFile(url, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function loadPaidRunContext() {
  const manifest = await verifyPhase15Freeze();
  const plan = await readJson(new URL('./model-run-plan.json', import.meta.url));
  if (plan.modelId !== PHASE_15_MODEL_ID) throw new Error('Frozen model-run plan model mismatch.');
  const sources = await readJson(new URL('./sources.normalized.json', import.meta.url));
  const sourceByFamily = new Map(sources.sources.map((source) => [source.recallFamilyId, source]));
  const datasets = {};
  const datasetHashes = {};
  for (const split of splitNames) {
    const url = new URL(`./${split}.v2.json`, import.meta.url);
    const bytes = await readFile(url);
    datasetHashes[split] = sha256(bytes);
    if (datasetHashes[split] !== plan.datasets.sha256[split]) {
      throw new Error(`Reviewed ${split} dataset hash mismatch.`);
    }
    datasets[split] = JSON.parse(bytes.toString('utf8'));
  }
  const cases = splitNames.flatMap((split) =>
    datasets[split].cases.map((benchmarkCase) => ({ benchmarkCase, split })),
  );
  if (cases.length !== plan.datasets.caseCount) throw new Error('Reviewed case count mismatch.');
  return { manifest, plan, sources, sourceByFamily, datasets, datasetHashes, cases };
}

export function requirePaidApproval(argumentsList) {
  if (!argumentsList.includes('--approved')) {
    throw new Error('Paid Phase 15 execution requires the explicit --approved flag.');
  }
}

export async function refuseExisting(path) {
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing paid benchmark artifact ${path}.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing')) throw error;
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
  }
}

export async function writeJson(path, value) {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function sumUsage(attempts) {
  const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens'];
  return Object.fromEntries(
    fields.map((field) => [
      field,
      attempts.every((attempt) => attempt.usage[field] !== null)
        ? attempts.reduce((total, attempt) => total + attempt.usage[field], 0)
        : null,
    ]),
  );
}

function stratify(predictions, field) {
  const keys = new Set(
    predictions.flatMap((item) => {
      const value = item[field];
      return Array.isArray(value) ? value : value ? [value] : [];
    }),
  );
  return Object.fromEntries(
    [...keys]
      .sort()
      .map((key) => [
        key,
        calculatePhase15Metrics(
          predictions.filter((item) =>
            Array.isArray(item[field]) ? item[field].includes(key) : item[field] === key,
          ),
        ),
      ]),
  );
}

export function metricsAndStrata(predictions) {
  return {
    metrics: calculatePhase15Metrics(predictions),
    bySplit: Object.fromEntries(
      splitNames.map((split) => [
        split,
        calculatePhase15Metrics(predictions.filter((item) => item.split === split)),
      ]),
    ),
    stratified: {
      evidenceCategory: stratify(predictions, 'evidenceDimensions'),
      sourceAuthority: stratify(predictions, 'authority'),
      split: stratify(predictions, 'split'),
      perturbationFamily: stratify(predictions, 'perturbationType'),
      hardNegative: {
        true: calculatePhase15Metrics(predictions.filter((item) => item.hardNegative)),
      },
      pairedCases: {
        true: calculatePhase15Metrics(predictions.filter((item) => item.pairGroupId)),
      },
    },
  };
}

export function latencySummary(values) {
  return {
    totalMs: values.reduce((total, value) => total + value, 0),
    averageMs: values.length
      ? values.reduce((total, value) => total + value, 0) / values.length
      : 0,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    sampleCount: values.length,
  };
}

export function benchmarkPrediction(benchmarkCase, split, evaluation, technicalFailure = false) {
  const predicted =
    evaluation.decision === 'confirmed'
      ? 'match'
      : evaluation.decision === 'rejected'
        ? 'no_match'
        : 'needs_review';
  return {
    caseId: benchmarkCase.caseId,
    recallFamilyId: benchmarkCase.recallFamilyId,
    externalRecallId: benchmarkCase.externalRecallId,
    authority: benchmarkCase.authority,
    split,
    pairGroupId: benchmarkCase.pairGroupId,
    hardNegative: benchmarkCase.hardNegative,
    evidenceDimensions: benchmarkCase.evidenceDimensions,
    perturbationType: benchmarkCase.perturbationType,
    expected: benchmarkCase.expected,
    predicted,
    technicalFailure,
    decision: evaluation.decision,
    reasoningSummary: evaluation.reasoningSummary,
    matchedIdentifiers: evaluation.matchedIdentifiers,
    conflictingIdentifiers: evaluation.conflictingIdentifiers,
  };
}
