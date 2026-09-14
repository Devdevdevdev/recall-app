import { NebiusClient } from '../../supabase/functions/_shared/nebius/client.ts';
import { safeNebiusEndpoint } from '../../supabase/functions/_shared/nebius/config.ts';
import {
  findConfiguredModel,
  loadPhase9NebiusConfig,
  safeModelMetadata,
} from './nebiusRuntime.mjs';

const config = loadPhase9NebiusConfig({ requestTimeoutMs: 15_000, maxRetries: 0 });
const client = new NebiusClient(config);
const response = await client.listModels();
const target = findConfiguredModel(response.body, config.modelId);

console.log(
  JSON.stringify({
    endpointReachable: true,
    endpoint: `${safeNebiusEndpoint(config)}models`,
    targetModelAvailable: Boolean(target),
    modelId: config.modelId,
    modelMetadata: safeModelMetadata(target),
  }),
);
if (!target) process.exitCode = 2;
