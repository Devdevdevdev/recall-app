import { NebiusClient } from '../../supabase/functions/_shared/nebius/client.ts';
import { safeNebiusEndpoint } from '../../supabase/functions/_shared/nebius/config.ts';
import { evaluateNemotronMatch } from '../../supabase/functions/_shared/matching/nemotronMatcher.ts';
import { loadPhase9NebiusConfig } from './nebiusRuntime.mjs';

const config = loadPhase9NebiusConfig();
const client = new NebiusClient(config);
const developmentInput = {
  ownedProduct: {
    productName: 'Development fixture electric kettle',
    brand: 'Example Brand',
    category: 'Kitchen appliance',
    gtin: null,
    modelNumber: 'DEV-100',
    serialNumber: null,
    lotNumber: null,
    purchaseDate: null,
    identificationMethod: 'development_fixture',
  },
  officialRecall: {
    recallNoticeId: 'development-fixture-notice',
    source: {
      authority: 'DEVELOPMENT_FIXTURE',
      externalId: 'DEV-NOTICE-1',
      officialUrl: 'https://example.invalid/development-fixture',
    },
    title: 'Development fixture electric kettle recall',
    description: 'Development-only synthetic evidence for validating the provider contract.',
    hazard: 'Development fixture only.',
    remedy: 'Development fixture only.',
    recallDate: '2026-01-01',
    scopes: [
      {
        scopeId: 'development-scope-1',
        brand: 'Example Brand',
        productName: 'Development fixture electric kettle',
        modelNumber: 'DEV-100',
      },
    ],
    rawEvidence: null,
  },
};

const attempt = await evaluateNemotronMatch(developmentInput, client, config.modelId);
console.log(
  JSON.stringify({
    endpoint: `${safeNebiusEndpoint(config)}chat/completions`,
    modelId: config.modelId,
    apiSucceeded: attempt.apiSucceeded,
    structuredOutputValid: attempt.structuredOutputValid,
    decision: attempt.evaluation.decision,
    schemaVersion: attempt.evaluation.schemaVersion,
    usageAvailable: attempt.usage.totalTokens !== null,
    usage: attempt.usage,
    retries: attempt.retries,
    latencyMs: attempt.latencyMs,
    failureKind: attempt.failureKind,
  }),
);
if (!attempt.apiSucceeded || !attempt.structuredOutputValid) process.exitCode = 2;
