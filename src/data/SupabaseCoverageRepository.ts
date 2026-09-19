import { requireSupabaseClient } from '@/src/services/supabase';
import { inferJurisdictionType } from '@/src/features/coverage/coveragePresentation';

import type { CoverageRepository, CoverageSourceRecord } from './CoverageRepository';

type RecallSourceRow = {
  id: string;
  source_key: string;
  name: string;
  jurisdiction: string;
  source_language_code: string | null;
  is_authoritative: boolean;
  is_active: boolean;
};

export class SupabaseCoverageRepository implements CoverageRepository {
  async listActiveSources(): Promise<readonly CoverageSourceRecord[]> {
    const { data, error } = await requireSupabaseClient()
      .from('recall_sources')
      .select(
        'id, source_key, name, jurisdiction, source_language_code, is_authoritative, is_active',
      )
      .eq('is_authoritative', true)
      .eq('is_active', true)
      .order('name');

    if (error) throw error;

    return (data as RecallSourceRow[]).map((source) => ({
      id: source.id,
      sourceKey: source.source_key,
      authority: source.name,
      jurisdictionType: inferJurisdictionType(source.jurisdiction),
      jurisdictionCode: source.jurisdiction,
      sourceLanguageCode: source.source_language_code,
      isActive: source.is_authoritative && source.is_active,
    }));
  }
}

export const coverageRepository: CoverageRepository = new SupabaseCoverageRepository();
