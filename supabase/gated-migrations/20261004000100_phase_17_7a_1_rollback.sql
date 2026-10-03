-- Phase 17.7a-1 ROLLBACK (gated). NEVER in supabase/migrations: applied only on an
-- explicit "GO 17.7A1-ROLLBACK", after:
--   1. product_check_enabled = false (immediate functional stop);
--   2. run-recall-automation back on the exact v14 bundle;
--   3. check-owned-product and process-owned-product-checks deleted;
--   4. the 17.7a-2 rollback applied (enforced below).
-- It removes the 17.7a-1 schema objects only. It deletes NO owned product, NO alert,
-- NO recall match and NO v2 evaluation/eligibility/snapshot: results already written
-- by product checks stay exactly as stored and are never re-promoted. The only rows
-- removed are the 17.7a-1 operational queue and its journal (derived state).
-- F-4 objects are not touched.
begin;

do $$
begin
  if to_regprocedure('public.get_recall_automation_product_check_plan(uuid,uuid)') is not null then
    raise exception 'roll back Phase 17.7a-2 first';
  end if;
end;
$$;

drop trigger owned_products_arm_recall_check_insert on public.owned_products;
drop trigger owned_products_arm_recall_check_update on public.owned_products;

drop function public.get_my_product_monitoring_states(uuid[]);
drop function public.complete_owned_product_recall_check(
  uuid, uuid, bigint, text, text, integer, uuid, text);
drop function public.claim_due_owned_product_recall_checks(integer, integer);
drop function public.claim_owned_product_recall_check(uuid, uuid, integer);
drop function private.claim_owned_product_recall_check_row(uuid, text, integer);
drop function private.owned_product_check_backoff(integer);
drop function private.owned_product_monitoring_state(uuid);
drop function public.get_owned_product_recall_candidates(uuid, integer, uuid, integer);
drop function private.arm_owned_product_recall_check();

drop index public.recall_notices_title_fts_idx;
drop index public.recall_scopes_normalized_brand_idx;
drop index public.recall_scopes_serial_range_idx;
drop index public.recall_scopes_lot_range_idx;

drop table private.owned_product_recall_check_events;
drop function private.owned_product_recall_check_events_immutable();
drop table private.owned_product_recall_checks;

alter table private.recall_automation_control
  drop column product_check_enabled,
  drop column max_product_check_candidates;

commit;
