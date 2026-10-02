-- Phase 16.34 Gate C — step C1: cutover. The ONLY mutating statement is
--   select private.convert_recall_automation_cron_to_tickets();
-- Run: psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-c/c1-cutover.sql
-- The pre- and post-assertions are reads inside the same transaction. If either raises,
-- ON_ERROR_STOP ends psql before COMMIT and nothing is committed.
begin;
select 'before' as stage, jobid, jobname, schedule, active, md5(command) as command_md5 from cron.job;
do $$
begin
  if (select count(*) from cron.job) <> 1 or not exists (
      select 1 from cron.job where jobid = 2 and jobname = 'recall-automation-every-6h'
        and schedule = '17 */6 * * *' and active
        and md5(command) = '07549bf985a3034a5ef9c645692097b6') then
    raise exception 'C1 pre-state mismatch: nothing changed';
  end if;
  if (select count(*) from cron.job_run_details where status not in ('succeeded', 'failed')) <> 0
      or (select count(*) from net.http_request_queue) <> 0
      or (select count(*) from private.recall_automation_lease) <> 0
      or (select count(*) from private.recall_matching_leases) <> 0
      or (select count(*) from private.recall_automation_runs where status = 'running') <> 0 then
    raise exception 'C1: work in flight: nothing changed';
  end if;
end $$;
select private.convert_recall_automation_cron_to_tickets() as converted_jobid;
do $$
begin
  if (select count(*) from cron.job) <> 1 or not exists (
      select 1 from cron.job where jobid = 2 and jobname = 'recall-automation-every-6h'
        and schedule = '17 */6 * * *' and active
        and command = 'select private.recall_automation_tick();') then
    raise exception 'C1 post-state mismatch: transaction not committed';
  end if;
end $$;
select 'after' as stage, jobid, jobname, schedule, active, md5(command) as command_md5, command from cron.job;
commit;
