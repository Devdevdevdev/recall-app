-- Phase 16.20: retire direct service-role access to the legacy hash-only gate.
-- Keep the function and owner-only historical backfill path intact.
begin;

revoke execute on function public.record_cpsc_identity_observation(
  text, text, text, text, text, date, text, timestamptz, text
) from service_role;

commit;
