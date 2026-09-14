begin;

create function public.ensure_cpsc_recall_source()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_id uuid;
begin
  -- Serialize source creation because the original Phase 2 schema intentionally has no source
  -- identity uniqueness constraint. This leaves all prior migrations unchanged.
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
    insert into public.recall_sources (name, jurisdiction, base_url, is_authoritative)
    values (
      'U.S. Consumer Product Safety Commission (CPSC)',
      'US',
      'https://www.cpsc.gov',
      true
    )
    returning id into v_source_id;
  else
    update public.recall_sources
    set is_authoritative = true
    where id = v_source_id;
  end if;

  return v_source_id;
end;
$$;

create function public.ingest_cpsc_recall(
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

commit;
