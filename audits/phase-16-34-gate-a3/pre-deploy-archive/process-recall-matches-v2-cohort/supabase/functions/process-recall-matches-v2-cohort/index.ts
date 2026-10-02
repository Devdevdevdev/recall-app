import { createClient } from 'npm:@supabase/supabase-js@2';
import { parseMatchingRunRequest } from '../_shared/recallMatching/request.ts';
import { processRecallMatchesV2 } from '../_shared/recallMatching/orchestratorV2.ts';
import { SupabaseRecallMatchingStoreV2 } from '../process-recall-matches/storeV2.ts';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function equal(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return difference === 0;
}

function key(): string | null {
  const modern = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (modern) {
    try {
      const parsed: unknown = JSON.parse(modern);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = (parsed as Record<string, unknown>).default;
        if (typeof value === 'string' && value) return value;
      }
    } catch {
      return null;
    }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return response(405, { error: 'Only POST is allowed.' });
  if (Deno.env.get('RECALL_V2_COHORT_ENABLED') !== 'true') {
    return response(503, { error: 'V2 cohort is disabled.' });
  }
  const expected = Deno.env.get('RECALL_V2_COHORT_KEY');
  const provided = request.headers.get('x-recall-v2-cohort-key');
  if (!expected || !provided || !equal(expected, provided)) {
    return response(401, { error: 'Unauthorized.' });
  }
  try {
    const limits = parseMatchingRunRequest(await request.json());
    if (
      !limits.recallNoticeIds?.length ||
      limits.recallNoticeIds.length > 5 ||
      limits.maxRecalls > 5 ||
      limits.maxCandidatePairs > 25 ||
      limits.maxNebiusCalls !== 0
    ) {
      return response(400, { error: 'Explicit cohort bounds and zero AI calls are required.' });
    }
    const url = Deno.env.get('SUPABASE_URL');
    const secret = key();
    if (!url || !secret) throw new Error('Server credentials unavailable.');
    const database = createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return response(
      200,
      await processRecallMatchesV2(
        limits,
        new SupabaseRecallMatchingStoreV2(database),
        undefined,
        false,
      ),
    );
  } catch {
    return response(500, { error: 'V2 cohort failed closed.' });
  }
});
