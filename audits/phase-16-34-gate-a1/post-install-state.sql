-- Phase 16.34 Gate A1: read-only post-install checks (SELECT only).
-- Row fingerprint method (reproduces the 16.33/16.34 values):
--   count || ' ' || left(md5(string_agg(to_jsonb(t)::text, ',' order by <pk>)), 8)
-- Migration-history fingerprint: md5(string_agg(version||name, ',' order by version)).
select
 (select count(*) from supabase_migrations.schema_migrations) as migrations,
 (select md5(string_agg(version||name, ',' order by version)) from supabase_migrations.schema_migrations where version <= '20260929110000') as fp_first_29,
 (select md5(string_agg(version||name, ',' order by version)) from supabase_migrations.schema_migrations) as fp_all,
 (select json_agg(json_build_object('jobid',jobid,'schedule',schedule,'active',active,'cmd_md5',md5(command)) order by jobid) from cron.job) as cron_jobs,
 (select count(*) from cron.job_run_details where status not in ('succeeded','failed')) as cron_unfinished,
 (select count(*) from net.http_request_queue) as net_queue,
 (select array_agg(name order by name) from vault.secrets) as vault_names,
 private.cpsc_page_stage_control_state(now()) as stage_state,
 private.recall_automation_pending_status(now()) as pending_status,
 private.scheduler_invocation_status(now()) as ticket_status,
 (select count(*)||' '||left(md5(string_agg(to_jsonb(t)::text, ',' order by t.id)),8) from private.cpsc_page_attempts t) as attempts,
 (select count(*)||' '||left(md5(string_agg(to_jsonb(t)::text, ',' order by t.identity_id)),8) from private.cpsc_page_work_state t) as work,
 (select count(*)||' '||left(md5(string_agg(to_jsonb(t)::text, ',' order by t.id)),8) from private.recall_automation_runs t) as runs,
 (select count(*) from private.recall_automation_lease) as lease,
 (select count(*) from private.cpsc_admin_capabilities) as capabilities,
 (select count(*) from private.cpsc_reviewer_authorizations) as reviewer_auth,
 (select count(*) from private.cpsc_page_stage_control_events) as control_events,
 (select count(*) from private.cpsc_page_stage_ticks) as page_ticks,
 (select count(*) from private.scheduler_invocation_tickets) as tickets;
