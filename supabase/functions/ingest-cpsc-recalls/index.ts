import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { cpscRecallSourceAdapter } from '../_shared/cpsc/adapter.ts';
import { ingestCpscRecallIdentity } from '../_shared/cpsc/ingestionGate.ts';
import { classifyCpscIngestion, emptyOutcomeCounts } from '../_shared/cpsc/sourceOutcome.ts';
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
    quarantined: 0,
    unresolved: 0,
    outcomes: emptyOutcomeCounts(),
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
    records = await cpscRecallSourceAdapter.retrieve({
      startDate: input.startDate,
      endDate: input.endDate,
      maxRecords: input.maxRecords ?? 100,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CPSC retrieval failed.';
    return json(
      message === 'CPSC response exceeds the bounded automation record limit.' ? 422 : 502,
      { error: message },
    );
  }
  if (input.maxRecords !== undefined && records.length > input.maxRecords) {
    return json(422, { error: 'CPSC response exceeds the bounded automation record limit.' });
  }

  const stats = emptyStats(records.length);
  const affectedRecallIds: string[] = [];
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
      stableId = cpscRecallSourceAdapter.stableExternalId(record);
      const mapped = cpscRecallSourceAdapter.normalize(record);
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

      const outcome = await ingestCpscRecallIdentity(database, mapped);
      // Phase 16.16A: a durably retained hold is an outcome, not a rejection.
      const rowOutcome = classifyCpscIngestion(outcome);
      stats.outcomes[rowOutcome] += 1;
      if (outcome.status === 'quarantined') {
        stats.quarantined += 1;
        continue;
      }
      // Only a new canonical identity creates a notice. An existing notice is never
      // rewritten here; its revision is recorded as lineage for later review.
      if (outcome.status === 'inserted') {
        stats.inserted += 1;
        affectedRecallIds.push(outcome.noticeId);
      } else {
        stats.unchanged += 1;
      }
    } catch (error) {
      stats.rejected += 1;
      stats.outcomes.failed += 1;
      if (stats.errors.length < maxReportedErrors) {
        stats.errors.push({
          externalId: stableId,
          reason: error instanceof Error ? error.message : 'record validation failed',
        });
      }
    }
  }

  return json(200, { dryRun: input.dryRun, window: input, stats, affectedRecallIds });
});
