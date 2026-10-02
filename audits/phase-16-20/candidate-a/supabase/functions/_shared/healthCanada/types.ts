import type { JsonObject } from '../recallSources/types.ts';

export type HealthCanadaRecord = JsonObject & {
  NID: string;
  Title: string;
  URL: string;
  Organization: string;
  Product: string;
  Issue: string;
  'What you should do': string;
  Category: string;
  'Recall class': string;
  'Last updated': string;
  Archived: string;
};
