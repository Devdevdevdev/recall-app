import { isSupportedCountryCode, type CountryCode } from '@/src/domain';
import { requireSupabaseClient } from '@/src/services/supabase';

import type { UserPreferencesRepository } from './UserPreferencesRepository';

type UserPreferencesRow = {
  default_purchase_country_code: string | null;
};

export class SupabaseUserPreferencesRepository implements UserPreferencesRepository {
  async getDefaultPurchaseCountryCode(): Promise<CountryCode | null> {
    const { data, error } = await requireSupabaseClient()
      .from('user_preferences')
      .select('default_purchase_country_code')
      .maybeSingle();

    if (error) throw error;

    const code = (data as UserPreferencesRow | null)?.default_purchase_country_code ?? null;
    return isSupportedCountryCode(code) ? code : null;
  }

  async setDefaultPurchaseCountryCode(value: CountryCode | null): Promise<void> {
    if (value !== null && !isSupportedCountryCode(value)) {
      throw new Error('Choose a valid country.');
    }

    const client = requireSupabaseClient();
    const { data: authData, error: authError } = await client.auth.getUser();
    if (authError) throw authError;
    if (!authData.user) throw new Error('An authenticated user is required to save preferences.');

    const { error } = await client.from('user_preferences').upsert(
      {
        user_id: authData.user.id,
        default_purchase_country_code: value,
      },
      { onConflict: 'user_id' },
    );

    if (error) throw error;
  }
}

export const userPreferencesRepository: UserPreferencesRepository =
  new SupabaseUserPreferencesRepository();
