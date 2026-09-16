import type { CountryCode } from '@/src/domain';

export interface UserPreferencesRepository {
  getDefaultPurchaseCountryCode(): Promise<CountryCode | null>;
  setDefaultPurchaseCountryCode(value: CountryCode | null): Promise<void>;
}
