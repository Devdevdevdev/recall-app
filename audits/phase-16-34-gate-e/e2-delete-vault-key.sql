-- Phase 16.34 Gate E — E2: delete the static key from Vault (plan §17, Gate E step 2). OWNER ONLY.
-- The ONLY mutating statement is:  delete from vault.secrets where name = 'recall_automation_key';
-- It runs inside one transaction with read-only pre- and post-assertions. If any assertion fails,
-- ON_ERROR_STOP ends psql before COMMIT and nothing is committed. No secret value is read or printed.
-- Run once, after E1 and its post-checks, between natural runs (not within 30 min of a :17):
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-e/e2-delete-vault-key.sql
begin;
select 'before' as stage, name, updated_at from vault.secrets order by name;
do $$
declare v_deleted integer;
begin
  if (select jsonb_agg(jsonb_build_object('n', name, 'u', updated_at) order by name) from vault.secrets)
      is distinct from '[{"n":"recall_automation_key","u":"2026-09-16T06:03:21.458957+00:00"},{"n":"recall_automation_url","u":"2026-09-16T06:03:35.819456+00:00"}]'::jsonb then
    raise exception 'E2 pre-state mismatch: Vault is not exactly {recall_automation_key, recall_automation_url}: nothing changed';
  end if;
  if (select count(*) from cron.job) <> 1 or not exists (select 1 from cron.job where jobid = 2
      and jobname = 'recall-automation-every-6h' and schedule = '17 */6 * * *' and active
      and md5(command) = 'aae24c409d36e91c64b4e1732d6c6651') then
    raise exception 'E2 pre-state mismatch: job 2 is not the only job on the ticket command: nothing changed';
  end if;
  if (select count(*) from net.http_request_queue) <> 0
      or (select count(*) from private.recall_automation_lease) <> 0
      or (select count(*) from private.recall_matching_leases) <> 0
      or (select count(*) from private.recall_automation_runs where status = 'running') <> 0
      or (select count(*) from cron.job_run_details where status not in ('succeeded', 'failed')) <> 0 then
    raise exception 'E2: work in flight: nothing changed';
  end if;
  delete from vault.secrets where name = 'recall_automation_key';
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception 'E2: expected exactly 1 row deleted, got %: transaction not committed', v_deleted;
  end if;
  if (select jsonb_agg(jsonb_build_object('n', name, 'u', updated_at) order by name) from vault.secrets)
      is distinct from '[{"n":"recall_automation_url","u":"2026-09-16T06:03:35.819456+00:00"}]'::jsonb then
    raise exception 'E2 post-state mismatch: transaction not committed';
  end if;
end $$;
select 'after' as stage, name, updated_at from vault.secrets order by name;
commit;
