begin;

create function public.queue_recall_push_alerts(p_alert_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queued integer;
begin
  if p_alert_ids is null
    or pg_catalog.cardinality(p_alert_ids) < 1
    or pg_catalog.cardinality(p_alert_ids) > 50 then
    raise exception 'targeted push queue requires between 1 and 50 alert ids';
  end if;

  insert into private.push_alert_queue (alert_id)
  select alert.id
  from public.alerts as alert
  join public.recall_matches as recall_match on recall_match.id = alert.recall_match_id
  where alert.id = any (p_alert_ids)
    and recall_match.status = 'confirmed'::public.recall_match_status
  on conflict on constraint push_alert_queue_pkey do nothing;

  get diagnostics v_queued = row_count;
  return v_queued;
end;
$$;

revoke all on function public.queue_recall_push_alerts(uuid[])
from public, anon, authenticated;
grant execute on function public.queue_recall_push_alerts(uuid[])
to service_role;

commit;
