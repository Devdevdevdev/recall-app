begin;

create table public.country_codes (
  code text primary key,
  constraint country_codes_code_check check (code ~ '^[A-Z]{2}$')
);

alter table public.country_codes enable row level security;

insert into public.country_codes (code)
select code
from pg_catalog.unnest(array[
  'AF', 'AX', 'AL', 'DZ', 'AS', 'AD', 'AO', 'AI', 'AQ', 'AG', 'AR', 'AM', 'AW', 'AU',
  'AT', 'AZ', 'BS', 'BH', 'BD', 'BB', 'BY', 'BE', 'BZ', 'BJ', 'BM', 'BT', 'BO', 'BQ',
  'BA', 'BW', 'BV', 'BR', 'IO', 'BN', 'BG', 'BF', 'BI', 'CV', 'KH', 'CM', 'CA', 'KY',
  'CF', 'TD', 'CL', 'CN', 'CX', 'CC', 'CO', 'KM', 'CG', 'CD', 'CK', 'CR', 'CI', 'HR',
  'CU', 'CW', 'CY', 'CZ', 'DK', 'DJ', 'DM', 'DO', 'EC', 'EG', 'SV', 'GQ', 'ER', 'EE',
  'SZ', 'ET', 'FK', 'FO', 'FJ', 'FI', 'FR', 'GF', 'PF', 'TF', 'GA', 'GM', 'GE', 'DE',
  'GH', 'GI', 'GR', 'GL', 'GD', 'GP', 'GU', 'GT', 'GG', 'GN', 'GW', 'GY', 'HT', 'HM',
  'VA', 'HN', 'HK', 'HU', 'IS', 'IN', 'ID', 'IR', 'IQ', 'IE', 'IM', 'IL', 'IT', 'JM',
  'JP', 'JE', 'JO', 'KZ', 'KE', 'KI', 'KP', 'KR', 'KW', 'KG', 'LA', 'LV', 'LB', 'LS',
  'LR', 'LY', 'LI', 'LT', 'LU', 'MO', 'MG', 'MW', 'MY', 'MV', 'ML', 'MT', 'MH', 'MQ',
  'MR', 'MU', 'YT', 'MX', 'FM', 'MD', 'MC', 'MN', 'ME', 'MS', 'MA', 'MZ', 'MM', 'NA',
  'NR', 'NP', 'NL', 'NC', 'NZ', 'NI', 'NE', 'NG', 'NU', 'NF', 'MK', 'MP', 'NO', 'OM',
  'PK', 'PW', 'PS', 'PA', 'PG', 'PY', 'PE', 'PH', 'PN', 'PL', 'PT', 'PR', 'QA', 'RE',
  'RO', 'RU', 'RW', 'BL', 'SH', 'KN', 'LC', 'MF', 'PM', 'VC', 'WS', 'SM', 'ST', 'SA',
  'SN', 'RS', 'SC', 'SL', 'SG', 'SX', 'SK', 'SI', 'SB', 'SO', 'ZA', 'GS', 'SS', 'ES',
  'LK', 'SD', 'SR', 'SJ', 'SE', 'CH', 'SY', 'TW', 'TJ', 'TZ', 'TH', 'TL', 'TG', 'TK',
  'TO', 'TT', 'TN', 'TR', 'TM', 'TC', 'TV', 'UG', 'UA', 'AE', 'GB', 'US', 'UM', 'UY',
  'UZ', 'VU', 'VE', 'VN', 'VG', 'VI', 'WF', 'EH', 'YE', 'ZM', 'ZW'
]::text[]) as supported_country(code);

revoke all on table public.country_codes from public, anon, authenticated;

alter table public.owned_products
  add column purchase_country_code text references public.country_codes (code),
  add constraint owned_products_purchase_country_code_check check (
    purchase_country_code is null
    or purchase_country_code ~ '^[A-Z]{2}$'
  );

create table public.user_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  default_purchase_country_code text references public.country_codes (code),
  constraint user_preferences_default_purchase_country_code_check check (
    default_purchase_country_code is null
    or default_purchase_country_code ~ '^[A-Z]{2}$'
  )
);

alter table public.user_preferences enable row level security;

create policy "Users can manage their own preferences"
on public.user_preferences
for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

revoke all on table public.user_preferences from public, anon, authenticated;
grant select, insert, update, delete on table public.user_preferences to authenticated;

create table public.recall_notice_jurisdictions (
  id uuid primary key default gen_random_uuid(),
  recall_notice_id uuid not null references public.recall_notices (id) on delete cascade,
  jurisdiction_type text not null,
  jurisdiction_code text not null,
  jurisdiction_country_code text generated always as (
    case when jurisdiction_type = 'country' then jurisdiction_code end
  ) stored references public.country_codes (code),
  created_at timestamptz not null default now(),
  constraint recall_notice_jurisdictions_type_check check (
    jurisdiction_type in ('country', 'region', 'global')
  ),
  constraint recall_notice_jurisdictions_code_check check (
    (jurisdiction_type = 'country' and jurisdiction_code ~ '^[A-Z]{2}$')
    or (
      jurisdiction_type = 'region'
      and jurisdiction_code ~ '^[A-Z][A-Z0-9]{1,7}$'
    )
    or (jurisdiction_type = 'global' and jurisdiction_code = 'GLOBAL')
  ),
  unique (recall_notice_id, jurisdiction_type, jurisdiction_code)
);

alter table public.recall_notice_jurisdictions enable row level security;

create policy "Authenticated users can read authoritative recall jurisdictions"
on public.recall_notice_jurisdictions
for select
to authenticated
using (
  exists (
    select 1
    from public.recall_notices as recall_notice
    join public.recall_sources as recall_source
      on recall_source.id = recall_notice.source_id
    where recall_notice.id = recall_notice_jurisdictions.recall_notice_id
      and recall_source.is_authoritative
  )
);

revoke all on table public.recall_notice_jurisdictions from public, anon, authenticated;
grant select on table public.recall_notice_jurisdictions to authenticated;

alter table public.recall_sources
  add column source_language_code text,
  add constraint recall_sources_source_language_code_check check (
    source_language_code is null
    or source_language_code ~ '^[a-z]{2}$'
  );

update public.recall_sources
set source_language_code = 'en'
where name = 'U.S. Consumer Product Safety Commission (CPSC)'
  and jurisdiction = 'US'
  and base_url = 'https://www.cpsc.gov'
  and source_language_code is distinct from 'en';

insert into public.recall_notice_jurisdictions (
  recall_notice_id,
  jurisdiction_type,
  jurisdiction_code
)
select
  recall_notice.id,
  'country',
  'US'
from public.recall_notices as recall_notice
join public.recall_sources as recall_source
  on recall_source.id = recall_notice.source_id
where recall_source.name = 'U.S. Consumer Product Safety Commission (CPSC)'
  and recall_source.jurisdiction = 'US'
  and recall_source.base_url = 'https://www.cpsc.gov'
on conflict (recall_notice_id, jurisdiction_type, jurisdiction_code) do nothing;

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
  where recall_source.name = 'U.S. Consumer Product Safety Commission (CPSC)'
    and recall_source.jurisdiction = 'US'
    and recall_source.base_url = 'https://www.cpsc.gov'
  order by recall_source.created_at
  limit 1;

  if v_source_id is null then
    insert into public.recall_sources (
      name,
      jurisdiction,
      base_url,
      is_authoritative,
      source_language_code
    )
    values (
      'U.S. Consumer Product Safety Commission (CPSC)',
      'US',
      'https://www.cpsc.gov',
      true,
      'en'
    )
    returning id into v_source_id;
  else
    update public.recall_sources
    set
      is_authoritative = true,
      source_language_code = 'en'
    where id = v_source_id
      and (
        is_authoritative is distinct from true
        or source_language_code is distinct from 'en'
      );
  end if;

  return v_source_id;
end;
$$;

create or replace function public.ingest_cpsc_recall(
  p_external_id text,
  p_title text,
  p_description text,
  p_hazard text,
  p_remedy text,
  p_recall_date date,
  p_official_url text,
  p_retrieved_at timestamptz,
  p_raw_payload jsonb,
  p_scopes jsonb
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
begin
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
  if pg_catalog.jsonb_typeof(p_scopes) <> 'array' then
    raise exception 'scopes must be an array';
  end if;

  v_source_id := public.ensure_cpsc_recall_source();

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
      source_id,
      external_id,
      title,
      description,
      hazard,
      remedy,
      recall_date,
      official_url,
      retrieved_at,
      raw_payload
    )
    values (
      v_source_id,
      p_external_id,
      p_title,
      p_description,
      p_hazard,
      p_remedy,
      p_recall_date,
      p_official_url,
      p_retrieved_at,
      p_raw_payload
    )
    returning id into v_notice_id;
    v_notice_changed := true;
    v_inserted := true;
  else
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
  end if;

  if v_notice_changed then
    delete from public.recall_scopes where recall_notice_id = v_notice_id;

    for scope in select value from pg_catalog.jsonb_array_elements(p_scopes)
    loop
      insert into public.recall_scopes (
        recall_notice_id,
        product_name,
        gtin,
        model_number,
        additional_criteria
      )
      values (
        v_notice_id,
        nullif(pg_catalog.btrim(scope ->> 'productName'), ''),
        nullif(pg_catalog.btrim(scope ->> 'gtin'), ''),
        nullif(pg_catalog.btrim(scope ->> 'modelNumber'), ''),
        case
          when pg_catalog.jsonb_typeof(scope -> 'additionalCriteria') = 'object'
            then scope -> 'additionalCriteria'
          else null
        end
      );
    end loop;
  end if;

  insert into public.recall_notice_jurisdictions (
    recall_notice_id,
    jurisdiction_type,
    jurisdiction_code
  )
  values (v_notice_id, 'country', 'US')
  on conflict (recall_notice_id, jurisdiction_type, jurisdiction_code) do nothing;

  return case
    when v_inserted then 'inserted'
    when v_notice_changed then 'updated'
    else 'unchanged'
  end;
exception
  when unique_violation then
    raise exception 'CPSC recall identity conflict';
end;
$$;

revoke all on function public.ensure_cpsc_recall_source() from public, anon, authenticated;
revoke all on function public.ingest_cpsc_recall(text, text, text, text, text, date, text, timestamptz, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function public.ensure_cpsc_recall_source() to service_role;
grant execute on function public.ingest_cpsc_recall(text, text, text, text, text, date, text, timestamptz, jsonb, jsonb)
to service_role;

create function public.get_monitoring_status()
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
      select pg_catalog.max(automation_run.completed_at)
      from private.recall_automation_runs as automation_run
      where automation_run.status = 'success'
    ) as last_successful_check_at,
    (
      select pg_catalog.count(*)::integer
      from public.recall_sources as recall_source
      where recall_source.is_authoritative
    ) as active_source_count;
$$;

revoke all on function public.get_monitoring_status() from public, anon, authenticated;
grant execute on function public.get_monitoring_status() to authenticated;

commit;
