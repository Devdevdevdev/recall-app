-- Run this file alone against a populated database. Every fixture is rolled back.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '20s';
set local idle_in_transaction_session_timeout = '30s';

select extensions.plan(89);

-- Schema, RLS, constraints and RPC ACLs are checked before any fixture write.
select extensions.has_table('private','recall_match_evaluations_v2','v2 evaluations exist');
select extensions.has_table('private','recall_alert_eligibility_v2','v2 eligibility exists');
select extensions.has_table('private','recall_alert_snapshots_v2','v2 alert snapshots exist');
select extensions.has_table('private','recall_alert_corrections_v2','v2 corrections exist');
select extensions.ok((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in ('recall_scope_criteria_v2','recall_match_evaluations_v2','recall_alert_eligibility_v2','recall_alert_snapshots_v2','recall_evaluation_evidence_v2','recall_legacy_alert_snapshots_v2','recall_alert_corrections_v2')),'all seven private v2 tables have RLS');
select extensions.ok((select count(*)=7 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in ('recall_scope_criteria_v2','recall_match_evaluations_v2','recall_alert_eligibility_v2','recall_alert_snapshots_v2','recall_evaluation_evidence_v2','recall_legacy_alert_snapshots_v2','recall_alert_corrections_v2')),'all seven private v2 tables are present');
select extensions.ok(exists(select 1 from pg_constraint where conrelid='private.recall_match_evaluations_v2'::regclass and pg_get_constraintdef(oid)='UNIQUE (owned_product_id, recall_notice_id, evidence_fingerprint)'),'pair and fingerprint are unique');
select extensions.ok(exists(select 1 from pg_constraint where conrelid='private.recall_alert_eligibility_v2'::regclass and conname='recall_alert_eligibility_v2_pkey'),'eligibility is pair unique');
select extensions.ok(exists(select 1 from pg_constraint where conrelid='private.recall_alert_snapshots_v2'::regclass and conname='recall_alert_snapshots_v2_owned_product_id_recall_notice_id_key'),'alert snapshots are pair unique');
select extensions.ok(has_function_privilege('service_role','public.finalize_recall_match_evaluation_v2(uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,jsonb,text)','EXECUTE'),'service may finalize');
select extensions.ok(has_function_privilege('service_role','public.create_recall_v2_alert(uuid,uuid)','EXECUTE'),'service may create an alert snapshot');
select extensions.ok(not has_function_privilege('authenticated','public.finalize_recall_match_evaluation_v2(uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,jsonb,text)','EXECUTE'),'authenticated cannot finalize');
select extensions.ok(not has_function_privilege('anon','public.create_recall_v2_alert(uuid,uuid)','EXECUTE'),'anon cannot create an alert snapshot');
select extensions.ok(has_function_privilege('authenticated','public.get_recall_safety_feed_v2()','EXECUTE'),'authenticated may use owner-filtered feed');
select extensions.ok(not has_function_privilege('anon','public.get_recall_safety_feed_v2()','EXECUTE'),'anon cannot use feed');
select extensions.ok((select count(*)<=1 from public.recall_sources where source_key='cpsc'),'existing CPSC source identity is unique and read only');

-- Post-16.11 trust boundary: the only path to a matcher rule set is worker
-- evidence -> authorized human review -> complete conjunction -> materialization.
-- The retired free-text approval is never called; only its revoked grants are checked.
select extensions.ok(not has_function_privilege(r,'public.approve_cpsc_product_model_criterion_v2(uuid,integer,text,text,text)','EXECUTE'),
  format('%s cannot execute the retired approval',r)) from unnest(array['anon','authenticated','service_role']) r;
select extensions.ok((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='private' and c.relname='recall_scope_rule_sets_v2'),'rule sets have RLS');
select extensions.ok(has_function_privilege('authenticated','public.decide_cpsc_candidate(uuid,text,boolean,text)','EXECUTE')
  and not has_function_privilege('service_role','public.decide_cpsc_candidate(uuid,text,boolean,text)','EXECUTE')
  and not has_function_privilege('service_role','public.materialize_cpsc_reviewed_conjunction(uuid)','EXECUTE'),
  'human review is not executable by the service role');
-- Post-16.13: source-coverage ledger and the reviewer pending-candidate queue.
select extensions.ok((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private' and c.relname='cpsc_page_coverage_ledgers')
  and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r,
    unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
    where has_table_privilege(r,'private.cpsc_page_coverage_ledgers',p)),
  'coverage ledgers have RLS and no API privilege');
select extensions.ok(not has_function_privilege('service_role','public.record_cpsc_page_coverage(uuid,jsonb)','EXECUTE')
  and not has_function_privilege('authenticated','public.record_cpsc_page_coverage(uuid,jsonb)','EXECUTE')
  and not has_function_privilege('anon','public.record_cpsc_page_coverage(uuid,jsonb)','EXECUTE'),
  'legacy direct coverage RPC is owner-only');
select extensions.ok(has_function_privilege('authenticated','public.list_cpsc_pending_review_candidates(integer,text)','EXECUTE')
  and not has_function_privilege('service_role','public.list_cpsc_pending_review_candidates(integer,text)','EXECUTE')
  and not has_function_privilege('anon','public.list_cpsc_pending_review_candidates(integer,text)','EXECUTE'),
  'only humans can call the pending-review queue');

create temporary table phase16_fixture(k text primary key, id uuid not null unique, fingerprint text) on commit drop;
insert into phase16_fixture(k,id,fingerprint)
select k,gen_random_uuid(),null from unnest(array['owner','other','reviewer','p1','p2','p3','p4','p5','legacy_match','legacy_alert']) k;
update phase16_fixture set fingerprint=md5(id::text)||md5(id::text||':phase16') where k like 'p%';

-- Unique, unused identity values: never an existing recall number, API ID, or URL.
select set_config('phase16.source',coalesce(
  (select id::text from public.recall_sources where source_key='cpsc' order by created_at limit 1),
  public.ensure_cpsc_recall_source()::text),true);
select set_config('phase16.number',(select n::text from generate_series(90000,99999) n
  where not exists(select 1 from private.cpsc_source_identities i where i.official_recall_number=n::text)
    and not exists(select 1 from public.recall_notices x where x.raw_payload->>'RecallNumber' in (n::text,
      substr(n::text,1,2)||'-'||substr(n::text,3)))
  order by random() limit 1),true);
select set_config('phase16.api',(select a::text from (select 900000000000+floor(random()*99999999999)::bigint a
  from generate_series(1,20)) c where not exists(select 1 from private.cpsc_source_aliases x where x.alias_value=a::text)
    and not exists(select 1 from public.recall_notices x where x.external_id=a::text) limit 1),true);
select set_config('phase16.url','https://www.cpsc.gov/Recalls/2099/pgtap-phase16-'||gen_random_uuid()::text,true);
select set_config('phase16.row',md5(current_setting('phase16.url')||':row')||md5(current_setting('phase16.api')||':row'),true);
select extensions.ok(current_setting('phase16.number') ~ '^9[0-9]{4}$' and current_setting('phase16.api') ~ '^[0-9]+$',
  'transaction-only recall number and API ID are unused');

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id,'authenticated','authenticated','pgtap_phase16_'||id::text||'@example.invalid','',now(),'{}','{}',now(),now()
from phase16_fixture where k in ('owner','other','reviewer');
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
-- A transaction-only authorization, recorded exactly as the owner grants a real reviewer.
insert into private.cpsc_reviewer_authorizations(user_id,authorized_at,reason)
select id,now()-interval '1 minute','Transaction-only pgTAP reviewer' from phase16_fixture where k='reviewer';
select set_config('phase16.reviewer',(select id::text from phase16_fixture where k='reviewer'),true);

-- Owner-only legacy observation remains available for historical compatibility.
-- The current worker path continues with identity-bound notice and page RPCs.
set local request.jwt.claims = '{"role":"service_role"}';
select set_config('phase16.observation',public.record_cpsc_identity_observation(current_setting('phase16.api'),
  current_setting('phase16.number'),current_setting('phase16.url'),current_setting('phase16.url'),
  'Phase 16 transaction-only recall',current_date,repeat('a',64),now(),'pgTAP remote-safe')::text,true);
set local role service_role;
select extensions.is(current_setting('phase16.observation')::jsonb->>'decisionClass','C_new_identity',
  'worker creates a transaction-only canonical identity');
select set_config('phase16.notice',public.ingest_cpsc_identity_notice(
  (current_setting('phase16.observation')::jsonb->>'observationId')::uuid,'Transaction-only',null,null,now(),
  jsonb_build_object('RecallID',current_setting('phase16.api'),'RecallNumber',current_setting('phase16.number'),
    'Products',jsonb_build_array(jsonb_build_object('Name','Phase 16 product','Model','MODEL-1'))),
  '[{"productName":"Phase 16 product","modelNumber":"MODEL-1"}]')->>'noticeId',true);
-- Historical direct page writes are owner-only after Phase 16.24.
reset role;
select set_config('phase16.revision',public.record_cpsc_page_revision(
  (current_setting('phase16.observation')::jsonb->>'identityId')::uuid,md5(current_setting('phase16.url'))||md5(current_setting('phase16.api')),
  jsonb_build_object('recallNumber',current_setting('phase16.number'),'canonicalUrl',current_setting('phase16.url'),
    'title','Phase 16 transaction-only recall'),'{}',
  jsonb_build_array(jsonb_build_object('identity','pgtap-table','rows',jsonb_build_array(jsonb_build_object(
    'identity',current_setting('phase16.row'),'evidence',jsonb_build_array('Phase 16 product','MODEL-1','2510, 2511'))))),
  'phase-16.13-structured-v2')->>'revisionId',true);
reset request.jwt.claims;
reset role;
select set_config('phase16.scope',(select id::text from public.recall_scopes
  where recall_notice_id=current_setting('phase16.notice')::uuid),true);
insert into phase16_fixture(k,id) values ('notice',current_setting('phase16.notice')::uuid),
  ('scope',current_setting('phase16.scope')::uuid);
set local role postgres;
set local request.jwt.claims = '{"role":"service_role"}';
select set_config('phase16.model',public.propose_cpsc_candidate_criterion(current_setting('phase16.revision')::uuid,
  current_setting('phase16.scope')::uuid,jsonb_build_object('source','cpsc','recallNumber',current_setting('phase16.number'),
    'canonicalUrl',current_setting('phase16.url'),'sourceSemanticRevision',md5(current_setting('phase16.url'))||md5(current_setting('phase16.api')),
    'sectionIdentity','description','tableIdentity','pgtap-table','rowIdentity',current_setting('phase16.row'),'fieldIdentity','model no'),
  repeat('b',64),'model_exact','"MODEL-1"','pgtap-table/'||current_setting('phase16.row'),'Phase 16 product | MODEL-1','phase-16.13-structured-v2')->>'candidateId',true);
select set_config('phase16.date',public.propose_cpsc_candidate_criterion(current_setting('phase16.revision')::uuid,
  current_setting('phase16.scope')::uuid,jsonb_build_object('source','cpsc','recallNumber',current_setting('phase16.number'),
    'canonicalUrl',current_setting('phase16.url'),'sourceSemanticRevision',md5(current_setting('phase16.url'))||md5(current_setting('phase16.api')),
    'sectionIdentity','description','tableIdentity','pgtap-table','rowIdentity',current_setting('phase16.row'),'fieldIdentity','date code'),
  repeat('b',64),'date_code_set','["2510","2511"]','pgtap-table/'||current_setting('phase16.row'),'Phase 16 product | 2510, 2511','phase-16.13-structured-v2')->>'candidateId',true);
select extensions.is((select count(*)::integer from public.get_recall_v2_scopes(current_setting('phase16.notice')::uuid)
  where reviewed_criteria is not null),0,'unreviewed proposals never reach the matcher');
set local role service_role;
select extensions.throws_ok(format($$select public.decide_cpsc_candidate(%L,'reviewed',true)$$,current_setting('phase16.model')),
  '42501',null,'the worker cannot review its own proposal');
set local role postgres;
-- Source-coverage ledger: every record of the page accounted for; the database
-- recomputes statuses and refuses a reviewable record that is not a proposal.
select set_config('phase16.ledger',jsonb_build_object('schema','cpsc_source_coverage_v1',
  'ledgerVersion','phase-16.13-coverage-v1','parserVersion','phase-16.13-structured-v2',
  'extractorVersion','phase-16.11-html-v1','censusVersion','phase-16.13-census-v1',
  'sourceSemanticRevision',md5(current_setting('phase16.url'))||md5(current_setting('phase16.api')),
  'structures',jsonb_build_array(
    jsonb_build_object('structureId','description/prose','kind','prose','sectionIdentity','description',
      'tableIndex',null,'tableIdentity',null,'authoritativeRecordCount',1,'anomalies','[]'::jsonb,
      'records',jsonb_build_array(jsonb_build_object('ordinal',0,'recordIdentity','pgtap-sentence-0',
        'rowIdentity',null,'extraction','extracted','disposition','ignored_non_safety','effect','none',
        'relation',null,'reason','no eligibility content','cells','[]'::jsonb))),
    jsonb_build_object('structureId','pgtap-table','kind','table','sectionIdentity','description',
      'tableIndex',0,'tableIdentity','pgtap-table','authoritativeRecordCount',1,'anomalies','[]'::jsonb,
      'records',jsonb_build_array(jsonb_build_object('ordinal',0,'recordIdentity',current_setting('phase16.row'),
        'rowIdentity',current_setting('phase16.row'),'extraction','extracted','disposition','parsed_reviewable',
        'effect','none','relation','pgtap-table/'||current_setting('phase16.row'),'reason','model conjunction',
        'cells',jsonb_build_array(
          jsonb_build_object('column','model no','criterionClass','model','status','recognized'),
          jsonb_build_object('column','date code','criterionClass','date_code','status','recognized')))))))::text,true);
select extensions.throws_ok(format($$select public.record_cpsc_page_coverage(%L,%L::jsonb)$$,
  current_setting('phase16.revision'),jsonb_set(current_setting('phase16.ledger')::jsonb,
    '{structures,1,records,0,relation}',to_jsonb('pgtap-table/'||repeat('f',64)))),
  null,null,'a ledger naming an unproposed conjunction is refused');
select set_config('phase16.coverage',public.record_cpsc_page_coverage(current_setting('phase16.revision')::uuid,
  current_setting('phase16.ledger')::jsonb)::text,true);
select extensions.ok(current_setting('phase16.coverage')::jsonb->>'status'='created'
    and current_setting('phase16.coverage')::jsonb->>'coverageStatus'='complete'
    and current_setting('phase16.coverage')::jsonb->>'positiveStatus'='independent'
    and (current_setting('phase16.coverage')::jsonb->>'negativeEvidenceEligible')::boolean
    and (current_setting('phase16.coverage')::jsonb->>'authoritativeRecords')::integer=2
    and (current_setting('phase16.coverage')::jsonb->>'accountedRecords')::integer=2,
  'worker records a complete source-coverage ledger (2 / 2 records)');
select extensions.is(public.record_cpsc_page_coverage(current_setting('phase16.revision')::uuid,
  current_setting('phase16.ledger')::jsonb)->>'status','unchanged','a replayed ledger is idempotent');
select extensions.throws_ok($$select public.list_cpsc_pending_review_candidates(10,null)$$,
  '42501',null,'the service role cannot list review candidates');
reset request.jwt.claims;
reset role;

-- Authorized human review of the complete conjunction, then materialization.
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',current_setting('phase16.reviewer'),
  'aal','aal2','session_id',current_setting('phase16.reviewer'))::text,true);
-- The queue is keyset-paginated; a cursor just before this recall lands on it
-- regardless of how many real candidates the database holds.
select set_config('phase16.queue',public.list_cpsc_pending_review_candidates(1,
  lpad((current_setting('phase16.number')::integer-1)::text,5,'0')||'|999999999999|~|~')::text,true);
select extensions.ok(current_setting('phase16.queue')::jsonb#>>'{items,0,recallNumber}'=current_setting('phase16.number')
    and (current_setting('phase16.queue')::jsonb#>>'{items,0,pendingMembers}')::integer=2
    and current_setting('phase16.queue')::jsonb#>>'{items,0,insideRuleSet}'='AND'
    and current_setting('phase16.queue')::jsonb#>>'{items,0,parserCoverage,coverageStatus}'='complete'
    and jsonb_array_length(current_setting('phase16.queue')::jsonb->'items')=1,
  'reviewer lists the pending rule set with its members and parser coverage');
select extensions.throws_ok($$select public.list_cpsc_pending_review_candidates(51,null)$$,
  null,'Review page size must be between 1 and 50','the review queue is bounded');
select extensions.ok(public.decide_cpsc_candidate(current_setting('phase16.model')::uuid,'reviewed',true,'pgTAP') is not null,
  'authorized reviewer reviews the model member');
select extensions.throws_ok(format($$select public.materialize_cpsc_reviewed_conjunction(%L)$$,current_setting('phase16.model')),
  null,'Conjunction is not fully human-reviewed, current, and model-anchored','a partial conjunction cannot materialize');
select extensions.ok(public.decide_cpsc_candidate(current_setting('phase16.date')::uuid,'reviewed',true,'pgTAP') is not null,
  'authorized reviewer reviews the date-code member');
select extensions.is(public.materialize_cpsc_reviewed_conjunction(current_setting('phase16.model')::uuid)->>'status',
  'materialized','the complete reviewed conjunction materializes');
-- Phase 16.33: negative evidence also needs the reviewer's outside-census attestation.
select public.attest_cpsc_outside_census(current_setting('phase16.revision')::uuid,
  public.get_cpsc_outside_census_packet(current_setting('phase16.revision')::uuid)->>'sectionsSha256','[]'::jsonb,
  'Transaction-only pgTAP attestation',1);
reset request.jwt.claims;
reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select extensions.ok((select jsonb_array_length(reviewed_criteria->'ruleSets')=1
    and reviewed_criteria->'ruleSets'->0->'review'->>'origin'='human_review_ledger'
    and reviewed_criteria->'ruleSets'->0->'criteria' @> '[{"kind":"model_number","value":"MODEL-1"}]'
    and reviewed_criteria->'ruleSets'->0->'criteria' @> '[{"kind":"date_code","values":["2510","2511"]}]'
    and (reviewed_criteria->'coverage'->>'complete')::boolean
  from public.get_recall_v2_scopes(current_setting('phase16.notice')::uuid)),
  'service role reads the human-reviewed model AND date-code rule set');
reset request.jwt.claims;
reset role;

insert into public.owned_products(id,user_id,product_name,model_number,identification_method)
select p.id,u.id,'pgtap_phase16_'||p.id::text,case when p.k='p3' then 'MODEL-2' else 'MODEL-1' end,'manual'
from phase16_fixture p cross join phase16_fixture u where p.k in ('p1','p2','p3','p4','p5') and u.k='owner';
select extensions.is((select count(*)::integer from public.owned_products where user_id=(select id from phase16_fixture where k='owner')),5,'five isolated owned products exist');

-- A stale revision must not create an evaluation.
select extensions.is((select status from public.claim_recall_match_evaluation(
  (select id from phase16_fixture where k='p1'),(select id from phase16_fixture where k='notice'),
  (select fingerprint from phase16_fixture where k='p1'),now()-interval '1 day',
  (select updated_at from public.recall_notices where id=(select id from phase16_fixture where k='notice')),120)),
  'stale','claim rejects a stale product revision');
select extensions.is((select count(*)::integer from private.recall_match_evaluations_v2 where recall_notice_id=(select id from phase16_fixture where k='notice')),0,'stale claim wrote no observation');

create temporary table phase16_claim on commit drop as
select p.k,p.id product_id,p.fingerprint,p_row.updated_at product_revision,n_row.updated_at notice_revision,c.status,c.lease_token
from phase16_fixture p join public.owned_products p_row on p_row.id=p.id
cross join public.recall_notices n_row
cross join lateral public.claim_recall_match_evaluation(p.id,n_row.id,p.fingerprint,p_row.updated_at,n_row.updated_at,120) c
where p.k in ('p1','p2','p3','p4') and n_row.id=(select id from phase16_fixture where k='notice');
select extensions.is((select count(*)::integer from phase16_claim where status='claimed'),4,'four pairs receive leases');
select extensions.is((select status from public.finalize_recall_match_evaluation_v2(
  (select product_id from phase16_claim where k='p1'),(select id from phase16_fixture where k='notice'),
  (select fingerprint from phase16_claim where k='p1'),(select product_revision from phase16_claim where k='p1'),
  (select notice_revision from phase16_claim where k='p1'),gen_random_uuid(),'confirmed',0.9,'{}','invalid lease')),
  'stale','finalization rejects an invalid lease');
select extensions.is((select count(*)::integer from private.recall_match_evaluations_v2 where recall_notice_id=(select id from phase16_fixture where k='notice')),0,'invalid lease wrote no observation');

create temporary table phase16_final on commit drop as
select c.k,r.status,r.alert_eligibility,r.evaluation_id
from phase16_claim c
cross join lateral public.finalize_recall_match_evaluation_v2(
  c.product_id,(select id from phase16_fixture where k='notice'),c.fingerprint,
  c.product_revision,c.notice_revision,c.lease_token,
  case c.k when 'p2' then 'needs_review'::public.recall_match_status when 'p3' then 'rejected'::public.recall_match_status else 'confirmed'::public.recall_match_status end,
  0.9,'{}'::jsonb,'Transaction-only deterministic decision.') r;
select extensions.is((select count(*)::integer from phase16_final where status='finalized'),4,'valid leases finalize four observations');
select extensions.is((select count(*)::integer from phase16_final where alert_eligibility='created'),2,'confirmed creates eligibility once per pair');
select extensions.is((select count(*)::integer from private.recall_alert_eligibility_v2 where recall_notice_id=(select id from phase16_fixture where k='notice')),2,'review and rejection create no eligibility');
select extensions.is((select count(*)::integer from private.recall_match_evaluations_v2 where recall_notice_id=(select id from phase16_fixture where k='notice')),4,'one immutable observation per pair and fingerprint');
select extensions.is((select status from public.finalize_recall_match_evaluation_v2(
  (select product_id from phase16_claim where k='p1'),(select id from phase16_fixture where k='notice'),
  (select fingerprint from phase16_claim where k='p1'),(select product_revision from phase16_claim where k='p1'),
  (select notice_revision from phase16_claim where k='p1'),(select lease_token from phase16_claim where k='p1'),
  'confirmed',0.9,'{}','Replay.')),'stale','consumed lease cannot finalize twice');
create temporary table phase16_p1_reclaim on commit drop as
select status,lease_token from public.claim_recall_match_evaluation(
  (select id from phase16_fixture where k='p1'),(select id from phase16_fixture where k='notice'),
  (select fingerprint from phase16_fixture where k='p1'),
  (select updated_at from public.owned_products where id=(select id from phase16_fixture where k='p1')),
  (select updated_at from public.recall_notices where id=(select id from phase16_fixture where k='notice')),120);
select extensions.is((select status from phase16_p1_reclaim),'claimed','same fingerprint may be reclaimed without a v1 match');
select extensions.is((select status from public.finalize_recall_match_evaluation_v2(
  (select id from phase16_fixture where k='p1'),(select id from phase16_fixture where k='notice'),
  (select fingerprint from phase16_fixture where k='p1'),
  (select updated_at from public.owned_products where id=(select id from phase16_fixture where k='p1')),
  (select updated_at from public.recall_notices where id=(select id from phase16_fixture where k='notice')),
  (select lease_token from phase16_p1_reclaim),'confirmed',0.9,'{}','Replay.')),
  'unchanged','confirmed replay adds no new observation');

-- Claim replay is idempotent at the immutable pair/fingerprint boundary.
create temporary table phase16_replay on commit drop as
select c.status,c.lease_token from phase16_fixture p cross join public.owned_products o
cross join public.recall_notices n
cross join lateral public.claim_recall_match_evaluation(p.id,n.id,p.fingerprint,o.updated_at,n.updated_at,120) c
where p.k='p2' and o.id=p.id and n.id=(select id from phase16_fixture where k='notice');
select extensions.is((select status from public.finalize_recall_match_evaluation_v2(
  (select id from phase16_fixture where k='p2'),(select id from phase16_fixture where k='notice'),
  (select fingerprint from phase16_fixture where k='p2'),
  (select updated_at from public.owned_products where id=(select id from phase16_fixture where k='p2')),
  (select updated_at from public.recall_notices where id=(select id from phase16_fixture where k='notice')),
  (select lease_token from phase16_replay),'needs_review',0.9,'{}','Replay.')),'unchanged','same pair and fingerprint replays unchanged');
select extensions.is((select count(*)::integer from private.recall_match_evaluations_v2 where recall_notice_id=(select id from phase16_fixture where k='notice')),4,'replay adds no observation');

select extensions.is((select status from public.create_recall_v2_alert((select id from phase16_fixture where k='p1'),(select id from phase16_fixture where k='notice'))),'created','eligible confirmation creates alert snapshot');
select extensions.is((select status from public.create_recall_v2_alert((select id from phase16_fixture where k='p1'),(select id from phase16_fixture where k='notice'))),'existing','alert replay returns existing snapshot');
select extensions.is((select count(*)::integer from private.recall_alert_snapshots_v2 where owned_product_id=(select id from phase16_fixture where k='p1')),1,'exactly one immutable alert snapshot');
select extensions.is((select status from public.create_recall_v2_alert((select id from phase16_fixture where k='p2'),(select id from phase16_fixture where k='notice'))),'ineligible','needs review cannot alert');
select extensions.is((select status from public.create_recall_v2_alert((select id from phase16_fixture where k='p3'),(select id from phase16_fixture where k='notice'))),'ineligible','rejection cannot alert');
select extensions.is((select count(*)::integer from private.push_alert_queue q join public.alerts a on a.id=q.alert_id join public.recall_matches m on m.id=a.recall_match_id where m.recall_notice_id=(select id from phase16_fixture where k='notice')),0,'v2 alert creates no push queue row');

-- The fifth product has a transaction-local historical v1 match and alert.
insert into public.recall_matches(id,owned_product_id,recall_notice_id,status,confidence,match_method,matched_identifiers,reasoning_summary,schema_version,evidence_fingerprint)
select m.id,p.id,n.id,'confirmed',0.9,'deterministic_v1','{}','Transaction-only legacy match.','1.0.0',p.fingerprint
from phase16_fixture m cross join phase16_fixture p cross join phase16_fixture n where m.k='legacy_match' and p.k='p5' and n.k='notice';
insert into public.alerts(id,user_id,recall_match_id)
select a.id,u.id,m.id from phase16_fixture a cross join phase16_fixture u cross join phase16_fixture m
where a.k='legacy_alert' and u.k='owner' and m.k='legacy_match';
select extensions.is((select count(*)::integer from private.recall_legacy_alert_snapshots_v2 where alert_id=(select id from phase16_fixture where k='legacy_alert')),1,'historical alert source captured');

update public.owned_products set model_number=null where id in (select id from phase16_fixture where k in ('p1','p4'));
create temporary table phase16_changed on commit drop as
select p.k,p.id product_id,o.updated_at product_revision,n.updated_at notice_revision,
  md5(p.id::text||':changed')||md5(p.id::text||':changed2') fingerprint,c.status,c.lease_token
from phase16_fixture p join public.owned_products o on o.id=p.id cross join public.recall_notices n
cross join lateral public.claim_recall_match_evaluation(p.id,n.id,md5(p.id::text||':changed')||md5(p.id::text||':changed2'),o.updated_at,n.updated_at,120) c
where p.k in ('p1','p4','p5') and n.id=(select id from phase16_fixture where k='notice');
select extensions.is((select count(*)::integer from phase16_changed where status='claimed'),3,'changed evidence receives fresh leases');
create temporary table phase16_reversed on commit drop as
select c.k,r.status,r.alert_eligibility from phase16_changed c cross join lateral
public.finalize_recall_match_evaluation_v2(c.product_id,(select id from phase16_fixture where k='notice'),
  c.fingerprint,c.product_revision,c.notice_revision,c.lease_token,
  case when c.k in ('p4','p5') then 'rejected'::public.recall_match_status else 'needs_review'::public.recall_match_status end,
  0.5,'{}','Newer transaction-only contradiction.') r;
select extensions.is((select count(*)::integer from phase16_reversed where status='finalized'),3,'new observations finalize');
select extensions.is((select count(*)::integer from private.recall_alert_eligibility_v2 where recall_notice_id=(select id from phase16_fixture where k='notice') and revoked_at is not null),2,'pending and delivered eligibility revoked');
select extensions.is((select status from public.create_recall_v2_alert((select id from phase16_fixture where k='p4'),(select id from phase16_fixture where k='notice'))),'ineligible','revoked pending eligibility cannot alert');
select extensions.is((select count(*)::integer from private.recall_alert_snapshots_v2 where owned_product_id=(select id from phase16_fixture where k='p1')),1,'older v2 alert preserved');
select extensions.is((select count(*)::integer from private.recall_alert_corrections_v2 where recall_notice_id=(select id from phase16_fixture where k='notice')),2,'v1 and v2 alerts each have correction');
select extensions.is((select count(*)::integer from public.alerts where id=(select id from phase16_fixture where k='legacy_alert')),1,'historical v1 alert preserved');
select extensions.is((select status::text from public.recall_matches where id=(select id from phase16_fixture where k='legacy_match')),'confirmed','v1 match status remains unchanged');
select extensions.is((select evidence_fingerprint from public.recall_matches where id=(select id from phase16_fixture where k='legacy_match')),(select fingerprint from phase16_fixture where k='p5'),'v1 fingerprint remains unchanged');
select extensions.is((select count(*)::integer from private.push_alert_queue q where q.alert_id=(select id from phase16_fixture where k='legacy_alert')),1,'historical alert alone has its expected v1 queue entry');

-- Share IDs through transaction-local settings so role sections do not need temp-table access.
select set_config('phase16.owner',(select id::text from phase16_fixture where k='owner'),true);
select set_config('phase16.other',(select id::text from phase16_fixture where k='other'),true);
select set_config('phase16.p1',(select id::text from phase16_fixture where k='p1'),true);
select set_config('phase16.p2',(select id::text from phase16_fixture where k='p2'),true);
select set_config('phase16.notice',(select id::text from phase16_fixture where k='notice'),true);
select set_config('phase16.alert',(select id::text from private.recall_alert_snapshots_v2 where owned_product_id=(select id from phase16_fixture where k='p1')),true);

set local role authenticated;
set local request.jwt.claim.sub = '';
select set_config('request.jwt.claim.sub',current_setting('phase16.owner'),true);
select extensions.is((select count(*)::integer from public.get_recall_safety_feed_v2() where recall_notice_id=current_setting('phase16.notice')::uuid),5,'owner reads own five v2 observations');
select extensions.is((select display_state from public.get_recall_safety_feed_v2() where owned_product_id=current_setting('phase16.p1')::uuid),'no_longer_confirmed','correction does not declare product safe');
select extensions.ok(public.update_recall_v2_alert_state(current_setting('phase16.alert')::uuid,'read'),'owner can update own alert state');
select extensions.throws_ok(format('select * from public.create_recall_v2_alert(%L::uuid,%L::uuid)',current_setting('phase16.p1'),current_setting('phase16.notice')),'42501',null,'authenticated cannot execute service alert writer');
select extensions.throws_ok('select * from public.finalize_recall_match_evaluation_v2(null::uuid,null::uuid,null::text,null::timestamptz,null::timestamptz,null::uuid,null::public.recall_match_status,null::numeric,null::jsonb,null::text)','42501',null,'authenticated cannot execute service finalizer');
reset role;
reset request.jwt.claim.sub;

set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('phase16.other'),true);
select extensions.is((select count(*)::integer from public.get_recall_safety_feed_v2() where recall_notice_id=current_setting('phase16.notice')::uuid),0,'second user cannot read owner v2 state');
select extensions.ok(not public.update_recall_v2_alert_state(current_setting('phase16.alert')::uuid,'dismissed'),'second user cannot change owner alert');
reset role;
reset request.jwt.claim.sub;

set local role anon;
select extensions.throws_ok('select * from public.get_recall_safety_feed_v2()','42501',null,'anon cannot execute consumer feed');
select extensions.throws_ok(format('select * from public.create_recall_v2_alert(%L::uuid,%L::uuid)',current_setting('phase16.p1'),current_setting('phase16.notice')),'42501',null,'anon cannot execute service writer');
select extensions.throws_ok('select * from public.finalize_recall_match_evaluation_v2(null::uuid,null::uuid,null::text,null::timestamptz,null::timestamptz,null::uuid,null::public.recall_match_status,null::numeric,null::jsonb,null::text)','42501',null,'anon cannot execute service finalizer');
reset role;
reset request.jwt.claim.sub;

set local role service_role;
select extensions.is((select count(*)::integer from public.get_owned_product_evidence_v2(current_setting('phase16.p1')::uuid)),1,'service actually executes worker evidence RPC');
select extensions.is((select status from public.create_recall_v2_alert(current_setting('phase16.p2')::uuid,current_setting('phase16.notice')::uuid)),'ineligible','service actually executes worker alert RPC');
select extensions.is((select status from public.finalize_recall_match_evaluation_v2(current_setting('phase16.p2')::uuid,current_setting('phase16.notice')::uuid,repeat('f',64),now(),now(),gen_random_uuid(),'confirmed',0.9,'{}','Invalid lease.')),'stale','service actually executes finalizer; invalid lease writes nothing');
select set_config('phase16.service_claim',to_jsonb(c)::text,true) from public.claim_recall_match_evaluation(
  current_setting('phase16.p2')::uuid,current_setting('phase16.notice')::uuid,
  md5(current_setting('phase16.p2')||':service')||md5(current_setting('phase16.p2')||':service2'),
  (select updated_at from public.owned_products where id=current_setting('phase16.p2')::uuid),
  (select updated_at from public.recall_notices where id=current_setting('phase16.notice')::uuid),120) c;
select extensions.is(current_setting('phase16.service_claim')::jsonb->>'status','claimed','service role claims a new revision');
select extensions.is((select status from public.finalize_recall_match_evaluation_v2(
  current_setting('phase16.p2')::uuid,current_setting('phase16.notice')::uuid,
  md5(current_setting('phase16.p2')||':service')||md5(current_setting('phase16.p2')||':service2'),
  (select updated_at from public.owned_products where id=current_setting('phase16.p2')::uuid),
  (select updated_at from public.recall_notices where id=current_setting('phase16.notice')::uuid),
  (current_setting('phase16.service_claim')::jsonb->>'lease_token')::uuid,
  'confirmed',0.9,'{}','Service role transaction-only confirmation.')),'finalized','service role finalizes a valid leased observation');
select extensions.is((select count(*)::integer from public.get_recall_v2_scopes(current_setting('phase16.notice')::uuid)),1,'service also executes the scoped worker read RPC');
reset role;
reset request.jwt.claim.sub;

select extensions.is((select count(*)::integer from private.recall_match_evaluations_v2 where recall_notice_id=(select id from phase16_fixture where k='notice')),8,'only the service role adds the final evaluation');
select extensions.is((select count(*)::integer from private.recall_alert_snapshots_v2 where recall_notice_id=(select id from phase16_fixture where k='notice')),1,'role tests add no alert');
select * from extensions.finish();
rollback;
