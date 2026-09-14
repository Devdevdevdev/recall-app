import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import {
  comparePredictions,
  simulateHybridPolicy,
} from '../benchmarks/recall-matching/comparison.ts';
import { asBenchmarkDataset } from '../benchmarks/recall-matching/dataset.ts';
import { projectBenchmarkCaseForNemotron } from '../benchmarks/recall-matching/nemotronProjection.ts';
import { extractPriceMetadata } from '../benchmarks/recall-matching/nebiusRuntime.mjs';
import {
  evaluateNemotronMatch,
  extractNebiusUsage,
} from '../supabase/functions/_shared/matching/nemotronMatcher.ts';
import { buildNemotronMessages } from '../supabase/functions/_shared/matching/nemotronPrompt.ts';
import { validateNemotronOutput } from '../supabase/functions/_shared/matching/nemotronSchema.ts';

const rawDataset = JSON.parse(
  await readFile(new URL('../benchmarks/recall-matching/cases.v1.json', import.meta.url), 'utf8'),
);
const benchmarkSchema = JSON.parse(
  await readFile(
    new URL('../benchmarks/recall-matching/benchmark.schema.json', import.meta.url),
    'utf8',
  ),
);
const dataset = asBenchmarkDataset(rawDataset, benchmarkSchema);
const committedNemotronResult = JSON.parse(
  await readFile(
    new URL('../benchmarks/recall-matching/results/nemotron-v1.json', import.meta.url),
    'utf8',
  ),
);

const identifiers = () => ({ gtin: [], modelNumber: [], serialNumber: [], lotNumber: [] });
const validOutput = (overrides = {}) => ({
  decision: 'needs_review',
  confidence: 0.4,
  matchedIdentifiers: identifiers(),
  conflictingIdentifiers: identifiers(),
  evidenceUsed: [],
  reasoningSummary: 'The supplied evidence is incomplete.',
  ...overrides,
});

function completion(content, usage = undefined) {
  return {
    body: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'test-call',
                type: 'function',
                function: { name: 'submit_recall_match_evaluation', arguments: content },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      ...(usage ? { usage } : {}),
    },
    retries: 0,
  };
}

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys));
  else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
}

async function collectSourceFiles(directoryUrl) {
  const files = [];
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  for (const entry of entries) {
    const entryUrl = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directoryUrl);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(entryUrl)));
    else if (/\.(?:ts|tsx|js|jsx)$/u.test(entry.name)) files.push(entryUrl);
  }
  return files;
}

test('benchmark projection and serialized model request exclude all evaluation labels', () => {
  const benchmarkCase = dataset.cases[0];
  const projected = projectBenchmarkCaseForNemotron(dataset, benchmarkCase);
  const keys = collectKeys(projected);
  for (const forbidden of [
    'caseId',
    'officialRecallExternalId',
    'expected',
    'reason',
    'notes',
    'labelProvenance',
    'baselinePrediction',
    'metrics',
    'confusionMatrix',
  ]) {
    assert.equal(keys.has(forbidden), false, `${forbidden} leaked into the projected input`);
  }
  const messages = buildNemotronMessages(projected);
  const userPayload = JSON.parse(messages[1].content.split('\n').slice(1).join('\n'));
  assert.deepEqual(userPayload, projected);
  assert.equal(messages[1].content.includes(benchmarkCase.caseId), false);
  assert.equal(messages[1].content.includes(benchmarkCase.reason), false);
});

test('strict output validation accepts the exact MatchEvaluation core', () => {
  const result = validateNemotronOutput(validOutput());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.decision, 'needs_review');
    assert.equal(result.value.confidence, 0.4);
  }
});

test('strict output validation rejects missing, unknown, and malformed fields', () => {
  const missing = validOutput();
  delete missing.reasoningSummary;
  assert.equal(validateNemotronOutput(missing).ok, false);
  assert.equal(validateNemotronOutput(validOutput({ decision: 'maybe' })).ok, false);
  assert.equal(validateNemotronOutput(validOutput({ confidence: 1.1 })).ok, false);
  assert.equal(validateNemotronOutput(validOutput({ reasoningSummary: ' ' })).ok, false);
  assert.equal(validateNemotronOutput(validOutput({ extra: true })).ok, false);
  assert.equal(
    validateNemotronOutput(
      validOutput({ matchedIdentifiers: { ...identifiers(), unexpected: ['value'] } }),
    ).ok,
    false,
  );
});

test('matcher adds provider metadata outside model-controlled output', async () => {
  let request;
  const client = {
    createChatCompletion: async (value) => {
      request = value;
      return completion(JSON.stringify(validOutput({ decision: 'confirmed', confidence: 0.8 })), {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      });
    },
  };
  const input = projectBenchmarkCaseForNemotron(dataset, dataset.cases[0]);
  const attempt = await evaluateNemotronMatch(input, client, 'nvidia/test-model');
  assert.equal(attempt.structuredOutputValid, true);
  assert.equal(attempt.evaluation.matchMethod, 'nemotron_v1');
  assert.equal(attempt.evaluation.aiProvider, 'nebius');
  assert.equal(attempt.evaluation.aiModel, 'nvidia/test-model');
  assert.equal(attempt.evaluation.promptVersion, '1.0.0');
  assert.equal(request.model, 'nvidia/test-model');
  assert.equal(request.temperature, 0);
  assert.equal(request.tools[0].function.strict, true);
  assert.equal(request.tools[0].function.name, 'submit_recall_match_evaluation');
  assert.equal(request.tool_choice.function.name, 'submit_recall_match_evaluation');
});

test('invalid JSON and schema failures become disclosed safe fallbacks', async () => {
  const input = projectBenchmarkCaseForNemotron(dataset, dataset.cases[0]);
  const invalidJson = await evaluateNemotronMatch(
    input,
    { createChatCompletion: async () => completion('not-json') },
    'nvidia/test-model',
  );
  assert.equal(invalidJson.evaluation.decision, 'needs_review');
  assert.equal(invalidJson.structuredOutputValid, false);
  assert.equal(invalidJson.failureKind, 'invalid_json');

  const invalidSchema = await evaluateNemotronMatch(
    input,
    {
      createChatCompletion: async () =>
        completion(JSON.stringify(validOutput({ decision: 'yes' }))),
    },
    'nvidia/test-model',
  );
  assert.equal(invalidSchema.evaluation.decision, 'needs_review');
  assert.equal(invalidSchema.failureKind, 'schema_violation');
});

test('usage extraction keeps reasoning tokens separate without double-counting', () => {
  assert.deepEqual(
    extractNebiusUsage({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 8,
        total_tokens: 18,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    }),
    { inputTokens: 10, outputTokens: 8, totalTokens: 18, reasoningTokens: 3 },
  );
});

test('live verbose model pricing is normalized to USD per million tokens', () => {
  assert.deepEqual(
    extractPriceMetadata(
      { pricing: { prompt: '0.0000003', completion: '0.0000009' } },
      '2026-09-14T14:37:38.402Z',
    ),
    {
      source: 'Nebius Token Factory GET /models?verbose=true',
      observedAt: '2026-09-14T14:37:38.402Z',
      currency: 'USD',
      unit: 'per_million_tokens',
      inputRate: 0.3,
      outputRate: 0.9,
    },
  );
});

test('technical fallbacks cannot count as correct needs-review answers', async () => {
  const { calculateBenchmarkMetrics } = await import('../benchmarks/recall-matching/metrics.ts');
  const metrics = calculateBenchmarkMetrics([
    {
      caseId: 'technical-fallback',
      expected: 'needs_review',
      predicted: 'needs_review',
      decision: 'needs_review',
      reasoningSummary: 'Provider failure.',
      matchedIdentifiers: {},
      conflictingIdentifiers: {},
      technicalFailure: true,
    },
  ]);
  assert.equal(metrics.exactThreeClassAccuracy, 0);
});

test('comparison and read-only hybrid policy reuse primary predictions', () => {
  const cases = [{ caseId: 'one' }, { caseId: 'two' }];
  const baseline = [
    {
      caseId: 'one',
      expected: 'match',
      predicted: 'needs_review',
      decision: 'needs_review',
      reasoningSummary: 'baseline',
      matchedIdentifiers: {},
      conflictingIdentifiers: {},
    },
    {
      caseId: 'two',
      expected: 'no_match',
      predicted: 'no_match',
      decision: 'rejected',
      reasoningSummary: 'baseline',
      matchedIdentifiers: {},
      conflictingIdentifiers: {},
    },
  ];
  const model = [
    { ...baseline[0], predicted: 'match', decision: 'confirmed' },
    { ...baseline[1], predicted: 'match', decision: 'confirmed' },
  ];
  const comparison = comparePredictions(baseline, model);
  assert.deepEqual(
    comparison.improved.map((item) => item.caseId),
    ['one'],
  );
  assert.deepEqual(
    comparison.worsened.map((item) => item.caseId),
    ['two'],
  );
  const hybrid = simulateHybridPolicy(cases, baseline, model);
  assert.deepEqual(
    hybrid.predictions.map((item) => item.predicted),
    ['match', 'no_match'],
  );
});

test('serialized matcher results never include the API key', async () => {
  const marker = 'secret-marker-that-must-not-leak';
  const attempt = await evaluateNemotronMatch(
    projectBenchmarkCaseForNemotron(dataset, dataset.cases[0]),
    { createChatCompletion: async () => completion(JSON.stringify(validOutput())) },
    'nvidia/test-model',
  );
  assert.equal(JSON.stringify(attempt).includes(marker), false);
});

test('committed result metadata is complete and contains no secret-shaped keys', () => {
  assert.equal(committedNemotronResult.dataset.caseCount, 30);
  assert.equal(
    committedNemotronResult.dataset.sha256,
    'c547d61df8e9eacc1d47d46ec505e409d88cd23795abc20cbbfb4e96f67fb3f8',
  );
  assert.equal(committedNemotronResult.matcher.version, 'nemotron_v1');
  assert.equal(committedNemotronResult.matcher.promptVersion, '1.0.0');
  assert.equal(committedNemotronResult.provider.name, 'nebius');
  assert.equal(committedNemotronResult.provider.modelId, 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(committedNemotronResult.cases.length, 30);
  const keys = collectKeys(committedNemotronResult);
  for (const forbidden of ['apiKey', 'authorization', 'NEBIUS_API_KEY']) {
    assert.equal(keys.has(forbidden), false);
  }
});

test('mobile source contains no Nebius secret access', async () => {
  const repositoryRoot = new URL('../', import.meta.url);
  const candidates = [];
  for (const directory of ['app', 'src']) {
    candidates.push(...(await collectSourceFiles(new URL(`${directory}/`, repositoryRoot))));
  }
  for (const candidate of candidates) {
    assert.equal((await readFile(candidate, 'utf8')).includes('NEBIUS_API_KEY'), false);
  }
});
