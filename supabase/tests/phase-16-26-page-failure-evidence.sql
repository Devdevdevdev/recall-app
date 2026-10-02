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
-- Test-only access to pgTAP and digest helpers rolls back with the fixture.
grant usage on schema extensions to cpsc_page_worker;

select extensions.ok(c.relrowsecurity and not exists (
  select 1 from pg_policies p where p.schemaname = 'private'
    and p.tablename = 'cpsc_page_structural_snapshots'),
  'structural snapshots have RLS and no API policy')
from pg_class c where c.oid = 'private.cpsc_page_structural_snapshots'::regclass;
select extensions.ok(not has_table_privilege(r,
  'private.cpsc_page_structural_snapshots', p),
  format('%s cannot %s structural snapshots',r,p))
from unnest(array['anon','authenticated','service_role','cpsc_page_worker']) r,
  unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p;
select extensions.ok(has_function_privilege('cpsc_page_worker',
  'public.retain_cpsc_page_transport(uuid,jsonb,bytea)','EXECUTE')
  and not has_function_privilege('service_role',
  'public.retain_cpsc_page_transport(uuid,jsonb,bytea)','EXECUTE')
  and not has_function_privilege('anon',
  'public.retain_cpsc_page_transport(uuid,jsonb,bytea)','EXECUTE'),
  'transport retention is dedicated-worker only');

select set_config('p1626.source',public.ensure_cpsc_recall_source()::text,true);
insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
  recall_date,official_url,retrieved_at,raw_payload)
values ('16260000-0000-4000-8000-000000000001',current_setting('p1626.source')::uuid,
  'cpsc:26926','Phase 16.26 failure','Description','Hazard','Refund','2026-09-20',
  'https://www.cpsc.gov/Recalls/2026/P1626-Failure',now(),'{"RecallNumber":"26926"}');
insert into private.cpsc_source_identities(id,source_id,official_recall_number,
  canonical_url,canonical_notice_id,identity_status)
values ('16260000-0000-4000-8000-000000000002',current_setting('p1626.source')::uuid,
  '26926','https://www.cpsc.gov/Recalls/2026/P1626-Failure',
  '16260000-0000-4000-8000-000000000001','reconciled');
insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance)
values ('16260000-0000-4000-8000-000000000001',
  '16260000-0000-4000-8000-000000000002','Phase 16.26 pgTAP');

create function pg_temp.raw_a() returns bytea language sql immutable as $$
  select convert_to('<html><body>Phase 16.26 transport A</body></html>','UTF8');
$$;
create function pg_temp.snapshot_a() returns jsonb language sql stable as $$
  select jsonb_build_object('canonicalUrl','https://www.cpsc.gov/Recalls/2026/P1626-Failure',
    'finalUrl','https://www.cpsc.gov/Recalls/2026/P1626-Failure','httpStatus',200,
    'fetchedAt',now(),'rawPageHash',encode(extensions.digest(pg_temp.raw_a(),'sha256'),'hex'),
    'contentType','text/html; charset=utf-8','etag',null,'lastModified',null,
    'redirectChain','[]'::jsonb);
$$;
create function pg_temp.revision_a() returns jsonb language sql stable as $$
  select jsonb_build_object('semanticHash',repeat('a',64),
    'normalized',jsonb_build_object('recallNumber','26926',
      'canonicalUrl','https://www.cpsc.gov/Recalls/2026/P1626-Failure',
      'title','Phase 16.26 failure','description','Fixture description.',
      'tables','[]'::jsonb),
    'sections','{}'::jsonb,'tableIdentities','[]'::jsonb,
    'parserVersion','phase-16.13-structured-v2');
$$;

set local role cpsc_page_worker;
select set_config('p1626.claim_a',c.claim_id::text,true)
from public.claim_cpsc_page_evidence(1) c;
select extensions.ok(current_setting('p1626.claim_a') <> '',
  'failure fixture receives a claim');
select public.retain_cpsc_page_transport(current_setting('p1626.claim_a')::uuid,
  pg_temp.snapshot_a(),pg_temp.raw_a());
select extensions.throws_ok(format($$select public.commit_cpsc_page_evidence_verified(
  %L,%L::jsonb,%L::jsonb,'[]'::jsonb,'{}'::jsonb,%L::bytea)$$,
  current_setting('p1626.claim_a'),pg_temp.snapshot_a(),
  pg_temp.revision_a(),pg_temp.raw_a()),
  null,'Invalid CPSC coverage ledger',
  'malformed semantic evidence is rejected after durable transport');
select extensions.is(public.finish_cpsc_page_attempt(
  current_setting('p1626.claim_a')::uuid,'evidence_rejected',200,
  'https://www.cpsc.gov/Recalls/2026/P1626-Failure',
  encode(extensions.digest(pg_temp.raw_a(),'sha256'),'hex'),
  'semantic_commit_rejected')->>'outcome','evidence_rejected',
  'failed semantic attempt is finalized in a separate transaction');
reset role;
select extensions.ok((select outcome = 'evidence_rejected' and completed_at is not null
  and revision_id is null and fetch_id is null and raw_payload_sha256 = raw_page_hash
  and transport_content_type = 'text/html; charset=utf-8'
  from private.cpsc_page_attempts where id = current_setting('p1626.claim_a')::uuid),
  'terminal attempt keeps transport-only linkage without semantic success');
select extensions.ok((select claim_id is null and claim_expires_at is null
  and manual_review_required and next_attempt_at > now() + interval '30 days'
  from private.cpsc_page_work_state
  where identity_id='16260000-0000-4000-8000-000000000002'),
  'evidence rejection releases claim and requires manual review');
select extensions.ok((select p.sha256 = encode(extensions.digest(p.raw_bytes,'sha256'),'hex')
  and p.raw_bytes=pg_temp.raw_a() from private.cpsc_page_raw_payloads p
  join private.cpsc_page_attempts a on a.raw_payload_sha256=p.sha256
  where a.id=current_setting('p1626.claim_a')::uuid),
  'failed attempt retains byte-identical replayable raw transport');
select extensions.is((select count(*) from private.cpsc_page_revisions),0::bigint,
  'failed semantic statement leaves no revision');
select extensions.is((select count(*) from private.cpsc_page_fetches),0::bigint,
  'failed semantic statement leaves no accepted fetch');
select extensions.is((select count(*) from private.cpsc_page_coverage_ledgers),0::bigint,
  'failed semantic statement leaves no coverage ledger');
select extensions.is((select count(*) from private.cpsc_candidate_criteria),0::bigint,
  'failed semantic statement leaves no candidate');
set local role cpsc_page_worker;
select extensions.is((select count(*) from public.claim_cpsc_page_evidence(1)),0::bigint,
  'manual-review-required failure cannot hot loop');
reset role;

-- A second fixture has the same semantic hash under an old parser, a stored
-- one-table normalized page, and zero historical table identities.
insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
  recall_date,official_url,retrieved_at,raw_payload)
values ('16260000-0000-4000-8000-000000000011',current_setting('p1626.source')::uuid,
  'cpsc:26927','Phase 16.26 legacy','Description','Hazard','Refund','2026-09-20',
  'https://www.cpsc.gov/Recalls/2026/P1626-Legacy',now(),'{"RecallNumber":"26927"}');
insert into private.cpsc_source_identities(id,source_id,official_recall_number,
  canonical_url,canonical_notice_id,identity_status)
values ('16260000-0000-4000-8000-000000000012',current_setting('p1626.source')::uuid,
  '26927','https://www.cpsc.gov/Recalls/2026/P1626-Legacy',
  '16260000-0000-4000-8000-000000000011','reconciled');
insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance)
values ('16260000-0000-4000-8000-000000000011',
  '16260000-0000-4000-8000-000000000012','Phase 16.26 pgTAP');
create function pg_temp.normalized_b() returns jsonb language sql immutable as $$
  select jsonb_build_object('recallNumber','26927',
    'canonicalUrl','https://www.cpsc.gov/Recalls/2026/P1626-Legacy',
    'title','Phase 16.26 legacy','description','Fixture description.',
    'tables',jsonb_build_array(jsonb_build_array(
      jsonb_build_array('MATERIAL'),jsonb_build_array('Blue'))));
$$;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('p1626.legacy_revision',
  public.record_cpsc_page_revision('16260000-0000-4000-8000-000000000012',
    repeat('b',64),pg_temp.normalized_b(),'{}'::jsonb,'[]'::jsonb,
    'phase-16.9-v1')->>'revisionId',true);
select extensions.is((select jsonb_array_length(table_identities)
  from private.cpsc_page_revisions where id=current_setting('p1626.legacy_revision')::uuid),
  0,'legacy revision remains structurally incomplete and immutable');
select extensions.is((select jsonb_array_length(normalized_evidence->'tables')
  from private.cpsc_page_revisions where id=current_setting('p1626.legacy_revision')::uuid),
  1,'legacy normalized evidence contains one table');
select set_config('p1626.tables_b',
  private.cpsc_expected_page_tables(pg_temp.normalized_b())::text,true);

create function pg_temp.raw_b() returns bytea language sql immutable as $$
  select convert_to('<html><body>Phase 16.26 transport B</body></html>','UTF8');
$$;
create function pg_temp.snapshot_b() returns jsonb language sql stable as $$
  select jsonb_build_object('canonicalUrl','https://www.cpsc.gov/Recalls/2026/P1626-Legacy',
    'finalUrl','https://www.cpsc.gov/Recalls/2026/P1626-Legacy','httpStatus',200,
    'fetchedAt',now(),'rawPageHash',encode(extensions.digest(pg_temp.raw_b(),'sha256'),'hex'),
    'contentType','text/html; charset=utf-8','etag',null,'lastModified',null,
    'redirectChain','[]'::jsonb);
$$;
create function pg_temp.revision_b() returns jsonb language sql stable as $$
  select jsonb_build_object('semanticHash',repeat('b',64),
    'normalized',pg_temp.normalized_b(),'sections','{}'::jsonb,
    'tableIdentities',current_setting('p1626.tables_b')::jsonb,
    'parserVersion','phase-16.13-structured-v2');
$$;
create function pg_temp.ledger_b() returns jsonb language sql stable as $$
  with ids as (select current_setting('p1626.tables_b')::jsonb->0 t)
  select jsonb_build_object('schema','cpsc_source_coverage_v1',
    'ledgerVersion','phase-16.13-coverage-v1',
    'parserVersion','phase-16.13-structured-v2',
    'extractorVersion','phase-16.11-html-v1',
    'censusVersion','phase-16.13-census-v1',
    'sourceSemanticRevision',repeat('b',64),
    'structures',jsonb_build_array(
      jsonb_build_object('structureId','description/prose','kind','prose',
        'sectionIdentity','description','tableIndex',null,'tableIdentity',null,
        'authoritativeRecordCount',1,'anomalies','[]'::jsonb,
        'records',jsonb_build_array(jsonb_build_object('ordinal',0,
          'recordIdentity','prose-fixture','rowIdentity',null,
          'disposition','ignored_non_safety','effect','none',
          'extraction','extracted','relation',null,'reason','non-safety fixture',
          'cells','[]'::jsonb))),
      jsonb_build_object('structureId',t->>'identity','kind','table',
        'sectionIdentity','description','tableIndex',0,'tableIdentity',t->>'identity',
        'authoritativeRecordCount',1,'anomalies','[]'::jsonb,
        'records',jsonb_build_array(jsonb_build_object('ordinal',0,
          'recordIdentity',t->'rows'->0->>'identity',
          'rowIdentity',t->'rows'->0->>'identity',
          'disposition','ignored_non_safety','effect','none',
          'extraction','extracted','relation',null,'reason','non-safety fixture',
          'cells','[]'::jsonb))))) from ids;
$$;

set local role cpsc_page_worker;
select set_config('p1626.claim_b',c.claim_id::text,true),
  set_config('p1626.identity_b',c.identity_id::text,true)
from public.claim_cpsc_page_evidence(1) c;
select extensions.is(current_setting('p1626.identity_b'),
  '16260000-0000-4000-8000-000000000012',
  'next claim skips manual-review failure and selects legacy fixture');
select public.retain_cpsc_page_transport(current_setting('p1626.claim_b')::uuid,
  pg_temp.snapshot_b(),pg_temp.raw_b());
select set_config('p1626.commit_b',public.commit_cpsc_page_evidence_verified(
  current_setting('p1626.claim_b')::uuid,pg_temp.snapshot_b(),
  pg_temp.revision_b(),'[]'::jsonb,pg_temp.ledger_b(),pg_temp.raw_b())::text,true);
select extensions.is(current_setting('p1626.commit_b')::jsonb->>'outcome',
  'fetched_unchanged','compatible structural snapshot accepts legacy semantic revision');
reset role;
select extensions.is((select jsonb_array_length(table_identities)
  from private.cpsc_page_revisions where id=current_setting('p1626.legacy_revision')::uuid),
  0,'legacy revision structural column remains unchanged');
select extensions.is((select count(*) from private.cpsc_page_structural_snapshots
  where revision_id=current_setting('p1626.legacy_revision')::uuid),
  1::bigint,'one additive versioned structural snapshot was attached');
select extensions.is((select jsonb_array_length(table_identities)
  from private.cpsc_page_structural_snapshots
  where revision_id=current_setting('p1626.legacy_revision')::uuid),
  1,'snapshot accounts for the one canonical table');
select extensions.is((select count(*) from private.cpsc_page_coverage_ledgers
  where revision_id=current_setting('p1626.legacy_revision')::uuid),
  1::bigint,'coverage attaches to compatible snapshot');
select extensions.throws_ok(format($$select private.cpsc_check_coverage_binding(
  %L,%L::jsonb)$$,current_setting('p1626.legacy_revision'),
  jsonb_set(pg_temp.ledger_b(),'{structures,1,tableIdentity}','"wrong"'::jsonb)),
  null,'CPSC coverage ledger does not account for every stored table',
  'mismatched table identity still fails closed');
select extensions.throws_ok($$update private.cpsc_page_structural_snapshots
  set table_identities='[]'::jsonb$$,'42501',
  'CPSC structural snapshot is immutable',
  'versioned structural evidence is immutable');
update private.cpsc_page_work_state set next_attempt_at=now()-interval '1 second'
  where identity_id='16260000-0000-4000-8000-000000000012';
set local role cpsc_page_worker;
select set_config('p1626.expired_claim',c.claim_id::text,true)
  from public.claim_cpsc_page_evidence(1) c;
reset role;
update private.cpsc_page_work_state set claim_expires_at=now()-interval '1 second'
  where identity_id='16260000-0000-4000-8000-000000000012';
set local role cpsc_page_worker;
select set_config('p1626.recovered_claim',c.claim_id::text,true)
  from public.claim_cpsc_page_evidence(1) c;
reset role;
select extensions.ok(current_setting('p1626.expired_claim') <>
    current_setting('p1626.recovered_claim')
  and (select outcome='claimed' and completed_at is null
       from private.cpsc_page_attempts where id=current_setting('p1626.expired_claim')::uuid),
  'reclaim creates a fresh claim without rewriting expired attempt history');
select extensions.is((select count(*) from private.cpsc_page_work_state w
  join private.cpsc_page_attempts a on a.id=w.claim_id
  where w.claim_expires_at>now() and a.outcome='claimed'
    and w.identity_id='16260000-0000-4000-8000-000000000012'),
  1::bigint,'only one claim is active after recovery');
set local role cpsc_page_worker;
select extensions.is(public.finish_cpsc_page_attempt(
  current_setting('p1626.expired_claim')::uuid,'database_timeout',null,
  null,null,'database_timeout')->>'superseded','true',
  'late worker can terminalize its own superseded attempt');
reset role;
select extensions.is((select claim_id::text from private.cpsc_page_work_state
  where identity_id='16260000-0000-4000-8000-000000000012'),
  current_setting('p1626.recovered_claim'),
  'late finalization leaves the newer active claim untouched');
select * from extensions.finish();
rollback;
