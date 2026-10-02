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

-- ===========================================================================
-- Privilege boundary.
-- ===========================================================================
select extensions.ok(c.relrowsecurity and not exists (
  select 1 from pg_policies p where p.schemaname = 'private' and p.tablename = c.relname),
  format('%s has RLS and no API policy', c.relname))
from pg_class c where c.oid in ('private.cpsc_page_identity_holds'::regclass,
  'private.cpsc_page_identity_hold_resolutions'::regclass,
  'private.cpsc_backfill_page_hold_imports'::regclass);
select extensions.ok(not has_table_privilege(r, t, p), format('%s cannot %s %s', r, p, t))
from unnest(array['anon','authenticated','service_role','cpsc_page_worker']) r,
  unnest(array['private.cpsc_page_identity_holds','private.cpsc_page_identity_hold_resolutions',
    'private.cpsc_backfill_page_hold_imports','private.cpsc_page_identity_eligibility']) t,
  unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p;
select extensions.ok(not has_function_privilege(r, f, 'EXECUTE'),
  format('%s cannot execute %s', r, f))
from unnest(array['anon','authenticated','service_role','cpsc_page_worker']) r,
  unnest(array['private.cpsc_page_identity_blockers(uuid)',
    'private.cpsc_page_identity_eligible(uuid)',
    'private.cpsc_page_identity_evidence(uuid)',
    'private.cpsc_identity_decision_authorized(uuid,timestamptz)',
    'private.cpsc_import_backfill_page_holds(jsonb)']) f;
select extensions.ok(not has_function_privilege(r, f, 'EXECUTE'),
  format('%s cannot execute %s', r, f))
from unnest(array['anon','service_role','cpsc_page_worker']) r,
  unnest(array['public.resolve_cpsc_page_identity_hold(uuid,text,text)',
    'public.get_cpsc_page_identity_hold_packet(uuid)',
    'public.reconcile_cpsc_quarantined_observation(uuid,text,text)']) f;
select extensions.ok(has_function_privilege('authenticated',
  'public.resolve_cpsc_page_identity_hold(uuid,text,text)', 'EXECUTE'),
  'resolution RPC is reachable only by authenticated callers (capability-gated inside)');
select extensions.ok(has_function_privilege('cpsc_page_worker',
  'public.claim_cpsc_page_evidence(integer)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.claim_cpsc_page_evidence(integer)', 'EXECUTE')
  and has_function_privilege('cpsc_page_worker',
  'public.commit_cpsc_page_evidence_verified(uuid,jsonb,jsonb,jsonb,jsonb,bytea)', 'EXECUTE'),
  'claim and verified commit keep their dedicated-worker grants');
select extensions.ok(not has_table_privilege('cpsc_page_worker', t, p),
  format('page worker cannot %s %s', p, t))
from unnest(array['private.cpsc_source_identities','private.cpsc_source_aliases',
  'private.cpsc_identity_reconciliations','private.cpsc_admin_capabilities',
  'private.cpsc_reviewer_authorizations','private.recall_source_sync_state',
  'public.recall_matches','public.alerts']) t,
  unnest(array['INSERT','UPDATE','DELETE']) p;

-- ===========================================================================
-- Production-equivalent backfill: the 26777 and 20163 shapes run through the
-- real 16.12 historical backfill, which marks both `reconciled`.
-- ===========================================================================
select set_config('p1629.source', public.ensure_cpsc_recall_source()::text, true);
insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
  recall_date,official_url,retrieved_at,raw_payload)
values
  ('16290000-0000-4000-8000-000000000101', current_setting('p1629.source')::uuid, '8876',
   'P1629 lawn darts', 'Description', 'Hazard', 'Dispose', '2020-01-02',
   'https://www.cpsc.gov/Recalls/2020/P1629-Lawn-Darts', '2026-09-15 05:12:22+00',
   '{"RecallID":8876,"RecallNumber":"20-163"}'),
  ('16290000-0000-4000-8000-000000000102', current_setting('p1629.source')::uuid, '10987',
   'P1629 pool heaters', 'Description', 'Carbon monoxide', 'Repair', '2026-09-18',
   'https://cpsc.gov/Recalls/2026/P1629-Pool-Heaters-Hazard-0', '2026-09-20 00:17:04+00',
   '{"RecallID":10987,"RecallNumber":"26-777"}'),
  ('16290000-0000-4000-8000-000000000103', current_setting('p1629.source')::uuid, '10990',
   'P1629 pool heaters', 'Description', 'Carbon monoxide', 'Repair', '2026-09-18',
   'https://www.cpsc.gov/Recalls/2026/P1629-Pool-Heaters-Hazard-0', '2026-09-18 12:17:03+00',
   '{"RecallID":10990,"RecallNumber":"26-777"}');
create function pg_temp.manifest() returns jsonb language sql immutable as $$
  select jsonb_build_object('manifestVersion', 'phase-16.12-cpsc-backfill-v1',
    'pages', '[]'::jsonb, 'currentObservations', '[]'::jsonb,
    'unresolvedIdentities', jsonb_build_array(
      jsonb_build_object('recallNumber', '26777', 'apiId', '10987',
        'apiUrl', 'https://cpsc.gov/Recalls/2026/P1629-Pool-Heaters-Hazard-0',
        'officialPageFinalUrl', 'https://www.cpsc.gov/Recalls/2026/P1629-Pool-Heaters-Hazard',
        'redirectChain', jsonb_build_array(
          'https://www.cpsc.gov/Recalls/2026/P1629-Pool-Heaters-Hazard'),
        'reasons', jsonb_build_array(
          'official page identity check failed: CPSC page canonical link contradicts its identity.'),
        'requiredAction', 'Human identity reconciliation of the official URL change before any live page ingestion.'),
      jsonb_build_object('recallNumber', '29999',
        'requiredAction', 'Human identity reconciliation before any live page ingestion.')));
$$;
select set_config('request.jwt.claims', '', true);
select set_config('p1629.backfill', private.cpsc_historical_backfill(
  pg_temp.manifest(), 'all', true, 'Phase 16.29 pgTAP backfill', 500)::text, true);
select extensions.ok((current_setting('p1629.backfill')::jsonb #>> '{structure,complete}')::boolean
  and (current_setting('p1629.backfill')::jsonb #>> '{observations,complete}')::boolean,
  'real historical backfill completes both stages');
select set_config('p1629.id20163', (select id::text from private.cpsc_source_identities
  where official_recall_number = '20163'), true);
select set_config('p1629.id26777', (select id::text from private.cpsc_source_identities
  where official_recall_number = '26777'), true);
select extensions.ok((select identity_status = 'reconciled'
    and canonical_url = 'https://www.cpsc.gov/Recalls/2026/P1629-Pool-Heaters-Hazard-0'
  from private.cpsc_source_identities where id = current_setting('p1629.id26777')::uuid),
  '26777 fixture is backfill-reconciled on its API -Hazard-0 URL');
select extensions.is((select count(*) from private.cpsc_notice_identity_links
  where identity_id = current_setting('p1629.id26777')::uuid), 2::bigint,
  '26777 fixture carries both historical notices');
select extensions.is((select count(*) from private.cpsc_identity_observations
  where identity_id = current_setting('p1629.id26777')::uuid
    and resolution = 'resolved' and decision_class = 'A_known_alias'), 2::bigint,
  '26777 fixture observations resolve as known aliases, as in production');
select extensions.is((select count(*) from private.cpsc_identity_reconciliations), 0::bigint,
  'backfill creates no human reconciliation');

-- Backfill-only `reconciled` is not unattended page provenance.
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.id20163')::uuid),
  array['backfill_page_provenance_unverified'],
  'backfill-only reconciled 20163 fixture is not yet page-eligible');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.id26777')::uuid),
  array['backfill_page_provenance_unverified'],
  'backfill-only reconciled 26777 fixture is not page-eligible');
set local role cpsc_page_worker;
select extensions.is((select count(*) from public.claim_cpsc_page_evidence(10)), 0::bigint,
  'no backfill identity is claimable before its manifest dispositions are imported');
reset role;

-- ===========================================================================
-- Manifest import: owner only, hash-bound to an executed backfill run.
-- ===========================================================================
create function pg_temp.api_identity_fp(p_number text) returns text language sql stable as $$
  select md5(concat_ws('|',
    (select to_jsonb(i)::text from private.cpsc_source_identities i
      where i.official_recall_number = p_number),
    (select string_agg(to_jsonb(l)::text, ',' order by l.notice_id)
      from private.cpsc_notice_identity_links l join private.cpsc_source_identities i
        on i.id = l.identity_id where i.official_recall_number = p_number),
    (select string_agg(to_jsonb(a)::text, ',' order by a.id)
      from private.cpsc_source_aliases a join private.cpsc_source_identities i
        on i.id = a.identity_id where i.official_recall_number = p_number),
    (select string_agg(to_jsonb(o)::text, ',' order by o.observation_seq)
      from private.cpsc_identity_observations o where o.official_recall_number = p_number)));
$$;
select set_config('p1629.fp26777', pg_temp.api_identity_fp('26777'), true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select extensions.throws_ok($$select private.cpsc_import_backfill_page_holds(pg_temp.manifest())$$,
  '42501', null, 'service_role cannot import page holds');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select extensions.throws_ok($$select private.cpsc_import_backfill_page_holds(pg_temp.manifest())$$,
  '42501', null, 'authenticated caller cannot import page holds');
select set_config('request.jwt.claims', '', true);
set local role cpsc_page_worker;
select extensions.throws_ok($$select private.cpsc_import_backfill_page_holds('{}'::jsonb)$$,
  '42501', null, 'page worker cannot reach the import function');
reset role;
select extensions.throws_ok($$select private.cpsc_import_backfill_page_holds(
  pg_temp.manifest() || '{"unresolvedIdentities":[]}'::jsonb)$$,
  null, 'Manifest does not match an executed CPSC backfill run',
  'a manifest without the reviewed dispositions cannot be imported');
select set_config('p1629.import', private.cpsc_import_backfill_page_holds(
  pg_temp.manifest())::text, true);
select extensions.is((current_setting('p1629.import')::jsonb->>'holdsCreated')::integer, 2,
  'manifest import records one hold per unresolved identity');
select extensions.is(current_setting('p1629.import')::jsonb->'withoutIdentity', '["29999"]'::jsonb,
  'an unresolved number without an identity is still held by number');
select extensions.throws_ok($$select private.cpsc_import_backfill_page_holds(pg_temp.manifest())$$,
  null, 'Backfill manifest page holds were already imported', 'import is one-shot');

select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.id20163')::uuid),
  '{}'::text[], '20163 fixture is page-eligible after verified provenance');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.id26777')::uuid),
  array['human_reconciliation_required'], '26777 fixture requires human page reconciliation');
select extensions.is((select page_eligibility from private.cpsc_page_identity_eligibility
  where identity_id = current_setting('p1629.id26777')::uuid),
  'human_reconciliation_required', 'eligibility read model reports the 26777 state');
select extensions.is(pg_temp.api_identity_fp('26777'), current_setting('p1629.fp26777'),
  'page hold leaves the canonical API identity, links, aliases, and observations untouched');
select extensions.throws_ok($$update private.cpsc_page_identity_holds set evidence = '{}'$$,
  '42501', null, 'holds are append-only');
select extensions.throws_ok($$delete from private.cpsc_page_identity_holds$$,
  '42501', null, 'holds cannot be deleted');
select extensions.throws_ok($$delete from private.cpsc_backfill_page_hold_imports$$,
  '42501', null, 'manifest imports cannot be deleted');
select extensions.ok((select evidence_sha256 = private.cpsc_canonical_json_sha256(evidence)
  from private.cpsc_page_identity_holds where official_recall_number = '26777'),
  'hold evidence hash is recomputed by the database');

-- ===========================================================================
-- Ordinary and adversarial fixtures (created directly, no backfill items).
-- ===========================================================================
create function pg_temp.identity(p_number text, p_url text, p_first timestamptz,
  p_payload_number text default null)
returns uuid language plpgsql as $$
declare v_notice uuid := gen_random_uuid(); v_identity uuid := gen_random_uuid();
begin
  insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
    recall_date,official_url,retrieved_at,raw_payload)
  values (v_notice, current_setting('p1629.source')::uuid, 'cpsc:' || p_number,
    'P1629 ' || p_number, 'Description', 'Hazard', 'Refund', '2026-09-20', p_url, now(),
    jsonb_build_object('RecallNumber', coalesce(p_payload_number, p_number)));
  insert into private.cpsc_source_identities (id,source_id,official_recall_number,
    canonical_url,canonical_notice_id,identity_status,first_seen_at,last_seen_at)
  values (v_identity, current_setting('p1629.source')::uuid, p_number, p_url, v_notice,
    'reconciled', p_first, greatest(p_first, now()));
  insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance)
  values (v_notice, v_identity, 'Phase 16.29 pgTAP');
  return v_identity;
end;
$$;
select set_config('p1629.a', pg_temp.identity('29001',
  'https://www.cpsc.gov/Recalls/2026/P1629-Ordinary', '1900-01-01 00:00:05+00')::text, true);
select set_config('p1629.q', pg_temp.identity('29002',
  'https://www.cpsc.gov/Recalls/2026/P1629-Quarantine', '1900-01-01 00:00:01+00')::text, true);
select set_config('p1629.u', pg_temp.identity('29003',
  'https://www.cpsc.gov/Recalls/2026/P1629-Lineage', '1900-01-01 00:00:02+00')::text, true);
select set_config('p1629.v', pg_temp.identity('29004',
  'https://www.cpsc.gov/Recalls/2026/P1629-Moved', '1900-01-01 00:00:03+00')::text, true);
select set_config('p1629.m', pg_temp.identity('29006',
  'https://www.cpsc.gov/Recalls/2026/P1629-Mismatch', '1900-01-01 00:00:04+00', '29060')::text, true);
-- The held 26777 fixture sorts ahead of every eligible identity.
update private.cpsc_source_identities set first_seen_at = '1900-01-01 00:00:00+00'
  where id = current_setting('p1629.id26777')::uuid;

select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.a')::uuid),
  '{}'::text[], 'ordinary reconciled safe identity is eligible');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.m')::uuid),
  array['canonical_notice_inconsistent'],
  'canonical notice with a different official recall number is ineligible');
select extensions.is(private.cpsc_page_identity_blockers(
  '16290000-0000-4000-8000-0000000009ff'), array['identity_missing'],
  'unknown identity fails closed');

-- Unresolved quarantine: a reused API id held by 29001 is observed for 29002.
insert into private.cpsc_source_aliases (identity_id, notice_id, alias_kind, alias_value,
  provenance, first_seen_at, last_seen_at)
select current_setting('p1629.a')::uuid, canonical_notice_id, 'api_id', '99001',
  'Phase 16.29 pgTAP alias', now(), now()
from private.cpsc_source_identities where id = current_setting('p1629.a')::uuid;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('p1629.q_obs', public.record_cpsc_identity_observation('99001', '29002',
  'https://www.cpsc.gov/Recalls/2026/P1629-Quarantine',
  'https://www.cpsc.gov/Recalls/2026/P1629-Quarantine', 'P1629 29002', '2026-09-20',
  repeat('c', 64), now(), 'Phase 16.29 pgTAP')::text, true);
-- A canonical URL change observed by the API for 29004.
select set_config('p1629.v_obs', public.record_cpsc_identity_observation('99004', '29004',
  'https://www.cpsc.gov/Recalls/2026/P1629-Moved-Elsewhere',
  'https://www.cpsc.gov/Recalls/2026/P1629-Moved-Elsewhere', 'P1629 29004', '2026-09-20',
  repeat('d', 64), now(), 'Phase 16.29 pgTAP')::text, true);
select set_config('request.jwt.claims', '', true);
select extensions.is(current_setting('p1629.q_obs')::jsonb->>'decisionClass', 'D_api_id_reuse',
  'reused API id is quarantined by the real identity gate');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.q')::uuid),
  array['unresolved_quarantine'], 'unresolved quarantine is ineligible');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.a')::uuid),
  '{}'::text[], 'the alias owner of the reused API id is not over-blocked');
select extensions.is(current_setting('p1629.v_obs')::jsonb->>'decisionClass', 'E_url_changed',
  'canonical URL change is quarantined by the real identity gate');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.v')::uuid),
  array['unresolved_quarantine', 'url_lineage_conflict'],
  'unresolved observation URL conflict is ineligible');

-- URL lineage conflict: a second linked notice points elsewhere.
insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
  recall_date,official_url,retrieved_at,raw_payload)
values ('16290000-0000-4000-8000-000000000301', current_setting('p1629.source')::uuid,
  'cpsc:29003-b', 'P1629 29003', 'Description', 'Hazard', 'Refund', '2026-09-20',
  'https://www.cpsc.gov/Recalls/2026/P1629-Lineage-Hazard', now(), '{"RecallNumber":"29003"}');
insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance)
values ('16290000-0000-4000-8000-000000000301', current_setting('p1629.u')::uuid,
  'Phase 16.29 pgTAP');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.u')::uuid),
  array['url_lineage_conflict'], 'unreconciled URL lineage conflict is ineligible');

-- Fake human markers never clear anything.
insert into private.cpsc_source_aliases (identity_id, notice_id, alias_kind, alias_value,
  provenance, first_seen_at, last_seen_at)
select current_setting('p1629.id26777')::uuid, canonical_notice_id, 'official_url',
  'https://www.cpsc.gov/Recalls/2026/P1629-Pool-Heaters-Hazard',
  'human reconciliation 00000000-0000-0000-0000-000000000000', now(), now()
from private.cpsc_source_identities where id = current_setting('p1629.id26777')::uuid;
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.id26777')::uuid),
  array['url_lineage_conflict', 'human_reconciliation_required'],
  'free-text "human reconciliation" alias provenance is not provenance and adds a conflict');

insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id::uuid,'authenticated','authenticated',email,'','2099-01-01','{}','{}',now(),now()
from (values
  ('16290000-0000-4000-8000-000000000901','p1629-reconciler@example.test'),
  ('16290000-0000-4000-8000-000000000902','p1629-criterion-reviewer@example.test'),
  ('16290000-0000-4000-8000-000000000903','p1629-consumer@example.test')) u(id,email);
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
values ('16290000-0000-4000-8000-000000000901','identity_reconciliation',
  now() - interval '1 hour','Phase 16.29 pgTAP reconciler');
insert into private.cpsc_reviewer_authorizations (user_id, reason)
values ('16290000-0000-4000-8000-000000000902','Phase 16.29 pgTAP criterion reviewer');
select set_config('p1629.hold26777', (select id::text from private.cpsc_page_identity_holds
  where identity_id = current_setting('p1629.id26777')::uuid), true);

select extensions.throws_ok(format($$insert into private.cpsc_page_identity_hold_resolutions
  (hold_id, decision, reviewer_user_id, rationale, evidence_snapshot, evidence_sha256)
  values (%L, 'clear_page_hold', '16290000-0000-4000-8000-000000000901',
  'owner forgery with a real reviewer id', '{}', repeat('0',64))$$,
  current_setting('p1629.hold26777')), '42501', null,
  'owner cannot forge a resolution with a reviewer id and no authenticated decision');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select extensions.throws_ok(format($$select public.resolve_cpsc_page_identity_hold(%L,
  'clear_page_hold', 'service bypass')$$, current_setting('p1629.hold26777')),
  '42501', null, 'service_role cannot clear a page hold');
select extensions.throws_ok($$select public.reconcile_cpsc_quarantined_observation(
  (current_setting('p1629.q_obs')::jsonb->>'observationId')::uuid,
  'reject_observation', 'service bypass')$$,
  '42501', null, 'service_role cannot reconcile a quarantine');
select set_config('request.jwt.claims',
  '{"role":"authenticated","aal":"aal2","session_id":"16290000-0000-4000-8000-000000000903","sub":"16290000-0000-4000-8000-000000000903"}', true);
select extensions.throws_ok(format($$select public.resolve_cpsc_page_identity_hold(%L,
  'clear_page_hold', 'consumer attempt')$$, current_setting('p1629.hold26777')),
  '42501', null, 'consumer cannot clear a page hold');
select extensions.throws_ok(format($$select public.get_cpsc_page_identity_hold_packet(%L)$$,
  current_setting('p1629.hold26777')), '42501', null, 'consumer cannot read the hold packet');
select set_config('request.jwt.claims',
  '{"role":"authenticated","aal":"aal2","session_id":"16290000-0000-4000-8000-000000000902","sub":"16290000-0000-4000-8000-000000000902"}', true);
select extensions.throws_ok(format($$select public.resolve_cpsc_page_identity_hold(%L,
  'clear_page_hold', 'criterion reviewer attempt')$$, current_setting('p1629.hold26777')),
  '42501', null, 'criterion reviewer without identity capability cannot clear a page hold');
select set_config('request.jwt.claims', '', true);
set local role cpsc_page_worker;
select extensions.throws_ok(format($$select public.resolve_cpsc_page_identity_hold(%L,
  'clear_page_hold', 'worker attempt')$$, current_setting('p1629.hold26777')),
  '42501', null, 'page worker cannot clear a page hold');
select extensions.throws_ok($$insert into private.cpsc_page_identity_hold_resolutions
  (hold_id, decision, reviewer_user_id, rationale, evidence_snapshot, evidence_sha256)
  values (gen_random_uuid(), 'clear_page_hold', gen_random_uuid(), 'x', '{}', repeat('0',64))$$,
  '42501', null, 'page worker cannot write resolutions');
reset role;
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.id26777')::uuid),
  array['url_lineage_conflict', 'human_reconciliation_required'],
  'every unauthorized attempt left the 26777 fixture ineligible');

-- ===========================================================================
-- Claim fairness: the held identity sorts first and is skipped without
-- starving the next eligible identity.
-- ===========================================================================
set local role cpsc_page_worker;
select set_config('p1629.c1', (select string_agg(official_recall_number, ',')
  from public.claim_cpsc_page_evidence(1)), true);
select set_config('p1629.c2', (select string_agg(official_recall_number, ',')
  from public.claim_cpsc_page_evidence(1)), true);
-- Phase 16.32: release both lanes (global concurrency is two) so the next
-- claim measures eligibility, not the concurrency backstop.
reset role;
select set_config('p1629.c_claims', (select string_agg(claim_id::text, ',')
  from private.cpsc_page_work_state where claim_id is not null and claim_expires_at > now()), true);
set local role cpsc_page_worker;
select public.finish_cpsc_page_attempt(c::uuid, 'budget_deferred', null, null, null,
  'cycle_deadline') from unnest(string_to_array(current_setting('p1629.c_claims'), ',')) c;
select set_config('p1629.c3', coalesce((select string_agg(official_recall_number, ',')
  from public.claim_cpsc_page_evidence(10)), ''), true);
reset role;
select extensions.is(current_setting('p1629.c1'), '29001',
  'first claim skips ineligible identities that sort earlier');
select extensions.is(current_setting('p1629.c2'), '20163',
  'second claim takes the next eligible identity in order');
select extensions.is(current_setting('p1629.c3'), '',
  'no ineligible identity is ever claimed');
select extensions.is((select count(*) from private.cpsc_page_attempts a
  where a.identity_id in (current_setting('p1629.id26777')::uuid,
    current_setting('p1629.q')::uuid, current_setting('p1629.u')::uuid,
    current_setting('p1629.v')::uuid, current_setting('p1629.m')::uuid)), 0::bigint,
  'ineligible identities have no attempts');
select extensions.is((select count(*) from private.cpsc_page_work_state w
  where w.identity_id in (current_setting('p1629.id26777')::uuid,
    current_setting('p1629.q')::uuid, current_setting('p1629.u')::uuid,
    current_setting('p1629.v')::uuid, current_setting('p1629.m')::uuid)), 0::bigint,
  'ineligible identities get no work state');

-- ===========================================================================
-- Authorized human resolution through the existing capability.
-- ===========================================================================
select set_config('request.jwt.claims',
  '{"role":"authenticated","aal":"aal2","session_id":"16290000-0000-4000-8000-000000000901","sub":"16290000-0000-4000-8000-000000000901"}', true);
select extensions.ok(public.get_cpsc_page_identity_hold_packet(
  current_setting('p1629.hold26777')::uuid) #>> '{holdEvidence,manifestEntry,officialPageFinalUrl}'
  = 'https://www.cpsc.gov/Recalls/2026/P1629-Pool-Heaters-Hazard',
  'authorized human packet carries the redirect evidence');
select extensions.is(public.resolve_cpsc_page_identity_hold(
  current_setting('p1629.hold26777')::uuid, 'keep_page_hold',
  'Redirect target not yet reviewed')->>'decision', 'keep_page_hold',
  'authorized human can keep a hold');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.id26777')::uuid),
  array['url_lineage_conflict', 'human_reconciliation_required'],
  'keep_page_hold leaves the identity ineligible');
select extensions.ok(public.resolve_cpsc_page_identity_hold(
  current_setting('p1629.hold26777')::uuid, 'clear_page_hold',
  'Reviewed: same recall 26-777; page identity confirmed') ? 'resolutionId',
  'authorized human can clear a hold');
select extensions.throws_ok(format($$select public.resolve_cpsc_page_identity_hold(%L,
  'clear_page_hold', 'again')$$, current_setting('p1629.hold26777')),
  null, 'CPSC page hold is already cleared', 'a hold is cleared once');
-- Quarantine and URL change clear only through the existing reconciliation RPC.
select public.reconcile_cpsc_quarantined_observation(
  (current_setting('p1629.q_obs')::jsonb->>'observationId')::uuid,
  'reject_observation', 'Reused API id belongs to 29001');
select public.reconcile_cpsc_quarantined_observation(
  (current_setting('p1629.v_obs')::jsonb->>'observationId')::uuid,
  'confirm_alias', 'Same recall; CPSC moved the page');
select set_config('request.jwt.claims', '', true);
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.id26777')::uuid),
  array['url_lineage_conflict'],
  'clearing the hold does not launder the forged free-text alias');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.q')::uuid),
  '{}'::text[], 'authorized quarantine rejection restores eligibility');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.v')::uuid),
  '{}'::text[], 'authorized alias confirmation of a URL change restores eligibility');
select extensions.throws_ok($$update private.cpsc_page_identity_hold_resolutions set rationale = 'x'$$,
  '42501', null, 'resolutions are append-only');
select extensions.ok((select evidence_sha256 = private.cpsc_canonical_json_sha256(evidence_snapshot)
  and reviewer_user_id = '16290000-0000-4000-8000-000000000901'
  and evidence_snapshot ? 'identityEvidence'
  from private.cpsc_page_identity_hold_resolutions where decision = 'clear_page_hold'),
  'resolution binds reviewer, rationale, and hashed evidence packet');

-- A later identity for a manifest-held number is held by provenance, not by id.
select set_config('p1629.late', pg_temp.identity('29999',
  'https://www.cpsc.gov/Recalls/2026/P1629-Late', '1900-01-01 00:00:06+00')::text, true);
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.late')::uuid),
  array['human_reconciliation_required'],
  'a later identity for a held recall number stays ineligible');

-- ===========================================================================
-- Worker identity redirect creates a hold; a human decision clears it.
-- ===========================================================================
select set_config('p1629.r', pg_temp.identity('29005',
  'https://www.cpsc.gov/Recalls/2026/P1629-Redirect', '1800-01-01 00:00:00+00')::text, true);
set local role cpsc_page_worker;
select set_config('p1629.r_claim', (select claim_id::text
  from public.claim_cpsc_page_evidence(1)), true);
reset role;
select extensions.ok((select identity_id = current_setting('p1629.r')::uuid
  from private.cpsc_page_attempts where id = current_setting('p1629.r_claim')::uuid),
  'redirect fixture is claimed');
set local role cpsc_page_worker;
select public.finish_cpsc_page_attempt(current_setting('p1629.r_claim')::uuid,
  'identity_redirect', 200, 'https://www.cpsc.gov/Recalls/2026/P1629-Redirect-Elsewhere',
  repeat('e', 64), 'final_url_mismatch');
reset role;
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.r')::uuid),
  array['human_reconciliation_required'],
  'identity-sensitive redirect without human reconciliation is ineligible');
select extensions.ok((select hold_class = 'worker_identity_redirect'
    and evidence->>'finalUrl' = 'https://www.cpsc.gov/Recalls/2026/P1629-Redirect-Elsewhere'
    and evidence->>'errorCode' = 'final_url_mismatch'
  from private.cpsc_page_identity_holds where origin_attempt_id = current_setting('p1629.r_claim')::uuid),
  'redirect hold binds the attempt transport evidence');
update private.cpsc_page_work_state set next_attempt_at = now() - interval '1 second'
  where identity_id = current_setting('p1629.r')::uuid;
set local role cpsc_page_worker;
select extensions.is((select count(*) from public.claim_cpsc_page_evidence(10)
  where identity_id = current_setting('p1629.r')::uuid), 0::bigint,
  'a due redirect-held identity is still not claimable');
reset role;
select extensions.throws_ok(format($$insert into private.cpsc_page_identity_holds
  (identity_id, official_recall_number, hold_class, origin_attempt_id, evidence, evidence_sha256)
  values (%L, '29001', 'worker_identity_redirect', %L, '{}', repeat('0',64))$$,
  current_setting('p1629.a'), current_setting('p1629.r_claim')),
  null, 'CPSC page hold does not match its identity redirect attempt',
  'a worker-class hold must bind a real redirect attempt of its identity');
select set_config('request.jwt.claims',
  '{"role":"authenticated","aal":"aal2","session_id":"16290000-0000-4000-8000-000000000901","sub":"16290000-0000-4000-8000-000000000901"}', true);
select public.resolve_cpsc_page_identity_hold(h.id, 'clear_page_hold', 'Redirect reviewed')
  from private.cpsc_page_identity_holds h where h.identity_id = current_setting('p1629.r')::uuid;
select set_config('request.jwt.claims', '', true);
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.r')::uuid),
  '{}'::text[], 'same redirect case with authorized human reconciliation is eligible');
select extensions.ok((select next_attempt_at = now() - interval '1 second'
    and claim_id is null and not manual_review_required
  from private.cpsc_page_work_state where identity_id = current_setting('p1629.r')::uuid),
  'human clearance changes no work state (no automatic worker approval)');
update private.cpsc_page_work_state set next_attempt_at = '-infinity'
  where identity_id = current_setting('p1629.r')::uuid;

-- ===========================================================================
-- Semantic commit re-checks eligibility for a hold recorded mid-claim.
-- ===========================================================================
-- Phase 16.32: release lanes still held by the claim(10) above (global
-- concurrency is two) so the redirect identity is claimed at its turn.
select set_config('p1629.open_claims', coalesce((select string_agg(claim_id::text, ',')
  from private.cpsc_page_work_state where claim_id is not null and claim_expires_at > now()), ''),
  true);
set local role cpsc_page_worker;
select public.finish_cpsc_page_attempt(c::uuid, 'budget_deferred', null, null, null,
  'cycle_deadline') from unnest(string_to_array(nullif(current_setting('p1629.open_claims'), ''),
  ',')) c;
select set_config('p1629.r_claim2', (select claim_id::text
  from public.claim_cpsc_page_evidence(1)), true);
reset role;
select extensions.ok((select identity_id = current_setting('p1629.r')::uuid
  from private.cpsc_page_attempts where id = current_setting('p1629.r_claim2')::uuid),
  'cleared redirect identity is claimable again at its natural turn');
create function pg_temp.raw_r() returns bytea language sql immutable as $$
  select convert_to('<html><body>Phase 16.29 transport</body></html>', 'UTF8');
$$;
create function pg_temp.snapshot_r() returns jsonb language sql stable as $$
  select jsonb_build_object('canonicalUrl', 'https://www.cpsc.gov/Recalls/2026/P1629-Redirect',
    'finalUrl', 'https://www.cpsc.gov/Recalls/2026/P1629-Redirect', 'httpStatus', 200,
    'fetchedAt', now(), 'rawPageHash', encode(extensions.digest(pg_temp.raw_r(), 'sha256'), 'hex'),
    'contentType', 'text/html; charset=utf-8', 'etag', null, 'lastModified', null,
    'redirectChain', '[]'::jsonb);
$$;
set local role cpsc_page_worker;
select public.retain_cpsc_page_transport(current_setting('p1629.r_claim2')::uuid,
  pg_temp.snapshot_r(), pg_temp.raw_r());
reset role;
-- A new manual-review flag lands while the claim is in flight.
update private.cpsc_page_work_state set manual_review_required = true
  where identity_id = current_setting('p1629.r')::uuid;
set local role cpsc_page_worker;
select extensions.throws_ok(format($$select public.commit_cpsc_page_evidence_verified(%L,
  %L::jsonb, jsonb_build_object('parserVersion', 'phase-16.13-structured-v2',
    'normalized', jsonb_build_object('tables', '[]'::jsonb)), '[]'::jsonb, '{}'::jsonb, %L::bytea)$$,
  current_setting('p1629.r_claim2'), pg_temp.snapshot_r(), pg_temp.raw_r()),
  null, 'CPSC page identity is not eligible for unattended evidence',
  'verified commit re-checks page eligibility');
reset role;
select extensions.is((select count(*) from private.cpsc_page_revisions
  where identity_id = current_setting('p1629.r')::uuid), 0::bigint,
  'ineligible commit binds no semantic revision');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1629.r')::uuid),
  array['manual_review_required'], 'manual review flag is an eligibility blocker');

-- The worker cannot touch identity, alias, or source state through the rule.
select extensions.is((select count(*) from private.cpsc_identity_reconciliations r
  where r.reviewer_user_id <> '16290000-0000-4000-8000-000000000901'), 0::bigint,
  'every reconciliation came from the authorized human');

select * from extensions.finish();
rollback;
