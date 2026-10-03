begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

-- Phase 17.7a F-4 test seam. This suite exercises alert mechanics on fixtures whose
-- official scope is not human-reviewed. F-4 (an automatic alert needs a proven
-- complete official scope) is covered by phase-17-7a-f4-automatic-alert-safety.sql;
-- here the proof is granted only inside this rolled-back transaction.
create or replace function private.automatic_alert_eligibility(
  p_owned_product_id uuid, p_recall_notice_id uuid)
returns text language sql stable security definer set search_path = ''
as $f4$ select 'eligible'::text $f4$;


select extensions.ok(has_function_privilege('service_role',
  'public.get_owned_product_evidence_v2(uuid)','EXECUTE'), 'worker may fetch safety evidence');
select extensions.ok(not has_function_privilege('authenticated',
  'public.get_owned_product_evidence_v2(uuid)','EXECUTE'), 'consumer cannot fetch worker evidence');
select extensions.ok(not has_function_privilege('authenticated',
  'public.create_recall_v2_alert(uuid,uuid)','EXECUTE'), 'consumer cannot create v2 alert');
select extensions.ok(not has_function_privilege('authenticated',
  'public.approve_cpsc_product_model_criterion_v2(uuid,integer,text,text,text)','EXECUTE'),
  'consumer cannot approve criteria');

insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
('a1000000-0000-4000-8000-000000000001','authenticated','authenticated',
 'phase164-owner@example.invalid','',now(),'{}','{}',now(),now()),
('a1000000-0000-4000-8000-000000000002','authenticated','authenticated',
 'phase164-other@example.invalid','',now(),'{}','{}',now(),now());
insert into public.recall_sources
  (id,source_key,name,jurisdiction,base_url,is_authoritative)
values ('a1000000-0000-4000-8000-000000000003','cpsc',
  'U.S. Consumer Product Safety Commission (CPSC)','US','https://www.cpsc.gov',true);
insert into public.recall_notices
  (id,source_id,external_id,title,recall_date,official_url,retrieved_at,raw_payload)
select 'a2000000-0000-4000-8000-000000000001',id,'phase-16-4-fixture',
  'Controlled product model recall','2026-09-20',
  'https://www.cpsc.gov/Recalls/2026/phase-16-4',now(),
  '{"Products":[{"Name":"Controlled product","Model":"MODEL-1"}],"ProductUPCs":[{"UPC":"012345678905"}]}'::jsonb
from public.recall_sources where source_key = 'cpsc';
insert into public.recall_scopes(id,recall_notice_id,product_name,model_number)
values ('a3000000-0000-4000-8000-000000000001',
 'a2000000-0000-4000-8000-000000000001','Controlled product','MODEL-1');
-- Phase 16.11 retired the free-text approval path: only the human review ledger
-- can make a criterion matcher-consumable.
select extensions.throws_ok($$select public.approve_cpsc_product_model_criterion_v2(
  'a3000000-0000-4000-8000-000000000001',0,'reviewer-fixture',
  'Official product-specific model is mandatory for this controlled fixture.',repeat('a',64))$$,
  '42501',null,'retired free-text approval cannot create a criterion');
select extensions.is((select reviewed_criteria
 from public.get_recall_v2_scopes('a2000000-0000-4000-8000-000000000001')),
 null,'no reviewed criterion exists without the human ledger');
select extensions.is((select count(*)::integer from public.get_recall_v2_scopes(
 'a2000000-0000-4000-8000-000000000001') where reviewed_criteria::text like '%ProductUPCs%'),
 0,'recall-level UPC was not promoted');

insert into public.owned_products
 (id,user_id,product_name,model_number,identification_method)
values
('a4000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001',
 'Controlled product','MODEL-1','manual'),
('a4000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001',
 'Controlled product',null,'manual'),
('a4000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000001',
 'Controlled product','MODEL-2','manual'),
('a4000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000001',
 'Controlled product','MODEL-1','manual'),
('a4000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000001',
 'Controlled product','MODEL-1','manual');
select extensions.is((select count(*)::integer from public.get_recall_candidates(
 'a2000000-0000-4000-8000-000000000001',null,null,50)),5,
 'all full-path fixture pairs are bounded candidates');
select extensions.is((select count(*)::integer from public.get_owned_product_evidence_v2(
 'a4000000-0000-4000-8000-000000000001')),1,
 'worker loads owned safety evidence');

create temporary table phase164_claim as
select p.id product_id, p.updated_at product_revision,n.updated_at notice_revision,
  repeat(substr(p.id::text,35,1),64) fingerprint,c.status,c.lease_token
from public.owned_products p
cross join public.recall_notices n
cross join lateral public.claim_recall_match_evaluation(p.id,n.id,
  repeat(substr(p.id::text,35,1),64),p.updated_at,n.updated_at,120) c
where n.id = 'a2000000-0000-4000-8000-000000000001'
  and p.id::text like 'a4000000-%';
select extensions.is((select count(*)::integer from phase164_claim where status='claimed'),5,
 'five candidates claimed');
create temporary table phase164_final as
select c.product_id,r.status,r.alert_eligibility
from phase164_claim c
cross join lateral public.finalize_recall_match_evaluation_v2(
 c.product_id,'a2000000-0000-4000-8000-000000000001',c.fingerprint,
 c.product_revision,c.notice_revision,c.lease_token,
 case right(c.product_id::text,1)
  when '2' then 'needs_review'::public.recall_match_status
  when '3' then 'rejected'::public.recall_match_status
  else 'confirmed'::public.recall_match_status end,
 0.9,'{}'::jsonb,'Controlled local deterministic evaluation.') r;
select extensions.is((select count(*)::integer from phase164_final where status='finalized'),5,
 'all evaluations finalized');
select extensions.is((select count(*)::integer from private.recall_match_evaluations_v2),5,
 'one immutable evaluation per pair');
select extensions.is((select count(*)::integer from private.recall_alert_eligibility_v2),3,
 'confirmed pairs alone have eligibility');
select extensions.is((select count(*)::integer from private.recall_alert_snapshots_v2),0,
 'eligibility alone creates no alert');
select extensions.is((select count(*)::integer from private.push_alert_queue),0,
 'no v2 push is queued');
select extensions.is((select status from public.create_recall_v2_alert(
 'a4000000-0000-4000-8000-000000000001',
 'a2000000-0000-4000-8000-000000000001')),'created',
 'confirmed eligibility creates one alert snapshot');
select extensions.is((select status from public.create_recall_v2_alert(
 'a4000000-0000-4000-8000-000000000001',
 'a2000000-0000-4000-8000-000000000001')),'existing',
 'replay finds the existing alert');
select extensions.is((select count(*)::integer from private.recall_alert_snapshots_v2),1,
 'alert snapshot exists exactly once');
select extensions.is((select count(*)::integer from private.push_alert_queue),0,
 'v2 alert creates no push queue entry');
select extensions.is((select status from public.create_recall_v2_alert(
 'a4000000-0000-4000-8000-000000000002',
 'a2000000-0000-4000-8000-000000000001')),'ineligible',
 'needs review cannot create an alert');
select extensions.is((select status from public.create_recall_v2_alert(
 'a4000000-0000-4000-8000-000000000003',
 'a2000000-0000-4000-8000-000000000001')),'ineligible',
 'rejected cannot create an alert');

update public.owned_products set model_number = null
where id in ('a4000000-0000-4000-8000-000000000001',
 'a4000000-0000-4000-8000-000000000004');
create temporary table phase164_changed as
select p.id product_id,p.updated_at product_revision,n.updated_at notice_revision,
 c.status,c.lease_token
from public.owned_products p cross join public.recall_notices n
cross join lateral public.claim_recall_match_evaluation(p.id,n.id,repeat('e',64),
 p.updated_at,n.updated_at,120) c
where n.id='a2000000-0000-4000-8000-000000000001'
 and p.id in ('a4000000-0000-4000-8000-000000000001',
 'a4000000-0000-4000-8000-000000000004');
select extensions.is((select count(*)::integer from phase164_changed where status='claimed'),2,
 'changed evidence gets new claims');
select public.finalize_recall_match_evaluation_v2(
 c.product_id,'a2000000-0000-4000-8000-000000000001',repeat('e',64),
 c.product_revision,c.notice_revision,c.lease_token,'needs_review',0.5,'{}',
 'Changed evidence is unresolved.') from phase164_changed c;
select extensions.is((select count(*)::integer from private.recall_alert_eligibility_v2
 where revoked_at is not null),2,'pending and delivered eligibility are revoked');
select extensions.is((select status from public.create_recall_v2_alert(
 'a4000000-0000-4000-8000-000000000004',
 'a2000000-0000-4000-8000-000000000001')),'ineligible',
 'revocation prevents pending alert creation');
select extensions.is((select count(*)::integer from private.recall_alert_snapshots_v2
 where owned_product_id='a4000000-0000-4000-8000-000000000001'),1,
 'original v2 alert is preserved after correction');
select extensions.is((select count(*)::integer from private.recall_alert_corrections_v2
 where owned_product_id='a4000000-0000-4000-8000-000000000001'),1,
 'later v2 reversal creates a correction');

insert into public.recall_matches(id,owned_product_id,recall_notice_id,status,confidence,
 match_method,matched_identifiers,reasoning_summary,schema_version,evidence_fingerprint)
values ('a5000000-0000-4000-8000-000000000001',
 'a4000000-0000-4000-8000-000000000005',
 'a2000000-0000-4000-8000-000000000001','confirmed',0.9,
 'deterministic_v1','{}','Legacy confirmed fixture.','1.0.0',repeat('f',64));
insert into public.alerts(id,user_id,recall_match_id)
values ('a6000000-0000-4000-8000-000000000001',
 'a1000000-0000-4000-8000-000000000001',
 'a5000000-0000-4000-8000-000000000001');
create temporary table phase164_legacy_claim as
select p.updated_at product_revision,n.updated_at notice_revision,c.lease_token
from public.owned_products p cross join public.recall_notices n
cross join lateral public.claim_recall_match_evaluation(p.id,n.id,repeat('9',64),
 p.updated_at,n.updated_at,120) c
where p.id='a4000000-0000-4000-8000-000000000005'
 and n.id='a2000000-0000-4000-8000-000000000001';
select extensions.is((select status from public.finalize_recall_match_evaluation_v2(
 'a4000000-0000-4000-8000-000000000005',
 'a2000000-0000-4000-8000-000000000001',repeat('9',64),
 (select product_revision from phase164_legacy_claim),
 (select notice_revision from phase164_legacy_claim),
 (select lease_token from phase164_legacy_claim),'rejected',0.98,'{}',
 'Newer v2 evidence conflicts.')),'finalized','historical v1 pair re-evaluates');
select extensions.is((select count(*)::integer from public.alerts
 where id='a6000000-0000-4000-8000-000000000001'),1,
 'historical v1 alert is not deleted');
select extensions.is((select count(*)::integer from private.recall_alert_corrections_v2
 where legacy_alert_id='a6000000-0000-4000-8000-000000000001'),1,
 'historical v1 alert gets correction record');
select extensions.is((select source_snapshot->>'official_url'
 from private.recall_legacy_alert_snapshots_v2
 where alert_id='a6000000-0000-4000-8000-000000000001'),
 'https://www.cpsc.gov/Recalls/2026/phase-16-4',
 'historical official source snapshot retained');
select set_config('phase164.alert_id',
  (select id::text from private.recall_alert_snapshots_v2
   where owned_product_id='a4000000-0000-4000-8000-000000000001'), true);

set local role authenticated;
set local request.jwt.claim.sub='a1000000-0000-4000-8000-000000000001';
select extensions.is((select count(*)::integer from public.get_recall_safety_feed_v2()),5,
 'owner sees latest v2 observations');
select extensions.is((select display_state from public.get_recall_safety_feed_v2()
 where owned_product_id='a4000000-0000-4000-8000-000000000005'),
 'no_longer_confirmed','historical v1 correction is consumer readable');
select extensions.ok(public.update_recall_v2_alert_state(
  current_setting('phase164.alert_id')::uuid, 'read'),
  'owner may mark v2 alert as read');
reset role;
reset request.jwt.claim.sub;
set local role authenticated;
set local request.jwt.claim.sub='a1000000-0000-4000-8000-000000000002';
select extensions.is((select count(*)::integer from public.get_recall_safety_feed_v2()),0,
 'other account cannot read v2 observations');
select extensions.ok(not public.update_recall_v2_alert_state(
  current_setting('phase164.alert_id')::uuid, 'dismissed'),
  'other account cannot change v2 alert state');
reset role;
reset request.jwt.claim.sub;

select * from extensions.finish();
rollback;
