-- Phase 16.34 GATE F ONLY. Staged outside supabase/migrations so that
-- `supabase db push` at Gate A cannot apply it. Copy it into
-- supabase/migrations only when Gate F is separately approved, after job 2
-- runs on tickets (Gate C/D) and the exposed static key is retired (Gate E).
--
-- The Phase 12 installer rebuilds job 2 with a command that reads the static
-- x-recall-automation-key from Vault. After Gate E that Vault secret no longer
-- exists; this forward-only change makes the installer (re)create the ticket
-- command instead, so no recovery path can put a long-lived key back into the
-- pg_net queue. Same name, schedule, inactive-on-install behaviour and grants.
begin;

create or replace function private.install_recall_automation_cron()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id bigint;
begin
  if not exists (
    select 1 from vault.decrypted_secrets where name = 'recall_automation_url'
  ) then
    raise exception 'required Recall automation Vault endpoint is unavailable';
  end if;

  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'recall-automation-every-6h';

  select cron.schedule(
    'recall-automation-every-6h',
    '17 */6 * * *',
    'select private.recall_automation_tick();'
  ) into v_job_id;

  perform cron.alter_job(v_job_id, active := false);
  return v_job_id;
end;
$$;

revoke all on function private.install_recall_automation_cron() from public, anon, authenticated;
grant execute on function private.install_recall_automation_cron() to service_role;

commit;
