export type CoverageSourceRecord = {
  id: string;
  sourceKey: string;
  authority: string;
  jurisdictionType: 'country' | 'global' | 'region';
  jurisdictionCode: string;
  sourceLanguageCode: string | null;
  isActive: boolean;
};

export interface CoverageRepository {
  listActiveSources(): Promise<readonly CoverageSourceRecord[]>;
}
