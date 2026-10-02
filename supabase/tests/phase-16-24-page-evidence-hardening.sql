begin;
set local role postgres;
set local search_path = extensions, public, auth;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();
-- Phase 16.32: the page stage is stopped by default and the claim enforces it.
-- This suite exercises the claim path, so an authorized scheduler operator
-- starts the stage inside the rolled-back transaction, with limits that do not
-- constrain the suite. Nothing here persists.
insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('16320000-0000-4000-8000-00000000f001','authenticated','authenticated',
  'p1632-suite-operator@example.test','','2099-01-01','{}','{}',now(),now());
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
insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason)
values ('16320000-0000-4000-8000-00000000f001', 'operational_scheduler_control',
  now() - interval '1 hour', 'Phase 16.32 suite operator');
select set_config('request.jwt.claims',
  '{"role":"authenticated","aal":"aal2","session_id":"16320000-0000-4000-8000-00000000f001","sub":"16320000-0000-4000-8000-00000000f001"}', true);
select public.start_cpsc_page_stage('Phase 16.32 suite start', 24, 10, 60, 1000);
select set_config('request.jwt.claims', '', true);
select set_config('p1624.baseline_revisions',
  (select count(*)::text from private.cpsc_page_revisions),true);
select set_config('p1624.baseline_fetches',
  (select count(*)::text from private.cpsc_page_fetches),true);
-- Test-only schema access; the enclosing transaction rolls it back.
grant usage on schema extensions to cpsc_page_worker;

select extensions.ok((select rolcanlogin from pg_roles where rolname = 'cpsc_page_worker'),
  'dedicated page role exists and can use a separately provisioned login');
select extensions.ok((select 'statement_timeout=4s' = any(rolconfig)
  from pg_roles where rolname = 'cpsc_page_worker'),
  'only dedicated role has four-second statement timeout');
select extensions.ok((select c.relrowsecurity from pg_class c
  where c.oid = 'private.cpsc_page_raw_payloads'::regclass),
  'raw byte table has RLS');
select extensions.ok(not exists(select 1 from pg_policies
  where schemaname = 'private' and tablename = 'cpsc_page_raw_payloads'),
  'raw byte table has no API policy');
select extensions.ok(not has_table_privilege(r,
  'private.cpsc_page_raw_payloads', privilege),
  format('%s lacks direct %s on raw bytes', r, privilege))
from unnest(array['anon','authenticated','service_role','cpsc_page_worker']) r,
  unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) privilege;
select extensions.ok(not has_function_privilege(r, f, 'EXECUTE'),
  format('%s cannot call legacy %s', r, f))
from unnest(array['anon','authenticated','service_role','cpsc_page_worker']) r,
  unnest(array[
    'public.record_cpsc_page_revision(uuid,text,jsonb,jsonb,jsonb,text)',
    'public.record_cpsc_page_fetch(uuid,uuid,timestamptz,integer,text,text,text,text,text,jsonb,text)',
    'public.propose_cpsc_candidate_criterion(uuid,uuid,jsonb,text,text,jsonb,text,text,text)',
    'public.record_cpsc_page_coverage(uuid,jsonb)',
    'public.commit_cpsc_page_evidence(uuid,jsonb,jsonb,jsonb,jsonb)']) f;
select extensions.ok(has_function_privilege('postgres', f, 'EXECUTE'),
  format('owner retains historical %s', f))
from unnest(array[
    'public.record_cpsc_page_revision(uuid,text,jsonb,jsonb,jsonb,text)',
    'public.record_cpsc_page_fetch(uuid,uuid,timestamptz,integer,text,text,text,text,text,jsonb,text)',
    'public.propose_cpsc_candidate_criterion(uuid,uuid,jsonb,text,text,jsonb,text,text,text)',
    'public.record_cpsc_page_coverage(uuid,jsonb)']) f;
select extensions.ok(has_function_privilege('cpsc_page_worker', f, 'EXECUTE')
  and not has_function_privilege('service_role', f, 'EXECUTE')
  and not has_function_privilege('anon', f, 'EXECUTE')
  and not has_function_privilege('authenticated', f, 'EXECUTE'),
  format('dedicated-only %s', f))
from unnest(array[
    'public.claim_cpsc_page_evidence(integer)',
    'public.finish_cpsc_page_attempt(uuid,text,integer,text,text,text)',
    'public.commit_cpsc_page_evidence_verified(uuid,jsonb,jsonb,jsonb,jsonb,bytea)']) f;
select extensions.ok(not has_function_privilege('cpsc_page_worker', f, 'EXECUTE'),
  format('page role cannot execute %s', f))
from unnest(array[
  'public.reconcile_cpsc_quarantined_observation(uuid,text,text)',
  'public.decide_cpsc_candidate(uuid,text,boolean,text)',
  'public.materialize_cpsc_reviewed_conjunction(uuid)',
  'public.finalize_recall_match_evaluation_v2(uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,jsonb,text)',
  'public.create_recall_v2_alert(uuid,uuid)',
  'public.record_recall_source_sync_result(text,text,jsonb,text,jsonb,timestamptz)']) f;

select set_config('p1624.source',public.ensure_cpsc_recall_source()::text,true);
insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
  recall_date,official_url,retrieved_at,raw_payload)
values ('16240000-0000-4000-8000-000000000001',current_setting('p1624.source')::uuid,
  'cpsc:26924','Phase 16.24 fixture','Description','Hazard','Refund','2026-09-20',
  'https://www.cpsc.gov/Recalls/2026/P1624-Fixture',now(),'{"RecallNumber":"26924"}');
insert into private.cpsc_source_identities(id,source_id,official_recall_number,
  canonical_url,canonical_notice_id,identity_status)
values ('16240000-0000-4000-8000-000000000002',current_setting('p1624.source')::uuid,
  '26924','https://www.cpsc.gov/Recalls/2026/P1624-Fixture',
  '16240000-0000-4000-8000-000000000001','reconciled');
insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance)
values ('16240000-0000-4000-8000-000000000001',
  '16240000-0000-4000-8000-000000000002','Phase 16.24 pgTAP');
-- In a populated production database, prevent the generic claim from taking a
-- real due identity. All changes remain inside the rollback-only transaction.
insert into private.cpsc_page_work_state(identity_id,next_attempt_at)
select id,now()+interval '1 day' from private.cpsc_source_identities
where identity_status='reconciled'
  and id <> '16240000-0000-4000-8000-000000000002'
on conflict (identity_id) do update set next_attempt_at=excluded.next_attempt_at;

create function pg_temp.raw() returns bytea language sql immutable as $$
  select convert_to('<html><body>Phase 16.24 fixture</body></html>','UTF8');
$$;
create function pg_temp.snapshot() returns jsonb language sql stable as $$
  select jsonb_build_object('canonicalUrl','https://www.cpsc.gov/Recalls/2026/P1624-Fixture',
    'finalUrl','https://www.cpsc.gov/Recalls/2026/P1624-Fixture','httpStatus',200,
    'fetchedAt',now(),'rawPageHash',encode(extensions.digest(pg_temp.raw(),'sha256'),'hex'),
    'contentType','text/html; charset=utf-8','etag',null,'lastModified',null,
    'redirectChain','[]'::jsonb);
$$;
create function pg_temp.revision() returns jsonb language sql stable as $$
  select jsonb_build_object('semanticHash',repeat('b',64),
    'normalized',jsonb_build_object('recallNumber','26924',
      'canonicalUrl','https://www.cpsc.gov/Recalls/2026/P1624-Fixture',
      'title','Phase 16.24 fixture','description','Fixture description.',
      'tables','[]'::jsonb),
    'sections','{}'::jsonb,'tableIdentities','[]'::jsonb,
    'parserVersion','phase-16.13-structured-v2');
$$;
create function pg_temp.ledger() returns jsonb language sql stable as $$
  select jsonb_build_object('schema','cpsc_source_coverage_v1',
    'ledgerVersion','phase-16.13-coverage-v1',
    'parserVersion','phase-16.13-structured-v2',
    'extractorVersion','phase-16.11-html-v1',
    'censusVersion','phase-16.13-census-v1',
    'sourceSemanticRevision',repeat('b',64),
    'structures',jsonb_build_array(jsonb_build_object(
      'structureId','description/prose','kind','prose',
      'sectionIdentity','description','tableIndex',null,'tableIdentity',null,
      'authoritativeRecordCount',1,'anomalies','[]'::jsonb,
      'records',jsonb_build_array(jsonb_build_object(
        'ordinal',0,'recordIdentity','description/sentence/0',
        'rowIdentity',null,'disposition','ignored_non_safety',
        'effect','none','extraction','extracted','relation',null,
        'reason','non-safety fixture','cells','[]'::jsonb)))));
$$;

set local role cpsc_page_worker;
select set_config('p1624.claim',c.claim_id::text,true),
  set_config('p1624.claim_identity',c.identity_id::text,true)
from public.claim_cpsc_page_evidence(1) c;
select extensions.ok(current_setting('p1624.claim') <> '',
  'dedicated role can claim a reconciled official target');
select extensions.is(current_setting('p1624.claim_identity'),
  '16240000-0000-4000-8000-000000000002',
  'rollback-only claim selects only its own fixture');
select extensions.throws_ok(format($$select public.retain_cpsc_page_transport(
  %L, %L::jsonb, convert_to('tampered','UTF8'))$$,
  current_setting('p1624.claim'),pg_temp.snapshot()),
  null,'CPSC raw page hash mismatch','tampered bytes are rejected');
reset role;
select extensions.is((select count(*) from private.cpsc_page_revisions),
  current_setting('p1624.baseline_revisions')::bigint,
  'tampered bytes create no revision');
set local role cpsc_page_worker;
select public.retain_cpsc_page_transport(
  current_setting('p1624.claim')::uuid, pg_temp.snapshot(), pg_temp.raw());
select extensions.throws_ok(format($$select public.commit_cpsc_page_evidence_verified(
  %L, %L::jsonb, %L::jsonb, '[]'::jsonb, '{}'::jsonb,
  pg_temp.raw())$$,current_setting('p1624.claim'),pg_temp.snapshot(),
  pg_temp.revision()),null,'Invalid CPSC coverage ledger',
  'late ledger error rolls back raw and semantic evidence');
reset role;
select extensions.is((select count(*) from private.cpsc_page_raw_payloads),1::bigint,
  'late semantic error retains validated raw payload');
select extensions.is((select count(*) from private.cpsc_page_fetches),
  current_setting('p1624.baseline_fetches')::bigint,
  'late error leaves no fetch');
select extensions.is((select count(*) from private.cpsc_page_revisions),
  current_setting('p1624.baseline_revisions')::bigint,
  'late error leaves no semantic revision');
select extensions.is((select count(*) from private.cpsc_candidate_criteria),0::bigint,
  'late error leaves no candidate');
select extensions.is((select count(*) from private.cpsc_page_coverage_ledgers),0::bigint,
  'late error leaves no coverage ledger');
set local role cpsc_page_worker;
select set_config('p1624.commit',public.commit_cpsc_page_evidence_verified(
  current_setting('p1624.claim')::uuid,pg_temp.snapshot(),pg_temp.revision(),
  '[]'::jsonb,pg_temp.ledger(),pg_temp.raw())::text,true);
select extensions.is(current_setting('p1624.commit')::jsonb->>'outcome',
  'fetched_changed','verified bytes commit with semantic evidence');
reset role;
select extensions.is((select count(*) from private.cpsc_page_raw_payloads),1::bigint,
  'one raw payload row retained');
select extensions.ok((select sha256 = encode(extensions.digest(raw_bytes,'sha256'),'hex')
  and byte_length=octet_length(raw_bytes) and byte_length=length(convert_from(raw_bytes,'UTF8'))
  from private.cpsc_page_raw_payloads), 'DB hash and stored bytes agree');
select extensions.ok((select a.raw_payload_sha256=p.sha256 and a.raw_page_hash=p.sha256
  and a.revision_id is not null and a.fetch_id is not null
  from private.cpsc_page_attempts a join private.cpsc_page_raw_payloads p
    on p.sha256=a.raw_payload_sha256
  where a.id=current_setting('p1624.claim')::uuid),
  'attempt, fetch, revision and exact bytes are linked');
select extensions.throws_ok($$update private.cpsc_page_raw_payloads set raw_bytes='\x00'$$,
  '42501','CPSC raw page payload is immutable','raw bytes cannot be updated');
select extensions.throws_ok($$delete from private.cpsc_page_raw_payloads$$,
  '42501','CPSC raw page payload is immutable','raw bytes cannot be deleted');
select extensions.throws_ok($$truncate private.cpsc_page_attempts,
  private.cpsc_page_raw_payloads$$,
  '42501','CPSC raw page payload is immutable','raw bytes cannot be truncated');

select * from extensions.finish();
rollback;
