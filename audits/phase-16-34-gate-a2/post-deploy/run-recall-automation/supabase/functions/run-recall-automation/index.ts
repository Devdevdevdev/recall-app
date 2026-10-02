import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { parseAutomationRunRequest, runRecallAutomation } from '../_shared/automation/index.ts';
import { RecallAutomationChildren } from './children.ts';
import { SupabaseAutomationStore } from './store.ts';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Required server configuration ${name} is unavailable.`);
  return value;
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
  const expected = Deno.env.get('RECALL_AUTOMATION_KEY');
  const provided = request.headers.get('x-recall-automation-key');
  return Boolean(expected && provided && constantTimeEqual(expected, provided));
}

function functionsRoot(): string {
  const url = new URL(requiredEnvironment('SUPABASE_URL'));
  return `${url.origin}/functions/v1`;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Only POST is allowed.' });
  if (!authorized(request)) return json(401, { error: 'Unauthorized.' });

  let input;
  try {
    const body = await request.text();
    input = parseAutomationRunRequest(body ? JSON.parse(body) : null);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : 'Invalid request.' });
  }

  try {
    const children = new RecallAutomationChildren(functionsRoot(), {
      ingestion: requiredEnvironment('RECALL_INGESTION_KEY'),
      matching: requiredEnvironment('RECALL_MATCHING_KEY'),
      push: requiredEnvironment('RECALL_PUSH_DELIVERY_KEY'),
    });
    const result = await runRecallAutomation(input, {
      store: new SupabaseAutomationStore(privilegedClient()),
      ingest: (childInput) => children.ingest(childInput),
      match: (childInput) => children.match(childInput),
      push: (childInput) => children.push(childInput),
      pushDeliveryGateEnabled: Deno.env.get('RECALL_PUSH_DELIVERY_ENABLED') === 'true',
    });
    console.info('recall_automation_run_complete', {
      status: result.status,
      errorStep: result.errorStep,
      errorCode: result.errorCode,
    });
    return json(result.status === 'failed' ? 502 : 200, result);
  } catch {
    console.error('recall_automation_unhandled_failure');
    return json(500, { error: 'Recall automation failed.' });
  }
});
