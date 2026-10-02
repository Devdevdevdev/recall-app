-- Phase 16.33 is a local candidate. Do not apply in production, deploy,
-- rotate a secret, or change a Cron job without a separately authorized
-- installation phase. This migration is additive and forward-only:
--   1. v1 matching: a recall with an unresolved (stale, busy or failed) pair
--      stays pending with bounded, observable retries; nothing is dropped;
--   2. scheduler invocation tickets: pg_net requests carry a single-use,
--      short-lived ticket (stored only as a hash) instead of a static key;
--   3. server-verified MFA for every capability-gated human action;
--   4. negative evidence also requires a human attestation over the
--      recall-detail sections that the coverage census does not read.
-- Nothing here grants a capability, resolves a hold, reviews a candidate,
-- creates or alters a Cron job, stores a secret, or activates v2.
begin;

-- ===========================================================================
-- 1. v1 durable matching work. The old record RPC stays for the deployed
-- function; the new one resolves recalls individually and never deletes a
-- recall whose pairs were not all resolved.
-- ===========================================================================
alter table private.recall_automation_pending_recalls
  add column unresolved_attempts integer not null default 0
    check (unresolved_attempts >= 0),
  add column last_unresolved_reason text check (last_unresolved_reason in
    ('stale', 'busy', 'failure', 'provider_failure', 'limit', 'not_reached',
     'inconsistent_summary')),
  add column last_unresolved_at timestamptz,
  add column exhausted_at timestamptz;

-- New authoritative work re-arms an exhausted or retrying recall.
create function private.recall_automation_pending_rearm()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.last_affected_at > old.last_affected_at then
    new.unresolved_attempts := 0;
    new.exhausted_at := null;
  end if;
  return new;
end;
$$;
create trigger recall_automation_pending_rearm
  before update on private.recall_automation_pending_recalls
  for each row execute function private.recall_automation_pending_rearm();

create table private.recall_automation_matching_outcomes (
  outcome_seq bigint generated always as identity primary key,
  run_id uuid not null references private.recall_automation_runs (id) on delete restrict,
  recall_notice_id uuid not null,
  outcome text not null check (outcome in ('resolved', 'retained', 'exhausted')),
  reason text check (reason in ('stale', 'busy', 'failure', 'provider_failure', 'limit',
    'not_reached', 'inconsistent_summary')),
  unresolved_attempts integer not null check (unresolved_attempts >= 0),
  recorded_at timestamptz not null default now(),
  check ((outcome = 'resolved') = (reason is null)),
  unique (run_id, recall_notice_id)
);
alter table private.recall_automation_matching_outcomes enable row level security;
create trigger recall_automation_matching_outcomes_append_only
  before update or delete on private.recall_automation_matching_outcomes
  for each row execute function private.cpsc_append_only();
create trigger recall_automation_matching_outcomes_no_truncate
  before truncate on private.recall_automation_matching_outcomes
  for each statement execute function private.cpsc_append_only();

create function public.record_recall_automation_matching_outcome(
  p_run_id uuid,
  p_lease_token uuid,
  p_resolved_recall_ids uuid[],
  p_unresolved jsonb,
  p_candidate_pairs integer,
  p_deterministic_resolved integer,
  p_confirmed integer,
  p_rejected integer,
  p_needs_review integer,
  p_ai_escalations integer,
  p_provider_failures integer,
  p_alerts_created integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Eight unresolved cycles (48 h at the 6 h cadence) before the recall is
  -- marked exhausted; an exhausted recall is still retried once per day.
  c_max_unresolved constant integer := 8;
  v_resolved uuid[] := coalesce(p_resolved_recall_ids, '{}');
  v_unresolved_ids uuid[];
  v_deleted integer;
  v_retained integer;
  v_exhausted integer;
begin
  if least(p_candidate_pairs, p_deterministic_resolved, p_confirmed, p_rejected,
      p_needs_review, p_ai_escalations, p_provider_failures, p_alerts_created) < 0 then
    raise exception 'invalid matching metrics';
  end if;
  if p_unresolved is null or jsonb_typeof(p_unresolved) <> 'array'
    or jsonb_array_length(p_unresolved) > 100 or cardinality(v_resolved) > 100
    or exists (select 1 from jsonb_array_elements(p_unresolved) item
      where jsonb_typeof(item) <> 'object'
        or coalesce(item->>'recallNoticeId', '') !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(item->>'reason', '') not in ('stale', 'busy', 'failure',
          'provider_failure', 'limit', 'not_reached', 'inconsistent_summary')
        or (select count(*) from jsonb_object_keys(item)) <> 2) then
    raise exception 'invalid unresolved matching work';
  end if;
  select coalesce(array_agg((item->>'recallNoticeId')::uuid), '{}') into v_unresolved_ids
  from jsonb_array_elements(p_unresolved) item;
  if cardinality(v_unresolved_ids) <> (select count(distinct x) from unnest(v_unresolved_ids) x)
    or cardinality(v_resolved) <> (select count(distinct x) from unnest(v_resolved) x)
    or v_unresolved_ids && v_resolved then
    raise exception 'matching work must be resolved or unresolved exactly once';
  end if;
  perform 1 from private.recall_automation_runs automation_run
  join private.recall_automation_lease automation_lease
    on automation_lease.run_id = automation_run.id
    and automation_lease.lease_token = p_lease_token
    and automation_lease.expires_at > pg_catalog.now()
  where automation_run.id = p_run_id and automation_run.status = 'running'
  for update of automation_run;
  if not found then
    raise exception 'automation run lease is unavailable';
  end if;

  update private.recall_automation_runs
  set
    candidate_pairs = p_candidate_pairs,
    deterministic_resolved = p_deterministic_resolved,
    confirmed = p_confirmed,
    rejected = p_rejected,
    needs_review = p_needs_review,
    ai_escalations = p_ai_escalations,
    provider_failures = p_provider_failures,
    alerts_created = p_alerts_created
  where id = p_run_id;

  insert into private.recall_automation_matching_outcomes (run_id, recall_notice_id, outcome,
    unresolved_attempts)
  select p_run_id, resolved_id, 'resolved', 0 from unnest(v_resolved) resolved_id;
  delete from private.recall_automation_pending_recalls
  where recall_notice_id = any (v_resolved);
  get diagnostics v_deleted = row_count;

  -- Unresolved work is never dropped: a missing row is recreated.
  insert into private.recall_automation_pending_recalls (recall_notice_id)
  select unresolved_id from unnest(v_unresolved_ids) unresolved_id
  where exists (select 1 from public.recall_notices n where n.id = unresolved_id)
  on conflict (recall_notice_id) do nothing;
  with item as (
    select (value->>'recallNoticeId')::uuid as recall_notice_id, value->>'reason' as reason
    from jsonb_array_elements(p_unresolved)
  ), updated as (
    update private.recall_automation_pending_recalls pending
    set attempt_count = pending.attempt_count + 1,
      last_attempted_at = pg_catalog.now(),
      unresolved_attempts = pending.unresolved_attempts + 1,
      last_unresolved_reason = item.reason,
      last_unresolved_at = pg_catalog.now(),
      exhausted_at = case when pending.unresolved_attempts + 1 >= c_max_unresolved
        then coalesce(pending.exhausted_at, pg_catalog.now()) end
    from item
    where pending.recall_notice_id = item.recall_notice_id
    returning pending.recall_notice_id, item.reason, pending.unresolved_attempts,
      pending.exhausted_at
  )
  insert into private.recall_automation_matching_outcomes (run_id, recall_notice_id, outcome,
    reason, unresolved_attempts)
  select p_run_id, recall_notice_id,
    case when exhausted_at is null then 'retained' else 'exhausted' end,
    reason, unresolved_attempts
  from updated;
  select count(*) filter (where outcome = 'retained'),
    count(*) filter (where outcome = 'exhausted')
  into v_retained, v_exhausted
  from private.recall_automation_matching_outcomes
  where run_id = p_run_id and outcome <> 'resolved';

  return jsonb_build_object('resolved', cardinality(v_resolved), 'deleted', v_deleted,
    'retained', v_retained, 'exhausted', v_exhausted);
end;
$$;

-- Same signature and order as Phase 12 while nothing is exhausted. An
-- exhausted recall is listed last and at most once per 24 hours.
create or replace function public.get_recall_automation_pending_recalls(
  p_run_id uuid,
  p_lease_token uuid,
  p_limit integer
)
returns table (recall_notice_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit < 1 or p_limit > 100 then
    raise exception 'invalid pending recall limit';
  end if;
  if not exists (
    select 1
    from private.recall_automation_lease as automation_lease
    where automation_lease.run_id = p_run_id
      and automation_lease.lease_token = p_lease_token
      and automation_lease.expires_at > pg_catalog.now()
  ) then
    raise exception 'automation run lease is unavailable';
  end if;

  return query
  select pending.recall_notice_id
  from private.recall_automation_pending_recalls as pending
  where pending.exhausted_at is null
    or pending.last_attempted_at is null
    or pending.last_attempted_at <= pg_catalog.now() - interval '24 hours'
  order by (pending.exhausted_at is not null), pending.last_attempted_at asc nulls first,
    pending.first_affected_at, pending.recall_notice_id
  limit p_limit;
end;
$$;

create function private.recall_automation_pending_status(p_now timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'pending', count(*),
    'retrying', count(*) filter (where unresolved_attempts > 0 and exhausted_at is null),
    'exhausted', count(*) filter (where exhausted_at is not null),
    'oldestAffectedAt', min(first_affected_at),
    'reasons', coalesce((select jsonb_object_agg(reason, n) from (
      select last_unresolved_reason reason, count(*) n
      from private.recall_automation_pending_recalls
      where last_unresolved_reason is not null group by 1) r), '{}'::jsonb),
    'outcomesLast24h', coalesce((select jsonb_object_agg(outcome, n) from (
      select outcome, count(*) n from private.recall_automation_matching_outcomes
      where recorded_at > p_now - interval '1 day' group by 1) o), '{}'::jsonb))
  from private.recall_automation_pending_recalls;
$$;

-- ===========================================================================
-- 2. Scheduler invocation tickets. A tick creates a random 256-bit ticket,
-- stores only its SHA-256, and sends it once through pg_net. The receiver
-- consumes it atomically: single use, 120 s, bound to one job, parameters
-- taken from the database. A ticket read from the pg_net queue can only
-- trigger the bounded cycle the database already decided to run.
-- ===========================================================================
create table private.scheduler_invocation_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_seq bigint generated always as identity unique,
  job text not null check (job in ('cpsc_page_stage', 'recall_automation')),
  ticket_sha256 text not null unique check (ticket_sha256 ~ '^[0-9a-f]{64}$'),
  parameters jsonb not null check (jsonb_typeof(parameters) = 'object'),
  request_id bigint not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumer text check (consumer in ('process-cpsc-page-evidence', 'run-recall-automation')),
  rejected_attempts integer not null default 0 check (rejected_attempts >= 0),
  check (expires_at > issued_at and expires_at <= issued_at + interval '5 minutes'),
  check ((consumed_at is null) = (consumer is null))
);
alter table private.scheduler_invocation_tickets enable row level security;

create function private.scheduler_ticket_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'Scheduler tickets are retained for audit' using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'consumed_at' - 'consumer' - 'rejected_attempts')
      is distinct from (to_jsonb(old) - 'consumed_at' - 'consumer' - 'rejected_attempts')
    or new.rejected_attempts < old.rejected_attempts
    or (old.consumed_at is not null and (new.consumed_at is distinct from old.consumed_at
      or new.consumer is distinct from old.consumer)) then
    raise exception 'A scheduler ticket can only be consumed once' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger scheduler_invocation_tickets_guard
  before update or delete on private.scheduler_invocation_tickets
  for each row execute function private.scheduler_ticket_guard();
create trigger scheduler_invocation_tickets_no_truncate
  before truncate on private.scheduler_invocation_tickets
  for each statement execute function private.scheduler_ticket_guard();

create function private.scheduler_ticket_hash(p_ticket text)
returns text language sql immutable set search_path = '' as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_ticket, 'UTF8')), 'hex');
$$;

create function private.consume_scheduler_ticket(p_job text, p_ticket text, p_consumer text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v private.scheduler_invocation_tickets%rowtype;
begin
  if p_ticket is null or p_ticket !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('accepted', false, 'reason', 'malformed');
  end if;
  select * into v from private.scheduler_invocation_tickets
    where ticket_sha256 = private.scheduler_ticket_hash(p_ticket) for update;
  if v.id is null then
    return jsonb_build_object('accepted', false, 'reason', 'unknown');
  end if;
  if v.job <> p_job or v.consumed_at is not null or v.expires_at <= now() then
    update private.scheduler_invocation_tickets
      set rejected_attempts = rejected_attempts + 1 where id = v.id;
    return jsonb_build_object('accepted', false, 'reason', case
      when v.job <> p_job then 'wrong_job'
      when v.consumed_at is not null then 'replayed' else 'expired' end);
  end if;
  update private.scheduler_invocation_tickets
    set consumed_at = now(), consumer = p_consumer where id = v.id;
  return jsonb_build_object('accepted', true, 'ticketId', v.id, 'parameters', v.parameters);
end;
$$;

-- The page worker consumes its own ticket through its dedicated login. A
-- ticket issued before a stop is consumed but authorizes nothing.
create function public.consume_cpsc_page_stage_ticket(p_ticket text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if session_user <> 'cpsc_page_worker'
    and current_setting('role', true) <> 'cpsc_page_worker' then
    raise exception 'Dedicated page worker authorization required' using errcode = '42501';
  end if;
  v_result := private.consume_scheduler_ticket('cpsc_page_stage', p_ticket,
    'process-cpsc-page-evidence');
  if (v_result->>'accepted')::boolean
    and not (private.cpsc_page_stage_control_state(now())->>'running')::boolean then
    return jsonb_build_object('accepted', false, 'reason', 'stage_not_running');
  end if;
  if not (v_result->>'accepted')::boolean then return v_result; end if;
  return jsonb_build_object('accepted', true,
    'maxPages', (v_result #>> '{parameters,maxPages}')::integer,
    'timeBudgetMs', (v_result #>> '{parameters,timeBudgetMs}')::integer);
end;
$$;

create function public.consume_recall_automation_ticket(p_ticket text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  v_result := private.consume_scheduler_ticket('recall_automation', p_ticket,
    'run-recall-automation');
  if not (v_result->>'accepted')::boolean then return v_result; end if;
  return jsonb_build_object('accepted', true, 'trigger', v_result #>> '{parameters,trigger}');
end;
$$;

-- The page tick keeps every 16.32 policy check. It no longer reads or sends
-- a static key: the Vault holds only the pinned URL and the publishable key.
create or replace function private.cpsc_page_stage_tick()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_policy jsonb;
  v_blockers text[];
  v_url text;
  v_apikey text;
  v_ticket text;
  v_request bigint;
  v_max integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cpsc:page-stage-tick'));
  v_policy := private.cpsc_page_stage_policy(now());
  select coalesce(array_agg(value), '{}') into v_blockers
    from jsonb_array_elements_text(v_policy->'blockers');
  if cardinality(v_blockers) = 0 then
    select max(decrypted_secret) filter (where name = 'cpsc_page_worker_url'),
      max(decrypted_secret) filter (where name = 'cpsc_page_worker_apikey')
      into v_url, v_apikey
    from vault.decrypted_secrets
    where name in ('cpsc_page_worker_url', 'cpsc_page_worker_apikey');
    if v_url is null or v_apikey is null or btrim(v_apikey) = ''
      or v_apikey like 'sb_secret_%'
      or v_url !~ ('^(https://[a-z0-9]{20}\.supabase\.co'
        || '|http://(kong|host\.docker\.internal|127\.0\.0\.1|localhost)(:[0-9]{1,5})?)'
        || '/functions/v1/process-cpsc-page-evidence$') then
      v_blockers := array['invocation_endpoint_unavailable'];
    end if;
  end if;
  if cardinality(v_blockers) > 0 then
    insert into private.cpsc_page_stage_ticks (decision, blockers, control_event_id)
    values ('skipped', v_blockers, nullif(v_policy #>> '{control,eventId}', '')::uuid);
    return jsonb_build_object('decision', 'skipped', 'blockers', to_jsonb(v_blockers));
  end if;
  v_max := (v_policy #>> '{control,maxPagesPerCycle}')::integer;
  v_ticket := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  v_request := net.http_post(
    url := v_url,
    headers := jsonb_build_object('content-type', 'application/json',
      'apikey', v_apikey, 'authorization', 'Bearer ' || v_apikey,
      'x-cpsc-page-ticket', v_ticket),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
  insert into private.scheduler_invocation_tickets (job, ticket_sha256, parameters, request_id,
    expires_at)
  values ('cpsc_page_stage', private.scheduler_ticket_hash(v_ticket),
    jsonb_build_object('maxPages', v_max, 'timeBudgetMs', 20000), v_request,
    now() + interval '120 seconds');
  insert into private.cpsc_page_stage_ticks (decision, control_event_id, max_pages, request_id)
  values ('dispatched', (v_policy #>> '{control,eventId}')::uuid, v_max, v_request);
  return jsonb_build_object('decision', 'dispatched', 'maxPages', v_max);
end;
$$;

create or replace function private.install_cpsc_page_stage_cron()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_job bigint;
begin
  if (select count(*) from vault.decrypted_secrets where name in
      ('cpsc_page_worker_url', 'cpsc_page_worker_apikey')) <> 2 then
    raise exception 'required CPSC page worker Vault endpoint is unavailable';
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'cpsc-page-evidence-shadow';
  select cron.schedule('cpsc-page-evidence-shadow', '47 * * * *',
    'select private.cpsc_page_stage_tick();') into v_job;
  perform cron.alter_job(v_job, active := false);
  return v_job;
end;
$$;

-- v1 tick: the same automation run, triggered with a ticket instead of the
-- static x-recall-automation-key. Defined only; converting job 2 is a
-- separately authorized owner action (convert_recall_automation_cron_to_tickets).
create function private.recall_automation_tick()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_ticket text;
  v_request bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('recall:automation-tick'));
  select max(decrypted_secret) into v_url from vault.decrypted_secrets
    where name = 'recall_automation_url';
  if v_url is null or v_url !~ ('^(https://[a-z0-9]{20}\.supabase\.co'
      || '|http://(kong|host\.docker\.internal|127\.0\.0\.1|localhost)(:[0-9]{1,5})?)'
      || '/functions/v1/run-recall-automation$') then
    raise exception 'Recall automation endpoint is unavailable or not pinned';
  end if;
  v_ticket := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  v_request := net.http_post(
    url := v_url,
    headers := jsonb_build_object('content-type', 'application/json',
      'x-recall-automation-ticket', v_ticket),
    body := '{"trigger":"cron"}'::jsonb,
    timeout_milliseconds := 30000);
  insert into private.scheduler_invocation_tickets (job, ticket_sha256, parameters, request_id,
    expires_at)
  values ('recall_automation', private.scheduler_ticket_hash(v_ticket),
    '{"trigger":"cron"}'::jsonb, v_request, now() + interval '120 seconds');
  return jsonb_build_object('decision', 'dispatched', 'requestId', v_request);
end;
$$;

create function private.convert_recall_automation_cron_to_tickets()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_job bigint;
begin
  if (select count(*) from cron.job where jobname = 'recall-automation-every-6h') <> 1 then
    raise exception 'exactly one Recall automation Cron job is required';
  end if;
  select jobid into v_job from cron.job where jobname = 'recall-automation-every-6h';
  perform cron.alter_job(v_job, command := 'select private.recall_automation_tick();');
  return v_job;
end;
$$;

create function private.scheduler_invocation_status(p_now timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(job, jsonb_build_object(
    'issuedLast24h', issued, 'consumedLast24h', consumed,
    'expiredUnconsumedLast24h', expired, 'rejectedAttemptsLast24h', rejected,
    'lastIssuedAt', last_issued, 'lastConsumedAt', last_consumed)), '{}'::jsonb)
  from (
    select job, count(*) issued, count(consumed_at) consumed,
      count(*) filter (where consumed_at is null and expires_at <= p_now) expired,
      coalesce(sum(rejected_attempts), 0) rejected,
      max(issued_at) last_issued, max(consumed_at) last_consumed
    from private.scheduler_invocation_tickets
    where issued_at > p_now - interval '1 day'
    group by job) s;
$$;

-- ===========================================================================
-- 3. Server-verified MFA. A human capability is usable only from a live
-- Supabase Auth session at aal2 whose MFA step is at most 12 hours old and
-- whose user holds a verified factor. The token's aal claim alone is not
-- enough: the session row must still exist, so signing out or deleting the
-- session or factor ends the authority at once.
-- ===========================================================================
create function private.cpsc_session_mfa_verified()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_session text := auth.jwt()->>'session_id';
begin
  if coalesce(auth.role(), '') <> 'authenticated' or v_uid is null
    or coalesce(auth.jwt()->>'aal', '') <> 'aal2'
    or coalesce(v_session, '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
      select 1 from auth.sessions s
      where s.id = v_session::uuid and s.user_id = v_uid and s.aal = 'aal2'
        and (s.not_after is null or s.not_after > now()))
    and exists (
      select 1 from auth.mfa_factors f
      where f.user_id = v_uid and f.status = 'verified')
    and exists (
      select 1 from auth.mfa_amr_claims a
      where a.session_id = v_session::uuid
        and a.authentication_method in ('totp', 'mfa/totp', 'mfa/phone', 'mfa/webauthn')
        and a.updated_at > now() - interval '12 hours');
end;
$$;

create or replace function private.cpsc_has_capability(p_capability text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.cpsc_session_mfa_verified()
    and exists (
      select 1 from private.cpsc_admin_capabilities c
      where c.user_id = auth.uid() and c.capability = p_capability
        and c.authorized_at <= now()
        and (c.revoked_at is null or c.revoked_at > now())
    ), false);
$$;

create or replace function private.cpsc_is_human_reviewer()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.cpsc_session_mfa_verified()
    and exists (
      select 1 from private.cpsc_reviewer_authorizations r
      where r.user_id = auth.uid() and r.authorized_at <= now()
        and (r.revoked_at is null or r.revoked_at > now())
    ), false);
$$;

-- ===========================================================================
-- 4. Negative evidence outside the census. The coverage ledger reads only the
-- description. A rejection additionally needs a current human attestation
-- that the other recall-detail sections (remedy, sold at, importer, ...) and
-- any linked documents do not narrow or widen the scope. The attestation is
-- bound to the exact section text; any change, expiry or new revision
-- withdraws it. Nothing is inferred from documents automatically.
-- ===========================================================================
create function private.cpsc_outside_census_sections(p_revision_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(r.normalized_evidence->'recallDetails', '{}'::jsonb) - 'description'
  from private.cpsc_page_revisions r where r.id = p_revision_id;
$$;

create function private.cpsc_outside_census_sha256(p_revision_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'cpsc-outside-census/v1' || chr(10) || private.cpsc_outside_census_sections(p_revision_id)::text,
    'UTF8')), 'hex');
$$;

create table private.cpsc_outside_census_attestations (
  id uuid primary key default gen_random_uuid(),
  attestation_seq bigint generated always as identity unique,
  revision_id uuid not null references private.cpsc_page_revisions (id) on delete restrict,
  source_revision_hash text not null,
  outside_census_sha256 text not null check (outside_census_sha256 ~ '^[0-9a-f]{64}$'),
  sections text[] not null,
  external_references jsonb not null check (jsonb_typeof(external_references) = 'array'
    and jsonb_array_length(external_references) <= 20),
  statement text not null check (btrim(statement) <> '' and length(statement) <= 4000),
  reviewer_user_id uuid not null references auth.users (id) on delete restrict,
  attested_at timestamptz not null default now(),
  valid_until timestamptz not null,
  check (valid_until > attested_at and valid_until <= attested_at + interval '30 days')
);
alter table private.cpsc_outside_census_attestations enable row level security;
create trigger cpsc_outside_census_attestations_append_only
  before update or delete on private.cpsc_outside_census_attestations
  for each row execute function private.cpsc_append_only();
create trigger cpsc_outside_census_attestations_no_truncate
  before truncate on private.cpsc_outside_census_attestations
  for each statement execute function private.cpsc_append_only();

-- Only the authenticated reviewer can write their own attestation; an owner
-- insert carrying a real reviewer id is rejected.
create function private.cpsc_guard_outside_census_attestation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not private.cpsc_is_human_reviewer() or auth.uid() is distinct from new.reviewer_user_id then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  new.attested_at := now();
  return new;
end;
$$;
create trigger cpsc_guard_outside_census_attestation
  before insert on private.cpsc_outside_census_attestations
  for each row execute function private.cpsc_guard_outside_census_attestation();

create function private.cpsc_outside_census_attested(p_revision_id uuid, p_now timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'attested', a.id is not null,
    'attestationId', a.id,
    'validUntil', a.valid_until,
    'sectionsSha256', private.cpsc_outside_census_sha256(p_revision_id))
  from (select 1) one
  left join lateral (
    select a.* from private.cpsc_outside_census_attestations a
    join private.cpsc_page_revisions r on r.id = a.revision_id
    where a.revision_id = p_revision_id
      and a.source_revision_hash = r.evidence_hash
      and a.outside_census_sha256 = private.cpsc_outside_census_sha256(p_revision_id)
      and a.valid_until > p_now
      and private.cpsc_revision_is_current(r.id)
      and exists (select 1 from private.cpsc_reviewer_authorizations g
        where g.user_id = a.reviewer_user_id and g.authorized_at <= a.attested_at
          and (g.revoked_at is null or g.revoked_at > a.attested_at))
    order by a.attestation_seq desc limit 1) a on true;
$$;

create function public.get_cpsc_outside_census_packet(p_revision_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_revision private.cpsc_page_revisions%rowtype;
begin
  if not private.cpsc_is_human_reviewer() then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  select * into v_revision from private.cpsc_page_revisions where id = p_revision_id;
  if v_revision.id is null then return null; end if;
  return jsonb_build_object(
    'revisionId', v_revision.id,
    'recallNumber', v_revision.recall_number,
    'officialUrl', v_revision.canonical_url,
    'sourceSemanticRevision', v_revision.evidence_hash,
    'revisionIsCurrent', private.cpsc_revision_is_current(v_revision.id),
    'sections', private.cpsc_outside_census_sections(v_revision.id),
    'sectionsSha256', private.cpsc_outside_census_sha256(v_revision.id),
    'instruction', 'Read every section and every document it links to on the official '
      || 'page. Attest only if none of them narrows or widens the recalled population.',
    'attestation', private.cpsc_outside_census_attested(v_revision.id, now()));
end;
$$;

create function public.attest_cpsc_outside_census(
  p_revision_id uuid,
  p_expected_sections_sha256 text,
  p_external_references jsonb,
  p_statement text,
  p_valid_for_days integer
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_revision private.cpsc_page_revisions%rowtype;
  v_id uuid;
begin
  if not private.cpsc_is_human_reviewer() then
    raise exception 'CPSC human reviewer authorization required' using errcode = '42501';
  end if;
  select * into v_revision from private.cpsc_page_revisions where id = p_revision_id;
  if v_revision.id is null or not private.cpsc_revision_is_current(v_revision.id) then
    raise exception 'Attestation requires the current source revision';
  end if;
  if p_expected_sections_sha256 is distinct from private.cpsc_outside_census_sha256(p_revision_id) then
    raise exception 'Recall-detail sections changed since they were read';
  end if;
  if p_valid_for_days is null or p_valid_for_days not between 1 and 30 then
    raise exception 'Attestation must expire within 1 to 30 days';
  end if;
  if p_external_references is null or jsonb_typeof(p_external_references) <> 'array'
    or exists (select 1 from jsonb_array_elements(p_external_references) ref
      where jsonb_typeof(ref) <> 'string' or ref #>> '{}' !~ '^https://[^[:space:]]+$'
        or length(ref #>> '{}') > 2000) then
    raise exception 'External references must be https URLs';
  end if;
  insert into private.cpsc_outside_census_attestations (revision_id, source_revision_hash,
    outside_census_sha256, sections, external_references, statement, reviewer_user_id,
    valid_until)
  values (v_revision.id, v_revision.evidence_hash, p_expected_sections_sha256,
    (select coalesce(array_agg(key order by key), '{}')
      from jsonb_object_keys(private.cpsc_outside_census_sections(v_revision.id)) key),
    p_external_references, p_statement, auth.uid(),
    now() + p_valid_for_days * interval '1 day')
  returning id into v_id;
  return v_id;
end;
$$;

-- Unchanged from 16.13 except: sourceCoverage carries the outside-census
-- state, and `complete` also requires it.
create or replace function private.cpsc_scope_rule_set_coverage(p_scope_id uuid, p_served_groups text[])
returns jsonb language sql stable security definer set search_path = '' as $$
  with current_revision as (
    select revision.id from public.recall_scopes scope
    join private.cpsc_notice_identity_links link on link.notice_id = scope.recall_notice_id
    join private.cpsc_page_revisions revision on revision.identity_id = link.identity_id
    where scope.id = p_scope_id and private.cpsc_revision_is_current(revision.id)
  ), proposal as (
    select distinct coalesce(c.conjunction_key, c.id::text) as conjunction_group,
      c.proposed_scope_id
    from private.cpsc_candidate_criteria c
    join current_revision on current_revision.id = c.revision_id
  ), ledger as (
    select l.* from private.cpsc_page_coverage_ledgers l
    where l.revision_id = private.cpsc_scope_current_revision(p_scope_id)
    order by l.recorded_seq desc limit 1
  ), outside as (
    select private.cpsc_outside_census_attested(
      private.cpsc_scope_current_revision(p_scope_id), now()) as state
  ), summary as (
    select
      (select count(*) from current_revision) as current_revisions,
      (select count(*) from proposal where proposed_scope_id = p_scope_id) as proposed,
      (select count(*) from proposal where proposed_scope_id is null) as unattributed,
      (select count(*) from proposal where proposed_scope_id = p_scope_id
        and conjunction_group <> all(coalesce(p_served_groups, '{}'))) as unserved,
      coalesce(cardinality(p_served_groups), 0) as served,
      coalesce((select negative_evidence_eligible from ledger), false) as ledger_negative,
      coalesce((select reviewable_relations from ledger), '{}') as relations,
      coalesce((select array_agg(distinct conjunction_group) from proposal), '{}') as groups,
      coalesce((select (state->>'attested')::boolean from outside), false) as outside_attested,
      (select state from outside) as outside_state
  )
  select jsonb_build_object(
    'currentRevisionId', (select id from current_revision limit 1),
    'proposedRuleSets', proposed,
    'unattributedRuleSets', unattributed,
    'servedRuleSets', served,
    'sourceCoverage', private.cpsc_revision_coverage(private.cpsc_scope_current_revision(p_scope_id))
      || jsonb_build_object('outsideCensus', outside_state),
    'complete', current_revisions = 1 and unattributed = 0 and proposed > 0
      and unserved = 0 and served = proposed
      and ledger_negative and relations @> groups and groups @> relations
      and outside_attested)
  from summary;
$$;

-- ===========================================================================
-- Privilege boundary.
-- ===========================================================================
revoke all on private.recall_automation_matching_outcomes, private.scheduler_invocation_tickets,
  private.cpsc_outside_census_attestations
  from public, anon, authenticated, service_role, cpsc_page_worker;
revoke all on function
  private.recall_automation_pending_rearm(),
  public.record_recall_automation_matching_outcome(uuid, uuid, uuid[], jsonb, integer, integer,
    integer, integer, integer, integer, integer, integer),
  public.get_recall_automation_pending_recalls(uuid, uuid, integer),
  private.recall_automation_pending_status(timestamptz),
  private.scheduler_ticket_guard(),
  private.scheduler_ticket_hash(text),
  private.consume_scheduler_ticket(text, text, text),
  public.consume_cpsc_page_stage_ticket(text),
  public.consume_recall_automation_ticket(text),
  private.cpsc_page_stage_tick(),
  private.install_cpsc_page_stage_cron(),
  private.recall_automation_tick(),
  private.convert_recall_automation_cron_to_tickets(),
  private.scheduler_invocation_status(timestamptz),
  private.cpsc_session_mfa_verified(),
  private.cpsc_has_capability(text),
  private.cpsc_is_human_reviewer(),
  private.cpsc_outside_census_sections(uuid),
  private.cpsc_outside_census_sha256(uuid),
  private.cpsc_guard_outside_census_attestation(),
  private.cpsc_outside_census_attested(uuid, timestamptz),
  public.get_cpsc_outside_census_packet(uuid),
  public.attest_cpsc_outside_census(uuid, text, jsonb, text, integer),
  private.cpsc_scope_rule_set_coverage(uuid, text[])
  from public, anon, authenticated, service_role, cpsc_page_worker;
grant execute on function
  public.record_recall_automation_matching_outcome(uuid, uuid, uuid[], jsonb, integer, integer,
    integer, integer, integer, integer, integer, integer),
  public.get_recall_automation_pending_recalls(uuid, uuid, integer),
  public.consume_recall_automation_ticket(text)
  to service_role;
grant execute on function public.consume_cpsc_page_stage_ticket(text) to cpsc_page_worker;
grant execute on function
  public.get_cpsc_outside_census_packet(uuid),
  public.attest_cpsc_outside_census(uuid, text, jsonb, text, integer)
  to authenticated;

commit;
