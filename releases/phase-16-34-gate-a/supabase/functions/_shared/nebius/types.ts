export type NebiusEnvironment = Readonly<Record<string, string | undefined>>;

export type NebiusConfig = {
  apiKey: string;
  baseUrl: URL;
  modelId: string;
  requestTimeoutMs: number;
  maxRetries: number;
};

export type NebiusUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
};

export type NebiusRequestResult = {
  body: unknown;
  retries: number;
};

export type NebiusChatRequest = {
  model: string;
  messages: readonly {
    role: 'system' | 'user';
    content: string;
  }[];
  response_format?: unknown;
  tools?: readonly {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: unknown;
      strict: boolean;
    };
  }[];
  tool_choice?: {
    type: 'function';
    function: { name: string };
  };
  temperature: number;
  max_tokens: number;
  stream: false;
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type NebiusClientDependencies = {
  fetch?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
};
