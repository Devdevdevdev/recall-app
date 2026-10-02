import { NebiusError } from '../nebius/errors.ts';
import type { NebiusChatRequest, NebiusRequestResult, NebiusUsage } from '../nebius/types.ts';
import { buildNemotronMessages, type NemotronMatchingInput } from './nemotronPrompt.ts';
import { NEMOTRON_MATCH_OUTPUT_SCHEMA, validateNemotronOutput } from './nemotronSchema.ts';
import {
  MATCH_EVALUATION_SCHEMA_VERSION,
  NEBIUS_AI_PROVIDER,
  NEMOTRON_MATCH_METHOD,
  NEMOTRON_PROMPT_VERSION,
  type NemotronMatchEvaluation,
} from './types.ts';

export const NEMOTRON_MAX_OUTPUT_TOKENS = 2_400;
export const NEMOTRON_TEMPERATURE = 0;
export const NEMOTRON_STRUCTURED_OUTPUT_METHOD = 'strict_function_tool';
export const NEMOTRON_RESULT_TOOL_NAME = 'submit_recall_match_evaluation';

export type NemotronFailureKind =
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

export type NemotronMatcherClient = {
  createChatCompletion(request: NebiusChatRequest): Promise<NebiusRequestResult>;
};

export type NemotronAttempt = {
  evaluation: NemotronMatchEvaluation;
  structuredOutputValid: boolean;
  apiSucceeded: boolean;
  failureKind: NemotronFailureKind | null;
  retries: number;
  latencyMs: number;
  usage: NebiusUsage;
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

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function extractNebiusUsage(body: unknown): NebiusUsage {
  if (!isRecord(body) || !isRecord(body.usage)) return { ...emptyUsage };
  const details = isRecord(body.usage.completion_tokens_details)
    ? body.usage.completion_tokens_details
    : null;
  return {
    inputTokens: safeInteger(body.usage.prompt_tokens),
    outputTokens: safeInteger(body.usage.completion_tokens),
    totalTokens: safeInteger(body.usage.total_tokens),
    reasoningTokens: safeInteger(details?.reasoning_tokens),
  };
}

function baseEvaluation(
  modelId: string,
  core: Omit<
    NemotronMatchEvaluation,
    'matchMethod' | 'schemaVersion' | 'aiProvider' | 'aiModel' | 'promptVersion'
  >,
): NemotronMatchEvaluation {
  return {
    ...core,
    matchMethod: NEMOTRON_MATCH_METHOD,
    schemaVersion: MATCH_EVALUATION_SCHEMA_VERSION,
    aiProvider: NEBIUS_AI_PROVIDER,
    aiModel: modelId,
    promptVersion: NEMOTRON_PROMPT_VERSION,
  };
}

function fallback(modelId: string, summary: string): NemotronMatchEvaluation {
  return baseEvaluation(modelId, {
    decision: 'needs_review',
    confidence: 0,
    matchedIdentifiers: {},
    conflictingIdentifiers: {},
    evidenceUsed: [],
    reasoningSummary: summary,
  });
}

function responseMessage(
  body: unknown,
): { refusal: string | null; toolArguments: string | null } | null {
  if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) return null;
  const message = isRecord(body.choices[0].message) ? body.choices[0].message : null;
  if (!message) return null;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCall = toolCalls.length === 1 && isRecord(toolCalls[0]) ? toolCalls[0] : null;
  const toolFunction = toolCall && isRecord(toolCall.function) ? toolCall.function : null;
  return {
    refusal: typeof message.refusal === 'string' ? message.refusal : null,
    toolArguments:
      toolFunction?.name === NEMOTRON_RESULT_TOOL_NAME && typeof toolFunction.arguments === 'string'
        ? toolFunction.arguments
        : null,
  };
}

export async function evaluateNemotronMatch(
  input: NemotronMatchingInput,
  client: NemotronMatcherClient,
  modelId: string,
): Promise<NemotronAttempt> {
  const startedAt = performance.now();
  try {
    const result = await client.createChatCompletion({
      model: modelId,
      messages: buildNemotronMessages(input),
      tools: [
        {
          type: 'function',
          function: {
            name: NEMOTRON_RESULT_TOOL_NAME,
            description:
              'Submit the product-to-authoritative-recall matching evaluation. Call exactly once.',
            parameters: NEMOTRON_MATCH_OUTPUT_SCHEMA.schema,
            strict: true,
          },
        },
      ],
      tool_choice: {
        type: 'function',
        function: { name: NEMOTRON_RESULT_TOOL_NAME },
      },
      temperature: NEMOTRON_TEMPERATURE,
      max_tokens: NEMOTRON_MAX_OUTPUT_TOKENS,
      stream: false,
    });
    const usage = extractNebiusUsage(result.body);
    const message = responseMessage(result.body);
    if (!message) {
      return {
        evaluation: fallback(
          modelId,
          'Nebius returned an unexpected response; human review is required.',
        ),
        structuredOutputValid: false,
        apiSucceeded: true,
        failureKind: 'invalid_response',
        retries: result.retries,
        latencyMs: performance.now() - startedAt,
        usage,
      };
    }
    if (message.refusal) {
      return {
        evaluation: fallback(
          modelId,
          'The model declined the evaluation; human review is required.',
        ),
        structuredOutputValid: false,
        apiSucceeded: true,
        failureKind: 'model_refusal',
        retries: result.retries,
        latencyMs: performance.now() - startedAt,
        usage,
      };
    }
    if (!message.toolArguments?.trim()) {
      return {
        evaluation: fallback(
          modelId,
          'The model returned no structured tool evaluation; human review is required.',
        ),
        structuredOutputValid: false,
        apiSucceeded: true,
        failureKind: 'empty_output',
        retries: result.retries,
        latencyMs: performance.now() - startedAt,
        usage,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message.toolArguments);
    } catch {
      return {
        evaluation: fallback(modelId, 'The model returned invalid JSON; human review is required.'),
        structuredOutputValid: false,
        apiSucceeded: true,
        failureKind: 'invalid_json',
        retries: result.retries,
        latencyMs: performance.now() - startedAt,
        usage,
      };
    }
    const validated = validateNemotronOutput(parsed);
    if (!validated.ok) {
      return {
        evaluation: fallback(
          modelId,
          'The model output failed local schema validation; human review is required.',
        ),
        structuredOutputValid: false,
        apiSucceeded: true,
        failureKind: 'schema_violation',
        retries: result.retries,
        latencyMs: performance.now() - startedAt,
        usage,
      };
    }

    return {
      evaluation: baseEvaluation(modelId, validated.value),
      structuredOutputValid: true,
      apiSucceeded: true,
      failureKind: null,
      retries: result.retries,
      latencyMs: performance.now() - startedAt,
      usage,
    };
  } catch (error) {
    const failureKind = error instanceof NebiusError ? error.code : 'network';
    return {
      evaluation: fallback(
        modelId,
        'The provider request failed safely; human review is required.',
      ),
      structuredOutputValid: false,
      apiSucceeded: false,
      failureKind,
      retries: error instanceof NebiusError ? error.retries : 0,
      latencyMs: performance.now() - startedAt,
      usage: { ...emptyUsage },
    };
  }
}
