import { createClient } from 'npm:@supabase/supabase-js@2';
import { parseMatchingRunRequest } from '../_shared/recallMatching/request.ts';
import {
  productionMatcherPolicy,
  type ProductionMatcherPolicy,
} from '../_shared/recallMatching/policySelector.ts';
import { processRecallMatchesV2 } from '../_shared/recallMatching/orchestratorV2.ts';
import { SupabaseRecallMatchingStoreV2 } from './storeV2.ts';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function secretKey(): string | null {
  const modern = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (modern) {
    try {
      const parsed: unknown = JSON.parse(modern);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const key = (parsed as Record<string, unknown>).default;
        if (typeof key === 'string' && key) return key;
      }
    } catch {
      return null;
    }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null;
}

function authorized(request: Request): boolean {
  const expected = Deno.env.get('RECALL_MATCHING_KEY');
  const provided = request.headers.get('x-recall-matching-key');
  if (!expected || !provided) return false;
  const length = Math.max(expected.length, provided.length);
  let difference = expected.length ^ provided.length;
  for (let i = 0; i < length; i += 1) {
    difference |= (expected.charCodeAt(i) || 0) ^ (provided.charCodeAt(i) || 0);
  }
  return difference === 0;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Only POST is allowed.' });
  if (!authorized(request)) return json(401, { error: 'Unauthorized.' });
  let policy: ProductionMatcherPolicy;
  try {
    policy = productionMatcherPolicy(Deno.env.get('RECALL_MATCHING_POLICY'));
  } catch {
    return json(503, { error: 'Recall matching policy is unavailable.' });
  }
  if (policy === 'phase_10_guarded_v1') {
    const { runLegacyRecallMatching } = await import('./legacyRun.ts');
    return runLegacyRecallMatching(request);
  }
  try {
    const body: unknown = await request.json();
    const input = parseMatchingRunRequest(body);
    if (
      !input.recallNoticeIds?.length ||
      input.maxNebiusCalls !== 0 ||
      input.maxRecalls > 10 ||
      input.maxCandidatePairs > 50
    ) {
      return json(400, { error: 'V2 requires explicit bounded recall IDs and zero AI calls.' });
    }
    const url = Deno.env.get('SUPABASE_URL');
    const key = secretKey();
    if (!url || !key) throw new Error('Server credentials unavailable.');
    const database = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const result = await processRecallMatchesV2(input, new SupabaseRecallMatchingStoreV2(database));
    return json(200, result);
  } catch {
    return json(500, { error: 'Deterministic v2 matching failed closed.' });
  }
});
