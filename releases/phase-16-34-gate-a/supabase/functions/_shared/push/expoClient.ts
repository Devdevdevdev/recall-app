import type {
  ExpoPushMessage,
  ExpoPushProvider,
  ExpoPushReceipt,
  ExpoPushTicket,
} from './types.ts';
import { isExpoPushToken } from './validation.ts';

const sendUrl = 'https://exp.host/--/api/v2/push/send';
const receiptsUrl = 'https://exp.host/--/api/v2/push/getReceipts';
const maxBatchSize = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function providerError(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.error !== 'string' || !value.error) return undefined;
  return value.error;
}

function parseTicket(value: unknown): ExpoPushTicket {
  if (!isRecord(value) || (value.status !== 'ok' && value.status !== 'error')) {
    throw new ExpoPushRequestError('invalid_response', false);
  }
  if (value.status === 'ok') {
    if (typeof value.id !== 'string' || !value.id) {
      throw new ExpoPushRequestError('invalid_response', false);
    }
    return { status: 'ok', id: value.id };
  }
  if (typeof value.message !== 'string' || !value.message) {
    throw new ExpoPushRequestError('invalid_response', false);
  }
  const error = providerError(value.details);
  return error
    ? { status: 'error', message: value.message, details: { error } }
    : { status: 'error', message: value.message };
}

function parseReceipt(value: unknown): ExpoPushReceipt {
  if (!isRecord(value) || (value.status !== 'ok' && value.status !== 'error')) {
    throw new ExpoPushRequestError('invalid_response', false);
  }
  if (value.status === 'ok') return { status: 'ok' };
  if (typeof value.message !== 'string' || !value.message) {
    throw new ExpoPushRequestError('invalid_response', false);
  }
  const error = providerError(value.details);
  return error
    ? { status: 'error', message: value.message, details: { error } }
    : { status: 'error', message: value.message };
}

export class ExpoPushRequestError extends Error {
  readonly code: string;
  readonly transient: boolean;

  constructor(code: string, transient: boolean) {
    super('Expo Push Service request failed.');
    this.name = 'ExpoPushRequestError';
    this.code = code;
    this.transient = transient;
  }
}

export class ExpoPushClient implements ExpoPushProvider {
  private readonly options: {
    accessToken?: string | null;
    fetch?: typeof fetch;
    timeoutMs?: number;
  };

  constructor(
    options: { accessToken?: string | null; fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.options = options;
  }

  async send(messages: readonly ExpoPushMessage[]): Promise<readonly ExpoPushTicket[]> {
    if (messages.length < 1 || messages.length > maxBatchSize) {
      throw new ExpoPushRequestError('invalid_batch', false);
    }
    if (messages.some((message) => !isExpoPushToken(message.to))) {
      throw new ExpoPushRequestError('invalid_token', false);
    }
    const body = await this.request(sendUrl, messages);
    if (!isRecord(body) || !Array.isArray(body.data) || body.data.length !== messages.length) {
      throw new ExpoPushRequestError('invalid_response', false);
    }
    return body.data.map(parseTicket);
  }

  async getReceipts(
    ticketIds: readonly string[],
  ): Promise<Readonly<Record<string, ExpoPushReceipt>>> {
    if (ticketIds.length < 1 || ticketIds.length > maxBatchSize) {
      throw new ExpoPushRequestError('invalid_batch', false);
    }
    const body = await this.request(receiptsUrl, { ids: ticketIds });
    if (!isRecord(body) || !isRecord(body.data)) {
      throw new ExpoPushRequestError('invalid_response', false);
    }
    return Object.fromEntries(
      Object.entries(body.data).map(([ticketId, receipt]) => [ticketId, parseReceipt(receipt)]),
    );
  }

  private async request(url: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (this.options.accessToken) headers.authorization = `Bearer ${this.options.accessToken}`;

    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ExpoPushRequestError(
          `http_${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new ExpoPushRequestError('invalid_json', false);
      }
    } catch (error) {
      if (error instanceof ExpoPushRequestError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ExpoPushRequestError('timeout', true);
      }
      throw new ExpoPushRequestError('network_error', true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
