-- Phase 16.34 Gate C — step C0: read-only preflight.
-- Run: psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-c/c0-preflight.sql
-- Read-only transaction. Prints one JSON object; every value under "checks" must be true,
-- and "all_pass" must be true (a null check counts as a failure). No secret value is returned (the URL check returns a boolean).
begin transaction read only;
with v2 as (
  select n.nspname s, c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname in ('public', 'private') and c.relname like '%v2%'),
fp as (select
  (select count(*)||' '||left(md5(string_agg(to_jsonb(t)::text, ',' order by t.id)),8) from private.cpsc_page_attempts t) attempts,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(t)::text, ',' order by t.identity_id)),8) from private.cpsc_page_work_state t) work,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(t)::text, ',' order by t.id)),8) from private.cpsc_page_revisions t) revisions,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(t)::text, ',' order by t.id)),8) from private.cpsc_page_coverage_ledgers t) ledgers,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(t)::text, ',' order by t.id)),8) from private.cpsc_page_identity_holds t) holds,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(t)::text, ',' order by t.id)),8) from private.cpsc_candidate_criteria t) candidates),
c as (select jsonb_build_object(
  'migrations_31', (select count(*)||' '||md5(string_agg(version||name, ',' order by version)) from supabase_migrations.schema_migrations) = '31 f8be9553280b05ab2d26ca5d89fdb8b9',
  'only_job_2', (select count(*) from cron.job) = 1 and exists (select 1 from cron.job where jobid = 2 and jobname = 'recall-automation-every-6h'),
  'job2_schedule_active', exists (select 1 from cron.job where jobid = 2 and schedule = '17 */6 * * *' and active),
  'job2_static_key_cmd', (select md5(command) from cron.job where jobid = 2) = '07549bf985a3034a5ef9c645692097b6',
  'no_page_cron', not exists (select 1 from cron.job where jobname ilike '%page%' or command ilike '%page%'),
  'no_running_cron', (select count(*) from cron.job_run_details where status not in ('succeeded', 'failed')) = 0,
  'last_cron_succeeded', (select status from cron.job_run_details order by start_time desc limit 1) = 'succeeded',
  'net_queue_0', (select count(*) from net.http_request_queue) = 0,
  'automation_lease_0', (select count(*) from private.recall_automation_lease) = 0,
  'matching_lease_0', (select count(*) from private.recall_matching_leases) = 0,
  'no_run_in_progress', (select count(*) from private.recall_automation_runs where status = 'running') = 0,
  'last_run_ok', (select status from private.recall_automation_runs order by started_at desc limit 1) in ('success', 'partial_success'),
  'stage_never_started', private.cpsc_page_stage_control_state(now()) = '{"state":"never_started","running":false}'::jsonb,
  'page_control_events_0', (select count(*) from private.cpsc_page_stage_control_events) = 0,
  'page_ticks_0', (select count(*) from private.cpsc_page_stage_ticks) = 0,
  'tickets_0', (select count(*) from private.scheduler_invocation_tickets) = 0,
  'page_unchanged', (select attempts = '8 ac113605' and work = '8 4a536bb2' and revisions = '27 7a34be4a' and ledgers = '7 a27e8b73' from fp)
    and (select count(*) from private.cpsc_page_fetches) = 34 and (select count(*) from private.cpsc_page_raw_payloads) = 7
    and (select count(*) from private.cpsc_page_structural_snapshots) = 7,
  'hold_26777', (select holds = '1 a19900c3' from fp) and (select count(*) from private.cpsc_page_identity_hold_resolutions) = 0
    and exists (select 1 from private.cpsc_page_identity_holds where official_recall_number = '26777'),
  'candidates_unreviewed', (select candidates = '18 dc2b3a0f' from fp) and (select count(*) from private.cpsc_candidate_review_ledger) = 0,
  'v2_inactive', (select coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I.%I', s, t), false, true, '')))[1]::text::int), 0) from v2) = 0,
  'humans_0', (select count(*) from private.cpsc_admin_capabilities) + (select count(*) from private.cpsc_reviewer_authorizations)
    + (select count(*) from private.cpsc_identity_reconciliations) + (select count(*) from private.cpsc_review_decision_invalidations)
    + (select count(*) from private.cpsc_authorization_audit) + (select count(*) from private.cpsc_outside_census_attestations) = 0,
  'vault_unchanged', (select jsonb_agg(jsonb_build_object('n', name, 'u', updated_at) order by name) from vault.secrets)
    = '[{"n":"recall_automation_key","u":"2026-09-16T06:03:21.458957+00:00"},{"n":"recall_automation_url","u":"2026-09-16T06:03:35.819456+00:00"}]'::jsonb,
  'url_pinned_to_project', (select count(*) = 1 and bool_and(decrypted_secret ~ '^https://cnftnulgtsraurtusnpb\.supabase\.co/functions/v1/run-recall-automation$')
    from vault.decrypted_secrets where name = 'recall_automation_url'),
  'rollback_text_ready', md5(substring(pg_get_functiondef('private.install_recall_automation_cron()'::regprocedure) from '\$cron\$(.*)\$cron\$')) = '07549bf985a3034a5ef9c645692097b6',
  'owner_only_cutover_and_tick', (select bool_and(proacl::text = '{postgres=X/postgres}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname in ('recall_automation_tick', 'convert_recall_automation_cron_to_tickets')),
  'consume_rpc_service_role_only', has_function_privilege('service_role', 'public.consume_recall_automation_ticket(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.consume_recall_automation_ticket(text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.consume_recall_automation_ticket(text)', 'EXECUTE')
) checks)
select jsonb_pretty(jsonb_build_object(
  'now', now(),
  'all_pass', (select bool_and(coalesce(value = 'true', false)) from c, jsonb_each_text(checks)),
  'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from c, jsonb_each_text(checks) where value is distinct from 'true'),
  'checks', (select checks from c),
  'runs', (select count(*) from private.recall_automation_runs),
  'last_run', (select jsonb_build_object('status', status, 'started', started_at) from private.recall_automation_runs order by started_at desc limit 1),
  'last_cron_start', (select max(start_time) from cron.job_run_details),
  'net_last_response', (select max(id) from net._http_response)));
rollback;
