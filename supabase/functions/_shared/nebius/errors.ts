export type NebiusErrorCode =
  | 'authentication'
  | 'authorization'
  | 'rate_limit'
  | 'timeout'
  | 'provider_server'
  | 'invalid_request'
  | 'network'
  | 'invalid_response';

export class NebiusError extends Error {
  readonly code: NebiusErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retries: number;

  constructor(
    code: NebiusErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; retries?: number } = {},
  ) {
    super(message);
    this.name = 'NebiusError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.retries = options.retries ?? 0;
  }
}

export function nebiusErrorForStatus(status: number): NebiusError {
  if (status === 401) {
    return new NebiusError('authentication', 'Nebius authentication failed.', { status });
  }
  if (status === 403) {
    return new NebiusError('authorization', 'Nebius access was denied.', { status });
  }
  if (status === 429) {
    return new NebiusError('rate_limit', 'Nebius rate limit was reached.', {
      status,
      retryable: true,
    });
  }
  if ([500, 502, 503, 504].includes(status)) {
    return new NebiusError('provider_server', 'Nebius had a transient server failure.', {
      status,
      retryable: true,
    });
  }
  return new NebiusError('invalid_request', `Nebius request failed with HTTP ${status}.`, {
    status,
  });
}

export function isAbortLikeError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
