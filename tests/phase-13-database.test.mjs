import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const phase13Migration = await readFile(
  new URL(
    '../supabase/migrations/20260916120000_phase_13_global_product_model.sql',
    import.meta.url,
  ),
  'utf8',
);
const phase12Migration = await readFile(
  new URL(
    '../supabase/migrations/20260916100000_phase_12_autonomous_recall_monitoring.sql',
    import.meta.url,
  ),
  'utf8',
);
const matchingProjection = await readFile(
  new URL('../supabase/functions/_shared/recallMatching/projection.ts', import.meta.url),
  'utf8',
);
const countryCatalog = await readFile(
  new URL('../src/domain/countries.ts', import.meta.url),
  'utf8',
);

test('Phase 13 adds nullable canonical purchase-country storage without inventing legacy values', () => {
  assert.match(
    phase13Migration,
    /alter table public\.owned_products[\s\S]+add column purchase_country_code text/u,
  );
  assert.match(
    phase13Migration,
    /purchase_country_code is null[\s\S]+purchase_country_code ~ '\^\[A-Z\]\{2\}\$'/u,
  );
  assert.doesNotMatch(phase13Migration, /add column purchase_country_code text\s+not null/u);
  assert.doesNotMatch(
    phase13Migration,
    /update public\.owned_products[\s\S]+purchase_country_code/u,
  );
});

test('country storage is constrained to the supported ISO catalog at the database boundary', () => {
  assert.match(phase13Migration, /create table public\.country_codes/u);
  assert.match(
    phase13Migration,
    /purchase_country_code text references public\.country_codes \(code\)/u,
  );
  assert.match(
    phase13Migration,
    /default_purchase_country_code text references public\.country_codes \(code\)/u,
  );

  const applicationCodes = [...countryCatalog.matchAll(/\{ code: '([A-Z]{2})', name:/gu)].map(
    ([, code]) => code,
  );
  const databaseCatalog = phase13Migration.match(
    /pg_catalog\.unnest\(array\[([\s\S]*?)\]::text\[\]\)/u,
  )?.[1];
  assert.ok(databaseCatalog);
  const databaseCodes = [...databaseCatalog.matchAll(/'([A-Z]{2})'/gu)].map(([, code]) => code);
  assert.deepEqual(databaseCodes, applicationCodes);
});

test('user preferences remain a minimal owner-only default-country record', () => {
  assert.match(phase13Migration, /create table public\.user_preferences/u);
  assert.match(
    phase13Migration,
    /user_id uuid primary key references auth\.users \(id\) on delete cascade/u,
  );
  assert.match(phase13Migration, /default_purchase_country_code text/u);
  assert.match(phase13Migration, /alter table public\.user_preferences enable row level security/u);
  assert.match(phase13Migration, /using \(\(select auth\.uid\(\)\) = user_id\)/u);
  assert.match(phase13Migration, /with check \(\(select auth\.uid\(\)\) = user_id\)/u);
  assert.doesNotMatch(
    phase13Migration,
    /user_preferences[\s\S]{0,500}\b(?:email|display_name|phone|address|secret|token)\b/iu,
  );
});

test('notice jurisdictions are normalized, constrained, unique, and tied to notice lifetime', () => {
  assert.match(phase13Migration, /create table public\.recall_notice_jurisdictions/u);
  assert.match(
    phase13Migration,
    /recall_notice_id uuid not null references public\.recall_notices \(id\) on delete cascade/u,
  );
  assert.match(phase13Migration, /jurisdiction_type text not null/u);
  assert.match(phase13Migration, /jurisdiction_code text not null/u);
  assert.match(phase13Migration, /jurisdiction_type in \('country', 'region', 'global'\)/u);
  assert.match(
    phase13Migration,
    /unique \(recall_notice_id, jurisdiction_type, jurisdiction_code\)/u,
  );
  assert.doesNotMatch(phase13Migration, /jurisdiction(?:s)? jsonb/iu);
});

test('CPSC language and United States jurisdiction backfills are explicit and idempotent', () => {
  assert.match(
    phase13Migration,
    /alter table public\.recall_sources[\s\S]+add column source_language_code text/u,
  );
  assert.match(
    phase13Migration,
    /source_language_code is null[\s\S]+source_language_code ~ '\^\[a-z\]\{2\}\$'/u,
  );
  assert.match(
    phase13Migration,
    /update public\.recall_sources[\s\S]+source_language_code = 'en'[\s\S]+U\.S\. Consumer Product Safety Commission \(CPSC\)/u,
  );
  assert.match(
    phase13Migration,
    /insert into public\.recall_notice_jurisdictions[\s\S]+select[\s\S]+'country'[\s\S]+'US'[\s\S]+from public\.recall_notices/u,
  );
  assert.match(phase13Migration, /on conflict[\s\S]+do nothing/u);
  assert.doesNotMatch(
    phase13Migration,
    /update public\.recall_notices\s+set\s+(?:source_language_code|jurisdiction)/u,
  );
});

test('future CPSC ingestion keeps source language and notice jurisdiction metadata complete', () => {
  assert.match(
    phase13Migration,
    /create or replace function public\.ensure_cpsc_recall_source\(\)[\s\S]+source_language_code/u,
  );
  assert.match(
    phase13Migration,
    /create or replace function public\.ingest_cpsc_recall\([\s\S]+recall_notice_jurisdictions/u,
  );
});

test('the authenticated monitoring projection exposes exactly three safe aggregates', () => {
  assert.match(
    phase13Migration,
    /create function public\.get_monitoring_status\(\)[\s\S]+returns table \(\s*monitoring_enabled boolean,\s*last_successful_check_at timestamptz,\s*active_source_count integer\s*\)/u,
  );
  assert.match(
    phase13Migration,
    /create function public\.get_monitoring_status\(\)[\s\S]+security definer[\s\S]+set search_path = ''/u,
  );
  assert.match(
    phase13Migration,
    /revoke all on function public\.get_monitoring_status\(\) from public, anon, authenticated/u,
  );
  assert.match(
    phase13Migration,
    /grant execute on function public\.get_monitoring_status\(\) to authenticated/u,
  );
  assert.doesNotMatch(
    phase13Migration,
    /returns table \([^)]*(?:secret|token|key|payload|error|run_id|job_id|lease)/iu,
  );
});

test('Phase 13 metadata cannot become matching evidence or trigger fingerprint churn', () => {
  assert.doesNotMatch(matchingProjection, /purchase_country_code|purchaseCountryCode/u);
  assert.doesNotMatch(
    phase13Migration,
    /(?:evidence_fingerprint|buildEvidenceFingerprint|PRODUCTION_MATCHING_POLICY_VERSION)/u,
  );
  assert.doesNotMatch(
    phase13Migration,
    /update public\.recall_matches|delete from public\.recall_matches/u,
  );
});

test('Phase 13 preserves Phase 12 scheduling, controls, and hard limits unchanged', () => {
  assert.match(phase12Migration, /max_recalls_per_run integer not null default 100/u);
  assert.match(phase12Migration, /max_candidate_pairs_per_run integer not null default 500/u);
  assert.match(phase12Migration, /max_ai_escalations_per_run integer not null default 5/u);
  assert.match(phase12Migration, /max_notification_batch_size integer not null default 25/u);
  assert.match(phase12Migration, /'17 \*\/6 \* \* \*'/u);
  assert.doesNotMatch(
    phase13Migration,
    /(?:alter table|update|insert into|delete from) private\.recall_automation_control/u,
  );
  assert.doesNotMatch(phase13Migration, /cron\.(?:schedule|unschedule|alter_job)/u);
});

test('Phase 13 does not weaken Phase 10 RLS or Phase 11 push privacy', () => {
  assert.doesNotMatch(phase13Migration, /disable row level security/u);
  assert.doesNotMatch(phase13Migration, /drop policy/u);
  assert.doesNotMatch(
    phase13Migration,
    /grant [^;]+private\.(?:push_devices|push_deliveries|push_alert_queue)[^;]+authenticated/u,
  );
  assert.doesNotMatch(
    phase13Migration,
    /grant (?:insert|update|delete)[^;]+public\.recall_matches[^;]+authenticated/u,
  );
});
