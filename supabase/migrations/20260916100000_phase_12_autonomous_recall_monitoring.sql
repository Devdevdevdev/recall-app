begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

create schema if not exists private;

create table private.recall_automation_control (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  ai_enabled boolean not null default false,
  push_enabled boolean not null default false,
  max_recalls_per_run integer not null default 100
    check (max_recalls_per_run between 1 and 100),
  max_candidate_pairs_per_run integer not null default 500
    check (max_candidate_pairs_per_run between 1 and 1000),
  max_ai_escalations_per_run integer not null default 5
    check (max_ai_escalations_per_run between 0 and 5),
  max_notification_batch_size integer not null default 25
    check (max_notification_batch_size between 1 and 50),
  bootstrap_days integer not null default 7 check (bootstrap_days between 1 and 14),
  catch_up_days integer not null default 7 check (catch_up_days between 1 and 14),
  overlap_hours integer not null default 48 check (overlap_hours between 0 and 72),
  updated_at timestamptz not null default now()
);

insert into private.recall_automation_control (singleton)
values (true)
on conflict (singleton) do nothing;

create table private.recall_automation_state (
  singleton boolean primary key default true check (singleton),
  last_successful_watermark date,
  updated_at timestamptz not null default now()
);

insert into private.recall_automation_state (singleton)
values (true)
on conflict (singleton) do nothing;

create table private.recall_automation_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('cron', 'manual')),
  verification_mode boolean not null default false,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (
    status in (
      'running',
      'success',
      'partial_success',
      'failed',
      'skipped_disabled',
      'skipped_already_running'
    )
  ),
  window_start date,
  window_end date,
  max_recalls integer not null default 0 check (max_recalls between 0 and 100),
  max_candidate_pairs integer not null default 0 check (max_candidate_pairs between 0 and 1000),
  max_ai_escalations integer not null default 0 check (max_ai_escalations between 0 and 5),
  notification_batch_size integer not null default 0 check (notification_batch_size between 0 and 50),
  ingestion_seen integer not null default 0 check (ingestion_seen >= 0),
  ingestion_inserted integer not null default 0 check (ingestion_inserted >= 0),
  ingestion_updated integer not null default 0 check (ingestion_updated >= 0),
  ingestion_unchanged integer not null default 0 check (ingestion_unchanged >= 0),
  ingestion_rejected integer not null default 0 check (ingestion_rejected >= 0),
  affected_recalls integer not null default 0 check (affected_recalls >= 0),
  candidate_pairs integer not null default 0 check (candidate_pairs >= 0),
  deterministic_resolved integer not null default 0 check (deterministic_resolved >= 0),
  confirmed integer not null default 0 check (confirmed >= 0),
  rejected integer not null default 0 check (rejected >= 0),
  needs_review integer not null default 0 check (needs_review >= 0),
  ai_escalations integer not null default 0 check (ai_escalations >= 0),
  provider_failures integer not null default 0 check (provider_failures >= 0),
  alerts_created integer not null default 0 check (alerts_created >= 0),
  push_claimed integer not null default 0 check (push_claimed >= 0),
  push_accepted integer not null default 0 check (push_accepted >= 0),
  push_failed integer not null default 0 check (push_failed >= 0),
  error_step text,
  error_code text,
  constraint recall_automation_runs_completion_check check (
    (status = 'running' and completed_at is null)
    or (status <> 'running' and completed_at is not null)
  ),
  constraint recall_automation_runs_window_check check (
    (window_start is null and window_end is null)
    or (window_start is not null and window_end is not null and window_start <= window_end)
  ),
  constraint recall_automation_runs_error_check check (
    (error_step is null and error_code is null)
    or (error_step is not null and btrim(error_step) <> '' and error_code is not null and btrim(error_code) <> '')
  )
);

create index recall_automation_runs_started_at_idx
on private.recall_automation_runs (started_at desc);

create table private.recall_automation_lease (
  singleton boolean primary key default true check (singleton),
  run_id uuid not null references private.recall_automation_runs (id) on delete cascade,
  lease_token uuid not null unique,
  claimed_at timestamptz not null,
  expires_at timestamptz not null,
  check (expires_at > claimed_at)
);

create table private.recall_automation_pending_recalls (
  recall_notice_id uuid primary key references public.recall_notices (id) on delete cascade,
  first_affected_at timestamptz not null default now(),
  last_affected_at timestamptz not null default now(),
  last_attempted_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0)
);

create index recall_automation_pending_order_idx
on private.recall_automation_pending_recalls (
  last_attempted_at asc nulls first,
  first_affected_at,
  recall_notice_id
);

alter table private.recall_automation_control enable row level security;
alter table private.recall_automation_state enable row level security;
alter table private.recall_automation_runs enable row level security;
alter table private.recall_automation_lease enable row level security;
alter table private.recall_automation_pending_recalls enable row level security;

revoke all on table private.recall_automation_control from public, anon, authenticated, service_role;
revoke all on table private.recall_automation_state from public, anon, authenticated, service_role;
revoke all on table private.recall_automation_runs from public, anon, authenticated, service_role;
revoke all on table private.recall_automation_lease from public, anon, authenticated, service_role;
revoke all on table private.recall_automation_pending_recalls from public, anon, authenticated, service_role;

create function public.get_cpsc_recall_notice_id(p_external_id text)
returns uuid
language sql
security definer
set search_path = ''
stable
as $$
  select recall_notice.id
  from public.recall_notices as recall_notice
  join public.recall_sources as recall_source on recall_source.id = recall_notice.source_id
  where recall_source.name = 'U.S. Consumer Product Safety Commission (CPSC)'
    and recall_source.jurisdiction = 'US'
    and recall_source.base_url = 'https://www.cpsc.gov'
    and recall_source.is_authoritative
    and recall_notice.external_id = p_external_id
  order by recall_notice.created_at
  limit 1;
$$;

create function public.claim_recall_automation_run(
  p_trigger text default 'manual',
  p_verification_mode boolean default false,
  p_max_recalls integer default null,
  p_max_candidate_pairs integer default null,
  p_max_ai_escalations integer default null,
  p_notification_batch_size integer default null,
  p_now timestamptz default now(),
  p_lease_seconds integer default 1800
)
returns table (
  claim_status text,
  run_id uuid,
  lease_token uuid,
  window_start date,
  window_end date,
  max_recalls integer,
  max_candidate_pairs integer,
  max_ai_escalations integer,
  notification_batch_size integer,
  ai_enabled boolean,
  push_enabled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control private.recall_automation_control%rowtype;
  v_watermark date;
  v_existing_run_id uuid;
  v_existing_expires_at timestamptz;
  v_run_id uuid := gen_random_uuid();
  v_lease_token uuid := gen_random_uuid();
  v_today date := (p_now at time zone 'UTC')::date;
  v_window_start date;
  v_window_end date;
  v_max_recalls integer;
  v_max_candidate_pairs integer;
  v_max_ai integer;
  v_notification_batch integer;
begin
  if p_trigger not in ('cron', 'manual') then
    raise exception 'invalid automation trigger';
  end if;

  select * into v_control
  from private.recall_automation_control
  where singleton
  for update;

  if not found then
    raise exception 'automation control is unavailable';
  end if;

  v_max_recalls := coalesce(p_max_recalls, v_control.max_recalls_per_run);
  v_max_candidate_pairs := coalesce(p_max_candidate_pairs, v_control.max_candidate_pairs_per_run);
  v_max_ai := case
    when p_verification_mode or not v_control.ai_enabled then 0
    else coalesce(p_max_ai_escalations, v_control.max_ai_escalations_per_run)
  end;
  v_notification_batch := coalesce(
    p_notification_batch_size,
    v_control.max_notification_batch_size
  );

  if v_max_recalls < 1 or v_max_recalls > v_control.max_recalls_per_run
    or v_max_candidate_pairs < 1
    or v_max_candidate_pairs > v_control.max_candidate_pairs_per_run
    or v_max_ai < 0
    or v_max_ai > v_control.max_ai_escalations_per_run
    or v_notification_batch < 1
    or v_notification_batch > v_control.max_notification_batch_size then
    raise exception 'requested automation limits exceed server controls';
  end if;

  if not v_control.enabled and not p_verification_mode then
    insert into private.recall_automation_runs (
      id, trigger, verification_mode, started_at, completed_at, status
    ) values (
      v_run_id, p_trigger, false, p_now, p_now, 'skipped_disabled'
    );

    claim_status := 'skipped_disabled';
    run_id := v_run_id;
    return next;
    return;
  end if;

  select automation_lease.run_id, automation_lease.expires_at
  into v_existing_run_id, v_existing_expires_at
  from private.recall_automation_lease as automation_lease
  where automation_lease.singleton
  for update;

  if v_existing_run_id is not null and v_existing_expires_at > p_now then
    insert into private.recall_automation_runs (
      id, trigger, verification_mode, started_at, completed_at, status
    ) values (
      v_run_id, p_trigger, p_verification_mode, p_now, p_now, 'skipped_already_running'
    );

    claim_status := 'already_running';
    run_id := v_run_id;
    return next;
    return;
  end if;

  if v_existing_run_id is not null then
    update private.recall_automation_runs
    set
      completed_at = p_now,
      status = 'failed',
      error_step = 'lease',
      error_code = 'lease_expired'
    where id = v_existing_run_id
      and status = 'running';
  end if;

  select last_successful_watermark into v_watermark
  from private.recall_automation_state
  where singleton
  for update;

  if v_watermark is null then
    v_window_start := v_today - (v_control.bootstrap_days - 1);
    v_window_end := v_today;
  else
    v_window_start := v_watermark - (v_control.overlap_hours / 24);
    v_window_end := least(v_today, v_watermark + v_control.catch_up_days);
  end if;

  insert into private.recall_automation_runs (
    id,
    trigger,
    verification_mode,
    started_at,
    status,
    window_start,
    window_end,
    max_recalls,
    max_candidate_pairs,
    max_ai_escalations,
    notification_batch_size
  ) values (
    v_run_id,
    p_trigger,
    p_verification_mode,
    p_now,
    'running',
    v_window_start,
    v_window_end,
    v_max_recalls,
    v_max_candidate_pairs,
    v_max_ai,
    v_notification_batch
  );

  insert into private.recall_automation_lease (
    singleton, run_id, lease_token, claimed_at, expires_at
  ) values (
    true,
    v_run_id,
    v_lease_token,
    p_now,
    p_now + pg_catalog.make_interval(
      secs => least(greatest(coalesce(p_lease_seconds, 1800), 300), 3600)
    )
  )
  on conflict (singleton) do update
  set
    run_id = excluded.run_id,
    lease_token = excluded.lease_token,
    claimed_at = excluded.claimed_at,
    expires_at = excluded.expires_at;

  claim_status := 'claimed';
  run_id := v_run_id;
  lease_token := v_lease_token;
  window_start := v_window_start;
  window_end := v_window_end;
  max_recalls := v_max_recalls;
  max_candidate_pairs := v_max_candidate_pairs;
  max_ai_escalations := v_max_ai;
  notification_batch_size := v_notification_batch;
  ai_enabled := v_control.ai_enabled and not p_verification_mode;
  push_enabled := v_control.push_enabled and not p_verification_mode;
  return next;
end;
$$;

create function public.record_recall_automation_ingestion(
  p_run_id uuid,
  p_lease_token uuid,
  p_seen integer,
  p_inserted integer,
  p_updated integer,
  p_unchanged integer,
  p_affected_recall_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_end date;
begin
  if least(p_seen, p_inserted, p_updated, p_unchanged) < 0
    or p_seen <> p_inserted + p_updated + p_unchanged
    or coalesce(pg_catalog.cardinality(p_affected_recall_ids), 0) <> p_inserted + p_updated then
    raise exception 'invalid ingestion metrics';
  end if;

  select automation_run.window_end into v_window_end
  from private.recall_automation_runs as automation_run
  join private.recall_automation_lease as automation_lease
    on automation_lease.run_id = automation_run.id
    and automation_lease.lease_token = p_lease_token
    and automation_lease.expires_at > pg_catalog.now()
  where automation_run.id = p_run_id
    and automation_run.status = 'running'
  for update of automation_run;

  if v_window_end is null then
    raise exception 'automation run lease is unavailable';
  end if;

  update private.recall_automation_runs
  set
    ingestion_seen = p_seen,
    ingestion_inserted = p_inserted,
    ingestion_updated = p_updated,
    ingestion_unchanged = p_unchanged,
    ingestion_rejected = 0,
    affected_recalls = pg_catalog.cardinality(p_affected_recall_ids)
  where id = p_run_id;

  insert into private.recall_automation_pending_recalls (
    recall_notice_id, first_affected_at, last_affected_at
  )
  select affected_id, pg_catalog.now(), pg_catalog.now()
  from pg_catalog.unnest(p_affected_recall_ids) as affected_id
  on conflict (recall_notice_id) do update
  set last_affected_at = excluded.last_affected_at;

  update private.recall_automation_state
  set last_successful_watermark = greatest(
    coalesce(last_successful_watermark, v_window_end),
    v_window_end
  ), updated_at = pg_catalog.now()
  where singleton;
end;
$$;

create function public.get_recall_automation_pending_recalls(
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
  order by pending.last_attempted_at asc nulls first, pending.first_affected_at, pending.recall_notice_id
  limit p_limit;
end;
$$;

create function public.record_recall_automation_matching(
  p_run_id uuid,
  p_lease_token uuid,
  p_recall_notice_ids uuid[],
  p_complete boolean,
  p_candidate_pairs integer,
  p_deterministic_resolved integer,
  p_confirmed integer,
  p_rejected integer,
  p_needs_review integer,
  p_ai_escalations integer,
  p_provider_failures integer,
  p_alerts_created integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if least(
    p_candidate_pairs,
    p_deterministic_resolved,
    p_confirmed,
    p_rejected,
    p_needs_review,
    p_ai_escalations,
    p_provider_failures,
    p_alerts_created
  ) < 0 then
    raise exception 'invalid matching metrics';
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
  where id = p_run_id and status = 'running';

  if p_complete then
    delete from private.recall_automation_pending_recalls
    where recall_notice_id = any (p_recall_notice_ids);
  else
    update private.recall_automation_pending_recalls
    set
      last_attempted_at = pg_catalog.now(),
      attempt_count = attempt_count + 1
    where recall_notice_id = any (p_recall_notice_ids);
  end if;
end;
$$;

create function public.complete_recall_automation_run(
  p_run_id uuid,
  p_lease_token uuid,
  p_status text,
  p_push_claimed integer default 0,
  p_push_accepted integer default 0,
  p_push_failed integer default 0,
  p_error_step text default null,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('success', 'partial_success', 'failed') then
    raise exception 'invalid final automation status';
  end if;
  if least(p_push_claimed, p_push_accepted, p_push_failed) < 0 then
    raise exception 'invalid push metrics';
  end if;
  if not exists (
    select 1
    from private.recall_automation_lease as automation_lease
    where automation_lease.run_id = p_run_id
      and automation_lease.lease_token = p_lease_token
  ) then
    raise exception 'automation run lease is unavailable';
  end if;

  update private.recall_automation_runs
  set
    completed_at = pg_catalog.now(),
    status = p_status,
    push_claimed = p_push_claimed,
    push_accepted = p_push_accepted,
    push_failed = p_push_failed,
    error_step = p_error_step,
    error_code = p_error_code
  where id = p_run_id and status = 'running';

  delete from private.recall_automation_lease
  where run_id = p_run_id and lease_token = p_lease_token;
end;
$$;

create function private.install_recall_automation_cron()
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

  update cron.job set active = false where jobid = v_job_id;
  return v_job_id;
end;
$$;

create function private.set_recall_automation_cron_active(p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    select count(*)
    from cron.job
    where jobname = 'recall-automation-every-6h'
  ) <> 1 then
    raise exception 'exactly one Recall automation Cron job is required';
  end if;

  update cron.job
  set active = p_active
  where jobname = 'recall-automation-every-6h';
end;
$$;

revoke all on function public.get_cpsc_recall_notice_id(text) from public, anon, authenticated;
revoke all on function public.claim_recall_automation_run(text, boolean, integer, integer, integer, integer, timestamptz, integer)
from public, anon, authenticated;
revoke all on function public.record_recall_automation_ingestion(uuid, uuid, integer, integer, integer, integer, uuid[])
from public, anon, authenticated;
revoke all on function public.get_recall_automation_pending_recalls(uuid, uuid, integer)
from public, anon, authenticated;
revoke all on function public.record_recall_automation_matching(uuid, uuid, uuid[], boolean, integer, integer, integer, integer, integer, integer, integer, integer)
from public, anon, authenticated;
revoke all on function public.complete_recall_automation_run(uuid, uuid, text, integer, integer, integer, text, text)
from public, anon, authenticated;
revoke all on function private.install_recall_automation_cron() from public, anon, authenticated;
revoke all on function private.set_recall_automation_cron_active(boolean) from public, anon, authenticated;

grant execute on function public.get_cpsc_recall_notice_id(text) to service_role;
grant execute on function public.claim_recall_automation_run(text, boolean, integer, integer, integer, integer, timestamptz, integer)
to service_role;
grant execute on function public.record_recall_automation_ingestion(uuid, uuid, integer, integer, integer, integer, uuid[])
to service_role;
grant execute on function public.get_recall_automation_pending_recalls(uuid, uuid, integer)
to service_role;
grant execute on function public.record_recall_automation_matching(uuid, uuid, uuid[], boolean, integer, integer, integer, integer, integer, integer, integer, integer)
to service_role;
grant execute on function public.complete_recall_automation_run(uuid, uuid, text, integer, integer, integer, text, text)
to service_role;
grant execute on function private.install_recall_automation_cron() to service_role;
grant execute on function private.set_recall_automation_cron_active(boolean) to service_role;

commit;
