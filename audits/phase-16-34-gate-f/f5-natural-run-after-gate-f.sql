-- Phase 16.34 Gate F — F5: first natural ticket run AFTER Gate F (job 2, 2026-10-02 12:17 UTC).
-- READ-ONLY. Identical to audits/phase-16-34-gate-e/e3-natural-run-after-key-retirement.sql (128c30ec…e8) except:
--   * window 2026-10-02 12:16–12:47 UTC; history baselines captured read-only at 2026-10-02 06:27:05
--     (67 runs '67 3824ff39', 4 tickets '4 7968d321'), so they must be unchanged before the window;
--   * no_event_since_e3: no Cron execution, ticket, run or pg_net response between 06:47 and 12:16;
--   * migrations_32 ('32 6b985817894f081ab0b31e85af51b3a1') replaces migrations_31;
--   * adds installer_retired and no_function_references_static_key (F1 in force; installer not executed);
--   * reports page_worker_password_is_null (true only if F4 was approved and applied) outside the checks.
--   Valid only if every approved Gate F write (F1, F2, optional F3, F4) was completed before 11:47 UTC.
--   Otherwise a re-dated copy is needed (next run 18:17).
-- Run (at or after 12:19 UTC on 2026-10-02, before 18:17 UTC):
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-f/f5-natural-run-after-gate-f.sql
-- Every value under "checks" must be true; "all_pass" must be true (a null counts as a failure).
begin transaction read only;
with p as (select timestamptz '2026-10-02 12:16:00+00' as since, timestamptz '2026-10-02 12:47:00+00' as until,
  timestamptz '2026-10-02 06:47:00+00' as prev_until),
k as (select * from private.scheduler_invocation_tickets),
kn as (select * from k where issued_at >= (select since from p) and issued_at < (select until from p)),
t as (select * from kn order by issued_at desc limit 1),
r as (select * from private.recall_automation_runs
      where started_at >= (select since from p) and started_at < (select until from p)),
cr as (select * from cron.job_run_details where start_time >= (select since from p) and start_time < (select until from p)),
nr as (select * from net._http_response where created >= (select since from p) and created < (select until from p)),
src as (select s.source_key, y.* from private.recall_source_sync_state y join public.recall_sources s on s.id = y.source_id),
fp as (select
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_attempts x) attempts,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.identity_id)),8) from private.cpsc_page_work_state x) work,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_revisions x) revisions,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_coverage_ledgers x) ledgers,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_identity_holds x) holds,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_candidate_criteria x) candidates,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.recall_automation_runs x
     where x.started_at < (select since from p)) runs_before,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from k x
     where x.issued_at < (select since from p)) tickets_before),
v2 as (select n.nspname s, c.relname tb from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname in ('public', 'private') and c.relname like '%v2%'),
c as (select jsonb_build_object(
  -- Cron / HTTP
  'cron_one_execution_succeeded', (select count(*) = 1 and bool_and(status = 'succeeded' and jobid = 2) from cr),
  'no_running_cron', (select count(*) from cron.job_run_details where status not in ('succeeded', 'failed')) = 0,
  'exactly_one_new_ticket', (select count(*) from kn) = 1,
  'ticket_job_and_params', (select job = 'recall_automation' and parameters = '{"trigger":"cron"}'::jsonb from t),
  'ticket_consumed_once_by_automation', (select consumed_at is not null and consumer = 'run-recall-automation'
    and consumed_at <= expires_at from t),
  'ticket_rejected_attempts_0', (select rejected_attempts = 0 from t),
  'http_200', (select status_code = 200 and not timed_out and error_msg is null
    from net._http_response where id = (select request_id from t)),
  'no_401_or_non_200_in_window', (select count(*) = 1 and bool_and(status_code = 200 and not timed_out) from nr),
  'theft_query_empty', not exists (select 1 from k where k.consumed_at is not null and not exists (
    select 1 from net._http_response x where x.id = k.request_id and x.status_code = 200)
    and k.issued_at >= (select since from p)),
  'no_expired_unconsumed_ticket', not exists (select 1 from k where consumed_at is null and expires_at <= now()),
  'net_queue_0', (select count(*) from net.http_request_queue) = 0,
  -- Automation
  'exactly_one_new_run', (select count(*) from r) = 1,
  'run_status_accepted', (select trigger = 'cron' and completed_at is not null and (
      (status = 'success' and error_code is null)
      or (status = 'partial_success' and error_code = 'source_partial_failure'
          and exists (select 1 from src where last_status <> 'success'))) from r),
  'run_after_ticket_consumed', (select started_at >= (select consumed_at from t) - interval '5 seconds' from r),
  'automation_lease_0', (select count(*) from private.recall_automation_lease) = 0,
  'matching_lease_0', (select count(*) from private.recall_matching_leases) = 0,
  'no_run_in_progress', (select count(*) from private.recall_automation_runs where status = 'running') = 0,
  'history_unchanged', (select runs_before = '67 3824ff39' and tickets_before = '4 7968d321' from fp),
  'no_event_since_e3',
    (select count(*) from cron.job_run_details where start_time >= (select prev_until from p) and start_time < (select since from p)) = 0
    and (select count(*) from k where issued_at >= (select prev_until from p) and issued_at < (select since from p)) = 0
    and (select count(*) from private.recall_automation_runs where started_at >= (select prev_until from p) and started_at < (select since from p)) = 0
    and (select count(*) from net._http_response where created >= (select prev_until from p) and created < (select since from p)) = 0,
  'outcomes_cover_affected', (select count(*) from private.recall_automation_matching_outcomes o where o.run_id = (select id from r))
    = (select least(affected_recalls, max_recalls) from r),
  'pending_equals_retained', (select count(*) from private.recall_automation_pending_recalls)
    = (select count(*) from private.recall_automation_matching_outcomes o where o.run_id = (select id from r) and o.outcome <> 'resolved'),
  'nothing_exhausted', (select count(*) from private.recall_automation_pending_recalls where exhausted_at is not null) = 0,
  'alerts_push_only_from_run', (select count(*) from public.alerts) = (select alerts_created from r)
    and (select count(*) from private.push_deliveries) = (select alerts_created from r),
  -- Sources / watermarks (baseline 2026-10-02 for all three)
  'both_sources_attempted_in_window', (select count(*) = 2 and bool_and(last_attempted_at >= (select since from p)) from src),
  'sources_consistent_with_run', (select case when (select status from r) = 'success'
      then bool_and(last_status = 'success' and last_error_code is null) else true end from src),
  'watermarks_monotone', (select bool_and((watermark->>'value')::date >= date '2026-10-02') from src)
    and (select last_successful_watermark >= date '2026-10-02' from private.recall_automation_state),
  -- Cron definition unchanged
  'job2_ticket_command', exists (select 1 from cron.job where jobid = 2 and jobname = 'recall-automation-every-6h'
    and schedule = '17 */6 * * *' and active and md5(command) = 'aae24c409d36e91c64b4e1732d6c6651')
    and (select count(*) from cron.job) = 1,
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
    + (select count(*) from private.cpsc_authorization_audit) + (select count(*) from private.cpsc_outside_census_attestations) = 0,
  'vault_static_key_absent', (select jsonb_agg(jsonb_build_object('n', name, 'u', updated_at) order by name) from vault.secrets)
    = '[{"n":"recall_automation_url","u":"2026-09-16T06:03:35.819456+00:00"}]'::jsonb,
  'migrations_32', (select count(*)||' '||md5(string_agg(version||name, ',' order by version)) from supabase_migrations.schema_migrations) = '32 6b985817894f081ab0b31e85af51b3a1',
  -- Gate F in force: retired installer (not executed), no function reads the static key
  'installer_retired', (select md5(prosrc) = 'c9ee5f44b93baa66a79d622eb538a21c' and prosecdef
    and proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
    from pg_proc where oid = 'private.install_recall_automation_cron()'::regprocedure),
  'no_function_references_static_key', not exists (select 1 from pg_proc p
    where p.prosrc like '%recall_automation_key%' or p.prosrc like '%x-recall-automation-key%')
) checks)
select jsonb_pretty(jsonb_build_object(
  'now', now(),
  'all_pass', (select bool_and(coalesce(value = 'true', false)) from c, jsonb_each_text(checks)),
  'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from c, jsonb_each_text(checks) where value is distinct from 'true'),
  'checks', (select checks from c),
  'cron', (select jsonb_agg(jsonb_build_object('jobid', jobid, 'start', start_time, 'end', end_time, 'status', status)) from cr),
  'ticket', (select jsonb_build_object('seq', ticket_seq, 'request_id', request_id, 'issued_at', issued_at, 'expires_at', expires_at,
    'consumed_at', consumed_at, 'consumer', consumer, 'rejected_attempts', rejected_attempts) from t),
  'responses_in_window', (select jsonb_agg(jsonb_build_object('id', id, 'status', status_code, 'timed_out', timed_out, 'created', created)) from nr),
  'run', (select jsonb_build_object('id', id, 'status', status, 'error_code', error_code, 'started', started_at, 'completed', completed_at,
    'seen', ingestion_seen, 'inserted', ingestion_inserted, 'updated', ingestion_updated, 'affected', affected_recalls,
    'pairs', candidate_pairs, 'alerts', alerts_created, 'push', jsonb_build_array(push_claimed, push_accepted, push_failed)) from r),
  'sources', (select jsonb_agg(jsonb_build_object('src', source_key, 'status', last_status, 'error', last_error_code,
    'watermark', watermark->>'value', 'attempted', last_attempted_at, 'fetched', last_metrics->'fetched',
    'inserted', last_metrics->'inserted', 'unchanged', last_metrics->'unchanged') order by source_key) from src),
  'automation_watermark', (select last_successful_watermark from private.recall_automation_state),
  'page_worker_password_is_null', (select rolpassword is null from pg_authid where rolname = 'cpsc_page_worker'),
  'page_worker_sessions', (select count(*) from pg_stat_activity where usename = 'cpsc_page_worker'),
  'outcomes', (select coalesce(jsonb_object_agg(outcome, n), '{}'::jsonb) from (select outcome, count(*) n
    from private.recall_automation_matching_outcomes where run_id = (select id from r) group by outcome) o),
  'pending_status', private.recall_automation_pending_status(now()),
  'scheduler_status', private.scheduler_invocation_status(now()),
  'business', jsonb_build_object('matches', (select count(*) from public.recall_matches), 'alerts', (select count(*) from public.alerts),
    'push', (select count(*) from private.push_deliveries))));
rollback;
