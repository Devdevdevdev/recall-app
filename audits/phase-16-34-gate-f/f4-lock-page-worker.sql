-- Phase 16.34 Gate F — F4: remove the cpsc_page_worker login password (plan §11 and §17, Gate F step 4). OWNER ONLY.
-- The ONLY mutating statement is:  alter role cpsc_page_worker password null;
-- It runs inside one transaction with read-only pre- and post-assertions. If any assertion fails,
-- ON_ERROR_STOP ends psql before COMMIT and nothing is committed. No password or hash is read or
-- printed: the checks only test `rolpassword is null`. The role, its grants and LOGIN are kept, so
-- page work can be re-enabled later only with a NEW password and a new CPSC_PAGE_DB_URL (separate gate).
-- Run once, between natural runs (not within 30 min of a :17):
--   psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-f/f4-lock-page-worker.sql
begin;
select 'before' as stage, rolname, rolcanlogin, rolsuper,
  (select rolpassword is null from pg_authid where rolname = 'cpsc_page_worker') as password_is_null,
  (select count(*) from pg_stat_activity where usename = 'cpsc_page_worker') as sessions
from pg_roles where rolname = 'cpsc_page_worker';
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cpsc_page_worker'
      and rolcanlogin and not rolsuper and not rolcreaterole and not rolbypassrls) then
    raise exception 'F4 pre-state mismatch: cpsc_page_worker missing or not the expected login role: nothing changed';
  end if;
  if (select rolpassword is null from pg_authid where rolname = 'cpsc_page_worker') then
    raise exception 'F4: cpsc_page_worker already has no password: nothing changed';
  end if;
  if (select count(*) from pg_stat_activity where usename = 'cpsc_page_worker') <> 0 then
    raise exception 'F4: cpsc_page_worker has an open session: nothing changed';
  end if;
  if private.cpsc_page_stage_control_state(now()) <> '{"state":"never_started","running":false}'::jsonb
      or exists (select 1 from cron.job where jobname ilike '%page%' or command ilike '%page%')
      or exists (select 1 from private.scheduler_invocation_tickets where job <> 'recall_automation') then
    raise exception 'F4: page stage is not dormant: nothing changed';
  end if;
  if (select count(*) from net.http_request_queue) <> 0
      or (select count(*) from private.recall_automation_lease) <> 0
      or (select count(*) from private.recall_automation_runs where status = 'running') <> 0
      or (select count(*) from cron.job_run_details where status not in ('succeeded', 'failed')) <> 0 then
    raise exception 'F4: work in flight: nothing changed';
  end if;
end $$;
alter role cpsc_page_worker password null;
do $$
begin
  if not (select rolpassword is null from pg_authid where rolname = 'cpsc_page_worker') then
    raise exception 'F4 post-state mismatch: password still set: transaction not committed';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'cpsc_page_worker'
      and rolcanlogin and not rolsuper and not rolcreaterole and not rolbypassrls and rolvaliduntil is null) then
    raise exception 'F4 post-state mismatch: other role attributes changed: transaction not committed';
  end if;
end $$;
select 'after' as stage, rolname, rolcanlogin, rolsuper,
  (select rolpassword is null from pg_authid where rolname = 'cpsc_page_worker') as password_is_null
from pg_roles where rolname = 'cpsc_page_worker';
commit;
