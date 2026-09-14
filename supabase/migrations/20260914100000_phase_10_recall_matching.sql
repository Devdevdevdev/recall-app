begin;

alter table public.recall_matches
add column evidence_fingerprint text;

alter table public.recall_matches
add constraint recall_matches_evidence_fingerprint_check check (
  evidence_fingerprint is null
  or evidence_fingerprint ~ '^[0-9a-f]{64}$'
);

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table private.recall_matching_leases (
  owned_product_id uuid not null references public.owned_products (id) on delete cascade,
  recall_notice_id uuid not null references public.recall_notices (id) on delete cascade,
  evidence_fingerprint text not null,
  lease_token uuid not null,
  lease_expires_at timestamptz not null,
  claimed_at timestamptz not null default now(),
  attempt_count integer not null default 1,
  primary key (owned_product_id, recall_notice_id),
  constraint recall_matching_leases_fingerprint_check check (
    evidence_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint recall_matching_leases_attempt_count_check check (attempt_count > 0),
  constraint recall_matching_leases_expiry_check check (lease_expires_at > claimed_at)
);

alter table private.recall_matching_leases enable row level security;
revoke all on table private.recall_matching_leases
from public, anon, authenticated, service_role;

-- Expression indexes support normalized exact-identifier retrieval without granting access to a
-- helper function in the private schema. Descriptive retrieval is deliberately recall-first and
-- bounded by the RPC before the in-memory candidate ranker applies the final safety policy.
create index owned_products_normalized_gtin_idx
on public.owned_products ((pg_catalog.regexp_replace(gtin, '[^0-9]', '', 'g')))
where gtin is not null;

create index owned_products_normalized_model_idx
on public.owned_products ((pg_catalog.lower(pg_catalog.regexp_replace(model_number, '[^[:alnum:]]', '', 'g'))))
where model_number is not null;

create index owned_products_normalized_serial_idx
on public.owned_products ((pg_catalog.lower(pg_catalog.regexp_replace(serial_number, '[^[:alnum:]]', '', 'g'))))
where serial_number is not null;

create index owned_products_normalized_lot_idx
on public.owned_products ((pg_catalog.lower(pg_catalog.regexp_replace(lot_number, '[^[:alnum:]]', '', 'g'))))
where lot_number is not null;

create index owned_products_product_name_fts_idx
on public.owned_products using gin (pg_catalog.to_tsvector('simple', coalesce(product_name, '')));

create index recall_scopes_normalized_gtin_idx
on public.recall_scopes ((pg_catalog.regexp_replace(gtin, '[^0-9]', '', 'g')))
where gtin is not null;

create index recall_scopes_normalized_model_idx
on public.recall_scopes ((pg_catalog.lower(pg_catalog.regexp_replace(model_number, '[^[:alnum:]]', '', 'g'))))
where model_number is not null;

create index recall_scopes_product_name_fts_idx
on public.recall_scopes using gin (pg_catalog.to_tsvector('simple', coalesce(product_name, '')));

create function public.get_recall_matching_batch(
  p_after_recall_id uuid default null,
  p_limit integer default 25,
  p_recall_notice_ids uuid[] default null
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
  scopes jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    recall_notice.id as recall_notice_id,
    recall_notice.external_id,
    recall_source.name as authority,
    recall_notice.official_url,
    recall_notice.title,
    recall_notice.description,
    recall_notice.hazard,
    recall_notice.remedy,
    recall_notice.recall_date,
    recall_notice.raw_payload,
    recall_notice.updated_at as recall_notice_updated_at,
    coalesce(scope_projection.scopes, '[]'::jsonb) as scopes
  from public.recall_notices as recall_notice
  join public.recall_sources as recall_source
    on recall_source.id = recall_notice.source_id
  left join lateral (
    select pg_catalog.jsonb_agg(
      canonical_scope.scope_json
      order by canonical_scope.scope_sort_key
    ) as scopes
    from (
      select
        pg_catalog.jsonb_build_object(
          'brand', recall_scope.brand,
          'product_name', recall_scope.product_name,
          'gtin', recall_scope.gtin,
          'model_number', recall_scope.model_number,
          'lot_from', recall_scope.lot_from,
          'lot_to', recall_scope.lot_to,
          'serial_from', recall_scope.serial_from,
          'serial_to', recall_scope.serial_to,
          'manufactured_from', recall_scope.manufactured_from,
          'manufactured_to', recall_scope.manufactured_to,
          'additional_criteria', recall_scope.additional_criteria
        ) as scope_json,
        concat_ws(
          chr(31),
          coalesce(recall_scope.brand, ''),
          coalesce(recall_scope.product_name, ''),
          coalesce(recall_scope.gtin, ''),
          coalesce(recall_scope.model_number, ''),
          coalesce(recall_scope.lot_from, ''),
          coalesce(recall_scope.lot_to, ''),
          coalesce(recall_scope.serial_from, ''),
          coalesce(recall_scope.serial_to, ''),
          coalesce(recall_scope.manufactured_from::text, ''),
          coalesce(recall_scope.manufactured_to::text, ''),
          coalesce(recall_scope.additional_criteria::text, '')
        ) as scope_sort_key
      from public.recall_scopes as recall_scope
      where recall_scope.recall_notice_id = recall_notice.id
    ) as canonical_scope
  ) as scope_projection on true
  where recall_source.is_authoritative
    and (p_after_recall_id is null or recall_notice.id > p_after_recall_id)
    and (p_recall_notice_ids is null or recall_notice.id = any (p_recall_notice_ids))
  order by recall_notice.id
  limit least(greatest(coalesce(p_limit, 1), 1), 100);
$$;

create function public.get_recall_candidates(
  p_recall_notice_id uuid,
  p_after_exact_rank integer default null,
  p_after_product_id uuid default null,
  p_limit integer default 100
)
returns table (
  owned_product_id uuid,
  brand text,
  product_name text,
  category text,
  gtin text,
  model_number text,
  serial_number text,
  lot_number text,
  purchase_date date,
  identification_method text,
  owned_product_updated_at timestamptz,
  exact_rank integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with authoritative_recall as (
    select recall_notice.id, recall_notice.title
    from public.recall_notices as recall_notice
    join public.recall_sources as recall_source
      on recall_source.id = recall_notice.source_id
    where recall_notice.id = p_recall_notice_id
      and recall_source.is_authoritative
  ),
  candidate_products as (
    select
      owned_product.id as owned_product_id,
      owned_product.brand,
      owned_product.product_name,
      owned_product.category,
      owned_product.gtin,
      owned_product.model_number,
      owned_product.serial_number,
      owned_product.lot_number,
      owned_product.purchase_date,
      owned_product.identification_method,
      owned_product.updated_at as owned_product_updated_at,
      case
        when exists (
          select 1
          from public.recall_scopes as exact_scope
          where exact_scope.recall_notice_id = authoritative_recall.id
            and owned_product.gtin is not null
            and exact_scope.gtin is not null
            and pg_catalog.regexp_replace(owned_product.gtin, '[^0-9]', '', 'g') =
              pg_catalog.regexp_replace(exact_scope.gtin, '[^0-9]', '', 'g')
        ) then 4
        when exists (
          select 1
          from public.recall_scopes as exact_scope
          where exact_scope.recall_notice_id = authoritative_recall.id
            and (
              (
                owned_product.serial_number is not null
                and (exact_scope.serial_from is not null or exact_scope.serial_to is not null)
              )
              or (
                owned_product.lot_number is not null
                and (exact_scope.lot_from is not null or exact_scope.lot_to is not null)
              )
            )
        ) then 3
        when exists (
          select 1
          from public.recall_scopes as exact_scope
          where exact_scope.recall_notice_id = authoritative_recall.id
            and owned_product.model_number is not null
            and exact_scope.model_number is not null
            and pg_catalog.lower(pg_catalog.regexp_replace(owned_product.model_number, '[^[:alnum:]]', '', 'g')) =
              pg_catalog.lower(pg_catalog.regexp_replace(exact_scope.model_number, '[^[:alnum:]]', '', 'g'))
        ) then 2
        else 1
      end as exact_rank
    from authoritative_recall
    join public.owned_products as owned_product on true
    where (
        exists (
          select 1
          from public.recall_scopes as candidate_scope
          where candidate_scope.recall_notice_id = authoritative_recall.id
            and (
              (
                owned_product.gtin is not null
                and candidate_scope.gtin is not null
                and pg_catalog.regexp_replace(owned_product.gtin, '[^0-9]', '', 'g') =
                  pg_catalog.regexp_replace(candidate_scope.gtin, '[^0-9]', '', 'g')
              )
              or (
                owned_product.model_number is not null
                and candidate_scope.model_number is not null
                and pg_catalog.lower(pg_catalog.regexp_replace(owned_product.model_number, '[^[:alnum:]]', '', 'g')) =
                  pg_catalog.lower(pg_catalog.regexp_replace(candidate_scope.model_number, '[^[:alnum:]]', '', 'g'))
              )
              or (
                owned_product.serial_number is not null
                and (candidate_scope.serial_from is not null or candidate_scope.serial_to is not null)
              )
              or (
                owned_product.lot_number is not null
                and (candidate_scope.lot_from is not null or candidate_scope.lot_to is not null)
              )
              or (
                owned_product.product_name is not null
                and candidate_scope.product_name is not null
                and pg_catalog.to_tsvector('simple', coalesce(owned_product.product_name, '')) @@ (
                  select pg_catalog.to_tsquery(
                    'simple',
                    pg_catalog.string_agg(pg_catalog.quote_literal(scope_token.token), ' | ')
                  )
                  from pg_catalog.unnest(
                    pg_catalog.tsvector_to_array(
                      pg_catalog.to_tsvector('simple', candidate_scope.product_name)
                    )
                  ) as scope_token(token)
                  where pg_catalog.length(scope_token.token) >= 3
                )
              )
              or (
                owned_product.brand is not null
                and candidate_scope.brand is not null
                and pg_catalog.lower(pg_catalog.regexp_replace(owned_product.brand, '[^[:alnum:]]', '', 'g')) =
                  pg_catalog.lower(pg_catalog.regexp_replace(candidate_scope.brand, '[^[:alnum:]]', '', 'g'))
              )
            )
        )
        or (
          owned_product.product_name is not null
          and pg_catalog.to_tsvector('simple', coalesce(owned_product.product_name, '')) @@ (
            select pg_catalog.to_tsquery(
              'simple',
              pg_catalog.string_agg(pg_catalog.quote_literal(title_token.token), ' | ')
            )
            from pg_catalog.unnest(
              pg_catalog.tsvector_to_array(
                pg_catalog.to_tsvector('simple', authoritative_recall.title)
              )
            ) as title_token(token)
            where pg_catalog.length(title_token.token) >= 3
          )
        )
      )
  )
  select
    candidate_products.owned_product_id,
    candidate_products.brand,
    candidate_products.product_name,
    candidate_products.category,
    candidate_products.gtin,
    candidate_products.model_number,
    candidate_products.serial_number,
    candidate_products.lot_number,
    candidate_products.purchase_date,
    candidate_products.identification_method,
    candidate_products.owned_product_updated_at,
    candidate_products.exact_rank
  from candidate_products
  where p_after_exact_rank is null
    or candidate_products.exact_rank < p_after_exact_rank
    or (
      candidate_products.exact_rank = p_after_exact_rank
      and candidate_products.owned_product_id > p_after_product_id
    )
  order by candidate_products.exact_rank desc, candidate_products.owned_product_id
  limit least(greatest(coalesce(p_limit, 1), 1), 250);
$$;

create function public.claim_recall_match_evaluation(
  p_owned_product_id uuid,
  p_recall_notice_id uuid,
  p_evidence_fingerprint text,
  p_expected_product_updated_at timestamptz,
  p_expected_recall_updated_at timestamptz,
  p_lease_seconds integer default 120
)
returns table (
  status text,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product_updated_at timestamptz;
  v_recall_updated_at timestamptz;
  v_lease_token uuid := gen_random_uuid();
  v_lease_expires_at timestamptz;
begin
  if p_evidence_fingerprint is null
    or p_evidence_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'a canonical SHA-256 evidence fingerprint is required';
  end if;

  select owned_product.updated_at
  into v_product_updated_at
  from public.owned_products as owned_product
  where owned_product.id = p_owned_product_id;

  select recall_notice.updated_at
  into v_recall_updated_at
  from public.recall_notices as recall_notice
  join public.recall_sources as recall_source
    on recall_source.id = recall_notice.source_id
  where recall_notice.id = p_recall_notice_id
    and recall_source.is_authoritative;

  if v_product_updated_at is null or v_recall_updated_at is null then
    status := 'missing';
    lease_token := null;
    lease_expires_at := null;
    return next;
    return;
  end if;

  if v_product_updated_at is distinct from p_expected_product_updated_at
    or v_recall_updated_at is distinct from p_expected_recall_updated_at then
    status := 'stale';
    lease_token := null;
    lease_expires_at := null;
    return next;
    return;
  end if;

  if exists (
    select 1
    from public.recall_matches as recall_match
    where recall_match.owned_product_id = p_owned_product_id
      and recall_match.recall_notice_id = p_recall_notice_id
      and recall_match.evidence_fingerprint = p_evidence_fingerprint
  ) then
    status := 'unchanged';
    lease_token := null;
    lease_expires_at := null;
    return next;
    return;
  end if;

  v_lease_expires_at := pg_catalog.now() + pg_catalog.make_interval(
    secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 300)
  );

  insert into private.recall_matching_leases as recall_matching_leases (
    owned_product_id,
    recall_notice_id,
    evidence_fingerprint,
    lease_token,
    lease_expires_at
  )
  values (
    p_owned_product_id,
    p_recall_notice_id,
    p_evidence_fingerprint,
    v_lease_token,
    v_lease_expires_at
  )
  on conflict (owned_product_id, recall_notice_id) do update
  set
    evidence_fingerprint = excluded.evidence_fingerprint,
    lease_token = excluded.lease_token,
    lease_expires_at = excluded.lease_expires_at,
    claimed_at = pg_catalog.now(),
    attempt_count = recall_matching_leases.attempt_count + 1
  where recall_matching_leases.lease_expires_at <= pg_catalog.now()
  returning recall_matching_leases.lease_token, recall_matching_leases.lease_expires_at
  into lease_token, lease_expires_at;

  if lease_token is null then
    status := 'busy';
    return next;
    return;
  end if;

  select owned_product.updated_at
  into v_product_updated_at
  from public.owned_products as owned_product
  where owned_product.id = p_owned_product_id;

  select recall_notice.updated_at
  into v_recall_updated_at
  from public.recall_notices as recall_notice
  join public.recall_sources as recall_source
    on recall_source.id = recall_notice.source_id
  where recall_notice.id = p_recall_notice_id
    and recall_source.is_authoritative;

  if v_product_updated_at is distinct from p_expected_product_updated_at
    or v_recall_updated_at is distinct from p_expected_recall_updated_at then
    delete from private.recall_matching_leases as matching_lease
    where matching_lease.owned_product_id = p_owned_product_id
      and matching_lease.recall_notice_id = p_recall_notice_id
      and matching_lease.lease_token = lease_token;
    status := 'stale';
    lease_token := null;
    lease_expires_at := null;
    return next;
    return;
  end if;

  if exists (
    select 1
    from public.recall_matches as recall_match
    where recall_match.owned_product_id = p_owned_product_id
      and recall_match.recall_notice_id = p_recall_notice_id
      and recall_match.evidence_fingerprint = p_evidence_fingerprint
  ) then
    delete from private.recall_matching_leases as matching_lease
    where matching_lease.owned_product_id = p_owned_product_id
      and matching_lease.recall_notice_id = p_recall_notice_id
      and matching_lease.lease_token = lease_token;
    status := 'unchanged';
    lease_token := null;
    lease_expires_at := null;
    return next;
    return;
  end if;

  status := 'claimed';
  return next;
end;
$$;

create function public.finalize_recall_match_evaluation(
  p_owned_product_id uuid,
  p_recall_notice_id uuid,
  p_evidence_fingerprint text,
  p_expected_product_updated_at timestamptz,
  p_expected_recall_updated_at timestamptz,
  p_lease_token uuid,
  p_status public.recall_match_status,
  p_confidence numeric,
  p_match_method text,
  p_matched_identifiers jsonb,
  p_reasoning_summary text,
  p_ai_provider text,
  p_ai_model text,
  p_schema_version text
)
returns table (
  status text,
  recall_match_id uuid,
  alert_id uuid,
  alert_outcome text,
  previous_status public.recall_match_status,
  confirmation_reversed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease_valid boolean := false;
  v_product_updated_at timestamptz;
  v_recall_updated_at timestamptz;
  v_user_id uuid;
  v_existing_alert_id uuid;
begin
  if p_evidence_fingerprint is null
    or p_evidence_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'a canonical SHA-256 evidence fingerprint is required';
  end if;
  if p_lease_token is null then
    raise exception 'lease token is required';
  end if;
  if p_status = 'candidate'::public.recall_match_status then
    raise exception 'candidate is not a final production evaluation status';
  end if;
  if p_match_method not in ('deterministic_v1', 'hybrid_guarded_v1') then
    raise exception 'unsupported production match method';
  end if;
  if p_match_method = 'deterministic_v1'
    and (p_ai_provider is not null or p_ai_model is not null) then
    raise exception 'deterministic evaluations cannot contain AI provenance';
  end if;
  if p_match_method = 'hybrid_guarded_v1'
    and (
      p_ai_provider is distinct from 'nebius'
      or p_ai_model is distinct from 'nvidia/nemotron-3-super-120b-a12b'
    ) then
    raise exception 'guarded hybrid evaluations require the approved Nebius model provenance';
  end if;

  select true
  into v_lease_valid
  from private.recall_matching_leases as matching_lease
  where matching_lease.owned_product_id = p_owned_product_id
    and matching_lease.recall_notice_id = p_recall_notice_id
    and matching_lease.lease_token = p_lease_token
    and matching_lease.evidence_fingerprint = p_evidence_fingerprint
    and matching_lease.lease_expires_at > pg_catalog.now()
  for update;

  if not coalesce(v_lease_valid, false) then
    status := 'stale';
    recall_match_id := null;
    alert_id := null;
    alert_outcome := 'none';
    previous_status := null;
    confirmation_reversed := false;
    return next;
    return;
  end if;

  select owned_product.updated_at, owned_product.user_id
  into v_product_updated_at, v_user_id
  from public.owned_products as owned_product
  where owned_product.id = p_owned_product_id
  for share;

  select recall_notice.updated_at
  into v_recall_updated_at
  from public.recall_notices as recall_notice
  join public.recall_sources as recall_source
    on recall_source.id = recall_notice.source_id
  where recall_notice.id = p_recall_notice_id
    and recall_source.is_authoritative
  for share of recall_notice, recall_source;

  if v_product_updated_at is null or v_recall_updated_at is null then
    delete from private.recall_matching_leases as matching_lease
    where matching_lease.owned_product_id = p_owned_product_id
      and matching_lease.recall_notice_id = p_recall_notice_id
      and matching_lease.lease_token = p_lease_token;
    status := 'missing';
    recall_match_id := null;
    alert_id := null;
    alert_outcome := 'none';
    previous_status := null;
    confirmation_reversed := false;
    return next;
    return;
  end if;

  if v_product_updated_at is distinct from p_expected_product_updated_at
    or v_recall_updated_at is distinct from p_expected_recall_updated_at then
    delete from private.recall_matching_leases as matching_lease
    where matching_lease.owned_product_id = p_owned_product_id
      and matching_lease.recall_notice_id = p_recall_notice_id
      and matching_lease.lease_token = p_lease_token;
    status := 'stale';
    recall_match_id := null;
    alert_id := null;
    alert_outcome := 'none';
    previous_status := null;
    confirmation_reversed := false;
    return next;
    return;
  end if;

  select recall_match.status
  into previous_status
  from public.recall_matches as recall_match
  where recall_match.owned_product_id = p_owned_product_id
    and recall_match.recall_notice_id = p_recall_notice_id
  for update;

  insert into public.recall_matches (
    owned_product_id,
    recall_notice_id,
    status,
    confidence,
    match_method,
    matched_identifiers,
    reasoning_summary,
    ai_provider,
    ai_model,
    schema_version,
    evidence_fingerprint,
    evaluated_at
  )
  values (
    p_owned_product_id,
    p_recall_notice_id,
    p_status,
    p_confidence,
    p_match_method,
    p_matched_identifiers,
    p_reasoning_summary,
    p_ai_provider,
    p_ai_model,
    p_schema_version,
    p_evidence_fingerprint,
    pg_catalog.now()
  )
  on conflict (owned_product_id, recall_notice_id)
  do update set
    status = excluded.status,
    confidence = excluded.confidence,
    match_method = excluded.match_method,
    matched_identifiers = excluded.matched_identifiers,
    reasoning_summary = excluded.reasoning_summary,
    ai_provider = excluded.ai_provider,
    ai_model = excluded.ai_model,
    schema_version = excluded.schema_version,
    evidence_fingerprint = excluded.evidence_fingerprint,
    evaluated_at = excluded.evaluated_at
  returning id into recall_match_id;

  select alert.id
  into v_existing_alert_id
  from public.alerts as alert
  where alert.recall_match_id = recall_match_id;

  if p_status = 'confirmed'::public.recall_match_status then
    if v_existing_alert_id is null then
      insert into public.alerts (user_id, recall_match_id)
      values (v_user_id, recall_match_id)
      on conflict (recall_match_id) do nothing
      returning id into alert_id;

      if alert_id is null then
        select alert.id
        into alert_id
        from public.alerts as alert
        where alert.recall_match_id = recall_match_id;
        alert_outcome := 'existing';
      else
        alert_outcome := 'created';
      end if;
    else
      alert_id := v_existing_alert_id;
      alert_outcome := 'existing';
    end if;
  else
    alert_id := v_existing_alert_id;
    alert_outcome := 'none';
  end if;

  confirmation_reversed := previous_status = 'confirmed'::public.recall_match_status
    and p_status <> 'confirmed'::public.recall_match_status;

  delete from private.recall_matching_leases as matching_lease
  where matching_lease.owned_product_id = p_owned_product_id
    and matching_lease.recall_notice_id = p_recall_notice_id
    and matching_lease.lease_token = p_lease_token;

  status := 'finalized';
  return next;
end;
$$;

revoke all on function public.get_recall_matching_batch(uuid, integer, uuid[])
from public, anon, authenticated;
revoke all on function public.get_recall_candidates(uuid, integer, uuid, integer)
from public, anon, authenticated;
revoke all on function public.claim_recall_match_evaluation(uuid, uuid, text, timestamptz, timestamptz, integer)
from public, anon, authenticated;
revoke all on function public.finalize_recall_match_evaluation(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  uuid,
  public.recall_match_status,
  numeric,
  text,
  jsonb,
  text,
  text,
  text,
  text
)
from public, anon, authenticated;

grant execute on function public.get_recall_matching_batch(uuid, integer, uuid[]) to service_role;
grant execute on function public.get_recall_candidates(uuid, integer, uuid, integer) to service_role;
grant execute on function public.claim_recall_match_evaluation(uuid, uuid, text, timestamptz, timestamptz, integer)
to service_role;
grant execute on function public.finalize_recall_match_evaluation(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  uuid,
  public.recall_match_status,
  numeric,
  text,
  jsonb,
  text,
  text,
  text,
  text
)
to service_role;

commit;
