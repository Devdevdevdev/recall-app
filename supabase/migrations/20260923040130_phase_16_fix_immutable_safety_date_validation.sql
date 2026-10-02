begin;

create or replace function public.validate_owned_product_safety_attributes(attributes jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  attribute_key text;
  attribute_json jsonb;
  attribute_value text;
begin
  if pg_catalog.jsonb_typeof(attributes) <> 'object' then
    return false;
  end if;

  for attribute_key, attribute_json in
    select attribute.key, attribute.value
    from pg_catalog.jsonb_each(attributes) as attribute(key, value)
  loop
    if attribute_key not in (
        'variant', 'color', 'size', 'capacity', 'battery_model',
        'charging_port_type', 'screw_state', 'date_code',
        'manufacture_date', 'production_date'
    ) then
      return false;
    end if;
    if pg_catalog.jsonb_typeof(attribute_json) <> 'string' then
      return false;
    end if;

    attribute_value := attribute_json #>> '{}';
    if pg_catalog.length(pg_catalog.btrim(attribute_value)) not between 1 and 120
      or attribute_value ~ '[[:cntrl:]]' then
      return false;
    end if;

    if attribute_key in ('manufacture_date', 'production_date') then
      if attribute_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        return false;
      end if;
      begin
        perform pg_catalog.make_date(
          pg_catalog.substr(attribute_value, 1, 4)::integer,
          pg_catalog.substr(attribute_value, 6, 2)::integer,
          pg_catalog.substr(attribute_value, 9, 2)::integer
        );
      exception when others then
        return false;
      end;
    end if;
  end loop;

  return true;
end;
$$;

revoke all on function public.validate_owned_product_safety_attributes(jsonb) from public;
revoke all on function public.validate_owned_product_safety_attributes(jsonb) from anon;
grant execute on function public.validate_owned_product_safety_attributes(jsonb)
to authenticated, service_role;

commit;
