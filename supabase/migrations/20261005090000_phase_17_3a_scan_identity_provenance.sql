-- Phase 17.3a is a LOCAL candidate. Do not apply in production without a separately authorized
-- installation (docs/phase-17-3a-scan-identity-foundation.md).
--
-- Scan identity provenance. `owned_products.gtin` keeps the matching GTIN (for a UPC-E, its
-- UPC-A expansion, so the Phase 17.3-S canonical index and candidate retrieval work unchanged).
-- The scan that produced the CURRENT gtin is kept beside it:
--
--   barcode_raw_value  the barcode value delivered to JavaScript by expo-camera
--                      (`BarcodeScanningResult.data`, e.g. UPC-E 04252614); not necessarily the
--                      native scanner engine's raw bytes
--   barcode_symbology  the symbology the scanner reported (ean13 | ean8 | upc_a | upc_e | itf14)
--
-- Semantics: provenance of the current gtin, not a history of the first scan.
--   * kept while gtin keeps the same canonical GTIN-14 (12 -> 13 -> 14 representations);
--   * cleared by a BEFORE UPDATE trigger when gtin becomes NULL, invalid or non-equivalent.
-- A UPC-E is stored in gtin as its UPC-A, so comparing canonical_gtin14(OLD.gtin) with
-- canonical_gtin14(NEW.gtin) suffices: the trigger never re-interprets a raw UPC-E.
--
-- Both are NULL for manual, OCR-assisted and every pre-17.3a product: nothing is backfilled or
-- inferred, and an 8-digit `gtin` without `barcode_symbology = 'upc_e'` stays a GTIN-8. The
-- canonical GTIN-14 and any UPC-E -> UPC-A transformation are derived from these two columns
-- with the shared primitive (supabase/functions/_shared/matching/gtin.ts) and are not stored.
--
-- The database guarantees that provenance describes gtin, for every symbology: an 8-digit raw
-- value is expanded as UPC-E only when barcode_symbology = 'upc_e' (private.expand_upce_to_upca,
-- SQL mirror of expandUpcE). private.canonical_gtin14 is unchanged and still never expands.
--
-- The columns are not inputs of matching: no matching function, index, policy, fingerprint or
-- F-4 rule changes, and the recall-check arming trigger is not widened.
begin;

-- ===========================================================================
-- 1. UPC-E expansion (parity with expandUpcE in supabase/functions/_shared/matching/gtin.ts).
--    Exactly 8 ASCII digits, number system 0 or 1, nothing trimmed; GS1 zero-suppression rules;
--    the UPC-E check digit is the expanded UPC-A's, so the result is returned only when
--    private.canonical_gtin14 accepts it. Anything else is NULL. Callers must only use it when
--    the symbology is known to be UPC-E: an 8-digit value alone is a GTIN-8.
--    Shared vectors: tests/fixtures/phase-17-3-s-gtin-vectors.json (upce) and
--    tests/fixtures/phase-17-3a-upce-vectors.json.
--    SQL-standard body: references are bound at creation, so a writing role needs EXECUTE on
--    this function and on canonical_gtin14, never USAGE on schema private.
-- ===========================================================================
create function private.expand_upce_to_upca(p_value text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
begin atomic
  select case when private.canonical_gtin14(expansion.upc_a) is not null then expansion.upc_a end
  from (
    select
      case
        when digits.d6 in ('0', '1', '2')
          then digits.ns || digits.d1 || digits.d2 || digits.d6 || '0000' || digits.d3 || digits.d4 || digits.d5
        when digits.d6 = '3'
          then digits.ns || digits.d1 || digits.d2 || digits.d3 || '00000' || digits.d4 || digits.d5
        when digits.d6 = '4'
          then digits.ns || digits.d1 || digits.d2 || digits.d3 || digits.d4 || '00000' || digits.d5
        else digits.ns || digits.d1 || digits.d2 || digits.d3 || digits.d4 || digits.d5 || '0000' || digits.d6
      end || digits.check_digit as upc_a
    from (
      select
        pg_catalog.substr(p_value, 1, 1) as ns,
        pg_catalog.substr(p_value, 2, 1) as d1,
        pg_catalog.substr(p_value, 3, 1) as d2,
        pg_catalog.substr(p_value, 4, 1) as d3,
        pg_catalog.substr(p_value, 5, 1) as d4,
        pg_catalog.substr(p_value, 6, 1) as d5,
        pg_catalog.substr(p_value, 7, 1) as d6,
        pg_catalog.substr(p_value, 8, 1) as check_digit
      where p_value ~ '^[01][0-9]{7}$'
    ) as digits
  ) as expansion;
end;
revoke all on function private.expand_upce_to_upca(text) from public, anon, authenticated, service_role;
-- Like canonical_gtin14: the CHECK constraint below is evaluated with the privileges of the role
-- writing owned_products, so exactly those two roles need EXECUTE. Neither has USAGE on schema
-- private, so the function stays unreachable by name from the API.
grant execute on function private.expand_upce_to_upca(text) to authenticated, service_role;

-- ===========================================================================
-- 2. Columns and constraints.
-- ===========================================================================

alter table public.owned_products
  add column barcode_raw_value text,
  add column barcode_symbology text,
  add constraint owned_products_barcode_provenance_pair_check check (
    (barcode_raw_value is null) = (barcode_symbology is null)
  ),
  -- Mirrors gtinCarrierLengths (src/domain/barcode.ts): exact ASCII digits, nothing trimmed,
  -- and only lengths the reported symbology can carry. Code 128 is not a GTIN carrier.
  add constraint owned_products_barcode_provenance_check check (
    barcode_symbology is null
    or (
      barcode_raw_value ~ '^[0-9]+$'
      and case barcode_symbology
        when 'ean13' then pg_catalog.length(barcode_raw_value) in (12, 13)
        when 'upc_a' then pg_catalog.length(barcode_raw_value) in (12, 13)
        when 'ean8' then pg_catalog.length(barcode_raw_value) = 8
        when 'upc_e' then pg_catalog.length(barcode_raw_value) in (8, 12)
        when 'itf14' then pg_catalog.length(barcode_raw_value) = 14
        else false
      end
    )
  ),
  -- Provenance only ever describes the current gtin: the identity of the raw value under its
  -- symbology must equal the canonical GTIN-14 of gtin. Only upc_e with 8 digits is expanded;
  -- an 8-digit ean8 stays a GTIN-8. coalesce(..., false): a NULL comparison (gtin NULL or
  -- invalid, raw invalid) must reject, never pass the CHECK.
  add constraint owned_products_barcode_provenance_gtin_check check (
    barcode_symbology is null
    or coalesce(
      private.canonical_gtin14(gtin) = private.canonical_gtin14(
        case
          when barcode_symbology = 'upc_e' and pg_catalog.length(barcode_raw_value) = 8
            then private.expand_upce_to_upca(barcode_raw_value)
          else barcode_raw_value
        end
      ),
      false
    )
  );

-- ===========================================================================
-- 3. Clears provenance that no longer describes gtin. The equivalence test lives in the trigger's
-- WHEN clause (stored parsed, so the writing role needs only EXECUTE on canonical_gtin14, as
-- for the 17.3-S index expressions); the function itself touches no other object.
-- ===========================================================================
create function private.clear_stale_owned_product_barcode_provenance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.barcode_raw_value := null;
  new.barcode_symbology := null;
  return new;
end;
$$;
revoke all on function private.clear_stale_owned_product_barcode_provenance()
  from public, anon, authenticated, service_role;

create trigger owned_products_clear_stale_barcode_provenance
  before update of gtin on public.owned_products
  for each row
  when (
    (new.barcode_raw_value is not null or new.barcode_symbology is not null)
    and old.gtin is distinct from new.gtin
    and (
      private.canonical_gtin14(new.gtin) is null
      or private.canonical_gtin14(new.gtin) is distinct from private.canonical_gtin14(old.gtin)
    )
  )
  execute function private.clear_stale_owned_product_barcode_provenance();

comment on column public.owned_products.barcode_raw_value is
  'Phase 17.3a: barcode value delivered to JavaScript by the scanner for the scan that produced '
  'the current gtin; NULL otherwise, and cleared when gtin stops being equivalent. Not a '
  'matching input: gtin holds the matching GTIN.';
comment on column public.owned_products.barcode_symbology is
  'Phase 17.3a: symbology reported by the scanner for barcode_raw_value; NULL otherwise. Only '
  'upc_e changes the GTIN identity (expanded to UPC-A in gtin).';

commit;
