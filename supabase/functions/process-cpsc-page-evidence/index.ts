import postgres from 'npm:postgres@3.4.7';

import { runCpscPageWorker } from '../_shared/cpsc/scheduledPageWorker.ts';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Only these five prepared statements exist in the page worker's DB adapter.
// The login role has no direct table rights and a DB-enforced 4s statement timeout.
function pageDatabase(connectionString: string) {
  const sql = postgres(connectionString, {
    max: 2,
    prepare: false,
    connect_timeout: 2,
    idle_timeout: 2,
  });
  return {
    async rpc(name: string, parameters: Record<string, unknown>) {
      try {
        if (name === 'consume_cpsc_page_stage_ticket') {
          const rows = await sql`
            select public.consume_cpsc_page_stage_ticket(${String(parameters.p_ticket)}::text) as result
          `;
          return { data: rows[0]?.result, error: null };
        }
        if (name === 'claim_cpsc_page_evidence') {
          const rows = await sql`
            select * from public.claim_cpsc_page_evidence(${Number(parameters.p_limit)}::integer)
          `;
          return { data: rows, error: null };
        }
        if (name === 'finish_cpsc_page_attempt') {
          const rows = await sql`
            select public.finish_cpsc_page_attempt(
              ${String(parameters.p_claim_id)}::uuid,
              ${String(parameters.p_outcome)}::text,
              ${parameters.p_http_status === null ? null : Number(parameters.p_http_status)}::integer,
              ${parameters.p_final_url === null ? null : String(parameters.p_final_url)}::text,
              ${parameters.p_raw_page_hash === null ? null : String(parameters.p_raw_page_hash)}::text,
              ${parameters.p_error_code === null ? null : String(parameters.p_error_code)}::text
            ) as result
          `;
          return { data: rows[0]?.result, error: null };
        }
        if (name === 'retain_cpsc_page_transport') {
          const rows = await sql`
            select public.retain_cpsc_page_transport(
              ${String(parameters.p_claim_id)}::uuid,
              ${sql.json(parameters.p_snapshot as Parameters<typeof sql.json>[0])}::jsonb,
              decode(${String(parameters.p_raw_page_hex)}::text, 'hex')
            ) as result
          `;
          return { data: rows[0]?.result, error: null };
        }
        if (name === 'commit_cpsc_page_evidence_verified') {
          const rows = await sql`
            select public.commit_cpsc_page_evidence_verified(
              ${String(parameters.p_claim_id)}::uuid,
              ${sql.json(parameters.p_snapshot as Parameters<typeof sql.json>[0])}::jsonb,
              ${sql.json(parameters.p_revision as Parameters<typeof sql.json>[0])}::jsonb,
              ${sql.json(parameters.p_candidates as Parameters<typeof sql.json>[0])}::jsonb,
              ${sql.json(parameters.p_ledger as Parameters<typeof sql.json>[0])}::jsonb,
              decode(${String(parameters.p_raw_page_hex)}::text, 'hex')
            ) as result
          `;
          return { data: rows[0]?.result, error: null };
        }
        return { data: null, error: new Error('Unsupported page database operation.') };
      } catch (error) {
        return { data: null, error };
      }
    },
    async close() {
      await sql.end({ timeout: 1 });
    },
  };
}

const TICKET = /^[0-9a-f]{64}$/u;

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Only POST is allowed.' });
  // Phase 16.33: a scheduled tick sends a single-use database ticket instead of
  // a static key; its bounds come from the database, never from the body. The
  // static key remains only for supervised manual runs outside pg_net.
  const ticket = request.headers.get('x-cpsc-page-ticket');
  let input: unknown;
  if (ticket !== null) {
    if (!TICKET.test(ticket)) return json(401, { error: 'Unauthorized.' });
  } else {
    const expected = Deno.env.get('CPSC_PAGE_WORKER_KEY');
    const supplied = request.headers.get('x-cpsc-page-worker-key');
    if (!expected || !supplied || supplied !== expected) {
      return json(401, { error: 'Unauthorized.' });
    }
    try {
      input = await request.json();
    } catch {
      return json(400, { error: 'Invalid JSON.' });
    }
  }
  const connectionString = Deno.env.get('CPSC_PAGE_DB_URL');
  if (!connectionString) return json(500, { error: 'Page database capability is unavailable.' });
  try {
    const capability = new URL(connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(capability.protocol) ||
      decodeURIComponent(capability.username) !== 'cpsc_page_worker' ||
      !capability.password
    ) {
      return json(500, { error: 'Page database capability is invalid.' });
    }
  } catch {
    return json(500, { error: 'Page database capability is invalid.' });
  }
  const database = pageDatabase(connectionString);
  try {
    if (ticket !== null) {
      const consumed = await database.rpc('consume_cpsc_page_stage_ticket', { p_ticket: ticket });
      const grant = consumed.data as {
        accepted?: unknown;
        maxPages?: unknown;
        timeBudgetMs?: unknown;
      };
      if (consumed.error || !grant || grant.accepted !== true) {
        return json(401, { error: 'Unauthorized.' });
      }
      input = { maxPages: grant.maxPages, timeBudgetMs: grant.timeBudgetMs };
    }
    const result = await runCpscPageWorker(database, input);
    return json(result.failed > 0 ? 502 : 200, result);
  } catch (error) {
    if (error instanceof Error && /option|bounds/iu.test(error.message)) {
      return json(400, { error: error.message });
    }
    return json(502, { error: 'CPSC page stage failed closed.' });
  } finally {
    await database.close();
  }
});
