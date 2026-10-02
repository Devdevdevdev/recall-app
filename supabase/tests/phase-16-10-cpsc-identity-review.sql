begin;
set local role postgres;
set local search_path = extensions, public, auth;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

select extensions.ok(relrowsecurity, 'notice links have RLS') from pg_class
  where oid = 'private.cpsc_notice_identity_links'::regclass;
select extensions.ok(relrowsecurity, 'observations have RLS') from pg_class
  where oid = 'private.cpsc_identity_observations'::regclass;
select extensions.ok(relrowsecurity, 'reviewer authorizations have RLS') from pg_class
  where oid = 'private.cpsc_reviewer_authorizations'::regclass;
select extensions.ok(not has_table_privilege('anon', 'private.cpsc_candidate_review_ledger', 'SELECT'),
  'anon cannot read ledger');
select extensions.ok(not has_table_privilege('anon', 'private.cpsc_candidate_review_ledger', 'INSERT'),
  'anon cannot write ledger');
select extensions.ok(not has_table_privilege('authenticated', 'private.cpsc_candidate_review_ledger', 'INSERT'),
  'consumer cannot write ledger directly');
select extensions.ok(not has_table_privilege('service_role', 'private.cpsc_candidate_review_ledger', 'INSERT'),
  'service worker cannot approve directly');
select extensions.ok(not has_table_privilege('service_role', 'private.cpsc_reviewer_authorizations', 'INSERT'),
  'service worker cannot grant reviewer authorization');
select extensions.ok(not has_table_privilege('service_role', 'private.cpsc_source_aliases', 'INSERT'),
  'worker creates aliases only through collision-aware RPC');
select extensions.ok(not has_table_privilege('service_role', 'private.cpsc_identity_observations', 'INSERT'),
  'worker cannot forge resolved observation rows directly');
select extensions.ok(not has_table_privilege('service_role', 'private.cpsc_notice_identity_links', 'INSERT'),
  'worker cannot reassign historical notice links');
-- Phase 16.11 replaced the (runtime-unusable) private table grants with worker RPCs.
select extensions.ok(not has_function_privilege('service_role',
  'public.record_cpsc_page_fetch(uuid,uuid,timestamptz,integer,text,text,text,text,text,jsonb,text)', 'EXECUTE'),
  'shared service role cannot append transport snapshots directly');
select extensions.ok(not has_function_privilege('service_role',
  'public.propose_cpsc_candidate_criterion(uuid,uuid,jsonb,text,text,jsonb,text,text,text)', 'EXECUTE'),
  'shared service role cannot append unreviewed proposals directly');
select extensions.ok(not has_function_privilege('anon',
  'public.decide_cpsc_candidate(uuid,text,boolean,text)', 'EXECUTE'),
  'anon cannot call human decision RPC');
select extensions.ok(not has_function_privilege('service_role',
  'public.decide_cpsc_candidate(uuid,text,boolean,text)', 'EXECUTE'),
  'worker cannot call human decision RPC');
select extensions.ok(has_function_privilege('authenticated',
  'public.decide_cpsc_candidate(uuid,text,boolean,text)', 'EXECUTE'),
  'human reviewer can call restricted decision RPC');
select extensions.ok(not has_function_privilege('anon',
  'public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)', 'EXECUTE'),
  'public cannot bypass quarantine with observation RPC');
select extensions.ok(not has_function_privilege('authenticated',
  'public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)', 'EXECUTE'),
  'consumer cannot bypass quarantine with observation RPC');
-- Phase 16.20 retires the direct worker grant; historical owner calls remain.
select extensions.ok(not has_function_privilege('service_role',
  'public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)', 'EXECUTE'),
  'worker cannot call the legacy observation RPC directly');
select extensions.ok(not has_function_privilege('service_role',
  'public.ingest_cpsc_recall(text,text,text,text,text,date,text,timestamptz,jsonb,jsonb)', 'EXECUTE'),
  'legacy numeric CPSC write RPC is unavailable to worker');
select extensions.ok(not exists (
  select 1 from information_schema.columns where table_schema = 'private'
    and table_name in ('cpsc_page_fetches', 'cpsc_page_revisions', 'cpsc_identity_observations')
    and column_name in ('owned_product_id', 'user_id', 'safety_attributes')
), 'source snapshots contain no owned-product private columns');

insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('16100000-0000-4000-8000-000000000001','authenticated','authenticated',
   'cpsc-reviewer@example.invalid','','2099-01-01','{}','{}',now(),now()),
  ('16100000-0000-4000-8000-000000000002','authenticated','authenticated',
   'cpsc-consumer@example.invalid','','2099-01-01','{}','{}',now(),now());
-- Phase 16.33: human capabilities need a live aal2 session with a fresh MFA
-- step and a verified factor. Each fixture user gets one (session id = user id).
insert into auth.sessions (id, user_id, aal, created_at, updated_at)
select u.id, u.id, 'aal2', now(), now() from auth.users u
where u.created_at = now() and u.email ~ '@example[.](invalid|test)$'
  and not exists (select 1 from auth.sessions s where s.id = u.id);
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at,
  updated_at)
select u.id, u.id, 'pgTAP TOTP', 'totp', 'verified', now(), now() from auth.users u
where u.created_at = now() and u.email ~ '@example[.](invalid|test)$'
  and not exists (select 1 from auth.mfa_factors f where f.id = u.id);
insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
select gen_random_uuid(), u.id, 'totp', now(), now() from auth.users u
where u.created_at = now() and u.email ~ '@example[.](invalid|test)$'
  and not exists (select 1 from auth.mfa_amr_claims a where a.session_id = u.id);
insert into private.cpsc_reviewer_authorizations (user_id, reason)
values ('16100000-0000-4000-8000-000000000001','local pgTAP reviewer fixture');

select set_config('phase1610.source', public.ensure_cpsc_recall_source()::text, true);
insert into public.recall_notices (id,source_id,external_id,title,recall_date,
  official_url,retrieved_at,raw_payload)
values
  ('16100000-0000-4000-8000-000000000011',current_setting('phase1610.source')::uuid,
   '10965','Test CPSC Recall A','2026-09-10',
   'https://www.cpsc.gov/Recalls/2026/Test-A',now(),'{}'),
  ('16100000-0000-4000-8000-000000000012',current_setting('phase1610.source')::uuid,
   '10962','Test CPSC Recall B','2026-09-10',
   'https://www.cpsc.gov/Recalls/2026/Test-B',now(),'{}');
insert into public.recall_scopes (id,recall_notice_id,model_number)
values ('16100000-0000-4000-8000-000000000021',
  '16100000-0000-4000-8000-000000000011','MODEL-A');
insert into private.cpsc_source_identities (id,source_id,official_recall_number,
  canonical_url,canonical_notice_id,identity_status)
values
  ('16100000-0000-4000-8000-000000000031',current_setting('phase1610.source')::uuid,
   '26748','https://www.cpsc.gov/Recalls/2026/Test-A',
   '16100000-0000-4000-8000-000000000011','reconciled'),
  ('16100000-0000-4000-8000-000000000032',current_setting('phase1610.source')::uuid,
   '26749','https://www.cpsc.gov/Recalls/2026/Test-B',
   '16100000-0000-4000-8000-000000000012','reconciled');
insert into private.cpsc_notice_identity_links (notice_id,identity_id,provenance)
values ('16100000-0000-4000-8000-000000000011',
  '16100000-0000-4000-8000-000000000031','historical fixture');
insert into private.cpsc_source_aliases (identity_id,notice_id,alias_kind,alias_value,
  provenance,first_seen_at,last_seen_at)
values ('16100000-0000-4000-8000-000000000032',
  '16100000-0000-4000-8000-000000000012','api_id','10962',
  'historical fixture',now(),now());

select extensions.is((select count(*) from private.cpsc_notice_identity_links),1::bigint,
  'historical notice link persisted without changing notice');
select extensions.is((select identity_fingerprint from private.cpsc_source_identities
  where official_recall_number='26748'),
  encode(sha256(convert_to('cpsc','UTF8') || decode('00','hex') ||
    convert_to('26748','UTF8')),'hex'), 'canonical identity fingerprint is stable');

-- Observations are worker calls (Phase 16.11 requires the service role); the
-- PostgREST-shaped claim keeps private-table assertions readable in this block.
set local request.jwt.claims='{"role":"service_role"}';
select extensions.is(
  public.record_cpsc_identity_observation('10962','26748',
    'https://cpsc.gov/Recalls/2026/Test-A',
    'https://www.cpsc.gov/Recalls/2026/Test-A',
    'Test CPSC Recall A','2026-09-10',repeat('a',64),now(),'current API')->>'status',
  'quarantined', 'reused API ID is quarantined');
select extensions.is((select count(*) from private.cpsc_source_aliases
  where alias_kind='api_id' and alias_value='10962'),1::bigint,
  'quarantine did not create a conflicting alias');
select extensions.is(
  public.record_cpsc_identity_observation('10963','26748',
    'https://cpsc.gov/Recalls/2026/Test-A',
    'https://www.cpsc.gov/Recalls/2026/Test-A',
    'Test CPSC Recall A','2026-09-10',repeat('b',64),now(),'current API')->>'status',
  'resolved', 'corroborated fresh API alias resolves');
select extensions.is((select count(*) from private.cpsc_identity_observations
  where resolution='quarantined'),1::bigint,'conflict remains auditable');
select extensions.is(
  public.record_cpsc_identity_observation(p.api,p.num,p.url,p.url,p.title,p.day,
    repeat('c',64),now(),'collision regression')->>'reason', p.reason, p.label)
from (values
  ('10990','26748','https://www.cpsc.gov/Recalls/2026/Test-B','Test CPSC Recall A',
   '2026-09-10'::date,'official number and canonical URL conflict','number/URL conflict quarantines'),
  ('10965','26749','https://www.cpsc.gov/Recalls/2026/Test-B','Test CPSC Recall B',
   '2026-09-10'::date,'API ID belongs to another historical recall',
   'current API ID equal to another recall''s historical row quarantines')
) p(api,num,url,title,day,reason,label);
select extensions.throws_ok(
  $$select public.record_cpsc_identity_observation('10994','26748',
    'https://www.cpsc.gov/Recalls/2026/Test-B','https://www.cpsc.gov/Recalls/2026/Test-A',
    'Test CPSC Recall A','2026-09-10',repeat('c',64),now(),'x')$$,
  null,'Observed CPSC URL does not match canonical URL','observed/canonical URL mismatch is rejected');
-- Phase 16.11: title and date are revisional metadata; a consistent unknown
-- recall number creates a canonical identity instead of quarantining.
select extensions.is(
  public.record_cpsc_identity_observation(p.api,p.num,p.url,p.url,p.title,p.day,
    repeat('c',64),now(),'revision regression')->>'status', p.status, p.label)
from (values
  ('10991','26748','https://www.cpsc.gov/Recalls/2026/Test-A','Another recall title',
   '2026-09-10'::date,'resolved','title correction is a source revision'),
  ('10992','26748','https://www.cpsc.gov/Recalls/2026/Test-A','Test CPSC Recall A',
   '2026-09-11'::date,'resolved','publication date correction is a source revision'),
  ('10993','26999','https://www.cpsc.gov/Recalls/2026/Test-Z','Unknown recall',
   '2026-09-10'::date,'created','consistent unknown recall number creates an identity')
) p(api,num,url,title,day,status,label);
select extensions.is((select count(*) from private.cpsc_source_aliases
  where alias_value in ('10990','10965')),0::bigint,
  'no quarantined observation creates an alias');
select extensions.is((select count(*) from private.cpsc_identity_observations o
  join private.cpsc_source_identities i on i.id = o.identity_id
  where o.resolution='resolved' and o.official_recall_number <> i.official_recall_number),
  0::bigint,'zero resolved numeric-ID misassociation');
reset request.jwt.claims;
-- PostgREST v14 sets request.jwt.claims only; the legacy per-claim GUCs stay unset.
set local request.jwt.claims='{"role":"service_role"}';
select extensions.is(current_setting('request.jwt.claim.role', true), null,
  'fixture mirrors PostgREST: legacy role GUC is unset');
select extensions.throws_ok(
  $$select public.ingest_authoritative_recall('cpsc',null,null,null,null,null,null,null,null,null,null,null)$$,
  '42501',null,'generic service RPC cannot bypass CPSC identity gate (JWT claims)');
reset request.jwt.claims;
set local role service_role;
select extensions.throws_ok(
  $$select public.ingest_authoritative_recall('cpsc',null,null,null,null,null,null,null,null,null,null,null)$$,
  '42501',null,'generic service RPC cannot bypass CPSC identity gate (database role)');
select extensions.throws_ok(
  $$select public.decide_cpsc_candidate('16100000-0000-4000-8000-000000000051','reviewed',true)$$,
  '42501',null,'service worker cannot execute human decision RPC');
reset role;
select extensions.throws_ok(
  $$insert into private.cpsc_page_revisions (identity_id,evidence_hash,recall_number,
    canonical_url,title,section_hashes,normalized_evidence)
    values ('16100000-0000-4000-8000-000000000031',repeat('e',64),'26749',
    'https://www.cpsc.gov/Recalls/2026/Test-B','Mismatched','{}','{}')$$,
  null,'CPSC page revision does not match its canonical identity',
  'page snapshot cannot be attached to another identity');

insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,
  canonical_url,title,section_hashes,normalized_evidence,parser_version)
values ('16100000-0000-4000-8000-000000000041',
  '16100000-0000-4000-8000-000000000031',repeat('a',64),'26748',
  'https://www.cpsc.gov/Recalls/2026/Test-A','Test CPSC Recall A',
  '{}','{}','phase-16.10-structured-v1');
insert into private.cpsc_candidate_criteria (id,revision_id,proposed_scope_id,
  evidence_address,evidence_fingerprint,criterion_kind,criterion_value,
  proposed_operator,interpretation,conjunction_key,authoritative_excerpt,
  parser_version)
values
  ('16100000-0000-4000-8000-000000000051',
   '16100000-0000-4000-8000-000000000041',
   '16100000-0000-4000-8000-000000000021',
   '{"source":"cpsc","sectionIdentity":"description","fieldIdentity":"model","rowIdentity":"row-a"}',
   repeat('c',64),'model_exact','"MODEL-A"','exact','mandatory_candidate',
   'row-a','MODEL-A','phase-16.10-structured-v1'),
  ('16100000-0000-4000-8000-000000000052',
   '16100000-0000-4000-8000-000000000041',
   '16100000-0000-4000-8000-000000000021',
   '{"source":"cpsc","sectionIdentity":"description","fieldIdentity":"date_code","rowIdentity":"row-a"}',
   repeat('d',64),'date_code_exact','"2510"','exact','mandatory_candidate',
   'row-a','2510','phase-16.10-structured-v1'),
  ('16100000-0000-4000-8000-000000000053',
   '16100000-0000-4000-8000-000000000041',
   '16100000-0000-4000-8000-000000000021',
   '{"source":"cpsc","sectionIdentity":"description","fieldIdentity":"model","rowIdentity":"row-b"}',
   repeat('c',64),'model_exact','"MODEL-B"','exact','mandatory_candidate',
   'row-b','MODEL-B','phase-16.10-structured-v1'),
  ('16100000-0000-4000-8000-000000000054',
   '16100000-0000-4000-8000-000000000041',
   '16100000-0000-4000-8000-000000000021',
   '{"source":"cpsc","sectionIdentity":"description","fieldIdentity":"date_code","rowIdentity":"row-b"}',
   repeat('d',64),'date_code_exact','"2511"','exact','mandatory_candidate',
   'row-b','2511','phase-16.10-structured-v1'),
  ('16100000-0000-4000-8000-000000000055',
   '16100000-0000-4000-8000-000000000041',
   '16100000-0000-4000-8000-000000000021',
   '{"source":"cpsc","sectionIdentity":"description","fieldIdentity":"model","rowIdentity":"row-c"}',
   repeat('c',64),'model_exact','"MODEL-C"','exact','mandatory_candidate',
   'row-c','MODEL-C','phase-16.10-structured-v1'),
  ('16100000-0000-4000-8000-000000000056',
   '16100000-0000-4000-8000-000000000041',
   '16100000-0000-4000-8000-000000000021',
   '{"source":"cpsc","sectionIdentity":"description","fieldIdentity":"date_code","rowIdentity":"row-c"}',
   repeat('d',64),'date_code_exact','"2512"','exact','mandatory_candidate',
   'row-c','2512','phase-16.10-structured-v1');

-- Human decisions run as the authenticated database role with PostgREST-shaped claims.
set local role authenticated;
set local request.jwt.claims='{"role":"authenticated","aal":"aal2","session_id":"16100000-0000-4000-8000-000000000002","sub":"16100000-0000-4000-8000-000000000002"}';
select extensions.throws_ok(
  $$select public.decide_cpsc_candidate('16100000-0000-4000-8000-000000000051','reviewed',true)$$,
  '42501',null,'ordinary consumer cannot approve');
select extensions.throws_ok(
  $$select public.get_cpsc_candidate_review_packet('16100000-0000-4000-8000-000000000051')$$,
  '42501',null,'second consumer cannot read private review packet');
select extensions.throws_ok(
  $$select count(*) from private.cpsc_candidate_review_ledger$$,
  '42501',null,'consumer cannot read review ledger directly');
set local request.jwt.claims='{"role":"authenticated","aal":"aal2","session_id":"16100000-0000-4000-8000-000000000001","sub":"16100000-0000-4000-8000-000000000001"}';
select extensions.is(current_setting('request.jwt.claim.role', true), null,
  'reviewer path does not rely on the legacy role GUC');
select extensions.ok((public.get_cpsc_candidate_review_packet(
  '16100000-0000-4000-8000-000000000051') -> 'allConjuncts') @>
  '[{"kind":"date_code_exact","value":"2510"}]'::jsonb,
  'review packet shows other mandatory conjunct');
select extensions.is(jsonb_array_length(public.get_cpsc_candidate_review_packet(
  '16100000-0000-4000-8000-000000000051') -> 'allConjuncts'), 2,
  'review packet shows only its own conjunction');
select extensions.ok(public.get_cpsc_candidate_review_packet(
  '16100000-0000-4000-8000-000000000051') ?& array['officialUrl','recallNumber',
  'sourceRevision','evidenceAddress','authoritativeExcerpt','normalizedCriterion',
  'criterionKind','operator','conjunctionGroup','parserVersion'],
  'review packet carries the full presentation contract');
select extensions.throws_ok(
  $$select public.decide_cpsc_candidate('16100000-0000-4000-8000-000000000051','reviewed',false)$$,
  null,'Mandatory eligibility attestation required',
  'approval requires explicit mandatory-eligibility attestation');
select extensions.ok(public.decide_cpsc_candidate(
  '16100000-0000-4000-8000-000000000051','reviewed',true,
  'Official model eligibility verified') is not null,
  'authorized human can approve');
select extensions.ok(public.decide_cpsc_candidate(
  '16100000-0000-4000-8000-000000000052','rejected',false,
  'Date code association not approved') is not null,
  'authorized human can reject');
select extensions.throws_ok(
  $$select public.decide_cpsc_candidate('16100000-0000-4000-8000-000000000052','reviewed',true)$$,
  null,'Candidate already has a decision','a decision cannot be overwritten');
select public.decide_cpsc_candidate('16100000-0000-4000-8000-000000000053','reviewed',true);
select public.decide_cpsc_candidate('16100000-0000-4000-8000-000000000054','reviewed',true);
select public.decide_cpsc_candidate('16100000-0000-4000-8000-000000000055','reviewed',true);
reset request.jwt.claims;
reset role;

select extensions.is(
  (select array_agg(candidate_id order by candidate_id) from private.cpsc_current_reviewed_criteria),
  array['16100000-0000-4000-8000-000000000053','16100000-0000-4000-8000-000000000054']::uuid[],
  'only a fully reviewed conjunction is confirmation-eligible');
select extensions.ok(not exists (select 1 from private.cpsc_current_reviewed_criteria
  where candidate_id in ('16100000-0000-4000-8000-000000000051',
    '16100000-0000-4000-8000-000000000055')),
  'approved model with rejected or unreviewed date code never widens to model-only');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger
  where decision='reviewed' and reviewer_user_id='16100000-0000-4000-8000-000000000001'
    and mandatory_eligibility and normalized_criterion is not null
    and reviewed_operator is not null and conjunction_key is not null
    and source_revision_hash = repeat('a',64) and evidence_address ? 'rowIdentity'),
  4::bigint,'reviewed events preserve reviewer, revision, address, criterion, operator, conjunction');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger
  where decision='rejected'),1::bigint,'rejection remains auditable');
select extensions.ok(not has_table_privilege(r, 'private.cpsc_candidate_review_ledger', p),
  format('%s cannot %s review history', r, p))
  from unnest(array['anon','authenticated','service_role']) r,
    unnest(array['UPDATE','DELETE','TRUNCATE']) p;

-- A transport-only refetch (new raw bytes, same semantic evidence) keeps approval.
insert into private.cpsc_page_fetches (identity_id,revision_id,fetched_at,http_status,
  raw_page_hash,final_url,content_type)
values ('16100000-0000-4000-8000-000000000031','16100000-0000-4000-8000-000000000041',
  now(),200,repeat('f',64),'https://www.cpsc.gov/Recalls/2026/Test-A','text/html');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger
  where decision='stale'),0::bigint,'cosmetic transport change keeps approval current');
select extensions.is((select count(*) from private.cpsc_current_reviewed_criteria),
  2::bigint,'cosmetic transport change keeps the reviewed conjunction usable');
insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,
  canonical_url,title,section_hashes,normalized_evidence,parser_version)
values ('16100000-0000-4000-8000-000000000042',
  '16100000-0000-4000-8000-000000000031',repeat('b',64),'26748',
  'https://www.cpsc.gov/Recalls/2026/Test-A','Test CPSC Recall A',
  '{}','{}','phase-16.10-structured-v1');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger
  where decision='stale'),4::bigint,'semantic revision stales every reviewed criterion');
select extensions.is((select count(*) from private.cpsc_current_reviewed_criteria),
  0::bigint,'stale criterion is unusable for confirmation');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger
  where decision in ('reviewed','rejected')),5::bigint,
  'semantic revision preserves reviewed and rejected history');
set local role authenticated;
set local request.jwt.claims='{"role":"authenticated","aal":"aal2","session_id":"16100000-0000-4000-8000-000000000001","sub":"16100000-0000-4000-8000-000000000001"}';
select extensions.throws_ok(
  $$select public.decide_cpsc_candidate('16100000-0000-4000-8000-000000000056','reviewed',true)$$,
  null,'Candidate source revision is stale','old source revision cannot be approved');
reset request.jwt.claims;
reset role;

-- Two semantic revisions with the same timestamp are ambiguous: neither is current.
insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,
  canonical_url,title,section_hashes,normalized_evidence)
values
  ('16100000-0000-4000-8000-000000000043','16100000-0000-4000-8000-000000000032',
   repeat('1',64),'26749','https://www.cpsc.gov/Recalls/2026/Test-B','Test CPSC Recall B','{}','{}'),
  ('16100000-0000-4000-8000-000000000044','16100000-0000-4000-8000-000000000032',
   repeat('2',64),'26749','https://www.cpsc.gov/Recalls/2026/Test-B','Test CPSC Recall B','{}','{}');
insert into private.cpsc_candidate_criteria (id,revision_id,proposed_scope_id,
  evidence_address,evidence_fingerprint,criterion_kind,criterion_value,
  proposed_operator,interpretation,conjunction_key,authoritative_excerpt)
values
  ('16100000-0000-4000-8000-000000000057','16100000-0000-4000-8000-000000000043',
   '16100000-0000-4000-8000-000000000021','{"source":"cpsc"}',repeat('c',64),
   'model_exact','"MODEL-T"','exact','mandatory_candidate',null,'MODEL-T'),
  ('16100000-0000-4000-8000-000000000058','16100000-0000-4000-8000-000000000044',
   '16100000-0000-4000-8000-000000000021','{"source":"cpsc"}',repeat('c',64),
   'model_exact','"MODEL-T"','exact','mandatory_candidate',null,'MODEL-T');
set local role authenticated;
set local request.jwt.claims='{"role":"authenticated","aal":"aal2","session_id":"16100000-0000-4000-8000-000000000001","sub":"16100000-0000-4000-8000-000000000001"}';
select extensions.throws_ok(
  $$select public.decide_cpsc_candidate('16100000-0000-4000-8000-000000000057','reviewed',true)$$,
  null,'Candidate source revision is stale','timestamp tie fails closed (first revision)');
select extensions.throws_ok(
  $$select public.decide_cpsc_candidate('16100000-0000-4000-8000-000000000058','reviewed',true)$$,
  null,'Candidate source revision is stale','timestamp tie fails closed (second revision)');
reset request.jwt.claims;
reset role;

-- A revoked reviewer is no longer a human reviewer.
update private.cpsc_reviewer_authorizations set revoked_at=now()
  where user_id='16100000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims='{"role":"authenticated","aal":"aal2","session_id":"16100000-0000-4000-8000-000000000001","sub":"16100000-0000-4000-8000-000000000001"}';
select extensions.throws_ok(
  $$select public.get_cpsc_candidate_review_packet('16100000-0000-4000-8000-000000000056')$$,
  '42501',null,'revoked reviewer loses review access');
reset request.jwt.claims;
reset role;

select extensions.finish();
rollback;
