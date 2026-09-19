import { fetchCpscRecalls } from './client.ts';
import { mapCpscRecall, sourceIdentifier } from './mapper.ts';
import type { JsonObject } from './types.ts';
import type { CanonicalRecallNotice, RecallSourceAdapter } from '../recallSources/types.ts';
import { validateRetrievalRequest } from '../recallSources/validation.ts';

export const cpscRecallSourceAdapter: RecallSourceAdapter<JsonObject> = {
  definition: {
    key: 'cpsc',
    authorityName: 'U.S. Consumer Product Safety Commission (CPSC)',
    authoritativeBaseUrl: 'https://www.cpsc.gov',
    jurisdictionCoverage: [{ type: 'country', code: 'US' }],
    sourceLanguageCode: 'en',
    retrieval: {
      kind: 'date_window',
      maximumWindowDays: 31,
      maximumRecords: 100,
      watermarkKind: 'last_publish_date',
    },
  },

  async retrieve(request) {
    validateRetrievalRequest(request, this.definition.retrieval);
    const records = await fetchCpscRecalls({ ...request, dryRun: true });
    if (records.length > request.maxRecords) {
      throw new Error('CPSC response exceeds the bounded automation record limit.');
    }
    return records.filter((record): record is JsonObject =>
      Boolean(record && typeof record === 'object' && !Array.isArray(record)),
    );
  },

  stableExternalId: sourceIdentifier,

  normalize(record): CanonicalRecallNotice {
    const mapped = mapCpscRecall(record);
    return {
      ...mapped,
      updatedAt: mapped.recallDate,
      scopes: mapped.scopes.map((scope) => ({
        brand: null,
        productName: scope.productName,
        gtin: scope.gtin,
        modelNumber: scope.modelNumber,
        lotFrom: null,
        lotTo: null,
        serialFrom: null,
        serialTo: null,
        additionalCriteria: scope.additionalCriteria,
      })),
      jurisdictions: this.definition.jurisdictionCoverage,
    };
  },

  watermarkFor(_notices, request) {
    return {
      kind: this.definition.retrieval.watermarkKind,
      value: request.endDate,
    };
  },
};
