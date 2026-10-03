-- Phase 17.7a-2 is a LOCAL candidate. Install only after Phase 17.7a-1
-- (20261002120000), following docs/phase-17-7a-2-automation-integration.md.
--
-- run-recall-automation must know the product-check flag BEFORE it calls the
-- product-check worker, so that a disabled flag means no worker call at all.
-- No existing RPC exposes private.recall_automation_control to the service, so
-- this adds one read-only function:
--   * bound to the live automation run lease (same rule as the other run RPCs);
--   * returns only the flag, never a product, user or recall;
--   * changes no state, adds no setting, schedules nothing.
-- The flag keeps its 17.7a-1 default (false); this migration does not touch it.
begin;

create function public.get_recall_automation_product_check_plan(
  p_run_id uuid,
  p_lease_token uuid
)
returns table (product_check_enabled boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from private.recall_automation_lease as automation_lease
    where automation_lease.run_id = p_run_id
      and automation_lease.lease_token = p_lease_token
      and automation_lease.expires_at > pg_catalog.now()
  ) then
    raise exception 'automation run lease is unavailable';
  end if;

  product_check_enabled := coalesce(
    (
      select control.product_check_enabled
      from private.recall_automation_control as control
      where control.singleton
    ),
    false
  );
  return next;
end;
$$;

revoke all on function public.get_recall_automation_product_check_plan(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_recall_automation_product_check_plan(uuid, uuid)
  to service_role;

commit;
