begin;

set local role postgres;
set local search_path = extensions, public, auth, private, cron, vault;

create extension if not exists pgtap with schema extensions;

select extensions.plan(52);

select extensions.has_column(
  'public', 'owned_products', 'scan_date', 'owned products have a scan date'
);
select extensions.col_type_is(
  'public', 'owned_products', 'scan_date', 'date', 'scan date is a PostgreSQL date'
);
select extensions.col_not_null(
  'public', 'owned_products', 'scan_date', 'scan date is required after legacy backfill'
);
select extensions.ok(
  (
    select column_default = 'CURRENT_DATE'
    from information_schema.columns
    where table_schema = 'public' and table_name = 'owned_products' and column_name = 'scan_date'
  ),
  'scan date has a safe database fallback default'
);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '14000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'phase14-a@example.invalid', '', '2099-01-01 00:00:00+00', '{}'::jsonb, '{}'::jsonb,
    '2099-01-01 00:00:00+00', '2099-01-01 00:00:00+00'
  ),
  (
    '14000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'phase14-b@example.invalid', '', '2099-01-01 00:00:00+00', '{}'::jsonb, '{}'::jsonb,
    '2099-01-01 00:00:00+00', '2099-01-01 00:00:00+00'
  );

insert into public.owned_products (
  id, user_id, product_name, scan_date, identification_method, created_at, updated_at
)
values (
  '14000000-0000-4000-8000-000000000011',
  '14000000-0000-4000-8000-000000000001',
  'Phase 14 product',
  '2099-01-17',
  'manual',
  '2099-01-17 23:30:00+00',
  '2099-01-17 23:30:00+00'
);

select extensions.is(
  (select scan_date from public.owned_products where id = '14000000-0000-4000-8000-000000000011'),
  '2099-01-17'::date,
  'a canonical date-only scan date is stored without timezone conversion'
);

update public.owned_products
set scan_date = '2099-01-16'
where id = '14000000-0000-4000-8000-000000000011';
select extensions.is(
  (
    select created_at
    from public.owned_products
    where id = '14000000-0000-4000-8000-000000000011'
  ),
  '2099-01-17 23:30:00+00'::timestamptz,
  'editing scan date leaves created_at unchanged'
);
select extensions.throws_ok(
  $$
    update public.owned_products
    set created_at = '2099-01-18 00:00:00+00'
    where id = '14000000-0000-4000-8000-000000000011'
  $$,
  'P0001',
  'owned product created_at is immutable',
  'created_at cannot be edited'
);
select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public' and relation.relname = 'owned_products'
  ),
  'owned product RLS remains enabled'
);

set local role authenticated;
set local request.jwt.claim.sub = '14000000-0000-4000-8000-000000000001';
select extensions.is(
  (
    select count(*)
    from public.owned_products
    where id = '14000000-0000-4000-8000-000000000011'
  ),
  1::bigint,
  'the owner can still read the product'
);
update public.owned_products
set scan_date = '2099-01-15'
where id = '14000000-0000-4000-8000-000000000011';
select extensions.is(
  (
    select scan_date
    from public.owned_products
    where id = '14000000-0000-4000-8000-000000000011'
  ),
  '2099-01-15'::date,
  'the owner can edit scan date'
);
reset role;
set local role postgres;

set local role authenticated;
set local request.jwt.claim.sub = '14000000-0000-4000-8000-000000000002';
select extensions.is(
  (
    select count(*)
    from public.owned_products
    where id = '14000000-0000-4000-8000-000000000011'
  ),
  0::bigint,
  'another user cannot read the product after scan date changes'
);
reset role;
set local role postgres;

select extensions.is(
  (select scan_date from public.owned_products where id = '14000000-0000-4000-8000-000000000011'),
  '2099-01-15'::date,
  'the owner edit is persisted exactly'
);

select extensions.has_column(
  'public', 'recall_sources', 'source_key', 'recall sources have stable adapter keys'
);
select extensions.has_column(
  'public', 'recall_sources', 'is_active', 'recall sources have explicit activation state'
);
select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_constraint as constraint_info
    join pg_catalog.pg_class as relation on relation.oid = constraint_info.conrelid
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'recall_sources'
      and constraint_info.conname = 'recall_sources_source_key_key'
      and constraint_info.contype = 'u'
  ),
  'source keys are unique'
);
select extensions.ok(
  (select is_active from public.recall_sources where source_key = 'cpsc'),
  'CPSC remains active'
);
select extensions.is(
  (select source_key from public.recall_sources where source_key = 'health_canada'),
  'health_canada',
  'Health Canada has a stable source key independent of activation state'
);
select extensions.ok(
  (select is_authoritative from public.recall_sources where source_key = 'health_canada'),
  'Health Canada is recorded as an official authority'
);
select extensions.is(
  (select source_language_code from public.recall_sources where source_key = 'health_canada'),
  'en',
  'the selected Health Canada feed is English'
);
select extensions.is(
  (select jurisdiction from public.recall_sources where source_key = 'health_canada'),
  'CA',
  'Health Canada is scoped to Canada'
);

select extensions.has_table(
  'private', 'recall_source_sync_state', 'per-source sync state exists'
);
select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private' and relation.relname = 'recall_source_sync_state'
  ),
  'per-source sync state has RLS enabled'
);
select extensions.ok(
  not pg_catalog.has_table_privilege(
    'authenticated', 'private.recall_source_sync_state', 'SELECT'
  ),
  'authenticated users cannot read private source watermarks'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'service_role', 'public.get_recall_source_sync_state(text)', 'EXECUTE'
  ),
  'service role can read one source sync state through the bounded RPC'
);

select public.record_recall_source_sync_result(
  'cpsc',
  'success',
  '{"kind":"last_publish_date","value":"2099-01-17"}'::jsonb,
  null,
  '{"fetched":1}'::jsonb,
  '2099-01-17 12:00:00+00'
);
select extensions.is(
  (
    select watermark ->> 'value'
    from private.recall_source_sync_state as sync_state
    join public.recall_sources as source on source.id = sync_state.source_id
    where source.source_key = 'cpsc'
  ),
  '2099-01-17',
  'a successful source sync advances only its watermark'
);
select public.record_recall_source_sync_result(
  'cpsc',
  'failed',
  '{"kind":"last_publish_date","value":"2099-01-18"}'::jsonb,
  'controlled_failure',
  '{"fetched":0}'::jsonb,
  '2099-01-18 12:00:00+00'
);
select extensions.is(
  (
    select watermark ->> 'value'
    from private.recall_source_sync_state as sync_state
    join public.recall_sources as source on source.id = sync_state.source_id
    where source.source_key = 'cpsc'
  ),
  '2099-01-17',
  'a failed source sync cannot advance its watermark'
);
select extensions.is(
  (
    select last_status
    from private.recall_source_sync_state as sync_state
    join public.recall_sources as source on source.id = sync_state.source_id
    where source.source_key = 'cpsc'
  ),
  'failed',
  'source failure state is represented accurately'
);

select extensions.is(
  public.ingest_authoritative_recall(
    'cpsc',
    'phase-14-generic-cpsc',
    'Phase 14 generic CPSC recall',
    'Controlled fixture.',
    'Controlled hazard.',
    'Controlled remedy.',
    '2099-01-17',
    'https://www.cpsc.gov/Recalls/2099/phase-14-generic-cpsc',
    '2099-01-17 12:00:00+00',
    '{"RecallID":"phase-14-generic-cpsc"}'::jsonb,
    '[{"productName":"Phase 14 product","gtin":null,"modelNumber":null}]'::jsonb,
    '[{"type":"country","code":"US"}]'::jsonb
  ),
  'inserted',
  'generic ingestion inserts an active CPSC notice'
);
select extensions.is(
  (
    select count(*)
    from public.recall_notice_jurisdictions as jurisdiction
    join public.recall_notices as notice on notice.id = jurisdiction.recall_notice_id
    where notice.external_id = 'phase-14-generic-cpsc'
      and jurisdiction.jurisdiction_type = 'country'
      and jurisdiction.jurisdiction_code = 'US'
  ),
  1::bigint,
  'generic ingestion preserves normalized notice jurisdiction'
);
select extensions.is(
  public.ingest_authoritative_recall(
    'cpsc',
    'phase-14-generic-cpsc',
    'Phase 14 generic CPSC recall',
    'Controlled fixture.',
    'Controlled hazard.',
    'Controlled remedy.',
    '2099-01-17',
    'https://www.cpsc.gov/Recalls/2099/phase-14-generic-cpsc',
    '2099-01-18 12:00:00+00',
    '{"RecallID":"phase-14-generic-cpsc"}'::jsonb,
    '[{"productName":"Phase 14 product","gtin":null,"modelNumber":null}]'::jsonb,
    '[{"type":"country","code":"US"}]'::jsonb
  ),
  'unchanged',
  'generic source ingestion is idempotent'
);

create function pg_temp.insert_phase14_cpsc_url(p_external_id text, p_url text)
returns void
language sql
set search_path = ''
as $$
  insert into public.recall_notices (
    source_id,
    external_id,
    title,
    recall_date,
    official_url,
    retrieved_at,
    raw_payload
  )
  select
    source.id,
    p_external_id,
    'Phase 14 CPSC authority validation',
    '2099-01-17',
    p_url,
    '2099-01-17 12:00:00+00',
    jsonb_build_object('fixture', p_external_id)
  from public.recall_sources as source
  where source.source_key = 'cpsc';
$$;

select extensions.lives_ok(
  $$select pg_temp.insert_phase14_cpsc_url('phase-14-cpsc-authority-bare', 'https://cpsc.gov/Recalls/example')$$,
  'CPSC notice validation accepts the exact bare HTTPS authority'
);
select extensions.lives_ok(
  $$select pg_temp.insert_phase14_cpsc_url('phase-14-cpsc-authority-www', 'https://www.cpsc.gov/Recalls/example')$$,
  'CPSC notice validation accepts the exact www HTTPS authority'
);
select extensions.throws_ok(
  $$select pg_temp.insert_phase14_cpsc_url('phase-14-cpsc-authority-http', 'http://cpsc.gov/Recalls/example')$$,
  'P0001',
  'recall notice official_url must use an allowed HTTPS CPSC host',
  'CPSC notice validation rejects HTTP'
);
select extensions.throws_ok(
  $$select pg_temp.insert_phase14_cpsc_url('phase-14-cpsc-authority-lookalike', 'https://evilcpsc.gov/Recalls/example')$$,
  'P0001',
  'recall notice official_url must use an allowed HTTPS CPSC host',
  'CPSC notice validation rejects a suffix lookalike'
);
select extensions.throws_ok(
  $$select pg_temp.insert_phase14_cpsc_url('phase-14-cpsc-authority-suffix', 'https://cpsc.gov.evil.example/Recalls/example')$$,
  'P0001',
  'recall notice official_url must use an allowed HTTPS CPSC host',
  'CPSC notice validation rejects a hostname suffix attack'
);
select extensions.throws_ok(
  $$select pg_temp.insert_phase14_cpsc_url('phase-14-cpsc-authority-subdomain', 'https://foo.cpsc.gov/Recalls/example')$$,
  'P0001',
  'recall notice official_url must use an allowed HTTPS CPSC host',
  'CPSC notice validation rejects unapproved subdomains'
);
select extensions.throws_ok(
  $$select pg_temp.insert_phase14_cpsc_url('phase-14-cpsc-authority-unrelated', 'https://example.com/Recalls/example')$$,
  'P0001',
  'recall notice official_url must use an allowed HTTPS CPSC host',
  'CPSC notice validation rejects unrelated hosts'
);
select extensions.throws_ok(
  $$select pg_temp.insert_phase14_cpsc_url('phase-14-cpsc-authority-userinfo', 'https://cpsc.gov@evil.example/Recalls/example')$$,
  'P0001',
  'recall notice official_url must use an allowed HTTPS CPSC host',
  'CPSC notice validation rejects a userinfo authority attack'
);
select extensions.throws_ok(
  $$select pg_temp.insert_phase14_cpsc_url('phase-14-cpsc-authority-credentials', 'https://user:pass@cpsc.gov/Recalls/example')$$,
  'P0001',
  'recall notice official_url must use an allowed HTTPS CPSC host',
  'CPSC notice validation rejects credentials in the authority'
);
select extensions.throws_ok(
  $$select pg_temp.insert_phase14_cpsc_url('phase-14-cpsc-authority-port-443', 'https://cpsc.gov:443/Recalls/example')$$,
  'P0001',
  'recall notice official_url must use an allowed HTTPS CPSC host',
  'CPSC notice validation rejects an explicit default port'
);
select extensions.throws_ok(
  $$select pg_temp.insert_phase14_cpsc_url('phase-14-cpsc-authority-port-8443', 'https://cpsc.gov:8443/Recalls/example')$$,
  'P0001',
  'recall notice official_url must use an allowed HTTPS CPSC host',
  'CPSC notice validation rejects an alternate port'
);

update public.recall_sources
set is_active = false
where source_key = 'health_canada';
select extensions.is(
  (
    select count(*)
    from public.get_active_recall_source_keys()
    where source_key = 'health_canada'
  ),
  0::bigint,
  'inactive authorities are excluded from active-source enumeration'
);
select extensions.throws_ok(
  $$
    select public.ingest_authoritative_recall(
      'health_canada', 'phase-14-inactive', 'Inactive source test', 'Controlled fixture.',
      'Controlled hazard.', 'Controlled remedy.', '2099-01-17',
      'https://recalls-rappels.canada.ca/en/alert-recall/phase-14-inactive',
      '2099-01-17 12:00:00+00', '{"NID":"phase-14-inactive"}'::jsonb,
      '[{"productName":"Inactive product"}]'::jsonb,
      '[{"type":"country","code":"CA"}]'::jsonb
    )
  $$,
  'P0001',
  'recall source is not active',
  'inactive authorities cannot ingest production notices'
);

update public.recall_sources
set is_active = true
where source_key = 'health_canada';
select extensions.is(
  (
    select count(*)
    from public.get_active_recall_source_keys()
    where source_key = 'health_canada'
  ),
  1::bigint,
  'active authorities are included in active-source enumeration'
);
select extensions.is(
  public.ingest_authoritative_recall(
    'health_canada', 'phase-14-active', 'Active source test', 'Controlled fixture.',
    'Controlled hazard.', 'Controlled remedy.', '2099-01-17',
    'https://recalls-rappels.canada.ca/en/alert-recall/phase-14-active',
    '2099-01-17 12:00:00+00', '{"NID":"phase-14-active"}'::jsonb,
    '[{"productName":"Active product"}]'::jsonb,
    '[{"type":"country","code":"CA"}]'::jsonb
  ),
  'inserted',
  'active authorities can ingest production notices'
);
select extensions.is(
  (select active_source_count from public.get_monitoring_status()),
  (
    select count(*)::integer
    from public.recall_sources
    where is_authoritative and is_active
  ),
  'monitoring reports the current active authoritative source count'
);

select extensions.is(
  public.ingest_cpsc_recall(
    'phase-14-legacy-cpsc',
    'Phase 14 legacy CPSC compatibility',
    'Controlled fixture.',
    'Controlled hazard.',
    'Controlled remedy.',
    '2099-01-17',
    'https://www.cpsc.gov/Recalls/2099/phase-14-legacy-cpsc',
    '2099-01-17 12:00:00+00',
    '{"RecallID":"phase-14-legacy-cpsc"}'::jsonb,
    '[{"productName":"Legacy product"}]'::jsonb
  ),
  'inserted',
  'the Phase 7 CPSC RPC remains backwards compatible'
);
select extensions.is(
  public.ingest_cpsc_recall(
    'phase-14-cpsc-bare-host',
    'Phase 14 bare CPSC host compatibility',
    'Controlled fixture.',
    'Controlled hazard.',
    'Controlled remedy.',
    '2099-01-17',
    'https://cpsc.gov/Recalls/2099/phase-14-cpsc-bare-host',
    '2099-01-17 12:00:00+00',
    '{"RecallID":"phase-14-cpsc-bare-host"}'::jsonb,
    '[{"productName":"Bare host product"}]'::jsonb
  ),
  'inserted',
  'the CPSC compatibility RPC accepts the official bare host'
);
select extensions.is(
  (
    select official_url
    from public.recall_notices
    where external_id = 'phase-14-cpsc-bare-host'
  ),
  'https://cpsc.gov/Recalls/2099/phase-14-cpsc-bare-host',
  'the authoritative bare-host URL is preserved without rewriting'
);
select extensions.is(
  (
    select count(*)
    from public.recall_notice_jurisdictions as jurisdiction
    join public.recall_notices as notice on notice.id = jurisdiction.recall_notice_id
    where notice.external_id = 'phase-14-legacy-cpsc'
      and jurisdiction.jurisdiction_code = 'US'
  ),
  1::bigint,
  'legacy CPSC ingestion still writes United States jurisdiction'
);
select extensions.col_type_is(
  'public', 'owned_products', 'created_at', 'timestamp with time zone',
  'created_at remains a technical timestamptz'
);
select extensions.ok(
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public' and relation.relname = 'recall_matches'
  ),
  'Phase 10 recall match RLS remains enabled'
);

select * from extensions.finish();

rollback;
