-- Phase 17.7a-2 ROLLBACK (gated). NEVER in supabase/migrations: applied only on an
-- explicit "GO 17.7A2-ROLLBACK", and only AFTER run-recall-automation is back on the
-- exact v14 bundle (runtime tree 37a79b95...). A 17.7a-2 automation without this
-- function still fails closed (product_check_plan_unavailable, no worker call), but
-- every run would then report partial_success.
-- Removes the single read-only plan function. Changes no data and no setting.
begin;

drop function public.get_recall_automation_product_check_plan(uuid, uuid);

commit;
