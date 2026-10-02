-- Phase 16.34 Gate C — step C3: read-only post-checks. Run at least 60 s after C2
-- (the ticket TTL is 120 s and the pg_net timeout is 30 s; production runs take 3–9 s).
-- Run: psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-c/c3-postcheck.sql
-- Every value under "checks" must be true; "all_pass" must be true (a null counts as a failure).
begin transaction read only;
with k as (select * from private.scheduler_invocation_tickets),
t as (select * from k order by issued_at desc limit 1),
r as (select * from private.recall_automation_runs
      where started_at >= (select issued_at from t) - interval '5 seconds'),
fp as (select
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_attempts x) attempts,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.identity_id)),8) from private.cpsc_page_work_state x) work,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_revisions x) revisions,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_coverage_ledgers x) ledgers,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_page_identity_holds x) holds,
  (select count(*)||' '||left(md5(string_agg(to_jsonb(x)::text, ',' order by x.id)),8) from private.cpsc_candidate_criteria x) candidates),
v2 as (select n.nspname s, c.relname tb from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname in ('public', 'private') and c.relname like '%v2%'),
c as (select jsonb_build_object(
  'exactly_one_ticket', (select count(*) from k) = 1,
  'ticket_job_and_params', (select job = 'recall_automation' and parameters = '{"trigger":"cron"}'::jsonb from t),
  'ticket_consumed_once_by_automation', (select consumed_at is not null and consumer = 'run-recall-automation'
    and consumed_at <= expires_at from t),
  'ticket_rejected_attempts_0', (select rejected_attempts = 0 from t),
  'http_200', (select status_code = 200 and not timed_out and error_msg is null
    from net._http_response where id = (select request_id from t)),
  'theft_query_empty', not exists (select 1 from k where k.consumed_at is not null and not exists (
    select 1 from net._http_response x where x.id = k.request_id and x.status_code = 200)),
  'net_queue_0', (select count(*) from net.http_request_queue) = 0,
  'exactly_one_new_run', (select count(*) from r) = 1,
  'run_success', (select status = 'success' and trigger = 'cron' and completed_at is not null and error_code is null from r),
  'run_after_ticket_consumed', (select started_at >= (select consumed_at from t) - interval '5 seconds' from r),
  'automation_lease_0', (select count(*) from private.recall_automation_lease) = 0,
  'matching_lease_0', (select count(*) from private.recall_matching_leases) = 0,
  'no_run_in_progress', (select count(*) from private.recall_automation_runs where status = 'running') = 0,
  'outcomes_cover_affected', (select count(*) from private.recall_automation_matching_outcomes o where o.run_id = (select id from r))
    = (select least(affected_recalls, max_recalls) from r),
  'pending_equals_retained', (select count(*) from private.recall_automation_pending_recalls)
    = (select count(*) from private.recall_automation_matching_outcomes o where o.run_id = (select id from r) and o.outcome <> 'resolved'),
  'nothing_exhausted', (select count(*) from private.recall_automation_pending_recalls where exhausted_at is not null) = 0,
  'job2_ticket_command', exists (select 1 from cron.job where jobid = 2 and jobname = 'recall-automation-every-6h'
    and schedule = '17 */6 * * *' and active and command = 'select private.recall_automation_tick();')
    and (select count(*) from cron.job) = 1,
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
  'static_key_present_unchanged', (select jsonb_agg(jsonb_build_object('n', name, 'u', updated_at) order by name) from vault.secrets)
    = '[{"n":"recall_automation_key","u":"2026-09-16T06:03:21.458957+00:00"},{"n":"recall_automation_url","u":"2026-09-16T06:03:35.819456+00:00"}]'::jsonb,
  'migrations_31', (select count(*)||' '||md5(string_agg(version||name, ',' order by version)) from supabase_migrations.schema_migrations) = '31 f8be9553280b05ab2d26ca5d89fdb8b9'
) checks)
select jsonb_pretty(jsonb_build_object(
  'now', now(),
  'all_pass', (select bool_and(coalesce(value = 'true', false)) from c, jsonb_each_text(checks)),
  'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from c, jsonb_each_text(checks) where value is distinct from 'true'),
  'checks', (select checks from c),
  'ticket', (select jsonb_build_object('seq', ticket_seq, 'request_id', request_id, 'issued_at', issued_at, 'expires_at', expires_at,
    'consumed_at', consumed_at, 'consumer', consumer, 'rejected_attempts', rejected_attempts) from t),
  'response', (select jsonb_build_object('id', id, 'status', status_code, 'timed_out', timed_out, 'created', created)
    from net._http_response where id = (select request_id from t)),
  'run', (select jsonb_build_object('id', id, 'status', status, 'started', started_at, 'completed', completed_at,
    'affected', affected_recalls, 'pairs', candidate_pairs, 'alerts', alerts_created) from r),
  'outcomes', (select coalesce(jsonb_object_agg(outcome, n), '{}'::jsonb) from (select outcome, count(*) n
    from private.recall_automation_matching_outcomes where run_id = (select id from r) group by outcome) o),
  'pending_status', private.recall_automation_pending_status(now()),
  'scheduler_status', private.scheduler_invocation_status(now()),
  'business', jsonb_build_object('matches', (select count(*) from public.recall_matches), 'alerts', (select count(*) from public.alerts),
    'push', (select count(*) from private.push_deliveries))));
rollback;
