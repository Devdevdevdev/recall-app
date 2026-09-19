import type { RecallSourceAdapter } from '../recallSources/types.ts';
import { validateRetrievalRequest } from '../recallSources/validation.ts';
import { fetchHealthCanadaRecalls, fetchHealthCanadaSnapshot } from './client.ts';
import { healthCanadaSourceIdentifier, mapHealthCanadaRecall } from './mapper.ts';
import type { HealthCanadaRecord } from './types.ts';

export const healthCanadaRecallSourceAdapter: RecallSourceAdapter<HealthCanadaRecord> = {
  definition: {
    key: 'health_canada',
    authorityName: 'Health Canada Recalls and Safety Alerts',
    authoritativeBaseUrl: 'https://recalls-rappels.canada.ca',
    jurisdictionCoverage: [{ type: 'country', code: 'CA' }],
    sourceLanguageCode: 'en',
    retrieval: {
      kind: 'date_window',
      maximumWindowDays: 14,
      maximumRecords: 100,
      watermarkKind: 'last_updated_date',
    },
  },

  async retrieve(request) {
    validateRetrievalRequest(request, this.definition.retrieval);
    return fetchHealthCanadaRecalls(request);
  },

  async retrieveWithDiagnostics(request) {
    validateRetrievalRequest(request, this.definition.retrieval);
    return fetchHealthCanadaSnapshot(request);
  },

  stableExternalId: healthCanadaSourceIdentifier,
  normalize: mapHealthCanadaRecall,

  watermarkFor(_notices, request) {
    return {
      kind: this.definition.retrieval.watermarkKind,
      value: request.endDate,
    };
  },
};
