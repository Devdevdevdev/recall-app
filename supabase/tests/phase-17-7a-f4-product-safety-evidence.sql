-- Phase 17.7a F-4 active successor of supabase/tests/phase-16-product-safety-evidence.sql.
-- That file is a frozen Phase 16 artifact (benchmarks/recall-matching/phase-16/
-- freeze-manifest.json) and stays byte-identical; it is no longer executed because its
-- v1 fixture writes a confirmed match directly, which F-4 now refuses for every role.
-- Every Phase 16 assertion is kept here; only the v1 fixture changed: the historical
-- deterministic_v1 decision goes through the real finalizer, and F-4 withholds it.
begin;

set local role postgres;
set local search_path = extensions, public, auth;

create extension if not exists pgtap with schema extensions;

select extensions.plan(49);

select extensions.has_column(
  'public', 'owned_products', 'safety_attributes', 'owned products store safety attributes'
);
select extensions.col_type_is(
  'public', 'owned_products', 'safety_attributes', 'jsonb', 'safety attributes use JSONB'
);
select extensions.col_not_null(
  'public', 'owned_products', 'safety_attributes', 'safety attributes are never SQL null'
);
select extensions.ok(
  (
    select column_default = '''{}''::jsonb'
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'owned_products'
      and column_name = 'safety_attributes'
  ),
  'legacy products receive an empty evidence object by default'
);
select extensions.has_function(
  'public', 'validate_owned_product_safety_attributes', array['jsonb'],
  'the safety-attribute validator exists'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'public',
    'public.validate_owned_product_safety_attributes(jsonb)',
    'EXECUTE'
  ),
  'PUBLIC cannot execute the constraint validator'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.validate_owned_product_safety_attributes(jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute the constraint validator'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'service_role',
    'public.validate_owned_product_safety_attributes(jsonb)',
    'EXECUTE'
  ),
  'service_role can execute the constraint validator'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.validate_owned_product_safety_attributes(jsonb)',
    'EXECUTE'
  ),
  'anonymous users cannot execute the constraint validator'
);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '16000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'phase16-a@example.invalid', '', '2099-01-01 00:00:00+00', '{}'::jsonb, '{}'::jsonb,
    '2099-01-01 00:00:00+00', '2099-01-01 00:00:00+00'
  ),
  (
    '16000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'phase16-b@example.invalid', '', '2099-01-01 00:00:00+00', '{}'::jsonb, '{}'::jsonb,
    '2099-01-01 00:00:00+00', '2099-01-01 00:00:00+00'
  );

insert into public.owned_products (
  id, user_id, product_name, safety_attributes, created_at, updated_at
)
values
  (
    '16000000-0000-4000-8000-000000000011',
    '16000000-0000-4000-8000-000000000001',
    'Phase 16 product A',
    '{
      "variant":"Pro", "color":"Black", "size":"Large", "capacity":"2 L",
      "battery_model":"BAT-9", "charging_port_type":"USB-C",
      "screw_state":"Installed", "date_code":"26W38",
      "manufacture_date":"2026-03-15", "production_date":"2026-03-16"
    }'::jsonb,
    '2000-01-01 00:00:00+00',
    '2000-01-01 00:00:00+00'
  ),
  (
    '16000000-0000-4000-8000-000000000012',
    '16000000-0000-4000-8000-000000000002',
    'Phase 16 product B',
    '{}'::jsonb,
    '2000-01-01 00:00:00+00',
    '2000-01-01 00:00:00+00'
  );

insert into public.owned_products (
  id, user_id, product_name, created_at, updated_at
)
values (
  '16000000-0000-4000-8000-000000000013',
  '16000000-0000-4000-8000-000000000001',
  'Phase 16 legacy-compatible product',
  '2000-01-01 00:00:00+00',
  '2000-01-01 00:00:00+00'
);

select extensions.is(
  (
    select safety_attributes
    from public.owned_products
    where id = '16000000-0000-4000-8000-000000000013'
  ),
  '{}'::jsonb,
  'legacy-compatible products receive no fabricated evidence'
);
select extensions.is(
  (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_object_keys(
      (
        select safety_attributes
        from public.owned_products
        where id = '16000000-0000-4000-8000-000000000011'
      )
    )
  ),
  10::bigint,
  'all ten supported safety attributes are accepted together'
);
select extensions.is(
  (
    select safety_attributes ->> 'manufacture_date'
    from public.owned_products
    where id = '16000000-0000-4000-8000-000000000011'
  ),
  '2026-03-15',
  'a canonical date-only safety value is stored unchanged'
);

select extensions.throws_ok(
  $$
    update public.owned_products
    set safety_attributes = '{"unknown":"value"}'::jsonb
    where id = '16000000-0000-4000-8000-000000000011'
  $$,
  '23514', null, 'unknown safety keys are rejected'
);
select extensions.throws_ok(
  $$
    update public.owned_products
    set safety_attributes = '[]'::jsonb
    where id = '16000000-0000-4000-8000-000000000011'
  $$,
  '23514', null, 'non-object safety evidence is rejected'
);
select extensions.throws_ok(
  $$
    update public.owned_products
    set safety_attributes = '{"color":7}'::jsonb
    where id = '16000000-0000-4000-8000-000000000011'
  $$,
  '23514', null, 'non-string safety values are rejected'
);
select extensions.throws_ok(
  $$
    update public.owned_products
    set safety_attributes = pg_catalog.jsonb_build_object('color', pg_catalog.repeat('x', 121))
    where id = '16000000-0000-4000-8000-000000000011'
  $$,
  '23514', null, 'oversized safety values are rejected'
);
select extensions.throws_ok(
  $$
    update public.owned_products
    set safety_attributes = '{"manufacture_date":"03/15/2026"}'::jsonb
    where id = '16000000-0000-4000-8000-000000000011'
  $$,
  '23514', null, 'non-canonical date formats are rejected'
);
select extensions.throws_ok(
  $$
    update public.owned_products
    set safety_attributes = '{"production_date":"2026-02-30"}'::jsonb
    where id = '16000000-0000-4000-8000-000000000011'
  $$,
  '23514', null, 'invalid calendar dates are rejected'
);
select extensions.ok(
  public.validate_owned_product_safety_attributes(
    '{"manufacture_date":"2026-01-01"}'::jsonb
  ),
  'the first day of a year is a valid canonical manufacture date'
);
select extensions.ok(
  public.validate_owned_product_safety_attributes(
    '{"production_date":"2026-12-31"}'::jsonb
  ),
  'the last day of a year is a valid canonical production date'
);
select extensions.ok(
  public.validate_owned_product_safety_attributes(
    '{"manufacture_date":"2028-02-29"}'::jsonb
  ),
  'a valid leap day is accepted'
);
select extensions.ok(
  not public.validate_owned_product_safety_attributes(
    '{"manufacture_date":"2026-02-29"}'::jsonb
  ),
  'a non-leap-year February 29 is rejected'
);
select extensions.ok(
  not public.validate_owned_product_safety_attributes(
    '{"production_date":"2026-04-31"}'::jsonb
  ),
  'an impossible day for the month is rejected'
);
select extensions.ok(
  not public.validate_owned_product_safety_attributes(
    '{"manufacture_date":"2026-13-01"}'::jsonb
  ),
  'month thirteen is rejected'
);
select extensions.ok(
  not public.validate_owned_product_safety_attributes(
    '{"manufacture_date":"2026-00-10"}'::jsonb
  ),
  'month zero is rejected'
);
select extensions.ok(
  not public.validate_owned_product_safety_attributes(
    '{"production_date":"2026-01-00"}'::jsonb
  ),
  'day zero is rejected'
);
select extensions.ok(
  not public.validate_owned_product_safety_attributes(
    '{"manufacture_date":"26-01-01"}'::jsonb
  ),
  'a two-digit year is rejected'
);
select extensions.ok(
  not public.validate_owned_product_safety_attributes(
    '{"manufacture_date":"2026/01/01"}'::jsonb
  ),
  'slash-separated dates are rejected'
);
select extensions.ok(
  not public.validate_owned_product_safety_attributes(
    '{"manufacture_date":" 2026-01-01 "}'::jsonb
  ),
  'whitespace-padded dates are rejected'
);
select extensions.ok(
  not public.validate_owned_product_safety_attributes(
    '{"production_date":"2026-01-01T00:00:00Z"}'::jsonb
  ),
  'timestamps cannot masquerade as production dates'
);
select extensions.is(
  (
    select function_info.provolatile::text
    from pg_catalog.pg_proc as function_info
    where function_info.oid =
      'public.validate_owned_product_safety_attributes(jsonb)'::regprocedure
  ),
  'i',
  'the safety attribute validator remains IMMUTABLE'
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
select extensions.ok(
  not pg_catalog.has_table_privilege('anon', 'public.owned_products', 'SELECT')
    and not pg_catalog.has_table_privilege('anon', 'public.owned_products', 'INSERT')
    and not pg_catalog.has_table_privilege('anon', 'public.owned_products', 'UPDATE')
    and not pg_catalog.has_table_privilege('anon', 'public.owned_products', 'DELETE'),
  'anonymous users receive no owned_products table privileges'
);

insert into public.recall_sources (
  id, source_key, name, jurisdiction, base_url,
  is_authoritative, is_active, source_language_code
)
values (
  '16000000-0000-4000-8000-000000000021',
  'phase16_test',
  'Phase 16 Test Authority',
  'XX',
  'https://phase16.example.invalid',
  true,
  false,
  'en'
);
insert into public.recall_notices (
  id, source_id, external_id, title, recall_date,
  official_url, retrieved_at, raw_payload
)
values (
  '16000000-0000-4000-8000-000000000022',
  '16000000-0000-4000-8000-000000000021',
  'phase16-fixture',
  'Phase 16 fixture recall',
  '2026-09-20',
  'https://phase16.example.invalid/recalls/fixture',
  '2026-09-20 00:00:00+00',
  '{}'::jsonb
);
-- F-4: a confirmed v1 match cannot be written directly, not even by the table owner.
select extensions.throws_ok(
  $$insert into public.recall_matches (owned_product_id, recall_notice_id, status, confidence,
      match_method, matched_identifiers, reasoning_summary, schema_version)
    values ('16000000-0000-4000-8000-000000000011', '16000000-0000-4000-8000-000000000022',
      'confirmed', 1, 'deterministic_v1', '{"modelNumber":["MODEL-1"]}', 'direct', '1.0.0')$$,
  'an automatic confirmation requires a proven complete official scope',
  'the owner role has no exemption: a direct confirmed v1 write is refused'
);
set local role service_role;
select extensions.throws_ok(
  $$insert into public.recall_matches (owned_product_id, recall_notice_id, status, confidence,
      match_method, matched_identifiers, reasoning_summary, schema_version)
    values ('16000000-0000-4000-8000-000000000011', '16000000-0000-4000-8000-000000000022',
      'confirmed', 1, 'deterministic_v1', '{"modelNumber":["MODEL-1"]}', 'direct', '1.0.0')$$,
  'an automatic confirmation requires a proven complete official scope',
  'the runtime service role cannot write a confirmed v1 match directly either'
);
set local role postgres;

-- The historical deterministic_v1 decision ('confirmed') still reaches the finalizer,
-- which stores it as a withheld needs_review: no alert, no push.
create temporary table phase16_v1_finalize on commit drop as
select finalized.*
from public.owned_products as product
cross join public.recall_notices as notice
cross join lateral public.claim_recall_match_evaluation(
  product.id, notice.id, repeat('d', 64), product.updated_at, notice.updated_at, 60) as claim
cross join lateral public.finalize_recall_match_evaluation(
  product.id, notice.id, repeat('d', 64), product.updated_at, notice.updated_at,
  claim.lease_token, 'confirmed', 1, 'deterministic_v1', '{"modelNumber":["MODEL-1"]}'::jsonb,
  'Phase 16 immutable v1 fixture.', null, null, '1.0.0') as finalized
where product.id = '16000000-0000-4000-8000-000000000011'
  and notice.id = '16000000-0000-4000-8000-000000000022';
select extensions.is(
  (select row(status, stored_status, alert_outcome, safety_status <> 'eligible')::text
    from phase16_v1_finalize),
  row('finalized', 'needs_review'::public.recall_match_status, 'none', true)::text,
  'F-4 withholds the historical v1 confirmation (stored needs_review, no alert)'
);
select extensions.is(
  (select row(status, match_method, matched_identifiers,
      reasoning_summary like 'Automatic alert withheld (%Matcher: Phase 16 immutable v1 fixture.')::text
    from public.recall_matches where id = (select id from public.recall_matches where owned_product_id = '16000000-0000-4000-8000-000000000011' and recall_notice_id = '16000000-0000-4000-8000-000000000022')),
  row('needs_review'::public.recall_match_status, 'deterministic_v1',
    '{"modelNumber": ["MODEL-1"]}'::jsonb, true)::text,
  'the v1 decision stays observable as a signal: method, identifiers, and matcher reasoning kept'
);
select extensions.is(
  (select count(*) from private.push_alert_queue),
  0::bigint,
  'no unsafe alert means no push'
);
create temporary table phase16_v1_match_before on commit drop as
select pg_catalog.to_jsonb(recall_match) as value
from public.recall_matches as recall_match
where id = (select id from public.recall_matches where owned_product_id = '16000000-0000-4000-8000-000000000011' and recall_notice_id = '16000000-0000-4000-8000-000000000022');

set local role authenticated;
set local request.jwt.claim.sub = '16000000-0000-4000-8000-000000000001';
select extensions.is(
  (
    select count(*)
    from public.owned_products
    where id = '16000000-0000-4000-8000-000000000011'
  ),
  1::bigint,
  'the owner can read its richer evidence'
);
update public.owned_products
set safety_attributes = '{"color":"Red"}'::jsonb
where id = '16000000-0000-4000-8000-000000000011';
select extensions.is(
  (
    select safety_attributes ->> 'color'
    from public.owned_products
    where id = '16000000-0000-4000-8000-000000000011'
  ),
  'Red',
  'the owner can update richer safety evidence'
);
reset role;
reset request.jwt.claim.sub;
set local role postgres;
select extensions.is(
  (
    select created_at
    from public.owned_products
    where id = '16000000-0000-4000-8000-000000000011'
  ),
  '2000-01-01 00:00:00+00'::timestamptz,
  'safety evidence updates preserve created_at'
);
select extensions.ok(
  (
    select updated_at is distinct from '2000-01-01 00:00:00+00'::timestamptz
    from public.owned_products
    where id = '16000000-0000-4000-8000-000000000011'
  ),
  'safety evidence updates advance updated_at'
);

set local role authenticated;
set local request.jwt.claim.sub = '16000000-0000-4000-8000-000000000002';
select extensions.is(
  (
    select count(*)
    from public.owned_products
    where id = '16000000-0000-4000-8000-000000000011'
  ),
  0::bigint,
  'another user cannot read product evidence'
);
update public.owned_products
set safety_attributes = '{"color":"Blue"}'::jsonb
where id = '16000000-0000-4000-8000-000000000011';
reset role;
reset request.jwt.claim.sub;
set local role postgres;
select extensions.is(
  (
    select safety_attributes ->> 'color'
    from public.owned_products
    where id = '16000000-0000-4000-8000-000000000011'
  ),
  'Red',
  'another user cannot update product evidence'
);

set local role anon;
select extensions.throws_ok(
  $$
    select count(*)
    from public.owned_products
    where id = '16000000-0000-4000-8000-000000000011'
  $$,
  '42501', null,
  'anonymous users cannot read product evidence'
);
select extensions.throws_ok(
  $$
    update public.owned_products
    set safety_attributes = '{"color":"Green"}'::jsonb
    where id = '16000000-0000-4000-8000-000000000011'
  $$,
  '42501', null,
  'anonymous users cannot update product evidence'
);
reset role;
reset request.jwt.claim.sub;
set local role postgres;

select extensions.is(
  (
    select count(*)
    from public.recall_matches
    where id = (select id from public.recall_matches where owned_product_id = '16000000-0000-4000-8000-000000000011' and recall_notice_id = '16000000-0000-4000-8000-000000000022')
      and match_method = 'deterministic_v1'
      and schema_version = '1.0.0'
  ),
  1::bigint,
  'safety evidence updates do not reevaluate the deterministic_v1 match'
);
select extensions.is(
  (
    select pg_catalog.to_jsonb(recall_match)
    from public.recall_matches as recall_match
    where id = (select id from public.recall_matches where owned_product_id = '16000000-0000-4000-8000-000000000011' and recall_notice_id = '16000000-0000-4000-8000-000000000022')
  ),
  (select value from phase16_v1_match_before),
  'safety evidence updates do not mutate the existing deterministic_v1 match'
);
select extensions.is(
  (
    select count(*)
    from public.alerts
    where recall_match_id = (select id from public.recall_matches where owned_product_id = '16000000-0000-4000-8000-000000000011' and recall_notice_id = '16000000-0000-4000-8000-000000000022')
  ),
  0::bigint,
  'safety evidence updates do not create an alert'
);

select * from extensions.finish();
rollback;
