-- Phase 17.7a install, after GO 17.7A2-MIGRATION (and again inside GO 17.7A-REMOTE-VERIFY).
-- READ-ONLY: one SELECT, the plan function is NOT called, no personal data.
-- Expected: every value in "checks" is true; "observed" equals the preflight counts
-- (plus the test account's rows once the controlled user test has started).
with
f4 as (
  select jsonb_object_agg(p.proname, md5(pg_get_functiondef(p.oid))) as md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'public' and p.proname in ('finalize_recall_match_evaluation',
      'finalize_recall_match_evaluation_v2', 'create_recall_v2_alert', 'queue_recall_push_alerts'))
    or (n.nspname = 'private' and (p.proname like 'automatic_alert%'
      or p.proname like 'require_safe%' or p.proname = 'neutralize_unsafe_automatic_alerts'))
),
p1 as (
  select jsonb_object_agg(n.nspname || '.' || p.proname, md5(pg_get_functiondef(p.oid))) as md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.proname in ('get_owned_product_recall_candidates', 'owned_product_monitoring_state',
    'owned_product_check_backoff', 'claim_owned_product_recall_check_row',
    'claim_owned_product_recall_check', 'claim_due_owned_product_recall_checks',
    'complete_owned_product_recall_check', 'get_my_product_monitoring_states',
    'arm_owned_product_recall_check', 'owned_product_recall_check_events_immutable')
)
select jsonb_build_object(
  'migrations_35_last_17_7a_2',
    (select count(*) = 35 and max(version) = '20261003090000' from supabase_migrations.schema_migrations),
  'history_matches_repo_6bab7d3',
    (select md5(string_agg(version || coalesce(name, ''), '' order by version)) = 'a07eb32d7999326a89ec7a9d8c0454c3'
     from supabase_migrations.schema_migrations),
  'plan_rpc_present_stable_definer',
    (select prosecdef and provolatile = 's' and proconfig = array['search_path=""']
     from pg_proc where oid = to_regprocedure('public.get_recall_automation_product_check_plan(uuid,uuid)')),
  'plan_rpc_service_role_only',
    has_function_privilege('service_role', 'public.get_recall_automation_product_check_plan(uuid,uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.get_recall_automation_product_check_plan(uuid,uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_recall_automation_product_check_plan(uuid,uuid)', 'EXECUTE')
    and not has_function_privilege('public', 'public.get_recall_automation_product_check_plan(uuid,uuid)', 'EXECUTE'),
  'plan_rpc_lease_bound_and_read_only',
    (select pg_get_functiondef(oid) ~ 'automation_lease\.lease_token = p_lease_token'
       and pg_get_functiondef(oid) ~ 'expires_at > pg_catalog\.now\(\)'
       and pg_get_functiondef(oid) !~* '\m(insert|update|delete)\M'
     from pg_proc where oid = to_regprocedure('public.get_recall_automation_product_check_plan(uuid,uuid)')),
  'plan_rpc_as_rehearsed',
    (select md5(pg_get_functiondef(oid)) = 'c13587657a7c62196ba3ce1e0b8aed83'
     from pg_proc where oid = to_regprocedure('public.get_recall_automation_product_check_plan(uuid,uuid)')),
  'tables_present_with_rls',
    (select count(*) = 2 and bool_and(relrowsecurity) from pg_class
     where oid in (to_regclass('private.owned_product_recall_checks'),
                   to_regclass('private.owned_product_recall_check_events'))),
  'no_api_role_table_privilege',
    not exists (select 1
      from unnest(array['anon', 'authenticated', 'service_role']) r(role_name)
      cross join unnest(array['private.owned_product_recall_checks',
        'private.owned_product_recall_check_events']) t(table_name)
      cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p(privilege)
      where has_table_privilege(r.role_name, t.table_name, p.privilege)),
  'owned_products_arm_triggers_enabled',
    (select count(*) = 2 from pg_trigger where not tgisinternal and tgenabled = 'O'
     and tgrelid = 'public.owned_products'::regclass
     and tgname in ('owned_products_arm_recall_check_insert', 'owned_products_arm_recall_check_update')),
  'existing_owned_products_triggers_kept',
    (select count(*) = 3 from pg_trigger where not tgisinternal and tgenabled = 'O'
     and tgrelid = 'public.owned_products'::regclass and tgname in
     ('owned_products_protect_created_at', 'owned_products_protect_owner', 'owned_products_set_updated_at')),
  'journal_immutability_triggers',
    (select count(*) = 2 from pg_trigger where not tgisinternal and tgenabled = 'O'
     and tgname in ('owned_product_recall_check_events_no_update',
                    'owned_product_recall_check_events_no_truncate')),
  'flag_false',
    (select product_check_enabled = false from private.recall_automation_control where singleton),
  'flag_column_default_false',
    (select column_default = 'false' and is_nullable = 'NO' from information_schema.columns
     where table_schema = 'private' and table_name = 'recall_automation_control'
       and column_name = 'product_check_enabled'),
  'max_candidates_25',
    (select max_product_check_candidates = 25 from private.recall_automation_control where singleton),
  'automation_control_unchanged',
    (select enabled and ai_enabled and push_enabled and max_recalls_per_run = 100
       and max_candidate_pairs_per_run = 500 and max_ai_escalations_per_run = 5
       and max_notification_batch_size = 25
     from private.recall_automation_control where singleton),
  'service_rpcs_not_for_clients',
    not exists (select 1 from unnest(array['anon', 'authenticated']) r(role_name)
      cross join unnest(array[
        'public.get_owned_product_recall_candidates(uuid,integer,uuid,integer)',
        'public.claim_owned_product_recall_check(uuid,uuid,integer)',
        'public.claim_due_owned_product_recall_checks(integer,integer)',
        'public.complete_owned_product_recall_check(uuid,uuid,bigint,text,text,integer,uuid,text)'
      ]) f(signature)
      where has_function_privilege(r.role_name, f.signature, 'EXECUTE')),
  'service_rpcs_for_service_role',
    has_function_privilege('service_role', 'public.claim_owned_product_recall_check(uuid,uuid,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.claim_due_owned_product_recall_checks(integer,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.complete_owned_product_recall_check(uuid,uuid,bigint,text,text,integer,uuid,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.get_owned_product_recall_candidates(uuid,integer,uuid,integer)', 'EXECUTE'),
  'monitoring_read_authenticated_only',
    has_function_privilege('authenticated', 'public.get_my_product_monitoring_states(uuid[])', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_my_product_monitoring_states(uuid[])', 'EXECUTE'),
  'private_helpers_not_for_api_roles',
    not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role_name)
      cross join unnest(array[
        'private.owned_product_monitoring_state(uuid)',
        'private.owned_product_check_backoff(integer)',
        'private.claim_owned_product_recall_check_row(uuid,text,integer)',
        'private.arm_owned_product_recall_check()',
        'private.owned_product_recall_check_events_immutable()'
      ]) f(signature)
      where has_function_privilege(r.role_name, f.signature, 'EXECUTE')),
  'definers_with_empty_search_path',
    (select bool_and(prosecdef and proconfig = array['search_path=""'])
     from pg_proc where proname in ('get_owned_product_recall_candidates',
       'owned_product_monitoring_state', 'claim_owned_product_recall_check_row',
       'claim_owned_product_recall_check', 'claim_due_owned_product_recall_checks',
       'complete_owned_product_recall_check', 'get_my_product_monitoring_states',
       'arm_owned_product_recall_check')),
  'candidate_indexes_present',
    (select count(*) = 4 from pg_indexes where schemaname = 'public' and indexname in
     ('recall_notices_title_fts_idx', 'recall_scopes_normalized_brand_idx',
      'recall_scopes_serial_range_idx', 'recall_scopes_lot_range_idx')),
  'one_job_per_existing_product',
    (select count(*) from private.owned_product_recall_checks) = (select count(*) from public.owned_products),
  'no_check_event_beyond_arming',
    not exists (select 1 from private.owned_product_recall_check_events where event <> 'armed'),
  'p17_7a_1_definitions_as_rehearsed',
    (select md5 = '{"private.owned_product_check_backoff":"67d6798fd6bacaa7e85ccb762143b62b","private.arm_owned_product_recall_check":"7bd2af7352bb3fea535ae1ed070e73b5","private.owned_product_monitoring_state":"270f39aaaa7b44b38593f6a5cd958fe6","public.claim_owned_product_recall_check":"2bf8dd58c309ab09e889045eb4cdbde1","public.get_my_product_monitoring_states":"77634cab3126b67d39398480b2e1619e","public.complete_owned_product_recall_check":"784d7ffe4272a2a518cd0af39d162df4","public.get_owned_product_recall_candidates":"0bcf8890a3a2fdac552d11c12b52d99a","private.claim_owned_product_recall_check_row":"2a430571dbfba7028292f19744771046","public.claim_due_owned_product_recall_checks":"06a936b2c2bdd00f465a6c4980407b33","private.owned_product_recall_check_events_immutable":"01e2e138124f860297df399b4015abbf"}'::jsonb from p1),
  'f4_triggers_enabled',
    (select count(*) = 5 from pg_trigger where not tgisinternal and tgenabled = 'O' and tgname in (
      'alerts_require_safe_scope', 'recall_alert_eligibility_v2_require_safe_scope',
      'recall_alert_snapshots_v2_require_safe_scope', 'recall_matches_require_safe_confirmation',
      'recall_match_evaluations_v2_require_safe_confirmation')),
  'f4_definitions_unchanged',
    (select md5 = '{"require_safe_v1_alert":"8cf3e3f4f07701f4cf37815ab9c7367c","create_recall_v2_alert":"9d94fb32a269916d9389de148fe6a847","queue_recall_push_alerts":"6210d9aa0e05feefa714033dd07a5245","require_safe_confirmation":"3afa5ad918ee8d05702a10feba734784","automatic_alert_identifier":"f6c92bb32cbb4fb9c6007516480c198f","automatic_alert_eligibility":"b6a31c8dd6b5e631b0ec2a1038483353","require_safe_v2_eligibility":"ff4d5b3453a2c956cc2bfd5b3728539e","automatic_alert_jurisdiction":"5a2a069346927d10c444d6ee33f7e6dc","automatic_alert_classification":"b1aac773a5ef98363a09fcb6b103355f","automatic_alert_rule_set_valid":"95556d9eec5e6ec6d48154d418e94235","require_safe_v2_alert_snapshot":"d258b88b9bd3923081a8f104b60573a4","finalize_recall_match_evaluation":"fbd878906a7ea59b0a6dd310620107f3","neutralize_unsafe_automatic_alerts":"b47d299025b5530b53bfbb1df03512fe","finalize_recall_match_evaluation_v2":"d4735250828425086d32c7d23ebd1f34"}'::jsonb from f4),
  'single_recall_cron_unchanged',
    (select count(*) = 1 and bool_and(jobname = 'recall-automation-every-6h' and schedule = '17 */6 * * *'
       and active and md5(command) = 'aae24c409d36e91c64b4e1732d6c6651') from cron.job),
  'no_automation_run_in_progress',
    not exists (select 1 from private.recall_automation_lease)
) as checks,
jsonb_build_object(
  'p17_7a_1_definitions_md5', (select md5 from p1),
  'owned_products', (select count(*) from public.owned_products),
  'product_check_jobs', (select count(*) from private.owned_product_recall_checks),
  'product_check_events', (select count(*) from private.owned_product_recall_check_events),
  'recall_matches', (select count(*) from public.recall_matches),
  'alerts', (select count(*) from public.alerts),
  'push_queue', (select count(*) from private.push_alert_queue),
  'push_deliveries', (select count(*) from private.push_deliveries),
  'v2_evaluations', (select count(*) from private.recall_match_evaluations_v2),
  'v2_eligibility', (select count(*) from private.recall_alert_eligibility_v2),
  'v2_snapshots', (select count(*) from private.recall_alert_snapshots_v2),
  'pending_recalls', (select count(*) from private.recall_automation_pending_recalls),
  'notices', (select count(*) from public.recall_notices)
) as observed;
