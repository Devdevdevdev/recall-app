begin;

create function public.validate_owned_product_safety_attributes(attributes jsonb)
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
  parsed_date date;
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
      if attribute_value !~ '^\d{4}-\d{2}-\d{2}$' then
        return false;
      end if;
      begin
        parsed_date := attribute_value::date;
      exception when others then
        return false;
      end;
      if pg_catalog.to_char(parsed_date, 'YYYY-MM-DD') <> attribute_value then
        return false;
      end if;
    end if;
  end loop;

  return true;
end;
$$;

revoke all on function public.validate_owned_product_safety_attributes(jsonb) from public;
revoke all on function public.validate_owned_product_safety_attributes(jsonb) from anon;
grant execute on function public.validate_owned_product_safety_attributes(jsonb)
to authenticated, service_role;

alter table public.owned_products
  add column safety_attributes jsonb not null default '{}'::jsonb,
  add constraint owned_products_safety_attributes_check check (
    public.validate_owned_product_safety_attributes(safety_attributes)
  );

comment on column public.owned_products.safety_attributes is
  'Owner-private, whitelisted safety evidence only; excludes images and raw OCR payloads.';

commit;
