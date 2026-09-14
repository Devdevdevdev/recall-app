import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { projectBenchmarkCaseForNemotron } from '../benchmarks/recall-matching/nemotronProjection.ts';
import { buildGuardedNemotronMessages } from '../supabase/functions/_shared/matching/guardedNemotronPrompt.ts';
import {
  evaluateHybridGuardedMatch,
  HYBRID_GUARDED_MAX_ORCHESTRATION_RETRIES,
} from '../supabase/functions/_shared/matching/hybridGuardedMatcher.ts';
import {
  evaluateGuardedNemotronMatch,
  GUARDED_NEMOTRON_RESULT_TOOL_NAME,
} from '../supabase/functions/_shared/matching/guardedNemotronMatcher.ts';
import { validateGuardedNemotronOutput } from '../supabase/functions/_shared/matching/guardedNemotronSchema.ts';
import { verifyNemotronConfirmation } from '../supabase/functions/_shared/matching/nemotronSafetyVerifier.ts';

const identifiers = () => ({ gtin: [], modelNumber: [], serialNumber: [], lotNumber: [] });
const developmentDataset = JSON.parse(
  await readFile(
    new URL('../benchmarks/recall-matching/phase-9-1/development.v1.json', import.meta.url),
    'utf8',
  ),
);

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

function input(overrides = {}) {
  return {
    ownedProduct: {
      productName: 'Studio Six Headphone Amplifier',
      brand: 'AudioLineOut',
      category: 'Audio amplifier',
      gtin: null,
      modelNumber: 'ST6',
      serialNumber: null,
      lotNumber: null,
      purchaseDate: '2026-01-15',
      identificationMethod: 'manual',
      ...overrides.ownedProduct,
    },
    officialRecall: {
      recallNoticeId: 'development-notice',
      source: {
        authority: 'CPSC',
        externalId: 'development',
        officialUrl: 'https://www.cpsc.gov/Recalls/development',
      },
      title: 'Studio Six Headphone Amplifiers recalled',
      description: 'Official development fixture.',
      hazard: 'Fixture hazard.',
      remedy: null,
      recallDate: '2026-08-20',
      scopes: [{ productName: 'Studio Six Headphone Amplifiers', brand: 'AudioLineOut' }],
      rawEvidence: {
        explicitCriteria: [
          {
            criterion: 'modelNumber',
            value: 'ST6',
            productName: 'Studio Six Headphone Amplifiers',
            brand: 'AudioLineOut',
            context: 'CPSC explicitly identifies model ST6 for this product.',
          },
        ],
      },
      ...overrides.officialRecall,
    },
  };
}

function claim(overrides = {}) {
  return {
    criterion: 'modelNumber',
    ownedField: 'modelNumber',
    ownedValue: 'ST6',
    claimedOfficialValue: 'ST6',
    sourceKind: 'rawEvidence',
    scopeIndex: null,
    sourceField: 'explicitCriteria',
    sourceIndex: 0,
    ...overrides,
  };
}

function output(overrides = {}) {
  return {
    decision: 'confirmed',
    confidence: 0.85,
    matchedIdentifiers: identifiers(),
    conflictingIdentifiers: identifiers(),
    evidenceUsed: [],
    reasoningSummary: 'The explicit model criterion appears to match.',
    evidenceClaims: [claim()],
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    output: output(),
    structuredOutputValid: true,
    apiSucceeded: true,
    failureKind: null,
    retryEligible: false,
    transportRetries: 0,
    latencyMs: 5,
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: null },
    ...overrides,
  };
}

test('guarded schema requires controlled machine-verifiable evidence references', () => {
  assert.equal(validateGuardedNemotronOutput(output()).ok, true);
  assert.equal(validateGuardedNemotronOutput(output({ evidenceClaims: [] })).ok, true);
  assert.equal(
    validateGuardedNemotronOutput(
      output({ evidenceClaims: [claim({ sourceField: 'invented.path' })] }),
    ).ok,
    false,
  );
  assert.equal(
    validateGuardedNemotronOutput(output({ evidenceClaims: [claim({ criterion: 'saleDate' })] }))
      .ok,
    false,
  );
});

test('guarded serialized requests contain evidence but no benchmark labels or metadata', () => {
  const benchmarkCase = developmentDataset.cases[0];
  const projected = projectBenchmarkCaseForNemotron(developmentDataset, benchmarkCase);
  const messages = buildGuardedNemotronMessages(projected);
  const serialized = messages[1].content;
  const modelInput = JSON.parse(serialized.split('\n').slice(1).join('\n'));
  const keys = collectKeys(modelInput);
  for (const forbidden of [
    'caseId',
    'expected',
    'labelProvenance',
    'reason',
    'notes',
    'baselinePrediction',
    'metrics',
    'confusionMatrix',
  ]) {
    assert.equal(keys.has(forbidden), false);
  }
  assert.equal(serialized.includes(benchmarkCase.caseId), false);
  assert.equal(serialized.includes(benchmarkCase.reason), false);
});

test('verifier independently accepts an exact associated raw model criterion', () => {
  const verification = verifyNemotronConfirmation(input(), output());
  assert.equal(verification.accepted, true);
  assert.equal(verification.verifiedEvidence[0].officialValue, 'ST6');
});

test('verifier rejects name-only, copied-value, and ambiguous-association confirmations', () => {
  assert.equal(verifyNemotronConfirmation(input(), output({ evidenceClaims: [] })).accepted, false);
  assert.equal(
    verifyNemotronConfirmation(
      input(),
      output({ evidenceClaims: [claim({ claimedOfficialValue: 'NOT-ST6' })] }),
    ).accepted,
    false,
  );
  assert.equal(
    verifyNemotronConfirmation(
      input({
        officialRecall: {
          ...input().officialRecall,
          rawEvidence: {
            explicitCriteria: [
              {
                criterion: 'modelNumber',
                value: 'ST6',
                productName: 'Unrelated Receiver',
                brand: 'Other Brand',
                context: 'The value is associated with another product.',
              },
            ],
          },
        },
      }),
      output(),
    ).accepted,
    false,
  );
});

test('purchase date cannot be promoted to manufacture or sale-date evidence', () => {
  const dateLikeClaim = claim({
    criterion: 'modelNumber',
    ownedField: 'modelNumber',
    ownedValue: 'ST6',
    claimedOfficialValue: '2026-01-15',
    sourceKind: 'scope',
    scopeIndex: 0,
    sourceField: 'modelNumber',
    sourceIndex: null,
  });
  const dateInput = input({
    officialRecall: {
      ...input().officialRecall,
      scopes: [
        {
          productName: 'Studio Six Headphone Amplifiers',
          modelNumber: 'ST6',
          manufacturedFrom: '2025-01-01',
          manufacturedTo: '2025-12-31',
        },
      ],
    },
  });
  assert.equal(
    verifyNemotronConfirmation(dateInput, output({ evidenceClaims: [dateLikeClaim] })).accepted,
    false,
  );
});

test('deterministic confirmed and rejected decisions never call Nemotron', async () => {
  let calls = 0;
  const evaluator = async () => {
    calls += 1;
    return attempt();
  };
  const confirmedInput = input({
    officialRecall: {
      ...input().officialRecall,
      scopes: [
        {
          productName: 'Studio Six Headphone Amplifiers',
          brand: 'AudioLineOut',
          modelNumber: 'ST6',
        },
      ],
    },
  });
  const confirmed = await evaluateHybridGuardedMatch(confirmedInput, evaluator, 'test/model');
  assert.equal(confirmed.evaluation.decision, 'confirmed');
  assert.equal(confirmed.trace.aiEscalated, false);

  const rejectedInput = input({
    ownedProduct: { modelNumber: 'OTHER-7' },
    officialRecall: {
      ...input().officialRecall,
      scopes: [
        {
          productName: 'Studio Six Headphone Amplifiers',
          brand: 'AudioLineOut',
          modelNumber: 'ST6',
        },
      ],
    },
  });
  const rejected = await evaluateHybridGuardedMatch(rejectedInput, evaluator, 'test/model');
  assert.equal(rejected.evaluation.decision, 'rejected');
  assert.equal(rejected.trace.aiEscalated, false);
  assert.equal(calls, 0);
});

test('a verified AI confirmation is accepted only after deterministic abstention', async () => {
  const result = await evaluateHybridGuardedMatch(input(), async () => attempt(), 'test/model');
  assert.equal(result.trace.deterministicDecision, 'needs_review');
  assert.equal(result.trace.aiEscalated, true);
  assert.equal(result.evaluation.decision, 'confirmed');
  assert.equal(result.trace.verifierConfirmedEvidence.length, 1);
});

test('AI rejection is advisory and cannot create a production rejection', async () => {
  const result = await evaluateHybridGuardedMatch(
    input(),
    async () => attempt({ output: output({ decision: 'rejected', evidenceClaims: [] }) }),
    'test/model',
  );
  assert.equal(result.evaluation.decision, 'needs_review');
  assert.equal(result.trace.aiDecision, 'rejected');
});

test('eligible model and provider failures retry once then fail safely', async (context) => {
  assert.equal(HYBRID_GUARDED_MAX_ORCHESTRATION_RETRIES, 1);
  for (const failureKind of [
    'network',
    'timeout',
    'rate_limit',
    'provider_server',
    'invalid_response',
    'empty_output',
    'invalid_json',
    'schema_violation',
  ]) {
    await context.test(failureKind, async () => {
      let calls = 0;
      const result = await evaluateHybridGuardedMatch(
        input(),
        async () => {
          calls += 1;
          return attempt({
            output: null,
            structuredOutputValid: false,
            apiSucceeded: !['network', 'timeout', 'rate_limit', 'provider_server'].includes(
              failureKind,
            ),
            failureKind,
            retryEligible: true,
          });
        },
        'test/model',
      );
      assert.equal(result.evaluation.decision, 'needs_review');
      assert.equal(result.nemotronRequestCount, 2);
      assert.equal(result.orchestrationRetries, 1);
      assert.equal(result.attemptHistory.length, 2);
      assert.equal(calls, 2);
    });
  }
});

test('missing provider usage remains unavailable instead of becoming zero', async () => {
  const result = await evaluateHybridGuardedMatch(
    input(),
    async () =>
      attempt({
        usage: {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          reasoningTokens: null,
        },
      }),
    'test/model',
  );
  assert.equal(result.usageComplete, false);
  assert.equal(result.usage.totalTokens, null);
});

test('authentication and configuration failures are not retried', async () => {
  for (const failureKind of ['authentication', 'authorization', 'invalid_request']) {
    const result = await evaluateHybridGuardedMatch(
      input(),
      async () =>
        attempt({
          output: null,
          structuredOutputValid: false,
          apiSucceeded: false,
          failureKind,
          retryEligible: false,
        }),
      'test/model',
    );
    assert.equal(result.evaluation.decision, 'needs_review');
    assert.equal(result.nemotronRequestCount, 1);
  }
});

test('guarded provider response is parsed only from the forced tool call', async () => {
  let request;
  const result = await evaluateGuardedNemotronMatch(
    input(),
    {
      createChatCompletion: async (value) => {
        request = value;
        return {
          retries: 0,
          body: {
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      function: {
                        name: GUARDED_NEMOTRON_RESULT_TOOL_NAME,
                        arguments: JSON.stringify(output()),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
          },
        };
      },
    },
    'test/model',
  );
  assert.equal(result.structuredOutputValid, true);
  assert.equal(result.output.decision, 'confirmed');
  assert.equal(request.tool_choice.function.name, GUARDED_NEMOTRON_RESULT_TOOL_NAME);
  assert.equal(request.tools[0].function.strict, true);
  assert.equal(request.temperature, 0);
});
