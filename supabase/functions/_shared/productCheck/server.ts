import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import type { ProductCheckStores } from './handler.ts';
import { SupabaseProductCheckJobStore, SupabaseProductCheckPairStore } from './supabaseStore.ts';

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

let cached: SupabaseClient | null = null;

/** Server-credential client. Never exposed to, or constructible from, a request. */
export function serverClient(): SupabaseClient {
  if (cached) return cached;
  const url = Deno.env.get('SUPABASE_URL');
  const key = secretKey();
  if (!url || !key) throw new Error('Server credentials unavailable.');
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

export function productCheckStores(): ProductCheckStores {
  const database = serverClient();
  return {
    jobs: new SupabaseProductCheckJobStore(database),
    pairs: new SupabaseProductCheckPairStore(database),
  };
}

/** Asks the auth server to verify the user's access token; returns its user id or null. */
export async function authenticateUser(token: string): Promise<string | null> {
  const { data, error } = await serverClient().auth.getUser(token);
  if (error || !data.user?.id || data.user.role !== 'authenticated') return null;
  return data.user.id;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
