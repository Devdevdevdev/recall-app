-- Phase 17.7a controlled user test. READ-ONLY, aggregates only: no product attribute,
-- no e-mail, no identifier is returned. Production holds only the operator's test
-- account(s) (2 auth users, 0 products at preflight).
-- T1 (flag false): every T1 check true.   T2 (after GO 17.7A-ACTIVATE): every T2 check true.
select
jsonb_build_object(
  'T1_flag_false',
    (select product_check_enabled = false from private.recall_automation_control where singleton),
  'T1_one_job_per_product',
    (select count(*) from private.owned_product_recall_checks) = (select count(*) from public.owned_products),
  'T1_jobs_armed_not_claimed',
    not exists (select 1 from private.owned_product_recall_checks
      where status <> 'pending' or attempts <> 0 or lease_token is not null),
  'T1_only_arming_events',
    not exists (select 1 from private.owned_product_recall_check_events
      where event <> 'armed' or path <> 'trigger'),
  'T1_states_pending_check',
    not exists (select 1 from public.owned_products p
      cross join lateral private.owned_product_monitoring_state(p.id) s
      where s.state <> 'pending_check')
) as t1_checks,
jsonb_build_object(
  'T2_flag_true',
    (select product_check_enabled from private.recall_automation_control where singleton),
  'T2_no_alert', (select count(*) = 0 from public.alerts),
  'T2_no_v2_eligibility', (select count(*) = 0 from private.recall_alert_eligibility_v2),
  'T2_no_v2_snapshot', (select count(*) = 0 from private.recall_alert_snapshots_v2),
  'T2_no_push', (select count(*) = 0 from private.push_alert_queue)
    and (select count(*) = 0 from private.push_deliveries),
  'T2_no_confirmed_evaluation', not exists (
    select 1 from private.recall_match_evaluations_v2 where status = 'confirmed'),
  'T2_f4_inventory_empty',
    (select count(*) from public.recall_matches m where m.status = 'confirmed'
       and private.automatic_alert_eligibility(m.owned_product_id, m.recall_notice_id) <> 'eligible')
    + (select count(*) from private.recall_alert_eligibility_v2 e where e.revoked_at is null
       and private.automatic_alert_eligibility(e.owned_product_id, e.recall_notice_id) <> 'eligible') = 0,
  'T2_no_job_stuck_failed', not exists (
    select 1 from private.owned_product_recall_checks where status = 'failed')
) as t2_checks,
jsonb_build_object(
  'owned_products', (select count(*) from public.owned_products),
  'states', (select jsonb_object_agg(state, n) from (
    select s.state, count(*) n from public.owned_products p
    cross join lateral private.owned_product_monitoring_state(p.id) s group by 1) x),
  'jobs_by_status', (select jsonb_object_agg(status, n) from (
    select status, count(*) n from private.owned_product_recall_checks group by 1) x),
  'events_by_type', (select jsonb_object_agg(event || '/' || path, n) from (
    select event, path, count(*) n from private.owned_product_recall_check_events group by 1, 2) x),
  'v2_evaluations_by_status', (select jsonb_object_agg(status, n) from (
    select status, count(*) n from private.recall_match_evaluations_v2 group by 1) x),
  'v1_matches_by_status', (select jsonb_object_agg(status, n) from (
    select status, count(*) n from public.recall_matches group by 1) x),
  'alerts', (select count(*) from public.alerts)
) as observed;
