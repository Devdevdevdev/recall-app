begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(61);

select extensions.has_table(
  'public',
  'country_codes',
  'the supported country catalog is enforced by the database'
);
select extensions.is(
  (select count(*) from public.country_codes),
  249::bigint,
  'the database country catalog contains all 249 ISO alpha-2 entries'
);
select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'country_codes'
  ),
  'the internal country catalog is protected by RLS'
);

select extensions.has_column(
  'public',
  'owned_products',
  'purchase_country_code',
  'owned products store country of purchase'
);
select extensions.ok(
  (
    select column_info.is_nullable = 'YES'
    from information_schema.columns as column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = 'owned_products'
      and column_info.column_name = 'purchase_country_code'
  ),
  'country of purchase remains nullable for existing products'
);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '13000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'phase13-a@example.invalid', '', '2099-01-01 00:00:00+00', '{}'::jsonb, '{}'::jsonb,
    '2099-01-01 00:00:00+00', '2099-01-01 00:00:00+00'
  ),
  (
    '13000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'phase13-b@example.invalid', '', '2099-01-01 00:00:00+00', '{}'::jsonb, '{}'::jsonb,
    '2099-01-01 00:00:00+00', '2099-01-01 00:00:00+00'
  );

insert into public.owned_products (
  id, user_id, product_name, purchase_country_code, identification_method,
  created_at, updated_at
)
values
  (
    '13000000-0000-4000-8000-000000000011',
    '13000000-0000-4000-8000-000000000001',
    'Phase 13 Belgium product',
    'BE',
    'manual',
    '2099-01-01 00:00:00+00',
    '2099-01-01 00:00:00+00'
  ),
  (
    '13000000-0000-4000-8000-000000000012',
    '13000000-0000-4000-8000-000000000001',
    'Phase 13 legacy-compatible product',
    null,
    'manual',
    '2099-01-01 00:00:00+00',
    '2099-01-01 00:00:00+00'
  );

select extensions.is(
  (
    select purchase_country_code
    from public.owned_products
    where id = '13000000-0000-4000-8000-000000000011'
  ),
  'BE',
  'a canonical alpha-2 country code is accepted'
);
select extensions.is(
  (
    select purchase_country_code
    from public.owned_products
    where id = '13000000-0000-4000-8000-000000000012'
  ),
  null,
  'a product can keep an unspecified country'
);
select extensions.throws_ok(
  $$
    insert into public.owned_products (
      user_id, product_name, purchase_country_code, identification_method
    ) values (
      '13000000-0000-4000-8000-000000000001', 'Lowercase country', 'be', 'manual'
    )
  $$,
  '23514',
  null,
  'lowercase country codes are rejected'
);
select extensions.throws_ok(
  $$
    insert into public.owned_products (
      user_id, product_name, purchase_country_code, identification_method
    ) values (
      '13000000-0000-4000-8000-000000000001', 'Free-text country', 'Belgium', 'manual'
    )
  $$,
  '23514',
  null,
  'free-text country names are rejected'
);
select extensions.throws_ok(
  $$
    insert into public.owned_products (
      user_id, product_name, purchase_country_code, identification_method
    ) values (
      '13000000-0000-4000-8000-000000000001', 'Unsupported country', 'ZZ', 'manual'
    )
  $$,
  '23503',
  null,
  'well-formed but unsupported product country codes are rejected'
);

select extensions.has_table('public', 'user_preferences', 'user preferences are persisted');
select extensions.has_column(
  'public',
  'user_preferences',
  'default_purchase_country_code',
  'preferences store the default country of purchase'
);
select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'user_preferences'
  ),
  'user preferences have RLS enabled'
);
select extensions.ok(
  pg_catalog.has_table_privilege(
    'authenticated',
    'public.user_preferences',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'authenticated users have preference operations mediated by RLS'
);

set local role authenticated;
set local request.jwt.claim.sub = '13000000-0000-4000-8000-000000000001';
insert into public.user_preferences (user_id, default_purchase_country_code)
values ('13000000-0000-4000-8000-000000000001', 'BE');
select extensions.is(
  (
    select default_purchase_country_code
    from public.user_preferences
    where user_id = '13000000-0000-4000-8000-000000000001'
  ),
  'BE',
  'a user can read its own default country'
);
select extensions.throws_ok(
  $$
    insert into public.user_preferences (user_id, default_purchase_country_code)
    values ('13000000-0000-4000-8000-000000000002', 'US')
  $$,
  '42501',
  null,
  'a user cannot create another user preference row'
);
select extensions.throws_ok(
  $$
    update public.user_preferences
    set default_purchase_country_code = 'be'
    where user_id = '13000000-0000-4000-8000-000000000001'
  $$,
  '23514',
  null,
  'malformed default country codes are rejected'
);
select extensions.throws_ok(
  $$
    update public.user_preferences
    set default_purchase_country_code = 'ZZ'
    where user_id = '13000000-0000-4000-8000-000000000001'
  $$,
  '23503',
  null,
  'well-formed but unsupported preference country codes are rejected'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '13000000-0000-4000-8000-000000000002';
select extensions.is(
  (
    select count(*)
    from public.user_preferences
    where user_id = '13000000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'another user cannot read the preference row'
);
update public.user_preferences
set default_purchase_country_code = 'US'
where user_id = '13000000-0000-4000-8000-000000000001';
reset role;
select extensions.is(
  (
    select default_purchase_country_code
    from public.user_preferences
    where user_id = '13000000-0000-4000-8000-000000000001'
  ),
  'BE',
  'another user cannot update the preference row'
);

select extensions.has_table(
  'public',
  'recall_notice_jurisdictions',
  'recall notice jurisdictions are normalized'
);
select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_constraint as constraint_info
    join pg_catalog.pg_class as relation on relation.oid = constraint_info.conrelid
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'recall_notice_jurisdictions'
      and constraint_info.contype = 'f'
      and constraint_info.confdeltype = 'c'
  ),
  'jurisdictions are deleted with their notice'
);
select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_constraint as constraint_info
    join pg_catalog.pg_class as relation on relation.oid = constraint_info.conrelid
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'recall_notice_jurisdictions'
      and constraint_info.contype = 'u'
  ),
  'duplicate notice jurisdictions are prevented'
);
select extensions.has_column(
  'public',
  'recall_sources',
  'source_language_code',
  'recall sources store source language metadata'
);
select extensions.ok(
  (
    select column_info.is_nullable = 'YES'
    from information_schema.columns as column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = 'recall_sources'
      and column_info.column_name = 'source_language_code'
  ),
  'source language remains nullable for future source onboarding'
);

select public.ensure_cpsc_recall_source();

select extensions.is(
  (
    select source_language_code
    from public.recall_sources
    where name = 'U.S. Consumer Product Safety Commission (CPSC)'
      and jurisdiction = 'US'
      and base_url = 'https://www.cpsc.gov'
    order by created_at
    limit 1
  ),
  'en',
  'the CPSC source is identified as English'
);

select extensions.throws_ok(
  $$
    insert into public.recall_sources (
      name, jurisdiction, base_url, is_authoritative, source_language_code
    ) values (
      'Invalid language source', 'ZZ', 'https://invalid.example', false, 'EN'
    )
  $$,
  '23514',
  null,
  'non-canonical source language codes are rejected'
);

select extensions.is(
  public.ingest_cpsc_recall(
    'phase-13-cpsc-test',
    'Phase 13 controlled recall',
    'Controlled database fixture.',
    'Controlled hazard.',
    'Controlled remedy.',
    '2099-01-12',
    'https://www.cpsc.gov/Recalls/2099/phase-13-cpsc-test',
    '2099-01-13 00:00:00+00',
    '{"RecallID":"phase-13-cpsc-test"}'::jsonb,
    '[{"productName":"Phase 13 product"}]'::jsonb
  ),
  'inserted',
  'CPSC ingestion still inserts a new authoritative notice'
);

select extensions.is(
  (
    select count(*)
    from public.recall_notice_jurisdictions as jurisdiction
    join public.recall_notices as notice on notice.id = jurisdiction.recall_notice_id
    where notice.external_id = 'phase-13-cpsc-test'
      and jurisdiction.jurisdiction_type = 'country'
      and jurisdiction.jurisdiction_code = 'US'
  ),
  1::bigint,
  'a newly ingested CPSC notice receives United States jurisdiction'
);

select extensions.is(
  public.ingest_cpsc_recall(
    'phase-13-cpsc-test',
    'Phase 13 controlled recall',
    'Controlled database fixture.',
    'Controlled hazard.',
    'Controlled remedy.',
    '2099-01-12',
    'https://www.cpsc.gov/Recalls/2099/phase-13-cpsc-test',
    '2099-01-13 00:00:00+00',
    '{"RecallID":"phase-13-cpsc-test"}'::jsonb,
    '[{"productName":"Phase 13 product"}]'::jsonb
  ),
  'unchanged',
  'CPSC re-ingestion remains idempotent'
);
select extensions.is(
  (
    select count(*)
    from public.recall_notice_jurisdictions as jurisdiction
    join public.recall_notices as notice on notice.id = jurisdiction.recall_notice_id
    where notice.external_id = 'phase-13-cpsc-test'
      and jurisdiction.jurisdiction_type = 'country'
      and jurisdiction.jurisdiction_code = 'US'
  ),
  1::bigint,
  'idempotent ingestion never duplicates a notice jurisdiction'
);

select extensions.throws_ok(
  $$
    insert into public.recall_notice_jurisdictions (
      recall_notice_id, jurisdiction_type, jurisdiction_code
    ) values (
      (
        select id from public.recall_notices
        where external_id = 'phase-13-cpsc-test'
      ),
      'market',
      'US'
    )
  $$,
  '23514',
  null,
  'uncontrolled jurisdiction types are rejected'
);
select extensions.throws_ok(
  $$
    insert into public.recall_notice_jurisdictions (
      recall_notice_id, jurisdiction_type, jurisdiction_code
    ) values (
      (
        select id from public.recall_notices
        where external_id = 'phase-13-cpsc-test'
      ),
      'country',
      'usa'
    )
  $$,
  '23514',
  null,
  'malformed country jurisdiction codes are rejected'
);
select extensions.throws_ok(
  $$
    insert into public.recall_notice_jurisdictions (
      recall_notice_id, jurisdiction_type, jurisdiction_code
    ) values (
      (
        select id from public.recall_notices
        where external_id = 'phase-13-cpsc-test'
      ),
      'country',
      'ZZ'
    )
  $$,
  '23503',
  null,
  'well-formed but unsupported notice country jurisdictions are rejected'
);
select extensions.throws_ok(
  $$
    insert into public.recall_notice_jurisdictions (
      recall_notice_id, jurisdiction_type, jurisdiction_code
    ) values (
      (
        select id from public.recall_notices
        where external_id = 'phase-13-cpsc-test'
      ),
      'country',
      'US'
    )
  $$,
  '23505',
  null,
  'duplicate notice jurisdictions are rejected'
);

create temporary table phase13_notice_revision as
select updated_at
from public.recall_notices
where external_id = 'phase-13-cpsc-test';

insert into public.recall_notice_jurisdictions (
  recall_notice_id, jurisdiction_type, jurisdiction_code
)
select id, 'region', 'EU'
from public.recall_notices
where external_id = 'phase-13-cpsc-test';

select extensions.is(
  (
    select notice.updated_at
    from public.recall_notices as notice
    where notice.external_id = 'phase-13-cpsc-test'
  ),
  (select updated_at from phase13_notice_revision),
  'adding jurisdiction metadata does not mutate the notice matching revision'
);

select extensions.ok(
  pg_catalog.has_table_privilege(
    'authenticated',
    'public.recall_notice_jurisdictions',
    'SELECT'
  ),
  'authenticated users can read authoritative notice jurisdictions'
);
select extensions.ok(
  not pg_catalog.has_table_privilege(
    'authenticated',
    'public.recall_notice_jurisdictions',
    'INSERT,UPDATE,DELETE'
  ),
  'authenticated users cannot mutate notice jurisdictions'
);

select extensions.has_function(
  'public',
  'get_monitoring_status',
  array[]::text[],
  'the authenticated monitoring projection exists'
);
select extensions.ok(
  (
    select function_info.prosecdef
    from pg_catalog.pg_proc as function_info
    join pg_catalog.pg_namespace as namespace on namespace.oid = function_info.pronamespace
    where namespace.nspname = 'public'
      and function_info.proname = 'get_monitoring_status'
      and function_info.pronargs = 0
  ),
  'the monitoring projection is a security definer'
);
select extensions.ok(
  (
    select 'search_path=""' = any (function_info.proconfig)
    from pg_catalog.pg_proc as function_info
    join pg_catalog.pg_namespace as namespace on namespace.oid = function_info.pronamespace
    where namespace.nspname = 'public'
      and function_info.proname = 'get_monitoring_status'
      and function_info.pronargs = 0
  ),
  'the monitoring projection has a fixed empty search path'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.get_monitoring_status()',
    'EXECUTE'
  ),
  'authenticated users can read the safe monitoring projection'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.get_monitoring_status()',
    'EXECUTE'
  ),
  'anonymous users cannot read monitoring state'
);

insert into private.recall_automation_runs (
  trigger, verification_mode, started_at, completed_at, status,
  max_recalls, max_candidate_pairs, max_ai_escalations, notification_batch_size
)
values (
  'manual', false, '2099-01-13 11:55:00+00', '2099-01-13 12:00:00+00', 'success',
  100, 500, 5, 25
);

set local role authenticated;
set local request.jwt.claim.sub = '13000000-0000-4000-8000-000000000001';
create temporary table phase13_monitoring_status as
select * from public.get_monitoring_status();
reset role;

select extensions.is(
  (
    select pg_catalog.array_agg(output_key order by output_key)
    from phase13_monitoring_status as monitoring_status
    cross join lateral pg_catalog.jsonb_object_keys(
      pg_catalog.to_jsonb(monitoring_status)
    ) as output_key
  ),
  array['active_source_count', 'last_successful_check_at', 'monitoring_enabled']::text[],
  'monitoring status exposes exactly three safe aggregate fields'
);
select extensions.is(
  (select last_successful_check_at from phase13_monitoring_status),
  '2099-01-13 12:00:00+00'::timestamptz,
  'monitoring status reports the latest real successful check'
);
select extensions.is(
  (select active_source_count from phase13_monitoring_status),
  1,
  'monitoring status counts the one active authoritative source'
);
select extensions.ok(
  (select monitoring_enabled is not null from phase13_monitoring_status),
  'monitoring status always returns a concrete enabled state'
);

set local role authenticated;
select extensions.throws_ok(
  $$select * from private.recall_automation_control$$,
  '42501',
  null,
  'authenticated users still cannot read private automation controls'
);
select extensions.throws_ok(
  $$select * from private.recall_automation_runs$$,
  '42501',
  null,
  'authenticated users still cannot read private automation run history'
);
select extensions.throws_ok(
  $$select expo_push_token from private.push_devices$$,
  '42501',
  null,
  'authenticated users still cannot read raw push tokens'
);
reset role;

insert into public.recall_matches (
  id, owned_product_id, recall_notice_id, status, confidence, match_method,
  reasoning_summary, schema_version, evidence_fingerprint
)
values (
  '13000000-0000-4000-8000-000000000021',
  '13000000-0000-4000-8000-000000000011',
  (
    select id from public.recall_notices
    where external_id = 'phase-13-cpsc-test'
  ),
  'confirmed', 1, 'deterministic_v1', 'Controlled Phase 13 match.', '1.0.0', repeat('a', 64)
);

set local role authenticated;
set local request.jwt.claim.sub = '13000000-0000-4000-8000-000000000002';
select extensions.is(
  (
    select count(*)
    from public.owned_products
    where id = '13000000-0000-4000-8000-000000000011'
  ),
  0::bigint,
  'Phase 10 owned-product cross-user isolation remains intact'
);
select extensions.is(
  (
    select count(*)
    from public.recall_matches
    where id = '13000000-0000-4000-8000-000000000021'
  ),
  0::bigint,
  'Phase 10 recall-match cross-user isolation remains intact'
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
  'Phase 11 authenticated push registration remains intact'
);
select extensions.ok(
  not pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE'),
  'Phase 11 private-schema isolation remains intact'
);

select extensions.is(
  (select max_recalls_per_run from private.recall_automation_control where singleton),
  100,
  'Phase 12 recall limit remains 100 per run'
);
select extensions.is(
  (select max_candidate_pairs_per_run from private.recall_automation_control where singleton),
  500,
  'Phase 12 candidate-pair limit remains 500 per run'
);
select extensions.is(
  (select max_ai_escalations_per_run from private.recall_automation_control where singleton),
  5,
  'Phase 12 AI escalation limit remains five per run'
);
select extensions.is(
  (select max_notification_batch_size from private.recall_automation_control where singleton),
  25,
  'Phase 12 push delivery limit remains 25 per batch'
);
select extensions.is(
  (
    select count(*)
    from cron.job
    where jobname = 'recall-automation-every-6h'
  ),
  1::bigint,
  'Phase 12 still has exactly one production Cron job'
);
select extensions.is(
  (
    select schedule
    from cron.job
    where jobname = 'recall-automation-every-6h'
  ),
  '17 */6 * * *',
  'Phase 12 Cron schedule remains unchanged'
);

select * from extensions.finish();

rollback;
