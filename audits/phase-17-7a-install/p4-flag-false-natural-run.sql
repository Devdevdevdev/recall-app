-- Phase 17.7a install: NON-ACTIVATION proof on the first natural cron run (:17) after
-- GO 17.7A-AUTOMATION, flag still false. READ-ONLY, no manual tick, no personal data.
-- Set :since to the deploy time of the 17.7a-2 automation (UTC), e.g.
--   psql ... -v since="'2026-10-04 10:00:00+00'" -f p4-flag-false-natural-run.sql
-- Expected: every value in "checks" is true.
with run as (
  select r.* from private.recall_automation_runs r
  where r.started_at > :since and r.trigger = 'cron'
  order by r.started_at desc limit 1
),
response as (
  select h.status_code, h.content::jsonb as body
  from net._http_response h
  where h.created > :since and h.content is not null and h.content like '{%'
    and (h.content::jsonb ? 'productCheck')
  order by h.created desc limit 1
)
select jsonb_build_object(
  'a_natural_run_happened', exists (select 1 from run),
  'run_finished', (select status in ('success', 'partial_success', 'failed') from run),
  'run_error_not_product_check', (select error_step is distinct from 'product_check' from run),
  'http_200', (select status_code = 200 from response),
  'summary_disabled', (select body #>> '{productCheck,status}' = 'disabled' from response),
  'summary_not_attempted', (select (body #>> '{productCheck,attempted}')::boolean = false from response),
  'summary_zero_claims', (select (body #>> '{productCheck,claimed}')::integer = 0 from response),
  'flag_still_false',
    (select product_check_enabled = false from private.recall_automation_control where singleton),
  'no_worker_claim_ever',
    not exists (select 1 from private.owned_product_recall_check_events where path = 'worker'),
  'no_user_claim_ever',
    not exists (select 1 from private.owned_product_recall_check_events where event = 'claimed'),
  'every_job_untouched',
    not exists (select 1 from private.owned_product_recall_checks
      where status <> 'pending' or attempts <> 0 or lease_token is not null or checked_at is not null),
  'single_recall_cron_unchanged',
    (select count(*) = 1 and bool_and(jobname = 'recall-automation-every-6h'
       and schedule = '17 */6 * * *' and active and md5(command) = 'aae24c409d36e91c64b4e1732d6c6651')
     from cron.job)
) as checks,
(select jsonb_build_object('status', status, 'error_step', error_step, 'error_code', error_code,
   'started_at', started_at) from run) as run,
(select body -> 'productCheck' from response) as product_check_summary,
jsonb_build_object(
  'owned_products', (select count(*) from public.owned_products),
  'product_check_jobs', (select count(*) from private.owned_product_recall_checks),
  'events_by_type', (select jsonb_object_agg(event || '/' || path, n) from (
    select event, path, count(*) n from private.owned_product_recall_check_events group by 1, 2) e),
  'alerts', (select count(*) from public.alerts),
  'push_queue', (select count(*) from private.push_alert_queue),
  'push_deliveries', (select count(*) from private.push_deliveries),
  'v2_evaluations', (select count(*) from private.recall_match_evaluations_v2)
) as observed;
-- Edge logs (separately, read-only, query_logs / function_edge_logs) over the same
-- window must show: one POST run-recall-automation (new version) with 200, and NO
-- request at all to process-owned-product-checks.
