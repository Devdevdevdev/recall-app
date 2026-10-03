-- Phase 17.7a-2: lease-bound, read-only product-check flag for run-recall-automation.
-- Runs on the local stack only; everything is rolled back.
begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(16);

-- ===========================================================================
-- Shape and privilege boundary.
-- ===========================================================================
select extensions.ok(
  (select p.prosecdef and p.proconfig = array['search_path=""']
     and p.provolatile = 's'
   from pg_proc p
   where p.oid = 'public.get_recall_automation_product_check_plan(uuid,uuid)'::regprocedure),
  'the plan RPC is a stable SECURITY DEFINER function with an empty search_path'
);
select extensions.ok(
  not pg_catalog.has_function_privilege('anon',
    'public.get_recall_automation_product_check_plan(uuid,uuid)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('authenticated',
    'public.get_recall_automation_product_check_plan(uuid,uuid)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('public',
    'public.get_recall_automation_product_check_plan(uuid,uuid)', 'EXECUTE'),
  'anon, authenticated and public cannot read the plan'
);
select extensions.ok(
  pg_catalog.has_function_privilege('service_role',
    'public.get_recall_automation_product_check_plan(uuid,uuid)', 'EXECUTE'),
  'service_role (the automation) can read the plan'
);
select extensions.is(
  (select product_check_enabled from private.recall_automation_control where singleton),
  false,
  'the product-check flag still defaults to false'
);

-- ===========================================================================
-- Lease binding.
-- ===========================================================================
select extensions.throws_ok(
  $$select * from public.get_recall_automation_product_check_plan(
      gen_random_uuid(), gen_random_uuid())$$,
  'automation run lease is unavailable',
  'without a live run lease the plan is refused'
);

update private.recall_automation_control set enabled = true where singleton;
create temporary table p1772_claim as
select * from public.claim_recall_automation_run(
  'cron', false, null, null, null, null, pg_catalog.now(), 1800
);
select extensions.is(
  (select claim_status from p1772_claim), 'claimed', 'a run lease is claimed for the test'
);

select extensions.throws_ok(
  $$select * from public.get_recall_automation_product_check_plan(
      (select run_id from p1772_claim), gen_random_uuid())$$,
  'automation run lease is unavailable',
  'a wrong lease token is refused'
);
select extensions.throws_ok(
  $$select * from public.get_recall_automation_product_check_plan(
      gen_random_uuid(), (select lease_token from p1772_claim))$$,
  'automation run lease is unavailable',
  'a wrong run id is refused'
);

-- ===========================================================================
-- Value and absence of side effects.
-- ===========================================================================
create temporary table p1772_before as
select
  (select count(*) from private.owned_product_recall_checks) as jobs,
  (select count(*) from private.owned_product_recall_check_events) as events,
  (select md5(string_agg(r::text, '|' order by r.id)) from private.recall_automation_runs r) as runs,
  (select md5(l::text) from private.recall_automation_lease l) as lease,
  (select md5(c::text) from private.recall_automation_control c) as control;

select extensions.is(
  (select product_check_enabled from public.get_recall_automation_product_check_plan(
     (select run_id from p1772_claim), (select lease_token from p1772_claim))),
  false,
  'the live run reads false by default'
);
select extensions.is(
  (select count(*)::integer from public.get_recall_automation_product_check_plan(
     (select run_id from p1772_claim), (select lease_token from p1772_claim))),
  1,
  'exactly one row'
);
select extensions.ok(
  (select
     b.jobs = (select count(*) from private.owned_product_recall_checks)
     and b.events = (select count(*) from private.owned_product_recall_check_events)
     and b.runs is not distinct from
       (select md5(string_agg(r::text, '|' order by r.id)) from private.recall_automation_runs r)
     and b.lease is not distinct from (select md5(l::text) from private.recall_automation_lease l)
     and b.control is not distinct from (select md5(c::text) from private.recall_automation_control c)
   from p1772_before b),
  'reading the plan changes no job, event, run, lease or control row'
);

-- Test-only toggle inside this rolled-back transaction.
update private.recall_automation_control set product_check_enabled = (1 = 1) where singleton;
select extensions.is(
  (select product_check_enabled from public.get_recall_automation_product_check_plan(
     (select run_id from p1772_claim), (select lease_token from p1772_claim))),
  true,
  'the plan reflects the control flag'
);
update private.recall_automation_control set product_check_enabled = (1 = 0) where singleton;

update private.recall_automation_lease
set claimed_at = pg_catalog.now() - interval '2 hours',
  expires_at = pg_catalog.now() - interval '1 hour'
where run_id = (select run_id from p1772_claim);
select extensions.throws_ok(
  $$select * from public.get_recall_automation_product_check_plan(
      (select run_id from p1772_claim), (select lease_token from p1772_claim))$$,
  'automation run lease is unavailable',
  'an expired lease is refused'
);

-- ===========================================================================
-- No scheduler change, no write path.
-- ===========================================================================
select extensions.is(
  (select count(*)::integer from cron.job where command ilike '%product%check%'),
  0,
  'no cron job runs product checks'
);
select extensions.ok(
  not exists (
    select 1 from pg_proc p
    where p.proname = 'get_recall_automation_product_check_plan'
      and pg_catalog.pg_get_functiondef(p.oid) ~* '\m(insert|update|delete)\M'
  ),
  'the plan function contains no write statement'
);
select extensions.is(
  (select count(*)::integer from pg_proc where proname = 'get_recall_automation_product_check_plan'),
  1,
  'a single overload'
);

select * from extensions.finish();
rollback;
