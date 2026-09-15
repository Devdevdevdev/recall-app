begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(43);

select extensions.has_table('private', 'push_devices', 'push devices are stored privately');
select extensions.has_table('private', 'push_alert_queue', 'push alert eligibility is stored privately');
select extensions.has_table('private', 'push_deliveries', 'push delivery state is stored privately');
select extensions.has_function(
  'public',
  'register_push_device',
  array['text', 'text'],
  'authenticated registration RPC exists'
);
select extensions.has_function(
  'public',
  'unregister_push_device',
  array['text'],
  'authenticated unregistration RPC exists'
);
select extensions.has_function(
  'public',
  'queue_recall_push_alerts',
  array['uuid[]'],
  'service-only targeted queue RPC exists'
);
select extensions.has_function(
  'public',
  'claim_recall_push_deliveries',
  array['integer', 'uuid[]', 'integer'],
  'service delivery claim RPC exists'
);
select extensions.has_function(
  'public',
  'record_recall_push_ticket',
  array['uuid', 'uuid', 'text', 'text', 'text'],
  'service ticket RPC exists'
);
select extensions.has_function(
  'public',
  'claim_recall_push_receipts',
  array['integer', 'integer'],
  'service receipt claim RPC exists'
);
select extensions.has_function(
  'public',
  'record_recall_push_receipt',
  array['uuid', 'uuid', 'text', 'text'],
  'service receipt RPC exists'
);

select extensions.ok(
  pg_catalog.has_function_privilege('authenticated', 'public.register_push_device(text,text)', 'EXECUTE'),
  'authenticated can register its device'
);
select extensions.ok(
  not pg_catalog.has_function_privilege('anon', 'public.register_push_device(text,text)', 'EXECUTE'),
  'anonymous users cannot register devices'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.claim_recall_push_deliveries(integer,uuid[],integer)',
    'EXECUTE'
  ),
  'authenticated users cannot claim deliveries'
);
select extensions.ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.queue_recall_push_alerts(uuid[])',
    'EXECUTE'
  ),
  'authenticated users cannot queue historical alerts'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'service_role',
    'public.claim_recall_push_deliveries(integer,uuid[],integer)',
    'EXECUTE'
  ),
  'service role can claim deliveries through the RPC'
);
select extensions.ok(
  not pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE'),
  'authenticated users cannot access the private schema'
);
select extensions.ok(
  not pg_catalog.has_schema_privilege('anon', 'private', 'USAGE'),
  'anonymous users cannot access the private schema'
);

set local role authenticated;
select extensions.throws_ok(
  'select expo_push_token from private.push_devices',
  '42501',
  null,
  'authenticated users cannot read any raw push token table'
);
select extensions.throws_ok(
  $$update private.push_devices set enabled = false$$,
  '42501',
  null,
  'authenticated users cannot modify another user push token table'
);
reset role;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '11000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'phase11-a@example.invalid', '', pg_catalog.now(), '{}'::jsonb, '{}'::jsonb,
    pg_catalog.now(), pg_catalog.now()
  ),
  (
    '22000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'phase11-b@example.invalid', '', pg_catalog.now(), '{}'::jsonb, '{}'::jsonb,
    pg_catalog.now(), pg_catalog.now()
  );

set local role authenticated;
set local request.jwt.claim.sub = '11000000-0000-4000-8000-000000000001';
select extensions.throws_ok(
  $$select * from public.register_push_device('not-a-token', 'android')$$,
  'P0001',
  'invalid Expo push token',
  'malformed push tokens are rejected'
);
select * from public.register_push_device('ExpoPushToken[shared_device_token]', 'android');
select * from public.register_push_device('ExpoPushToken[shared_device_token]', 'android');
reset role;

select extensions.is(
  (
    select push_device.user_id
    from private.push_devices as push_device
    where push_device.expo_push_token = 'ExpoPushToken[shared_device_token]'
  ),
  '11000000-0000-4000-8000-000000000001'::uuid,
  'registration derives ownership from auth uid'
);
select extensions.is(
  (
    select count(*)
    from private.push_devices as push_device
    where push_device.expo_push_token = 'ExpoPushToken[shared_device_token]'
  ),
  1::bigint,
  'duplicate registration is idempotent'
);

set local role authenticated;
set local request.jwt.claim.sub = '22000000-0000-4000-8000-000000000002';
select * from public.register_push_device('ExpoPushToken[shared_device_token]', 'android');
reset role;

select extensions.is(
  (
    select push_device.user_id
    from private.push_devices as push_device
    where push_device.expo_push_token = 'ExpoPushToken[shared_device_token]'
  ),
  '22000000-0000-4000-8000-000000000002'::uuid,
  'sign-in registration reassigns a physical token to the current account'
);

set local role authenticated;
set local request.jwt.claim.sub = '11000000-0000-4000-8000-000000000001';
create temporary table phase11_wrong_owner_unregister as
select public.unregister_push_device('ExpoPushToken[shared_device_token]') as disabled;
reset role;

select extensions.is(
  (select disabled from phase11_wrong_owner_unregister),
  false,
  'the previous account cannot unregister the reassigned token'
);

set local role authenticated;
set local request.jwt.claim.sub = '22000000-0000-4000-8000-000000000002';
create temporary table phase11_owner_unregister as
select public.unregister_push_device('ExpoPushToken[shared_device_token]') as disabled;
reset role;

select extensions.is(
  (select disabled from phase11_owner_unregister),
  true,
  'the current account can unregister its token'
);

set local role authenticated;
set local request.jwt.claim.sub = '11000000-0000-4000-8000-000000000001';
select * from public.register_push_device('ExpoPushToken[user_a_primary]', 'android');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '22000000-0000-4000-8000-000000000002';
select * from public.register_push_device('ExpoPushToken[user_b_primary]', 'android');
reset role;

insert into public.recall_sources (id, name, jurisdiction, base_url, is_authoritative)
values (
  '33000000-0000-4000-8000-000000000003',
  'Phase 11 CPSC fixture',
  'US',
  'https://www.cpsc.gov',
  true
);

insert into public.recall_notices (
  id, source_id, external_id, title, recall_date, official_url, retrieved_at, raw_payload
)
values (
  '44000000-0000-4000-8000-000000000004',
  '33000000-0000-4000-8000-000000000003',
  'phase-11-test',
  'Phase 11 controlled recall',
  '2026-09-15',
  'https://www.cpsc.gov/Recalls/2026/phase-11-test',
  pg_catalog.now(),
  '{}'::jsonb
);

insert into public.owned_products (id, user_id, product_name, identification_method)
values
  (
    '55000000-0000-4000-8000-000000000005',
    '11000000-0000-4000-8000-000000000001',
    'Current confirmed product',
    'manual'
  ),
  (
    '56000000-0000-4000-8000-000000000006',
    '11000000-0000-4000-8000-000000000001',
    'Historical confirmed product',
    'manual'
  ),
  (
    '57000000-0000-4000-8000-000000000007',
    '11000000-0000-4000-8000-000000000001',
    'Needs review product',
    'manual'
  ),
  (
    '58000000-0000-4000-8000-000000000008',
    '22000000-0000-4000-8000-000000000002',
    'User B confirmed product',
    'manual'
  );

insert into public.recall_matches (
  id, owned_product_id, recall_notice_id, status, confidence, match_method,
  reasoning_summary, schema_version
)
values
  (
    '66000000-0000-4000-8000-000000000006',
    '55000000-0000-4000-8000-000000000005',
    '44000000-0000-4000-8000-000000000004',
    'confirmed', 1, 'deterministic_v1', 'Confirmed fixture.', '1.0.0'
  ),
  (
    '67000000-0000-4000-8000-000000000007',
    '56000000-0000-4000-8000-000000000006',
    '44000000-0000-4000-8000-000000000004',
    'confirmed', 1, 'deterministic_v1', 'Historical fixture.', '1.0.0'
  ),
  (
    '68000000-0000-4000-8000-000000000008',
    '57000000-0000-4000-8000-000000000007',
    '44000000-0000-4000-8000-000000000004',
    'needs_review', 0, 'deterministic_v1', 'Needs review fixture.', '1.0.0'
  ),
  (
    '69000000-0000-4000-8000-000000000009',
    '58000000-0000-4000-8000-000000000008',
    '44000000-0000-4000-8000-000000000004',
    'confirmed', 1, 'deterministic_v1', 'User B fixture.', '1.0.0'
  );

insert into public.alerts (id, user_id, recall_match_id)
values (
  '77000000-0000-4000-8000-000000000007',
  '11000000-0000-4000-8000-000000000001',
  '67000000-0000-4000-8000-000000000007'
);
delete from private.push_alert_queue
where alert_id = '77000000-0000-4000-8000-000000000007';

select extensions.is(
  (
    select count(*)
    from public.claim_recall_push_deliveries(
      25,
      array['77000000-0000-4000-8000-000000000007'::uuid],
      60
    )
  ),
  0::bigint,
  'an unqueued historical alert is not backfilled or delivered'
);

select extensions.is(
  public.queue_recall_push_alerts(
    array['77000000-0000-4000-8000-000000000007'::uuid]
  ),
  1,
  'service-side explicit targeting can queue one confirmed historical alert'
);
delete from private.push_alert_queue
where alert_id = '77000000-0000-4000-8000-000000000007';

insert into public.alerts (id, user_id, recall_match_id)
values (
  '78000000-0000-4000-8000-000000000008',
  '11000000-0000-4000-8000-000000000001',
  '68000000-0000-4000-8000-000000000008'
);

select extensions.is(
  (
    select count(*) from private.push_alert_queue
    where alert_id = '78000000-0000-4000-8000-000000000008'
  ),
  0::bigint,
  'needs-review alerts are not eligible for push'
);

insert into public.alerts (id, user_id, recall_match_id)
values
  (
    '79000000-0000-4000-8000-000000000009',
    '11000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000006'
  ),
  (
    '7a000000-0000-4000-8000-00000000000a',
    '22000000-0000-4000-8000-000000000002',
    '69000000-0000-4000-8000-000000000009'
  );

select extensions.is(
  (
    select count(*) from private.push_alert_queue
    where alert_id = '79000000-0000-4000-8000-000000000009'
  ),
  1::bigint,
  'a newly inserted confirmed alert is eligible for push'
);

create temporary table phase11_a_claim as
select *
from public.claim_recall_push_deliveries(
  25,
  array['79000000-0000-4000-8000-000000000009'::uuid],
  60
);

select extensions.is(
  (select count(*) from phase11_a_claim),
  1::bigint,
  'one enabled device produces one claimed delivery'
);
select extensions.is(
  (select expo_push_token from phase11_a_claim),
  'ExpoPushToken[user_a_primary]',
  'targeted delivery cannot cross into another user device'
);
select extensions.is(
  (
    select count(*)
    from public.claim_recall_push_deliveries(
      25,
      array['79000000-0000-4000-8000-000000000009'::uuid],
      60
    )
  ),
  0::bigint,
  'a live claimed delivery cannot be claimed twice'
);

select public.record_recall_push_ticket(
  (select delivery_id from phase11_a_claim),
  (select lease_token from phase11_a_claim),
  'accepted',
  'phase11-ticket-a',
  null
);

select extensions.is(
  (
    select status from private.push_deliveries
    where id = (select delivery_id from phase11_a_claim)
  ),
  'accepted',
  'an Expo ticket records acceptance without claiming handset delivery'
);

select extensions.is(
  (
    select count(*)
    from public.claim_recall_push_deliveries(
      25,
      array['ffffffff-ffff-4fff-bfff-ffffffffffff'::uuid],
      60
    )
  ),
  0::bigint,
  'a nonexistent alert does not create a delivery'
);

create temporary table phase11_b_claim as
select *
from public.claim_recall_push_deliveries(
  25,
  array['7a000000-0000-4000-8000-00000000000a'::uuid],
  60
);

select public.record_recall_push_ticket(
  (select delivery_id from phase11_b_claim),
  (select lease_token from phase11_b_claim),
  'invalid_device',
  null,
  'DeviceNotRegistered'
);

select extensions.is(
  (
    select enabled from private.push_devices
    where expo_push_token = 'ExpoPushToken[user_b_primary]'
  ),
  false,
  'DeviceNotRegistered disables the token'
);

-- now() is transaction-stable, so make the rollback-only queue cutoff explicitly earlier
-- than the device registrations that follow.
update private.push_alert_queue
set queued_at = pg_catalog.now() - interval '10 minutes'
where alert_id = '79000000-0000-4000-8000-000000000009';

set local role authenticated;
set local request.jwt.claim.sub = '11000000-0000-4000-8000-000000000001';
select * from public.register_push_device('ExpoPushToken[user_a_retry]', 'android');
select * from public.register_push_device('ExpoPushToken[user_a_permanent]', 'android');
reset role;

select extensions.is(
  (
    select count(*)
    from public.claim_recall_push_deliveries(
      25,
      array['79000000-0000-4000-8000-000000000009'::uuid],
      60
    )
    where expo_push_token in (
      'ExpoPushToken[user_a_retry]',
      'ExpoPushToken[user_a_permanent]'
    )
  ),
  0::bigint,
  'devices enabled after an alert was queued cannot receive that older alert'
);

update private.push_devices
set enabled_at = (
  select push_queue.queued_at - interval '1 second'
  from private.push_alert_queue as push_queue
  where push_queue.alert_id = '79000000-0000-4000-8000-000000000009'
)
where expo_push_token in (
  'ExpoPushToken[user_a_retry]',
  'ExpoPushToken[user_a_permanent]'
);

create temporary table phase11_retry_claims as
select *
from public.claim_recall_push_deliveries(
  25,
  array['79000000-0000-4000-8000-000000000009'::uuid],
  60
);

select public.record_recall_push_ticket(
  delivery_id,
  lease_token,
  case when expo_push_token = 'ExpoPushToken[user_a_retry]' then 'transient_error' else 'permanent_error' end,
  null,
  case when expo_push_token = 'ExpoPushToken[user_a_retry]' then 'MessageRateExceeded' else 'InvalidCredentials' end
)
from phase11_retry_claims;

select extensions.is(
  (
    select status
    from private.push_deliveries as push_delivery
    join private.push_devices as push_device on push_device.id = push_delivery.push_device_id
    where push_device.expo_push_token = 'ExpoPushToken[user_a_retry]'
      and push_delivery.alert_id = '79000000-0000-4000-8000-000000000009'
  ),
  'pending',
  'a transient ticket error is retryable'
);
select extensions.is(
  (
    select status
    from private.push_deliveries as push_delivery
    join private.push_devices as push_device on push_device.id = push_delivery.push_device_id
    where push_device.expo_push_token = 'ExpoPushToken[user_a_permanent]'
      and push_delivery.alert_id = '79000000-0000-4000-8000-000000000009'
  ),
  'failed',
  'a permanent ticket error is not retryable'
);

do $$
declare
  v_delivery_id uuid;
  v_lease_token uuid;
begin
  for v_counter in 2..3 loop
    update private.push_deliveries as push_delivery
    set next_attempt_at = pg_catalog.now() - interval '1 second'
    from private.push_devices as push_device
    where push_device.id = push_delivery.push_device_id
      and push_device.expo_push_token = 'ExpoPushToken[user_a_retry]'
      and push_delivery.alert_id = '79000000-0000-4000-8000-000000000009';

    select claim.delivery_id, claim.lease_token
    into v_delivery_id, v_lease_token
    from public.claim_recall_push_deliveries(
      25,
      array['79000000-0000-4000-8000-000000000009'::uuid],
      60
    ) as claim
    where claim.expo_push_token = 'ExpoPushToken[user_a_retry]';

    perform public.record_recall_push_ticket(
      v_delivery_id,
      v_lease_token,
      'transient_error',
      null,
      'MessageRateExceeded'
    );
  end loop;
end;
$$;

select extensions.is(
  (
    select status
    from private.push_deliveries as push_delivery
    join private.push_devices as push_device on push_device.id = push_delivery.push_device_id
    where push_device.expo_push_token = 'ExpoPushToken[user_a_retry]'
      and push_delivery.alert_id = '79000000-0000-4000-8000-000000000009'
  ),
  'failed',
  'transient delivery retries stop after three attempts'
);
select extensions.is(
  (
    select count(*)
    from public.claim_recall_push_deliveries(
      25,
      array['79000000-0000-4000-8000-000000000009'::uuid],
      60
    )
    where expo_push_token in (
      'ExpoPushToken[user_a_retry]',
      'ExpoPushToken[user_a_permanent]'
    )
  ),
  0::bigint,
  'failed deliveries are not claimed indefinitely'
);

update private.push_deliveries
set
  sent_at = '2000-01-01 00:00:00+00'::timestamptz,
  receipt_available_at = '2000-01-01 00:00:00+00'::timestamptz
where id = (select delivery_id from phase11_a_claim);

create temporary table phase11_receipt_claim as
select * from public.claim_recall_push_receipts(1, 60);

select extensions.is(
  (select count(*) from phase11_receipt_claim),
  1::bigint,
  'accepted Expo tickets become eligible for bounded receipt checks'
);

select public.record_recall_push_receipt(
  (select delivery_id from phase11_receipt_claim),
  (select lease_token from phase11_receipt_claim),
  'ok',
  null
);

select extensions.is(
  (
    select status from private.push_deliveries
    where id = (select delivery_id from phase11_a_claim)
  ),
  'receipt_ok',
  'an ok receipt records provider handoff without claiming device display'
);
select extensions.is(
  (
    select count(*)
    from private.push_deliveries
    where alert_id = '79000000-0000-4000-8000-000000000009'
      and push_device_id = (
        select id from private.push_devices
        where expo_push_token = 'ExpoPushToken[user_a_primary]'
      )
  ),
  1::bigint,
  'alert and device uniqueness prevents duplicate logical delivery rows'
);

select * from extensions.finish();
rollback;
