import { createClient } from 'npm:@supabase/supabase-js@2';

import { getRecallSourceAdapter } from '../_shared/recallSources/index.ts';
import { isJsonObject } from '../_shared/recallSources/validation.ts';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const responseLimitBytes = 1024 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function secretKey(): string | null {
  const modernKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (modernKeys) {
    try {
      const parsed: unknown = JSON.parse(modernKeys);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = (parsed as Record<string, unknown>).default;
        if (typeof value === 'string' && value) return value;
      }
    } catch {
      return null;
    }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null;
}

function authorized(request: Request): boolean {
  const expected = Deno.env.get('RECALL_INGESTION_KEY');
  const provided = request.headers.get('x-recall-ingestion-key');
  return Boolean(expected && provided && expected === provided);
}

function count(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error('invalid source metrics');
  return Number(value);
}

function subtractDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function laterDate(left: string, right: string): string {
  return left > right ? left : right;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Only POST is allowed.' });
  if (!authorized(request)) return json(401, { error: 'Unauthorized.' });

  let input: { startDate: string; endDate: string; maxRecords: number };
  try {
    const value: unknown = await request.json();
    if (!isJsonObject(value)) throw new Error('Request body must be an object.');
    if (
      typeof value.startDate !== 'string' ||
      typeof value.endDate !== 'string' ||
      !Number.isInteger(value.maxRecords) ||
      Number(value.maxRecords) < 1 ||
      Number(value.maxRecords) > 100
    ) {
      throw new Error('Invalid bounded ingestion request.');
    }
    input = {
      startDate: value.startDate,
      endDate: value.endDate,
      maxRecords: Number(value.maxRecords),
    };
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : 'Invalid request.' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const key = secretKey();
  const ingestionKey = Deno.env.get('RECALL_INGESTION_KEY');
  if (!supabaseUrl || !key || !ingestionKey) {
    return json(500, { error: 'Required server configuration is unavailable.' });
  }
  const database = createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await database.rpc('get_active_recall_source_keys');
  if (error || !Array.isArray(data)) return json(500, { error: 'Active sources unavailable.' });

  const sourceKeys = data.flatMap((row) =>
    row && typeof row === 'object' && typeof row.source_key === 'string' ? [row.source_key] : [],
  );
  const totals = {
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    rejected: 0,
  };
  const affectedRecallIds: string[] = [];
  const sources: Array<Record<string, unknown>> = [];
  const sourceSlots = Math.min(sourceKeys.length, input.maxRecords);
  const baseSourceLimit = sourceSlots > 0 ? Math.floor(input.maxRecords / sourceSlots) : 0;
  const sourceLimitRemainder = sourceSlots > 0 ? input.maxRecords % sourceSlots : 0;

  for (const [sourceIndex, sourceKey] of sourceKeys.entries()) {
    if (sourceIndex >= sourceSlots) {
      sources.push({ sourceKey, status: 'failed', errorCode: 'global_record_limit_reached' });
      continue;
    }
    try {
      const adapter = getRecallSourceAdapter(sourceKey);
      if (!adapter) throw new Error('adapter_unavailable');
      const { data: stateData, error: stateError } = await database.rpc(
        'get_recall_source_sync_state',
        { p_source_key: sourceKey },
      );
      if (stateError) throw new Error('source_state_unavailable');
      const state = Array.isArray(stateData) ? stateData[0] : null;
      const watermark = isJsonObject(state?.watermark) ? state.watermark : null;
      const watermarkValue = typeof watermark?.value === 'string' ? watermark.value : null;
      const maximumStart = subtractDays(
        input.endDate,
        adapter.definition.retrieval.maximumWindowDays - 1,
      );
      const startDate = watermarkValue
        ? laterDate(maximumStart, subtractDays(watermarkValue, 2))
        : laterDate(maximumStart, input.startDate);
      const sourceLimit = baseSourceLimit + (sourceIndex < sourceLimitRemainder ? 1 : 0);
      const response = await fetch(
        `${new URL(supabaseUrl).origin}/functions/v1/ingest-recall-source`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-recall-ingestion-key': ingestionKey,
          },
          body: JSON.stringify({
            sourceKey,
            startDate,
            endDate: input.endDate,
            dryRun: false,
            maxRecords: sourceLimit,
          }),
        },
      );
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > responseLimitBytes) throw new Error('source_response_too_large');
      const body: unknown = JSON.parse(new TextDecoder().decode(buffer));
      if (!response.ok || !isJsonObject(body) || !isJsonObject(body.stats)) {
        throw new Error(`source_http_${response.status}`);
      }
      const stats = body.stats;
      const fetched = count(stats.fetched);
      const inserted = count(stats.inserted);
      const updated = count(stats.updated);
      const unchanged = count(stats.unchanged);
      const rejected = count(stats.rejected);
      const ids = Array.isArray(body.affectedRecallIds)
        ? body.affectedRecallIds.filter((value): value is string => typeof value === 'string')
        : [];
      const accepted = inserted + updated + unchanged;
      totals.fetched += accepted;
      totals.inserted += inserted;
      totals.updated += updated;
      totals.unchanged += unchanged;
      affectedRecallIds.push(...ids);
      sources.push({
        sourceKey,
        status: rejected === 0 ? 'success' : 'failed',
        windowStart: startDate,
        windowEnd: input.endDate,
        fetched,
        inserted,
        updated,
        unchanged,
        rejected,
      });
    } catch (sourceError) {
      const errorCode = sourceError instanceof Error ? sourceError.message : 'source_failed';
      await database.rpc('record_recall_source_sync_result', {
        p_source_key: sourceKey,
        p_status: 'failed',
        p_error_code: errorCode,
        p_metrics: { fetched: 0 },
      });
      sources.push({
        sourceKey,
        status: 'failed',
        errorCode,
      });
    }
  }

  const sourceFailures = sources.filter((source) => source.status === 'failed').length;
  const successfulSources = sources.length - sourceFailures;
  if (successfulSources === 0)
    return json(502, { error: 'All active recall sources failed.', sources });

  return json(200, {
    stats: totals,
    affectedRecallIds,
    sourceFailures,
    successfulSources,
    sources,
  });
});
