begin;

alter table public.owned_products
  add column scan_date date;

-- Legacy clients did not capture a local scan date. UTC is the only stable calendar basis
-- available from the technical creation timestamp, so the backfill is explicit and conservative.
-- The table lock held by ALTER TABLE keeps concurrent writes out while the timestamp trigger is
-- disabled, preventing the backfill from rewriting updated_at and changing inventory order.
alter table public.owned_products disable trigger owned_products_set_updated_at;

update public.owned_products
set scan_date = (created_at at time zone 'UTC')::date
where scan_date is null;

alter table public.owned_products enable trigger owned_products_set_updated_at;

alter table public.owned_products
  alter column scan_date set default current_date,
  alter column scan_date set not null;

create function public.protect_owned_product_created_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.created_at is distinct from old.created_at then
    raise exception 'owned product created_at is immutable';
  end if;

  return new;
end;
$$;

create trigger owned_products_protect_created_at
before update of created_at on public.owned_products
for each row execute function public.protect_owned_product_created_at();

revoke all on function public.protect_owned_product_created_at() from public;

alter table public.recall_sources
  add column source_key text,
  add column is_active boolean not null default false;

update public.recall_sources
set source_key = 'cpsc', is_active = true
where name = 'U.S. Consumer Product Safety Commission (CPSC)'
  and jurisdiction = 'US'
  and base_url = 'https://www.cpsc.gov';

update public.recall_sources
set source_key = 'legacy_' || pg_catalog.substr(pg_catalog.md5(id::text), 1, 24)
where source_key is null;

alter table public.recall_sources
  alter column source_key set not null,
  add constraint recall_sources_source_key_key unique (source_key),
  add constraint recall_sources_source_key_check check (
    source_key ~ '^[a-z][a-z0-9_]{1,39}$'
  );

drop trigger recall_sources_protect_identity on public.recall_sources;

create or replace function public.protect_recall_source_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.source_key is distinct from old.source_key
    or new.name is distinct from old.name
    or new.jurisdiction is distinct from old.jurisdiction
    or new.base_url is distinct from old.base_url then
    raise exception 'recall source identity is immutable';
  end if;

  return new;
end;
$$;

create trigger recall_sources_protect_identity
before update of source_key, name, jurisdiction, base_url on public.recall_sources
for each row execute function public.protect_recall_source_identity();

insert into public.recall_sources (
  source_key,
  name,
  jurisdiction,
  base_url,
  is_authoritative,
  is_active,
  source_language_code
)
values (
  'health_canada',
  'Health Canada Recalls and Safety Alerts',
  'CA',
  'https://recalls-rappels.canada.ca',
  true,
  false,
  'en'
)
on conflict (source_key) do nothing;

-- Keep the established CPSC RPC compatible with the required source key and activation state.
create or replace function public.ensure_cpsc_recall_source()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('recall:cpsc-source:v1'));

  select id
  into v_source_id
  from public.recall_sources as recall_source
  where recall_source.source_key = 'cpsc'
  order by recall_source.created_at
  limit 1;

  if v_source_id is null then
    insert into public.recall_sources (
      source_key,
      name,
      jurisdiction,
      base_url,
      is_authoritative,
      is_active,
      source_language_code
    )
    values (
      'cpsc',
      'U.S. Consumer Product Safety Commission (CPSC)',
      'US',
      'https://www.cpsc.gov',
      true,
      true,
      'en'
    )
    returning id into v_source_id;
  else
    update public.recall_sources
    set
      is_authoritative = true,
      is_active = true,
      source_language_code = 'en'
    where id = v_source_id
      and (
        is_authoritative is distinct from true
        or is_active is distinct from true
        or source_language_code is distinct from 'en'
      );
  end if;

  return v_source_id;
end;
$$;

create table private.recall_source_sync_state (
  source_id uuid primary key references public.recall_sources (id) on delete restrict,
  watermark jsonb,
  last_attempted_at timestamptz,
  last_successful_sync_at timestamptz,
  last_status text check (last_status in ('success', 'failed')),
  last_error_code text,
  last_metrics jsonb,
  updated_at timestamptz not null default now(),
  constraint recall_source_sync_state_watermark_object check (
    watermark is null or pg_catalog.jsonb_typeof(watermark) = 'object'
  ),
  constraint recall_source_sync_state_metrics_object check (
    last_metrics is null or pg_catalog.jsonb_typeof(last_metrics) = 'object'
  ),
  constraint recall_source_sync_state_error_check check (
    (last_status = 'failed' and last_error_code is not null and pg_catalog.btrim(last_error_code) <> '')
    or (last_status is distinct from 'failed' and last_error_code is null)
  )
);

alter table private.recall_source_sync_state enable row level security;
revoke all on table private.recall_source_sync_state from public, anon, authenticated, service_role;

insert into private.recall_source_sync_state (source_id, watermark, last_successful_sync_at)
select
  recall_source.id,
  case
    when recall_source.source_key = 'cpsc' and automation_state.last_successful_watermark is not null
      then pg_catalog.jsonb_build_object(
        'kind', 'last_publish_date',
        'value', automation_state.last_successful_watermark
      )
    else null
  end,
  case
    when recall_source.source_key = 'cpsc' then (
      select pg_catalog.max(automation_run.completed_at)
      from private.recall_automation_runs as automation_run
      where automation_run.status = 'success'
    )
    else null
  end
from public.recall_sources as recall_source
left join private.recall_automation_state as automation_state on automation_state.singleton
where recall_source.source_key in ('cpsc', 'health_canada')
on conflict (source_id) do nothing;

create function public.get_recall_source_sync_state(p_source_key text)
returns table (
  source_key text,
  is_active boolean,
  watermark jsonb,
  last_successful_sync_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    recall_source.source_key,
    recall_source.is_active,
    sync_state.watermark,
    sync_state.last_successful_sync_at
  from public.recall_sources as recall_source
  left join private.recall_source_sync_state as sync_state
    on sync_state.source_id = recall_source.id
  where recall_source.source_key = p_source_key
    and recall_source.is_authoritative;
$$;

create function public.record_recall_source_sync_result(
  p_source_key text,
  p_status text,
  p_watermark jsonb default null,
  p_error_code text default null,
  p_metrics jsonb default null,
  p_now timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_id uuid;
begin
  if p_status not in ('success', 'failed') then
    raise exception 'invalid source sync status';
  end if;
  if p_status = 'success' and p_error_code is not null then
    raise exception 'successful source sync cannot include an error';
  end if;
  if p_status = 'failed' and (p_error_code is null or pg_catalog.btrim(p_error_code) = '') then
    raise exception 'failed source sync requires an error code';
  end if;
  if p_watermark is not null and pg_catalog.jsonb_typeof(p_watermark) <> 'object' then
    raise exception 'source watermark must be an object';
  end if;
  if p_metrics is not null and pg_catalog.jsonb_typeof(p_metrics) <> 'object' then
    raise exception 'source metrics must be an object';
  end if;

  select id into v_source_id
  from public.recall_sources as recall_source
  where recall_source.source_key = p_source_key
    and recall_source.is_authoritative
  for update;

  if v_source_id is null then
    raise exception 'unknown authoritative recall source';
  end if;

  insert into private.recall_source_sync_state (
    source_id,
    watermark,
    last_attempted_at,
    last_successful_sync_at,
    last_status,
    last_error_code,
    last_metrics,
    updated_at
  ) values (
    v_source_id,
    case when p_status = 'success' then p_watermark else null end,
    p_now,
    case when p_status = 'success' then p_now else null end,
    p_status,
    p_error_code,
    p_metrics,
    p_now
  )
  on conflict (source_id) do update
  set
    watermark = case
      when p_status = 'success' then excluded.watermark
      else recall_source_sync_state.watermark
    end,
    last_attempted_at = excluded.last_attempted_at,
    last_successful_sync_at = case
      when p_status = 'success' then excluded.last_successful_sync_at
      else recall_source_sync_state.last_successful_sync_at
    end,
    last_status = excluded.last_status,
    last_error_code = excluded.last_error_code,
    last_metrics = excluded.last_metrics,
    updated_at = excluded.updated_at;
end;
$$;

create function public.get_active_recall_source_keys()
returns table (source_key text)
language sql
security definer
set search_path = ''
stable
as $$
  select recall_source.source_key
  from public.recall_sources as recall_source
  where recall_source.is_authoritative and recall_source.is_active
  order by recall_source.source_key;
$$;

create function public.get_recall_notice_id(p_source_key text, p_external_id text)
returns uuid
language sql
security definer
set search_path = ''
stable
as $$
  select recall_notice.id
  from public.recall_notices as recall_notice
  join public.recall_sources as recall_source on recall_source.id = recall_notice.source_id
  where recall_source.source_key = p_source_key
    and recall_source.is_authoritative
    and recall_notice.external_id = p_external_id
  order by recall_notice.created_at
  limit 1;
$$;

create function public.ingest_authoritative_recall(
  p_source_key text,
  p_external_id text,
  p_title text,
  p_description text,
  p_hazard text,
  p_remedy text,
  p_recall_date date,
  p_official_url text,
  p_retrieved_at timestamptz,
  p_raw_payload jsonb,
  p_scopes jsonb,
  p_jurisdictions jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_id uuid;
  v_notice_id uuid;
  v_notice_changed boolean;
  v_inserted boolean := false;
  scope jsonb;
  jurisdiction jsonb;
begin
  select id into v_source_id
  from public.recall_sources as recall_source
  where recall_source.source_key = p_source_key
    and recall_source.is_authoritative
    and recall_source.is_active
  for update;

  if v_source_id is null then
    raise exception 'recall source is not active';
  end if;
  if p_external_id is null or pg_catalog.btrim(p_external_id) = '' then
    raise exception 'external id is required';
  end if;
  if p_title is null or pg_catalog.btrim(p_title) = '' then
    raise exception 'title is required';
  end if;
  if p_recall_date is null or p_official_url is null or p_retrieved_at is null then
    raise exception 'recall date, official URL, and retrieval time are required';
  end if;
  if pg_catalog.jsonb_typeof(p_raw_payload) <> 'object' then
    raise exception 'raw payload must be an object';
  end if;
  if pg_catalog.jsonb_typeof(p_scopes) <> 'array'
    or pg_catalog.jsonb_typeof(p_jurisdictions) <> 'array' then
    raise exception 'scopes and jurisdictions must be arrays';
  end if;

  select id,
    title is distinct from p_title
      or description is distinct from p_description
      or hazard is distinct from p_hazard
      or remedy is distinct from p_remedy
      or recall_date is distinct from p_recall_date
      or official_url is distinct from p_official_url
      or raw_payload is distinct from p_raw_payload
  into v_notice_id, v_notice_changed
  from public.recall_notices as recall_notice
  where recall_notice.source_id = v_source_id
    and recall_notice.external_id = p_external_id
  for update;

  if v_notice_id is null then
    insert into public.recall_notices (
      source_id, external_id, title, description, hazard, remedy, recall_date,
      official_url, retrieved_at, raw_payload
    ) values (
      v_source_id, p_external_id, p_title, p_description, p_hazard, p_remedy,
      p_recall_date, p_official_url, p_retrieved_at, p_raw_payload
    ) returning id into v_notice_id;
    v_notice_changed := true;
    v_inserted := true;
  elsif v_notice_changed then
    update public.recall_notices
    set
      title = p_title,
      description = p_description,
      hazard = p_hazard,
      remedy = p_remedy,
      recall_date = p_recall_date,
      official_url = p_official_url,
      retrieved_at = p_retrieved_at,
      raw_payload = p_raw_payload
    where id = v_notice_id;
  else
    update public.recall_notices
    set retrieved_at = p_retrieved_at
    where id = v_notice_id;
  end if;

  if v_notice_changed then
    delete from public.recall_scopes where recall_notice_id = v_notice_id;
    for scope in select value from pg_catalog.jsonb_array_elements(p_scopes)
    loop
      insert into public.recall_scopes (
        recall_notice_id, brand, product_name, gtin, model_number,
        lot_from, lot_to, serial_from, serial_to, additional_criteria
      ) values (
        v_notice_id,
        nullif(pg_catalog.btrim(scope ->> 'brand'), ''),
        nullif(pg_catalog.btrim(scope ->> 'productName'), ''),
        nullif(pg_catalog.btrim(scope ->> 'gtin'), ''),
        nullif(pg_catalog.btrim(scope ->> 'modelNumber'), ''),
        nullif(pg_catalog.btrim(scope ->> 'lotFrom'), ''),
        nullif(pg_catalog.btrim(scope ->> 'lotTo'), ''),
        nullif(pg_catalog.btrim(scope ->> 'serialFrom'), ''),
        nullif(pg_catalog.btrim(scope ->> 'serialTo'), ''),
        case
          when pg_catalog.jsonb_typeof(scope -> 'additionalCriteria') = 'object'
            then scope -> 'additionalCriteria'
          else null
        end
      );
    end loop;

    delete from public.recall_notice_jurisdictions where recall_notice_id = v_notice_id;
    for jurisdiction in select value from pg_catalog.jsonb_array_elements(p_jurisdictions)
    loop
      insert into public.recall_notice_jurisdictions (
        recall_notice_id, jurisdiction_type, jurisdiction_code
      ) values (
        v_notice_id,
        jurisdiction ->> 'type',
        jurisdiction ->> 'code'
      );
    end loop;
  end if;

  return case
    when v_inserted then 'inserted'
    when v_notice_changed then 'updated'
    else 'unchanged'
  end;
end;
$$;

revoke all on function public.get_recall_source_sync_state(text) from public, anon, authenticated;
revoke all on function public.record_recall_source_sync_result(text, text, jsonb, text, jsonb, timestamptz)
from public, anon, authenticated;
revoke all on function public.get_active_recall_source_keys() from public, anon, authenticated;
revoke all on function public.get_recall_notice_id(text, text) from public, anon, authenticated;
revoke all on function public.ingest_authoritative_recall(text, text, text, text, text, text, date, text, timestamptz, jsonb, jsonb, jsonb)
from public, anon, authenticated;

grant execute on function public.get_recall_source_sync_state(text) to service_role;
grant execute on function public.record_recall_source_sync_result(text, text, jsonb, text, jsonb, timestamptz)
to service_role;
grant execute on function public.get_active_recall_source_keys() to service_role;
grant execute on function public.get_recall_notice_id(text, text) to service_role;
grant execute on function public.ingest_authoritative_recall(text, text, text, text, text, text, date, text, timestamptz, jsonb, jsonb, jsonb)
to service_role;

create or replace function public.get_monitoring_status()
returns table (
  monitoring_enabled boolean,
  last_successful_check_at timestamptz,
  active_source_count integer
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    coalesce(
      (
        select automation_control.enabled
          and exists (
            select 1
            from cron.job as scheduled_job
            where scheduled_job.jobname = 'recall-automation-every-6h'
              and scheduled_job.active
          )
        from private.recall_automation_control as automation_control
        where automation_control.singleton
      ),
      false
    ) as monitoring_enabled,
    (
      select pg_catalog.max(sync_state.last_successful_sync_at)
      from private.recall_source_sync_state as sync_state
      join public.recall_sources as recall_source on recall_source.id = sync_state.source_id
      where recall_source.is_authoritative and recall_source.is_active
    ) as last_successful_check_at,
    (
      select pg_catalog.count(*)::integer
      from public.recall_sources as recall_source
      where recall_source.is_authoritative and recall_source.is_active
    ) as active_source_count;
$$;

commit;
