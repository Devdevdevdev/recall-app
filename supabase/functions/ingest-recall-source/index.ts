import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { getRecallSourceAdapter } from '../_shared/recallSources/index.ts';
import { isJsonObject } from '../_shared/recallSources/validation.ts';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const maxReportedErrors = 20;

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
        if (typeof defaultKey === 'string' && defaultKey) return defaultKey;
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
  if (!url || !key) throw new Error('Required Supabase server credentials are unavailable.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function authorized(request: Request): boolean {
  const expected = Deno.env.get('RECALL_INGESTION_KEY');
  const provided = request.headers.get('x-recall-ingestion-key');
  return Boolean(expected && provided && expected === provided);
}

function parseRequest(value: unknown) {
  if (!isJsonObject(value)) throw new Error('Request body must be a JSON object.');
  const sourceKey = value.sourceKey;
  const startDate = value.startDate;
  const endDate = value.endDate;
  const maxRecords = value.maxRecords;
  const dryRun = value.dryRun === undefined ? true : value.dryRun;
  if (typeof sourceKey !== 'string' || !/^[a-z][a-z0-9_]{1,39}$/u.test(sourceKey)) {
    throw new Error('sourceKey is invalid.');
  }
  if (typeof startDate !== 'string' || typeof endDate !== 'string') {
    throw new Error('startDate and endDate are required.');
  }
  if (!Number.isInteger(maxRecords) || Number(maxRecords) < 1 || Number(maxRecords) > 100) {
    throw new Error('maxRecords must be an integer between 1 and 100.');
  }
  if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean.');
  return { sourceKey, startDate, endDate, maxRecords: Number(maxRecords), dryRun };
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Only POST is allowed.' });
  if (!authorized(request)) return json(401, { error: 'Unauthorized.' });

  let input;
  try {
    input = parseRequest(await request.json());
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : 'Invalid request.' });
  }

  const adapter = getRecallSourceAdapter(input.sourceKey);
  if (!adapter) return json(404, { error: 'Recall source adapter is unavailable.' });

  let database: SupabaseClient | null = null;
  if (!input.dryRun) {
    try {
      database = privilegedClient();
      const { data, error } = await database.rpc('get_recall_source_sync_state', {
        p_source_key: input.sourceKey,
      });
      const state = Array.isArray(data) ? data[0] : null;
      if (error || !state || state.is_active !== true) {
        return json(409, { error: 'Recall source is not active for production ingestion.' });
      }
    } catch {
      return json(500, { error: 'Recall source activation could not be verified.' });
    }
  }

  let records;
  let sourceDiagnostics = null;
  try {
    if (input.dryRun && adapter.retrieveWithDiagnostics) {
      const result = await adapter.retrieveWithDiagnostics(input);
      records = result.records;
      sourceDiagnostics = result.diagnostics;
    } else {
      records = await adapter.retrieve(input);
    }
  } catch (error) {
    if (database) {
      await database.rpc('record_recall_source_sync_result', {
        p_source_key: input.sourceKey,
        p_status: 'failed',
        p_error_code: 'retrieval_failed',
        p_metrics: { fetched: 0 },
      });
    }
    return json(502, {
      error: error instanceof Error ? error.message : 'Official source retrieval failed.',
    });
  }

  const stats = {
    fetched: records.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    scopeCount: 0,
    errors: [] as Array<{ externalId: string | null; reason: string }>,
  };
  const notices = [];
  const affectedRecallIds: string[] = [];

  for (const record of records) {
    let externalId: string | null = null;
    try {
      externalId = adapter.stableExternalId(record);
      const notice = adapter.normalize(record);
      notices.push(notice);
      stats.scopeCount += notice.scopes.length;
      if (!database) continue;

      const { data, error } = await database.rpc('ingest_authoritative_recall', {
        p_source_key: input.sourceKey,
        p_external_id: notice.externalId,
        p_title: notice.title,
        p_description: notice.description,
        p_hazard: notice.hazard,
        p_remedy: notice.remedy,
        p_recall_date: notice.recallDate,
        p_official_url: notice.officialUrl,
        p_retrieved_at: new Date().toISOString(),
        p_raw_payload: notice.rawPayload,
        p_scopes: notice.scopes,
        p_jurisdictions: notice.jurisdictions,
      });
      if (error || !['inserted', 'updated', 'unchanged'].includes(String(data))) {
        throw new Error('database persistence rejected the record');
      }
      stats[data as 'inserted' | 'updated' | 'unchanged'] += 1;
      if (data === 'inserted' || data === 'updated') {
        const { data: noticeId, error: identityError } = await database.rpc(
          'get_recall_notice_id',
          { p_source_key: input.sourceKey, p_external_id: notice.externalId },
        );
        if (identityError || typeof noticeId !== 'string') {
          throw new Error('affected recall identity lookup failed');
        }
        affectedRecallIds.push(noticeId);
      }
    } catch (error) {
      stats.rejected += 1;
      if (stats.errors.length < maxReportedErrors) {
        stats.errors.push({
          externalId,
          reason: error instanceof Error ? error.message : 'record validation failed',
        });
      }
    }
  }

  if (database) {
    const complete = stats.rejected === 0;
    const { error } = await database.rpc('record_recall_source_sync_result', {
      p_source_key: input.sourceKey,
      p_status: complete ? 'success' : 'failed',
      p_watermark: complete ? adapter.watermarkFor(notices, input) : null,
      p_error_code: complete ? null : 'record_rejected',
      p_metrics: stats,
    });
    if (error) return json(500, { error: 'Source sync state persistence failed.' });
  }

  return json(200, {
    sourceKey: input.sourceKey,
    dryRun: input.dryRun,
    window: { startDate: input.startDate, endDate: input.endDate },
    stats,
    affectedRecallIds,
    ...(sourceDiagnostics ? { sourceDiagnostics } : {}),
  });
});
