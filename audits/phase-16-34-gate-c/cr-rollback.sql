-- Phase 16.34 Gate C — rollback: restore job 2's Phase 12 static-key command IN PLACE
-- (same jobid 2, schedule and active flag). The command text is taken byte-exactly from
-- the installed Phase 12 installer and is applied only if its MD5 is the recorded
-- production fingerprint 07549bf985a3034a5ef9c645692097b6. The command reads the
-- still-current Vault key at run time; no key is restored, rotated or read here.
-- Run: psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-c/cr-rollback.sql
begin;
select 'before' as stage, jobid, schedule, active, md5(command) as command_md5 from cron.job;
do $$
declare v_cmd text;
begin
  if (select count(*) from cron.job) <> 1
      or not exists (select 1 from cron.job where jobid = 2 and jobname = 'recall-automation-every-6h') then
    raise exception 'CR: job 2 is not the only job: use the documented fallback, do not improvise';
  end if;
  if not exists (select 1 from vault.secrets where name = 'recall_automation_key')
      or not exists (select 1 from vault.secrets where name = 'recall_automation_url') then
    raise exception 'CR: a Phase 12 Vault secret is missing: static-key rollback is impossible';
  end if;
  v_cmd := substring(pg_catalog.pg_get_functiondef('private.install_recall_automation_cron()'::regprocedure)
    from '\$cron\$(.*)\$cron\$');
  if v_cmd is null or md5(v_cmd) <> '07549bf985a3034a5ef9c645692097b6' then
    raise exception 'CR: Phase 12 command text does not match the recorded fingerprint';
  end if;
  perform cron.alter_job(2, command := v_cmd);
end $$;
do $$
begin
  if (select count(*) from cron.job) <> 1 or not exists (
      select 1 from cron.job where jobid = 2 and jobname = 'recall-automation-every-6h'
        and schedule = '17 */6 * * *' and md5(command) = '07549bf985a3034a5ef9c645692097b6') then
    raise exception 'CR post-state mismatch: transaction not committed';
  end if;
end $$;
select 'after' as stage, jobid, schedule, active, md5(command) as command_md5 from cron.job;
commit;
