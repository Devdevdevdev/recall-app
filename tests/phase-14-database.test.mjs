import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [
  migration,
  remediationMigration,
  authorityValidationMigration,
  phase14PgTap,
  phase12Migration,
  projection,
  coverageRepository,
  automation,
  children,
] = await Promise.all([
  readFile(
    new URL(
      '../supabase/migrations/20260918100000_phase_14_global_recall_network.sql',
      import.meta.url,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      '../supabase/migrations/20260919064629_phase_14_cpsc_official_host_alias.sql',
      import.meta.url,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      '../supabase/migrations/20260919121744_phase_14_fix_cpsc_official_url_authority_validation.sql',
      import.meta.url,
    ),
    'utf8',
  ),
  readFile(
    new URL('../supabase/tests/phase-14-global-recall-network.sql', import.meta.url),
    'utf8',
  ),
  readFile(
    new URL(
      '../supabase/migrations/20260916100000_phase_12_autonomous_recall_monitoring.sql',
      import.meta.url,
    ),
    'utf8',
  ),
  readFile(
    new URL('../supabase/functions/_shared/recallMatching/projection.ts', import.meta.url),
    'utf8',
  ),
  readFile(new URL('../src/data/SupabaseCoverageRepository.ts', import.meta.url), 'utf8'),
  readFile(
    new URL('../supabase/functions/_shared/automation/orchestrator.ts', import.meta.url),
    'utf8',
  ),
  readFile(
    new URL('../supabase/functions/run-recall-automation/children.ts', import.meta.url),
    'utf8',
  ),
]);

test('scan_date is a non-null date with a conservative UTC legacy backfill', () => {
  assert.match(migration, /add column scan_date date/u);
  assert.match(migration, /scan_date = \(created_at at time zone 'UTC'\)::date/u);
  assert.match(migration, /alter column scan_date set default current_date/u);
  assert.match(migration, /alter column scan_date set not null/u);
  assert.match(migration, /disable trigger owned_products_set_updated_at/u);
  assert.match(migration, /enable trigger owned_products_set_updated_at/u);
  assert.doesNotMatch(migration, /update public\.owned_products[\s\S]+set created_at/u);
});

test('created_at is immutable while scan_date remains an ordinary owner-editable column', () => {
  assert.match(migration, /create function public\.protect_owned_product_created_at/u);
  assert.match(migration, /new\.created_at is distinct from old\.created_at/u);
  assert.match(migration, /before update of created_at on public\.owned_products/u);
  assert.doesNotMatch(migration, /before update of scan_date/u);
});

test('scan_date cannot enter matching evidence or trigger reevaluation', () => {
  assert.doesNotMatch(projection, /scan_date|scanDate/u);
  assert.doesNotMatch(
    migration,
    /update public\.recall_matches|delete from public\.recall_matches|matching_fingerprint/u,
  );
});

test('source identities are stable and Health Canada is registered but inactive', () => {
  assert.match(migration, /add column source_key text/u);
  assert.match(migration, /recall_sources_source_key_key unique \(source_key\)/u);
  assert.match(migration, /before update of source_key, name, jurisdiction, base_url/u);
  assert.match(
    migration,
    /'health_canada'[\s\S]+'Health Canada Recalls and Safety Alerts'[\s\S]+'CA'[\s\S]+'https:\/\/recalls-rappels\.canada\.ca'[\s\S]+true,[\s\S]+false,[\s\S]+'en'/u,
  );
  assert.match(migration, /set source_key = 'cpsc', is_active = true/u);
});

test('coverage and monitoring count only genuinely active authoritative sources', () => {
  assert.match(coverageRepository, /\.eq\('is_authoritative', true\)/u);
  assert.match(coverageRepository, /\.eq\('is_active', true\)/u);
  assert.match(migration, /where recall_source\.is_authoritative and recall_source\.is_active/u);
});

test('per-source sync state is private and failed sources cannot advance watermarks', () => {
  assert.match(migration, /create table private\.recall_source_sync_state/u);
  assert.match(
    migration,
    /alter table private\.recall_source_sync_state enable row level security/u,
  );
  assert.match(
    migration,
    /revoke all on table private\.recall_source_sync_state from public, anon, authenticated, service_role/u,
  );
  assert.match(
    migration,
    /when p_status = 'success' then excluded\.watermark[\s\S]+else recall_source_sync_state\.watermark/u,
  );
  assert.doesNotMatch(
    migration,
    /grant (?:select|insert|update|delete)[^;]+private\.recall_source_sync_state[^;]+authenticated/u,
  );
});

test('generic ingestion is service-only, host-checked, and refuses inactive sources', () => {
  assert.match(migration, /create function public\.ingest_authoritative_recall/u);
  assert.match(migration, /and recall_source\.is_active/u);
  assert.match(migration, /raise exception 'recall source is not active'/u);
  assert.match(
    migration,
    /grant execute on function public\.ingest_authoritative_recall[\s\S]+to service_role/u,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.ingest_authoritative_recall[^;]+authenticated/u,
  );
});

test('multi-source automation isolates failures and reports partial success before push', () => {
  assert.match(children, /ingest-recall-sources/u);
  assert.match(automation, /source_partial_failure/u);
  const failureGate = automation.indexOf('if (hasSourceFailure)');
  const pushGate = automation.indexOf('if (claim.pushEnabled');
  assert.ok(failureGate > 0 && pushGate > failureGate);
});

test('approved Phase 12 global ceilings and CPSC compatibility remain unchanged', () => {
  assert.match(phase12Migration, /max_recalls_per_run integer not null default 100/u);
  assert.match(phase12Migration, /max_candidate_pairs_per_run integer not null default 500/u);
  assert.match(phase12Migration, /max_ai_escalations_per_run integer not null default 5/u);
  assert.match(phase12Migration, /max_notification_batch_size integer not null default 25/u);
  assert.doesNotMatch(migration, /drop function public\.ingest_cpsc_recall/u);
  assert.doesNotMatch(migration, /drop function public\.ensure_cpsc_recall_source/u);
  assert.match(
    migration,
    /create or replace function public\.ensure_cpsc_recall_source\(\)[\s\S]+source_key,[\s\S]+'cpsc'/u,
  );
  assert.doesNotMatch(migration, /alter table private\.recall_automation_control/u);
});

test('Phase 14 remains forward-only and preserves security boundaries', () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /commit;\s*$/u);
  assert.doesNotMatch(migration, /disable row level security/u);
  assert.doesNotMatch(migration, /grant [^;]+private\.[^;]+authenticated/u);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete)[^;]+public\.recall_matches/u);
});

test('CPSC remediation permits only the two exact HTTPS authority hosts', () => {
  assert.match(authorityValidationMigration, /v_notice_authority text/u);
  assert.ok(authorityValidationMigration.includes("from '^https://([^/?#[:space:]]+)(?:[/?#]|$)'"));
  assert.match(
    authorityValidationMigration,
    /v_notice_authority not in \('cpsc\.gov', 'www\.cpsc\.gov'\)/u,
  );
  assert.doesNotMatch(authorityValidationMigration, /endsWith|right\(|like\s+'%cpsc\.gov'/iu);
  for (const url of [
    'https://cpsc.gov/Recalls/example',
    'https://www.cpsc.gov/Recalls/example',
    'http://cpsc.gov/Recalls/example',
    'https://evilcpsc.gov/Recalls/example',
    'https://cpsc.gov.evil.example/Recalls/example',
    'https://foo.cpsc.gov/Recalls/example',
    'https://example.com/Recalls/example',
    'https://cpsc.gov@evil.example/Recalls/example',
    'https://user:pass@cpsc.gov/Recalls/example',
  ]) {
    assert.match(phase14PgTap, new RegExp(url.replaceAll('.', '\\.'), 'u'));
  }
  assert.match(phase14PgTap, /pg_temp\.insert_phase14_cpsc_url/u);
  assert.match(phase14PgTap, /extensions\.throws_ok/u);
  assert.doesNotMatch(
    authorityValidationMigration,
    /recall_matches|recall_automation_control|health_canada|cron\.job/iu,
  );
  assert.match(remediationMigration, /commit;\s*$/u);
});
