\set ON_ERROR_STOP on
begin;
select set_config('p1620.payload',jsonb_build_object(
  'RecallID','999999','RecallNumber','99999',
  'URL','https://www.cpsc.gov/Recalls/2099/phase-16-20-probe',
  'RecallDate','2099-09-27','Title','Phase 16.20 probe')::text,true);
select set_config('p1620.hash',private.cpsc_payload_sha256_v1(
  current_setting('p1620.payload')::jsonb),true);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select public.record_cpsc_retained_observation(
  '999999','99999','https://www.cpsc.gov/Recalls/2099/phase-16-20-probe',
  'https://www.cpsc.gov/Recalls/2099/phase-16-20-probe',
  'Phase 16.20 probe','2099-09-27',current_setting('p1620.hash'),
  now(),'Phase 16.20 rollback-only probe',current_setting('p1620.payload')::jsonb
)->>'decisionClass' as wrapper_decision;
rollback;
