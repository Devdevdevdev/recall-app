-- Phase 17.3-S is a LOCAL candidate. Do not apply in production, deploy, or backfill
-- without a separately authorized installation (docs/phase-17-3-s-gtin-equivalence-implementation.md).
--
-- Canonical GTIN equivalence. A UPC-A 091021037090, its EAN-13 form 0091021037090 and its
-- GTIN-14 00091021037090 are one commercial identifier, but candidate retrieval compared the
-- raw digit strings, so an equivalent representation was never retrieved by GTIN.
--
--   1. private.canonical_gtin14(text): SQL mirror of canonicalGtin14
--      (supabase/functions/_shared/matching/gtin.ts). JavaScript String.prototype.trim
--      whitespace is removed, then only ASCII digits of length 8/12/13/14 with a valid GS1
--      check digit are accepted; the result is zero-filled on the left to 14 digits. Anything
--      else is NULL (fail closed). No UPC-E expansion: an 8-digit value is a GTIN-8.
--      Shared vectors: tests/fixtures/phase-17-3-s-gtin-vectors.json.
--   2. Expression indexes on owned_products and recall_scopes. The raw gtin columns are not
--      changed, rewritten, or backfilled: historical 12/13/14-digit rows become equivalent
--      through the expression, and invalid historical values stay visible but never get a
--      canonical key.
--   3. get_recall_candidates and get_owned_product_recall_candidates keep every existing
--      predicate and ranking; a canonical GTIN-14 equality is only ADDED as an alternative
--      to the legacy digit-string equality (rank 4 either way). Nothing is narrowed.
--
-- Equivalence only produces candidates. It confirms nothing by itself: v1/v2 matching,
-- private.automatic_alert_eligibility (F-4: a GTIN criterion is never eligible), jurisdiction
-- and coverage are unchanged. RECALL_MATCHING_POLICY and fingerprints are unchanged.
begin;

-- ===========================================================================
-- 1. Canonical GTIN-14 (parity with gtin.ts canonicalGtin14).
-- ===========================================================================
create function private.canonical_gtin14(p_value text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select case
    when value.digits ~ '^[0-9]+$' and pg_catalog.length(value.digits) in (8, 12, 13, 14) then
      case
        when (10 - (
            select pg_catalog.sum(
              pg_catalog.substr(value.digits, pg_catalog.length(value.digits) - position.i, 1)::integer
                * case when position.i % 2 = 1 then 3 else 1 end)
            from pg_catalog.generate_series(1, pg_catalog.length(value.digits) - 1) as position(i)
          ) % 10) % 10 = pg_catalog.right(value.digits, 1)::integer
        then pg_catalog.lpad(value.digits, 14, '0')
      end
  end
  from (
    -- Exactly the String.prototype.trim set (WhiteSpace + LineTerminator).
    select pg_catalog.btrim(p_value, E'\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff') as digits
  ) as value;
$$;
revoke all on function private.canonical_gtin14(text) from public, anon, authenticated, service_role;
-- Index expressions are evaluated with the privileges of the role writing the row, so the
-- two roles that insert/update owned_products and recall_scopes need EXECUTE. They have no
-- USAGE on schema private, so the function stays unreachable by name from the API.
grant execute on function private.canonical_gtin14(text) to authenticated, service_role;

-- ===========================================================================
-- 2. Indexes (no column, no data change).
-- ===========================================================================
create index owned_products_canonical_gtin14_idx
  on public.owned_products ((private.canonical_gtin14(gtin)))
  where gtin is not null;

create index recall_scopes_canonical_gtin14_idx
  on public.recall_scopes ((private.canonical_gtin14(gtin)))
  where gtin is not null;

-- ===========================================================================
-- 3. Candidate retrieval: legacy equality OR canonical equality. Bodies are otherwise
--    byte-identical to 20260914100000 and 20261002120000; grants are preserved by
--    create or replace.
-- ===========================================================================
create or replace function public.get_recall_candidates(
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
            and (
              pg_catalog.regexp_replace(owned_product.gtin, '[^0-9]', '', 'g') =
                pg_catalog.regexp_replace(exact_scope.gtin, '[^0-9]', '', 'g')
              -- Phase 17.3-S: equivalent GTIN representations (same canonical GTIN-14).
              or private.canonical_gtin14(owned_product.gtin) =
                private.canonical_gtin14(exact_scope.gtin)
            )
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
                and (
                  pg_catalog.regexp_replace(owned_product.gtin, '[^0-9]', '', 'g') =
                    pg_catalog.regexp_replace(candidate_scope.gtin, '[^0-9]', '', 'g')
                  -- Phase 17.3-S: equivalent GTIN representations (same canonical GTIN-14).
                  or private.canonical_gtin14(owned_product.gtin) =
                    private.canonical_gtin14(candidate_scope.gtin)
                )
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

create or replace function public.get_owned_product_recall_candidates(
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
      private.canonical_gtin14(owned_product.gtin) as gtin14_key,
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
    -- Phase 17.3-S: equivalent GTIN representations (same canonical GTIN-14), same rank.
    select scope.recall_notice_id, 4
    from product
    join public.recall_scopes as scope
      on product.gtin14_key is not null
      and scope.gtin is not null
      and private.canonical_gtin14(scope.gtin) = product.gtin14_key
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

commit;
