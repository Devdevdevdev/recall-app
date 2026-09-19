begin;

create or replace function public.protect_recall_notice_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source_key text;
  v_source_base_url text;
  v_notice_protocol text;
  v_notice_host text;
begin
  if tg_op = 'UPDATE'
    and (
      new.source_id is distinct from old.source_id
      or new.external_id is distinct from old.external_id
    ) then
    raise exception 'recall notice source_id and external_id are immutable';
  end if;

  select recall_source.source_key, recall_source.base_url
  into v_source_key, v_source_base_url
  from public.recall_sources as recall_source
  where recall_source.id = new.source_id;

  v_notice_protocol := lower(
    substring(lower(new.official_url) from '^([a-z][a-z0-9+.-]*):')
  );
  v_notice_host := lower(
    substring(lower(new.official_url) from '^https?://([^/@:?#[:space:]]+)')
  );

  if v_source_key = 'cpsc' then
    if v_notice_protocol is distinct from 'https'
      or v_notice_host is null
      or v_notice_host not in ('cpsc.gov', 'www.cpsc.gov') then
      raise exception 'recall notice official_url must use an allowed HTTPS CPSC host';
    end if;
  elsif v_notice_host is distinct from lower(
    substring(v_source_base_url from '^https?://([^/@:?#[:space:]]+)')
  ) then
    raise exception 'recall notice official_url must use the recall source host';
  end if;

  return new;
end;
$$;

commit;
