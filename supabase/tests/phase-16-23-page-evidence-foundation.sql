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

select extensions.ok(c.relrowsecurity, format('%s has RLS', c.relname))
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'private' and c.relname in ('cpsc_page_work_state', 'cpsc_page_attempts');
select extensions.ok(not has_table_privilege(r, format('private.%s', t), p),
  format('%s cannot %s %s', r, p, t))
from unnest(array['anon','authenticated','service_role']) r,
  unnest(array['cpsc_page_work_state','cpsc_page_attempts']) t,
  unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;
select extensions.ok(has_function_privilege('cpsc_page_worker', f, 'EXECUTE')
  and not has_function_privilege('service_role', f, 'EXECUTE')
  and not has_function_privilege('authenticated', f, 'EXECUTE')
  and not has_function_privilege('anon', f, 'EXECUTE'),
  format('%s is worker-only', f))
from unnest(array[
  'public.claim_cpsc_page_evidence(integer)',
  'public.finish_cpsc_page_attempt(uuid,text,integer,text,text,text)',
  'public.commit_cpsc_page_evidence_verified(uuid,jsonb,jsonb,jsonb,jsonb,bytea)']) f;
select extensions.ok(not has_function_privilege('service_role',
  'public.reconcile_cpsc_quarantined_observation(uuid,text,text)', 'EXECUTE')
  and not has_function_privilege('service_role',
  'public.decide_cpsc_candidate(uuid,text,boolean,text)', 'EXECUTE'),
  'page worker cannot reconcile or review');

select set_config('p1623.source', public.ensure_cpsc_recall_source()::text, true);
insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
  recall_date,official_url,retrieved_at,raw_payload)
values ('16230000-0000-4000-8000-000000000001', current_setting('p1623.source')::uuid,
  'cpsc:26901', 'Phase 16.23 fixture', 'Description', 'Hazard', 'Refund',
  '2026-09-20', 'https://www.cpsc.gov/Recalls/2026/P1623-Fixture', now(),
  '{"RecallNumber":"26901"}');
insert into private.cpsc_source_identities (id,source_id,official_recall_number,
  canonical_url,canonical_notice_id,identity_status)
values ('16230000-0000-4000-8000-000000000002', current_setting('p1623.source')::uuid,
  '26901', 'https://www.cpsc.gov/Recalls/2026/P1623-Fixture',
  '16230000-0000-4000-8000-000000000001', 'reconciled'),
  ('16230000-0000-4000-8000-000000000003', current_setting('p1623.source')::uuid,
  '26777', 'https://www.cpsc.gov/Recalls/2026/P1623-Unresolved',
  null, 'unresolved');
insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance)
values ('16230000-0000-4000-8000-000000000001',
  '16230000-0000-4000-8000-000000000002', 'Phase 16.23 pgTAP');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('p1623.claim',
  (select claim_id::text from public.claim_cpsc_page_evidence(1)), true);
select extensions.ok(current_setting('p1623.claim') <> '', 'eligible canonical identity is claimed');
select extensions.is((select count(*) from public.claim_cpsc_page_evidence(1)), 0::bigint,
  'second worker cannot claim the same active identity or unresolved 26777');
select extensions.is((select count(*) from private.cpsc_page_attempts
  where identity_id = '16230000-0000-4000-8000-000000000003'), 0::bigint,
  '26777 remains unresolved without a claim');
select extensions.throws_ok(format($$select public.commit_cpsc_page_evidence(%L,
  '{"canonicalUrl":"https://www.cpsc.gov/Recalls/2026/P1623-Fixture",
    "finalUrl":"https://www.cpsc.gov/Recalls/2026/Wrong","httpStatus":200}'::jsonb,
  '{}'::jsonb, '[]'::jsonb, '{}'::jsonb)$$, current_setting('p1623.claim')),
  null, 'CPSC page evidence contradicts its claimed identity',
  'wrong final URL aborts atomic evidence commit');
select extensions.is((select count(*) from private.cpsc_page_revisions), 0::bigint,
  'rejected final URL leaves no semantic revision');
select extensions.is((select count(*) from private.cpsc_page_fetches), 0::bigint,
  'rejected final URL leaves no successful fetch');
select extensions.is((select count(*) from private.cpsc_page_coverage_ledgers), 0::bigint,
  'rejected final URL leaves no coverage ledger');
select extensions.is((select count(*) from private.cpsc_candidate_criteria), 0::bigint,
  'rejected final URL leaves no candidate');

select extensions.is(public.finish_cpsc_page_attempt(
  current_setting('p1623.claim')::uuid, 'temporary_failure', 500,
  null, null, 'http_500')->>'outcome', 'temporary_failure',
  'temporary failure is durable');
select extensions.ok((select next_attempt_at >= now() + interval '5 minutes'
  from private.cpsc_page_work_state where identity_id =
  '16230000-0000-4000-8000-000000000002'), 'first retry has five-minute backoff');
select extensions.is((select count(*) from public.claim_cpsc_page_evidence(1)), 0::bigint,
  'retry does not hot loop');
update private.cpsc_page_work_state set next_attempt_at = now() - interval '1 second'
where identity_id = '16230000-0000-4000-8000-000000000002';
select set_config('p1623.claim2',
  (select claim_id::text from public.claim_cpsc_page_evidence(1)), true);
select extensions.ok(current_setting('p1623.claim2') <> current_setting('p1623.claim'),
  'due identity receives a fresh claim');
update private.cpsc_page_work_state set claim_expires_at = now() - interval '1 second'
where identity_id = '16230000-0000-4000-8000-000000000002';
select set_config('p1623.claim3',
  (select claim_id::text from public.claim_cpsc_page_evidence(1)), true);
select extensions.ok(current_setting('p1623.claim3') <> current_setting('p1623.claim2'),
  'expired claim is recoverable');
select extensions.is((select outcome from private.cpsc_page_attempts
  where id = current_setting('p1623.claim2')::uuid), 'claimed',
  'expired historical attempt remains unchanged when a new claim takes the lease');
select extensions.is(public.finish_cpsc_page_attempt(
  current_setting('p1623.claim3')::uuid, 'identity_redirect', 200,
  'https://www.cpsc.gov/Recalls/2026/Other', repeat('a',64),
  'final_url_mismatch')->>'outcome', 'identity_redirect',
  'identity redirect is durable without reconciliation');
select extensions.is((select count(*) from private.cpsc_source_aliases
  where identity_id = '16230000-0000-4000-8000-000000000002'), 0::bigint,
  'redirect creates no alias');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger), 0::bigint,
  'redirect creates no review');
select extensions.ok((select next_attempt_at >= now() + interval '30 days'
  from private.cpsc_page_work_state where identity_id =
  '16230000-0000-4000-8000-000000000002'), 'identity redirect cannot hot loop');
-- Phase 16.29: the redirect is an identity-sensitive transition. It holds the
-- identity until an authorized human clears it; the success path below then
-- runs on the same identity through that real human decision.
select extensions.is(private.cpsc_page_identity_blockers(
  '16230000-0000-4000-8000-000000000002'), array['human_reconciliation_required'],
  'identity redirect requires human page reconciliation');
insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('16230000-0000-4000-8000-000000000009','authenticated','authenticated',
  'p1623-reconciler@example.test','','2099-01-01','{}','{}',now(),now());
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
values ('16230000-0000-4000-8000-000000000009','identity_reconciliation',
  now() - interval '1 hour','Phase 16.23 pgTAP reconciler');
select set_config('request.jwt.claims',
  '{"role":"authenticated","aal":"aal2","session_id":"16230000-0000-4000-8000-000000000009","sub":"16230000-0000-4000-8000-000000000009"}', true);
select public.resolve_cpsc_page_identity_hold(h.id, 'clear_page_hold',
  'Fixture: redirect reviewed; identity page unchanged')
from private.cpsc_page_identity_holds h
where h.identity_id = '16230000-0000-4000-8000-000000000002';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create function pg_temp.snapshot() returns jsonb language sql stable as $$
  select jsonb_build_object('canonicalUrl',
    'https://www.cpsc.gov/Recalls/2026/P1623-Fixture', 'finalUrl',
    'https://www.cpsc.gov/Recalls/2026/P1623-Fixture', 'httpStatus', 200,
    'fetchedAt', now(), 'rawPageHash', repeat('a',64),
    'contentType', 'text/html; charset=utf-8', 'etag', null,
    'lastModified', null, 'redirectChain', '[]'::jsonb);
$$;
create function pg_temp.revision() returns jsonb language sql stable as $$
  select jsonb_build_object('semanticHash', repeat('b',64),
    'normalized', jsonb_build_object('recallNumber', '26901',
      'canonicalUrl', 'https://www.cpsc.gov/Recalls/2026/P1623-Fixture',
      'title', 'Phase 16.23 fixture', 'description', 'Fixture description.'),
    'sections', '{}'::jsonb, 'tableIdentities', '[]'::jsonb,
    'parserVersion', 'phase-16.13-structured-v2');
$$;
create function pg_temp.ledger() returns jsonb language sql stable as $$
  select jsonb_build_object('schema', 'cpsc_source_coverage_v1',
    'ledgerVersion', 'phase-16.13-coverage-v1',
    'parserVersion', 'phase-16.13-structured-v2',
    'extractorVersion', 'phase-16.11-html-v1',
    'censusVersion', 'phase-16.13-census-v1',
    'sourceSemanticRevision', repeat('b',64),
    'structures', jsonb_build_array(jsonb_build_object(
      'structureId', 'description/prose', 'kind', 'prose',
      'sectionIdentity', 'description', 'tableIndex', null,
      'tableIdentity', null, 'authoritativeRecordCount', 1,
      'anomalies', '[]'::jsonb,
      'records', jsonb_build_array(jsonb_build_object(
        'ordinal', 0, 'recordIdentity', 'description/sentence/0',
        'rowIdentity', null, 'disposition', 'ignored_non_safety',
        'effect', 'none', 'extraction', 'extracted', 'relation', null,
        'reason', 'non-safety fixture', 'cells', '[]'::jsonb)))));
$$;
update private.cpsc_page_work_state set next_attempt_at = now() - interval '1 second'
where identity_id = '16230000-0000-4000-8000-000000000002';
select set_config('p1623.success_claim',
  (select claim_id::text from public.claim_cpsc_page_evidence(1)), true);
select extensions.throws_ok($$select public.commit_cpsc_page_evidence(
  current_setting('p1623.success_claim')::uuid,
  pg_temp.snapshot() || '{"rawPageHash":"bad"}'::jsonb,
  pg_temp.revision(), '[]'::jsonb, pg_temp.ledger())$$,
  null, 'A successful CPSC fetch must bind its own identity revision',
  'late fetch validation rolls back a newly inserted semantic revision');
select extensions.is((select count(*) from private.cpsc_page_revisions), 0::bigint,
  'late fetch rejection leaves no revision');
select extensions.throws_ok($$select public.commit_cpsc_page_evidence(
  current_setting('p1623.success_claim')::uuid, pg_temp.snapshot(),
  pg_temp.revision(), '[]'::jsonb, '{}'::jsonb)$$,
  null, 'Invalid CPSC coverage ledger',
  'late coverage validation rolls back revision and fetch together');
select extensions.is((select count(*) from private.cpsc_page_revisions), 0::bigint,
  'late ledger rejection leaves no revision');
select extensions.is((select count(*) from private.cpsc_page_fetches), 0::bigint,
  'late ledger rejection leaves no fetch');
select set_config('p1623.commit1', public.commit_cpsc_page_evidence(
  current_setting('p1623.success_claim')::uuid, pg_temp.snapshot(),
  pg_temp.revision(), '[]'::jsonb, pg_temp.ledger())::text, true);
select extensions.is(current_setting('p1623.commit1')::jsonb->>'outcome',
  'fetched_changed', 'successful evidence commit is changed');
select extensions.is((select count(*) from private.cpsc_page_revisions), 1::bigint,
  'one semantic revision committed');
select extensions.is((select count(*) from private.cpsc_page_fetches), 1::bigint,
  'one validated fetch committed');
select extensions.is((select count(*) from private.cpsc_page_coverage_ledgers), 1::bigint,
  'coverage committed in the same transaction');
select extensions.ok((select next_attempt_at >= now() + interval '1 day'
  from private.cpsc_page_work_state where identity_id =
  '16230000-0000-4000-8000-000000000002'), 'success schedules next refresh');
update private.cpsc_page_work_state set next_attempt_at = now() - interval '1 second'
where identity_id = '16230000-0000-4000-8000-000000000002';
select set_config('p1623.replay_claim',
  (select claim_id::text from public.claim_cpsc_page_evidence(1)), true);
select extensions.is(public.commit_cpsc_page_evidence(
  current_setting('p1623.replay_claim')::uuid, pg_temp.snapshot(),
  pg_temp.revision(), '[]'::jsonb, pg_temp.ledger())->>'outcome',
  'fetched_unchanged', 'same semantic evidence replays unchanged');
select extensions.is((select count(*) from private.cpsc_page_revisions), 1::bigint,
  'replay does not duplicate semantic revision');
select extensions.is((select count(*) from private.cpsc_page_coverage_ledgers), 1::bigint,
  'replay does not duplicate coverage ledger');
update private.cpsc_page_work_state set next_attempt_at = now() - interval '1 second'
where identity_id = '16230000-0000-4000-8000-000000000002';
select set_config('p1623.budget_claim',
  (select claim_id::text from public.claim_cpsc_page_evidence(1)), true);
select extensions.is(public.finish_cpsc_page_attempt(
  current_setting('p1623.budget_claim')::uuid, 'budget_deferred',
  null, null, null, 'cycle_deadline')->>'outcome', 'budget_deferred',
  'cycle deadline closes claim without fetch or revision');
select extensions.is((select consecutive_failures from private.cpsc_page_work_state
  where identity_id = '16230000-0000-4000-8000-000000000002'), 0,
  'budget deferral does not count as failure');
select extensions.is((select count(*) from private.cpsc_page_revisions), 1::bigint,
  'budget deferral writes no semantic evidence');

select * from extensions.finish();
rollback;
