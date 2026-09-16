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
  ) or not exists (
    select 1 from vault.decrypted_secrets where name = 'recall_automation_key'
  ) then
    raise exception 'required Recall automation Vault secrets are unavailable';
  end if;

  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'recall-automation-every-6h';

  select cron.schedule(
    'recall-automation-every-6h',
    '17 */6 * * *',
    $cron$
      select net.http_post(
        url := (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'recall_automation_url'
        ),
        headers := pg_catalog.jsonb_build_object(
          'content-type', 'application/json',
          'x-recall-automation-key', (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'recall_automation_key'
          )
        ),
        body := '{"trigger":"cron"}'::jsonb,
        timeout_milliseconds := 30000
      ) as request_id;
    $cron$
  ) into v_job_id;

  perform cron.alter_job(v_job_id, active := false);
  return v_job_id;
end;
$$;

create or replace function private.set_recall_automation_cron_active(p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'recall-automation-every-6h';

  if v_job_id is null or (
    select count(*)
    from cron.job
    where jobname = 'recall-automation-every-6h'
  ) <> 1 then
    raise exception 'exactly one Recall automation Cron job is required';
  end if;

  perform cron.alter_job(v_job_id, active := p_active);
end;
$$;

revoke all on function private.install_recall_automation_cron() from public, anon, authenticated;
revoke all on function private.set_recall_automation_cron_active(boolean)
from public, anon, authenticated;
grant execute on function private.install_recall_automation_cron() to service_role;
grant execute on function private.set_recall_automation_cron_active(boolean) to service_role;

commit;
