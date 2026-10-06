-- Phase 17.3a ROLLBACK, window A (gated). NEVER in supabase/migrations: applied only on an explicit
-- "GO 17.3A-ROLLBACK", as a forward migration, and ONLY BEFORE any 17.3a app build has been
-- distributed. A 17.3a app selects barcode_raw_value and barcode_symbology: dropping them would
-- break it. After a 17.3a app is distributed, use 20261005090200_phase_17_3a_post_rollout_relax.sql
-- instead (docs/phase-17-3a-production-install-plan.md).
--
-- Removes exactly what 20261005090000 created: the clearing trigger and its function, the three
-- provenance constraints, the two columns, and private.expand_upce_to_upca. Fails closed if any
-- provenance exists (only a 17.3a app writes it), so no scan provenance is ever dropped silently.
-- Changes no other data; canonical_gtin14, the 17.3-S RPCs, F-4, flags and cron are untouched.
begin;

do $$
begin
  if exists (
    select 1 from public.owned_products
    where barcode_raw_value is not null or barcode_symbology is not null
  ) then
    raise exception 'Phase 17.3a rollback refused: scan provenance exists, so a 17.3a app is in use. '
      'Use 20261005090200_phase_17_3a_post_rollout_relax.sql instead.';
  end if;
end;
$$;

drop trigger owned_products_clear_stale_barcode_provenance on public.owned_products;
drop function private.clear_stale_owned_product_barcode_provenance();

alter table public.owned_products
  drop constraint owned_products_barcode_provenance_gtin_check,
  drop constraint owned_products_barcode_provenance_check,
  drop constraint owned_products_barcode_provenance_pair_check,
  drop column barcode_symbology,
  drop column barcode_raw_value;

drop function private.expand_upce_to_upca(text);

commit;
