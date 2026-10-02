import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
  deliverQueuedRecallNotifications,
  ExpoPushClient,
  parseSendRecallNotificationsRequest,
  SupabasePushDeliveryStore,
} from '../_shared/push/index.ts';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

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
  const expected = Deno.env.get('RECALL_PUSH_DELIVERY_KEY');
  const provided = request.headers.get('x-recall-push-delivery-key');
  return Boolean(expected && provided && constantTimeEqual(expected, provided));
}

function deliveryEnabled(): boolean {
  return Deno.env.get('RECALL_PUSH_DELIVERY_ENABLED') === 'true';
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Only POST is allowed.' });
  if (!authorized(request)) return json(401, { error: 'Unauthorized.' });

  let input;
  try {
    const body = await request.text();
    input = parseSendRecallNotificationsRequest(body ? JSON.parse(body) : null);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : 'Invalid request.' });
  }

  if (!deliveryEnabled()) {
    return json(503, { error: 'Recall push delivery is disabled.' });
  }

  try {
    const summary = await deliverQueuedRecallNotifications(input, {
      store: new SupabasePushDeliveryStore(privilegedClient()),
      provider: new ExpoPushClient({ accessToken: Deno.env.get('EXPO_ACCESS_TOKEN') }),
    });
    console.info('recall_push_delivery_complete', summary);
    return json(200, summary);
  } catch {
    console.error('recall_push_delivery_failed');
    return json(500, { error: 'Recall push delivery failed.' });
  }
});
