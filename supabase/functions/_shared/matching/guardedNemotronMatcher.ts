import { NebiusError } from '../nebius/errors.ts';
import type { NebiusChatRequest, NebiusRequestResult, NebiusUsage } from '../nebius/types.ts';
import { buildGuardedNemotronMessages } from './guardedNemotronPrompt.ts';
import {
  GUARDED_NEMOTRON_OUTPUT_SCHEMA,
  type GuardedNemotronOutput,
  validateGuardedNemotronOutput,
} from './guardedNemotronSchema.ts';
import type { NemotronMatchingInput } from './nemotronPrompt.ts';
import { extractNebiusUsage } from './nemotronMatcher.ts';

export const GUARDED_NEMOTRON_RESULT_TOOL_NAME = 'submit_guarded_recall_match_evaluation';
export const GUARDED_NEMOTRON_MAX_OUTPUT_TOKENS = 2_800;

export type GuardedNemotronFailureKind =
  | 'authentication'
  | 'authorization'
  | 'rate_limit'
  | 'timeout'
  | 'provider_server'
  | 'invalid_request'
  | 'network'
  | 'invalid_response'
  | 'model_refusal'
  | 'empty_output'
  | 'invalid_json'
  | 'schema_violation';

export type GuardedNemotronAttempt = {
  output: GuardedNemotronOutput | null;
  structuredOutputValid: boolean;
  apiSucceeded: boolean;
  failureKind: GuardedNemotronFailureKind | null;
  retryEligible: boolean;
  transportRetries: number;
  latencyMs: number;
  usage: NebiusUsage;
};

export type GuardedNemotronClient = {
  createChatCompletion(request: NebiusChatRequest): Promise<NebiusRequestResult>;
};

const emptyUsage: NebiusUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  reasoningTokens: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseMessage(
  body: unknown,
): { refusal: string | null; arguments: string | null } | null {
  if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) return null;
  const message = isRecord(body.choices[0].message) ? body.choices[0].message : null;
  if (!message) return null;
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const call = calls.length === 1 && isRecord(calls[0]) ? calls[0] : null;
  const fn = call && isRecord(call.function) ? call.function : null;
  return {
    refusal: typeof message.refusal === 'string' ? message.refusal : null,
    arguments:
      fn?.name === GUARDED_NEMOTRON_RESULT_TOOL_NAME && typeof fn.arguments === 'string'
        ? fn.arguments
        : null,
  };
}

function failed(
  startedAt: number,
  failureKind: GuardedNemotronFailureKind,
  options: Partial<
    Pick<GuardedNemotronAttempt, 'apiSucceeded' | 'transportRetries' | 'usage'>
  > = {},
): GuardedNemotronAttempt {
  return {
    output: null,
    structuredOutputValid: false,
    apiSucceeded: options.apiSucceeded ?? true,
    failureKind,
    retryEligible: [
      'rate_limit',
      'timeout',
      'provider_server',
      'network',
      'invalid_response',
      'empty_output',
      'invalid_json',
      'schema_violation',
    ].includes(failureKind),
    transportRetries: options.transportRetries ?? 0,
    latencyMs: performance.now() - startedAt,
    usage: options.usage ?? { ...emptyUsage },
  };
}

export async function evaluateGuardedNemotronMatch(
  input: NemotronMatchingInput,
  client: GuardedNemotronClient,
  modelId: string,
): Promise<GuardedNemotronAttempt> {
  const startedAt = performance.now();
  try {
    const result = await client.createChatCompletion({
      model: modelId,
      messages: buildGuardedNemotronMessages(input),
      tools: [
        {
          type: 'function',
          function: {
            name: GUARDED_NEMOTRON_RESULT_TOOL_NAME,
            description:
              'Submit an advisory recall match with machine-verifiable evidence references.',
            parameters: GUARDED_NEMOTRON_OUTPUT_SCHEMA.schema,
            strict: true,
          },
        },
      ],
      tool_choice: {
        type: 'function',
        function: { name: GUARDED_NEMOTRON_RESULT_TOOL_NAME },
      },
      temperature: 0,
      max_tokens: GUARDED_NEMOTRON_MAX_OUTPUT_TOKENS,
      stream: false,
    });
    const usage = extractNebiusUsage(result.body);
    const message = responseMessage(result.body);
    if (!message)
      return failed(startedAt, 'invalid_response', { usage, transportRetries: result.retries });
    if (message.refusal)
      return failed(startedAt, 'model_refusal', { usage, transportRetries: result.retries });
    if (!message.arguments?.trim())
      return failed(startedAt, 'empty_output', { usage, transportRetries: result.retries });

    let parsed: unknown;
    try {
      parsed = JSON.parse(message.arguments);
    } catch {
      return failed(startedAt, 'invalid_json', { usage, transportRetries: result.retries });
    }
    const validated = validateGuardedNemotronOutput(parsed);
    if (!validated.ok)
      return failed(startedAt, 'schema_violation', { usage, transportRetries: result.retries });
    return {
      output: validated.value,
      structuredOutputValid: true,
      apiSucceeded: true,
      failureKind: null,
      retryEligible: false,
      transportRetries: result.retries,
      latencyMs: performance.now() - startedAt,
      usage,
    };
  } catch (error) {
    const kind = error instanceof NebiusError ? error.code : 'network';
    return failed(startedAt, kind, {
      apiSucceeded: false,
      transportRetries: error instanceof NebiusError ? error.retries : 0,
    });
  }
}
