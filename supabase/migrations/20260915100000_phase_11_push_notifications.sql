begin;

create schema if not exists private;

create table private.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  expo_push_token text not null unique,
  platform text not null,
  enabled boolean not null default true,
  enabled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_registered_at timestamptz not null default now(),
  constraint push_devices_token_format_check check (
    expo_push_token ~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,200}\]$'
  ),
  constraint push_devices_platform_check check (platform in ('android', 'ios'))
);

create index push_devices_user_id_idx on private.push_devices (user_id);
create index push_devices_enabled_user_idx on private.push_devices (user_id) where enabled;

create table private.push_alert_queue (
  alert_id uuid primary key references public.alerts (id) on delete cascade,
  queued_at timestamptz not null default now()
);

create table private.push_deliveries (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.alerts (id) on delete cascade,
  push_device_id uuid not null references private.push_devices (id) on delete cascade,
  status text not null default 'pending',
  expo_ticket_id text,
  attempt_count integer not null default 0,
  receipt_attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  receipt_available_at timestamptz,
  last_error_code text,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  receipt_checked_at timestamptz,
  constraint push_deliveries_alert_device_key unique (alert_id, push_device_id),
  constraint push_deliveries_status_check check (
    status in (
      'pending',
      'processing',
      'accepted',
      'receipt_checking',
      'receipt_ok',
      'failed',
      'invalid_device',
      'cancelled'
    )
  ),
  constraint push_deliveries_attempt_count_check check (
    attempt_count between 0 and 3 and receipt_attempt_count between 0 and 3
  ),
  constraint push_deliveries_ticket_not_blank_check check (
    expo_ticket_id is null or btrim(expo_ticket_id) <> ''
  ),
  constraint push_deliveries_error_not_blank_check check (
    last_error_code is null or btrim(last_error_code) <> ''
  )
);

create index push_deliveries_send_queue_idx
on private.push_deliveries (next_attempt_at, created_at)
where status in ('pending', 'processing');

create index push_deliveries_receipt_queue_idx
on private.push_deliveries (receipt_available_at, sent_at)
where status in ('accepted', 'receipt_checking');

alter table private.push_devices enable row level security;
alter table private.push_alert_queue enable row level security;
alter table private.push_deliveries enable row level security;

revoke all on table private.push_devices from public, anon, authenticated, service_role;
revoke all on table private.push_alert_queue from public, anon, authenticated, service_role;
revoke all on table private.push_deliveries from public, anon, authenticated, service_role;

create function private.enqueue_confirmed_recall_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.recall_matches as recall_match
    where recall_match.id = new.recall_match_id
      and recall_match.status = 'confirmed'::public.recall_match_status
  ) then
    insert into private.push_alert_queue (alert_id)
    values (new.id)
    on conflict (alert_id) do nothing;
  end if;

  return new;
end;
$$;

create trigger alerts_enqueue_confirmed_push
after insert on public.alerts
for each row execute function private.enqueue_confirmed_recall_alert();

revoke all on function private.enqueue_confirmed_recall_alert() from public, anon, authenticated, service_role;

create function public.register_push_device(
  p_expo_push_token text,
  p_platform text
)
returns table (
  push_device_id uuid,
  enabled boolean,
  platform text,
  last_registered_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_device_id uuid;
begin
  if v_user_id is null then
    raise exception 'authentication is required';
  end if;
  if p_expo_push_token is null
    or p_expo_push_token !~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,200}\]$' then
    raise exception 'invalid Expo push token';
  end if;
  if p_platform not in ('android', 'ios') then
    raise exception 'invalid push platform';
  end if;

  insert into private.push_devices (
    user_id,
    expo_push_token,
    platform
  )
  values (
    v_user_id,
    p_expo_push_token,
    p_platform
  )
  on conflict (expo_push_token) do nothing
  returning id into v_device_id;

  if v_device_id is null then
    select push_device.id
    into v_device_id
    from private.push_devices as push_device
    where push_device.expo_push_token = p_expo_push_token
    for update;

    update private.push_deliveries as push_delivery
    set
      status = 'cancelled',
      last_error_code = 'account_reassigned',
      lease_token = null,
      lease_expires_at = null,
      updated_at = pg_catalog.now()
    from public.alerts as alert
    where push_delivery.push_device_id = v_device_id
      and alert.id = push_delivery.alert_id
      and alert.user_id <> v_user_id
      and push_delivery.status in ('pending', 'processing');

    update private.push_devices as push_device
    set
      user_id = v_user_id,
      platform = p_platform,
      enabled = true,
      enabled_at = case
        when push_device.user_id <> v_user_id or not push_device.enabled
          then pg_catalog.now()
        else push_device.enabled_at
      end,
      updated_at = pg_catalog.now(),
      last_registered_at = pg_catalog.now()
    where push_device.id = v_device_id;
  end if;

  return query
  select push_device.id, push_device.enabled, push_device.platform, push_device.last_registered_at
  from private.push_devices as push_device
  where push_device.id = v_device_id;
end;
$$;

create function public.unregister_push_device(p_expo_push_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_device_id uuid;
begin
  if v_user_id is null then
    raise exception 'authentication is required';
  end if;

  update private.push_devices as push_device
  set
    enabled = false,
    updated_at = pg_catalog.now()
  where push_device.user_id = v_user_id
    and push_device.expo_push_token = p_expo_push_token
    and push_device.enabled
  returning push_device.id into v_device_id;

  if v_device_id is not null then
    update private.push_deliveries as push_delivery
    set
      status = 'cancelled',
      last_error_code = 'device_unregistered',
      lease_token = null,
      lease_expires_at = null,
      updated_at = pg_catalog.now()
    where push_delivery.push_device_id = v_device_id
      and push_delivery.status in ('pending', 'processing');
  end if;

  return v_device_id is not null;
end;
$$;

create function public.claim_recall_push_deliveries(
  p_limit integer default 25,
  p_alert_ids uuid[] default null,
  p_lease_seconds integer default 60
)
returns table (
  delivery_id uuid,
  alert_id uuid,
  push_device_id uuid,
  expo_push_token text,
  attempt_count integer,
  lease_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease_token uuid := gen_random_uuid();
  v_lease_expires_at timestamptz := pg_catalog.now() + pg_catalog.make_interval(
    secs => least(greatest(coalesce(p_lease_seconds, 60), 30), 300)
  );
begin
  insert into private.push_deliveries (alert_id, push_device_id)
  select alert.id, push_device.id
  from private.push_alert_queue as push_queue
  join public.alerts as alert on alert.id = push_queue.alert_id
  join public.recall_matches as recall_match on recall_match.id = alert.recall_match_id
  join private.push_devices as push_device
    on push_device.user_id = alert.user_id
    and push_device.enabled
    and push_device.enabled_at <= push_queue.queued_at
  where recall_match.status = 'confirmed'::public.recall_match_status
    and (p_alert_ids is null or alert.id = any (p_alert_ids))
  on conflict on constraint push_deliveries_alert_device_key do nothing;

  return query
  with candidates as (
    select push_delivery.id
    from private.push_deliveries as push_delivery
    join private.push_alert_queue as push_queue on push_queue.alert_id = push_delivery.alert_id
    join public.alerts as alert on alert.id = push_delivery.alert_id
    join public.recall_matches as recall_match on recall_match.id = alert.recall_match_id
    join private.push_devices as push_device on push_device.id = push_delivery.push_device_id
    where (
        push_delivery.status = 'pending'
        or (
          push_delivery.status = 'processing'
          and push_delivery.lease_expires_at <= pg_catalog.now()
        )
      )
      and push_delivery.next_attempt_at <= pg_catalog.now()
      and push_delivery.attempt_count < 3
      and push_device.enabled
      and push_device.user_id = alert.user_id
      and recall_match.status = 'confirmed'::public.recall_match_status
      and (p_alert_ids is null or alert.id = any (p_alert_ids))
    order by push_delivery.created_at, push_delivery.id
    for update of push_delivery skip locked
    limit least(greatest(coalesce(p_limit, 25), 1), 50)
  ),
  claimed as (
    update private.push_deliveries as push_delivery
    set
      status = 'processing',
      attempt_count = push_delivery.attempt_count + 1,
      lease_token = v_lease_token,
      lease_expires_at = v_lease_expires_at,
      updated_at = pg_catalog.now()
    from candidates
    where push_delivery.id = candidates.id
    returning push_delivery.*
  )
  select
    claimed.id,
    claimed.alert_id,
    claimed.push_device_id,
    push_device.expo_push_token,
    claimed.attempt_count,
    claimed.lease_token
  from claimed
  join private.push_devices as push_device on push_device.id = claimed.push_device_id
  order by claimed.created_at, claimed.id;
end;
$$;

create function public.record_recall_push_ticket(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_expo_ticket_id text default null,
  p_error_code text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt_count integer;
  v_push_device_id uuid;
  v_status text;
begin
  if p_outcome not in ('accepted', 'transient_error', 'permanent_error', 'invalid_device') then
    raise exception 'invalid push ticket outcome';
  end if;

  select push_delivery.attempt_count, push_delivery.push_device_id
  into v_attempt_count, v_push_device_id
  from private.push_deliveries as push_delivery
  where push_delivery.id = p_delivery_id
    and push_delivery.status = 'processing'
    and push_delivery.lease_token = p_lease_token
    and push_delivery.lease_expires_at > pg_catalog.now()
  for update;

  if v_attempt_count is null then
    return 'stale';
  end if;

  if p_outcome = 'accepted' then
    if p_expo_ticket_id is null or btrim(p_expo_ticket_id) = '' then
      raise exception 'accepted tickets require an Expo ticket id';
    end if;
    v_status := 'accepted';
    update private.push_deliveries as push_delivery
    set
      status = v_status,
      expo_ticket_id = p_expo_ticket_id,
      last_error_code = null,
      sent_at = pg_catalog.now(),
      receipt_available_at = pg_catalog.now() + interval '15 minutes',
      lease_token = null,
      lease_expires_at = null,
      updated_at = pg_catalog.now()
    where push_delivery.id = p_delivery_id;
  elsif p_outcome = 'transient_error' then
    v_status := case when v_attempt_count < 3 then 'pending' else 'failed' end;
    update private.push_deliveries as push_delivery
    set
      status = v_status,
      last_error_code = coalesce(nullif(btrim(p_error_code), ''), 'transient_error'),
      next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(secs => 60 * v_attempt_count),
      lease_token = null,
      lease_expires_at = null,
      updated_at = pg_catalog.now()
    where push_delivery.id = p_delivery_id;
  elsif p_outcome = 'invalid_device' then
    v_status := 'invalid_device';
    update private.push_devices as push_device
    set enabled = false, updated_at = pg_catalog.now()
    where push_device.id = v_push_device_id;
    update private.push_deliveries as push_delivery
    set
      status = v_status,
      last_error_code = coalesce(nullif(btrim(p_error_code), ''), 'DeviceNotRegistered'),
      lease_token = null,
      lease_expires_at = null,
      updated_at = pg_catalog.now()
    where push_delivery.id = p_delivery_id;
  else
    v_status := 'failed';
    update private.push_deliveries as push_delivery
    set
      status = v_status,
      last_error_code = coalesce(nullif(btrim(p_error_code), ''), 'permanent_error'),
      lease_token = null,
      lease_expires_at = null,
      updated_at = pg_catalog.now()
    where push_delivery.id = p_delivery_id;
  end if;

  return v_status;
end;
$$;

create function public.claim_recall_push_receipts(
  p_limit integer default 25,
  p_lease_seconds integer default 60
)
returns table (
  delivery_id uuid,
  push_device_id uuid,
  expo_ticket_id text,
  lease_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease_token uuid := gen_random_uuid();
  v_lease_expires_at timestamptz := pg_catalog.now() + pg_catalog.make_interval(
    secs => least(greatest(coalesce(p_lease_seconds, 60), 30), 300)
  );
begin
  return query
  with candidates as (
    select push_delivery.id
    from private.push_deliveries as push_delivery
    where (
        push_delivery.status = 'accepted'
        or (
          push_delivery.status = 'receipt_checking'
          and push_delivery.lease_expires_at <= pg_catalog.now()
        )
      )
      and push_delivery.receipt_available_at <= pg_catalog.now()
      and push_delivery.receipt_attempt_count < 3
      and push_delivery.expo_ticket_id is not null
    order by push_delivery.sent_at, push_delivery.id
    for update of push_delivery skip locked
    limit least(greatest(coalesce(p_limit, 25), 1), 50)
  ),
  claimed as (
    update private.push_deliveries as push_delivery
    set
      status = 'receipt_checking',
      receipt_attempt_count = push_delivery.receipt_attempt_count + 1,
      lease_token = v_lease_token,
      lease_expires_at = v_lease_expires_at,
      updated_at = pg_catalog.now()
    from candidates
    where push_delivery.id = candidates.id
    returning push_delivery.*
  )
  select claimed.id, claimed.push_device_id, claimed.expo_ticket_id, claimed.lease_token
  from claimed
  order by claimed.sent_at, claimed.id;
end;
$$;

create function public.record_recall_push_receipt(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_error_code text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt_attempt_count integer;
  v_push_device_id uuid;
  v_status text;
begin
  if p_outcome not in ('ok', 'transient_error', 'permanent_error', 'invalid_device') then
    raise exception 'invalid push receipt outcome';
  end if;

  select push_delivery.receipt_attempt_count, push_delivery.push_device_id
  into v_receipt_attempt_count, v_push_device_id
  from private.push_deliveries as push_delivery
  where push_delivery.id = p_delivery_id
    and push_delivery.status = 'receipt_checking'
    and push_delivery.lease_token = p_lease_token
    and push_delivery.lease_expires_at > pg_catalog.now()
  for update;

  if v_receipt_attempt_count is null then
    return 'stale';
  end if;

  if p_outcome = 'ok' then
    v_status := 'receipt_ok';
    update private.push_deliveries as push_delivery
    set
      status = v_status,
      last_error_code = null,
      receipt_checked_at = pg_catalog.now(),
      lease_token = null,
      lease_expires_at = null,
      updated_at = pg_catalog.now()
    where push_delivery.id = p_delivery_id;
  elsif p_outcome = 'transient_error' then
    v_status := case when v_receipt_attempt_count < 3 then 'accepted' else 'failed' end;
    update private.push_deliveries as push_delivery
    set
      status = v_status,
      last_error_code = coalesce(nullif(btrim(p_error_code), ''), 'receipt_unavailable'),
      receipt_available_at = pg_catalog.now() + interval '15 minutes',
      lease_token = null,
      lease_expires_at = null,
      updated_at = pg_catalog.now()
    where push_delivery.id = p_delivery_id;
  elsif p_outcome = 'invalid_device' then
    v_status := 'invalid_device';
    update private.push_devices as push_device
    set enabled = false, updated_at = pg_catalog.now()
    where push_device.id = v_push_device_id;
    update private.push_deliveries as push_delivery
    set
      status = v_status,
      last_error_code = coalesce(nullif(btrim(p_error_code), ''), 'DeviceNotRegistered'),
      receipt_checked_at = pg_catalog.now(),
      lease_token = null,
      lease_expires_at = null,
      updated_at = pg_catalog.now()
    where push_delivery.id = p_delivery_id;
  else
    v_status := 'failed';
    update private.push_deliveries as push_delivery
    set
      status = v_status,
      last_error_code = coalesce(nullif(btrim(p_error_code), ''), 'receipt_permanent_error'),
      receipt_checked_at = pg_catalog.now(),
      lease_token = null,
      lease_expires_at = null,
      updated_at = pg_catalog.now()
    where push_delivery.id = p_delivery_id;
  end if;

  return v_status;
end;
$$;

revoke all on function public.register_push_device(text, text) from public, anon, service_role;
revoke all on function public.unregister_push_device(text) from public, anon, service_role;
grant execute on function public.register_push_device(text, text) to authenticated;
grant execute on function public.unregister_push_device(text) to authenticated;

revoke all on function public.claim_recall_push_deliveries(integer, uuid[], integer)
from public, anon, authenticated;
revoke all on function public.record_recall_push_ticket(uuid, uuid, text, text, text)
from public, anon, authenticated;
revoke all on function public.claim_recall_push_receipts(integer, integer)
from public, anon, authenticated;
revoke all on function public.record_recall_push_receipt(uuid, uuid, text, text)
from public, anon, authenticated;

grant execute on function public.claim_recall_push_deliveries(integer, uuid[], integer)
to service_role;
grant execute on function public.record_recall_push_ticket(uuid, uuid, text, text, text)
to service_role;
grant execute on function public.claim_recall_push_receipts(integer, integer)
to service_role;
grant execute on function public.record_recall_push_receipt(uuid, uuid, text, text)
to service_role;

commit;
