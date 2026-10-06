-- Phase 17.3a POST-ROLLOUT RELAX, window B (gated). NEVER in supabase/migrations: applied only on an
-- explicit "GO 17.3A-RELAX", as a forward migration, if a 17.3a app is distributed and a provenance
-- constraint rejects legitimate writes (e.g. a scanner payload the app accepts but the database
-- refuses, which would block saving a scanned product).
--
-- Schema stays additive, so both old and 17.3a apps keep working: barcode_raw_value,
-- barcode_symbology, the pair constraint, private.expand_upce_to_upca and the clearing trigger are
-- KEPT. Only the two constraints that can reject a write are dropped. The trigger only ever sets
-- provenance to NULL, so it cannot block a write. Provenance is not a matching input: matching,
-- F-4, flags and cron are unaffected. The app mapper still hides provenance that does not describe
-- gtin (defense in depth). No data is changed.
begin;

alter table public.owned_products
  drop constraint owned_products_barcode_provenance_gtin_check,
  drop constraint owned_products_barcode_provenance_check;

commit;
