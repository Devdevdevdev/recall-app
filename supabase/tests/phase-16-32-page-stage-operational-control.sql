begin;
set local role postgres;
set local search_path = extensions, public, auth;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();
grant usage on schema extensions to cpsc_page_worker;

create function pg_temp.id(p_suffix text) returns uuid language sql immutable as $$
  select ('16320000-0000-4000-8000-' || lpad(p_suffix, 12, '0'))::uuid;
$$;
create function pg_temp.act(p_role text, p_sub text default null) returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('role', p_role) ||
    case when p_sub is null then '{}'::jsonb
      else jsonb_build_object('sub', pg_temp.id(p_sub), 'aal', 'aal2',
        'session_id', pg_temp.id(p_sub)) end)::text, true);
$$;
create function pg_temp.done() returns void language sql as $$
  select set_config('request.jwt.claims', '', true);
$$;
-- Worker-side claim helper: returns the claimed recall numbers.
create function pg_temp.claim(p_limit integer) returns text[] language plpgsql as $$
declare v text[];
begin
  set local role cpsc_page_worker;
  select coalesce(array_agg(official_recall_number order by official_recall_number), '{}')
    into v from public.claim_cpsc_page_evidence(p_limit);
  reset role;
  set local role postgres;
  return v;
end $$;
create function pg_temp.finish(p_number text, p_outcome text, p_error text,
  p_final_url text default null) returns jsonb language plpgsql as $$
declare v jsonb; v_claim uuid;
begin
  select w.claim_id into v_claim from private.cpsc_page_work_state w
    join private.cpsc_source_identities i on i.id = w.identity_id
    where i.official_recall_number = p_number;
  set local role cpsc_page_worker;
  v := public.finish_cpsc_page_attempt(v_claim, p_outcome, null, p_final_url, null, p_error);
  reset role;
  set local role postgres;
  return v;
end $$;
create function pg_temp.finish_active(p_outcome text, p_error text) returns integer
language plpgsql as $$
declare v_claim uuid; v_count integer := 0;
begin
  for v_claim in select claim_id from private.cpsc_page_work_state
    where claim_id is not null and claim_expires_at > now()
  loop
    set local role cpsc_page_worker;
    perform public.finish_cpsc_page_attempt(v_claim, p_outcome, null, null, null, p_error);
    reset role;
    set local role postgres;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
create function pg_temp.blockers(p_now timestamptz default now()) returns text[] language sql as $$
  select coalesce(array_agg(value), '{}') from jsonb_array_elements_text(
    private.cpsc_page_stage_policy(p_now)->'blockers');
$$;
create function pg_temp.v1_fp() returns text language sql stable as $$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x.singleton) from private.recall_automation_control x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.singleton) from private.recall_automation_state x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from private.recall_automation_runs x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.singleton) from private.recall_automation_lease x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.source_id) from private.recall_source_sync_state x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.jobid)
      from cron.job x where x.jobname <> 'cpsc-page-evidence-shadow')));
$$;

-- ===========================================================================
-- Privilege boundary.
-- ===========================================================================
select extensions.ok(c.relrowsecurity and not exists (
  select 1 from pg_policies p where p.schemaname = 'private' and p.tablename = c.relname),
  format('%s has RLS and no API policy', c.relname))
from pg_class c where c.oid in ('private.cpsc_authorization_audit'::regclass,
  'private.cpsc_page_stage_control_events'::regclass, 'private.cpsc_page_stage_ticks'::regclass);
select extensions.ok(not has_table_privilege(r, t, p), format('%s cannot %s %s', r, p, t))
from unnest(array['anon','authenticated','service_role','cpsc_page_worker']) r,
  unnest(array['private.cpsc_authorization_audit','private.cpsc_page_stage_control_events',
    'private.cpsc_page_stage_ticks','private.cpsc_admin_capabilities',
    'private.cpsc_reviewer_authorizations']) t,
  unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p;
select extensions.ok(not has_function_privilege(r, f, 'EXECUTE'),
  format('%s cannot execute %s', r, f))
from unnest(array['anon','authenticated','service_role','cpsc_page_worker']) r,
  unnest(array['private.cpsc_page_stage_control_state(timestamptz)',
    'private.stop_cpsc_page_stage_as_owner(text)',
    'private.cpsc_page_stage_policy(timestamptz)', 'private.cpsc_page_stage_tick()',
    'private.install_cpsc_page_stage_cron()', 'private.set_cpsc_page_stage_cron_active(boolean)',
    'private.uninstall_cpsc_page_stage_cron()', 'private.cpsc_page_stage_status(timestamptz)']) f;
select extensions.ok(not has_function_privilege(r, f, 'EXECUTE'),
  format('%s cannot execute %s', r, f))
from unnest(array['anon','service_role','cpsc_page_worker']) r,
  unnest(array['public.start_cpsc_page_stage(text,integer,integer,integer,integer)',
    'public.stop_cpsc_page_stage(text)', 'public.get_cpsc_page_stage_status()',
    'public.get_cpsc_candidate_review_context(uuid)']) f;
select extensions.ok(has_function_privilege('cpsc_page_worker',
  'public.claim_cpsc_page_evidence(integer)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.claim_cpsc_page_evidence(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_cpsc_page_evidence(integer)', 'EXECUTE'),
  'claim keeps its dedicated-worker grant');
select extensions.is((select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosecdef
    and has_function_privilege('cpsc_page_worker', p.oid, 'EXECUTE')
    and p.prorettype <> 'trigger'::regtype),
  -- Phase 16.33 adds only the single-use scheduler ticket consumer.
  array['claim_cpsc_page_evidence(integer)',
    'commit_cpsc_page_evidence_verified(uuid,jsonb,jsonb,jsonb,jsonb,bytea)',
    'consume_cpsc_page_stage_ticket(text)',
    'finish_cpsc_page_attempt(uuid,text,integer,text,text,text)',
    'retain_cpsc_page_transport(uuid,jsonb,bytea)'],
  'the worker gains no executable security-definer function');

-- ===========================================================================
-- Fixtures: users, capabilities and four ordinary eligible identities.
-- ===========================================================================
insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select pg_temp.id(s),'authenticated','authenticated',e,'','2099-01-01','{}','{}',now(),now()
from (values ('901','p1632-operator@example.test'), ('902','p1632-reconciler@example.test'),
  ('903','p1632-criterion-reviewer@example.test'), ('904','p1632-consumer@example.test'),
  ('905','p1632-operator-two@example.test')) u(s, e);
-- Phase 16.33: human capabilities need a live aal2 session with a fresh MFA
-- step and a verified factor. Each fixture user gets one (session id = user id).
insert into auth.sessions (id, user_id, aal, created_at, updated_at)
select u.id, u.id, 'aal2', now(), now() from auth.users u
where u.created_at = now() and u.email ~ '@example[.](invalid|test)$'
  and not exists (select 1 from auth.sessions s where s.id = u.id);
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at,
  updated_at)
select u.id, u.id, 'pgTAP TOTP', 'totp', 'verified', now(), now() from auth.users u
where u.created_at = now() and u.email ~ '@example[.](invalid|test)$'
  and not exists (select 1 from auth.mfa_factors f where f.id = u.id);
insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
select gen_random_uuid(), u.id, 'totp', now(), now() from auth.users u
where u.created_at = now() and u.email ~ '@example[.](invalid|test)$'
  and not exists (select 1 from auth.mfa_amr_claims a where a.session_id = u.id);
insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason) values
  (pg_temp.id('901'), 'operational_scheduler_control', now() - interval '1 hour', 'pgTAP operator'),
  (pg_temp.id('902'), 'identity_reconciliation', now() - interval '1 hour', 'pgTAP reconciler'),
  (pg_temp.id('905'), 'operational_scheduler_control', now() - interval '1 hour', 'pgTAP operator 2');
insert into private.cpsc_reviewer_authorizations (user_id, reason)
values (pg_temp.id('903'), 'pgTAP criterion reviewer');

select set_config('p1632.source', public.ensure_cpsc_recall_source()::text, true);
create function pg_temp.identity(p_number text, p_first timestamptz) returns uuid
language plpgsql as $$
declare v_notice uuid := gen_random_uuid(); v_identity uuid := gen_random_uuid();
  v_url text := 'https://www.cpsc.gov/Recalls/2026/P1632-' || p_number;
begin
  insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
    recall_date,official_url,retrieved_at,raw_payload)
  values (v_notice, current_setting('p1632.source')::uuid, 'cpsc:' || p_number,
    'P1632 ' || p_number, 'Description', 'Hazard', 'Refund', '2026-09-20', v_url, now(),
    jsonb_build_object('RecallNumber', p_number));
  insert into private.cpsc_source_identities (id,source_id,official_recall_number,
    canonical_url,canonical_notice_id,identity_status,first_seen_at,last_seen_at)
  values (v_identity, current_setting('p1632.source')::uuid, p_number, v_url, v_notice,
    'reconciled', p_first, now());
  insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance)
  values (v_notice, v_identity, 'Phase 16.32 pgTAP');
  return v_identity;
end $$;
select set_config('p1632.r', pg_temp.identity('29320', '1900-01-01 00:00:00+00')::text, true);
select pg_temp.identity('29321', '1900-01-01 00:00:01+00');
select pg_temp.identity('29322', '1900-01-01 00:00:02+00');
select pg_temp.identity('29323', '1900-01-01 00:00:03+00');
select pg_temp.identity('29324', '1900-01-01 00:00:04+00');
select extensions.is((select count(*) from private.cpsc_page_identity_eligibility
  where official_recall_number like '2932%' and page_eligibility = 'eligible'), 5::bigint,
  'five ordinary fixture identities are page-eligible');

-- ===========================================================================
-- Default DISABLED: nothing is claimable before an operator starts the stage.
-- ===========================================================================
select extensions.is(private.cpsc_page_stage_control_state(now())->>'state', 'never_started',
  'the page stage defaults to never started');
select extensions.is(pg_temp.claim(10), '{}'::text[],
  'no eligible identity is claimable while the stage is stopped');
select extensions.ok('stage_not_running' = any(pg_temp.blockers()),
  'policy reports stage_not_running');

-- ===========================================================================
-- Capability separation and fake operators.
-- ===========================================================================
select pg_temp.act('authenticated', '904');
select extensions.throws_ok($$select public.start_cpsc_page_stage('consumer', 1, 2, 4, 48)$$,
  '42501', null, 'a consumer cannot start the page stage');
select extensions.throws_ok($$select public.get_cpsc_page_stage_status()$$,
  '42501', null, 'a consumer cannot read page-stage status');
select pg_temp.act('authenticated', '903');
select extensions.throws_ok($$select public.start_cpsc_page_stage('reviewer', 1, 2, 4, 48)$$,
  '42501', null, 'a criterion reviewer cannot start the page stage');
select pg_temp.act('authenticated', '902');
select extensions.throws_ok($$select public.start_cpsc_page_stage('reconciler', 1, 2, 4, 48)$$,
  '42501', null, 'an identity reconciler cannot start the page stage');
select extensions.throws_ok($$select public.stop_cpsc_page_stage('reconciler')$$,
  '42501', null, 'an identity reconciler cannot stop the page stage');
select pg_temp.act('service_role');
select extensions.throws_ok($$select public.start_cpsc_page_stage('service', 1, 2, 4, 48)$$,
  '42501', null, 'service_role cannot start the page stage');
select extensions.throws_ok($$insert into private.cpsc_page_stage_control_events
  (action, actor_kind, reason) values ('stop', 'database_owner', 'service impersonation')$$,
  '42501', null, 'service_role claims cannot record an owner stop');
select pg_temp.done();
select extensions.throws_ok(format($$insert into private.cpsc_page_stage_control_events
  (action, actor_kind, actor_user_id, reason, valid_until, max_pages_per_cycle,
   max_claims_per_hour, max_claims_per_day)
  values ('start', 'operator', %L, 'owner forgery', now() + interval '1 hour', 2, 4, 48)$$,
  pg_temp.id('901')), '42501', null,
  'the owner cannot forge an operator start with a real operator id');
select extensions.throws_ok($$insert into private.cpsc_page_stage_control_events
  (action, actor_kind, reason, valid_until, max_pages_per_cycle, max_claims_per_hour,
   max_claims_per_day) values ('start', 'database_owner', 'owner start', now() + interval '1 hour',
   2, 4, 48)$$, '42501', null, 'the database owner can never start the page stage');
set local role cpsc_page_worker;
select extensions.throws_ok($$select public.start_cpsc_page_stage('worker', 1, 2, 4, 48)$$,
  '42501', null, 'the page worker cannot start the page stage');
reset role;
set local role postgres;
-- The scheduler capability confers nothing else.
select pg_temp.act('authenticated', '901');
select extensions.throws_ok($$select public.resolve_cpsc_page_identity_hold(gen_random_uuid(),
  'clear_page_hold', 'operator attempt')$$, '42501', null,
  'a scheduler operator cannot resolve a page hold');
select extensions.throws_ok($$select public.decide_cpsc_candidate(gen_random_uuid(), 'reviewed',
  true, 'operator attempt')$$, '42501', null,
  'a scheduler operator cannot review a criterion');
select extensions.throws_ok($$select public.get_cpsc_candidate_review_context(gen_random_uuid())$$,
  '42501', null, 'a scheduler operator cannot read criterion review context');
select extensions.throws_ok($$select public.start_cpsc_page_stage('too long', 337, 2, 4, 48)$$,
  null, 'Page stage authorization must last 1 to 336 hours',
  'a start authorization is bounded to 14 days');
select extensions.throws_ok($$select public.start_cpsc_page_stage('bad caps', 1, 11, 4, 48)$$,
  '23514', null, 'per-cycle pages are bounded by the worker maximum');
select pg_temp.done();

-- ===========================================================================
-- Valid operator start; backstops in the claim itself.
-- ===========================================================================
select set_config('p1632.v1_before', pg_temp.v1_fp(), true);
select pg_temp.act('authenticated', '901');
select extensions.is(public.start_cpsc_page_stage('pgTAP bounded start', 24, 2, 3, 48)->>'state',
  'running', 'an authenticated operator starts the page stage');
select extensions.ok((public.get_cpsc_page_stage_status()->'queue'->>'eligibleDue')::integer >= 5,
  'the operator status read model reports the eligible queue');
select pg_temp.done();
select extensions.ok((select actor_user_id = pg_temp.id('901') and actor_kind = 'operator'
  from private.cpsc_page_stage_control_events order by event_seq desc limit 1),
  'the start is attributed to the authenticated operator');
select extensions.is(pg_temp.claim(10), array['29320', '29321'],
  'a running stage admits at most two concurrent claims, in natural order');
select extensions.is(pg_temp.claim(10), '{}'::text[],
  'an overlapping invocation cannot exceed global concurrency');
select pg_temp.finish('29321', 'budget_deferred', 'cycle_deadline');
select extensions.is(pg_temp.claim(10), array['29322'],
  'a released lane admits exactly one more claim');
select pg_temp.finish('29320', 'budget_deferred', 'cycle_deadline');
select pg_temp.finish('29322', 'budget_deferred', 'cycle_deadline');
select extensions.is(pg_temp.claim(10), '{}'::text[],
  'the hourly claim cap is enforced by the database');
select extensions.ok('hourly_cap_reached' = any(pg_temp.blockers()),
  'policy reports the hourly cap');

-- Lease expiry: an abandoned claim is recoverable and its attempt is kept.
select pg_temp.act('authenticated', '901');
select public.start_cpsc_page_stage('pgTAP larger caps', 24, 2, 20, 48);
select pg_temp.done();
update private.cpsc_page_work_state set next_attempt_at = '-infinity'
  where identity_id in (select id from private.cpsc_source_identities
    where official_recall_number in ('29320', '29321', '29322'));
set local role cpsc_page_worker;
select set_config('p1632.expired_claim', (select claim_id::text
  from public.claim_cpsc_page_evidence(1)), true);
reset role;
set local role postgres;
update private.cpsc_page_work_state set claim_expires_at = now() - interval '1 second'
  where claim_id = current_setting('p1632.expired_claim')::uuid;
select extensions.is(cardinality(pg_temp.claim(2)), 2,
  'an expired lease frees its lane for new claims');
select extensions.is((select outcome from private.cpsc_page_attempts
  where id = current_setting('p1632.expired_claim')::uuid), 'claimed',
  'the expired attempt is preserved as history');
select extensions.throws_ok($$select * from public.claim_cpsc_page_evidence(1)$$, '42501', null,
  'the database owner cannot claim as a worker');
select extensions.is((select (private.cpsc_page_stage_status(now())->'leases'->>'orphanedClaimedAttempts')::integer),
  1, 'status reports the orphaned expired attempt');
select extensions.is(pg_temp.finish_active('budget_deferred', 'cycle_deadline'), 2,
  'both live claims terminalize');

-- ===========================================================================
-- Kill switch: a stop blocks new claims but never discards in-flight evidence.
-- ===========================================================================
update private.cpsc_page_work_state set next_attempt_at = '-infinity'
  where identity_id = current_setting('p1632.r')::uuid;
set local role cpsc_page_worker;
select set_config('p1632.inflight', (select claim_id::text
  from public.claim_cpsc_page_evidence(1)), true);
reset role;
set local role postgres;
select extensions.is((select identity_id from private.cpsc_page_attempts
  where id = current_setting('p1632.inflight')::uuid), current_setting('p1632.r')::uuid,
  'the in-flight claim belongs to the 29320 fixture');
select pg_temp.act('authenticated', '901');
select extensions.is(public.stop_cpsc_page_stage('pgTAP kill switch')->>'state', 'stopped',
  'the operator stops the page stage');
select pg_temp.done();
select extensions.is(pg_temp.claim(10), '{}'::text[], 'a stopped stage admits no new claim');
create function pg_temp.raw() returns bytea language sql immutable as $$
  select convert_to('<html><body>Phase 16.32 in-flight transport</body></html>', 'UTF8');
$$;
set local role cpsc_page_worker;
select extensions.ok((public.retain_cpsc_page_transport(current_setting('p1632.inflight')::uuid,
  jsonb_build_object('canonicalUrl', 'https://www.cpsc.gov/Recalls/2026/P1632-29320',
    'finalUrl', 'https://www.cpsc.gov/Recalls/2026/P1632-29320', 'httpStatus', 200,
    'fetchedAt', now(), 'rawPageHash', encode(extensions.digest(pg_temp.raw(), 'sha256'), 'hex'),
    'contentType', 'text/html; charset=utf-8', 'etag', null, 'lastModified', null,
    'redirectChain', '[]'::jsonb), pg_temp.raw())->>'byteLength')::integer > 0,
  'an in-flight claim still retains its transport after the stop');
select extensions.is(public.finish_cpsc_page_attempt(current_setting('p1632.inflight')::uuid,
  'unresolved_structure', 200, 'https://www.cpsc.gov/Recalls/2026/P1632-29320',
  encode(extensions.digest(pg_temp.raw(), 'sha256'), 'hex'), 'extractor_rejected')->>'outcome',
  'unresolved_structure', 'an in-flight claim still terminalizes after the stop');
reset role;
set local role postgres;
select extensions.ok((select raw_payload_sha256 is not null and outcome = 'unresolved_structure'
  from private.cpsc_page_attempts where id = current_setting('p1632.inflight')::uuid),
  'the retained in-flight bytes stay bound to their attempt');
select extensions.ok(not exists (select 1 from pg_proc p where p.proname in
  ('retain_cpsc_page_transport', 'commit_cpsc_page_evidence_verified',
   'commit_cpsc_page_evidence', 'finish_cpsc_page_attempt')
  and p.prosrc ilike '%page_stage%'),
  'retain, commit and finish never consult the kill switch');

-- Owner emergency stop, and revocation stopping a running stage.
select pg_temp.act('authenticated', '905');
select public.start_cpsc_page_stage('pgTAP operator two', 24, 2, 20, 48);
select pg_temp.done();
select extensions.is(private.stop_cpsc_page_stage_as_owner('pgTAP emergency')->>'state',
  'stopped', 'the database owner can always stop');
select extensions.ok((select actor_kind = 'database_owner' and actor_user_id is null
  from private.cpsc_page_stage_control_events order by event_seq desc limit 1),
  'the emergency stop is attributed to the database owner, not a person');
select pg_temp.act('authenticated', '905');
select public.start_cpsc_page_stage('pgTAP operator two again', 24, 2, 20, 48);
select pg_temp.done();
select extensions.ok((private.cpsc_page_stage_control_state(now())->>'running')::boolean,
  'the second operator runs the stage');
select extensions.is(private.cpsc_page_stage_control_state(now() + interval '25 hours')->>'state',
  'expired', 'a start authorization expires fail-closed');
update private.cpsc_admin_capabilities set revoked_at = now()
  where user_id = pg_temp.id('905') and capability = 'operational_scheduler_control';
select extensions.is(private.cpsc_page_stage_control_state(now())->>'state',
  'operator_not_authorized', 'revoking the operator stops the stage');
select extensions.is(pg_temp.claim(10), '{}'::text[], 'a revoked operator''s start admits nothing');
insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason)
values (pg_temp.id('905'), 'operational_scheduler_control', now() + interval '1 second',
  'pgTAP re-grant');
select extensions.is(private.cpsc_page_stage_control_state(now() + interval '2 seconds')->>'state',
  'operator_not_authorized', 'a re-grant never revives an earlier start');

-- ===========================================================================
-- Authorization history is append-only and audited.
-- ===========================================================================
select extensions.throws_ok(format($$update private.cpsc_admin_capabilities set revoked_at = null
  where user_id = %L and revoked_at is not null$$, pg_temp.id('905')), '42501', null,
  'a revocation cannot be undone');
select extensions.throws_ok(format($$update private.cpsc_admin_capabilities
  set authorized_at = now() - interval '10 years' where user_id = %L and revoked_at is null$$,
  pg_temp.id('901')), '42501', null, 'a grant window cannot be widened retroactively');
select extensions.throws_ok(format($$update private.cpsc_admin_capabilities
  set capability = 'identity_reconciliation' where user_id = %L$$, pg_temp.id('901')),
  '42501', null, 'a grant cannot be converted into another capability');
select extensions.throws_ok(format($$delete from private.cpsc_admin_capabilities where user_id = %L$$,
  pg_temp.id('901')), '42501', null, 'a capability grant cannot be deleted');
select extensions.throws_ok(format($$delete from private.cpsc_reviewer_authorizations
  where user_id = %L$$, pg_temp.id('903')), '42501', null,
  'a reviewer authorization cannot be deleted');
select extensions.throws_ok($$truncate private.cpsc_admin_capabilities cascade$$, '42501', null,
  'capability grants cannot be truncated');
select extensions.throws_ok(format($$update private.cpsc_reviewer_authorizations
  set revoked_at = authorized_at - interval '1 day' where user_id = %L$$, pg_temp.id('903')),
  '42501', null, 'a revocation cannot precede its grant');
select extensions.is((select count(*) from private.cpsc_authorization_audit
  where user_id in (pg_temp.id('901'), pg_temp.id('902'), pg_temp.id('903'), pg_temp.id('905'))),
  6::bigint, 'every grant, revocation and re-grant is audited');
select extensions.ok((select operation = 'UPDATE' and revoked_at = now()
    and actor_current_user = 'postgres'
  from private.cpsc_authorization_audit where user_id = pg_temp.id('905')
    and operation = 'UPDATE'), 'the revocation audit records the acting database role');
select extensions.throws_ok($$update private.cpsc_authorization_audit set reason = 'rewritten'$$,
  null, null, 'the authorization audit is append-only');

-- ===========================================================================
-- Scheduling policy: CPSC health through the real v1 recorder only.
-- ===========================================================================
select pg_temp.act('authenticated', '901');
select public.start_cpsc_page_stage('pgTAP policy', 24, 2, 20, 48);
select pg_temp.done();
select extensions.ok('source_health_unknown' = any(pg_temp.blockers()),
  'no recorded CPSC health is not healthy');
select pg_temp.act('service_role');
select public.record_recall_source_sync_result('cpsc', 'failed', null, 'source_http_502',
  '{"fetched":0}'::jsonb, now());
select pg_temp.done();
select set_config('p1632.v1_before', pg_temp.v1_fp(), true);
select extensions.ok('source_unhealthy' = any(pg_temp.blockers()),
  'an upstream 502 recorded by v1 pauses the page stage');
select extensions.is(private.cpsc_page_stage_tick()->>'decision', 'skipped',
  'the tick does not start a batch against an unhealthy CPSC source');
select extensions.ok((select 'source_unhealthy' = any(blockers) and request_id is null
  from private.cpsc_page_stage_ticks order by tick_seq desc limit 1),
  'the skipped tick is durably recorded with its reason and no request');
select pg_temp.act('service_role');
select public.record_recall_source_sync_result('cpsc', 'success', null, null,
  '{"fetched":0}'::jsonb, now());
select pg_temp.done();
select extensions.ok(not (pg_temp.blockers() && array['source_health_unknown',
  'source_unhealthy', 'source_health_stale']), 'a later v1 success automatically clears the pause');
select extensions.ok('source_health_stale' = any(pg_temp.blockers(now() + interval '8 hours')),
  'health older than seven hours is stale and pauses the stage');
select pg_temp.act('service_role');
select extensions.is((select claim_status from public.claim_recall_automation_run('manual', true)),
  'claimed', 'a v1 verification run takes the v1 lease');
select pg_temp.done();
select extensions.ok('v1_run_active' = any(pg_temp.blockers()),
  'the page stage never starts while a v1 run holds its lease');
select set_config('p1632.v1_before', pg_temp.v1_fp(), true);
delete from private.recall_automation_lease;
select set_config('p1632.v1_before', pg_temp.v1_fp(), true);

-- Page-level circuit breakers.
update private.cpsc_page_work_state set next_attempt_at = '-infinity'
  where identity_id in (select id from private.cpsc_source_identities
    where official_recall_number in ('29323', '29324'));
update private.cpsc_page_work_state set next_attempt_at = now() + interval '1 day'
  where identity_id in (select id from private.cpsc_source_identities
    where official_recall_number in ('29320', '29321', '29322'));
select extensions.is(pg_temp.claim(2), array['29323', '29324'], 'healthy policy admits claims');
select extensions.is(pg_temp.finish_active('temporary_failure', 'http_5xx'), 2,
  'both claims end as upstream 5xx failures');
select extensions.ok('upstream_failures' = any(pg_temp.blockers()),
  'two upstream 5xx page failures in an hour pause the stage');
select extensions.ok(not ('upstream_failures' = any(pg_temp.blockers(now() + interval '61 minutes'))),
  'the upstream pause clears automatically after its window');
insert into private.cpsc_page_attempts (identity_id, claimed_at, completed_at, outcome, error_code)
select id, now() - interval '2 hours', now() - interval '2 hours', 'temporary_failure', 'http_429'
from private.cpsc_source_identities where official_recall_number = '29324';
select extensions.ok('upstream_rate_limited' = any(pg_temp.blockers(now() + interval '3 hours')),
  'an upstream 429 pauses the stage for six hours');
insert into private.cpsc_page_attempts (identity_id, claimed_at, completed_at, outcome, error_code)
select id, now() - interval '3 hours', now() - interval '3 hours', 'evidence_rejected',
  'semantic_commit_rejected'
from private.cpsc_source_identities where official_recall_number in ('29321', '29322');
select extensions.ok(not ('defect_circuit_open' = any(pg_temp.blockers())),
  'defects before the current start do not trip the defect circuit');
insert into private.cpsc_page_attempts (identity_id, claimed_at, completed_at, outcome, error_code)
select id, now(), now(), 'internal_failure', 'worker_exception'
from private.cpsc_source_identities where official_recall_number in ('29321', '29322');
select extensions.ok('defect_circuit_open' = any(pg_temp.blockers()),
  'two defects after the start open a circuit that needs an operator restart');

-- ===========================================================================
-- Tick and credential custody. Phase 16.33: no static key exists; the queued
-- request carries a single-use ticket whose hash alone is stored.
-- ===========================================================================
delete from private.cpsc_page_attempts where error_code in ('http_429', 'http_5xx',
  'worker_exception', 'semantic_commit_rejected') and raw_payload_sha256 is null
  and revision_id is null and identity_id in (select id from private.cpsc_source_identities
    where official_recall_number like '2932%');
select extensions.is(pg_temp.blockers() && array['upstream_failures', 'upstream_rate_limited',
  'defect_circuit_open'], false, 'circuit fixtures removed');
select set_config('p1632.queue_before', (select count(*)::text from net.http_request_queue), true);
select extensions.is(private.cpsc_page_stage_tick()->'blockers',
  '["invocation_endpoint_unavailable"]'::jsonb,
  'without the Vault endpoint the tick skips instead of calling');
select extensions.throws_ok($$select private.install_cpsc_page_stage_cron()$$, null,
  'required CPSC page worker Vault endpoint is unavailable',
  'the Cron job cannot be installed without the Vault endpoint');
select vault.create_secret('http://kong:8000/functions/v1/process-cpsc-page-evidence',
  'cpsc_page_worker_url', 'pgTAP');
select vault.create_secret('pgtap-publishable-key', 'cpsc_page_worker_apikey', 'pgTAP');
select extensions.is(private.cpsc_page_stage_tick()->>'decision', 'dispatched',
  'a healthy running stage dispatches one bounded worker request');
select extensions.ok((select convert_from(q.body, 'UTF8') = '{}'
    and q.headers->>'x-cpsc-page-ticket' ~ '^[0-9a-f]{64}$'
    and not q.headers ? 'x-cpsc-page-worker-key'
    and k.parameters = '{"maxPages": 2, "timeBudgetMs": 20000}'::jsonb
    and k.ticket_sha256 = private.scheduler_ticket_hash(q.headers->>'x-cpsc-page-ticket')
  from private.cpsc_page_stage_ticks t join net.http_request_queue q on q.id = t.request_id
  join private.scheduler_invocation_tickets k on k.request_id = t.request_id
  where t.tick_seq = (select max(tick_seq) from private.cpsc_page_stage_ticks)),
  'the request carries only a single-use ticket; its bounds live in the database');
select extensions.ok(not exists (select 1 from private.cpsc_page_stage_ticks t
    join net.http_request_queue q on q.id = t.request_id
  where to_jsonb(t)::text like '%' || (q.headers->>'x-cpsc-page-ticket') || '%'
    or to_jsonb(t)::text like '%pgtap-publishable-key%')
  and not exists (select 1 from private.scheduler_invocation_tickets k
    join net.http_request_queue q on q.id = k.request_id
  where to_jsonb(k)::text like '%' || (q.headers->>'x-cpsc-page-ticket') || '%'),
  'the durable tick and ticket records hold no ticket or key');
select vault.update_secret(id, 'https://attacker.example/functions/v1/process-cpsc-page-evidence')
from vault.secrets where name = 'cpsc_page_worker_url';
select extensions.is(private.cpsc_page_stage_tick()->'blockers',
  '["invocation_endpoint_unavailable"]'::jsonb,
  'a tampered Vault URL never receives a ticket');
select vault.update_secret(id, 'http://kong:8000/functions/v1/process-cpsc-page-evidence')
from vault.secrets where name = 'cpsc_page_worker_url';

-- A secret API key in place of the publishable key is refused.
select vault.update_secret(id, 'sb_secret_pgtap') from vault.secrets
where name = 'cpsc_page_worker_apikey';
select extensions.is(private.cpsc_page_stage_tick()->'blockers',
  '["invocation_endpoint_unavailable"]'::jsonb,
  'a secret API key is never sent through the queue');
select vault.update_secret(id, 'pgtap-publishable-key') from vault.secrets
where name = 'cpsc_page_worker_apikey';

-- ===========================================================================
-- Cron installation: inactive, credential-free, isolated from v1.
-- ===========================================================================
select vault.create_secret('http://kong:8000/functions/v1/run-recall-automation',
  'recall_automation_url', 'pgTAP');
select vault.create_secret('pgtap-automation-key', 'recall_automation_key', 'pgTAP');
select private.install_recall_automation_cron();
select set_config('p1632.v1_before', pg_temp.v1_fp(), true);
select set_config('p1632.job', private.install_cpsc_page_stage_cron()::text, true);
select extensions.ok((select not active and schedule = '47 * * * *'
    and command = 'select private.cpsc_page_stage_tick();'
  from cron.job where jobid = current_setting('p1632.job')::bigint),
  'the page Cron job installs inactive with a credential-free command');
select extensions.ok((select command not like '%' || repeat('cd', 32) || '%'
    and command not like '%http%' and command not like '%vault%'
  from cron.job where jobid = current_setting('p1632.job')::bigint),
  'the Cron command contains no key, URL or Vault reference');
select private.install_cpsc_page_stage_cron();
select extensions.is((select count(*) from cron.job where jobname = 'cpsc-page-evidence-shadow'),
  1::bigint, 'reinstalling keeps exactly one page job');
select private.set_cpsc_page_stage_cron_active(true);
select extensions.ok((select active from cron.job where jobname = 'cpsc-page-evidence-shadow'),
  'the owner can activate the page job');
select private.set_cpsc_page_stage_cron_active(false);
select extensions.is(private.uninstall_cpsc_page_stage_cron(), 1, 'the page job uninstalls');
select extensions.is(pg_temp.v1_fp(), current_setting('p1632.v1_before'),
  'installing, toggling and removing the page job leaves v1 state and its job unchanged');

-- ===========================================================================
-- v1 isolation across every page-stage operation.
-- ===========================================================================
select set_config('p1632.v1_before', pg_temp.v1_fp(), true);
select pg_temp.act('authenticated', '901');
select public.start_cpsc_page_stage('pgTAP isolation', 24, 2, 20, 48);
select public.get_cpsc_page_stage_status();
select pg_temp.done();
select private.cpsc_page_stage_tick();
select private.cpsc_page_stage_policy(now());
select private.cpsc_page_stage_status(now());
select pg_temp.claim(1);
select private.stop_cpsc_page_stage_as_owner('pgTAP isolation stop');
select extensions.is(pg_temp.v1_fp(), current_setting('p1632.v1_before'),
  'start, stop, claim, tick, policy and status never change v1 state');
select extensions.ok(not exists (select 1 from pg_proc p where p.proname in
  ('cpsc_page_stage_policy', 'cpsc_page_stage_tick', 'cpsc_page_stage_status',
   'cpsc_page_stage_control_state', 'claim_cpsc_page_evidence', 'start_cpsc_page_stage',
   'stop_cpsc_page_stage', 'stop_cpsc_page_stage_as_owner')
  and p.prosrc ~* '(insert into|update|delete from)\s+(private\.recall_|public\.recall_|public\.alerts|private\.push)'),
  'no page-stage function writes v1 recall, alert or push state');

-- ===========================================================================
-- Identity redirects: clearing a hold does not solve a live redirect.
-- ===========================================================================
select pg_temp.act('authenticated', '901');
select public.start_cpsc_page_stage('pgTAP redirect', 24, 2, 20, 48);
select pg_temp.done();
update private.cpsc_page_work_state set claim_id = null, claim_expires_at = null
  where claim_id is not null;
update private.cpsc_page_work_state set next_attempt_at = '-infinity'
  where identity_id = current_setting('p1632.r')::uuid;
select extensions.is(pg_temp.claim(1), array['29320'], 'the redirect fixture is claimed');
select pg_temp.finish('29320', 'identity_redirect', 'final_url_mismatch',
  'https://www.cpsc.gov/Recalls/2026/P1632-29320-Moved');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1632.r')::uuid),
  array['human_reconciliation_required'], 'a live redirect creates a page hold');
select pg_temp.act('authenticated', '902');
select public.resolve_cpsc_page_identity_hold(h.id, 'clear_page_hold', 'pgTAP clearance')
from private.cpsc_page_identity_holds h where h.identity_id = current_setting('p1632.r')::uuid;
select pg_temp.done();
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1632.r')::uuid),
  '{}'::text[], 'an authorized clearance makes the identity eligible again');
update private.cpsc_page_work_state set next_attempt_at = '-infinity'
  where identity_id = current_setting('p1632.r')::uuid;
select extensions.is(pg_temp.claim(1), array['29320'], 'the cleared identity is claimed again');
select pg_temp.finish('29320', 'identity_redirect', 'final_url_mismatch',
  'https://www.cpsc.gov/Recalls/2026/P1632-29320-Moved');
select extensions.is((select count(*) from private.cpsc_page_identity_holds
  where identity_id = current_setting('p1632.r')::uuid), 2::bigint,
  'the same redirect reappears as a new hold after clearance');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1632.r')::uuid),
  array['human_reconciliation_required'], 'the redirected identity is held again');
select extensions.is((select canonical_url from private.cpsc_source_identities
  where id = current_setting('p1632.r')::uuid), 'https://www.cpsc.gov/Recalls/2026/P1632-29320',
  'no clearance substitutes the destination URL for the identity URL');
select extensions.ok(not exists (select 1 from pg_proc p
  where p.proname = 'resolve_cpsc_page_identity_hold'
    and pg_get_function_arguments(p.oid) ilike '%url%'),
  'the hold decision accepts no URL argument');

-- ===========================================================================
-- Criterion review context: reviewer only, discloses conjunct provenance
-- and page text outside the coverage census. Nothing is reviewed here.
-- ===========================================================================
insert into public.recall_scopes (id, recall_notice_id, product_name)
select pg_temp.id('601'), canonical_notice_id, 'P1632 grills'
from private.cpsc_source_identities where official_recall_number = '29321';
insert into private.cpsc_page_revisions (id, identity_id, evidence_hash, recall_number,
  canonical_url, title, section_hashes, normalized_evidence, parser_version, first_seen_at,
  last_seen_at, table_identities)
select pg_temp.id('602'), i.id, repeat('e', 64), '29321', i.canonical_url, 'P1632 grills', '{}',
  jsonb_build_object('recallNumber', '29321', 'canonicalUrl', i.canonical_url,
    'title', 'P1632 grills',
    'tables', jsonb_build_array(jsonb_build_array(jsonb_build_array('Model Description', 'Model No.'),
      jsonb_build_array('Grill Black', '25302145'))),
    'recallDetails', jsonb_build_object('description', 'Only grills with date codes 2510 are included.',
      'remedy', 'Repair kit; a label is affixed after repair.',
      'sold at', 'Stores from October 2025 through June 2026.')),
  'phase-16.13-structured-v2', now() - interval '1 hour', now() - interval '1 hour', '[]'
from private.cpsc_source_identities i where i.official_recall_number = '29321';
select pg_temp.act('service_role');
select set_config('p1632.model', (public.propose_cpsc_candidate_criterion(pg_temp.id('602'),
  pg_temp.id('601'), jsonb_build_object('source', 'cpsc', 'recallNumber', '29321',
    'canonicalUrl', 'https://www.cpsc.gov/Recalls/2026/P1632-29321',
    'sourceSemanticRevision', repeat('e', 64), 'sectionIdentity', 'description',
    'tableIdentity', 'description/table/0/' || repeat('1', 64), 'rowIdentity', repeat('2', 64),
    'fieldIdentity', 'model no'), repeat('3', 64), 'model_exact', '"25302145"',
  'description/table/0/' || repeat('1', 64) || '/' || repeat('2', 64),
  'Grill Black | 25302145', 'phase-16.13-structured-v2')->>'candidateId'), true);
select public.propose_cpsc_candidate_criterion(pg_temp.id('602'),
  pg_temp.id('601'), jsonb_build_object('source', 'cpsc', 'recallNumber', '29321',
    'canonicalUrl', 'https://www.cpsc.gov/Recalls/2026/P1632-29321',
    'sourceSemanticRevision', repeat('e', 64), 'sectionIdentity', 'description',
    'tableIdentity', 'description/table/0/' || repeat('1', 64), 'rowIdentity', repeat('2', 64),
    'fieldIdentity', 'date codes'), repeat('3', 64), 'date_code_set', '["2510"]',
  'description/table/0/' || repeat('1', 64) || '/' || repeat('2', 64),
  'Only grills with date codes 2510 are included.', 'phase-16.13-structured-v2');
select pg_temp.done();
select pg_temp.act('authenticated', '902');
select extensions.throws_ok(format($$select public.get_cpsc_candidate_review_context(%L)$$,
  current_setting('p1632.model')), '42501', null,
  'an identity reconciler cannot read criterion review context');
select pg_temp.act('authenticated', '903');
select set_config('p1632.context', public.get_cpsc_candidate_review_context(
  current_setting('p1632.model')::uuid)::text, true);
select pg_temp.done();
select extensions.is((select jsonb_object_agg(value->>'kind', value->>'sourceKind')
  from jsonb_array_elements(current_setting('p1632.context')::jsonb->'conjunctSources')),
  '{"model_exact":"table_cell","date_code_set":"governing_prose"}'::jsonb,
  'the model is a table cell; the date-code restriction is governing prose, not a row cell');
select extensions.is((select jsonb_agg(value->>'section' order by value->>'section')
  from jsonb_array_elements(current_setting('p1632.context')::jsonb->'sectionsOutsideCoverage')),
  '["remedy", "sold at"]'::jsonb, 'recall-detail text outside the census is shown to the reviewer');
select extensions.ok((current_setting('p1632.context')::jsonb->>'reviewStatus') = 'unreviewed'
  and not (current_setting('p1632.context')::jsonb #>> '{servingState,envelopeServed}')::boolean,
  'the context leaves the candidate unreviewed and nothing served');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger), 0::bigint,
  'reading review context records no decision');

select * from extensions.finish();
rollback;
