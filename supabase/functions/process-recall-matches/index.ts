import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { createGuardedNebiusEvaluator } from '../_shared/matching/hybridGuardedMatcher.ts';
import { NebiusClient } from '../_shared/nebius/client.ts';
import { loadNebiusConfig } from '../_shared/nebius/config.ts';
import {
  parseMatchingRunRequest,
  processRecallMatches,
  safeMatchingSummary,
} from '../_shared/recallMatching/index.ts';
import { SupabaseRecallMatchingStore } from './store.ts';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const expectedNebiusModel = 'nvidia/nemotron-3-super-120b-a12b';
const expectedNebiusBaseUrl = 'https://api.tokenfactory.us-central1.nebius.com/v1/';
const expectedNebiusHost = 'api.tokenfactory.us-central1.nebius.com';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function secretKey(): string | null {
  const modernKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (modernKeys) {
    try {
      const parsed: unknown = JSON.parse(modernKeys);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const defaultKey = (parsed as Record<string, unknown>).default;
        if (typeof defaultKey === 'string' && defaultKey) return defaultKey;
      }
    } catch {
      return null;
    }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null;
}

function privilegedClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = secretKey();
  if (!url || !key) throw new Error('Required Supabase server credentials are unavailable.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function authorized(request: Request): boolean {
  const expected = Deno.env.get('RECALL_MATCHING_KEY');
  const provided = request.headers.get('x-recall-matching-key');
  return Boolean(expected && provided && constantTimeEqual(expected, provided));
}

function createProductionEvaluator() {
  const config = loadNebiusConfig(
    {
      NEBIUS_API_KEY: Deno.env.get('NEBIUS_API_KEY'),
      NEBIUS_MODEL_ID: Deno.env.get('NEBIUS_MODEL_ID'),
      NEBIUS_BASE_URL: Deno.env.get('NEBIUS_BASE_URL'),
    },
    {
      expectedHost: expectedNebiusHost,
      expectedModelId: expectedNebiusModel,
      maxRetries: 0,
    },
  );
  if (config.baseUrl.toString() !== expectedNebiusBaseUrl) {
    throw new Error('NEBIUS_BASE_URL is not the approved production endpoint.');
  }
  return createGuardedNebiusEvaluator(new NebiusClient(config), config.modelId);
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Only POST is allowed.' });
  if (!authorized(request)) return json(401, { error: 'Unauthorized.' });

  let input;
  try {
    input = parseMatchingRunRequest(await request.json());
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : 'Invalid request.' });
  }

  try {
    const result = await processRecallMatches(input, {
      store: new SupabaseRecallMatchingStore(privilegedClient()),
      modelId: expectedNebiusModel,
      createNemotronEvaluator: createProductionEvaluator,
      logger: {
        info(event, summary) {
          console.info(event, summary);
        },
        error(event, summary) {
          console.error(event, summary);
        },
      },
    });
    return json(200, {
      ...safeMatchingSummary(result),
      unchangedSkipped: result.unchangedSkipped,
      busySkipped: result.busySkipped,
      staleSkipped: result.staleSkipped,
      providerFailures: result.providerFailures,
      limitsReached: result.limitsReached,
      usage: result.usage,
    });
  } catch {
    return json(500, { error: 'Recall matching orchestration failed.' });
  }
});
