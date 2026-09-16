import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(
  new URL(
    '../supabase/migrations/20260916100000_phase_12_autonomous_recall_monitoring.sql',
    import.meta.url,
  ),
  'utf8',
);
const cronFixMigration = await readFile(
  new URL(
    '../supabase/migrations/20260916110000_phase_12_fix_cron_activation.sql',
    import.meta.url,
  ),
  'utf8',
);

test('Phase 12 enables only the supported scheduling extensions and preserves Vault', () => {
  assert.match(migration, /create extension if not exists pg_cron/u);
  assert.match(migration, /create extension if not exists pg_net/u);
  assert.doesNotMatch(migration, /drop extension/u);
  assert.doesNotMatch(migration, /create extension[^;]+supabase_vault/u);
});

test('automation control is private, server bounded, and disabled by default', () => {
  assert.match(migration, /create table private\.recall_automation_control/u);
  assert.match(migration, /enabled boolean not null default false/u);
  assert.match(migration, /ai_enabled boolean not null default false/u);
  assert.match(migration, /push_enabled boolean not null default false/u);
  assert.match(migration, /max_ai_escalations_per_run integer not null default 5/u);
  assert.match(migration, /max_ai_escalations_per_run between 0 and 5/u);
  assert.match(
    migration,
    /revoke all on table private\.recall_automation_control from public, anon, authenticated, service_role/u,
  );
});

test('run history stores aggregate metrics without user content or provider payloads', () => {
  assert.match(migration, /create table private\.recall_automation_runs/u);
  for (const metric of [
    'ingestion_seen',
    'affected_recalls',
    'candidate_pairs',
    'deterministic_resolved',
    'ai_escalations',
    'alerts_created',
    'push_claimed',
    'push_accepted',
    'push_failed',
  ]) {
    assert.match(migration, new RegExp(`${metric} integer not null default 0`, 'u'));
  }
  assert.doesNotMatch(migration, /email|expo_push_token|ocr|raw_payload|provider_response/iu);
});

test('the singleton lease prevents overlap and explicitly recovers stale runs', () => {
  assert.match(migration, /create table private\.recall_automation_lease/u);
  assert.match(migration, /singleton boolean primary key/u);
  assert.match(migration, /v_existing_expires_at > p_now/u);
  assert.match(migration, /status = 'failed',[\s\S]+error_code = 'lease_expired'/u);
  assert.match(migration, /on conflict \(singleton\) do update/u);
});

test('watermark windows implement seven-day bootstrap, bounded catch-up, and 48-hour overlap', () => {
  assert.match(migration, /bootstrap_days integer not null default 7/u);
  assert.match(migration, /catch_up_days integer not null default 7/u);
  assert.match(migration, /overlap_hours integer not null default 48/u);
  assert.match(migration, /v_window_start := v_today - \(v_control\.bootstrap_days - 1\)/u);
  assert.match(migration, /v_window_start := v_watermark - \(v_control\.overlap_hours \/ 24\)/u);
  assert.match(migration, /least\(v_today, v_watermark \+ v_control\.catch_up_days\)/u);
  assert.match(migration, /record_recall_automation_ingestion[\s\S]+last_successful_watermark/u);
});

test('affected recalls persist until matching completes successfully', () => {
  assert.match(migration, /create table private\.recall_automation_pending_recalls/u);
  assert.match(migration, /on conflict \(recall_notice_id\) do update/u);
  assert.match(
    migration,
    /if p_complete then[\s\S]+delete from private\.recall_automation_pending_recalls/u,
  );
  assert.match(migration, /attempt_count = attempt_count \+ 1/u);
});

test('all automation Data API RPCs are security definers restricted to service role', () => {
  for (const rpc of [
    'claim_recall_automation_run',
    'record_recall_automation_ingestion',
    'get_recall_automation_pending_recalls',
    'record_recall_automation_matching',
    'complete_recall_automation_run',
  ]) {
    assert.match(
      migration,
      new RegExp(
        `create function public\\.${rpc}\\([\\s\\S]+?security definer[\\s\\S]+?set search_path = ''`,
        'u',
      ),
    );
    assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}\\(`, 'u'));
    assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}\\(`, 'u'));
  }
  assert.doesNotMatch(migration, /grant execute[^;]+to (?:anon|authenticated)/u);
});

test('Cron is unique, non-round, Vault-backed, and installed inactive', () => {
  assert.match(migration, /recall-automation-every-6h/u);
  assert.match(migration, /17 \*\/6 \* \* \*/u);
  assert.match(migration, /cron\.unschedule/u);
  assert.match(migration, /vault\.decrypted_secrets/u);
  assert.match(migration, /recall_automation_url/u);
  assert.match(migration, /recall_automation_key/u);
  assert.match(migration, /update cron\.job set active = false/u);
  assert.doesNotMatch(migration, /x-recall-automation-key',\s*'[^']+'/u);
  assert.match(cronFixMigration, /cron\.alter_job\(v_job_id, active := false\)/u);
  assert.match(cronFixMigration, /cron\.alter_job\(v_job_id, active := p_active\)/u);
  assert.doesNotMatch(cronFixMigration, /update cron\.job/u);
});

test('Phase 12 does not weaken Phase 10 or Phase 11 client isolation', () => {
  assert.doesNotMatch(migration, /disable row level security/u);
  assert.doesNotMatch(migration, /drop policy/u);
  assert.doesNotMatch(migration, /grant [^;]+recall_matches[^;]+authenticated/u);
  assert.doesNotMatch(migration, /grant [^;]+push_(?:devices|deliveries)[^;]+authenticated/u);
});
