import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { fetchCpscRecalls } from '../_shared/cpsc/client.ts';
import { mapCpscRecall, sourceIdentifier } from '../_shared/cpsc/mapper.ts';
import type { CpscIngestionRequest, CpscIngestionStats } from '../_shared/cpsc/types.ts';
import { isJsonObject, parseCpscIngestionRequest } from '../_shared/cpsc/validation.ts';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const maxReportedErrors = 20;
const maxExamples = 3;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function secretKey(): string | null {
  const modernKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (modernKeys) {
    try {
      const parsed: unknown = JSON.parse(modernKeys);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const defaultKey = (parsed as Record<string, unknown>).default;
        if (typeof defaultKey === 'string' && defaultKey) {
          return defaultKey;
        }
      }
    } catch {
      return null;
    }
  }

  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null;
}

function privilegedClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = secretKey();
  if (!url || !key) {
    throw new Error('Required Supabase server credentials are unavailable.');
  }

  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function authorized(request: Request): boolean {
  const expected = Deno.env.get('RECALL_INGESTION_KEY');
  const provided = request.headers.get('x-recall-ingestion-key');
  return Boolean(expected && provided && expected === provided);
}

function emptyStats(fetched: number): CpscIngestionStats {
  return {
    fetched,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    scopeCount: 0,
    errors: [],
    examples: [],
  };
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return json(405, { error: 'Only POST is allowed.' });
  }
  if (!authorized(request)) {
    return json(401, { error: 'Unauthorized.' });
  }

  let input: CpscIngestionRequest;
  try {
    input = parseCpscIngestionRequest(await request.json());
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : 'Invalid request.' });
  }

  let records: readonly unknown[];
  try {
    records = await fetchCpscRecalls(input);
  } catch (error) {
    return json(502, { error: error instanceof Error ? error.message : 'CPSC retrieval failed.' });
  }

  const stats = emptyStats(records.length);
  let database: SupabaseClient | null = null;
  if (!input.dryRun) {
    try {
      database = privilegedClient();
    } catch {
      return json(500, { error: 'Required Supabase server credentials are unavailable.' });
    }
  }

  if (database) {
    const { error } = await database.rpc('ensure_cpsc_recall_source');
    if (error) {
      return json(500, { error: 'CPSC source registration failed.' });
    }
  }

  for (const record of records) {
    let stableId: string | null = null;
    try {
      if (!isJsonObject(record)) {
        throw new Error('CPSC record is not a JSON object');
      }
      stableId = sourceIdentifier(record);
      const mapped = mapCpscRecall(record);
      stats.scopeCount += mapped.scopes.length;
      if (stats.examples.length < maxExamples) {
        stats.examples.push({
          externalId: mapped.externalId,
          title: mapped.title,
          scopeCount: mapped.scopes.length,
        });
      }

      if (!database) {
        continue;
      }

      const { data, error } = await database.rpc('ingest_cpsc_recall', {
        p_external_id: mapped.externalId,
        p_title: mapped.title,
        p_description: mapped.description,
        p_hazard: mapped.hazard,
        p_remedy: mapped.remedy,
        p_recall_date: mapped.recallDate,
        p_official_url: mapped.officialUrl,
        p_retrieved_at: new Date().toISOString(),
        p_raw_payload: mapped.rawPayload,
        p_scopes: mapped.scopes,
      });
      if (error || !['inserted', 'updated', 'unchanged'].includes(String(data))) {
        throw new Error('database persistence rejected the record');
      }
      if (data === 'inserted') {
        stats.inserted += 1;
      } else if (data === 'updated') {
        stats.updated += 1;
      } else {
        stats.unchanged += 1;
      }
    } catch (error) {
      stats.rejected += 1;
      if (stats.errors.length < maxReportedErrors) {
        stats.errors.push({
          externalId: stableId,
          reason: error instanceof Error ? error.message : 'record validation failed',
        });
      }
    }
  }

  return json(200, { dryRun: input.dryRun, window: input, stats });
});
