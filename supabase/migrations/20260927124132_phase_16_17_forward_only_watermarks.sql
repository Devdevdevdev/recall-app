-- Phase 16.17: validate the date cursor at the database trust boundary. Normal
-- ingestion cannot clear or rewind an established cursor. An intentional reset
-- requires a separately reviewed migration; no worker bypass is provided.
begin;

create function private.guard_recall_source_watermark_forward()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_source_key text;
  v_expected_kind text;
  v_old_value text;
  v_new_value text;
  v_old_date date;
  v_new_date date;
begin
  if tg_op = 'UPDATE' and new.source_id is distinct from old.source_id then
    raise exception 'source watermark source_id cannot change' using errcode = '23514';
  end if;

  select source_key into v_source_key
  from public.recall_sources where id = new.source_id;
  v_expected_kind := case v_source_key
    when 'cpsc' then 'last_publish_date'
    when 'health_canada' then 'last_updated_date'
    else null
  end;
  if v_expected_kind is null then
    raise exception 'source watermark has no comparison policy for source %',
      coalesce(v_source_key, '<unknown>') using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and old.watermark is not null then
    if jsonb_typeof(old.watermark) <> 'object'
      or (select count(*) from jsonb_object_keys(old.watermark)) <> 2
      or old.watermark ->> 'kind' is distinct from v_expected_kind
      or jsonb_typeof(old.watermark -> 'value') <> 'string' then
      raise exception 'source watermark existing cursor is malformed or has an unexpected kind'
        using errcode = '23514';
    end if;
    v_old_value := old.watermark ->> 'value';
    if v_old_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'source watermark existing date must be YYYY-MM-DD' using errcode = '23514';
    end if;
    begin
      v_old_date := v_old_value::date;
    exception when datetime_field_overflow or invalid_datetime_format then
      raise exception 'source watermark existing date is invalid' using errcode = '23514';
    end;
    if to_char(v_old_date, 'YYYY-MM-DD') <> v_old_value then
      raise exception 'source watermark existing date is invalid' using errcode = '23514';
    end if;
  end if;

  if new.watermark is null then
    if v_old_date is not null then
      raise exception 'source watermark cannot be cleared by normal ingestion'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if jsonb_typeof(new.watermark) <> 'object'
    or (select count(*) from jsonb_object_keys(new.watermark)) <> 2
    or new.watermark ->> 'kind' is distinct from v_expected_kind
    or jsonb_typeof(new.watermark -> 'value') <> 'string' then
    raise exception 'source watermark cursor is malformed or has an unexpected kind'
      using errcode = '23514';
  end if;
  v_new_value := new.watermark ->> 'value';
  if v_new_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'source watermark date must be YYYY-MM-DD' using errcode = '23514';
  end if;
  begin
    v_new_date := v_new_value::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'source watermark date is invalid' using errcode = '23514';
  end;
  if to_char(v_new_date, 'YYYY-MM-DD') <> v_new_value then
    raise exception 'source watermark date is invalid' using errcode = '23514';
  end if;
  if v_old_date is not null and v_new_date < v_old_date then
    raise exception 'source watermark cannot move backward from % to %',
      v_old_value, v_new_value using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_recall_source_watermark_forward
  before insert or update of source_id, watermark
  on private.recall_source_sync_state
  for each row execute function private.guard_recall_source_watermark_forward();

create function private.guard_recall_automation_watermark_forward()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.last_successful_watermark is not null
    and (new.last_successful_watermark is null
      or new.last_successful_watermark < old.last_successful_watermark) then
    raise exception 'automation watermark cannot move backward or be cleared'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger guard_recall_automation_watermark_forward
  before insert or update of last_successful_watermark
  on private.recall_automation_state
  for each row execute function private.guard_recall_automation_watermark_forward();

revoke all on function private.guard_recall_source_watermark_forward() from public, anon, authenticated, service_role;
revoke all on function private.guard_recall_automation_watermark_forward() from public, anon, authenticated, service_role;
commit;
