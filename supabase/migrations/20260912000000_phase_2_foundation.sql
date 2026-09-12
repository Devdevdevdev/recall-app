begin;

create type public.recall_match_status as enum (
  'candidate',
  'confirmed',
  'rejected',
  'needs_review'
);

create type public.alert_status as enum ('unread', 'read', 'dismissed');

create table public.owned_products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  brand text,
  product_name text,
  category text,
  gtin text,
  model_number text,
  serial_number text,
  lot_number text,
  purchase_date date,
  image_path text,
  identification_method text,
  identification_confidence numeric(5, 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint owned_products_identification_confidence_check check (
    identification_confidence is null
    or identification_confidence between 0 and 1
  )
);

create table public.recall_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  jurisdiction text not null,
  base_url text not null,
  is_authoritative boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recall_sources_name_not_blank check (btrim(name) <> ''),
  constraint recall_sources_jurisdiction_not_blank check (btrim(jurisdiction) <> ''),
  constraint recall_sources_base_url_not_blank check (btrim(base_url) <> ''),
  constraint recall_sources_base_url_format_check check (
    base_url ~* '^https?://[^/@:?#[:space:]]+(:[0-9]+)?([/?#][^[:space:]]*)?$'
  )
);

create table public.recall_notices (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.recall_sources (id) on delete restrict,
  external_id text not null,
  title text not null,
  description text,
  hazard text,
  remedy text,
  recall_date date not null,
  official_url text not null,
  retrieved_at timestamptz not null,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recall_notices_source_external_id_key unique (source_id, external_id),
  constraint recall_notices_external_id_not_blank check (btrim(external_id) <> ''),
  constraint recall_notices_title_not_blank check (btrim(title) <> ''),
  constraint recall_notices_official_url_not_blank check (btrim(official_url) <> ''),
  constraint recall_notices_official_url_format_check check (
    official_url ~* '^https?://[^/@:?#[:space:]]+(:[0-9]+)?([/?#][^[:space:]]*)?$'
  ),
  constraint recall_notices_raw_payload_object_check check (
    jsonb_typeof(raw_payload) = 'object'
  )
);

create table public.recall_scopes (
  id uuid primary key default gen_random_uuid(),
  recall_notice_id uuid not null references public.recall_notices (id) on delete cascade,
  brand text,
  product_name text,
  gtin text,
  model_number text,
  lot_from text,
  lot_to text,
  serial_from text,
  serial_to text,
  manufactured_from date,
  manufactured_to date,
  additional_criteria jsonb,
  created_at timestamptz not null default now(),
  constraint recall_scopes_manufactured_range_check check (
    manufactured_from is null
    or manufactured_to is null
    or manufactured_from <= manufactured_to
  ),
  constraint recall_scopes_additional_criteria_object_check check (
    additional_criteria is null
    or jsonb_typeof(additional_criteria) = 'object'
  ),
  constraint recall_scopes_additional_criteria_not_empty_check check (
    additional_criteria is null
    or additional_criteria <> '{}'::jsonb
  ),
  constraint recall_scopes_text_criteria_not_blank_check check (
    (brand is null or btrim(brand) <> '')
    and (product_name is null or btrim(product_name) <> '')
    and (gtin is null or btrim(gtin) <> '')
    and (model_number is null or btrim(model_number) <> '')
    and (lot_from is null or btrim(lot_from) <> '')
    and (lot_to is null or btrim(lot_to) <> '')
    and (serial_from is null or btrim(serial_from) <> '')
    and (serial_to is null or btrim(serial_to) <> '')
  ),
  constraint recall_scopes_has_criteria_check check (
    num_nonnulls(
      brand,
      product_name,
      gtin,
      model_number,
      lot_from,
      lot_to,
      serial_from,
      serial_to,
      manufactured_from,
      manufactured_to,
      additional_criteria
    ) > 0
  )
);

create table public.recall_matches (
  id uuid primary key default gen_random_uuid(),
  owned_product_id uuid not null references public.owned_products (id) on delete cascade,
  recall_notice_id uuid not null references public.recall_notices (id) on delete restrict,
  status public.recall_match_status not null default 'candidate',
  confidence numeric(5, 4) not null,
  match_method text not null,
  matched_identifiers jsonb not null default '{}'::jsonb,
  reasoning_summary text not null,
  ai_provider text,
  ai_model text,
  schema_version text not null,
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recall_matches_owned_product_notice_key unique (
    owned_product_id,
    recall_notice_id
  ),
  constraint recall_matches_confidence_check check (confidence between 0 and 1),
  constraint recall_matches_match_method_not_blank check (btrim(match_method) <> ''),
  constraint recall_matches_reasoning_summary_not_blank check (
    btrim(reasoning_summary) <> ''
  ),
  constraint recall_matches_schema_version_not_blank check (btrim(schema_version) <> ''),
  constraint recall_matches_matched_identifiers_object_check check (
    jsonb_typeof(matched_identifiers) = 'object'
  )
);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recall_match_id uuid not null unique references public.recall_matches (id) on delete cascade,
  status public.alert_status not null default 'unread',
  created_at timestamptz not null default now(),
  read_at timestamptz,
  dismissed_at timestamptz,
  constraint alerts_status_timestamps_check check (
    (status = 'unread' and read_at is null and dismissed_at is null)
    or (status = 'read' and read_at is not null and dismissed_at is null)
    or (status = 'dismissed' and dismissed_at is not null)
  )
);

create index owned_products_user_id_idx on public.owned_products (user_id);
create index owned_products_gtin_idx on public.owned_products (gtin) where gtin is not null;
create index owned_products_model_number_idx on public.owned_products (model_number)
where model_number is not null;
create index owned_products_serial_number_idx on public.owned_products (serial_number)
where serial_number is not null;
create index owned_products_lot_number_idx on public.owned_products (lot_number)
where lot_number is not null;

create index recall_notices_recall_date_idx on public.recall_notices (recall_date);

create index recall_scopes_recall_notice_id_idx on public.recall_scopes (recall_notice_id);
create index recall_scopes_gtin_idx on public.recall_scopes (gtin) where gtin is not null;
create index recall_scopes_model_number_idx on public.recall_scopes (model_number)
where model_number is not null;
create index recall_scopes_brand_idx on public.recall_scopes (brand) where brand is not null;

create index recall_matches_recall_notice_id_idx on public.recall_matches (recall_notice_id);
create index alerts_user_id_idx on public.alerts (user_id);

create function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create function public.protect_owned_product_owner()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'owned product user_id is immutable';
  end if;

  return new;
end;
$$;

create function public.protect_recall_notice_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_base_url text;
begin
  if tg_op = 'UPDATE'
    and (
      new.source_id is distinct from old.source_id
      or new.external_id is distinct from old.external_id
    ) then
    raise exception 'recall notice source_id and external_id are immutable';
  end if;

  select recall_source.base_url
  into source_base_url
  from public.recall_sources as recall_source
  where recall_source.id = new.source_id;

  if lower(substring(new.official_url from '^https?://([^/@:?#[:space:]]+)'))
    is distinct from lower(substring(source_base_url from '^https?://([^/@:?#[:space:]]+)')) then
    raise exception 'recall notice official_url must use the recall source host';
  end if;

  return new;
end;
$$;

create function public.protect_recall_scope_notice()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.recall_notice_id is distinct from old.recall_notice_id then
    raise exception 'recall scope notice relationship is immutable';
  end if;

  return new;
end;
$$;

create function public.protect_recall_source_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.name is distinct from old.name
    or new.jurisdiction is distinct from old.jurisdiction
    or new.base_url is distinct from old.base_url then
    raise exception 'recall source identity is immutable';
  end if;

  return new;
end;
$$;

create function public.validate_recall_match()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and (
      new.owned_product_id is distinct from old.owned_product_id
      or new.recall_notice_id is distinct from old.recall_notice_id
    ) then
    raise exception 'recall match product and notice relationships are immutable';
  end if;

  if not exists (
    select 1
    from public.recall_notices as recall_notice
    join public.recall_sources as recall_source
      on recall_source.id = recall_notice.source_id
    where recall_notice.id = new.recall_notice_id
      and recall_source.is_authoritative
  ) then
    raise exception 'recall matches require an authoritative recall source';
  end if;

  return new;
end;
$$;

create trigger owned_products_set_updated_at
before update on public.owned_products
for each row execute function public.set_updated_at();

create trigger owned_products_protect_owner
before update of user_id on public.owned_products
for each row execute function public.protect_owned_product_owner();

create trigger recall_sources_set_updated_at
before update on public.recall_sources
for each row execute function public.set_updated_at();

create trigger recall_sources_protect_identity
before update of name, jurisdiction, base_url on public.recall_sources
for each row execute function public.protect_recall_source_identity();

create trigger recall_notices_set_updated_at
before update on public.recall_notices
for each row execute function public.set_updated_at();

create trigger recall_notices_protect_identity
before insert or update of source_id, external_id, official_url on public.recall_notices
for each row execute function public.protect_recall_notice_identity();

create trigger recall_scopes_protect_notice
before update of recall_notice_id on public.recall_scopes
for each row execute function public.protect_recall_scope_notice();

create trigger recall_matches_set_updated_at
before update on public.recall_matches
for each row execute function public.set_updated_at();

create trigger recall_matches_validate
before insert or update on public.recall_matches
for each row execute function public.validate_recall_match();

create function public.ensure_alert_owner()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.recall_matches as recall_match
    join public.owned_products as owned_product
      on owned_product.id = recall_match.owned_product_id
    join public.recall_notices as recall_notice
      on recall_notice.id = recall_match.recall_notice_id
    join public.recall_sources as recall_source
      on recall_source.id = recall_notice.source_id
    where recall_match.id = new.recall_match_id
      and owned_product.user_id = new.user_id
      and recall_source.is_authoritative
  ) then
    raise exception 'alert must belong to the product owner and an authoritative recall source';
  end if;

  return new;
end;
$$;

create trigger alerts_ensure_owner
before insert or update of user_id, recall_match_id on public.alerts
for each row execute function public.ensure_alert_owner();

revoke all on function public.set_updated_at() from public;
revoke all on function public.protect_owned_product_owner() from public;
revoke all on function public.protect_recall_notice_identity() from public;
revoke all on function public.protect_recall_scope_notice() from public;
revoke all on function public.protect_recall_source_identity() from public;
revoke all on function public.validate_recall_match() from public;
revoke all on function public.ensure_alert_owner() from public;

alter table public.owned_products enable row level security;
alter table public.recall_sources enable row level security;
alter table public.recall_notices enable row level security;
alter table public.recall_scopes enable row level security;
alter table public.recall_matches enable row level security;
alter table public.alerts enable row level security;

create policy "Users can read their owned products"
on public.owned_products
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their owned products"
on public.owned_products
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their owned products"
on public.owned_products
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their owned products"
on public.owned_products
for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy "Authenticated users can read recall sources"
on public.recall_sources
for select
to authenticated
using (is_authoritative);

create policy "Authenticated users can read recall notices"
on public.recall_notices
for select
to authenticated
using (
  exists (
    select 1
    from public.recall_sources as recall_source
    where recall_source.id = recall_notices.source_id
      and recall_source.is_authoritative
  )
);

create policy "Authenticated users can read recall scopes"
on public.recall_scopes
for select
to authenticated
using (
  exists (
    select 1
    from public.recall_notices as recall_notice
    join public.recall_sources as recall_source
      on recall_source.id = recall_notice.source_id
    where recall_notice.id = recall_scopes.recall_notice_id
      and recall_source.is_authoritative
  )
);

create policy "Users can read matches for their owned products"
on public.recall_matches
for select
to authenticated
using (
  exists (
    select 1
    from public.owned_products as owned_product
    where owned_product.id = recall_matches.owned_product_id
      and owned_product.user_id = (select auth.uid())
  )
  and exists (
    select 1
    from public.recall_notices as recall_notice
    join public.recall_sources as recall_source
      on recall_source.id = recall_notice.source_id
    where recall_notice.id = recall_matches.recall_notice_id
      and recall_source.is_authoritative
  )
);

create policy "Users can read their alerts"
on public.alerts
for select
to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.recall_matches as recall_match
    join public.owned_products as owned_product
      on owned_product.id = recall_match.owned_product_id
    join public.recall_notices as recall_notice
      on recall_notice.id = recall_match.recall_notice_id
    join public.recall_sources as recall_source
      on recall_source.id = recall_notice.source_id
    where recall_match.id = alerts.recall_match_id
      and owned_product.user_id = (select auth.uid())
      and recall_source.is_authoritative
  )
);

create policy "Users can update their alert state"
on public.alerts
for update
to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.recall_matches as recall_match
    join public.owned_products as owned_product
      on owned_product.id = recall_match.owned_product_id
    join public.recall_notices as recall_notice
      on recall_notice.id = recall_match.recall_notice_id
    join public.recall_sources as recall_source
      on recall_source.id = recall_notice.source_id
    where recall_match.id = alerts.recall_match_id
      and owned_product.user_id = (select auth.uid())
      and recall_source.is_authoritative
  )
)
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.recall_matches as recall_match
    join public.owned_products as owned_product
      on owned_product.id = recall_match.owned_product_id
    join public.recall_notices as recall_notice
      on recall_notice.id = recall_match.recall_notice_id
    join public.recall_sources as recall_source
      on recall_source.id = recall_notice.source_id
    where recall_match.id = alerts.recall_match_id
      and owned_product.user_id = (select auth.uid())
      and recall_source.is_authoritative
  )
);

revoke all on table public.owned_products from anon, authenticated;
revoke all on table public.recall_sources from anon, authenticated;
revoke all on table public.recall_notices from anon, authenticated;
revoke all on table public.recall_scopes from anon, authenticated;
revoke all on table public.recall_matches from anon, authenticated;
revoke all on table public.alerts from anon, authenticated;
revoke all on type public.recall_match_status from anon, authenticated;
revoke all on type public.alert_status from anon, authenticated;

grant select, insert, update, delete on table public.owned_products to authenticated;
grant select on table public.recall_sources to authenticated;
grant select on table public.recall_notices to authenticated;
grant select on table public.recall_scopes to authenticated;
grant select on table public.recall_matches to authenticated;
grant select on table public.alerts to authenticated;
grant update (status, read_at, dismissed_at) on table public.alerts to authenticated;
grant usage on type public.recall_match_status to authenticated;
grant usage on type public.alert_status to authenticated;

commit;
