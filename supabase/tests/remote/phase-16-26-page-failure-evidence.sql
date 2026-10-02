-- Phase 16.27 production-safe rollback-only suite for the Phase 16.26 contracts.
-- Run only through scripts/run-remote-pgtap.mjs, which injects the transient
-- pgTAP install after BEGIN; the final ROLLBACK removes it and every fixture.
-- Production identities are never claimed: each fixture sorts strictly first in
-- claim_cpsc_page_evidence (next_attempt_at -infinity, 1900 ordering timestamps),
-- and the suite asserts no non-fixture claim, attempt, or work-state appeared.
begin;
set local role postgres;
set local search_path = extensions, public, auth;
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

-- Pre-fixture production baselines, compared as deltas rather than absolutes.
select set_config('p1627.base', jsonb_build_object(
  'revisions', (select count(*) from private.cpsc_page_revisions),
  'fetches', (select count(*) from private.cpsc_page_fetches),
  'ledgers', (select count(*) from private.cpsc_page_coverage_ledgers),
  'candidates', (select count(*) from private.cpsc_candidate_criteria),
  'snapshots', (select count(*) from private.cpsc_page_structural_snapshots),
  'raw', (select count(*) from private.cpsc_page_raw_payloads),
  'review_ledger', (select count(*) from private.cpsc_candidate_review_ledger),
  'reviewer_auth', (select count(*) from private.cpsc_reviewer_authorizations),
  'reconciliations', (select count(*) from private.cpsc_identity_reconciliations),
  'aliases', (select count(*) from private.cpsc_source_aliases),
  'criteria_v2', (select count(*) from private.recall_scope_criteria_v2),
  'rule_sets_v2', (select count(*) from private.recall_scope_rule_sets_v2),
  'matches', (select count(*) from public.recall_matches),
  'alerts', (select count(*) from public.alerts),
  'attempts', (select count(*) from private.cpsc_page_attempts),
  'work', (select count(*) from private.cpsc_page_work_state),
  'old_attempt', (select md5(jsonb_build_array(id,identity_id,claimed_at,completed_at,
    outcome,http_status,final_url,raw_page_hash,error_code,revision_id,fetch_id,
    raw_payload_sha256)::text) from private.cpsc_page_attempts
    where id = '0bf98d4e-9c4b-42ce-a430-d20bfe97ac84'),
  'old_work', (select md5(jsonb_build_array(identity_id,claim_id,claim_expires_at,
    next_attempt_at,attempt_count,consecutive_failures,last_attempt_at,last_success_at,
    last_outcome)::text) from private.cpsc_page_work_state
    where identity_id = '4c5f90a1-26ea-4468-a926-4f5e077ddabf'))::text, true);
create function pg_temp.base(k text) returns bigint language sql stable as $$
  select (current_setting('p1627.base')::jsonb->>k)::bigint;
$$;
create function pg_temp.is_fixture(p uuid) returns boolean language sql immutable as $$
  select p in ('16260000-0000-4000-8000-000000000002'::uuid,
    '16260000-0000-4000-8000-000000000012'::uuid,
    '16260000-0000-4000-8000-000000000022'::uuid);
$$;

-- Catalog, RLS, and authorization matrix.
select extensions.ok(c.relrowsecurity and not exists (
  select 1 from pg_policies p where p.schemaname = 'private'
    and p.tablename = 'cpsc_page_structural_snapshots'),
  'structural snapshots have RLS and no API policy')
from pg_class c where c.oid = 'private.cpsc_page_structural_snapshots'::regclass;
select extensions.ok(not has_table_privilege(r, t, p),
  format('%s cannot %s %s', r, p, t))
from unnest(array['anon','authenticated','service_role','cpsc_page_worker']) r,
  unnest(array['private.cpsc_page_structural_snapshots','private.cpsc_page_raw_payloads',
    'private.cpsc_page_attempts','private.cpsc_page_work_state']) t,
  unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p;
select extensions.ok(has_function_privilege('cpsc_page_worker',
  'public.retain_cpsc_page_transport(uuid,jsonb,bytea)','EXECUTE'),
  'dedicated worker can retain transport');
select extensions.ok(not has_function_privilege(r, f, 'EXECUTE'),
  format('%s cannot execute %s', r, f))
from unnest(array['anon','authenticated','service_role']) r,
  unnest(array['public.retain_cpsc_page_transport(uuid,jsonb,bytea)',
    'public.claim_cpsc_page_evidence(integer)',
    'public.finish_cpsc_page_attempt(uuid,text,integer,text,text,text)',
    'public.commit_cpsc_page_evidence_verified(uuid,jsonb,jsonb,jsonb,jsonb,bytea)',
    'public.commit_cpsc_page_evidence(uuid,jsonb,jsonb,jsonb,jsonb)',
    'public.record_cpsc_page_revision(uuid,text,jsonb,jsonb,jsonb,text)',
    'public.record_cpsc_page_fetch(uuid,uuid,timestamp with time zone,integer,text,text,text,text,text,jsonb,text)',
    'public.propose_cpsc_candidate_criterion(uuid,uuid,jsonb,text,text,jsonb,text,text,text)',
    'public.record_cpsc_page_coverage(uuid,jsonb)',
    'public.get_cpsc_page_fetch_targets(integer)']) f;
select extensions.is((select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','private') and p.prosecdef
    and p.prorettype <> 'trigger'::regtype
    and has_function_privilege('cpsc_page_worker', p.oid, 'EXECUTE')),
  -- Phase 16.33 adds only the single-use scheduler ticket consumer.
  array['claim_cpsc_page_evidence(integer)',
    'commit_cpsc_page_evidence_verified(uuid,jsonb,jsonb,jsonb,jsonb,bytea)',
    'consume_cpsc_page_stage_ticket(text)',
    'finish_cpsc_page_attempt(uuid,text,integer,text,text,text)',
    'retain_cpsc_page_transport(uuid,jsonb,bytea)'],
  'dedicated worker executes exactly the four reviewed page RPCs and the ticket consumer');
select extensions.ok(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public','private') and c.relkind in ('r','p')
    and (has_table_privilege('cpsc_page_worker', c.oid, 'INSERT')
      or has_table_privilege('cpsc_page_worker', c.oid, 'UPDATE')
      or has_table_privilege('cpsc_page_worker', c.oid, 'DELETE')
      or has_table_privilege('cpsc_page_worker', c.oid, 'TRUNCATE'))),
  'dedicated worker has no direct table write privilege');
select extensions.ok((select not rolsuper and not rolbypassrls and not rolcreaterole
  and not rolcreatedb from pg_roles where rolname = 'cpsc_page_worker'),
  'dedicated worker role attributes remain narrow');

-- Fixtures: notices, identities, and links that sort before every real identity.
select set_config('p1627.source', public.ensure_cpsc_recall_source()::text, true);
insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
  recall_date,official_url,retrieved_at,raw_payload)
values
  ('16260000-0000-4000-8000-000000000001',current_setting('p1627.source')::uuid,
   'cpsc:26926','Phase 16.26 failure','Description','Hazard','Refund','2026-09-20',
   'https://www.cpsc.gov/Recalls/2026/P1626-Failure',now(),'{"RecallNumber":"26926"}'),
  ('16260000-0000-4000-8000-000000000021',current_setting('p1627.source')::uuid,
   'cpsc:26928','Phase 16.26 backoff','Description','Hazard','Refund','2026-09-20',
   'https://www.cpsc.gov/Recalls/2026/P1626-Backoff',now(),'{"RecallNumber":"26928"}');
insert into private.cpsc_source_identities(id,source_id,official_recall_number,
  canonical_url,canonical_notice_id,identity_status,first_seen_at)
values
  ('16260000-0000-4000-8000-000000000002',current_setting('p1627.source')::uuid,
   '26926','https://www.cpsc.gov/Recalls/2026/P1626-Failure',
   '16260000-0000-4000-8000-000000000001','reconciled','1900-01-01 00:00:00+00'),
  ('16260000-0000-4000-8000-000000000022',current_setting('p1627.source')::uuid,
   '26928','https://www.cpsc.gov/Recalls/2026/P1626-Backoff',
   '16260000-0000-4000-8000-000000000021','reconciled','1900-01-01 00:00:02+00');
insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance)
values ('16260000-0000-4000-8000-000000000001',
  '16260000-0000-4000-8000-000000000002','Phase 16.27 remote pgTAP'),
  ('16260000-0000-4000-8000-000000000021',
  '16260000-0000-4000-8000-000000000022','Phase 16.27 remote pgTAP');
-- The backoff fixture is parked until its own section.
insert into private.cpsc_page_work_state(identity_id,next_attempt_at,attempt_count,
  last_attempt_at)
values ('16260000-0000-4000-8000-000000000022','infinity',0,'1900-01-01 00:00:00+00');

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

-- A: validated transport is durable; semantic rejection leaves nothing semantic.
set local role cpsc_page_worker;
select set_config('p1627.claim_a',c.claim_id::text,true),
  set_config('p1627.identity_a',c.identity_id::text,true)
from public.claim_cpsc_page_evidence(1) c;
reset role;
select extensions.is(current_setting('p1627.identity_a'),
  '16260000-0000-4000-8000-000000000002','claim selects the failure fixture, not production');
select extensions.throws_ok(format($$select public.retain_cpsc_page_transport(%L,%L::jsonb,%L::bytea)$$,
  current_setting('p1627.claim_a'),pg_temp.snapshot_a(),pg_temp.raw_a()),
  '42501','Dedicated page worker authorization required',
  'owner session cannot retain transport as the worker');
set local role cpsc_page_worker;
select extensions.throws_ok(format($$select public.retain_cpsc_page_transport(%L,%L::jsonb,%L::bytea)$$,
  current_setting('p1627.claim_a'),
  jsonb_set(pg_temp.snapshot_a(),'{rawPageHash}',to_jsonb(repeat('0',64))),pg_temp.raw_a()),
  null,'CPSC raw page hash mismatch','transport with a mismatched SHA-256 is rejected');
select extensions.throws_ok(format($$select public.retain_cpsc_page_transport(%L,%L::jsonb,%L::bytea)$$,
  current_setting('p1627.claim_a'),
  jsonb_set(pg_temp.snapshot_a(),'{finalUrl}','"https://www.cpsc.gov/Recalls/2026/Other"'),
  pg_temp.raw_a()),
  null,'Invalid CPSC page transport','transport for a different final URL is rejected');
select extensions.is(public.retain_cpsc_page_transport(current_setting('p1627.claim_a')::uuid,
  pg_temp.snapshot_a(),pg_temp.raw_a())->>'rawPageHash',
  encode(extensions.digest(pg_temp.raw_a(),'sha256'),'hex'),
  'validated transport is retained before semantic processing');
select extensions.throws_ok(format($$select public.commit_cpsc_page_evidence_verified(
  %L,%L::jsonb,%L::jsonb,'[]'::jsonb,'{}'::jsonb,%L::bytea)$$,
  current_setting('p1627.claim_a'),pg_temp.snapshot_a(),
  pg_temp.revision_a(),pg_temp.raw_a()),
  null,'Invalid CPSC coverage ledger',
  'malformed semantic evidence is rejected after durable transport');
select extensions.is(public.finish_cpsc_page_attempt(
  current_setting('p1627.claim_a')::uuid,'evidence_rejected',200,
  'https://www.cpsc.gov/Recalls/2026/P1626-Failure',
  encode(extensions.digest(pg_temp.raw_a(),'sha256'),'hex'),
  'semantic_commit_rejected')->>'outcome','evidence_rejected',
  'failed semantic attempt is finalized in a separate statement');
reset role;
select extensions.ok((select outcome = 'evidence_rejected' and completed_at is not null
  and error_code = 'semantic_commit_rejected'
  and revision_id is null and fetch_id is null and raw_payload_sha256 = raw_page_hash
  and transport_content_type = 'text/html; charset=utf-8'
  and transport_redirect_chain = '[]'::jsonb and transport_fetched_at is not null
  from private.cpsc_page_attempts where id = current_setting('p1627.claim_a')::uuid),
  'terminal attempt keeps transport-only linkage and a stable error code');
select extensions.ok((select claim_id is null and claim_expires_at is null
  and manual_review_required and next_attempt_at = now() + interval '100 years'
  and last_outcome = 'evidence_rejected'
  from private.cpsc_page_work_state
  where identity_id='16260000-0000-4000-8000-000000000002'),
  'evidence rejection releases the claim, requires manual review, and parks 100 years');
select extensions.ok((select p.sha256 = encode(extensions.digest(p.raw_bytes,'sha256'),'hex')
  and p.raw_bytes = pg_temp.raw_a() from private.cpsc_page_raw_payloads p
  join private.cpsc_page_attempts a on a.raw_payload_sha256 = p.sha256
  where a.id = current_setting('p1627.claim_a')::uuid),
  'failed attempt retains byte-identical content-addressed raw transport');
select extensions.throws_ok(format($$update private.cpsc_page_raw_payloads
  set raw_bytes = convert_to('x','UTF8') where sha256 = %L$$,
  encode(extensions.digest(pg_temp.raw_a(),'sha256'),'hex')),
  '42501','CPSC raw page payload is immutable','raw payload cannot be updated');
select extensions.throws_ok(format($$delete from private.cpsc_page_raw_payloads
  where sha256 = %L$$, encode(extensions.digest(pg_temp.raw_a(),'sha256'),'hex')),
  '42501','CPSC raw page payload is immutable','raw payload cannot be deleted');
select extensions.is((select count(*) from private.cpsc_page_revisions),
  pg_temp.base('revisions'),'semantic rejection leaves no revision');
select extensions.is((select count(*) from private.cpsc_page_fetches),
  pg_temp.base('fetches'),'semantic rejection leaves no accepted fetch');
select extensions.is((select count(*) from private.cpsc_page_coverage_ledgers),
  pg_temp.base('ledgers'),'semantic rejection leaves no coverage ledger');
select extensions.is((select count(*) from private.cpsc_candidate_criteria),
  pg_temp.base('candidates'),'semantic rejection leaves no candidate');
select extensions.is((select count(*) from private.cpsc_page_structural_snapshots),
  pg_temp.base('snapshots'),'semantic rejection leaves no structural snapshot');
select extensions.is((select count(*) from private.cpsc_page_raw_payloads),
  pg_temp.base('raw') + 1,'exactly one transport payload survives the rejection');

-- B: a frozen legacy revision with zero table identities gains an additive,
-- independently recomputed structural snapshot; mismatches still fail closed.
insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
  recall_date,official_url,retrieved_at,raw_payload)
values ('16260000-0000-4000-8000-000000000011',current_setting('p1627.source')::uuid,
  'cpsc:26927','Phase 16.26 legacy','Description','Hazard','Refund','2026-09-20',
  'https://www.cpsc.gov/Recalls/2026/P1626-Legacy',now(),'{"RecallNumber":"26927"}');
insert into private.cpsc_source_identities(id,source_id,official_recall_number,
  canonical_url,canonical_notice_id,identity_status,first_seen_at)
values ('16260000-0000-4000-8000-000000000012',current_setting('p1627.source')::uuid,
  '26927','https://www.cpsc.gov/Recalls/2026/P1626-Legacy',
  '16260000-0000-4000-8000-000000000011','reconciled','1900-01-01 00:00:01+00');
insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance)
values ('16260000-0000-4000-8000-000000000011',
  '16260000-0000-4000-8000-000000000012','Phase 16.27 remote pgTAP');
create function pg_temp.normalized_b() returns jsonb language sql immutable as $$
  select jsonb_build_object('recallNumber','26927',
    'canonicalUrl','https://www.cpsc.gov/Recalls/2026/P1626-Legacy',
    'title','Phase 16.26 legacy','description','Fixture description.',
    'tables',jsonb_build_array(jsonb_build_array(
      jsonb_build_array('MATERIAL'),jsonb_build_array('Blue'))));
$$;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('p1627.legacy_revision',
  public.record_cpsc_page_revision('16260000-0000-4000-8000-000000000012',
    repeat('b',64),pg_temp.normalized_b(),'{}'::jsonb,'[]'::jsonb,
    'phase-16.9-v1')->>'revisionId',true);
select set_config('request.jwt.claims','',true);
select extensions.is((select jsonb_array_length(table_identities)
  from private.cpsc_page_revisions where id=current_setting('p1627.legacy_revision')::uuid),
  0,'legacy fixture revision has zero stored table identities');
select extensions.is((select jsonb_array_length(normalized_evidence->'tables')
  from private.cpsc_page_revisions where id=current_setting('p1627.legacy_revision')::uuid),
  1,'legacy fixture normalized evidence contains one table');
select set_config('p1627.tables_b',
  private.cpsc_expected_page_tables(pg_temp.normalized_b())::text,true);
select extensions.is(jsonb_array_length(current_setting('p1627.tables_b')::jsonb),1,
  'canonical census recomputes exactly one table identity');

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
    'tableIdentities',current_setting('p1627.tables_b')::jsonb,
    'parserVersion','phase-16.13-structured-v2');
$$;
create function pg_temp.ledger_b() returns jsonb language sql stable as $$
  with ids as (select current_setting('p1627.tables_b')::jsonb->0 t)
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

select extensions.throws_ok(format($$select private.cpsc_check_coverage_binding(%L,%L::jsonb)$$,
  current_setting('p1627.legacy_revision'),pg_temp.ledger_b()),
  null,'CPSC coverage ledger does not account for every stored table',
  'before a snapshot, the historical failure mode is reproduced');
set local role cpsc_page_worker;
select set_config('p1627.claim_b',c.claim_id::text,true),
  set_config('p1627.identity_b',c.identity_id::text,true)
from public.claim_cpsc_page_evidence(1) c;
reset role;
select extensions.is(current_setting('p1627.identity_b'),
  '16260000-0000-4000-8000-000000000012',
  'next claim skips the manual-review fixture and selects the legacy fixture');
set local role cpsc_page_worker;
select public.retain_cpsc_page_transport(current_setting('p1627.claim_b')::uuid,
  pg_temp.snapshot_b(),pg_temp.raw_b());
select set_config('p1627.commit_b',public.commit_cpsc_page_evidence_verified(
  current_setting('p1627.claim_b')::uuid,pg_temp.snapshot_b(),
  pg_temp.revision_b(),'[]'::jsonb,pg_temp.ledger_b(),pg_temp.raw_b())::text,true);
reset role;
select extensions.is(current_setting('p1627.commit_b')::jsonb->>'outcome',
  'fetched_unchanged','compatible structural snapshot accepts the legacy semantic revision');
select extensions.is((select jsonb_array_length(table_identities)
  from private.cpsc_page_revisions where id=current_setting('p1627.legacy_revision')::uuid),
  0,'legacy revision structural column is not rewritten');
select extensions.is((select count(*) from private.cpsc_page_structural_snapshots
  where revision_id=current_setting('p1627.legacy_revision')::uuid),
  1::bigint,'one additive versioned structural snapshot is attached');
select extensions.is((select jsonb_array_length(table_identities)
  from private.cpsc_page_structural_snapshots
  where revision_id=current_setting('p1627.legacy_revision')::uuid),
  1,'snapshot accounts for the one canonical table');
select extensions.is((select count(*) from private.cpsc_page_coverage_ledgers
  where revision_id=current_setting('p1627.legacy_revision')::uuid),
  1::bigint,'coverage attaches to the compatible snapshot');
select extensions.throws_ok(format($$select private.cpsc_check_coverage_binding(%L,%L::jsonb)$$,
  current_setting('p1627.legacy_revision'),
  jsonb_set(pg_temp.ledger_b(),'{structures,1,tableIdentity}','"wrong"'::jsonb)),
  null,'CPSC coverage ledger does not account for every stored table',
  'mismatched table identity still fails closed');
select extensions.throws_ok($$update private.cpsc_page_structural_snapshots
  set table_identities='[]'::jsonb where revision_id =
  current_setting('p1627.legacy_revision')::uuid$$,'42501',
  'CPSC structural snapshot is immutable','structural snapshot cannot be updated');
select extensions.throws_ok($$delete from private.cpsc_page_structural_snapshots
  where revision_id = current_setting('p1627.legacy_revision')::uuid$$,'42501',
  'CPSC structural snapshot is immutable','structural snapshot cannot be deleted');

-- Expired-claim recovery on the legacy fixture.
update private.cpsc_page_work_state set next_attempt_at='-infinity',
  last_success_at='1900-01-01 00:00:01+00'
  where identity_id='16260000-0000-4000-8000-000000000012';
set local role cpsc_page_worker;
select set_config('p1627.expired_claim',c.claim_id::text,true),
  set_config('p1627.expired_identity',c.identity_id::text,true)
  from public.claim_cpsc_page_evidence(1) c;
reset role;
update private.cpsc_page_work_state set claim_expires_at=now()-interval '1 second'
  where identity_id='16260000-0000-4000-8000-000000000012';
set local role cpsc_page_worker;
select set_config('p1627.recovered_claim',c.claim_id::text,true),
  set_config('p1627.recovered_identity',c.identity_id::text,true)
  from public.claim_cpsc_page_evidence(1) c;
reset role;
select extensions.ok(current_setting('p1627.expired_identity') =
    '16260000-0000-4000-8000-000000000012'
  and current_setting('p1627.recovered_identity') =
    '16260000-0000-4000-8000-000000000012',
  'recovery claims stay on the legacy fixture');
select extensions.ok(current_setting('p1627.expired_claim') <>
    current_setting('p1627.recovered_claim')
  and (select outcome='claimed' and completed_at is null
       from private.cpsc_page_attempts where id=current_setting('p1627.expired_claim')::uuid),
  'reclaim creates a fresh claim without rewriting expired attempt history');
select extensions.is((select count(*) from private.cpsc_page_work_state w
  join private.cpsc_page_attempts a on a.id=w.claim_id
  where w.claim_expires_at>now() and a.outcome='claimed'
    and w.identity_id='16260000-0000-4000-8000-000000000012'),
  1::bigint,'only one claim is active after recovery');
set local role cpsc_page_worker;
select extensions.is(public.finish_cpsc_page_attempt(
  current_setting('p1627.expired_claim')::uuid,'database_timeout',null,
  null,null,'database_timeout')->>'superseded','true',
  'late worker can terminalize its own superseded attempt');
reset role;
select extensions.is((select claim_id::text from private.cpsc_page_work_state
  where identity_id='16260000-0000-4000-8000-000000000012'),
  current_setting('p1627.recovered_claim'),
  'late finalization leaves the newer active claim untouched');

-- C: terminal outcomes and retry/backoff on a dedicated fixture.
update private.cpsc_page_work_state set next_attempt_at='infinity'
  where identity_id='16260000-0000-4000-8000-000000000012';
create function pg_temp.claim_c(n int) returns void language plpgsql as $$
begin
  update private.cpsc_page_work_state set next_attempt_at='-infinity',
    last_attempt_at='1900-01-01 00:00:02+00'
    where identity_id='16260000-0000-4000-8000-000000000022';
  perform set_config('p1627.claim_c' || n, '', true);
end;
$$;
select pg_temp.claim_c(1);
set local role cpsc_page_worker;
select set_config('p1627.claim_c1',c.claim_id::text,true),
  set_config('p1627.identity_c1',c.identity_id::text,true)
  from public.claim_cpsc_page_evidence(1) c;
select extensions.is(public.finish_cpsc_page_attempt(
  current_setting('p1627.claim_c1')::uuid,'database_timeout',null,null,null,
  'database_timeout')->>'outcome','database_timeout','database timeout terminalizes');
reset role;
select extensions.ok(current_setting('p1627.identity_c1') =
  '16260000-0000-4000-8000-000000000022'
  and (select next_attempt_at = now() + interval '1 hour' and claim_id is null
    and consecutive_failures = 1 and not manual_review_required
    from private.cpsc_page_work_state
    where identity_id='16260000-0000-4000-8000-000000000022')
  and (select completed_at is not null and error_code = 'database_timeout'
    from private.cpsc_page_attempts where id = current_setting('p1627.claim_c1')::uuid),
  'database timeout backs off one hour without manual review');
select pg_temp.claim_c(2);
set local role cpsc_page_worker;
select set_config('p1627.claim_c2',c.claim_id::text,true),
  set_config('p1627.identity_c2',c.identity_id::text,true)
  from public.claim_cpsc_page_evidence(1) c;
select public.finish_cpsc_page_attempt(current_setting('p1627.claim_c2')::uuid,
  'internal_failure',null,null,null,'worker_exception');
reset role;
select extensions.ok(current_setting('p1627.identity_c2') =
  '16260000-0000-4000-8000-000000000022'
  and (select next_attempt_at = now() + interval '1 day' and consecutive_failures = 2
    from private.cpsc_page_work_state
    where identity_id='16260000-0000-4000-8000-000000000022')
  and (select outcome = 'internal_failure' and error_code = 'worker_exception'
    and completed_at is not null
    from private.cpsc_page_attempts where id = current_setting('p1627.claim_c2')::uuid),
  'internal failure terminalizes and backs off one day');
select pg_temp.claim_c(3);
set local role cpsc_page_worker;
select set_config('p1627.claim_c3',c.claim_id::text,true),
  set_config('p1627.identity_c3',c.identity_id::text,true)
  from public.claim_cpsc_page_evidence(1) c;
select public.finish_cpsc_page_attempt(current_setting('p1627.claim_c3')::uuid,
  'unresolved_structure',200,null,null,'unresolved_structure');
reset role;
select extensions.ok(current_setting('p1627.identity_c3') =
  '16260000-0000-4000-8000-000000000022'
  and (select next_attempt_at = now() + interval '7 days' and consecutive_failures = 3
    from private.cpsc_page_work_state
    where identity_id='16260000-0000-4000-8000-000000000022'),
  'unresolved structure backs off seven days');
select pg_temp.claim_c(4);
set local role cpsc_page_worker;
select set_config('p1627.claim_c4',c.claim_id::text,true),
  set_config('p1627.identity_c4',c.identity_id::text,true)
  from public.claim_cpsc_page_evidence(1) c;
select public.finish_cpsc_page_attempt(current_setting('p1627.claim_c4')::uuid,
  'temporary_failure',503,null,null,'upstream_unavailable');
select extensions.throws_ok(format($$select public.finish_cpsc_page_attempt(%L,
  'fetched_changed',200,null,null,'bad')$$, current_setting('p1627.claim_c4')),
  null,'Invalid page attempt outcome','success outcomes cannot be forged through finish');
select extensions.throws_ok(format($$select public.finish_cpsc_page_attempt(%L,
  'internal_failure',null,null,null,'Raw SQL message: boom')$$,
  current_setting('p1627.claim_c4')),
  null,'Invalid page attempt outcome','unstable free-text error codes are rejected');
reset role;
select extensions.ok(current_setting('p1627.identity_c4') =
  '16260000-0000-4000-8000-000000000022'
  and (select next_attempt_at = now() + interval '2400 seconds' and consecutive_failures = 4
    from private.cpsc_page_work_state
    where identity_id='16260000-0000-4000-8000-000000000022'),
  'transient failure keeps bounded exponential backoff');
select extensions.is((select count(*) from private.cpsc_page_attempts
  where identity_id='16260000-0000-4000-8000-000000000022' and outcome='claimed'),
  0::bigint,'every backoff fixture attempt is terminal');

-- Production isolation and no automatic review or reconciliation.
select extensions.is((select count(*) from private.cpsc_page_attempts
  where not pg_temp.is_fixture(identity_id)),pg_temp.base('attempts'),
  'no production identity received an attempt inside the transaction');
select extensions.is((select count(*) from private.cpsc_page_work_state
  where not pg_temp.is_fixture(identity_id)),pg_temp.base('work'),
  'no production identity received a work-state inside the transaction');
select extensions.is((select md5(jsonb_build_array(id,identity_id,claimed_at,completed_at,
    outcome,http_status,final_url,raw_page_hash,error_code,revision_id,fetch_id,
    raw_payload_sha256)::text) from private.cpsc_page_attempts
    where id = '0bf98d4e-9c4b-42ce-a430-d20bfe97ac84'),
  current_setting('p1627.base')::jsonb->>'old_attempt',
  'historical Phase 16.25 attempt is untouched');
select extensions.is((select md5(jsonb_build_array(identity_id,claim_id,claim_expires_at,
    next_attempt_at,attempt_count,consecutive_failures,last_attempt_at,last_success_at,
    last_outcome)::text) from private.cpsc_page_work_state
    where identity_id = '4c5f90a1-26ea-4468-a926-4f5e077ddabf'),
  current_setting('p1627.base')::jsonb->>'old_work',
  'historical Phase 16.25 work-state is untouched');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger),
  pg_temp.base('review_ledger'),'no automatic candidate review');
select extensions.is((select count(*) from private.cpsc_reviewer_authorizations),
  pg_temp.base('reviewer_auth'),'no reviewer authorization');
select extensions.is((select count(*) from private.cpsc_identity_reconciliations),
  pg_temp.base('reconciliations'),'no automatic identity reconciliation');
select extensions.is((select count(*) from private.cpsc_source_aliases),
  pg_temp.base('aliases'),'no alias reassignment or creation');
select extensions.is((select count(*) from private.recall_scope_criteria_v2),
  pg_temp.base('criteria_v2'),'no reviewed matcher criteria');
select extensions.is((select count(*) from private.recall_scope_rule_sets_v2),
  pg_temp.base('rule_sets_v2'),'no materialized v2 rule sets');
select extensions.is((select count(*) from public.recall_matches),
  pg_temp.base('matches'),'no matches');
select extensions.is((select count(*) from public.alerts),
  pg_temp.base('alerts'),'no alerts');
select extensions.is((select count(*) from private.cpsc_candidate_criteria),
  pg_temp.base('candidates'),'fixture flows proposed no candidate criteria');
select * from extensions.finish();
rollback;
