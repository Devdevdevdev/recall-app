-- Phase 16.33 production-safe rollback-only install check for the Phase 16.32
-- and 16.33 migrations. Kept outside supabase/tests (it asserts the state that
-- installation alone must leave). Run only through scripts/run-remote-pgtap.mjs
-- from the repository root, immediately after `supabase db push`. The final
-- ROLLBACK removes the transient pgTAP install and everything the probes wrote.
-- No Cron job, Vault secret, capability or control event is created; the one
-- tick probe must skip, and pg_net sends nothing before a commit anyway.
begin;
set local role postgres;
set local search_path = extensions, public, auth;
select extensions.no_plan();
grant usage on schema extensions to cpsc_page_worker;

select set_config('p1633.base', jsonb_build_object(
  'attempts', (select count(*) from private.cpsc_page_attempts),
  'work', (select count(*) from private.cpsc_page_work_state),
  'queue', (select count(*) from net.http_request_queue),
  'runs', (select count(*) from private.recall_automation_runs),
  'pending', (select count(*) from private.recall_automation_pending_recalls),
  'holds', (select md5(string_agg(to_jsonb(h)::text, ',' order by h.id))
    from private.cpsc_page_identity_holds h),
  'candidates', (select md5(string_agg(to_jsonb(c)::text, ',' order by c.id))
    from private.cpsc_candidate_criteria c))::text, true);

-- Installation leaves the page stage stopped and unscheduled.
select extensions.ok(exists (select 1 from supabase_migrations.schema_migrations
    where version = '20260930120000')
  and exists (select 1 from supabase_migrations.schema_migrations where version = '20260930200000'),
  'both migrations are installed');
select extensions.is(private.cpsc_page_stage_control_state(now())->>'state', 'never_started',
  'the page stage has never been started');
select extensions.is((select count(*) from private.cpsc_page_stage_control_events), 0::bigint,
  'no control event exists');
select extensions.is((select count(*) from cron.job where jobname = 'cpsc-page-evidence-shadow'),
  0::bigint, 'no page Cron job exists');
select extensions.ok((select coalesce(bool_and(jobname = 'recall-automation-every-6h'), true)
  from cron.job), 'the only Cron job, if any, is the v1 job');
select extensions.ok((select coalesce(bool_and(command like '%recall_automation_key%'
    and command not like '%recall_automation_tick%'), true)
  from cron.job where jobname = 'recall-automation-every-6h'),
  'the v1 job was not converted by installation');

-- No secret, capability, ticket, attestation or outcome was created.
select extensions.is((select count(*) from vault.secrets where name like 'cpsc_page_worker%'),
  0::bigint, 'no page-stage Vault secret exists');
select extensions.is((select count(*) from private.cpsc_admin_capabilities), 0::bigint,
  'no human capability exists');
select extensions.is((select count(*) from private.cpsc_reviewer_authorizations), 0::bigint,
  'no reviewer authorization exists');
select extensions.is((select count(*) from private.scheduler_invocation_tickets), 0::bigint,
  'no invocation ticket exists');
select extensions.is((select count(*) from private.cpsc_outside_census_attestations), 0::bigint,
  'no outside-census attestation exists');
select extensions.is((select count(*) from private.recall_automation_matching_outcomes), 0::bigint,
  'no v1 outcome row exists yet');
select extensions.ok((select bool_and(unresolved_attempts = 0 and exhausted_at is null
    and last_unresolved_reason is null) from private.recall_automation_pending_recalls)
  is not false, 'existing pending work keeps neutral retry columns');

-- Probes: no caller can claim; a tick skips and queues nothing.
set local role cpsc_page_worker;
select extensions.is((select count(*) from public.claim_cpsc_page_evidence(1)), 0::bigint,
  'the dedicated worker claims nothing while the stage is stopped');
reset role;
set local role postgres;
select extensions.is(private.cpsc_page_stage_tick()->>'decision', 'skipped',
  'a tick skips while the stage is stopped');
select extensions.ok((select count(*) from net.http_request_queue)
    = (current_setting('p1633.base')::jsonb->>'queue')::bigint,
  'no worker request was queued');
select extensions.ok((select count(*) from private.cpsc_page_attempts)
    = (current_setting('p1633.base')::jsonb->>'attempts')::bigint
  and (select count(*) from private.cpsc_page_work_state)
    = (current_setting('p1633.base')::jsonb->>'work')::bigint,
  'no page attempt or work state appeared');

-- Humans: nothing works without a live aal2 session and a grant.
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated',
  'sub', gen_random_uuid(), 'aal', 'aal2', 'session_id', gen_random_uuid())::text, true);
select extensions.ok(not private.cpsc_has_capability('operational_scheduler_control')
    and not private.cpsc_is_human_reviewer(), 'an unknown session holds no capability');
select set_config('request.jwt.claims', '', true);

-- v1 is unaffected: same RPC grants, same pending set, no run touched.
select extensions.ok(has_function_privilege('service_role',
    'public.record_recall_automation_matching(uuid,uuid,uuid[],boolean,integer,integer,integer,integer,integer,integer,integer,integer)',
    'EXECUTE')
  and has_function_privilege('service_role',
    'public.get_recall_automation_pending_recalls(uuid,uuid,integer)', 'EXECUTE'),
  'the deployed v1 automation keeps every RPC it calls');
select extensions.ok((select count(*) from private.recall_automation_runs)
    = (current_setting('p1633.base')::jsonb->>'runs')::bigint
  and (select count(*) from private.recall_automation_pending_recalls)
    = (current_setting('p1633.base')::jsonb->>'pending')::bigint,
  'no v1 run or pending row changed');

-- Holds and candidates are untouched; v2 stays inactive.
select extensions.ok((select md5(string_agg(to_jsonb(h)::text, ',' order by h.id))
    from private.cpsc_page_identity_holds h)
    is not distinct from current_setting('p1633.base')::jsonb->>'holds'
  and (select md5(string_agg(to_jsonb(c)::text, ',' order by c.id))
    from private.cpsc_candidate_criteria c)
    is not distinct from current_setting('p1633.base')::jsonb->>'candidates',
  'holds and candidate criteria are unchanged');
select extensions.is((select count(*) from private.recall_match_evaluations_v2), 0::bigint,
  'no v2 evaluation exists');

select * from extensions.finish();
rollback;
