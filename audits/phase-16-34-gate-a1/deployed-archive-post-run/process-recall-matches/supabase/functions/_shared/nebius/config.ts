import { NebiusError } from './errors.ts';
import type { NebiusConfig, NebiusEnvironment } from './types.ts';

export const DEFAULT_NEBIUS_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_NEBIUS_MAX_RETRIES = 2;
export const PHASE_9_NEMOTRON_MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';
export const PHASE_9_NEBIUS_HOST = 'api.tokenfactory.us-central1.nebius.com';

export type LoadNebiusConfigOptions = {
  expectedModelId?: string;
  expectedHost?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
};

function required(environment: NebiusEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new NebiusError(
      'invalid_request',
      `Required server environment variable ${name} is missing.`,
    );
  }
  return value;
}

export function loadNebiusConfig(
  environment: NebiusEnvironment,
  options: LoadNebiusConfigOptions = {},
): NebiusConfig {
  const apiKey = required(environment, 'NEBIUS_API_KEY');
  const modelId = required(environment, 'NEBIUS_MODEL_ID');
  const rawBaseUrl = required(environment, 'NEBIUS_BASE_URL');
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new NebiusError('invalid_request', 'NEBIUS_BASE_URL is not a valid URL.');
  }

  if (
    baseUrl.protocol !== 'https:' ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new NebiusError(
      'invalid_request',
      'NEBIUS_BASE_URL must be a credential-free HTTPS URL without a query or fragment.',
    );
  }
  if (options.expectedHost && baseUrl.hostname !== options.expectedHost) {
    throw new NebiusError(
      'invalid_request',
      `NEBIUS_BASE_URL host is not the required ${options.expectedHost} host.`,
    );
  }
  if (options.expectedModelId && modelId !== options.expectedModelId) {
    throw new NebiusError(
      'invalid_request',
      `NEBIUS_MODEL_ID is not the required ${options.expectedModelId} model.`,
    );
  }

  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/u, '')}/`;
  return {
    apiKey,
    baseUrl,
    modelId,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_NEBIUS_REQUEST_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? DEFAULT_NEBIUS_MAX_RETRIES,
  };
}

export function safeNebiusEndpoint(config: NebiusConfig): string {
  return `${config.baseUrl.protocol}//${config.baseUrl.host}${config.baseUrl.pathname}`;
}
