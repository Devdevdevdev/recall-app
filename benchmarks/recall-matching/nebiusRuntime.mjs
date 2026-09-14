import {
  loadNebiusConfig,
  PHASE_9_NEBIUS_HOST,
  PHASE_9_NEMOTRON_MODEL_ID,
} from '../../supabase/functions/_shared/nebius/config.ts';

export function loadPhase9NebiusConfig(options = {}) {
  return loadNebiusConfig(process.env, {
    expectedHost: PHASE_9_NEBIUS_HOST,
    expectedModelId: PHASE_9_NEMOTRON_MODEL_ID,
    ...options,
  });
}

export function findConfiguredModel(body, modelId) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.data)) return null;
  return (
    body.data.find((model) => model && typeof model === 'object' && model.id === modelId) ?? null
  );
}

export function safeModelMetadata(model) {
  if (!model || typeof model !== 'object') return null;
  return {
    id: typeof model.id === 'string' ? model.id : null,
    object: typeof model.object === 'string' ? model.object : null,
    ownedBy: typeof model.owned_by === 'string' ? model.owned_by : null,
  };
}

export function extractPriceMetadata(model, observedAt) {
  if (!model || typeof model !== 'object') return null;
  const directInputRate = model.input_price_per_million_tokens;
  const directOutputRate = model.output_price_per_million_tokens;
  const nestedPricing = model.pricing && typeof model.pricing === 'object' ? model.pricing : null;
  const rawPromptRate = Number(nestedPricing?.prompt);
  const rawCompletionRate = Number(nestedPricing?.completion);
  const inputRate =
    typeof directInputRate === 'number'
      ? directInputRate
      : Number((rawPromptRate * 1_000_000).toFixed(12));
  const outputRate =
    typeof directOutputRate === 'number'
      ? directOutputRate
      : Number((rawCompletionRate * 1_000_000).toFixed(12));
  if (
    typeof inputRate !== 'number' ||
    !Number.isFinite(inputRate) ||
    inputRate < 0 ||
    typeof outputRate !== 'number' ||
    !Number.isFinite(outputRate) ||
    outputRate < 0
  ) {
    return null;
  }
  return {
    source: 'Nebius Token Factory GET /models?verbose=true',
    observedAt,
    currency: 'USD',
    unit: 'per_million_tokens',
    inputRate,
    outputRate,
  };
}
