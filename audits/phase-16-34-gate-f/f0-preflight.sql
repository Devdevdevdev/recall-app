-- Phase 16.34 Gate F — F0: read-only preflight before any Gate F write (plan §17, Gate F).
-- READ-ONLY. Baselines captured read-only at 2026-10-02 06:27:05 UTC, after the E3 run (06:17):
--   runs '67 3824ff39', tickets '4 7968d321', installer prosrc md5 5f44b078a6931b40979fe7ae5abc897f,
--   migrations '31 f8be9553280b05ab2d26ca5d89fdb8b9'.
-- Run between natural runs (>= 10 min after a :17 run completes, >= 30 min before the next :17):
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-f/f0-preflight.sql
-- Every value under "checks" must be true; "all_pass" must be true (a null counts as a failure).
-- page_worker_password_set reads only a boolean (rolpassword is null); no hash is returned.
begin transaction read only;
with k as (select * from private.scheduler_invocation_tickets),
inst as (select p.* from pg_proc p where p.oid = 'private.install_recall_automation_cron()'::regprocedure),
pw as (select * from pg_roles where rolname = 'cpsc_page_worker'),
fp as (select
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_attempts x) attempts,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.identity_id)),8) from private.cpsc_page_work_state x) work,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_revisions x) revisions,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_coverage_ledgers x) ledgers,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_identity_holds x) holds,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_candidate_criteria x) candidates,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.recall_automation_runs x) runs,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from k x) tickets),
v2 as (select n.nspname s, c.relname tb from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname in ('public', 'private') and c.relname like '%v2%'),
c as (select jsonb_build_object(
  -- Nothing happened since the E3 run
  'history_unchanged_since_e3', (select runs = '67 3824ff39' and tickets = '4 7968d321' from fp),
  'no_expired_unconsumed_ticket', not exists (select 1 from k where consumed_at is null and expires_at <= now()),
  -- Work in flight
  'net_queue_0', (select count(*) from net.http_request_queue) = 0,
  'automation_lease_0', (select count(*) from private.recall_automation_lease) = 0,
  'matching_lease_0', (select count(*) from private.recall_matching_leases) = 0,
  'no_run_in_progress', (select count(*) from private.recall_automation_runs where status = 'running') = 0,
  'no_running_cron', (select count(*) from cron.job_run_details where status not in ('succeeded', 'failed')) = 0,
  -- Cron / Vault after Gate E
  'job2_ticket_command', exists (select 1 from cron.job where jobid = 2 and jobname = 'recall-automation-every-6h'
    and schedule = '17 */6 * * *' and active and md5(command) = 'aae24c409d36e91c64b4e1732d6c6651')
    and (select count(*) from cron.job) = 1,
  'vault_url_only', (select jsonb_agg(jsonb_build_object('n', name, 'u', updated_at) order by name) from vault.secrets)
    = '[{"n":"recall_automation_url","u":"2026-09-16T06:03:35.819456+00:00"}]'::jsonb,
  'url_pinned_to_project', (select decrypted_secret ~ '^https://cnftnulgtsraurtusnpb\.supabase\.co/functions/v1/run-recall-automation$'
    from vault.decrypted_secrets where name = 'recall_automation_url'),
  -- F1 preconditions: the Phase 12 installer is still the static-key version, and nothing else reads that key
  'installer_still_phase12', (select md5(prosrc) = '5f44b078a6931b40979fe7ae5abc897f'
    and prosrc like '%recall_automation_key%' and prosrc like '%x-recall-automation-key%' from inst),
  'installer_owner_secdef_acl', (select pg_get_userbyid(proowner) = 'postgres' and prosecdef
    and proconfig = array['search_path=""'] and proacl::text = '{postgres=X/postgres,service_role=X/postgres}' from inst),
  'only_installer_references_static_key', (select coalesce(array_agg(p.oid::regprocedure::text), '{}') from pg_proc p
    where p.prosrc like '%recall_automation_key%' or p.prosrc like '%x-recall-automation-key%')
    = array['private.install_recall_automation_cron()'],
  'gate_f_version_absent', not exists (select 1 from supabase_migrations.schema_migrations where version = '20261001090000'),
  'migrations_31', (select count(*)||' '||md5(string_agg(version||name, ',' order by version)) from supabase_migrations.schema_migrations) = '31 f8be9553280b05ab2d26ca5d89fdb8b9',
  -- F4 preconditions (cpsc_page_worker)
  'page_worker_role_shape', (select rolcanlogin and not rolsuper and not rolcreaterole and not rolbypassrls from pw),
  'page_worker_password_set', (select rolpassword is not null from pg_authid where rolname = 'cpsc_page_worker'),
  'page_worker_no_session', (select count(*) from pg_stat_activity where usename = 'cpsc_page_worker') = 0,
  'postgres_can_alter_page_worker', (select rolcreaterole from pg_roles where rolname = 'postgres')
    and exists (select 1 from pg_auth_members where roleid = (select oid from pw)
      and member = (select oid from pg_roles where rolname = 'postgres') and admin_option),
  -- Page / 26777 / candidates / v2 / humans
  'no_page_cron', not exists (select 1 from cron.job where jobname ilike '%page%' or command ilike '%page%'),
  'stage_never_started', private.cpsc_page_stage_control_state(now()) = '{"state":"never_started","running":false}'::jsonb
    and (select count(*) from private.cpsc_page_stage_control_events) = 0 and (select count(*) from private.cpsc_page_stage_ticks) = 0,
  'no_page_ticket', not exists (select 1 from k where job <> 'recall_automation'),
  'page_unchanged', (select attempts = '8 ac113605' and work = '8 4a536bb2' and revisions = '27 7a34be4a' and ledgers = '7 a27e8b73' from fp)
    and (select count(*) from private.cpsc_page_fetches) = 34 and (select count(*) from private.cpsc_page_raw_payloads) = 7
    and (select count(*) from private.cpsc_page_structural_snapshots) = 7,
  'hold_26777', (select holds = '1 a19900c3' from fp) and (select count(*) from private.cpsc_page_identity_hold_resolutions) = 0,
  'candidates_unreviewed', (select candidates = '18 dc2b3a0f' from fp) and (select count(*) from private.cpsc_candidate_review_ledger) = 0,
  'v2_inactive', (select coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I.%I', s, tb), false, true, '')))[1]::text::int), 0) from v2) = 0,
  'humans_0', (select count(*) from private.cpsc_admin_capabilities) + (select count(*) from private.cpsc_reviewer_authorizations)
    + (select count(*) from private.cpsc_identity_reconciliations) + (select count(*) from private.cpsc_review_decision_invalidations)
    + (select count(*) from private.cpsc_authorization_audit) + (select count(*) from private.cpsc_outside_census_attestations) = 0
) checks)
select jsonb_pretty(jsonb_build_object(
  'now', now(),
  'all_pass', (select bool_and(coalesce(value = 'true', false)) from c, jsonb_each_text(checks)),
  'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from c, jsonb_each_text(checks) where value is distinct from 'true'),
  'checks', (select checks from c),
  'fingerprints', (select jsonb_build_object('runs', runs, 'tickets', tickets) from fp),
  'last_run', (select jsonb_build_object('status', status, 'error_code', error_code, 'started', started_at)
    from private.recall_automation_runs order by started_at desc limit 1),
  'sources', (select jsonb_agg(jsonb_build_object('src', s.source_key, 'status', y.last_status, 'error', y.last_error_code,
    'watermark', y.watermark->>'value') order by s.source_key)
    from private.recall_source_sync_state y join public.recall_sources s on s.id = y.source_id)));
rollback;
