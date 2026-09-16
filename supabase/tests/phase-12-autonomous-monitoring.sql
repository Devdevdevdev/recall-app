begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(56);

select extensions.has_table('private', 'recall_automation_control', 'automation control is private');
select extensions.has_table('private', 'recall_automation_state', 'automation watermark is private');
select extensions.has_table('private', 'recall_automation_runs', 'automation run history is private');
select extensions.has_table('private', 'recall_automation_lease', 'automation lease is private');
select extensions.has_table(
  'private',
  'recall_automation_pending_recalls',
  'affected recall retry state is private'
);

select extensions.is(
  (select enabled from private.recall_automation_control where singleton),
  false,
  'automation is disabled initially'
);
select extensions.is(
  (select ai_enabled from private.recall_automation_control where singleton),
  false,
  'automatic AI is disabled initially'
);
select extensions.is(
  (select push_enabled from private.recall_automation_control where singleton),
  false,
  'automatic push is disabled initially'
);
select extensions.is(
  (select max_ai_escalations_per_run from private.recall_automation_control where singleton),
  5,
  'automatic AI has a five-call hard run cap'
);
select extensions.is(
  (select overlap_hours from private.recall_automation_control where singleton),
  48,
  'the LastPublishDate window overlaps by 48 hours'
);

select extensions.ok(
  not pg_catalog.has_schema_privilege('anon', 'private', 'USAGE'),
  'anonymous users cannot use the private schema'
);
select extensions.ok(
  not pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE'),
  'authenticated users cannot use the private schema'
);
select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'private.recall_automation_control', 'SELECT'),
  'authenticated users cannot read automation controls'
);
select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'private.recall_automation_runs', 'SELECT'),
  'authenticated users cannot read automation runs'
);
select extensions.ok(
  not pg_catalog.has_table_privilege('service_role', 'private.recall_automation_lease', 'SELECT,INSERT,UPDATE,DELETE'),
  'service role has no direct automation lease table privilege'
);

select extensions.has_function(
  'public',
  'claim_recall_automation_run',
  array['text', 'boolean', 'integer', 'integer', 'integer', 'integer', 'timestamp with time zone', 'integer'],
  'service-only run claim RPC exists'
);
select extensions.has_function(
  'public',
  'record_recall_automation_ingestion',
  array['uuid', 'uuid', 'integer', 'integer', 'integer', 'integer', 'uuid[]'],
  'service-only ingestion checkpoint RPC exists'
);
select extensions.has_function(
  'public',
  'get_recall_automation_pending_recalls',
  array['uuid', 'uuid', 'integer'],
  'service-only pending recall RPC exists'
);
select extensions.has_function(
  'public',
  'record_recall_automation_matching',
  array['uuid', 'uuid', 'uuid[]', 'boolean', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer', 'integer'],
  'service-only matching checkpoint RPC exists'
);
select extensions.has_function(
  'public',
  'complete_recall_automation_run',
  array['uuid', 'uuid', 'text', 'integer', 'integer', 'integer', 'text', 'text'],
  'service-only completion RPC exists'
);

select extensions.ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.claim_recall_automation_run(text,boolean,integer,integer,integer,integer,timestamptz,integer)',
    'EXECUTE'
  ),
  'authenticated users cannot claim automation runs'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.record_recall_automation_ingestion(uuid,uuid,integer,integer,integer,integer,uuid[])',
    'EXECUTE'
  ),
  'authenticated users cannot advance the automation watermark'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.complete_recall_automation_run(uuid,uuid,text,integer,integer,integer,text,text)',
    'EXECUTE'
  ),
  'authenticated users cannot finalize automation runs'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.claim_recall_automation_run(text,boolean,integer,integer,integer,integer,timestamptz,integer)',
    'EXECUTE'
  ),
  'anonymous users cannot claim automation runs'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'service_role',
    'public.claim_recall_automation_run(text,boolean,integer,integer,integer,integer,timestamptz,integer)',
    'EXECUTE'
  ),
  'service role can claim through the bounded RPC'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'service_role',
    'public.record_recall_automation_ingestion(uuid,uuid,integer,integer,integer,integer,uuid[])',
    'EXECUTE'
  ),
  'service role can checkpoint ingestion through the RPC'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'service_role',
    'public.complete_recall_automation_run(uuid,uuid,text,integer,integer,integer,text,text)',
    'EXECUTE'
  ),
  'service role can finalize through the RPC'
);

create temporary table phase12_disabled_claim as
select *
from public.claim_recall_automation_run(
  'cron', false, null, null, null, null, '2099-01-10 00:00:00+00', 1800
);

select extensions.is(
  (select claim_status from phase12_disabled_claim),
  'skipped_disabled',
  'disabled automation returns a clean skipped result'
);
select extensions.is(
  (
    select status
    from private.recall_automation_runs
    where id = (select run_id from phase12_disabled_claim)
  ),
  'skipped_disabled',
  'disabled invocation is visible in aggregate run history'
);

update private.recall_automation_control
set enabled = true, updated_at = '2099-01-10 00:00:00+00'
where singleton;

create temporary table phase12_first_claim as
select *
from public.claim_recall_automation_run(
  'cron', false, 20, 200, 5, 25, '2099-01-10 00:00:00+00', 1800
);

select extensions.is(
  (select claim_status from phase12_first_claim),
  'claimed',
  'the first enabled invocation claims the singleton lease'
);
select extensions.is(
  (select window_start from phase12_first_claim),
  '2099-01-04'::date,
  'the initial bootstrap covers seven inclusive UTC dates'
);
select extensions.is(
  (select window_end from phase12_first_claim),
  '2099-01-10'::date,
  'the bootstrap upper boundary is bounded server time'
);

create temporary table phase12_overlap_claim as
select *
from public.claim_recall_automation_run(
  'cron', false, null, null, null, null, '2099-01-10 00:05:00+00', 1800
);

select extensions.is(
  (select claim_status from phase12_overlap_claim),
  'already_running',
  'a healthy lease prevents overlapping automation'
);
select extensions.is(
  (
    select count(*)
    from private.recall_automation_lease
    where run_id = (select run_id from phase12_first_claim)
  ),
  1::bigint,
  'only one active lease exists'
);

create temporary table phase12_recovered_claim as
select *
from public.claim_recall_automation_run(
  'manual', true, 10, 100, 0, 10, '2099-01-10 01:00:00+00', 1800
);

select extensions.is(
  (select claim_status from phase12_recovered_claim),
  'claimed',
  'a stale lease is recovered by the next invocation'
);
select extensions.is(
  (
    select status
    from private.recall_automation_runs
    where id = (select run_id from phase12_first_claim)
  ),
  'failed',
  'the stale prior run is closed as failed'
);
select extensions.is(
  (
    select error_code
    from private.recall_automation_runs
    where id = (select run_id from phase12_first_claim)
  ),
  'lease_expired',
  'stale recovery records a bounded error code'
);
select extensions.is(
  (select max_ai_escalations from phase12_recovered_claim),
  0,
  'verification mode forces a zero AI budget'
);
select extensions.is(
  (select push_enabled from phase12_recovered_claim),
  false,
  'verification mode forces push off'
);

insert into public.recall_sources (
  id, name, jurisdiction, base_url, is_authoritative, created_at, updated_at
) values (
  '41000000-0000-4000-8000-000000000004',
  'U.S. Consumer Product Safety Commission (CPSC)',
  'US',
  'https://www.cpsc.gov',
  true,
  '2099-01-10 00:00:00+00',
  '2099-01-10 00:00:00+00'
);

insert into public.recall_notices (
  id, source_id, external_id, title, recall_date, official_url, retrieved_at, raw_payload,
  created_at, updated_at
) values (
  '42000000-0000-4000-8000-000000000004',
  '41000000-0000-4000-8000-000000000004',
  'phase-12-test',
  'Phase 12 controlled recall',
  '2099-01-09',
  'https://www.cpsc.gov/Recalls/2099/phase-12-test',
  '2099-01-10 01:00:00+00',
  '{"RecallID":"phase-12-test","LastPublishDate":"2099-01-09T00:00:00"}'::jsonb,
  '2099-01-10 00:00:00+00',
  '2099-01-10 00:00:00+00'
);

select public.record_recall_automation_ingestion(
  (select run_id from phase12_recovered_claim),
  (select lease_token from phase12_recovered_claim),
  1, 1, 0, 0,
  array['42000000-0000-4000-8000-000000000004'::uuid]
);

select extensions.is(
  (select last_successful_watermark from private.recall_automation_state where singleton),
  '2099-01-10'::date,
  'successful authoritative ingestion advances the watermark'
);
select extensions.is(
  (
    select count(*)
    from private.recall_automation_pending_recalls
    where recall_notice_id = '42000000-0000-4000-8000-000000000004'
  ),
  1::bigint,
  'new or changed recalls remain pending for matching'
);
select extensions.is(
  (
    select affected_recalls
    from private.recall_automation_runs
    where id = (select run_id from phase12_recovered_claim)
  ),
  1,
  'run history stores aggregate affected recall metrics'
);
select extensions.is(
  (
    select count(*)
    from public.get_recall_automation_pending_recalls(
      (select run_id from phase12_recovered_claim),
      (select lease_token from phase12_recovered_claim),
      10
    )
  ),
  1::bigint,
  'the active run can retrieve its bounded affected set'
);

select public.record_recall_automation_matching(
  (select run_id from phase12_recovered_claim),
  (select lease_token from phase12_recovered_claim),
  array['42000000-0000-4000-8000-000000000004'::uuid],
  true,
  1, 1, 1, 0, 0, 0, 0, 1
);

select extensions.is(
  (select count(*) from private.recall_automation_pending_recalls),
  0::bigint,
  'fully successful matching clears the affected recall retry entry'
);
select extensions.is(
  (
    select candidate_pairs
    from private.recall_automation_runs
    where id = (select run_id from phase12_recovered_claim)
  ),
  1,
  'matching aggregate metrics are persisted'
);

select public.complete_recall_automation_run(
  (select run_id from phase12_recovered_claim),
  (select lease_token from phase12_recovered_claim),
  'success', 0, 0, 0, null, null
);

select extensions.is(
  (select count(*) from private.recall_automation_lease),
  0::bigint,
  'successful completion releases the automation lease'
);

create temporary table phase12_catchup_claim as
select *
from public.claim_recall_automation_run(
  'cron', false, null, null, null, null, '2099-02-10 00:00:00+00', 1800
);

select extensions.is(
  (select window_start from phase12_catchup_claim),
  '2099-01-08'::date,
  'catch-up starts 48 hours before the successful watermark'
);
select extensions.is(
  (select window_end from phase12_catchup_claim),
  '2099-01-17'::date,
  'long downtime advances by only one bounded seven-day catch-up window'
);

select public.complete_recall_automation_run(
  (select run_id from phase12_catchup_claim),
  (select lease_token from phase12_catchup_claim),
  'failed', 0, 0, 0, 'ingestion', 'cpsc_unavailable'
);

select extensions.is(
  (select last_successful_watermark from private.recall_automation_state where singleton),
  '2099-01-10'::date,
  'a failed ingestion run does not advance the watermark'
);

select extensions.throws_ok(
  $$
    select public.claim_recall_automation_run(
      'manual', false, 101, 200, 0, 25, '2099-02-10 00:00:00+00', 1800
    )
  $$,
  'P0001',
  'requested automation limits exceed server controls',
  'manual invocations cannot exceed server hard caps'
);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '51000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated',
    'phase12-a@example.invalid', '', '2099-01-01 00:00:00+00', '{}'::jsonb, '{}'::jsonb,
    '2099-01-01 00:00:00+00', '2099-01-01 00:00:00+00'
  ),
  (
    '52000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated',
    'phase12-b@example.invalid', '', '2099-01-01 00:00:00+00', '{}'::jsonb, '{}'::jsonb,
    '2099-01-01 00:00:00+00', '2099-01-01 00:00:00+00'
  );

insert into public.owned_products (
  id, user_id, product_name, identification_method, created_at, updated_at
) values (
  '53000000-0000-4000-8000-000000000005',
  '51000000-0000-4000-8000-000000000005',
  'Phase 12 private product',
  'manual',
  '2099-01-01 00:00:00+00',
  '2099-01-01 00:00:00+00'
);

set local role authenticated;
set local request.jwt.claim.sub = '52000000-0000-4000-8000-000000000005';
select extensions.is(
  (
    select count(*)
    from public.owned_products
    where id = '53000000-0000-4000-8000-000000000005'
  ),
  0::bigint,
  'Phase 12 preserves the existing cross-user owned-product RLS boundary'
);
reset role;

select extensions.ok(
  pg_catalog.has_table_privilege('authenticated', 'public.recall_matches', 'SELECT'),
  'Phase 10 authenticated recall-match read privilege remains intact'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.register_push_device(text,text)',
    'EXECUTE'
  ),
  'Phase 11 authenticated push registration privilege remains intact'
);
select extensions.has_function(
  'private',
  'install_recall_automation_cron',
  array[]::text[],
  'Vault-backed Cron installer exists privately'
);
select extensions.has_function(
  'private',
  'set_recall_automation_cron_active',
  array['boolean'],
  'Cron activation control exists privately'
);
select extensions.is(
  (
    select count(*)
    from cron.job
    where jobname = 'recall-automation-every-6h'
  ),
  0::bigint,
  'migration does not activate or install the production Cron job'
);

select * from extensions.finish();

rollback;
