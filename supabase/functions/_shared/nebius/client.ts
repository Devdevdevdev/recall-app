import { isAbortLikeError, NebiusError, nebiusErrorForStatus } from './errors.ts';
import type {
  FetchLike,
  NebiusChatRequest,
  NebiusClientDependencies,
  NebiusConfig,
  NebiusRequestResult,
} from './types.ts';

const retryDelayMs = 250;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class NebiusClient {
  readonly #config: NebiusConfig;
  readonly #fetch: FetchLike;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(config: NebiusConfig, dependencies: NebiusClientDependencies = {}) {
    this.#config = config;
    this.#fetch = dependencies.fetch ?? fetch;
    this.#sleep = dependencies.sleep ?? defaultSleep;
  }

  async listModels(verbose = false): Promise<NebiusRequestResult> {
    const endpoint = new URL('models', this.#config.baseUrl);
    if (verbose) endpoint.searchParams.set('verbose', 'true');
    return this.#requestJson(endpoint, { method: 'GET' });
  }

  async createChatCompletion(request: NebiusChatRequest): Promise<NebiusRequestResult> {
    const endpoint = new URL('chat/completions', this.#config.baseUrl);
    return this.#requestJson(endpoint, {
      method: 'POST',
      body: JSON.stringify(request),
      headers: { 'content-type': 'application/json' },
    });
  }

  async #requestJson(endpoint: URL, init: RequestInit): Promise<NebiusRequestResult> {
    let retries = 0;
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#config.requestTimeoutMs);
      try {
        const response = await this.#fetch(endpoint, {
          ...init,
          headers: {
            accept: 'application/json',
            ...init.headers,
            authorization: `Bearer ${this.#config.apiKey}`,
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = nebiusErrorForStatus(response.status);
          if (error.retryable && retries < this.#config.maxRetries) {
            retries += 1;
            await this.#sleep(retryDelayMs * 2 ** (retries - 1));
            continue;
          }
          throw error;
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new NebiusError('invalid_response', 'Nebius returned an invalid JSON response.');
        }
        return { body, retries };
      } catch (error) {
        const safeError =
          error instanceof NebiusError
            ? error
            : isAbortLikeError(error)
              ? new NebiusError('timeout', 'Nebius request timed out.', { retryable: true })
              : new NebiusError('network', 'Nebius request failed at the network boundary.', {
                  retryable: true,
                });
        if (safeError.retryable && retries < this.#config.maxRetries) {
          retries += 1;
          await this.#sleep(retryDelayMs * 2 ** (retries - 1));
          continue;
        }
        throw safeError.retries === retries
          ? safeError
          : new NebiusError(safeError.code, safeError.message, {
              status: safeError.status ?? undefined,
              retryable: safeError.retryable,
              retries,
            });
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}
