import { requireSupabaseClient } from '@/src/services/supabase';
import { inferJurisdictionType } from '@/src/features/coverage/coveragePresentation';

import type { CoverageRepository, CoverageSourceRecord } from './CoverageRepository';

type RecallSourceRow = {
  id: string;
  name: string;
  jurisdiction: string;
  source_language_code: string | null;
  is_authoritative: boolean;
};

export class SupabaseCoverageRepository implements CoverageRepository {
  async listActiveSources(): Promise<readonly CoverageSourceRecord[]> {
    const { data, error } = await requireSupabaseClient()
      .from('recall_sources')
      .select('id, name, jurisdiction, source_language_code, is_authoritative')
      .eq('is_authoritative', true)
      .order('name');

    if (error) throw error;

    return (data as RecallSourceRow[]).map((source) => ({
      id: source.id,
      authority: source.name,
      jurisdictionType: inferJurisdictionType(source.jurisdiction),
      jurisdictionCode: source.jurisdiction,
      sourceLanguageCode: source.source_language_code,
      isActive: source.is_authoritative,
    }));
  }
}

export const coverageRepository: CoverageRepository = new SupabaseCoverageRepository();
