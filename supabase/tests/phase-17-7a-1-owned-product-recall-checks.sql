-- Phase 17.7a-1: targeted product check (job queue, trigger, candidate retrieval,
-- claim/complete, monitoring states, isolation). Runs on the local stack only.
begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(89);

-- ===========================================================================
-- Privilege boundary.
-- ===========================================================================
select extensions.ok(c.relrowsecurity, format('%s has RLS enabled', c.relname))
from pg_class c
where c.oid in ('private.owned_product_recall_checks'::regclass,
  'private.owned_product_recall_check_events'::regclass)
order by c.relname;

select extensions.ok(
  not exists (
    select 1
    from unnest(array['anon', 'authenticated', 'service_role']) as r(role_name)
    cross join unnest(array['private.owned_product_recall_checks',
      'private.owned_product_recall_check_events']) as t(table_name)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(privilege)
    where pg_catalog.has_table_privilege(r.role_name, t.table_name, p.privilege)
  ),
  'no API role (not even service_role) has a direct privilege on the product check tables'
);

select extensions.ok(
  not exists (
    select 1
    from unnest(array['anon', 'authenticated']) as r(role_name)
    cross join unnest(array[
      'public.get_owned_product_recall_candidates(uuid,integer,uuid,integer)',
      'public.claim_owned_product_recall_check(uuid,uuid,integer)',
      'public.claim_due_owned_product_recall_checks(integer,integer)',
      'public.complete_owned_product_recall_check(uuid,uuid,bigint,text,text,integer,uuid,text)'
    ]) as f(signature)
    where pg_catalog.has_function_privilege(r.role_name, f.signature, 'EXECUTE')
  ),
  'anon and authenticated cannot execute any service product-check RPC'
);
select extensions.ok(
  pg_catalog.has_function_privilege('service_role',
    'public.claim_owned_product_recall_check(uuid,uuid,integer)', 'EXECUTE')
  and pg_catalog.has_function_privilege('service_role',
    'public.complete_owned_product_recall_check(uuid,uuid,bigint,text,text,integer,uuid,text)', 'EXECUTE')
  and pg_catalog.has_function_privilege('service_role',
    'public.claim_due_owned_product_recall_checks(integer,integer)', 'EXECUTE')
  and pg_catalog.has_function_privilege('service_role',
    'public.get_owned_product_recall_candidates(uuid,integer,uuid,integer)', 'EXECUTE'),
  'service_role can execute the service product-check RPCs'
);
select extensions.ok(
  pg_catalog.has_function_privilege('authenticated',
    'public.get_my_product_monitoring_states(uuid[])', 'EXECUTE')
  and not pg_catalog.has_function_privilege('anon',
    'public.get_my_product_monitoring_states(uuid[])', 'EXECUTE'),
  'only authenticated users can read their monitoring states'
);
select extensions.ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname in ('arm_owned_product_recall_check', 'owned_product_monitoring_state',
        'claim_owned_product_recall_check_row', 'owned_product_check_backoff')
      and (pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'))
  ),
  'private helpers are not executable by API roles'
);
select extensions.is(
  (select row(product_check_enabled, max_product_check_candidates)::text
    from private.recall_automation_control where singleton),
  row(false, 25)::text,
  'product checks are disabled by default with a bounded candidate budget'
);
select extensions.is(
  (select count(*)::integer from cron.job where command ilike '%owned%product%'),
  0,
  'no Cron job is created for product checks'
);

-- ===========================================================================
-- Fixtures. Notices exist BEFORE the products (old recalls must be found).
-- ===========================================================================
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('17a10000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated',
    'p17-a@example.invalid', '', now(), '{}', '{}', now(), now()),
  ('17a10000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated',
    'p17-b@example.invalid', '', now(), '{}', '{}', now(), now());

insert into public.recall_sources (id, source_key, name, jurisdiction, base_url, is_authoritative)
values
  ('17a1aaaa-0000-4000-8000-000000000001', 'p17_us', 'P17 US authority', 'US',
    'https://us.example.gov', true),
  ('17a1aaaa-0000-4000-8000-000000000002', 'p17_ca', 'P17 CA authority', 'CA',
    'https://ca.example.gc.ca', true),
  ('17a1aaaa-0000-4000-8000-000000000003', 'p17_unofficial', 'P17 unofficial feed', 'US',
    'https://feed.example.com', false);

insert into public.recall_notices (id, source_id, external_id, title, recall_date,
  official_url, retrieved_at, raw_payload)
select ('17a1bbbb-0000-4000-8000-0000000000' || n.suffix)::uuid, n.source_id::uuid,
  'p17-' || n.suffix, n.title, date '2020-08-12',
  source.base_url || '/recalls/' || n.suffix, now(), '{}'::jsonb
from (values
  ('01', '17a1aaaa-0000-4000-8000-000000000001', 'Widget recall alpha'),
  ('02', '17a1aaaa-0000-4000-8000-000000000001', 'Gizmo recall'),
  ('03', '17a1aaaa-0000-4000-8000-000000000001', 'Zeta recall'),
  ('04', '17a1aaaa-0000-4000-8000-000000000001', 'Serial range recall'),
  ('05', '17a1aaaa-0000-4000-8000-000000000001', 'Brand recall'),
  ('06', '17a1aaaa-0000-4000-8000-000000000001', 'Deluxe recall'),
  ('07', '17a1aaaa-0000-4000-8000-000000000001', 'Recall of Lantern devices'),
  ('08', '17a1aaaa-0000-4000-8000-000000000001', 'Unrelated item'),
  ('09', '17a1aaaa-0000-4000-8000-000000000003', 'Unofficial widget'),
  ('10', '17a1aaaa-0000-4000-8000-000000000002', 'Canadian widget')
) as n(suffix, source_id, title)
join public.recall_sources as source on source.id = n.source_id::uuid;

insert into public.recall_scopes (recall_notice_id, gtin, model_number, lot_from, lot_to,
  serial_from, serial_to, brand, product_name)
values
  ('17a1bbbb-0000-4000-8000-000000000001', '091021037090', null, null, null, null, null, null, null),
  ('17a1bbbb-0000-4000-8000-000000000002', null, 'WX-100', null, null, null, null, null, null),
  ('17a1bbbb-0000-4000-8000-000000000003', null, null, '1000', '1999', null, null, null, 'Zeta thing'),
  ('17a1bbbb-0000-4000-8000-000000000004', null, null, null, null, 'A1', 'A9', null, null),
  ('17a1bbbb-0000-4000-8000-000000000005', null, null, null, null, null, null, 'Acme Corp', null),
  ('17a1bbbb-0000-4000-8000-000000000006', null, null, null, null, null, null, null, 'Stroller deluxe'),
  ('17a1bbbb-0000-4000-8000-000000000007', null, null, null, null, null, null, null, 'xq'),
  ('17a1bbbb-0000-4000-8000-000000000008', '012345678905', null, null, null, null, null, null, null),
  ('17a1bbbb-0000-4000-8000-000000000009', '091021037090', null, null, null, null, null, null, null),
  ('17a1bbbb-0000-4000-8000-000000000010', '091021037090', null, null, null, null, null, null, null);

insert into public.recall_notice_jurisdictions (recall_notice_id, jurisdiction_type, jurisdiction_code)
values
  ('17a1bbbb-0000-4000-8000-000000000001', 'country', 'US'),
  ('17a1bbbb-0000-4000-8000-000000000010', 'country', 'CA');

-- Products: p01..p04 belong to A, p05 to B (same GTIN as p01), p06 to A (same GTIN too).
insert into public.owned_products (id, user_id, product_name, brand, gtin, model_number,
  serial_number, lot_number, purchase_country_code)
values
  ('17a1cccc-0000-4000-8000-000000000001', '17a10000-0000-4000-8000-00000000000a',
    'Lantern stroller', 'ACME corp', '091021037090', 'wx 100', 'A5', '1500', 'US'),
  ('17a1cccc-0000-4000-8000-000000000002', '17a10000-0000-4000-8000-00000000000a',
    'plain teapot', null, null, null, null, null, null),
  ('17a1cccc-0000-4000-8000-000000000003', '17a10000-0000-4000-8000-00000000000a',
    'Zeta thing', null, null, null, null, '2500', null),
  ('17a1cccc-0000-4000-8000-000000000004', '17a10000-0000-4000-8000-00000000000a',
    null, null, null, 'WX100', null, null, 'CA'),
  ('17a1cccc-0000-4000-8000-000000000005', '17a10000-0000-4000-8000-00000000000b',
    'Second household unit', null, '091021037090', null, null, null, 'US'),
  ('17a1cccc-0000-4000-8000-000000000006', '17a10000-0000-4000-8000-00000000000a',
    'Spare unit', null, '091021037090', null, null, null, 'US');

-- ===========================================================================
-- Arming trigger.
-- ===========================================================================
select extensions.is(
  (select row(status, matching_revision, attempts, user_id)::text
    from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000001'),
  row('pending', 1::bigint, 0, '17a10000-0000-4000-8000-00000000000a'::uuid)::text,
  'INSERT arms one pending job owned by the product owner'
);
select extensions.is(
  (select count(*)::integer from private.owned_product_recall_check_events
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000001' and event = 'armed'),
  1,
  'the arming is journaled'
);
select extensions.is(
  (select count(*)::integer from private.owned_product_recall_checks
    where owned_product_id in (select id from public.owned_products)),
  6,
  'every product has exactly one job (primary key on the product)'
);

savepoint rolled_back_insert;
insert into public.owned_products (id, user_id, product_name)
values ('17a1cccc-0000-4000-8000-0000000000ff', '17a10000-0000-4000-8000-00000000000a', 'Ghost');
rollback to savepoint rolled_back_insert;
select extensions.is(
  (select count(*)::integer from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-0000000000ff'),
  0,
  'a rolled-back product insert leaves no job (same transaction)'
);

update public.owned_products
set category = 'Nursery', purchase_date = date '2020-01-01', image_path = 'x.jpg',
  identification_method = 'manual', identification_confidence = 0.5, scan_date = date '2020-01-02'
where id = '17a1cccc-0000-4000-8000-000000000002';
select extensions.is(
  (select matching_revision from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000002'),
  1::bigint,
  'cosmetic edits (category, dates, image, identification) do not re-arm'
);

update public.owned_products set gtin = gtin, product_name = product_name
where id = '17a1cccc-0000-4000-8000-000000000002';
select extensions.is(
  (select matching_revision from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000002'),
  1::bigint,
  'writing an unchanged matching value does not re-arm'
);

update public.owned_products set gtin = '012345678905'
where id = '17a1cccc-0000-4000-8000-000000000002';
update public.owned_products set purchase_country_code = 'CA'
where id = '17a1cccc-0000-4000-8000-000000000002';
update public.owned_products set safety_attributes = '{"date_code":"1805"}'
where id = '17a1cccc-0000-4000-8000-000000000002';
update public.owned_products set product_name = 'plain teapot v2'
where id = '17a1cccc-0000-4000-8000-000000000002';
select extensions.is(
  (select matching_revision from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000002'),
  5::bigint,
  'gtin, purchase country, safety attributes and product name each re-arm'
);
update public.owned_products set gtin = null, safety_attributes = '{}', purchase_country_code = null,
  product_name = 'plain teapot'
where id = '17a1cccc-0000-4000-8000-000000000002';

-- ===========================================================================
-- Candidate retrieval: official only, ranked, bounded, keyset-paged.
-- ===========================================================================
select extensions.is(
  (select string_agg(right(recall_notice_id::text, 2) || ':' || exact_rank, ',' order by exact_rank desc, recall_notice_id)
    from public.get_owned_product_recall_candidates('17a1cccc-0000-4000-8000-000000000001', null, null, 100)),
  '01:4,10:4,03:3,04:3,02:2,05:1,06:1,07:1',
  'old recalls are found, ranked GTIN > range > model > descriptive; unofficial and unrelated excluded'
);
select extensions.is(
  (select jurisdictions from public.get_owned_product_recall_candidates(
    '17a1cccc-0000-4000-8000-000000000001', null, null, 100)
    where recall_notice_id = '17a1bbbb-0000-4000-8000-000000000010'),
  '[{"code": "CA", "type": "country"}]'::jsonb,
  'structured notice jurisdictions are returned with each candidate'
);
select extensions.is(
  (select count(*)::integer from public.get_owned_product_recall_candidates(
    '17a1cccc-0000-4000-8000-000000000001', null, null, 3)),
  3,
  'the page limit is honored'
);
select extensions.is(
  (select string_agg(right(recall_notice_id::text, 2), ',' order by exact_rank desc, recall_notice_id)
    from public.get_owned_product_recall_candidates(
      '17a1cccc-0000-4000-8000-000000000001', 3, '17a1bbbb-0000-4000-8000-000000000003', 3)),
  '04,02,05',
  'the keyset cursor resumes strictly after (rank, notice) without overlap'
);
select extensions.is(
  (select count(*)::integer from public.get_owned_product_recall_candidates(
    '17a1cccc-0000-4000-8000-000000000001', null, null, 100000)),
  8,
  'an oversized limit is clamped (at most 100)'
);
select extensions.is(
  (select count(*)::integer from public.get_owned_product_recall_candidates(
    '17a1cccc-0000-4000-8000-000000000002', null, null, 100)),
  0,
  'a product without any signal has no candidate'
);
select extensions.is(
  (select count(*)::integer from public.get_owned_product_recall_candidates(
    '17a1cccc-0000-4000-8000-0000000000ee', null, null, 100)),
  0,
  'an unknown product has no candidate'
);

-- Parity with public.get_recall_candidates over every product x authoritative notice.
create temporary table p17_recall_side as
select candidate.owned_product_id, notice.id as recall_notice_id, candidate.exact_rank
from public.recall_notices notice
join public.recall_sources source on source.id = notice.source_id and source.is_authoritative
cross join lateral public.get_recall_candidates(notice.id, null, null, 250) candidate;
create temporary table p17_product_side as
select product.id as owned_product_id, candidate.recall_notice_id, candidate.exact_rank
from public.owned_products product
cross join lateral public.get_owned_product_recall_candidates(product.id, null, null, 100) candidate;
select extensions.ok(
  (select count(*) from p17_recall_side) > 10,
  'the parity fixture exercises many candidate pairs'
);
select extensions.is(
  (select count(*)::integer from (
    (select * from p17_recall_side except select * from p17_product_side)
    union all
    (select * from p17_product_side except select * from p17_recall_side)
  ) as difference),
  0,
  'product->recalls retrieval equals recall->products retrieval, ranks included (parity)'
);

-- ===========================================================================
-- Claim, ownership, lease, retry, idempotence.
-- ===========================================================================
create function pg_temp.claim(p_product uuid, p_user uuid)
returns table (status text, lease_token uuid, matching_revision bigint, state text,
  cursor_rank integer, cursor_recall_id uuid, product_updated_at timestamptz)
language sql as $$
  select c.status, c.lease_token, c.matching_revision, c.state, c.cursor_rank,
    c.cursor_recall_id, c.product_updated_at
  from public.claim_owned_product_recall_check(p_product, p_user, 120) c;
$$;
create function pg_temp.complete(p_product uuid, p_lease uuid, p_revision bigint,
  p_outcome text, p_error text default null, p_rank integer default null, p_recall uuid default null)
returns text language sql as $$
  select c.status from public.complete_owned_product_recall_check(
    p_product, p_lease, p_revision, p_outcome, p_error, p_rank, p_recall, 'user') c;
$$;

select extensions.is(
  (select status from pg_temp.claim('17a1cccc-0000-4000-8000-000000000001',
    '17a10000-0000-4000-8000-00000000000a')),
  'disabled',
  'nothing is claimed while product checks are disabled'
);
select extensions.is(
  (select count(*)::integer from public.claim_due_owned_product_recall_checks(5, 120)),
  0,
  'the worker claims nothing while product checks are disabled'
);

-- Only p01 is due; every other job is scheduled later so worker batches stay predictable.
update private.owned_product_recall_checks set available_at = now() + interval '1 hour'
where owned_product_id <> '17a1cccc-0000-4000-8000-000000000001';
update private.recall_automation_control set product_check_enabled = true where singleton;

select extensions.is(
  (select status from pg_temp.claim('17a1cccc-0000-4000-8000-000000000001',
    '17a10000-0000-4000-8000-00000000000b')),
  'not_found',
  'another user cannot claim the product (not_found, no existence leak)'
);
select extensions.is(
  (select status from pg_temp.claim('17a1cccc-0000-4000-8000-0000000000ee',
    '17a10000-0000-4000-8000-00000000000a')),
  'not_found',
  'a missing product is indistinguishable from a foreign one'
);
select extensions.throws_ok(
  $$ select * from public.claim_owned_product_recall_check(
    '17a1cccc-0000-4000-8000-000000000001', null, 120) $$,
  'product and user are required',
  'the user path cannot run without a verified user id'
);

create temporary table p17_claim as
select * from pg_temp.claim('17a1cccc-0000-4000-8000-000000000001',
  '17a10000-0000-4000-8000-00000000000a');
select extensions.is(
  (select row(status, matching_revision, state,
      product_updated_at = (select updated_at from public.owned_products
        where id = '17a1cccc-0000-4000-8000-000000000001'))::text from p17_claim),
  row('claimed', 1::bigint, 'checking', true)::text,
  'the owner claims the pending job with its product revision; the state becomes checking'
);
select extensions.is(
  (select row(status, attempts, lease_token is not null)::text
    from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000001'),
  row('running', 1, true)::text,
  'the claim takes a lease and counts one attempt'
);
select extensions.is(
  (select status from pg_temp.claim('17a1cccc-0000-4000-8000-000000000001',
    '17a10000-0000-4000-8000-00000000000a')),
  'busy',
  'a concurrent claim of a leased job is refused (busy)'
);
select extensions.is(
  (select count(*)::integer from public.claim_due_owned_product_recall_checks(25, 120)
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000001'),
  0,
  'the worker never steals a live lease'
);
select extensions.is(
  pg_temp.complete('17a1cccc-0000-4000-8000-000000000001', gen_random_uuid(), 1, 'complete'),
  'stale_lease',
  'only the lease holder can record an outcome'
);
select extensions.is(
  pg_temp.complete('17a1cccc-0000-4000-8000-000000000001',
    (select lease_token from p17_claim), 1, 'retry', 'busy'),
  'retrying',
  'an unresolved check is retried'
);
select extensions.is(
  (select row(status, last_error, available_at > now(), lease_token is null)::text
    from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000001'),
  row('pending', 'busy', true, true)::text,
  'a retry releases the lease, records a bounded error and backs off'
);
select extensions.is(
  (select state from private.owned_product_monitoring_state('17a1cccc-0000-4000-8000-000000000001')),
  'check_failed_retrying',
  'the state shows a retrying check'
);
select extensions.is(
  (select status from pg_temp.claim('17a1cccc-0000-4000-8000-000000000001',
    '17a10000-0000-4000-8000-00000000000a')),
  'not_due',
  'the backoff is honored by the user path'
);

-- Lease expiry: the worker reclaims an expired lease.
update private.owned_product_recall_checks
set available_at = now() - interval '1 second'
where owned_product_id = '17a1cccc-0000-4000-8000-000000000001';
truncate p17_claim;
insert into p17_claim select * from pg_temp.claim('17a1cccc-0000-4000-8000-000000000001',
  '17a10000-0000-4000-8000-00000000000a');
update private.owned_product_recall_checks
set lease_expires_at = now() - interval '1 second'
where owned_product_id = '17a1cccc-0000-4000-8000-000000000001';
select extensions.is(
  (select state from private.owned_product_monitoring_state('17a1cccc-0000-4000-8000-000000000001')),
  'check_failed_retrying',
  'an expired lease is shown as retrying, not checking'
);
select extensions.is(
  pg_temp.complete('17a1cccc-0000-4000-8000-000000000001',
    (select lease_token from p17_claim), 1, 'complete'),
  'stale_lease',
  'an expired lease cannot complete'
);
create temporary table p17_due as
select * from public.claim_due_owned_product_recall_checks(25, 120)
where owned_product_id = '17a1cccc-0000-4000-8000-000000000001';
select extensions.is(
  (select row(count(*), max(attempts))::text from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000001'
      and lease_token = (select lease_token from p17_due)),
  row(1::bigint, 3)::text,
  'the worker reclaims the expired lease atomically and counts the attempt'
);

-- An edit during the check re-queues the product for its new revision.
update public.owned_products set lot_number = '1600'
where id = '17a1cccc-0000-4000-8000-000000000001';
select extensions.is(
  (select row(status, matching_revision)::text from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000001'),
  row('running', 2::bigint)::text,
  'a relevant edit during a check bumps the revision and keeps the live lease'
);
select extensions.is(
  pg_temp.complete('17a1cccc-0000-4000-8000-000000000001',
    (select lease_token from p17_due), 1, 'complete'),
  'rearmed',
  'a result for the old revision is not recorded; the product is re-queued'
);
select extensions.is(
  (select row(status, attempts, completed_revision)::text from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000001'),
  row('pending', 0, null::bigint)::text,
  're-queued for the new revision with a fresh attempt budget'
);

-- Continue keeps progress.
truncate p17_claim;
insert into p17_claim select * from pg_temp.claim('17a1cccc-0000-4000-8000-000000000001',
  '17a10000-0000-4000-8000-00000000000a');
select extensions.is(
  pg_temp.complete('17a1cccc-0000-4000-8000-000000000001',
    (select lease_token from p17_claim), 2, 'continue', null, 3, '17a1bbbb-0000-4000-8000-000000000003'),
  'continued',
  'a budget-limited check keeps its cursor'
);
select extensions.is(
  (select row(status, attempts, cursor_rank, cursor_recall_id)::text
    from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000001'),
  row('pending', 0, 3, '17a1bbbb-0000-4000-8000-000000000003'::uuid)::text,
  'the cursor is stored and the job is due again'
);
select extensions.throws_ok(
  $$ select pg_temp.complete('17a1cccc-0000-4000-8000-000000000001', gen_random_uuid(), 2, 'retry') $$,
  'invalid product check outcome',
  'a retry needs a bounded error'
);
select extensions.throws_ok(
  $$ select pg_temp.complete('17a1cccc-0000-4000-8000-000000000001', gen_random_uuid(), 2,
    'retry', 'something else') $$,
  'invalid product check outcome',
  'free-form errors are refused'
);

-- Completion and idempotence.
truncate p17_claim;
insert into p17_claim select * from pg_temp.claim('17a1cccc-0000-4000-8000-000000000001',
  '17a10000-0000-4000-8000-00000000000a');
select extensions.is(
  (select row(status, cursor_rank, cursor_recall_id)::text from p17_claim),
  row('claimed', 3, '17a1bbbb-0000-4000-8000-000000000003'::uuid)::text,
  'the next claim resumes from the stored cursor'
);
select extensions.is(
  pg_temp.complete('17a1cccc-0000-4000-8000-000000000001',
    (select lease_token from p17_claim), 2, 'complete'),
  'completed',
  'the lease holder completes the current revision'
);
select extensions.is(
  pg_temp.complete('17a1cccc-0000-4000-8000-000000000001',
    (select lease_token from p17_claim), 2, 'complete'),
  'stale_lease',
  'a duplicate completion is refused'
);
select extensions.is(
  (select row(status, completed_revision, checked_at is not null, cursor_rank)::text
    from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000001'),
  row('complete', 2::bigint, true, null::integer)::text,
  'the job is complete for revision 2'
);
select extensions.is(
  (select state from private.owned_product_monitoring_state('17a1cccc-0000-4000-8000-000000000001')),
  'monitored_no_known_recall',
  'a completed check without evaluation is monitored_no_known_recall'
);
select extensions.is(
  (select status from pg_temp.claim('17a1cccc-0000-4000-8000-000000000001',
    '17a10000-0000-4000-8000-00000000000a')),
  'complete',
  'a second request for an unchanged product does no work (idempotent)'
);

-- Exhaustion.
update private.owned_product_recall_checks set available_at = now() - interval '1 second'
where owned_product_id = '17a1cccc-0000-4000-8000-000000000003';
truncate p17_claim;
insert into p17_claim select * from pg_temp.claim('17a1cccc-0000-4000-8000-000000000003',
  '17a10000-0000-4000-8000-00000000000a');
update private.owned_product_recall_checks set attempts = 8
where owned_product_id = '17a1cccc-0000-4000-8000-000000000003';
select extensions.is(
  pg_temp.complete('17a1cccc-0000-4000-8000-000000000003',
    (select lease_token from p17_claim), 1, 'retry', 'failure'),
  'exhausted',
  'the 8th unresolved attempt exhausts the job'
);
select extensions.is(
  (select row(status, available_at > now() + interval '23 hours')::text
    from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000003'),
  row('failed', true)::text,
  'an exhausted job is an explicit failed state, retried at most daily'
);
select extensions.is(
  (select state from private.owned_product_monitoring_state('17a1cccc-0000-4000-8000-000000000003')),
  'check_failed',
  'the state shows check_failed'
);
update public.owned_products set lot_number = '2600'
where id = '17a1cccc-0000-4000-8000-000000000003';
select extensions.is(
  (select row(status, attempts)::text from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000003'),
  row('pending', 0)::text,
  'a relevant edit re-arms an exhausted job'
);

-- An expired lease past the attempt budget becomes failed in the worker.
update private.owned_product_recall_checks
set status = 'running', lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second',
  attempts = 8
where owned_product_id = '17a1cccc-0000-4000-8000-000000000003';
select extensions.is(
  (select count(*)::integer from public.claim_due_owned_product_recall_checks(25, 120)
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000003'),
  0,
  'an expired lease past the budget is not reclaimed'
);
select extensions.is(
  (select row(status, last_error)::text from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000003'),
  row('failed', 'timeout')::text,
  'it becomes an explicit failed state instead'
);

-- Per-user rate limit on the user path.
update private.owned_product_recall_checks set available_at = now() - interval '1 second'
where owned_product_id = '17a1cccc-0000-4000-8000-000000000005';
insert into private.owned_product_recall_check_events
  (owned_product_id, user_id, matching_revision, event, path)
select '17a1cccc-0000-4000-8000-000000000005', '17a10000-0000-4000-8000-00000000000b', 1,
  'claimed', 'user'
from generate_series(1, 60);
select extensions.is(
  (select status from pg_temp.claim('17a1cccc-0000-4000-8000-000000000005',
    '17a10000-0000-4000-8000-00000000000b')),
  'rate_limited',
  'more than 60 user checks per hour are refused'
);
select extensions.throws_ok(
  $$ update private.owned_product_recall_check_events set path = 'worker' $$,
  'owned product check events are append-only',
  'the journal cannot be rewritten'
);
select extensions.throws_ok(
  $$ select * from public.claim_due_owned_product_recall_checks(26, 120) $$,
  'invalid product check claim limit',
  'the worker batch is bounded'
);

-- ===========================================================================
-- Monitoring states from v2 evaluations and alerts (existing v2 RPCs).
-- ===========================================================================
create function pg_temp.finalize(p_product uuid, p_notice uuid, p_fingerprint text,
  p_status public.recall_match_status)
returns text language plpgsql as $$
declare
  v_lease uuid;
  v_product timestamptz;
  v_notice timestamptz;
  v_status text;
begin
  select updated_at into v_product from public.owned_products where id = p_product;
  select updated_at into v_notice from public.recall_notices where id = p_notice;
  select c.lease_token into v_lease from public.claim_recall_match_evaluation(
    p_product, p_notice, p_fingerprint, v_product, v_notice, 60) c;
  select f.status into v_status from public.finalize_recall_match_evaluation_v2(
    p_product, p_notice, p_fingerprint, v_product, v_notice, v_lease, p_status,
    case when p_status = 'confirmed' then 1 else 0 end,
    '{}'::jsonb, 'Phase 17.7a-1 test evaluation.') f;
  return v_status;
end;
$$;
create function pg_temp.complete_now(p_product uuid, p_user uuid) returns text language plpgsql as $$
declare
  v_claim record;
begin
  update private.owned_product_recall_checks set available_at = now() - interval '1 second'
  where owned_product_id = p_product;
  select * into v_claim from public.claim_owned_product_recall_check(p_product, p_user, 120);
  return (select c.status from public.complete_owned_product_recall_check(
    p_product, v_claim.lease_token, v_claim.matching_revision, 'complete', null, null, null, 'worker') c);
end;
$$;

-- p06 (A, same GTIN as p01): a gated needs_review -> possible match, no alert.
select extensions.is(
  pg_temp.finalize('17a1cccc-0000-4000-8000-000000000006', '17a1bbbb-0000-4000-8000-000000000001',
    repeat('6', 64), 'needs_review'),
  'finalized',
  'a needs_review result is persisted in the v2 evaluation table'
);
select extensions.is(
  pg_temp.complete_now('17a1cccc-0000-4000-8000-000000000006', '17a10000-0000-4000-8000-00000000000a'),
  'completed',
  'the p06 check completes'
);
select extensions.is(
  (select row(state, possible_matches, confirmed_alerts)::text
    from private.owned_product_monitoring_state('17a1cccc-0000-4000-8000-000000000006')),
  row('possible_match_needs_verification', 1, 0)::text,
  'a needs_review evaluation shows possible_match_needs_verification without alert'
);
select extensions.is(
  (select count(*)::integer from private.recall_alert_snapshots_v2
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000006'),
  0,
  'no v2 alert exists for a possible match'
);
select extensions.is(
  (select count(*)::integer from private.push_alert_queue),
  0,
  'no push is queued for a possible match'
);

-- p05 (B, same GTIN): confirmed + alert, idempotent on double execution.
select extensions.is(
  pg_temp.finalize('17a1cccc-0000-4000-8000-000000000005', '17a1bbbb-0000-4000-8000-000000000001',
    repeat('5', 64), 'confirmed'),
  'finalized',
  'a confirmed result is persisted'
);
select extensions.is(
  (select status from public.create_recall_v2_alert('17a1cccc-0000-4000-8000-000000000005',
    '17a1bbbb-0000-4000-8000-000000000001')),
  'created',
  'the existing v2 alert writer creates one alert'
);
select extensions.is(
  pg_temp.finalize('17a1cccc-0000-4000-8000-000000000005', '17a1bbbb-0000-4000-8000-000000000001',
    repeat('5', 64), 'confirmed'),
  'unchanged',
  'a second execution with the same evidence is unchanged'
);
select extensions.is(
  (select status from public.create_recall_v2_alert('17a1cccc-0000-4000-8000-000000000005',
    '17a1bbbb-0000-4000-8000-000000000001')),
  'existing',
  'a second alert request reuses the existing alert'
);
select extensions.is(
  (select count(*)::integer from private.recall_alert_snapshots_v2
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000005'),
  1,
  'double execution creates no duplicate alert'
);
select extensions.is(
  (select state from private.owned_product_monitoring_state('17a1cccc-0000-4000-8000-000000000005')),
  'recall_detected',
  'a confirmed alert shows recall_detected'
);
select extensions.is(
  (select count(*)::integer from public.recall_matches),
  0,
  'the product path writes nothing to the v1 match table'
);
select extensions.is(
  (select count(*)::integer from public.alerts),
  0,
  'the product path writes nothing to the v1 alert table'
);

-- Isolation: B's alert does not leak into A's products with the same GTIN.
select extensions.is(
  (select state from private.owned_product_monitoring_state('17a1cccc-0000-4000-8000-000000000001')),
  'monitored_no_known_recall',
  'two users with the same GTIN keep separate results'
);
select extensions.isnt(
  (select state from private.owned_product_monitoring_state('17a1cccc-0000-4000-8000-000000000006')),
  (select state from private.owned_product_monitoring_state('17a1cccc-0000-4000-8000-000000000001')),
  'two products of the same user keep separate states'
);

-- A re-armed product does not reuse a possible match from an older revision.
update private.owned_product_recall_checks set armed_at = now() + interval '1 second'
where owned_product_id = '17a1cccc-0000-4000-8000-000000000006';
select extensions.is(
  (select possible_matches from private.owned_product_monitoring_state(
    '17a1cccc-0000-4000-8000-000000000006')),
  0,
  'evaluations from before the latest arming are not counted'
);

-- Owner-only read model through PostgREST roles.
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"17a10000-0000-4000-8000-00000000000b"}';
select extensions.is(
  (select string_agg(right(owned_product_id::text, 2) || ':' || state, ',')
    from public.get_my_product_monitoring_states(null)),
  '05:recall_detected',
  'a user sees only their own products'
);
select extensions.is(
  (select count(*)::integer from public.get_my_product_monitoring_states(
    array['17a1cccc-0000-4000-8000-000000000001'::uuid])),
  0,
  'asking for another user''s product returns nothing'
);
select extensions.throws_ok(
  $$ select * from private.owned_product_recall_checks $$,
  '42501',
  null,
  'an authenticated user cannot read the job table'
);
select extensions.throws_ok(
  $$ select * from public.claim_owned_product_recall_check(
    '17a1cccc-0000-4000-8000-000000000005', '17a10000-0000-4000-8000-00000000000b', 120) $$,
  '42501',
  null,
  'an authenticated user cannot call the service claim'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"17a10000-0000-4000-8000-00000000000a"}';
select extensions.is(
  (select count(*)::integer from public.get_my_product_monitoring_states(null)),
  5,
  'the other user sees their five products'
);
select extensions.throws_ok(
  $$ select * from public.get_my_product_monitoring_states(
    array(select gen_random_uuid() from generate_series(1, 101))) $$,
  'at most 100 products per request',
  'the read model is bounded'
);
reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select extensions.throws_ok(
  $$ select * from public.get_my_product_monitoring_states(null) $$,
  '42501',
  null,
  'anon cannot read monitoring states'
);
reset role;

-- ===========================================================================
-- Deletion during a check.
-- ===========================================================================
truncate p17_claim;
update private.owned_product_recall_checks set status = 'pending', completed_revision = null,
  checked_at = null, available_at = now() - interval '1 second'
where owned_product_id = '17a1cccc-0000-4000-8000-000000000004';
insert into p17_claim select * from pg_temp.claim('17a1cccc-0000-4000-8000-000000000004',
  '17a10000-0000-4000-8000-00000000000a');
delete from public.owned_products where id = '17a1cccc-0000-4000-8000-000000000004';
select extensions.is(
  (select count(*)::integer from private.owned_product_recall_checks
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000004')
  + (select count(*)::integer from private.owned_product_recall_check_events
    where owned_product_id = '17a1cccc-0000-4000-8000-000000000004'),
  0,
  'deleting a product during its check removes its job and journal'
);
select extensions.is(
  pg_temp.complete('17a1cccc-0000-4000-8000-000000000004',
    (select lease_token from p17_claim), 1, 'complete'),
  'missing',
  'completing a deleted product reports missing, nothing is written'
);

select * from extensions.finish();
rollback;
