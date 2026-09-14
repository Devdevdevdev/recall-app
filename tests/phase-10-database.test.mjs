import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/migrations/20260914100000_phase_10_recall_matching.sql',
  import.meta.url,
);

async function migrationSql() {
  return readFile(migrationUrl, 'utf8');
}

test('Phase 10 migration adds a nullable, canonical SHA-256 fingerprint', async () => {
  const sql = await migrationSql();

  assert.match(sql, /alter table public\.recall_matches\s+add column evidence_fingerprint text/u);
  assert.match(sql, /evidence_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.doesNotMatch(
    sql,
    /alter table public\.recall_matches\s+add column evidence_fingerprint text not null/u,
  );
});

test('the concurrency lease table is private and inaccessible to client roles', async () => {
  const sql = await migrationSql();

  assert.match(sql, /create schema if not exists private/u);
  assert.match(sql, /create table private\.recall_matching_leases/u);
  assert.match(sql, /alter table private\.recall_matching_leases enable row level security/u);
  assert.match(sql, /revoke all on schema private from public, anon, authenticated, service_role/u);
  assert.match(
    sql,
    /revoke all on table private\.recall_matching_leases\s+from public, anon, authenticated, service_role/u,
  );
  assert.doesNotMatch(
    sql,
    /grant [^;]+recall_matching_leases[^;]+to (?:public|anon|authenticated)/u,
  );
});

test('matching RPCs are service-role-only security definers with fixed search paths', async () => {
  const sql = await migrationSql();
  const rpcNames = [
    'get_recall_matching_batch',
    'get_recall_candidates',
    'claim_recall_match_evaluation',
    'finalize_recall_match_evaluation',
  ];

  for (const rpcName of rpcNames) {
    assert.match(sql, new RegExp(`create function public\\.${rpcName}\\(`, 'u'));
    assert.match(
      sql,
      new RegExp(
        `create function public\\.${rpcName}\\([\\s\\S]+?security definer[\\s\\S]+?set search_path = ''`,
        'u',
      ),
    );
    assert.match(sql, new RegExp(`grant execute on function public\\.${rpcName}\\(`, 'u'));
  }

  assert.match(
    sql,
    /revoke all on function public\.get_recall_matching_batch\([^)]+\)\s+from public, anon, authenticated/u,
  );
  assert.match(
    sql,
    /revoke all on function public\.get_recall_candidates\([^)]+\)\s+from public, anon, authenticated/u,
  );
  assert.match(
    sql,
    /revoke all on function public\.claim_recall_match_evaluation\([^)]+\)\s+from public, anon, authenticated/u,
  );
  assert.match(
    sql,
    /revoke all on function public\.finalize_recall_match_evaluation\([^)]+\)\s+from public, anon, authenticated/u,
  );
});

test('candidate retrieval is authoritative, keyset-paginated, canonical, and hard capped', async () => {
  const sql = await migrationSql();

  assert.match(sql, /recall_source\.is_authoritative/u);
  assert.match(sql, /recall_notice\.id > p_after_recall_id/u);
  assert.match(sql, /recall_notice\.id = any \(p_recall_notice_ids\)/u);
  assert.match(sql, /candidate_products\.exact_rank < p_after_exact_rank/u);
  assert.match(sql, /candidate_products\.owned_product_id > p_after_product_id/u);
  assert.match(sql, /least\(greatest\(coalesce\(p_limit, 1\), 1\), 100\)/u);
  assert.match(sql, /least\(greatest\(coalesce\(p_limit, 1\), 1\), 250\)/u);
  assert.match(sql, /jsonb_agg\([\s\S]+order by[\s\S]+scope_sort_key/u);
  assert.doesNotMatch(sql, /'scopeId'/u);
  assert.doesNotMatch(sql, /'retrievedAt'/u);
  assert.match(sql, /exact_rank/u);
  assert.match(sql, /to_tsvector\('simple'/u);
  assert.match(sql, /string_agg\(pg_catalog\.quote_literal\([^)]+\), ' \| '\)/u);
  assert.match(
    sql,
    /candidate_scope\.serial_from is not null or candidate_scope\.serial_to is not null/u,
  );
});

test('claiming is idempotent and stale leases can be reclaimed without duplicate active claims', async () => {
  const sql = await migrationSql();

  assert.match(sql, /status := 'unchanged'/u);
  assert.match(sql, /on conflict \(owned_product_id, recall_notice_id\) do update/u);
  assert.match(sql, /where recall_matching_leases\.lease_expires_at <= pg_catalog\.now\(\)/u);
  assert.match(sql, /status := 'busy'/u);
  assert.match(sql, /least\(greatest\(coalesce\(p_lease_seconds, 120\), 30\), 300\)/u);
});

test('finalization is atomic, rejects stale claims, and preserves existing alert state', async () => {
  const sql = await migrationSql();

  assert.match(sql, /lease_token = p_lease_token/u);
  assert.match(sql, /evidence_fingerprint = p_evidence_fingerprint/u);
  assert.match(sql, /lease_expires_at > pg_catalog\.now\(\)/u);
  assert.match(sql, /status := 'stale'/u);
  assert.match(sql, /on conflict \(owned_product_id, recall_notice_id\)\s+do update/u);
  assert.match(sql, /if p_status = 'confirmed'::public\.recall_match_status then/u);
  assert.match(sql, /on conflict \(recall_match_id\) do nothing/u);
  assert.doesNotMatch(sql, /on conflict \(recall_match_id\)[\s\S]+do update/u);
  assert.match(sql, /alert_outcome := 'existing'/u);
  assert.match(sql, /alert_outcome := 'created'/u);
  assert.match(sql, /alert_outcome := 'none'/u);
  assert.match(sql, /candidate is not a final production evaluation status/u);
  assert.match(sql, /guarded hybrid evaluations require the approved Nebius model provenance/u);
});

test('the migration leaves client RLS ownership policies in force', async () => {
  const sql = await migrationSql();

  assert.doesNotMatch(sql, /disable row level security/u);
  assert.doesNotMatch(sql, /drop policy/u);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete)[^;]+recall_matches[^;]+authenticated/u);
  assert.doesNotMatch(sql, /grant insert[^;]+alerts[^;]+authenticated/u);
});
