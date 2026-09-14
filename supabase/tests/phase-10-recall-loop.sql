begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(28);

select extensions.has_column(
  'public',
  'recall_matches',
  'evidence_fingerprint',
  'recall_matches stores the Phase 10 evidence fingerprint'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'service_role',
    'public.finalize_recall_match_evaluation(uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,text,jsonb,text,text,text,text)',
    'EXECUTE'
  ),
  'service_role can finalize evaluations'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.finalize_recall_match_evaluation(uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,text,jsonb,text,text,text,text)',
    'EXECUTE'
  ),
  'authenticated cannot finalize evaluations'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.claim_recall_match_evaluation(uuid,uuid,text,timestamptz,timestamptz,integer)',
    'EXECUTE'
  ),
  'anon cannot claim evaluations'
);
select extensions.ok(
  not pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE'),
  'authenticated cannot access the private schema'
);
select extensions.ok(
  not (
    pg_catalog.has_table_privilege('authenticated', 'private.recall_matching_leases', 'SELECT')
    or pg_catalog.has_table_privilege('authenticated', 'private.recall_matching_leases', 'INSERT')
    or pg_catalog.has_table_privilege('authenticated', 'private.recall_matching_leases', 'UPDATE')
    or pg_catalog.has_table_privilege('authenticated', 'private.recall_matching_leases', 'DELETE')
    or pg_catalog.has_table_privilege('authenticated', 'private.recall_matching_leases', 'TRUNCATE')
    or pg_catalog.has_table_privilege('authenticated', 'private.recall_matching_leases', 'REFERENCES')
    or pg_catalog.has_table_privilege('authenticated', 'private.recall_matching_leases', 'TRIGGER')
  ),
  'authenticated has no matching lease table privilege'
);
select extensions.ok(
  not pg_catalog.has_schema_privilege('anon', 'private', 'USAGE'),
  'anon cannot access the private schema'
);
select extensions.ok(
  not (
    pg_catalog.has_table_privilege('anon', 'private.recall_matching_leases', 'SELECT')
    or pg_catalog.has_table_privilege('anon', 'private.recall_matching_leases', 'INSERT')
    or pg_catalog.has_table_privilege('anon', 'private.recall_matching_leases', 'UPDATE')
    or pg_catalog.has_table_privilege('anon', 'private.recall_matching_leases', 'DELETE')
    or pg_catalog.has_table_privilege('anon', 'private.recall_matching_leases', 'TRUNCATE')
    or pg_catalog.has_table_privilege('anon', 'private.recall_matching_leases', 'REFERENCES')
    or pg_catalog.has_table_privilege('anon', 'private.recall_matching_leases', 'TRIGGER')
  ),
  'anon has no matching lease table privilege'
);
select extensions.ok(
  not exists (
    select 1
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
    where namespace.nspname = 'private'
      and privilege.grantee = 0
  ),
  'PUBLIC has no private schema privilege'
);
select extensions.ok(
  not exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    cross join lateral pg_catalog.aclexplode(relation.relacl) as privilege
    where namespace.nspname = 'private'
      and relation.relname = 'recall_matching_leases'
      and privilege.grantee = 0
  ),
  'PUBLIC has no matching lease table privilege'
);
select extensions.ok(
  not pg_catalog.has_schema_privilege('service_role', 'private', 'USAGE'),
  'service_role cannot directly access the private schema'
);
select extensions.ok(
  not (
    pg_catalog.has_table_privilege('service_role', 'private.recall_matching_leases', 'SELECT')
    or pg_catalog.has_table_privilege('service_role', 'private.recall_matching_leases', 'INSERT')
    or pg_catalog.has_table_privilege('service_role', 'private.recall_matching_leases', 'UPDATE')
    or pg_catalog.has_table_privilege('service_role', 'private.recall_matching_leases', 'DELETE')
    or pg_catalog.has_table_privilege('service_role', 'private.recall_matching_leases', 'TRUNCATE')
    or pg_catalog.has_table_privilege('service_role', 'private.recall_matching_leases', 'REFERENCES')
    or pg_catalog.has_table_privilege('service_role', 'private.recall_matching_leases', 'TRIGGER')
  ),
  'service_role has no direct matching lease table privilege'
);

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '10000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'phase10-user-one@example.invalid',
    '',
    pg_catalog.now(),
    '{}'::jsonb,
    '{}'::jsonb,
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'phase10-user-two@example.invalid',
    '',
    pg_catalog.now(),
    '{}'::jsonb,
    '{}'::jsonb,
    pg_catalog.now(),
    pg_catalog.now()
  );

insert into public.recall_sources (
  id,
  name,
  jurisdiction,
  base_url,
  is_authoritative
)
values (
  '30000000-0000-4000-8000-000000000003',
  'Phase 10 CPSC fixture',
  'US',
  'https://www.cpsc.gov',
  true
);

insert into public.recall_notices (
  id,
  source_id,
  external_id,
  title,
  description,
  hazard,
  remedy,
  recall_date,
  official_url,
  retrieved_at,
  raw_payload
)
values (
  '40000000-0000-4000-8000-000000000004',
  '30000000-0000-4000-8000-000000000003',
  'phase-10-test',
  'Thule Sleek strollers recalled',
  'Controlled database test record.',
  'Handlebar detachment hazard.',
  'Stop use and contact the manufacturer.',
  '2026-09-01',
  'https://www.cpsc.gov/Recalls/2026/phase-10-test',
  pg_catalog.now(),
  '{"RecallID": "phase-10-test"}'::jsonb
);

insert into public.recall_scopes (recall_notice_id, product_name, gtin)
values (
  '40000000-0000-4000-8000-000000000004',
  'Thule Sleek strollers',
  '091021037090'
);

insert into public.owned_products (
  id,
  user_id,
  brand,
  product_name,
  gtin,
  identification_method
)
values
  (
    '50000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    'Thule',
    'Sleek stroller',
    '091021037090',
    'manual'
  ),
  (
    '60000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000001',
    'Thule',
    'Sleek stroller requiring review',
    null,
    'manual'
  );

create temporary table phase10_claim as
select *
from public.claim_recall_match_evaluation(
  '50000000-0000-4000-8000-000000000005',
  '40000000-0000-4000-8000-000000000004',
  repeat('a', 64),
  (select updated_at from public.owned_products where id = '50000000-0000-4000-8000-000000000005'),
  (select updated_at from public.recall_notices where id = '40000000-0000-4000-8000-000000000004'),
  120
);

select extensions.is(
  (select status from phase10_claim),
  'claimed',
  'the first evaluator claims the pair'
);

create temporary table phase10_confirmed as
select *
from public.finalize_recall_match_evaluation(
  '50000000-0000-4000-8000-000000000005',
  '40000000-0000-4000-8000-000000000004',
  repeat('a', 64),
  (select updated_at from public.owned_products where id = '50000000-0000-4000-8000-000000000005'),
  (select updated_at from public.recall_notices where id = '40000000-0000-4000-8000-000000000004'),
  (select lease_token from phase10_claim),
  'confirmed',
  1,
  'deterministic_v1',
  '{"gtin":["091021037090"]}'::jsonb,
  'Exact valid GTIN matched the authoritative recall scope.',
  null,
  null,
  '1.0.0'
);

select extensions.is(
  (select alert_outcome from phase10_confirmed),
  'created',
  'a confirmed evaluation creates an alert atomically'
);
select extensions.is(
  (select status::text from public.recall_matches where owned_product_id = '50000000-0000-4000-8000-000000000005'),
  'confirmed',
  'the confirmed match is persisted'
);
select extensions.is(
  (select count(*) from public.alerts where recall_match_id = (select recall_match_id from phase10_confirmed)),
  1::bigint,
  'one alert exists for the confirmed match'
);

select extensions.is(
  (
    select status
    from public.claim_recall_match_evaluation(
      '50000000-0000-4000-8000-000000000005',
      '40000000-0000-4000-8000-000000000004',
      repeat('a', 64),
      (select updated_at from public.owned_products where id = '50000000-0000-4000-8000-000000000005'),
      (select updated_at from public.recall_notices where id = '40000000-0000-4000-8000-000000000004'),
      120
    )
  ),
  'unchanged',
  'an unchanged fingerprint skips reevaluation'
);

create temporary table phase10_reversal_claim as
select *
from public.claim_recall_match_evaluation(
  '50000000-0000-4000-8000-000000000005',
  '40000000-0000-4000-8000-000000000004',
  repeat('b', 64),
  (select updated_at from public.owned_products where id = '50000000-0000-4000-8000-000000000005'),
  (select updated_at from public.recall_notices where id = '40000000-0000-4000-8000-000000000004'),
  120
);

create temporary table phase10_reversal as
select *
from public.finalize_recall_match_evaluation(
  '50000000-0000-4000-8000-000000000005',
  '40000000-0000-4000-8000-000000000004',
  repeat('b', 64),
  (select updated_at from public.owned_products where id = '50000000-0000-4000-8000-000000000005'),
  (select updated_at from public.recall_notices where id = '40000000-0000-4000-8000-000000000004'),
  (select lease_token from phase10_reversal_claim),
  'needs_review',
  0,
  'deterministic_v1',
  '{}'::jsonb,
  'Evidence changed and now requires review.',
  null,
  null,
  '1.0.0'
);

select extensions.ok(
  (select confirmation_reversed from phase10_reversal),
  'confirmed to needs_review is reported as a reversal'
);
select extensions.is(
  (select status::text from public.recall_matches where owned_product_id = '50000000-0000-4000-8000-000000000005'),
  'needs_review',
  'the current match status is updated on reversal'
);
select extensions.is(
  (select count(*) from public.alerts where recall_match_id = (select recall_match_id from phase10_reversal)),
  1::bigint,
  'the historical alert is preserved on reversal'
);

create temporary table phase10_reconfirm_claim as
select *
from public.claim_recall_match_evaluation(
  '50000000-0000-4000-8000-000000000005',
  '40000000-0000-4000-8000-000000000004',
  repeat('c', 64),
  (select updated_at from public.owned_products where id = '50000000-0000-4000-8000-000000000005'),
  (select updated_at from public.recall_notices where id = '40000000-0000-4000-8000-000000000004'),
  120
);

create temporary table phase10_reconfirmed as
select *
from public.finalize_recall_match_evaluation(
  '50000000-0000-4000-8000-000000000005',
  '40000000-0000-4000-8000-000000000004',
  repeat('c', 64),
  (select updated_at from public.owned_products where id = '50000000-0000-4000-8000-000000000005'),
  (select updated_at from public.recall_notices where id = '40000000-0000-4000-8000-000000000004'),
  (select lease_token from phase10_reconfirm_claim),
  'confirmed',
  1,
  'deterministic_v1',
  '{"gtin":["091021037090"]}'::jsonb,
  'Exact valid GTIN matched again.',
  null,
  null,
  '1.0.0'
);

select extensions.is(
  (select alert_outcome from phase10_reconfirmed),
  'existing',
  'reconfirmation reuses the existing alert'
);
select extensions.is(
  (select count(*) from public.alerts where recall_match_id = (select recall_match_id from phase10_reconfirmed)),
  1::bigint,
  'reconfirmation never duplicates the alert'
);

create temporary table phase10_review_claim as
select *
from public.claim_recall_match_evaluation(
  '60000000-0000-4000-8000-000000000006',
  '40000000-0000-4000-8000-000000000004',
  repeat('d', 64),
  (select updated_at from public.owned_products where id = '60000000-0000-4000-8000-000000000006'),
  (select updated_at from public.recall_notices where id = '40000000-0000-4000-8000-000000000004'),
  120
);

select *
from public.finalize_recall_match_evaluation(
  '60000000-0000-4000-8000-000000000006',
  '40000000-0000-4000-8000-000000000004',
  repeat('d', 64),
  (select updated_at from public.owned_products where id = '60000000-0000-4000-8000-000000000006'),
  (select updated_at from public.recall_notices where id = '40000000-0000-4000-8000-000000000004'),
  (select lease_token from phase10_review_claim),
  'needs_review',
  0.5,
  'deterministic_v1',
  '{}'::jsonb,
  'This pair remains unresolved.',
  null,
  null,
  '1.0.0'
);

select extensions.is(
  (select count(*) from public.alerts where recall_match_id = (
    select id from public.recall_matches where owned_product_id = '60000000-0000-4000-8000-000000000006'
  )),
  0::bigint,
  'needs_review never creates an alert'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '20000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select extensions.is((select count(*) from public.alerts), 0::bigint, 'user B cannot read user A alerts');
select extensions.is((select count(*) from public.recall_matches), 0::bigint, 'user B cannot read user A matches');
reset role;

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
select extensions.is((select count(*) from public.alerts), 1::bigint, 'user A can read their alert');
select extensions.is((select count(*) from public.recall_matches), 2::bigint, 'user A can read their matches');
reset role;

select extensions.is(
  (
    select count(*)
    from public.get_recall_matching_batch(
      null,
      10,
      array['40000000-0000-4000-8000-000000000004'::uuid]
    )
  ),
  1::bigint,
  'a targeted authoritative recall batch returns only the requested notice'
);

select * from extensions.finish();
rollback;
