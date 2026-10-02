-- Phase 16.32 is a local candidate. Do not apply in production, deploy,
-- install a Cron job, or schedule page evidence without a separately
-- authorized installation phase. This migration is additive and forward-only:
--   1. a separate operational_scheduler_control capability, with guarded,
--      audited grants and one-way revocations for every human capability;
--   2. an append-only page-stage control log that defaults to STOPPED;
--   3. a claim-level kill switch plus hard backstops for every caller;
--   4. a Cron tick that applies source-health, circuit-breaker and v1
--      isolation policy and keeps the invocation credential in Vault;
--   5. owner-only, inactive-by-default Cron management;
--   6. read models for operators and criterion reviewers.
-- Nothing here writes v1 state, activates v2, grants a capability, resolves
-- a hold, reviews a candidate, or creates a Cron job.
begin;

-- ===========================================================================
-- 1. Human capabilities. Scheduler control is its own capability; nothing
-- inherits it. Grants stay owner-only; history can no longer be rewritten.
-- ===========================================================================
alter table private.cpsc_admin_capabilities
  drop constraint cpsc_admin_capabilities_capability_check;
alter table private.cpsc_admin_capabilities
  add constraint cpsc_admin_capabilities_capability_check check (capability in
    ('identity_reconciliation', 'decision_invalidation', 'operational_scheduler_control'));
-- A revoked grant is kept as history. A later re-grant is a new row, so the
-- old authorization window can never be widened retroactively.
alter table private.cpsc_admin_capabilities
  drop constraint cpsc_admin_capabilities_user_id_capability_key;
create unique index cpsc_admin_capabilities_one_open_grant_idx
  on private.cpsc_admin_capabilities(user_id, capability) where revoked_at is null;

create table private.cpsc_authorization_audit (
  audit_seq bigint generated always as identity primary key,
  table_name text not null check (table_name in
    ('cpsc_admin_capabilities', 'cpsc_reviewer_authorizations')),
  operation text not null check (operation in ('INSERT', 'UPDATE')),
  user_id uuid not null,
  capability text not null,
  authorized_by uuid,
  authorized_at timestamptz not null,
  revoked_at timestamptz,
  reason text not null,
  actor_session_user text not null,
  actor_current_user text not null,
  actor_auth_uid uuid,
  recorded_at timestamptz not null default now()
);
alter table private.cpsc_authorization_audit enable row level security;
create trigger cpsc_authorization_audit_append_only
  before update or delete on private.cpsc_authorization_audit
  for each row execute function private.cpsc_append_only();
create trigger cpsc_authorization_audit_no_truncate
  before truncate on private.cpsc_authorization_audit
  for each statement execute function private.cpsc_append_only();

-- Grants are inserted; the only permitted change is a one-way revocation.
-- Deleting, un-revoking, or rewriting who/what/when is rejected.
create function private.cpsc_guard_authorization_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'CPSC authorizations are retained for audit' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
      (to_jsonb(new) - 'revoked_at') is distinct from (to_jsonb(old) - 'revoked_at')
      or old.revoked_at is not null or new.revoked_at is null
      or new.revoked_at < new.authorized_at) then
    raise exception 'Only a one-way revocation may change a CPSC authorization'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create function private.cpsc_record_authorization_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.cpsc_authorization_audit (table_name, operation, user_id, capability,
    authorized_by, authorized_at, revoked_at, reason, actor_session_user,
    actor_current_user, actor_auth_uid)
  values (tg_table_name, tg_op, new.user_id,
    case when tg_table_name = 'cpsc_reviewer_authorizations' then 'criterion_review'
      else to_jsonb(new)->>'capability' end,
    new.authorized_by, new.authorized_at, new.revoked_at, new.reason,
    session_user, current_user, auth.uid());
  return null;
end;
$$;

create trigger cpsc_admin_capabilities_guard
  before update or delete on private.cpsc_admin_capabilities
  for each row execute function private.cpsc_guard_authorization_change();
create trigger cpsc_admin_capabilities_no_truncate
  before truncate on private.cpsc_admin_capabilities
  for each statement execute function private.cpsc_guard_authorization_change();
create trigger cpsc_admin_capabilities_audit
  after insert or update on private.cpsc_admin_capabilities
  for each row execute function private.cpsc_record_authorization_audit();
create trigger cpsc_reviewer_authorizations_guard
  before update or delete on private.cpsc_reviewer_authorizations
  for each row execute function private.cpsc_guard_authorization_change();
create trigger cpsc_reviewer_authorizations_no_truncate
  before truncate on private.cpsc_reviewer_authorizations
  for each statement execute function private.cpsc_guard_authorization_change();
create trigger cpsc_reviewer_authorizations_audit
  after insert or update on private.cpsc_reviewer_authorizations
  for each row execute function private.cpsc_record_authorization_audit();

-- ===========================================================================
-- 2. Page-stage control. The current state is the latest event; no event
-- means STOPPED. Only an authenticated operator can start. The operator or
-- the database owner can stop. service_role, the worker, a parser, or a
-- model cannot write an event.
-- ===========================================================================
create table private.cpsc_page_stage_control_events (
  id uuid primary key default gen_random_uuid(),
  event_seq bigint generated always as identity unique,
  action text not null check (action in ('start', 'stop')),
  actor_kind text not null check (actor_kind in ('operator', 'database_owner')),
  actor_user_id uuid references auth.users(id) on delete restrict,
  reason text not null check (btrim(reason) <> '' and length(reason) <= 2000),
  valid_until timestamptz,
  max_pages_per_cycle integer check (max_pages_per_cycle between 1 and 10),
  max_claims_per_hour integer check (max_claims_per_hour between 1 and 60),
  max_claims_per_day integer check (max_claims_per_day between 1 and 1000),
  recorded_at timestamptz not null default now(),
  check ((action = 'start') = (valid_until is not null and max_pages_per_cycle is not null
    and max_claims_per_hour is not null and max_claims_per_day is not null)),
  check (action = 'stop' or actor_kind = 'operator'),
  check ((actor_kind = 'operator') = (actor_user_id is not null))
);
alter table private.cpsc_page_stage_control_events enable row level security;
create trigger cpsc_page_stage_control_append_only
  before update or delete on private.cpsc_page_stage_control_events
  for each row execute function private.cpsc_append_only();
create trigger cpsc_page_stage_control_no_truncate
  before truncate on private.cpsc_page_stage_control_events
  for each statement execute function private.cpsc_append_only();

create function private.cpsc_guard_page_stage_control_event()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.actor_kind = 'operator' then
    if not private.cpsc_has_capability('operational_scheduler_control')
      or auth.uid() is distinct from new.actor_user_id then
      raise exception 'CPSC operational scheduler authorization required' using errcode = '42501';
    end if;
  elsif new.action <> 'stop'
    or coalesce(auth.role(), '') in ('anon', 'authenticated', 'service_role')
    or session_user = 'cpsc_page_worker'
    or coalesce(current_setting('role', true), '') = 'cpsc_page_worker' then
    raise exception 'Only the database owner may record an emergency stop' using errcode = '42501';
  end if;
  if new.action = 'start' and (new.valid_until <= now()
      or new.valid_until > now() + interval '14 days') then
    raise exception 'Page stage authorization must expire within 14 days';
  end if;
  new.recorded_at := now();
  return new;
end;
$$;
create trigger cpsc_guard_page_stage_control_event
  before insert on private.cpsc_page_stage_control_events
  for each row execute function private.cpsc_guard_page_stage_control_event();

-- Running only while the latest event is an unexpired start by an operator
-- whose one continuous grant covers both the start and now. A revocation
-- stops the stage; a later re-grant never revives an earlier start.
create function private.cpsc_page_stage_control_state(p_now timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case
    when e.id is null then jsonb_build_object('running', false, 'state', 'never_started')
    when e.action = 'stop' then jsonb_build_object('running', false, 'state', 'stopped',
      'eventId', e.id, 'recordedAt', e.recorded_at, 'actorKind', e.actor_kind)
    when e.valid_until <= p_now then jsonb_build_object('running', false, 'state', 'expired',
      'eventId', e.id, 'validUntil', e.valid_until)
    when not exists (select 1 from private.cpsc_admin_capabilities c
        where c.user_id = e.actor_user_id and c.capability = 'operational_scheduler_control'
          and c.authorized_at <= e.recorded_at
          and (c.revoked_at is null or c.revoked_at > greatest(p_now, e.recorded_at)))
      then jsonb_build_object('running', false, 'state', 'operator_not_authorized',
        'eventId', e.id)
    else jsonb_build_object('running', true, 'state', 'running', 'eventId', e.id,
      'startedAt', e.recorded_at, 'validUntil', e.valid_until,
      'maxPagesPerCycle', e.max_pages_per_cycle, 'maxClaimsPerHour', e.max_claims_per_hour,
      'maxClaimsPerDay', e.max_claims_per_day) end
  from (select 1) one
  left join lateral (select * from private.cpsc_page_stage_control_events
    order by event_seq desc limit 1) e on true;
$$;

create function public.start_cpsc_page_stage(p_reason text, p_valid_for_hours integer,
  p_max_pages_per_cycle integer, p_max_claims_per_hour integer, p_max_claims_per_day integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not private.cpsc_has_capability('operational_scheduler_control') then
    raise exception 'CPSC operational scheduler authorization required' using errcode = '42501';
  end if;
  if p_valid_for_hours is null or p_valid_for_hours not between 1 and 336 then
    raise exception 'Page stage authorization must last 1 to 336 hours';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:page-stage-control'));
  insert into private.cpsc_page_stage_control_events (action, actor_kind, actor_user_id,
    reason, valid_until, max_pages_per_cycle, max_claims_per_hour, max_claims_per_day)
  values ('start', 'operator', auth.uid(), p_reason,
    now() + p_valid_for_hours * interval '1 hour', p_max_pages_per_cycle,
    p_max_claims_per_hour, p_max_claims_per_day)
  returning id into v_id;
  return private.cpsc_page_stage_control_state(now()) || jsonb_build_object('eventId', v_id);
end;
$$;

create function public.stop_cpsc_page_stage(p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not private.cpsc_has_capability('operational_scheduler_control') then
    raise exception 'CPSC operational scheduler authorization required' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:page-stage-control'));
  insert into private.cpsc_page_stage_control_events (action, actor_kind, actor_user_id, reason)
  values ('stop', 'operator', auth.uid(), p_reason);
  return private.cpsc_page_stage_control_state(now());
end;
$$;

-- Emergency stop for the database owner. It can only stop, never start.
create function private.stop_cpsc_page_stage_as_owner(p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:page-stage-control'));
  insert into private.cpsc_page_stage_control_events (action, actor_kind, reason)
  values ('stop', 'database_owner', p_reason);
  return private.cpsc_page_stage_control_state(now());
end;
$$;

-- ===========================================================================
-- 3. The claim consumes the kill switch and hard backstops. Eligibility,
-- ordering, leases and the returned shape are unchanged from 16.29, so the
-- deployed worker bundle is compatible. In-flight claims are not affected:
-- retain, commit and finish never read the control state.
-- ===========================================================================
create index cpsc_page_attempts_claimed_at_idx on private.cpsc_page_attempts(claimed_at);

create or replace function public.claim_cpsc_page_evidence(p_limit integer default 1)
returns table (claim_id uuid, identity_id uuid, official_recall_number text,
  canonical_url text, sole_scope_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_identity record;
  v_claim uuid;
  v_control jsonb;
  v_allowed integer;
begin
  if not private.cpsc_is_worker() then
    raise exception 'CPSC worker authorization required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 10 then
    raise exception 'Invalid page claim limit';
  end if;
  -- Serializes admission so overlapping invocations share one set of limits.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:page-claim-admission'));
  v_control := private.cpsc_page_stage_control_state(now());
  if not (v_control->>'running')::boolean then
    return;
  end if;
  v_allowed := least(p_limit,
    -- Global concurrency equals the worker's two lanes, across invocations.
    2 - (select count(*)::integer from private.cpsc_page_work_state w
      where w.claim_id is not null and w.claim_expires_at > now()),
    (v_control->>'maxClaimsPerHour')::integer - (select count(*)::integer
      from private.cpsc_page_attempts a where a.claimed_at > now() - interval '1 hour'),
    (v_control->>'maxClaimsPerDay')::integer - (select count(*)::integer
      from private.cpsc_page_attempts a where a.claimed_at > now() - interval '1 day'));
  if v_allowed < 1 then
    return;
  end if;
  for v_identity in
    select i.id, i.official_recall_number, i.canonical_url,
      (select case when count(*) = 1 then (array_agg(s.id))[1] end
       from public.recall_scopes s where s.recall_notice_id = i.canonical_notice_id)
        as sole_scope_id
    from private.cpsc_source_identities i
    left join private.cpsc_page_work_state w on w.identity_id = i.id
    where i.identity_status = 'reconciled'
      and private.cpsc_canonical_url(i.canonical_url) = i.canonical_url
      and not coalesce(w.manual_review_required, false)
      and coalesce(w.next_attempt_at, '-infinity'::timestamptz) <= now()
      and (w.claim_id is null or w.claim_expires_at <= now())
      and private.cpsc_page_identity_eligible(i.id)
    order by coalesce(w.next_attempt_at, '-infinity'::timestamptz),
      coalesce(w.last_success_at, w.last_attempt_at, i.first_seen_at),
      i.official_recall_number
    limit v_allowed for update of i skip locked
  loop
    -- The expired attempt is preserved. Only work-state claim_id changes.
    v_claim := gen_random_uuid();
    insert into private.cpsc_page_work_state
      (identity_id, claim_id, claim_expires_at, next_attempt_at, attempt_count, last_attempt_at)
      values (v_identity.id, v_claim, now() + interval '30 seconds',
        now(), 1, now())
      on conflict on constraint cpsc_page_work_state_pkey do update set
        claim_id = excluded.claim_id,
        claim_expires_at = excluded.claim_expires_at,
        attempt_count = cpsc_page_work_state.attempt_count + 1,
        last_attempt_at = excluded.last_attempt_at;
    insert into private.cpsc_page_attempts(id, identity_id, outcome)
      values (v_claim, v_identity.id, 'claimed');
    claim_id := v_claim;
    identity_id := v_identity.id;
    official_recall_number := v_identity.official_recall_number;
    canonical_url := v_identity.canonical_url;
    sole_scope_id := v_identity.sole_scope_id;
    return next;
  end loop;
end;
$$;

-- ===========================================================================
-- 4. Scheduling policy. Read-only over v1 state: it never writes source
-- health, watermarks, leases or runs. Blockers are in a stable order.
-- ===========================================================================
create function private.cpsc_page_stage_policy(p_now timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  with control as (
    select private.cpsc_page_stage_control_state(p_now) as state
  ), source as (
    select st.* from public.recall_sources s
    join private.recall_source_sync_state st on st.source_id = s.id
    where s.source_key = 'cpsc' and s.is_authoritative
  ), attempts as (
    select a.* from private.cpsc_page_attempts a
    where a.completed_at > p_now - interval '1 day'
  ), counts as (
    select
      (select count(*) from attempts where error_code = 'http_429'
        and completed_at > p_now - interval '6 hours') as rate_limited,
      (select count(*) from attempts where error_code in
        ('http_5xx', 'fetch_timeout', 'transport_failure')
        and completed_at > p_now - interval '1 hour') as upstream_failures,
      (select count(*) from attempts where outcome = 'database_timeout'
        and completed_at > p_now - interval '1 hour') as database_timeouts,
      (select count(*) from attempts, control where outcome in
        ('evidence_rejected', 'internal_failure')
        and (control.state->>'startedAt') is not null
        and completed_at >= (control.state->>'startedAt')::timestamptz) as defects,
      (select count(*) from private.cpsc_page_work_state w
        where w.claim_id is not null and w.claim_expires_at > p_now) as in_flight,
      (select count(*) from private.cpsc_page_attempts a
        where a.claimed_at > p_now - interval '1 hour') as claims_hour,
      (select count(*) from private.cpsc_page_attempts a
        where a.claimed_at > p_now - interval '1 day') as claims_day
  )
  select jsonb_build_object(
    'blockers', to_jsonb(array_remove(array[
      case when not (control.state->>'running')::boolean then 'stage_not_running' end,
      case when not exists (select 1 from source where last_attempted_at is not null)
        then 'source_health_unknown' end,
      case when exists (select 1 from source where last_status = 'failed')
        then 'source_unhealthy' end,
      case when exists (select 1 from source where last_status = 'success')
        and not exists (select 1 from source where last_status = 'success'
          and last_successful_sync_at > p_now - interval '7 hours')
        then 'source_health_stale' end,
      case when exists (select 1 from private.recall_automation_lease l
          where l.expires_at > p_now)
        then 'v1_run_active' end,
      case when counts.rate_limited > 0 then 'upstream_rate_limited' end,
      case when counts.upstream_failures >= 2 then 'upstream_failures' end,
      case when counts.database_timeouts >= 2 then 'database_pressure' end,
      case when counts.defects >= 2 then 'defect_circuit_open' end,
      case when counts.in_flight > 0 then 'claim_in_flight' end,
      case when (control.state->>'running')::boolean
        and counts.claims_hour >= (control.state->>'maxClaimsPerHour')::integer
        then 'hourly_cap_reached' end,
      case when (control.state->>'running')::boolean
        and counts.claims_day >= (control.state->>'maxClaimsPerDay')::integer
        then 'daily_cap_reached' end
    ]::text[], null)),
    'control', control.state,
    'sourceHealth', (select jsonb_build_object('lastStatus', last_status,
      'lastErrorCode', last_error_code, 'lastAttemptedAt', last_attempted_at,
      'lastSuccessfulSyncAt', last_successful_sync_at) from source),
    'counts', to_jsonb(counts))
  from control, counts;
$$;

-- ===========================================================================
-- 5. Cron tick. The only scheduled entrypoint. The job command carries no
-- credential, no URL and no parameters; Vault supplies them at dispatch.
-- ===========================================================================
create table private.cpsc_page_stage_ticks (
  tick_seq bigint generated always as identity primary key,
  ticked_at timestamptz not null default now(),
  decision text not null check (decision in ('dispatched', 'skipped')),
  blockers text[] not null default '{}',
  control_event_id uuid,
  max_pages integer check (max_pages between 1 and 10),
  request_id bigint,
  check ((decision = 'dispatched') = (request_id is not null
    and cardinality(blockers) = 0 and max_pages is not null))
);
alter table private.cpsc_page_stage_ticks enable row level security;
create trigger cpsc_page_stage_ticks_append_only
  before update or delete on private.cpsc_page_stage_ticks
  for each row execute function private.cpsc_append_only();
create trigger cpsc_page_stage_ticks_no_truncate
  before truncate on private.cpsc_page_stage_ticks
  for each statement execute function private.cpsc_append_only();

create function private.cpsc_page_stage_tick()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_policy jsonb;
  v_blockers text[];
  v_url text;
  v_key text;
  v_apikey text;
  v_request bigint;
  v_max integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:page-stage-tick'));
  v_policy := private.cpsc_page_stage_policy(now());
  select coalesce(array_agg(value), '{}') into v_blockers
    from jsonb_array_elements_text(v_policy->'blockers');
  if cardinality(v_blockers) = 0 then
    select max(decrypted_secret) filter (where name = 'cpsc_page_worker_url'),
      max(decrypted_secret) filter (where name = 'cpsc_page_worker_key'),
      max(decrypted_secret) filter (where name = 'cpsc_page_worker_apikey')
      into v_url, v_key, v_apikey
    from vault.decrypted_secrets
    where name in ('cpsc_page_worker_url', 'cpsc_page_worker_key', 'cpsc_page_worker_apikey');
    if v_url is null or v_key is null or v_apikey is null
      or v_key !~ '^[0-9a-f]{64}$'
      or v_url !~ ('^(https://[a-z0-9]{20}\.supabase\.co'
        || '|http://(kong|host\.docker\.internal|127\.0\.0\.1|localhost)(:[0-9]{1,5})?)'
        || '/functions/v1/process-cpsc-page-evidence$') then
      v_blockers := array['invocation_credential_unavailable'];
    end if;
  end if;
  if cardinality(v_blockers) > 0 then
    insert into private.cpsc_page_stage_ticks (decision, blockers, control_event_id)
    values ('skipped', v_blockers, nullif(v_policy #>> '{control,eventId}', '')::uuid);
    return jsonb_build_object('decision', 'skipped', 'blockers', to_jsonb(v_blockers));
  end if;
  v_max := (v_policy #>> '{control,maxPagesPerCycle}')::integer;
  v_request := net.http_post(
    url := v_url,
    headers := jsonb_build_object('content-type', 'application/json',
      'apikey', v_apikey, 'authorization', 'Bearer ' || v_apikey,
      'x-cpsc-page-worker-key', v_key),
    body := jsonb_build_object('maxPages', v_max, 'timeBudgetMs', 20000),
    timeout_milliseconds := 30000);
  insert into private.cpsc_page_stage_ticks (decision, control_event_id, max_pages, request_id)
  values ('dispatched', (v_policy #>> '{control,eventId}')::uuid, v_max, v_request);
  return jsonb_build_object('decision', 'dispatched', 'maxPages', v_max);
end;
$$;

-- Owner-only Cron management, mirroring the v1 pattern. Installation is
-- always inactive; activation is a separate owner action. The v1 job is
-- never read or changed by name here.
create function private.install_cpsc_page_stage_cron()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_job bigint;
begin
  if (select count(*) from vault.decrypted_secrets where name in
      ('cpsc_page_worker_url', 'cpsc_page_worker_key', 'cpsc_page_worker_apikey')) <> 3 then
    raise exception 'required CPSC page worker Vault secrets are unavailable';
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'cpsc-page-evidence-shadow';
  select cron.schedule('cpsc-page-evidence-shadow', '47 * * * *',
    'select private.cpsc_page_stage_tick();') into v_job;
  perform cron.alter_job(v_job, active := false);
  return v_job;
end;
$$;

create function private.set_cpsc_page_stage_cron_active(p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_job bigint;
begin
  if p_active is null or (select count(*) from cron.job
      where jobname = 'cpsc-page-evidence-shadow') <> 1 then
    raise exception 'exactly one CPSC page stage Cron job is required';
  end if;
  select jobid into v_job from cron.job where jobname = 'cpsc-page-evidence-shadow';
  perform cron.alter_job(v_job, active := p_active);
end;
$$;

create function private.uninstall_cpsc_page_stage_cron()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  select count(*) into v_count from cron.job where jobname = 'cpsc-page-evidence-shadow';
  perform cron.unschedule(jobid) from cron.job where jobname = 'cpsc-page-evidence-shadow';
  return v_count;
end;
$$;

-- ===========================================================================
-- 6. Read models. No credential, header, owned-product or consumer data.
-- ===========================================================================
create function private.cpsc_page_stage_status(p_now timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  with eligible as (
    select i.id, w.next_attempt_at, w.claim_id, w.claim_expires_at, i.first_seen_at
    from private.cpsc_source_identities i
    left join private.cpsc_page_work_state w on w.identity_id = i.id
    where private.cpsc_page_identity_eligible(i.id)
  ), recent as (
    select a.* from private.cpsc_page_attempts a where a.claimed_at > p_now - interval '1 day'
  )
  select jsonb_build_object(
    'generatedAt', p_now,
    'policy', private.cpsc_page_stage_policy(p_now),
    'cron', (select jsonb_build_object('installed', count(*) = 1,
        'active', coalesce(bool_and(active), false), 'schedule', max(schedule))
      from cron.job where jobname = 'cpsc-page-evidence-shadow'),
    'queue', jsonb_build_object(
      'identities', (select count(*) from private.cpsc_source_identities),
      'eligible', (select count(*) from eligible),
      'eligibleDue', (select count(*) from eligible
        where coalesce(next_attempt_at, '-infinity'::timestamptz) <= p_now
          and (claim_id is null or claim_expires_at <= p_now)),
      'oldestDueSince', (select min(coalesce(next_attempt_at, first_seen_at)) from eligible
        where coalesce(next_attempt_at, '-infinity'::timestamptz) <= p_now),
      'blockedByReason', (select coalesce(jsonb_object_agg(page_eligibility, n), '{}'::jsonb)
        from (select e.page_eligibility, count(*) n from private.cpsc_page_identity_eligibility e
          where e.page_eligibility <> 'eligible' group by 1) b)),
    'leases', jsonb_build_object(
      'active', (select count(*) from private.cpsc_page_work_state
        where claim_id is not null and claim_expires_at > p_now),
      'expiredUnreleased', (select count(*) from private.cpsc_page_work_state
        where claim_id is not null and claim_expires_at <= p_now),
      'orphanedClaimedAttempts', (select count(*) from private.cpsc_page_attempts a
        where a.outcome = 'claimed' and not exists (select 1 from private.cpsc_page_work_state w
          where w.claim_id = a.id and w.claim_expires_at > p_now))),
    'last24h', jsonb_build_object(
      'claims', (select count(*) from recent),
      'outcomes', (select coalesce(jsonb_object_agg(outcome, n), '{}'::jsonb)
        from (select outcome, count(*) n from recent group by 1) o),
      'errorCodes', (select coalesce(jsonb_object_agg(error_code, n), '{}'::jsonb)
        from (select error_code, count(*) n from recent where error_code is not null group by 1) e),
      'transportNotRetained', (select count(*) from recent where http_status = 200
        and raw_payload_sha256 is null and outcome not in ('claimed', 'identity_redirect')),
      'semanticFailures', (select count(*) from recent
        where outcome in ('unresolved_structure', 'evidence_rejected')),
      'identityRedirects', (select count(*) from recent where outcome = 'identity_redirect'),
      'ticks', (select jsonb_build_object(
          'dispatched', count(*) filter (where decision = 'dispatched'),
          'skipped', count(*) filter (where decision = 'skipped'))
        from private.cpsc_page_stage_ticks where ticked_at > p_now - interval '1 day')),
    'lastTick', (select jsonb_build_object('tickedAt', t.ticked_at, 'decision', t.decision,
        'blockers', t.blockers, 'maxPages', t.max_pages,
        'response', (select jsonb_build_object('statusCode', r.status_code,
            'timedOut', r.timed_out,
            'durationMs', round(extract(epoch from (r.created - t.ticked_at)) * 1000),
            'claimed', (r.content::jsonb)->'claimed', 'completed', (r.content::jsonb)->'completed',
            'failed', (r.content::jsonb)->'failed', 'stoppedBy', (r.content::jsonb)->'stoppedBy')
          from net._http_response r
          where r.id = t.request_id and r.content_type like 'application/json%'))
      from private.cpsc_page_stage_ticks t order by t.tick_seq desc limit 1),
    'holds', jsonb_build_object(
      'unresolved', (select count(*) from private.cpsc_page_identity_holds h
        where not exists (select 1 from private.cpsc_page_identity_hold_resolutions x
          where x.hold_id = h.id and x.decision = 'clear_page_hold'
            and private.cpsc_identity_decision_authorized(x.reviewer_user_id, x.decided_at))),
      'createdLast24h', (select count(*) from private.cpsc_page_identity_holds
        where created_at > p_now - interval '1 day')),
    'review', jsonb_build_object(
      'unreviewedCandidates', (select count(*) from private.cpsc_candidate_criteria
        where status = 'unreviewed'),
      'pendingRuleSets', (select count(distinct coalesce(conjunction_key, id::text))
        from private.cpsc_candidate_criteria where status = 'unreviewed'),
      'reviewedCriteriaOnStaleRevisions', (select count(*) from private.cpsc_candidate_criteria c
        join lateral (select l.decision from private.cpsc_candidate_review_ledger l
          where l.candidate_id = c.id order by l.event_seq desc limit 1) latest on true
        where latest.decision = 'reviewed'
          and not private.cpsc_revision_is_current(c.revision_id)),
      'usableReviewedCriteria', (select count(*) from private.cpsc_current_reviewed_criteria)));
$$;

create function public.get_cpsc_page_stage_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.cpsc_has_capability('operational_scheduler_control') then
    raise exception 'CPSC operational scheduler authorization required' using errcode = '42501';
  end if;
  return private.cpsc_page_stage_status(now());
end;
$$;

-- Criterion-review context. It adds what the 16.12 packet cannot show for a
-- legacy revision: the structural row order, the coverage ledger and its
-- limits, the source of each conjunct, and page text outside the census.
create function public.get_cpsc_candidate_review_context(p_candidate_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_candidate private.cpsc_candidate_criteria%rowtype;
  v_revision private.cpsc_page_revisions%rowtype;
  v_snapshot private.cpsc_page_structural_snapshots%rowtype;
  v_ledger private.cpsc_page_coverage_ledgers%rowtype;
begin
  if not private.cpsc_is_human_reviewer() then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  select * into v_candidate from private.cpsc_candidate_criteria where id = p_candidate_id;
  if v_candidate.id is null then return null; end if;
  select * into v_revision from private.cpsc_page_revisions where id = v_candidate.revision_id;
  select * into v_snapshot from private.cpsc_page_structural_snapshots
    where revision_id = v_revision.id order by recorded_at desc limit 1;
  select * into v_ledger from private.cpsc_page_coverage_ledgers
    where revision_id = v_revision.id order by recorded_seq desc limit 1;
  return jsonb_build_object(
    'candidateId', v_candidate.id,
    'recallNumber', v_revision.recall_number,
    'officialUrl', v_revision.canonical_url,
    'revisionId', v_revision.id,
    'sourceSemanticRevision', v_revision.evidence_hash,
    'revisionParserVersion', v_revision.parser_version,
    'revisionIsCurrent', private.cpsc_revision_is_current(v_revision.id),
    'structuralSnapshot', case when v_snapshot.revision_id is null then null
      else jsonb_build_object('parserVersion', v_snapshot.parser_version,
        'extractorVersion', v_snapshot.extractor_version,
        'censusVersion', v_snapshot.census_version,
        'tableIdentities', v_snapshot.table_identities) end,
    'coverage', case when v_ledger.id is null then null else jsonb_build_object(
      'ledgerId', v_ledger.id, 'recordedSeq', v_ledger.recorded_seq,
      'summary', v_ledger.summary, 'structures', v_ledger.ledger->'structures',
      'censusedSections', jsonb_build_array('description'),
      'limitation', 'Coverage accounts for description prose and tables only. '
        || 'Recall-detail sections below are not censused and must be read for '
        || 'restrictions before any negative conclusion.') end,
    'conjunctSources', (select coalesce(jsonb_agg(jsonb_build_object(
        'candidateId', c.id, 'kind', c.criterion_kind, 'value', c.criterion_value,
        'conjunctionGroup', c.conjunction_key,
        'fieldIdentity', c.evidence_address->>'fieldIdentity',
        'sourceKind', case when exists (
            select 1 from jsonb_array_elements_text(v_revision.normalized_evidence->'tables'
              ->(split_part(c.evidence_address->>'tableIdentity', '/', 3))::integer->0) header
            where btrim(regexp_replace(lower(header), '[^a-z0-9 ]', '', 'g'))
              = c.evidence_address->>'fieldIdentity')
          then 'table_cell' else 'governing_prose' end,
        'excerpt', c.authoritative_excerpt) order by c.conjunction_key, c.criterion_kind), '[]')
      from private.cpsc_candidate_criteria c
      where c.revision_id = v_candidate.revision_id
        and c.conjunction_key is not distinct from v_candidate.conjunction_key
        and c.evidence_address->>'tableIdentity' ~ '^description/table/[0-9]+/'),
    'sectionsOutsideCoverage', (select coalesce(jsonb_agg(jsonb_build_object(
        'section', key, 'text', value, 'censused', false) order by key), '[]')
      from jsonb_each_text(coalesce(v_revision.normalized_evidence->'recallDetails', '{}'))
      where key <> 'description'),
    'servingState', jsonb_build_object(
      'scopeId', v_candidate.proposed_scope_id,
      'envelopeServed', v_candidate.proposed_scope_id is not null
        and private.cpsc_scope_rule_set_envelope(v_candidate.proposed_scope_id) is not null),
    'reviewStatus', v_candidate.status);
end;
$$;

-- ===========================================================================
-- Privilege boundary. Nothing new is reachable by anon, service_role or the
-- page worker. Operators and criterion reviewers reach only their RPCs.
-- ===========================================================================
revoke all on private.cpsc_authorization_audit, private.cpsc_page_stage_control_events,
  private.cpsc_page_stage_ticks
  from public, anon, authenticated, service_role, cpsc_page_worker;
revoke all on function
  private.cpsc_guard_authorization_change(),
  private.cpsc_record_authorization_audit(),
  private.cpsc_guard_page_stage_control_event(),
  private.cpsc_page_stage_control_state(timestamptz),
  private.stop_cpsc_page_stage_as_owner(text),
  private.cpsc_page_stage_policy(timestamptz),
  private.cpsc_page_stage_tick(),
  private.install_cpsc_page_stage_cron(),
  private.set_cpsc_page_stage_cron_active(boolean),
  private.uninstall_cpsc_page_stage_cron(),
  private.cpsc_page_stage_status(timestamptz),
  public.start_cpsc_page_stage(text, integer, integer, integer, integer),
  public.stop_cpsc_page_stage(text),
  public.get_cpsc_page_stage_status(),
  public.get_cpsc_candidate_review_context(uuid)
  from public, anon, authenticated, service_role, cpsc_page_worker;
grant execute on function
  public.start_cpsc_page_stage(text, integer, integer, integer, integer),
  public.stop_cpsc_page_stage(text),
  public.get_cpsc_page_stage_status(),
  public.get_cpsc_candidate_review_context(uuid)
  to authenticated;
-- The replaced claim keeps its worker-only grant; restate.
revoke all on function public.claim_cpsc_page_evidence(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_cpsc_page_evidence(integer) to cpsc_page_worker;

commit;
