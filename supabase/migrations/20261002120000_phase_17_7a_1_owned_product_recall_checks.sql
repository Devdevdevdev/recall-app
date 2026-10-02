-- Phase 17.7a-1 is a LOCAL candidate. Do not apply in production, deploy, or
-- enable before finding F-4 (v1 recall->products confirms GTIN-only scopes
-- without structured conditions) is treated or explicitly neutralized.
--
-- Targeted check of ONE owned product against the official recalls already
-- known. Additive and forward-only:
--   1. a durable per-product job, armed in the same transaction as the product
--      write, that also carries the product's current check state;
--   2. an append-only event journal (audit, per-user rate limit);
--   3. a bounded, indexable candidate retrieval mirroring get_recall_candidates;
--   4. claim / complete RPCs (service_role) and an owner-only monitoring read.
-- The check itself runs in an Edge Function on the unchanged deterministic_v2
-- library behind a completeness/jurisdiction gate. It never calls the v1
-- matcher, never uses AI, and writes only the existing v2 evaluation/alert
-- tables. It is disabled by default (recall_automation_control flag).
begin;

-- ===========================================================================
-- 1. Control: reuse the Phase 12 singleton instead of a new control table.
-- ===========================================================================
alter table private.recall_automation_control
  add column product_check_enabled boolean not null default false,
  add column max_product_check_candidates integer not null default 25
    check (max_product_check_candidates between 1 and 100);

-- ===========================================================================
-- 2. One job per owned product. The row is both the durable queue entry and
-- the product's current check state. No product attribute is copied.
-- ===========================================================================
create table private.owned_product_recall_checks (
  owned_product_id uuid primary key
    references public.owned_products (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  matching_revision bigint not null default 1 check (matching_revision > 0),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'complete', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 1000),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  cursor_rank integer check (cursor_rank between 1 and 4),
  cursor_recall_id uuid,
  last_error text check (last_error in
    ('busy', 'stale', 'failure', 'timeout', 'product_changed')),
  armed_at timestamptz not null default now(),
  completed_revision bigint,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint owned_product_recall_checks_lease_pair
    check ((lease_token is null) = (lease_expires_at is null)),
  constraint owned_product_recall_checks_running_lease
    check ((status = 'running') = (lease_token is not null)),
  constraint owned_product_recall_checks_cursor_pair
    check ((cursor_rank is null) = (cursor_recall_id is null)),
  constraint owned_product_recall_checks_complete
    check (status <> 'complete'
      or (completed_revision = matching_revision and checked_at is not null)),
  constraint owned_product_recall_checks_completed_revision
    check (completed_revision is null or completed_revision <= matching_revision)
);
create index owned_product_recall_checks_due_idx
  on private.owned_product_recall_checks (available_at, owned_product_id)
  where status in ('pending', 'running', 'failed');
create index owned_product_recall_checks_user_idx
  on private.owned_product_recall_checks (user_id);
alter table private.owned_product_recall_checks enable row level security;
revoke all on table private.owned_product_recall_checks
  from public, anon, authenticated, service_role;

-- Append-only journal. Updates and truncation are refused; rows leave only
-- with their product (ON DELETE CASCADE), so no personal data is orphaned.
create table private.owned_product_recall_check_events (
  event_seq bigint generated always as identity primary key,
  owned_product_id uuid not null
    references public.owned_products (id) on delete cascade,
  user_id uuid not null,
  matching_revision bigint not null check (matching_revision > 0),
  event text not null check (event in
    ('armed', 'claimed', 'completed', 'continued', 'retry', 'exhausted', 'rearmed')),
  path text not null check (path in ('trigger', 'user', 'worker')),
  detail text check (detail is null or detail in
    ('busy', 'stale', 'failure', 'timeout', 'product_changed', 'lease_expired')),
  recorded_at timestamptz not null default now()
);
create index owned_product_recall_check_events_user_idx
  on private.owned_product_recall_check_events (user_id, recorded_at)
  where event = 'claimed' and path = 'user';
create index owned_product_recall_check_events_product_idx
  on private.owned_product_recall_check_events (owned_product_id, event_seq);
alter table private.owned_product_recall_check_events enable row level security;
revoke all on table private.owned_product_recall_check_events
  from public, anon, authenticated, service_role;

create function private.owned_product_recall_check_events_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'owned product check events are append-only';
end;
$$;
create trigger owned_product_recall_check_events_no_update
  before update on private.owned_product_recall_check_events
  for each row execute function private.owned_product_recall_check_events_immutable();
create trigger owned_product_recall_check_events_no_truncate
  before truncate on private.owned_product_recall_check_events
  for each statement execute function private.owned_product_recall_check_events_immutable();
revoke all on function private.owned_product_recall_check_events_immutable()
  from public, anon, authenticated, service_role;

-- ===========================================================================
-- 3. Arming trigger. Re-arms only when an input of the final logic changes:
--    gtin, model_number, serial_number, lot_number -> retrieval and v2 criteria;
--    safety_attributes                              -> v2 criteria (date_code...);
--    purchase_country_code                          -> jurisdiction gate;
--    product_name, brand                            -> candidate retrieval signals
--      (name FTS, brand equality, Jaccard guard) and the v2 fingerprint.
-- Not re-armed: category, purchase_date, scan_date, image_path,
-- identification_method, identification_confidence, timestamps.
-- ===========================================================================
create function private.arm_owned_product_recall_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision bigint;
begin
  insert into private.owned_product_recall_checks as job (owned_product_id, user_id)
  values (new.id, new.user_id)
  on conflict (owned_product_id) do update set
    user_id = excluded.user_id,
    matching_revision = job.matching_revision + 1,
    -- A running check keeps its lease; completion sees the new revision and
    -- re-queues the product instead of recording a stale result.
    status = case when job.status = 'running' then 'running' else 'pending' end,
    attempts = 0,
    available_at = pg_catalog.now(),
    cursor_rank = null,
    cursor_recall_id = null,
    last_error = null,
    armed_at = pg_catalog.now(),
    updated_at = pg_catalog.now()
  returning job.matching_revision into v_revision;

  insert into private.owned_product_recall_check_events
    (owned_product_id, user_id, matching_revision, event, path)
  values (new.id, new.user_id, v_revision, 'armed', 'trigger');
  return null;
end;
$$;
revoke all on function private.arm_owned_product_recall_check()
  from public, anon, authenticated, service_role;

create trigger owned_products_arm_recall_check_insert
  after insert on public.owned_products
  for each row execute function private.arm_owned_product_recall_check();

create trigger owned_products_arm_recall_check_update
  after update of brand, product_name, gtin, model_number, serial_number, lot_number,
    safety_attributes, purchase_country_code
  on public.owned_products
  for each row
  when (
    old.brand is distinct from new.brand
    or old.product_name is distinct from new.product_name
    or old.gtin is distinct from new.gtin
    or old.model_number is distinct from new.model_number
    or old.serial_number is distinct from new.serial_number
    or old.lot_number is distinct from new.lot_number
    or old.safety_attributes is distinct from new.safety_attributes
    or old.purchase_country_code is distinct from new.purchase_country_code
  )
  execute function private.arm_owned_product_recall_check();

-- Existing products get one pending job (production: zero rows).
insert into private.owned_product_recall_checks (owned_product_id, user_id)
select product.id, product.user_id from public.owned_products as product
on conflict (owned_product_id) do nothing;

-- ===========================================================================
-- 4. Candidate retrieval (product -> recalls). It confirms nothing. The
-- predicate and ranks mirror public.get_recall_candidates exactly (parity is
-- tested in pgTAP); each branch is index-driven and the result is bounded,
-- keyset-paged and deterministically ordered (rank desc, notice id).
-- ===========================================================================
create index recall_notices_title_fts_idx
  on public.recall_notices using gin (pg_catalog.to_tsvector('simple', title));
create index recall_scopes_normalized_brand_idx
  on public.recall_scopes
  ((pg_catalog.lower(pg_catalog.regexp_replace(brand, '[^[:alnum:]]', '', 'g'))))
  where brand is not null;
create index recall_scopes_serial_range_idx
  on public.recall_scopes (recall_notice_id)
  where serial_from is not null or serial_to is not null;
create index recall_scopes_lot_range_idx
  on public.recall_scopes (recall_notice_id)
  where lot_from is not null or lot_to is not null;

create function public.get_owned_product_recall_candidates(
  p_owned_product_id uuid,
  p_after_rank integer default null,
  p_after_recall_id uuid default null,
  p_limit integer default 25
)
returns table (
  recall_notice_id uuid,
  external_id text,
  authority text,
  official_url text,
  title text,
  description text,
  hazard text,
  remedy text,
  recall_date date,
  raw_payload jsonb,
  recall_notice_updated_at timestamptz,
  scopes jsonb,
  jurisdictions jsonb,
  exact_rank integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with product as (
    select
      owned_product.product_name,
      owned_product.serial_number,
      owned_product.lot_number,
      case when owned_product.gtin is not null
        then pg_catalog.regexp_replace(owned_product.gtin, '[^0-9]', '', 'g') end as gtin_key,
      case when owned_product.model_number is not null
        then pg_catalog.lower(pg_catalog.regexp_replace(
          owned_product.model_number, '[^[:alnum:]]', '', 'g')) end as model_key,
      case when owned_product.brand is not null
        then pg_catalog.lower(pg_catalog.regexp_replace(
          owned_product.brand, '[^[:alnum:]]', '', 'g')) end as brand_key,
      (
        select pg_catalog.to_tsquery(
          'simple', pg_catalog.string_agg(pg_catalog.quote_literal(name_token.token), ' | '))
        from pg_catalog.unnest(pg_catalog.tsvector_to_array(
          pg_catalog.to_tsvector('simple', owned_product.product_name))) as name_token(token)
        where pg_catalog.length(name_token.token) >= 3
      ) as name_query
    from public.owned_products as owned_product
    where owned_product.id = p_owned_product_id
  ),
  hits as (
    select scope.recall_notice_id, 4 as rank
    from product
    join public.recall_scopes as scope
      on scope.gtin is not null
      and pg_catalog.regexp_replace(scope.gtin, '[^0-9]', '', 'g') = product.gtin_key
    union all
    select scope.recall_notice_id, 3
    from product
    join public.recall_scopes as scope
      on product.serial_number is not null
      and (scope.serial_from is not null or scope.serial_to is not null)
    union all
    select scope.recall_notice_id, 3
    from product
    join public.recall_scopes as scope
      on product.lot_number is not null
      and (scope.lot_from is not null or scope.lot_to is not null)
    union all
    select scope.recall_notice_id, 2
    from product
    join public.recall_scopes as scope
      on scope.model_number is not null
      and pg_catalog.lower(pg_catalog.regexp_replace(
        scope.model_number, '[^[:alnum:]]', '', 'g')) = product.model_key
    union all
    select scope.recall_notice_id, 1
    from product
    join public.recall_scopes as scope
      on scope.brand is not null
      and pg_catalog.lower(pg_catalog.regexp_replace(
        scope.brand, '[^[:alnum:]]', '', 'g')) = product.brand_key
    union all
    select scope.recall_notice_id, 1
    from product
    join public.recall_scopes as scope
      on product.product_name is not null
      and scope.product_name is not null
      and pg_catalog.to_tsvector('simple', coalesce(scope.product_name, ''))
        @@ product.name_query
    union all
    select notice.id, 1
    from product
    join public.recall_notices as notice
      on product.product_name is not null
      and pg_catalog.to_tsvector('simple', notice.title) @@ product.name_query
  ),
  ranked as (
    select hit.recall_notice_id, max(hit.rank) as exact_rank
    from hits as hit
    group by hit.recall_notice_id
  )
  select
    notice.id,
    notice.external_id,
    source.name,
    notice.official_url,
    notice.title,
    notice.description,
    notice.hazard,
    notice.remedy,
    notice.recall_date,
    notice.raw_payload,
    notice.updated_at,
    coalesce(scope_projection.scopes, '[]'::jsonb),
    coalesce(jurisdiction_projection.jurisdictions, '[]'::jsonb),
    ranked.exact_rank
  from ranked
  join public.recall_notices as notice on notice.id = ranked.recall_notice_id
  join public.recall_sources as source on source.id = notice.source_id
  left join lateral (
    -- Same canonical scope projection as get_recall_matching_batch.
    select pg_catalog.jsonb_agg(canonical_scope.scope_json
      order by canonical_scope.scope_sort_key) as scopes
    from (
      select
        pg_catalog.jsonb_build_object(
          'brand', scope.brand,
          'product_name', scope.product_name,
          'gtin', scope.gtin,
          'model_number', scope.model_number,
          'lot_from', scope.lot_from,
          'lot_to', scope.lot_to,
          'serial_from', scope.serial_from,
          'serial_to', scope.serial_to,
          'manufactured_from', scope.manufactured_from,
          'manufactured_to', scope.manufactured_to,
          'additional_criteria', scope.additional_criteria
        ) as scope_json,
        concat_ws(
          chr(31),
          coalesce(scope.brand, ''),
          coalesce(scope.product_name, ''),
          coalesce(scope.gtin, ''),
          coalesce(scope.model_number, ''),
          coalesce(scope.lot_from, ''),
          coalesce(scope.lot_to, ''),
          coalesce(scope.serial_from, ''),
          coalesce(scope.serial_to, ''),
          coalesce(scope.manufactured_from::text, ''),
          coalesce(scope.manufactured_to::text, ''),
          coalesce(scope.additional_criteria::text, '')
        ) as scope_sort_key
      from public.recall_scopes as scope
      where scope.recall_notice_id = notice.id
    ) as canonical_scope
  ) as scope_projection on true
  left join lateral (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'type', jurisdiction.jurisdiction_type, 'code', jurisdiction.jurisdiction_code)
      order by jurisdiction.jurisdiction_type, jurisdiction.jurisdiction_code
    ) as jurisdictions
    from public.recall_notice_jurisdictions as jurisdiction
    where jurisdiction.recall_notice_id = notice.id
  ) as jurisdiction_projection on true
  where source.is_authoritative
    and (
      p_after_rank is null
      or ranked.exact_rank < p_after_rank
      or (ranked.exact_rank = p_after_rank and notice.id > p_after_recall_id)
    )
  order by ranked.exact_rank desc, notice.id
  limit least(greatest(coalesce(p_limit, 1), 1), 100);
$$;
revoke all on function public.get_owned_product_recall_candidates(uuid, integer, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_owned_product_recall_candidates(uuid, integer, uuid, integer)
  to service_role;

-- ===========================================================================
-- 5. Monitoring state, derived (never stored twice). Priority:
--   recall_detected > check_failed > checking > check_failed_retrying
--   > pending_check > possible_match_needs_verification > monitored_no_known_recall
-- "monitored_no_known_recall" means only: no matching recall was found in the
-- currently monitored sources with the available evidence.
-- ===========================================================================
create function private.owned_product_monitoring_state(p_owned_product_id uuid)
returns table (
  state text,
  checked_at timestamptz,
  possible_matches integer,
  confirmed_alerts integer,
  retrying boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with job as (
    select * from private.owned_product_recall_checks as check_job
    where check_job.owned_product_id = p_owned_product_id
  ),
  latest as (
    select distinct on (evaluation.recall_notice_id)
      evaluation.recall_notice_id, evaluation.status, evaluation.evaluated_at
    from private.recall_match_evaluations_v2 as evaluation
    where evaluation.owned_product_id = p_owned_product_id
    order by evaluation.recall_notice_id, evaluation.observation_seq desc
  ),
  counts as (
    select
      (
        (select count(*) from private.recall_alert_snapshots_v2 as snapshot
          join latest on latest.recall_notice_id = snapshot.recall_notice_id
            and latest.status = 'confirmed'
          where snapshot.owned_product_id = p_owned_product_id)
        + (select count(*) from public.alerts as alert
          join public.recall_matches as legacy on legacy.id = alert.recall_match_id
          where legacy.owned_product_id = p_owned_product_id
            and legacy.status = 'confirmed')
      )::integer as confirmed_alerts,
      (select count(*) from latest, job
        where latest.status = 'needs_review'
          and latest.evaluated_at >= job.armed_at)::integer as possible_matches
  )
  select
    case
      when counts.confirmed_alerts > 0 then 'recall_detected'
      when job.owned_product_id is null then 'pending_check'
      when job.status = 'failed' then 'check_failed'
      when job.status = 'running' and job.lease_expires_at > pg_catalog.now() then 'checking'
      when job.status <> 'complete' and job.attempts > 0 then 'check_failed_retrying'
      when job.status <> 'complete' then 'pending_check'
      when counts.possible_matches > 0 then 'possible_match_needs_verification'
      else 'monitored_no_known_recall'
    end,
    job.checked_at,
    counts.possible_matches,
    counts.confirmed_alerts,
    coalesce(job.status in ('pending', 'running') and job.attempts > 0
      and not (job.status = 'running' and job.lease_expires_at > pg_catalog.now()), false)
  from counts
  left join job on true;
$$;
revoke all on function private.owned_product_monitoring_state(uuid)
  from public, anon, authenticated, service_role;

create function private.owned_product_check_backoff(p_attempts integer)
returns interval language sql immutable set search_path = '' as $$
  select case
    when p_attempts <= 1 then interval '1 minute'
    when p_attempts = 2 then interval '5 minutes'
    when p_attempts = 3 then interval '30 minutes'
    when p_attempts = 4 then interval '2 hours'
    else interval '6 hours'
  end;
$$;
revoke all on function private.owned_product_check_backoff(integer)
  from public, anon, authenticated, service_role;

-- Claims one locked job row: lease, attempt count, journal entry.
create function private.claim_owned_product_recall_check_row(
  p_owned_product_id uuid,
  p_path text,
  p_lease_seconds integer
)
returns table (lease_token uuid, matching_revision bigint, attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.owned_product_recall_checks%rowtype;
begin
  update private.owned_product_recall_checks as job
  set status = 'running',
    lease_token = gen_random_uuid(),
    lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(
      secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 300)),
    attempts = job.attempts + 1,
    updated_at = pg_catalog.now()
  where job.owned_product_id = p_owned_product_id
  returning job.* into v_job;

  insert into private.owned_product_recall_check_events
    (owned_product_id, user_id, matching_revision, event, path)
  values (v_job.owned_product_id, v_job.user_id, v_job.matching_revision, 'claimed', p_path);

  lease_token := v_job.lease_token;
  matching_revision := v_job.matching_revision;
  attempts := v_job.attempts;
  return next;
end;
$$;
revoke all on function private.claim_owned_product_recall_check_row(uuid, text, integer)
  from public, anon, authenticated, service_role;

-- ===========================================================================
-- 6. Claim for the user path. p_user_id comes from the Edge Function's verified
-- JWT, never from the request body. A product of another user and a missing
-- product are indistinguishable ('not_found').
-- ===========================================================================
create function public.claim_owned_product_recall_check(
  p_owned_product_id uuid,
  p_user_id uuid,
  p_lease_seconds integer default 120
)
returns table (
  status text,
  lease_token uuid,
  matching_revision bigint,
  product_updated_at timestamptz,
  purchase_country_code text,
  cursor_rank integer,
  cursor_recall_id uuid,
  max_candidates integer,
  state text,
  checked_at timestamptz,
  possible_matches integer,
  confirmed_alerts integer,
  retrying boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control private.recall_automation_control%rowtype;
  v_job private.owned_product_recall_checks%rowtype;
  v_product public.owned_products%rowtype;
  v_claim record;
begin
  if p_owned_product_id is null or p_user_id is null then
    raise exception 'product and user are required';
  end if;

  select * into v_product from public.owned_products as product
  where product.id = p_owned_product_id and product.user_id = p_user_id;
  if not found then
    status := 'not_found';
    return next;
    return;
  end if;

  select * into v_job from private.owned_product_recall_checks as job
  where job.owned_product_id = p_owned_product_id
  for update;
  if not found or v_job.user_id is distinct from p_user_id then
    status := 'not_found';
    return next;
    return;
  end if;

  select * into v_control from private.recall_automation_control where singleton;

  if not coalesce(v_control.product_check_enabled, false) then
    status := 'disabled';
  elsif v_job.status = 'complete' then
    status := 'complete';
  elsif v_job.status = 'running' and v_job.lease_expires_at > pg_catalog.now() then
    status := 'busy';
  elsif v_job.available_at > pg_catalog.now() then
    status := 'not_due';
  elsif (
    select count(*) from private.owned_product_recall_check_events as event
    where event.user_id = p_user_id and event.event = 'claimed' and event.path = 'user'
      and event.recorded_at > pg_catalog.now() - interval '1 hour'
  ) >= 60 then
    status := 'rate_limited';
  else
    select * into v_claim from private.claim_owned_product_recall_check_row(
      p_owned_product_id, 'user', p_lease_seconds);
    status := 'claimed';
    lease_token := v_claim.lease_token;
    matching_revision := v_claim.matching_revision;
    product_updated_at := v_product.updated_at;
    purchase_country_code := v_product.purchase_country_code;
    cursor_rank := v_job.cursor_rank;
    cursor_recall_id := v_job.cursor_recall_id;
    max_candidates := v_control.max_product_check_candidates;
  end if;

  select monitoring.state, monitoring.checked_at, monitoring.possible_matches,
    monitoring.confirmed_alerts, monitoring.retrying
  into state, checked_at, possible_matches, confirmed_alerts, retrying
  from private.owned_product_monitoring_state(p_owned_product_id) as monitoring;
  return next;
end;
$$;
revoke all on function public.claim_owned_product_recall_check(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_owned_product_recall_check(uuid, uuid, integer)
  to service_role;

-- ===========================================================================
-- 7. Atomic claim of due jobs for the admin worker (not scheduled in 17.7a-1).
-- An expired lease past the attempt budget becomes an explicit 'failed' state.
-- ===========================================================================
create function public.claim_due_owned_product_recall_checks(
  p_limit integer default 5,
  p_lease_seconds integer default 120
)
returns table (
  owned_product_id uuid,
  lease_token uuid,
  matching_revision bigint,
  product_updated_at timestamptz,
  purchase_country_code text,
  cursor_rank integer,
  cursor_recall_id uuid,
  max_candidates integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control private.recall_automation_control%rowtype;
  v_job private.owned_product_recall_checks%rowtype;
  v_claim record;
begin
  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception 'invalid product check claim limit';
  end if;
  select * into v_control from private.recall_automation_control where singleton;
  if not coalesce(v_control.product_check_enabled, false) then
    return;
  end if;

  for v_job in
    select * from private.owned_product_recall_checks as job
    where (job.status = 'pending' and job.available_at <= pg_catalog.now())
      or (job.status = 'running' and job.lease_expires_at <= pg_catalog.now())
      or (job.status = 'failed' and job.available_at <= pg_catalog.now())
    order by job.available_at, job.owned_product_id
    limit p_limit
    for update skip locked
  loop
    if v_job.status = 'running' and v_job.attempts >= 8 then
      update private.owned_product_recall_checks as job
      set status = 'failed', lease_token = null, lease_expires_at = null,
        last_error = 'timeout', available_at = pg_catalog.now() + interval '24 hours',
        updated_at = pg_catalog.now()
      where job.owned_product_id = v_job.owned_product_id;
      insert into private.owned_product_recall_check_events
        (owned_product_id, user_id, matching_revision, event, path, detail)
      values (v_job.owned_product_id, v_job.user_id, v_job.matching_revision,
        'exhausted', 'worker', 'lease_expired');
      continue;
    end if;
    select * into v_claim from private.claim_owned_product_recall_check_row(
      v_job.owned_product_id, 'worker', p_lease_seconds);
    owned_product_id := v_job.owned_product_id;
    lease_token := v_claim.lease_token;
    matching_revision := v_claim.matching_revision;
    select product.updated_at, product.purchase_country_code
    into product_updated_at, purchase_country_code
    from public.owned_products as product where product.id = v_job.owned_product_id;
    cursor_rank := v_job.cursor_rank;
    cursor_recall_id := v_job.cursor_recall_id;
    max_candidates := v_control.max_product_check_candidates;
    return next;
  end loop;
end;
$$;
revoke all on function public.claim_due_owned_product_recall_checks(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_owned_product_recall_checks(integer, integer)
  to service_role;

-- ===========================================================================
-- 8. Completion. Only the live lease holder can record an outcome; a product
-- edited during the check is re-queued for its new revision.
--   complete -> state complete for this revision
--   continue -> progress kept (cursor), queued again immediately
--   retry    -> bounded backoff; the 8th unresolved attempt is 'failed'
--               (retried at most once per 24 h, re-armed by any relevant edit)
-- ===========================================================================
create function public.complete_owned_product_recall_check(
  p_owned_product_id uuid,
  p_lease_token uuid,
  p_matching_revision bigint,
  p_outcome text,
  p_error text default null,
  p_cursor_rank integer default null,
  p_cursor_recall_id uuid default null,
  p_path text default 'user'
)
returns table (
  status text,
  state text,
  checked_at timestamptz,
  possible_matches integer,
  confirmed_alerts integer,
  retrying boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.owned_product_recall_checks%rowtype;
begin
  if p_outcome is null or p_outcome not in ('complete', 'continue', 'retry')
    or (p_outcome = 'retry') <> (p_error is not null)
    or (p_error is not null
      and p_error not in ('busy', 'stale', 'failure', 'timeout', 'product_changed'))
    or (p_outcome = 'continue') <> (p_cursor_rank is not null and p_cursor_recall_id is not null)
    or (p_outcome <> 'continue' and (p_cursor_rank is not null or p_cursor_recall_id is not null))
    or p_path is null or p_path not in ('user', 'worker') then
    raise exception 'invalid product check outcome';
  end if;

  select * into v_job from private.owned_product_recall_checks as job
  where job.owned_product_id = p_owned_product_id
  for update;
  if not found then
    status := 'missing';
    return next;
    return;
  end if;

  if v_job.status <> 'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= pg_catalog.now() then
    status := 'stale_lease';
  elsif v_job.matching_revision <> p_matching_revision then
    update private.owned_product_recall_checks as job
    set status = 'pending', lease_token = null, lease_expires_at = null, attempts = 0,
      available_at = pg_catalog.now(), cursor_rank = null, cursor_recall_id = null,
      last_error = null, updated_at = pg_catalog.now()
    where job.owned_product_id = p_owned_product_id;
    insert into private.owned_product_recall_check_events
      (owned_product_id, user_id, matching_revision, event, path)
    values (v_job.owned_product_id, v_job.user_id, v_job.matching_revision, 'rearmed', p_path);
    status := 'rearmed';
  elsif p_outcome = 'complete' then
    update private.owned_product_recall_checks as job
    set status = 'complete', lease_token = null, lease_expires_at = null,
      cursor_rank = null, cursor_recall_id = null, last_error = null,
      completed_revision = job.matching_revision, checked_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
    where job.owned_product_id = p_owned_product_id;
    insert into private.owned_product_recall_check_events
      (owned_product_id, user_id, matching_revision, event, path)
    values (v_job.owned_product_id, v_job.user_id, v_job.matching_revision, 'completed', p_path);
    status := 'completed';
  elsif p_outcome = 'continue' then
    update private.owned_product_recall_checks as job
    set status = 'pending', lease_token = null, lease_expires_at = null, attempts = 0,
      available_at = pg_catalog.now(), cursor_rank = p_cursor_rank,
      cursor_recall_id = p_cursor_recall_id, last_error = null, updated_at = pg_catalog.now()
    where job.owned_product_id = p_owned_product_id;
    insert into private.owned_product_recall_check_events
      (owned_product_id, user_id, matching_revision, event, path)
    values (v_job.owned_product_id, v_job.user_id, v_job.matching_revision, 'continued', p_path);
    status := 'continued';
  elsif v_job.attempts >= 8 then
    update private.owned_product_recall_checks as job
    set status = 'failed', lease_token = null, lease_expires_at = null,
      available_at = pg_catalog.now() + interval '24 hours', last_error = p_error,
      updated_at = pg_catalog.now()
    where job.owned_product_id = p_owned_product_id;
    insert into private.owned_product_recall_check_events
      (owned_product_id, user_id, matching_revision, event, path, detail)
    values (v_job.owned_product_id, v_job.user_id, v_job.matching_revision,
      'exhausted', p_path, p_error);
    status := 'exhausted';
  else
    update private.owned_product_recall_checks as job
    set status = 'pending', lease_token = null, lease_expires_at = null,
      available_at = pg_catalog.now() + private.owned_product_check_backoff(job.attempts),
      last_error = p_error, updated_at = pg_catalog.now()
    where job.owned_product_id = p_owned_product_id;
    insert into private.owned_product_recall_check_events
      (owned_product_id, user_id, matching_revision, event, path, detail)
    values (v_job.owned_product_id, v_job.user_id, v_job.matching_revision,
      'retry', p_path, p_error);
    status := 'retrying';
  end if;

  select monitoring.state, monitoring.checked_at, monitoring.possible_matches,
    monitoring.confirmed_alerts, monitoring.retrying
  into state, checked_at, possible_matches, confirmed_alerts, retrying
  from private.owned_product_monitoring_state(p_owned_product_id) as monitoring;
  return next;
end;
$$;
revoke all on function public.complete_owned_product_recall_check(
  uuid, uuid, bigint, text, text, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.complete_owned_product_recall_check(
  uuid, uuid, bigint, text, text, integer, uuid, text) to service_role;

-- ===========================================================================
-- 9. Owner-only monitoring read model for the app.
-- ===========================================================================
create function public.get_my_product_monitoring_states(p_owned_product_ids uuid[] default null)
returns table (
  owned_product_id uuid,
  state text,
  checked_at timestamptz,
  possible_matches integer,
  confirmed_alerts integer,
  retrying boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(pg_catalog.cardinality(p_owned_product_ids), 0) > 100 then
    raise exception 'at most 100 products per request';
  end if;
  return query
  select product.id, monitoring.state, monitoring.checked_at, monitoring.possible_matches,
    monitoring.confirmed_alerts, monitoring.retrying
  from public.owned_products as product
  cross join lateral private.owned_product_monitoring_state(product.id) as monitoring
  where product.user_id = (select auth.uid())
    and (p_owned_product_ids is null or product.id = any (p_owned_product_ids))
  order by product.id
  limit 500;
end;
$$;
revoke all on function public.get_my_product_monitoring_states(uuid[]) from public, anon;
grant execute on function public.get_my_product_monitoring_states(uuid[]) to authenticated;

commit;
