begin;
set local role postgres;
set local search_path = extensions, public, auth;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

-- ---------------------------------------------------------------------------
-- Privilege boundary
-- ---------------------------------------------------------------------------
select extensions.ok(not has_function_privilege(r,
  'public.approve_cpsc_product_model_criterion_v2(uuid,integer,text,text,text)', 'EXECUTE'),
  format('%s cannot execute the retired free-text approval', r))
  from unnest(array['anon','authenticated','service_role']) r;
select extensions.throws_ok(
  $$select public.approve_cpsc_product_model_criterion_v2(gen_random_uuid(),0,'x','y',repeat('a',64))$$,
  '42501', null, 'retired approval refuses even the table owner');
select extensions.ok(not has_table_privilege(r, format('private.%s', t), p),
  format('%s has no %s on private.%s', r, p, t))
  from unnest(array['anon','authenticated','service_role']) r,
    unnest(array['recall_scope_criteria_v2','cpsc_candidate_review_ledger',
      'cpsc_candidate_criteria','cpsc_page_revisions','cpsc_page_fetches',
      'cpsc_identity_reconciliations','cpsc_source_aliases','cpsc_source_identities']) t,
    unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;
select extensions.ok(not has_table_privilege('service_role', format('public.%s', t), p),
  format('service API cannot %s public.%s directly', p, t))
  from unnest(array['recall_notices','recall_scopes','recall_notice_jurisdictions','recall_sources']) t,
    unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p;
select extensions.ok(has_table_privilege('service_role', 'public.recall_notices', 'SELECT'),
  'service API keeps read access for the v1 matcher');
select extensions.ok((case when f like '%cpsc_page_%' or f like '%cpsc_candidate_criterion%'
    then not has_function_privilege('service_role', f, 'EXECUTE')
    else has_function_privilege('service_role', f, 'EXECUTE') end)
    and not has_function_privilege('authenticated', f, 'EXECUTE')
    and not has_function_privilege('anon', f, 'EXECUTE'),
  format('phase 16.24 RPC grant %s', f))
  from unnest(array[
    'public.ingest_cpsc_identity_notice(uuid,text,text,text,timestamptz,jsonb,jsonb)',
    'public.get_cpsc_page_fetch_targets(integer)',
    'public.record_cpsc_page_revision(uuid,text,jsonb,jsonb,jsonb,text)',
    'public.record_cpsc_page_fetch(uuid,uuid,timestamptz,integer,text,text,text,text,text,jsonb,text)',
    'public.propose_cpsc_candidate_criterion(uuid,uuid,jsonb,text,text,jsonb,text,text,text)']) f;
select extensions.ok(not has_function_privilege('service_role',
    'public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)', 'EXECUTE'),
  'worker cannot call the legacy observation RPC directly');
select extensions.ok(has_function_privilege('authenticated', f, 'EXECUTE')
    and not has_function_privilege('service_role', f, 'EXECUTE')
    and not has_function_privilege('anon', f, 'EXECUTE'),
  format('human-only RPC %s', f))
  from unnest(array[
    'public.decide_cpsc_candidate(uuid,text,boolean,text)',
    'public.get_cpsc_candidate_review_packet(uuid)',
    'public.materialize_cpsc_reviewed_conjunction(uuid)',
    'public.get_cpsc_quarantine_packet(uuid)',
    'public.reconcile_cpsc_quarantined_observation(uuid,text,text)']) f;
select extensions.ok(c.relrowsecurity, format('RLS enabled on private.%s', c.relname))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private' and c.relkind = 'r'
    and (c.relname like 'cpsc\_%' or c.relname = 'recall_scope_criteria_v2');
select extensions.ok(not exists (select 1 from pg_policies
  where schemaname = 'private' and (tablename like 'cpsc\_%' or tablename = 'recall_scope_criteria_v2')),
  'no policy exposes private source, review, or criteria rows');

-- ---------------------------------------------------------------------------
-- Fixtures: two linked historical recalls, one unlinked historical notice.
-- ---------------------------------------------------------------------------
insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id::uuid,'authenticated','authenticated',email,'','2099-01-01','{}','{}',now(),now()
from (values
  ('16110000-0000-4000-8000-000000000001','reviewer-one@example.invalid'),
  ('16110000-0000-4000-8000-000000000002','reviewer-two@example.invalid'),
  ('16110000-0000-4000-8000-000000000003','consumer@example.invalid'),
  ('16110000-0000-4000-8000-000000000004','revoked@example.invalid')) u(id,email);
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
insert into private.cpsc_reviewer_authorizations (user_id, authorized_at, revoked_at, reason)
values
  ('16110000-0000-4000-8000-000000000001', now() - interval '1 hour', null, 'pgTAP reviewer'),
  ('16110000-0000-4000-8000-000000000002', now() - interval '1 hour', null, 'pgTAP reviewer'),
  ('16110000-0000-4000-8000-000000000004', now() - interval '2 hours',
    now() - interval '90 minutes', 'pgTAP revoked reviewer');
-- Phase 16.12: identity reconciliation is a separately granted capability.
insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason)
values ('16110000-0000-4000-8000-000000000001', 'identity_reconciliation',
  now() - interval '1 hour', 'pgTAP reconciler');
select set_config('t16.source', public.ensure_cpsc_recall_source()::text, true);
insert into public.recall_notices (id,source_id,external_id,title,recall_date,official_url,
  retrieved_at,raw_payload)
values
  ('16110000-0000-4000-8000-000000000011',current_setting('t16.source')::uuid,'20001',
   'Recall A','2026-09-10','https://www.cpsc.gov/Recalls/2026/Recall-A',now(),
   '{"RecallID":20001,"RecallNumber":"26801"}'),
  ('16110000-0000-4000-8000-000000000012',current_setting('t16.source')::uuid,'20002',
   'Recall B','2026-09-10','https://cpsc.gov/Recalls/2026/Recall-B',now(),
   '{"RecallID":20002,"RecallNumber":"26802"}'),
  ('16110000-0000-4000-8000-000000000013',current_setting('t16.source')::uuid,'20041',
   'Unlinked history','2026-09-10','https://www.cpsc.gov/Recalls/2026/Recall-D',now(),
   '{"RecallID":20041,"RecallNumber":"26804"}');
insert into public.recall_scopes (id,recall_notice_id,product_name,model_number)
select ('16110000-0000-4000-8000-0000000000' || k)::uuid,
  '16110000-0000-4000-8000-000000000011','Fixture product',null
from unnest(array['21','22','23','24','25','26','27']) k;
insert into public.recall_scopes (id,recall_notice_id,product_name)
values ('16110000-0000-4000-8000-000000000028','16110000-0000-4000-8000-000000000012','Other');
insert into private.cpsc_source_identities (id,source_id,official_recall_number,canonical_url,
  canonical_notice_id,identity_status)
values
  ('16110000-0000-4000-8000-000000000031',current_setting('t16.source')::uuid,'26801',
   'https://www.cpsc.gov/Recalls/2026/Recall-A','16110000-0000-4000-8000-000000000011','reconciled'),
  ('16110000-0000-4000-8000-000000000032',current_setting('t16.source')::uuid,'26802',
   'https://www.cpsc.gov/Recalls/2026/Recall-B','16110000-0000-4000-8000-000000000012','reconciled');
insert into private.cpsc_notice_identity_links (notice_id,identity_id,provenance)
values
  ('16110000-0000-4000-8000-000000000011','16110000-0000-4000-8000-000000000031','historical fixture'),
  ('16110000-0000-4000-8000-000000000012','16110000-0000-4000-8000-000000000032','historical fixture');
insert into private.cpsc_source_aliases (identity_id,notice_id,alias_kind,alias_value,
  provenance,first_seen_at,last_seen_at)
values
  ('16110000-0000-4000-8000-000000000031','16110000-0000-4000-8000-000000000011','api_id','20001',
   'historical fixture',now(),now()),
  ('16110000-0000-4000-8000-000000000032','16110000-0000-4000-8000-000000000012','api_id','20002',
   'historical fixture',now(),now());
insert into private.cpsc_api_revisions (identity_id,upstream_api_id,payload_hash,provenance,
  first_seen_at,last_seen_at)
values ('16110000-0000-4000-8000-000000000031','20001',repeat('0',64),'historical fixture',now(),now());
create temporary table phase1611_before as
  select id, external_id, title, official_url, recall_date, raw_payload from public.recall_notices;

create function pg_temp.observe(p_api text, p_number text, p_url text, p_title text,
  p_day date, p_hash text default repeat('a',64))
returns jsonb language sql as $$
  select public.record_cpsc_identity_observation(p_api, p_number, p_url,
    private.cpsc_canonical_url(p_url), p_title, p_day, p_hash, now(), 'pgTAP observation');
$$;

-- ---------------------------------------------------------------------------
-- Identity decision matrix (worker context: PostgREST-shaped service claim)
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"role":"service_role"}';
select extensions.is(pg_temp.observe('20001','26801','https://www.cpsc.gov/Recalls/2026/Recall-A',
  'Recall A','2026-09-10')->>'decisionClass', 'A_known_alias', 'A: known recall + known API alias resolves');
select extensions.is(pg_temp.observe('20011','26801','https://www.cpsc.gov/Recalls/2026/Recall-A',
  'Recall A','2026-09-10')->>'decisionClass', 'B_new_alias', 'B: new non-conflicting API alias attaches');
select set_config('t16.obs_c', pg_temp.observe('20021','26803',
  'https://www.cpsc.gov/Recalls/2026/Recall-C','Recall C','2026-09-18')::text, true);
select extensions.is(current_setting('t16.obs_c')::jsonb->>'status', 'created',
  'C: consistent new recall number creates a canonical identity');
select extensions.ok((current_setting('t16.obs_c')::jsonb->'canonicalNoticeId') = 'null'::jsonb,
  'C: new identity has no notice until identity-aware ingestion');
select set_config('t16.obs_d', pg_temp.observe('20002','26801',
  'https://www.cpsc.gov/Recalls/2026/Recall-A','Recall A','2026-09-10')::text, true);
select extensions.is(current_setting('t16.obs_d')::jsonb->>'decisionClass', 'D_api_id_reuse',
  'D: API ID reused from another canonical recall quarantines');
select set_config('t16.obs_e', pg_temp.observe('20031','26801',
  'https://www.cpsc.gov/Recalls/2026/Recall-B','Recall A','2026-09-10')::text, true);
select extensions.is(current_setting('t16.obs_e')::jsonb->>'decisionClass', 'E_number_url_conflict',
  'E: recall number conflicting with another canonical URL quarantines');
select set_config('t16.obs_slug', pg_temp.observe('20032','26801',
  'https://www.cpsc.gov/Recalls/2026/Recall-A-Renamed','Recall A','2026-09-10')::text, true);
select extensions.is(current_setting('t16.obs_slug')::jsonb->>'decisionClass', 'E_url_changed',
  'H: a non-equivalent URL change for a known recall is held for a human');
select extensions.ok((pg_temp.observe('20001','26801','https://www.cpsc.gov/Recalls/2026/Recall-A',
  'Recall A (Corrected)','2026-09-10')->'revisionFlags') ? 'title_revised',
  'F: title correction is a flagged source revision, not quarantine');
select extensions.ok((pg_temp.observe('20001','26801','https://www.cpsc.gov/Recalls/2026/Recall-A',
  'Recall A','2026-09-11')->'revisionFlags') ? 'publication_date_revised',
  'G: publication-date correction is a flagged source revision');
select extensions.ok((pg_temp.observe('20001','26801',
  'https://cpsc.gov/Recalls/2026/Recall-A/?utm_source=x','Recall A','2026-09-10')->'revisionFlags')
  ? 'url_spelling_alias', 'H: equivalent URL spelling resolves as an alias');
select extensions.ok((pg_temp.observe('20001','26801','https://www.cpsc.gov/Recalls/2026/Recall-A',
  'Recall A','2026-09-10',repeat('9',64))->'revisionFlags') ? 'payload_revised',
  'API payload change is a flagged revision');
select extensions.is(pg_temp.observe('20042','26804','https://www.cpsc.gov/Recalls/2026/Recall-D',
  'Unlinked history','2026-09-10')->>'decisionClass', 'X_unlinked_history',
  'unlinked historical notice for the number blocks automatic creation');
select set_config('t16.obs_reuse_new', pg_temp.observe('20041','26805',
  'https://www.cpsc.gov/Recalls/2026/Recall-E','Recall E','2026-09-19')::text, true);
select extensions.is(current_setting('t16.obs_reuse_new')::jsonb->>'decisionClass', 'D_api_id_reuse',
  'new number reusing a historical API ID quarantines');
select extensions.is((select count(*) from private.cpsc_source_identities), 3::bigint,
  'title/date/URL-spelling revisions never create duplicate identities');
select extensions.is((select count(*) from private.cpsc_source_aliases a
  where a.alias_kind = 'api_id' and a.alias_value in ('20002','20031','20032','20042','20041')
    and a.identity_id <> '16110000-0000-4000-8000-000000000032'), 0::bigint,
  'no quarantined observation creates an alias');
select extensions.throws_ok($$select pg_temp.observe('abc','26801',
  'https://www.cpsc.gov/Recalls/2026/Recall-A','Recall A','2026-09-10')$$,
  null, 'Invalid CPSC observation', 'malformed API ID fails closed');
select extensions.throws_ok($$select public.record_cpsc_identity_observation('20001','26801',
  'https://www.cpsc.gov/Recalls/2026/Recall-B','https://www.cpsc.gov/Recalls/2026/Recall-A',
  'Recall A','2026-09-10',repeat('a',64),now(),'x')$$,
  null, 'Observed CPSC URL does not match canonical URL', 'observed/canonical URL mismatch fails');
select extensions.throws_ok($$select pg_temp.observe('20001','26801',
  'https://www.cpsc.gov/Recalls/2026/Recall-A',repeat('t',1001),'2026-09-10')$$,
  null, 'Invalid CPSC observation', 'oversized title is bounded');
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- New identity -> first notice (idempotent, identity-bound, no historical rewrite)
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"role":"service_role"}';
select extensions.throws_ok(format($$select public.ingest_cpsc_identity_notice(%L,null,null,null,
  now(),'{"RecallID":"20021","RecallNumber":"26899"}','[]')$$,
  current_setting('t16.obs_c')::jsonb->>'observationId'),
  null, 'CPSC payload does not match its identity observation', 'payload must match observation');
select extensions.throws_ok(format($$select public.ingest_cpsc_identity_notice(%L,null,null,null,
  now(),'{"RecallID":"20002","RecallNumber":"26801"}','[]')$$,
  current_setting('t16.obs_d')::jsonb->>'observationId'),
  null, 'CPSC notice ingestion requires a resolved identity observation',
  'quarantined observation cannot create a notice');
select extensions.is(public.ingest_cpsc_identity_notice(
  (current_setting('t16.obs_c')::jsonb->>'observationId')::uuid, 'Fixture description',
  'Hazard', 'Remedy', now(), '{"RecallID":"20021","RecallNumber":"26-803"}',
  '[{"productName":"Recall C product","modelNumber":"C-1"}]')->>'status', 'inserted',
  'new identity receives its first notice');
select extensions.is(public.ingest_cpsc_identity_notice(
  (current_setting('t16.obs_c')::jsonb->>'observationId')::uuid, 'Changed', null, null, now(),
  '{"RecallID":"20021","RecallNumber":"26803"}','[]')->>'status', 'unchanged',
  'notice ingestion is idempotent and never rewrites');
select extensions.ok(exists (select 1 from public.recall_notices n
  join private.cpsc_source_identities i on i.canonical_notice_id = n.id
  join private.cpsc_notice_identity_links l on l.notice_id = n.id and l.identity_id = i.id
  where i.official_recall_number = '26803' and i.identity_status = 'reconciled'
    and n.external_id = 'cpsc:26803' and n.description = 'Fixture description'
    and n.official_url = 'https://www.cpsc.gov/Recalls/2026/Recall-C'),
  'new notice is keyed by official recall number, linked, and reconciled');
select extensions.is((select count(*) from public.recall_scopes s
  join public.recall_notices n on n.id = s.recall_notice_id where n.external_id = 'cpsc:26803'),
  1::bigint, 'new notice scopes are ingested');
select extensions.is(pg_temp.observe('20021','26803','https://www.cpsc.gov/Recalls/2026/Recall-C',
  'Recall C','2026-09-18')->>'decisionClass', 'A_known_alias', 'replay of a created identity resolves');
reset request.jwt.claims;
select extensions.ok(not exists (
  select 1 from phase1611_before b join public.recall_notices n on n.id = b.id
  where (n.external_id, n.title, n.official_url, n.recall_date, n.raw_payload)
    is distinct from (b.external_id, b.title, b.official_url, b.recall_date, b.raw_payload)),
  'no historical notice was rewritten by observation or ingestion');

-- ---------------------------------------------------------------------------
-- Role separation on identity and reconciliation paths
-- ---------------------------------------------------------------------------
set local role service_role;
select extensions.throws_ok(format($$select public.reconcile_cpsc_quarantined_observation(%L,
  'confirm_alias','worker attempt')$$, current_setting('t16.obs_d')::jsonb->>'observationId'),
  '42501', null, 'worker cannot reconcile quarantine');
select extensions.throws_ok($$select public.materialize_cpsc_reviewed_conjunction(gen_random_uuid())$$,
  '42501', null, 'worker cannot materialize matcher criteria');
select extensions.throws_ok($$insert into private.cpsc_candidate_review_ledger (candidate_id,decision,
  source_revision_hash,evidence_address,attestation) values (gen_random_uuid(),'stale',repeat('a',64),
  '{}','x')$$, '42501', null, 'worker cannot write the review ledger directly');
select extensions.throws_ok($$insert into private.recall_scope_criteria_v2 (scope_id,criteria,
  reviewed_at,source_url) values (gen_random_uuid(),'{"semantics":"all_of","criteria":[{}]}',now(),
  'https://www.cpsc.gov/Recalls/x')$$, '42501', null, 'worker cannot write matcher criteria directly');
select extensions.throws_ok($$update public.recall_scopes set model_number = 'X'$$,
  '42501', null, 'worker cannot mutate recall scopes directly');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16110000-0000-4000-8000-000000000001","sub":"16110000-0000-4000-8000-000000000001"}';
select extensions.throws_ok($$select public.get_cpsc_page_fetch_targets(5)$$,
  '42501', null, 'reviewer cannot execute worker ingestion RPCs');
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16110000-0000-4000-8000-000000000003","sub":"16110000-0000-4000-8000-000000000003"}';
select extensions.throws_ok(format($$select public.get_cpsc_quarantine_packet(%L)$$,
  current_setting('t16.obs_d')::jsonb->>'observationId'),
  '42501', null, 'consumer cannot read quarantine evidence');
select extensions.throws_ok($$select count(*) from private.cpsc_identity_observations$$,
  '42501', null, 'consumer cannot read private source state');
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16110000-0000-4000-8000-000000000004","sub":"16110000-0000-4000-8000-000000000004"}';
select extensions.throws_ok(format($$select public.reconcile_cpsc_quarantined_observation(%L,
  'confirm_alias','revoked')$$, current_setting('t16.obs_d')::jsonb->>'observationId'),
  '42501', null, 'revoked reviewer cannot reconcile');

-- ---------------------------------------------------------------------------
-- Human quarantine reconciliation
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16110000-0000-4000-8000-000000000001","sub":"16110000-0000-4000-8000-000000000001"}';
select extensions.ok(public.get_cpsc_quarantine_packet(
  (current_setting('t16.obs_d')::jsonb->>'observationId')::uuid) ?& array['incomingApiId',
  'conflictingAliases','officialRecallNumber','canonicalUrl','currentIdentity','historicalNotices',
  'reason','provenance'], 'quarantine packet carries the full human evidence');
select extensions.ok(public.get_cpsc_quarantine_packet(
  (current_setting('t16.obs_d')::jsonb->>'observationId')::uuid)->'conflictingAliases'
  @> '[{"officialRecallNumber":"26802","aliasValue":"20002"}]',
  'quarantine packet shows the conflicting historical alias');
select extensions.throws_ok(format($$select public.reconcile_cpsc_quarantined_observation(%L,
  'confirm_alias','')$$, current_setting('t16.obs_d')::jsonb->>'observationId'),
  null, 'Reconciliation rationale is required', 'reconciliation requires a rationale');
select extensions.is(public.reconcile_cpsc_quarantined_observation(
  (current_setting('t16.obs_d')::jsonb->>'observationId')::uuid, 'leave_unresolved',
  'Waiting for CPSC confirmation')->>'decision', 'leave_unresolved', 'leave unresolved is audited');
select extensions.is(public.reconcile_cpsc_quarantined_observation(
  (current_setting('t16.obs_d')::jsonb->>'observationId')::uuid, 'confirm_alias',
  'Official page confirms API ID 20002 now serves recall 26801')->>'identityId',
  '16110000-0000-4000-8000-000000000031', 'human confirms reused API ID as alias of the numbered recall');
select extensions.throws_ok(format($$select public.reconcile_cpsc_quarantined_observation(%L,
  'reject_observation','second decision')$$, current_setting('t16.obs_d')::jsonb->>'observationId'),
  null, 'Observation already has a terminal reconciliation', 'terminal reconciliation is final');
select extensions.throws_ok(format($$select public.reconcile_cpsc_quarantined_observation(%L,
  'confirm_alias','would merge two recalls')$$, current_setting('t16.obs_e')::jsonb->>'observationId'),
  null, 'Canonical URL belongs to another canonical recall', 'reconciliation cannot merge canonical recalls');
select extensions.is(public.reconcile_cpsc_quarantined_observation(
  (current_setting('t16.obs_e')::jsonb->>'observationId')::uuid, 'reject_observation',
  'Contradictory number and URL')->>'decision', 'reject_observation', 'contradiction can be rejected');
select extensions.ok(public.reconcile_cpsc_quarantined_observation(
  (current_setting('t16.obs_slug')::jsonb->>'observationId')::uuid, 'confirm_alias',
  'CPSC renamed the page slug')->>'identityId' is not null, 'renamed official URL confirmed as alias');
select extensions.throws_ok(format($$select public.reconcile_cpsc_quarantined_observation(%L,
  'confirm_alias','no identity')$$, current_setting('t16.obs_reuse_new')::jsonb->>'observationId'),
  null, 'No canonical identity exists for this recall number', 'alias requires an existing identity');
select extensions.ok(public.reconcile_cpsc_quarantined_observation(
  (current_setting('t16.obs_reuse_new')::jsonb->>'observationId')::uuid, 'confirm_new_identity',
  'New recall 26805 reuses retired API ID 20041')->>'identityId' is not null,
  'human confirms a genuinely new identity despite API ID reuse');
reset request.jwt.claims;
reset role;

select extensions.ok(exists (select 1 from private.cpsc_source_aliases
  where identity_id = '16110000-0000-4000-8000-000000000032' and alias_value = '20002'
    and provenance = 'historical fixture' and reconciliation_id is null),
  'original historical alias is preserved');
select extensions.ok(exists (select 1 from private.cpsc_notice_identity_links
  where notice_id = '16110000-0000-4000-8000-000000000012'
    and identity_id = '16110000-0000-4000-8000-000000000032'),
  'historical notice is never reassigned');
select extensions.throws_ok($$update private.cpsc_identity_reconciliations set rationale = 'edited'$$,
  '42501', null, 'reconciliation history is append-only');
select extensions.throws_ok($$delete from private.cpsc_identity_observations$$,
  '42501', null, 'observation history is append-only');

set local request.jwt.claims = '{"role":"service_role"}';
select extensions.is(pg_temp.observe('20002','26801','https://www.cpsc.gov/Recalls/2026/Recall-A',
  'Recall A','2026-09-10')->>'decisionClass', 'R_reconciled_alias',
  'replay after reconciliation resolves deterministically');
select extensions.is(pg_temp.observe('20002','26801','https://www.cpsc.gov/Recalls/2026/Recall-A',
  'Recall A','2026-09-10')->>'decisionClass', 'R_reconciled_alias', 'second replay is identical');
select extensions.is(pg_temp.observe('20002','26802','https://cpsc.gov/Recalls/2026/Recall-B',
  'Recall B','2026-09-10')->>'decisionClass', 'A_known_alias',
  'historical owner still resolves its own API ID');
select extensions.is(pg_temp.observe('20002','26809','https://www.cpsc.gov/Recalls/2026/Recall-F',
  'Recall F','2026-09-20')->>'decisionClass', 'D_api_id_reuse', 'a third claimant still quarantines');
select extensions.is(pg_temp.observe('20031','26801','https://www.cpsc.gov/Recalls/2026/Recall-B',
  'Recall A','2026-09-10')->>'status', 'quarantined', 'rejected contradiction stays quarantined on replay');
select extensions.ok((pg_temp.observe('20032','26801',
  'https://www.cpsc.gov/Recalls/2026/Recall-A-Renamed','Recall A','2026-09-10')->'revisionFlags')
  ? 'reconciled_url_alias', 'confirmed renamed URL resolves on replay');
select set_config('t16.obs_e2', pg_temp.observe('20041','26805',
  'https://www.cpsc.gov/Recalls/2026/Recall-E','Recall E','2026-09-19')::text, true);
select extensions.is(current_setting('t16.obs_e2')::jsonb->>'decisionClass', 'R_reconciled_alias',
  'confirmed new identity resolves on replay');
select extensions.is(public.ingest_cpsc_identity_notice(
  (current_setting('t16.obs_e2')::jsonb->>'observationId')::uuid, null, null, null, now(),
  '{"RecallID":"20041","RecallNumber":"26805"}','[]')->>'status', 'inserted',
  'reconciled new identity is ingestible although its API ID is historical');
reset request.jwt.claims;
select extensions.is((select external_id from public.recall_notices
  where id = '16110000-0000-4000-8000-000000000013'), '20041',
  'the historical row that first carried the reused API ID is untouched');

-- ---------------------------------------------------------------------------
-- Worker page persistence
-- ---------------------------------------------------------------------------
insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,canonical_url,
  title,section_hashes,normalized_evidence,parser_version,first_seen_at,last_seen_at)
values ('16110000-0000-4000-8000-000000000041','16110000-0000-4000-8000-000000000031',
  repeat('a',64),'26801','https://www.cpsc.gov/Recalls/2026/Recall-A','Recall A','{}',
  '{"recallNumber":"26801","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Recall-A","title":"Recall A"}',
  'phase-16.11-test',now() - interval '2 hours',now() - interval '2 hours');

set local request.jwt.claims = '{"role":"service_role"}';
select extensions.is(public.record_cpsc_page_revision('16110000-0000-4000-8000-000000000031',
  repeat('a',64),'{"recallNumber":"26801","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Recall-A","title":"Recall A"}',
  '{}','[]','phase-16.11-test')->>'status', 'unchanged', 'same semantic revision is idempotent');
select extensions.throws_ok($$select public.record_cpsc_page_revision('16110000-0000-4000-8000-000000000031',
  repeat('e',64),'{"recallNumber":"26802","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Recall-B","title":"B"}',
  '{}','[]','phase-16.11-test')$$, null, 'CPSC page evidence contradicts its canonical identity',
  'page naming another recall is an identity contradiction');
select extensions.throws_ok(format($$select public.record_cpsc_page_revision(%L,repeat('e',64),
  '{"recallNumber":"26801","title":"x"}','{}','[]','Bad Version!')$$,
  '16110000-0000-4000-8000-000000000031'), null, 'Invalid CPSC page revision',
  'parser version is validated');
select set_config('t16.fetch', public.record_cpsc_page_fetch('16110000-0000-4000-8000-000000000031',
  '16110000-0000-4000-8000-000000000041', now(), 200, repeat('f',64),
  'https://www.cpsc.gov/Recalls/2026/Recall-A','text/html','"v1"',null,'[]',null)::text, true);
select extensions.is(public.record_cpsc_page_fetch('16110000-0000-4000-8000-000000000031',
  '16110000-0000-4000-8000-000000000041', now(), 200, repeat('f',64),
  'https://www.cpsc.gov/Recalls/2026/Recall-A','text/html','"v1"',null,'[]',null)::text,
  current_setting('t16.fetch'), 'page fetch recording is idempotent');
select extensions.throws_ok($$select public.record_cpsc_page_fetch('16110000-0000-4000-8000-000000000031',
  null, now(), 200, repeat('f',64), 'https://www.cpsc.gov/Recalls/2026/Recall-A',
  'text/html',null,null,'[]',null)$$, null,
  'A successful CPSC fetch must bind its own identity revision', 'successful fetch needs a revision');
select extensions.throws_ok($$select public.record_cpsc_page_fetch('16110000-0000-4000-8000-000000000032',
  '16110000-0000-4000-8000-000000000041', now(), 200, repeat('f',64),
  'https://www.cpsc.gov/Recalls/2026/Recall-B','text/html',null,null,'[]',null)$$, null,
  'A successful CPSC fetch must bind its own identity revision', 'fetch cannot borrow another identity revision');
select extensions.throws_ok($$select public.record_cpsc_page_fetch('16110000-0000-4000-8000-000000000031',
  null, now(), 404, null, 'https://evil.test/Recalls/2026/Recall-A',null,null,null,'[]',null)$$,
  null, 'Invalid CPSC page fetch', 'off-authority final URL is refused');
select extensions.throws_ok($$select public.record_cpsc_page_fetch('16110000-0000-4000-8000-000000000031',
  null, now(), 404, null, 'https://www.cpsc.gov/Recalls/2026/Recall-A',null,null,null,
  '["https://www.cpsc.gov/Recalls/1","https://www.cpsc.gov/Recalls/2","https://www.cpsc.gov/Recalls/3","https://www.cpsc.gov/Recalls/4"]',
  null)$$, null, 'Invalid CPSC page fetch', 'redirect chain is bounded');
select extensions.ok((select count(*) from public.get_cpsc_page_fetch_targets(5)) between 1 and 5,
  'worker receives authority-derived fetch targets');
select extensions.ok((select bool_and(canonical_url ~ '^https://www\.cpsc\.gov/Recalls/')
  from public.get_cpsc_page_fetch_targets(50)), 'fetch targets are canonical CPSC recall URLs');
select extensions.throws_ok($$select * from public.get_cpsc_page_fetch_targets(500)$$,
  null, 'Invalid page fetch limit', 'fetch target batch is bounded');

create function pg_temp.propose(p_key text, p_scope text, p_kind text, p_value jsonb, p_group text,
  p_field text) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select (public.propose_cpsc_candidate_criterion(r.id,
    case when p_scope is null then null else ('16110000-0000-4000-8000-0000000000' || p_scope)::uuid end,
    jsonb_build_object('source','cpsc','recallNumber',r.recall_number,'canonicalUrl',r.canonical_url,
      'sourceSemanticRevision',r.evidence_hash,'sectionIdentity','description',
      'tableIdentity','fixture-table','rowIdentity',p_group,'fieldIdentity',p_field),
    encode(sha256(convert_to(p_group,'UTF8')),'hex'), p_kind, p_value, p_group,
    p_group || ' authoritative excerpt', 'phase-16.11-test')->>'candidateId')::uuid
  into v_id from private.cpsc_page_revisions r where r.id = '16110000-0000-4000-8000-000000000041';
  perform set_config('t16.' || p_key, v_id::text, true);
  return v_id;
end $$;
-- g1: model + rejected date code; g2: model + unreviewed date code; g3: complete;
-- g4: date code only; g5: complete (second reviewer); g6: complete on g3's scope;
-- g7: model + stale-by-later-review test.
select pg_temp.propose('g1m','21','model_exact','"MODEL-1"','g1','model');
select pg_temp.propose('g1d','21','date_code_set','["2510","2511"]','g1','date_code');
select pg_temp.propose('g2m','22','model_exact','"MODEL-2"','g2','model');
select pg_temp.propose('g2d','22','date_code_exact','"2512"','g2','date_code');
select pg_temp.propose('g3m','23','model_exact','"MODEL-3"','g3','model');
select pg_temp.propose('g3d','23','date_code_set','["2510","2511","2512"]','g3','date_code');
select pg_temp.propose('g4d','24','date_code_exact','"2510"','g4','date_code');
select pg_temp.propose('g5m','25','model_set','["MODEL-5A","MODEL-5B"]','g5','model');
select pg_temp.propose('g5d','25','date_code_exact','"2601"','g5','date_code');
select pg_temp.propose('g6m','23','model_exact','"MODEL-6"','g6','model');
select pg_temp.propose('g7m','26','model_exact','"MODEL-7"','g7','model');
select pg_temp.propose('g7d','26','date_code_exact','"2602"','g7','date_code');
select pg_temp.propose('g8m','27','model_exact','"MODEL-8"','g8','model');
select extensions.is(public.propose_cpsc_candidate_criterion('16110000-0000-4000-8000-000000000041',
  '16110000-0000-4000-8000-000000000021', jsonb_build_object('source','cpsc','recallNumber','26801',
  'canonicalUrl','https://www.cpsc.gov/Recalls/2026/Recall-A','sourceSemanticRevision',repeat('a',64),
  'sectionIdentity','description','tableIdentity','fixture-table','rowIdentity','g1',
  'fieldIdentity','model'), encode(sha256(convert_to('g1','UTF8')),'hex'),'model_exact','"MODEL-1"',
  'g1','g1 authoritative excerpt','phase-16.11-test')->>'status', 'unchanged',
  'candidate proposal is idempotent');
select extensions.throws_ok($$select public.propose_cpsc_candidate_criterion(
  '16110000-0000-4000-8000-000000000041',null,'{"source":"cpsc"}',repeat('a',64),
  'production_date_range','{"from":"2025-01-01"}','g9','x','phase-16.11-test')$$,
  null, 'Unsupported CPSC proposal class', 'deferred production-date class cannot be proposed');
select extensions.throws_ok($$select public.propose_cpsc_candidate_criterion(
  '16110000-0000-4000-8000-000000000041',null,'{"source":"cpsc"}',repeat('a',64),
  'model_exact','["A","B"]','g9','x','phase-16.11-test')$$,
  null, 'Invalid CPSC candidate proposal', 'operator/value shape is enforced');
select extensions.throws_ok($$select public.propose_cpsc_candidate_criterion(
  '16110000-0000-4000-8000-000000000041',null,
  '{"source":"cpsc","recallNumber":"26802","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Recall-A","fieldIdentity":"model"}',
  repeat('a',64),'model_exact','"M"','g9','x','phase-16.11-test')$$,
  null, 'CPSC proposal address does not match its source revision', 'source address is bound to revision');
select extensions.throws_ok(format($$select public.propose_cpsc_candidate_criterion(
  '16110000-0000-4000-8000-000000000041','16110000-0000-4000-8000-000000000028',%L,
  repeat('a',64),'model_exact','"M"','g9','x','phase-16.11-test')$$,
  jsonb_build_object('source','cpsc','recallNumber','26801',
    'canonicalUrl','https://www.cpsc.gov/Recalls/2026/Recall-A',
    'sourceSemanticRevision',repeat('a',64),'fieldIdentity','model')),
  null, 'Proposed scope does not belong to this canonical recall', 'scope must belong to the recall');
select extensions.throws_ok(format($$select public.propose_cpsc_candidate_criterion(
  '16110000-0000-4000-8000-000000000041',null,%L,repeat('a',64),'model_exact','"M"','g9',
  repeat('x',4001),'phase-16.11-test')$$,
  jsonb_build_object('source','cpsc','recallNumber','26801',
    'canonicalUrl','https://www.cpsc.gov/Recalls/2026/Recall-A',
    'sourceSemanticRevision',repeat('a',64),'fieldIdentity','model')),
  null, 'Invalid CPSC candidate proposal', 'excerpt payload is bounded');
reset request.jwt.claims;
select extensions.is((select count(*) from private.cpsc_candidate_criteria where status <> 'unreviewed'),
  0::bigint, 'worker proposals are unreviewed by construction');
select extensions.throws_ok(format($$update private.cpsc_candidate_criteria set criterion_value = '"X"'
  where id = %L$$, current_setting('t16.g1m')), '42501', null, 'candidate evidence is append-only');

-- ---------------------------------------------------------------------------
-- Human decisions and conjunction safety
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16110000-0000-4000-8000-000000000001","sub":"16110000-0000-4000-8000-000000000001"}';
select public.decide_cpsc_candidate(current_setting('t16.' || k)::uuid, d, d = 'reviewed',
  'pgTAP decision')
  from (values ('g1m','reviewed'),('g1d','rejected'),('g2m','reviewed'),('g3m','reviewed'),
    ('g3d','reviewed'),('g4d','reviewed'),('g6m','reviewed'),('g7m','reviewed'),('g7d','reviewed'),
    ('g8m','reviewed')) v(k,d);
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16110000-0000-4000-8000-000000000002","sub":"16110000-0000-4000-8000-000000000002"}';
select public.decide_cpsc_candidate(current_setting('t16.g5m')::uuid,'reviewed',true,'second reviewer');
select public.decide_cpsc_candidate(current_setting('t16.g5d')::uuid,'reviewed',true,'second reviewer');
select extensions.throws_ok(format($$select public.materialize_cpsc_reviewed_conjunction(%L)$$,
  current_setting('t16.g1m')), null,
  'Conjunction is not fully human-reviewed, current, and model-anchored',
  'MODEL reviewed + DATE CODE rejected cannot materialize');
select extensions.throws_ok(format($$select public.materialize_cpsc_reviewed_conjunction(%L)$$,
  current_setting('t16.g2m')), null,
  'Conjunction is not fully human-reviewed, current, and model-anchored',
  'MODEL reviewed + DATE CODE unreviewed cannot materialize');
select extensions.throws_ok(format($$select public.materialize_cpsc_reviewed_conjunction(%L)$$,
  current_setting('t16.g4d')), null,
  'Conjunction is not fully human-reviewed, current, and model-anchored',
  'date-code-only conjunction lacks a product anchor and cannot materialize');
select extensions.is(public.materialize_cpsc_reviewed_conjunction(
  current_setting('t16.g3m')::uuid)->>'status', 'materialized',
  'MODEL reviewed + DATE CODE reviewed materializes');
select extensions.is(public.materialize_cpsc_reviewed_conjunction(
  current_setting('t16.g3d')::uuid)->>'status', 'unchanged', 'materialization is idempotent');
select extensions.is(public.materialize_cpsc_reviewed_conjunction(
  current_setting('t16.g5m')::uuid)->>'status', 'materialized',
  'a second complete conjunction materializes independently');
-- Superseded by Phase 16.12: an alternative conjunction is an independent rule set.
select extensions.is(public.materialize_cpsc_reviewed_conjunction(
  current_setting('t16.g6m')::uuid)->>'status', 'materialized',
  'alternative conjunction on an occupied scope materializes as a second rule set');
select extensions.is(public.materialize_cpsc_reviewed_conjunction(
  current_setting('t16.g7m')::uuid)->>'status', 'materialized', 'third conjunction materializes');
select extensions.is(public.materialize_cpsc_reviewed_conjunction(
  current_setting('t16.g8m')::uuid)->>'status', 'materialized',
  'single-member model conjunction materializes');
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16110000-0000-4000-8000-000000000003","sub":"16110000-0000-4000-8000-000000000003"}';
select extensions.throws_ok(format($$select public.materialize_cpsc_reviewed_conjunction(%L)$$,
  current_setting('t16.g3m')), '42501', null, 'consumer cannot materialize');
reset request.jwt.claims;
reset role;

select extensions.is((select array_agg(k order by k) from (values ('g1m'),('g1d'),('g2m'),('g2d'),
  ('g3m'),('g3d'),('g4d'),('g5m'),('g5d'),('g6m'),('g7m'),('g7d'),('g8m')) v(k)
  where current_setting('t16.' || k)::uuid in (select candidate_id from private.cpsc_current_reviewed_criteria)),
  array['g3d','g3m','g4d','g5d','g5m','g6m','g7d','g7m','g8m'],
  'current view never flattens partial conjunctions');

create temporary table phase1611_scopes as
  select * from public.get_recall_v2_scopes('16110000-0000-4000-8000-000000000011');
select extensions.is((select count(*) from phase1611_scopes where reviewed_criteria is not null),
  4::bigint, 'exactly the four materialized conjunctions reach the matcher');
select extensions.ok((select reviewed_criteria is null from phase1611_scopes
  where scope_id = '16110000-0000-4000-8000-000000000021'), 'rejected member: scope is unmatchable');
select extensions.ok((select reviewed_criteria is null from phase1611_scopes
  where scope_id = '16110000-0000-4000-8000-000000000022'), 'unreviewed member: scope is unmatchable');
select extensions.ok((select reviewed_criteria is null from phase1611_scopes
  where scope_id = '16110000-0000-4000-8000-000000000024'), 'unanchored date code: scope is unmatchable');
-- Phase 16.12 serves an any_of envelope of rule sets; assertions read the rule set.
select extensions.is((select array_agg(kind order by kind) from phase1611_scopes,
    jsonb_array_elements(reviewed_criteria->'ruleSets') rule_set,
    jsonb_array_elements_text(jsonb_path_query_array(rule_set, '$.criteria[*].kind')) kind
  where scope_id = '16110000-0000-4000-8000-000000000023'
    and rule_set->'criteria' @> '[{"value":"MODEL-3"}]'),
  array['date_code','model_number'], 'served conjunction keeps MODEL AND DATE CODE');
select extensions.ok((select reviewed_criteria->'ruleSets' @> jsonb_build_array(jsonb_build_object(
    'review', jsonb_build_object('origin','human_review_ledger','reviewerIds',jsonb_build_array(
      '16110000-0000-4000-8000-000000000001','16110000-0000-4000-8000-000000000001'))))
  from phase1611_scopes where scope_id = '16110000-0000-4000-8000-000000000023'),
  'served criterion names its ledger origin and reviewers');
select extensions.ok((select reviewed_criteria->'ruleSets'->0->'criteria' @> '[{"operator":"one_of","values":["MODEL-5A","MODEL-5B"]}]'
  from phase1611_scopes where scope_id = '16110000-0000-4000-8000-000000000025'),
  'model set is served as one_of');

-- A reviewer revoked AFTER deciding keeps the historical decision valid; a ledger
-- row by someone never authorized at decision time is never usable.
update private.cpsc_reviewer_authorizations set revoked_at = now() + interval '1 minute'
  where user_id = '16110000-0000-4000-8000-000000000002';
select extensions.ok((select reviewed_criteria is not null
  from public.get_recall_v2_scopes('16110000-0000-4000-8000-000000000011')
  where scope_id = '16110000-0000-4000-8000-000000000025'),
  'revocation after the decision does not rewrite history');
insert into private.cpsc_candidate_review_ledger (candidate_id,decision,reviewer_user_id,
  attested_scope_id,source_revision_hash,evidence_address,attestation,normalized_criterion,
  reviewed_operator,conjunction_key,mandatory_eligibility)
select c.id,'reviewed',u,c.proposed_scope_id,repeat('a',64),c.evidence_address,'forged',
  c.criterion_value,c.proposed_operator,c.conjunction_key,true
from private.cpsc_candidate_criteria c,
  unnest(array['16110000-0000-4000-8000-000000000003','16110000-0000-4000-8000-000000000004']::uuid[]) u
where c.id = current_setting('t16.g2d')::uuid;
select extensions.ok(not exists (select 1 from private.cpsc_current_reviewed_criteria
  where candidate_id = current_setting('t16.g2d')::uuid),
  'ledger rows by unauthorized or already-revoked reviewers are unusable');

-- A single stale member invalidates its whole conjunction, in either position.
insert into private.cpsc_candidate_review_ledger (candidate_id,decision,attested_scope_id,
  source_revision_hash,evidence_address,attestation,normalized_criterion,reviewed_operator,
  conjunction_key,mandatory_eligibility)
select c.id,'stale',c.proposed_scope_id,repeat('a',64),c.evidence_address,'member-level stale',
  c.criterion_value,c.proposed_operator,c.conjunction_key,true
from private.cpsc_candidate_criteria c
where c.id in (current_setting('t16.g7d')::uuid, current_setting('t16.g5m')::uuid);
select extensions.ok((select reviewed_criteria is null
  from public.get_recall_v2_scopes('16110000-0000-4000-8000-000000000011')
  where scope_id = '16110000-0000-4000-8000-000000000026'),
  'MODEL reviewed + DATE CODE stale is unusable');
select extensions.ok((select reviewed_criteria is null
  from public.get_recall_v2_scopes('16110000-0000-4000-8000-000000000011')
  where scope_id = '16110000-0000-4000-8000-000000000025'),
  'MODEL stale + DATE CODE reviewed is unusable');
select extensions.ok(not exists (select 1 from private.cpsc_current_reviewed_criteria
  where candidate_id in (current_setting('t16.g7m')::uuid, current_setting('t16.g5d')::uuid)),
  'the still-reviewed sibling never survives alone');

-- Even the table owner cannot fabricate or edit matcher criteria.
select extensions.throws_ok($$insert into private.recall_scope_criteria_v2 (scope_id,criteria,
  reviewed_at,source_url) values ('16110000-0000-4000-8000-000000000021',
  '{"semantics":"all_of","criteria":[{"kind":"model_number","value":"MODEL-1"}]}',now(),
  'https://www.cpsc.gov/Recalls/2026/Recall-A')$$, '42501', null,
  'legacy-origin criterion insert is refused');
-- Phase 16.12: materialized criteria live in the append-only rule-set table.
select extensions.throws_ok($$insert into private.recall_scope_rule_sets_v2 (scope_id,
  rule_set_fingerprint,criteria_sha256,revision_id,conjunction_group,criteria,source_url)
  select '16110000-0000-4000-8000-000000000021', rule_set_fingerprint, criteria_sha256,
    revision_id, conjunction_group, criteria, source_url
  from private.recall_scope_rule_sets_v2 where scope_id = '16110000-0000-4000-8000-000000000023'$$,
  '42501', null, 'a valid criterion cannot be copied onto another scope');
select extensions.throws_ok($$update private.recall_scope_rule_sets_v2
  set criteria = jsonb_set(criteria, '{criteria,0,value}', '"MODEL-X"')
  where scope_id = '16110000-0000-4000-8000-000000000023'$$, '42501', null,
  'a materialized criterion cannot be edited');

-- Scope and source address changes invalidate the served criterion.
update public.recall_scopes set model_number = 'EDITED'
  where id = '16110000-0000-4000-8000-000000000023';
select extensions.ok((select reviewed_criteria is null
  from public.get_recall_v2_scopes('16110000-0000-4000-8000-000000000011')
  where scope_id = '16110000-0000-4000-8000-000000000023'), 'scope change makes criterion unusable');
update public.recall_scopes set model_number = null where id = '16110000-0000-4000-8000-000000000023';
select extensions.ok((select reviewed_criteria is not null
  from public.get_recall_v2_scopes('16110000-0000-4000-8000-000000000011')
  where scope_id = '16110000-0000-4000-8000-000000000023'), 'restored scope is usable again');
update public.recall_notices set official_url = 'https://www.cpsc.gov/Recalls/2026/Recall-Moved'
  where id = '16110000-0000-4000-8000-000000000011';
select extensions.is((select count(*) from public.get_recall_v2_scopes(
  '16110000-0000-4000-8000-000000000011') where reviewed_criteria is not null), 0::bigint,
  'source address change makes every criterion unusable');
update public.recall_notices set official_url = 'https://www.cpsc.gov/Recalls/2026/Recall-A'
  where id = '16110000-0000-4000-8000-000000000011';

-- ---------------------------------------------------------------------------
-- Source revision stale invalidation
-- ---------------------------------------------------------------------------
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger
  where decision = 'stale' and attestation = 'source semantic revision changed'),
  0::bigint, 'cosmetic transport refetch keeps reviews current');
insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,canonical_url,
  title,section_hashes,normalized_evidence,parser_version,first_seen_at,last_seen_at)
values ('16110000-0000-4000-8000-000000000042','16110000-0000-4000-8000-000000000031',
  repeat('b',64),'26801','https://www.cpsc.gov/Recalls/2026/Recall-A','Recall A','{}',
  '{"recallNumber":"26801","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Recall-A","title":"Recall A"}',
  'phase-16.11-test',now() - interval '1 hour',now() - interval '1 hour');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger where decision = 'stale'),
  12::bigint, 'material revision stales every reviewed member');
select extensions.is((select count(*) from public.get_recall_v2_scopes(
  '16110000-0000-4000-8000-000000000011') where reviewed_criteria is not null), 0::bigint,
  'stale reviewed conjunctions are unusable by the matcher');
select extensions.is((select count(*) from private.cpsc_current_reviewed_criteria), 0::bigint,
  'no stale member is current');
select extensions.is((select count(*) from private.recall_scope_rule_sets_v2), 5::bigint,
  'stale bindings stay as history but are never served');
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16110000-0000-4000-8000-000000000001","sub":"16110000-0000-4000-8000-000000000001"}';
select extensions.throws_ok(format($$select public.decide_cpsc_candidate(%L,'reviewed',true)$$,
  current_setting('t16.g2d')), null, 'Candidate source revision is stale',
  'old source revision cannot be approved');
reset request.jwt.claims;
reset role;

set local request.jwt.claims = '{"role":"service_role"}';
select extensions.is(public.record_cpsc_page_revision('16110000-0000-4000-8000-000000000031',
  repeat('a',64),'{"recallNumber":"26801","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Recall-A","title":"Recall A"}',
  '{}','[]','phase-16.11-test')->>'status', 'reverted', 'A -> B -> A revert is detected');
reset request.jwt.claims;
select extensions.ok(private.cpsc_revision_is_current('16110000-0000-4000-8000-000000000041')
  and not private.cpsc_revision_is_current('16110000-0000-4000-8000-000000000042'),
  'reverted revision becomes current without rewriting first_seen_at');
select extensions.is((select count(*) from public.get_recall_v2_scopes(
  '16110000-0000-4000-8000-000000000011') where reviewed_criteria is not null), 0::bigint,
  'reviews staled by the intermediate revision do not silently revive');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger
  where decision in ('reviewed','rejected')), 14::bigint,
  'invalidation preserves every reviewed and rejected event');
select extensions.throws_ok($$update private.cpsc_page_revisions set title = 'rewritten'
  where id = '16110000-0000-4000-8000-000000000041'$$, '42501', null,
  'page revision evidence is immutable');

-- ---------------------------------------------------------------------------
-- Production-state isolation: nothing downstream was created.
-- ---------------------------------------------------------------------------
select extensions.is((select count(*) from private.recall_match_evaluations_v2), 0::bigint,
  'no v2 evaluation created');
select extensions.is((select count(*) from private.recall_alert_eligibility_v2), 0::bigint,
  'no v2 eligibility created');
select extensions.is((select count(*) from private.recall_alert_snapshots_v2), 0::bigint,
  'no v2 alert created');

select extensions.finish();
rollback;
