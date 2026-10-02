-- Phase 16.34 Gate E — E0: read-only preflight (executed by the agent at 2026-10-02 04:19:30 UTC: 19/19, all_pass).
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-e/e0-preflight.sql
-- Every value under "checks" must be true; "all_pass" must be true (a null counts as a failure).
-- Hosted Edge secrets are outside SQL: the user runs secrets-metadata.py (see README).
begin transaction read only;
with v2 as (select n.nspname s, c.relname tb from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname in ('public', 'private') and c.relname like '%v2%'),
k as (select * from private.scheduler_invocation_tickets),
c as (select jsonb_build_object(
  'job2_on_tickets', exists (select 1 from cron.job where jobid = 2 and jobname = 'recall-automation-every-6h' and schedule = '17 */6 * * *'
     and active and md5(command) = 'aae24c409d36e91c64b4e1732d6c6651') and (select count(*) from cron.job) = 1,
  'two_natural_ticket_runs_ok', (select count(*) = 2 from k where issued_at >= '2026-10-01 18:16+00' and consumed_at is not null
     and consumer = 'run-recall-automation' and rejected_attempts = 0)
     and (select count(*) = 2 and bool_and(status = 'success') from private.recall_automation_runs where started_at >= '2026-10-01 18:16+00'),
  'tickets_all_consumed_no_rejects', (select count(*) = 3 and bool_and(consumed_at is not null and rejected_attempts = 0) from k),
  'net_queue_0', (select count(*) from net.http_request_queue) = 0,
  'automation_lease_0', (select count(*) from private.recall_automation_lease) = 0,
  'matching_lease_0', (select count(*) from private.recall_matching_leases) = 0,
  'no_run_in_progress', (select count(*) from private.recall_automation_runs where status = 'running') = 0,
  'no_running_cron', (select count(*) from cron.job_run_details where status not in ('succeeded', 'failed')) = 0,
  'vault_key_and_url_present', (select jsonb_agg(jsonb_build_object('n', name, 'u', updated_at) order by name) from vault.secrets)
    = '[{"n":"recall_automation_key","u":"2026-09-16T06:03:21.458957+00:00"},{"n":"recall_automation_url","u":"2026-09-16T06:03:35.819456+00:00"}]'::jsonb,
  'url_pinned_to_project', (select count(*) = 1 and bool_and(decrypted_secret ~ '^https://cnftnulgtsraurtusnpb\.supabase\.co/functions/v1/run-recall-automation$')
    from vault.decrypted_secrets where name = 'recall_automation_url'),
  'no_page_cron', not exists (select 1 from cron.job where jobname ilike '%page%' or command ilike '%page%'),
  'stage_never_started', private.cpsc_page_stage_control_state(now()) = '{"state":"never_started","running":false}'::jsonb
    and (select count(*) from private.cpsc_page_stage_control_events) = 0 and (select count(*) from private.cpsc_page_stage_ticks) = 0,
  'no_page_ticket', not exists (select 1 from k where job <> 'recall_automation'),
  'page_unchanged', (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_attempts x) = '8 ac113605'
    and (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.identity_id)),8) from private.cpsc_page_work_state x) = '8 4a536bb2',
  'hold_26777', (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_identity_holds x) = '1 a19900c3'
    and (select count(*) from private.cpsc_page_identity_hold_resolutions) = 0,
  'candidates_unreviewed', (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_candidate_criteria x) = '18 dc2b3a0f'
    and (select count(*) from private.cpsc_candidate_review_ledger) = 0,
  'v2_inactive', (select coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I.%I', s, tb), false, true, '')))[1]::text::int), 0) from v2) = 0,
  'humans_0', (select count(*) from private.cpsc_admin_capabilities) + (select count(*) from private.cpsc_reviewer_authorizations)
    + (select count(*) from private.cpsc_identity_reconciliations) + (select count(*) from private.cpsc_review_decision_invalidations)
    + (select count(*) from private.cpsc_authorization_audit) + (select count(*) from private.cpsc_outside_census_attestations) = 0,
  'migrations_31', (select count(*)||' '||md5(string_agg(version||name, ',' order by version)) from supabase_migrations.schema_migrations) = '31 f8be9553280b05ab2d26ca5d89fdb8b9'
) checks)
select jsonb_pretty(jsonb_build_object('now', now(),
 'all_pass', (select bool_and(coalesce(value = 'true', false)) from c, jsonb_each_text(checks)),
 'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from c, jsonb_each_text(checks) where value is distinct from 'true'),
 'checks', (select checks from c),
 'e2_readiness', jsonb_build_object(
    'postgres_can_delete_vault_secrets', has_table_privilege('postgres', 'vault.secrets', 'DELETE'),
    'vault_secrets_triggers', (select coalesce(jsonb_agg(tgname), '[]'::jsonb) from pg_trigger where tgrelid = 'vault.secrets'::regclass and not tgisinternal),
    'vault_secrets_fk_refs', (select count(*) from pg_constraint where confrelid = 'vault.secrets'::regclass))));
rollback;
