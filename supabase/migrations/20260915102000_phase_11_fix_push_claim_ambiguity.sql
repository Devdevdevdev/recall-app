begin;

create or replace function public.claim_recall_push_deliveries(
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

commit;
