import 'expo-sqlite/localStorage/install';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { supabaseConfiguration } from './configuration';

export const supabaseClient: SupabaseClient | null =
  supabaseConfiguration.status === 'configured'
    ? createClient(supabaseConfiguration.url, supabaseConfiguration.publishableKey, {
        auth: {
          storage: globalThis.localStorage,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
      })
    : null;

export function requireSupabaseClient(): SupabaseClient {
  if (supabaseClient) {
    return supabaseClient;
  }

  if (supabaseConfiguration.status === 'unconfigured') {
    throw new Error(
      `Supabase is not configured. Missing ${supabaseConfiguration.missingVariables.join(' and ')}.`,
    );
  }

  if (supabaseConfiguration.status === 'invalid') {
    throw new Error(`Supabase is not configured. ${supabaseConfiguration.message}`);
  }

  throw new Error('Supabase client initialization failed.');
}
