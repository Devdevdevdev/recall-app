begin;
set local role postgres;
set local search_path = extensions, public, auth;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

-- ---------------------------------------------------------------------------
-- Privilege boundary for every Phase 16.12 object
-- ---------------------------------------------------------------------------
select extensions.ok(not has_table_privilege(r, format('private.%s', t), p),
  format('%s has no %s on private.%s', r, p, t))
  from unnest(array['anon','authenticated','service_role']) r,
    unnest(array['recall_scope_rule_sets_v2','cpsc_admin_capabilities',
      'cpsc_review_decision_invalidations','cpsc_notice_revisions','cpsc_backfill_runs',
      'cpsc_backfill_items']) t,
    unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;
select extensions.ok(c.relrowsecurity, format('RLS enabled on private.%s', c.relname))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private' and c.relname in ('recall_scope_rule_sets_v2',
    'cpsc_admin_capabilities','cpsc_review_decision_invalidations','cpsc_notice_revisions',
    'cpsc_backfill_runs','cpsc_backfill_items');
select extensions.ok(has_function_privilege('authenticated', f, 'EXECUTE')
    and not has_function_privilege('service_role', f, 'EXECUTE')
    and not has_function_privilege('anon', f, 'EXECUTE'),
  format('human-only RPC %s', f))
  from unnest(array[
    'public.invalidate_cpsc_review_decision(uuid,text)',
    'public.invalidate_cpsc_reviewer_decisions(uuid,timestamptz,timestamptz,text)',
    'public.decide_cpsc_candidate(uuid,text,boolean,text)',
    'public.materialize_cpsc_reviewed_conjunction(uuid)',
    'public.reconcile_cpsc_quarantined_observation(uuid,text,text)']) f;
select extensions.ok(has_function_privilege('service_role', f, 'EXECUTE')
    and not has_function_privilege('authenticated', f, 'EXECUTE')
    and not has_function_privilege('anon', f, 'EXECUTE'),
  format('worker-only RPC %s', f))
  from unnest(array[
    'public.record_cpsc_notice_revision(uuid,text,text,text,jsonb)',
    'public.get_cpsc_current_notice_revision(uuid)',
    'public.get_recall_v2_scopes(uuid)']) f;
select extensions.ok(not has_function_privilege(r, f, 'EXECUTE'),
  format('%s cannot execute %s', r, f))
  from unnest(array['anon','authenticated','service_role']) r,
    unnest(array[
      'private.cpsc_historical_backfill(jsonb,text,boolean,text,integer)',
      'private.cpsc_backfill_retract(uuid,text)',
      'private.cpsc_backfill_apply(uuid,jsonb,text,integer)',
      'private.cpsc_reviewed_rule_set(uuid,text)',
      'private.cpsc_stale_identity_reviews(uuid,text)']) f;
select extensions.ok(not exists (select 1 from pg_policies where schemaname = 'private'
    and tablename in ('recall_scope_rule_sets_v2','cpsc_admin_capabilities',
      'cpsc_review_decision_invalidations','cpsc_notice_revisions')),
  'no policy exposes rule sets, capabilities, invalidations, or notice revisions');

-- ---------------------------------------------------------------------------
-- Shared fixtures: users, capabilities, CPSC source, helpers
-- ---------------------------------------------------------------------------
insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id::uuid,'authenticated','authenticated',email,'','2099-01-01','{}','{}',now(),now()
from (values
  ('16120000-0000-4000-8000-000000000001','p1612-reviewer-one@example.invalid'),
  ('16120000-0000-4000-8000-000000000002','p1612-reviewer-two@example.invalid'),
  ('16120000-0000-4000-8000-000000000003','p1612-reviewer-three@example.invalid'),
  ('16120000-0000-4000-8000-000000000004','p1612-reconciler@example.invalid'),
  ('16120000-0000-4000-8000-000000000005','p1612-invalidator@example.invalid'),
  ('16120000-0000-4000-8000-000000000006','p1612-consumer@example.invalid')) u(id,email);
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
insert into private.cpsc_reviewer_authorizations (user_id, authorized_at, reason)
select id::uuid, now() - interval '1 hour', 'Phase 16.12 pgTAP reviewer'
from unnest(array['16120000-0000-4000-8000-000000000001','16120000-0000-4000-8000-000000000002',
  '16120000-0000-4000-8000-000000000003']) id;
insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason) values
  ('16120000-0000-4000-8000-000000000004','identity_reconciliation',now() - interval '1 hour','pgTAP reconciler'),
  ('16120000-0000-4000-8000-000000000005','decision_invalidation',now() - interval '1 hour','pgTAP invalidator');
select set_config('t12.source', public.ensure_cpsc_recall_source()::text, true);

create function pg_temp.act(p_role text, p_sub text default null) returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('role', p_role) ||
    case when p_sub is null then '{}'::jsonb
      else jsonb_build_object('sub', '16120000-0000-4000-8000-0000000000' || p_sub, 'aal', 'aal2',
        'session_id', '16120000-0000-4000-8000-0000000000' || p_sub) end)::text, true);
$$;
create function pg_temp.done() returns void language sql as $$
  select set_config('request.jwt.claims', '', true);
$$;
create function pg_temp.id(p_suffix text) returns uuid language sql immutable as $$
  select ('16120000-0000-4000-8000-' || lpad(p_suffix, 12, '0'))::uuid;
$$;

-- A reconciled CPSC recall with one sole scope and a current page revision.
create function pg_temp.recall(p_key text, p_number text, p_hash text, p_payload jsonb default null)
returns void language plpgsql as $$
declare v_url text := 'https://www.cpsc.gov/Recalls/2026/P1612-' || p_key;
begin
  insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
    recall_date,official_url,retrieved_at,raw_payload)
  values (pg_temp.id('10' || p_number), current_setting('t12.source')::uuid, 'cpsc:' || p_number,
    'Recall ' || p_key, 'Desc', 'Hazard', 'Refund', '2026-09-20', v_url, now() - interval '1 day',
    coalesce(p_payload, jsonb_build_object('RecallNumber', p_number)));
  insert into public.recall_scopes (id,recall_notice_id,product_name)
  values (pg_temp.id('20' || p_number), pg_temp.id('10' || p_number), 'Product ' || p_key);
  insert into private.cpsc_source_identities (id,source_id,official_recall_number,canonical_url,
    canonical_notice_id,identity_status)
  values (pg_temp.id('30' || p_number), current_setting('t12.source')::uuid, p_number, v_url,
    pg_temp.id('10' || p_number), 'reconciled');
  insert into private.cpsc_notice_identity_links (notice_id,identity_id,provenance)
  values (pg_temp.id('10' || p_number), pg_temp.id('30' || p_number), 'Phase 16.12 pgTAP');
  insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,
    canonical_url,title,section_hashes,normalized_evidence,parser_version,first_seen_at,last_seen_at)
  values (pg_temp.id('40' || p_number), pg_temp.id('30' || p_number), p_hash, p_number, v_url,
    'Recall ' || p_key, '{}', jsonb_build_object('recallNumber', p_number, 'canonicalUrl', v_url,
      'title', 'Recall ' || p_key), 'phase-16.11-structured-v1',
    now() - interval '2 hours', now() - interval '2 hours');
end $$;

-- Worker proposal against the recall's current revision.
create function pg_temp.propose(p_number text, p_kind text, p_value jsonb, p_row text, p_field text,
  p_scoped boolean default true)
returns uuid language plpgsql as $$
declare v_id uuid; r private.cpsc_page_revisions%rowtype;
begin
  select * into r from private.cpsc_page_revisions where identity_id = pg_temp.id('30' || p_number)
    and private.cpsc_revision_is_current(id);
  perform pg_temp.act('service_role');
  select (public.propose_cpsc_candidate_criterion(r.id,
    case when p_scoped then pg_temp.id('20' || p_number) end,
    jsonb_build_object('source','cpsc','recallNumber',r.recall_number,'canonicalUrl',r.canonical_url,
      'sourceSemanticRevision',r.evidence_hash,'sectionIdentity','description',
      'tableIdentity','t-' || p_number,'rowIdentity',p_row,'fieldIdentity',p_field),
    encode(sha256(convert_to(p_number || p_row, 'UTF8')), 'hex'), p_kind, p_value,
    't-' || p_number || '/' || p_row, p_row || ' excerpt', 'phase-16.11-structured-v1')->>'candidateId')::uuid
  into v_id;
  perform pg_temp.done();
  return v_id;
end $$;

create function pg_temp.decide(p_candidate uuid, p_reviewer text, p_decision text default 'reviewed')
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  perform pg_temp.act('authenticated', p_reviewer);
  v_id := public.decide_cpsc_candidate(p_candidate, p_decision, p_decision = 'reviewed', 'pgTAP');
  perform pg_temp.done();
  return v_id;
end $$;

create function pg_temp.materialize(p_candidate uuid, p_reviewer text default '01')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act('authenticated', p_reviewer);
  v := public.materialize_cpsc_reviewed_conjunction(p_candidate);
  perform pg_temp.done();
  return v;
end $$;

create function pg_temp.envelope(p_number text) returns jsonb language sql as $$
  select reviewed_criteria from public.get_recall_v2_scopes(pg_temp.id('10' || p_number))
  where scope_id = pg_temp.id('20' || p_number);
$$;

-- ===========================================================================
-- Historical backfill (runs first, so its counts cover only its own history)
-- ===========================================================================
insert into public.recall_notices (id,source_id,external_id,title,recall_date,official_url,
  retrieved_at,raw_payload)
values
  (pg_temp.id('5001'),current_setting('t12.source')::uuid,'30001','BF One','2026-09-10',
   'https://www.cpsc.gov/Recalls/2026/BF-One',now() - interval '3 days','{"RecallID":30001,"RecallNumber":"26-901"}'),
  (pg_temp.id('5002'),current_setting('t12.source')::uuid,'30004','BF One','2026-09-10',
   'https://cpsc.gov/Recalls/2026/BF-One',now() - interval '3 days','{"RecallID":30004,"RecallNumber":"26901"}'),
  (pg_temp.id('5003'),current_setting('t12.source')::uuid,'30002','BF Two','2026-09-11',
   'https://www.cpsc.gov/Recalls/2026/BF-Two',now() - interval '3 days','{"RecallID":30002,"RecallNumber":"26902"}'),
  (pg_temp.id('5004'),current_setting('t12.source')::uuid,'30003','BF Three','2026-09-12',
   'https://www.cpsc.gov/Recalls/2026/BF-Three',now() - interval '3 days','{"RecallID":30003,"RecallNumber":"26903"}');
insert into public.recall_scopes (recall_notice_id,product_name)
select id, 'Backfill product' from public.recall_notices where id in
  (pg_temp.id('5001'),pg_temp.id('5002'),pg_temp.id('5003'),pg_temp.id('5004'));
create temporary table t12_history as
  select n.*, (select jsonb_agg(to_jsonb(s) order by s.id) from public.recall_scopes s
    where s.recall_notice_id = n.id) scopes
  from public.recall_notices n
  where n.id in (pg_temp.id('5001'),pg_temp.id('5002'),pg_temp.id('5003'),pg_temp.id('5004'));

-- Before the backfill: the live gate never duplicates or hijacks unlinked history.
select pg_temp.act('service_role');
select extensions.is(public.record_cpsc_identity_observation('30002','26902',
  'https://www.cpsc.gov/Recalls/2026/BF-Two','https://www.cpsc.gov/Recalls/2026/BF-Two','BF Two',
  '2026-09-11',repeat('a',64),now(),'pgTAP pre-backfill')->>'status', 'quarantined',
  'before backfill: a stored numeric ID of unlinked history quarantines');
select extensions.is(public.record_cpsc_identity_observation('30102','26902',
  'https://www.cpsc.gov/Recalls/2026/BF-Two','https://www.cpsc.gov/Recalls/2026/BF-Two','BF Two',
  '2026-09-11',repeat('a',64),now(),'pgTAP pre-backfill')->>'decisionClass', 'X_unlinked_history',
  'before backfill: a new API ID for an unlinked historical number quarantines');
select pg_temp.done();
select extensions.is((select count(*) from private.cpsc_source_identities
  where official_recall_number in ('26901','26902','26903')), 0::bigint,
  'before backfill: no identity is created for historical numbers');

select set_config('t12.manifest', jsonb_build_object(
  'manifestVersion','phase-16.12-cpsc-backfill-v1',
  'pages', jsonb_build_array(
    jsonb_build_object('recallNumber','26901','canonicalUrl','https://www.cpsc.gov/Recalls/2026/BF-One',
      'evidenceHash',repeat('1',64),'rawPageHash',repeat('2',64),'parserVersion','phase-16.9-v1',
      'fetchedAt','2026-09-20T00:00:00Z','sectionHashes','{}'::jsonb,
      'normalizedEvidence',jsonb_build_object('recallNumber','26901',
        'canonicalUrl','https://www.cpsc.gov/Recalls/2026/BF-One','title','BF One')),
    jsonb_build_object('recallNumber','26902','canonicalUrl','https://www.cpsc.gov/Recalls/2026/BF-Two',
      'evidenceHash',repeat('3',64),'rawPageHash',repeat('4',64),'parserVersion','phase-16.9-v1',
      'fetchedAt','2026-09-20T00:00:00Z','sectionHashes','{}'::jsonb,
      'normalizedEvidence',jsonb_build_object('recallNumber','26902',
        'canonicalUrl','https://www.cpsc.gov/Recalls/2026/BF-Two','title','BF Two'))),
  'currentObservations', jsonb_build_array(
    jsonb_build_object('apiId','30001','recallNumber','26901',
      'observedUrl','https://www.cpsc.gov/Recalls/2026/BF-One','title','BF One',
      'publicationDate','2026-09-10','payloadHash',repeat('5',64),'observedAt','2026-09-21T00:00:00Z'),
    jsonb_build_object('apiId','30003','recallNumber','26902',
      'observedUrl','https://cpsc.gov/Recalls/2026/BF-Two','title','BF Two',
      'publicationDate','2026-09-11','payloadHash',repeat('6',64),'observedAt','2026-09-21T00:00:00Z'),
    jsonb_build_object('apiId','30005','recallNumber','26903',
      'observedUrl','https://www.cpsc.gov/Recalls/2026/BF-Three','title','BF Three',
      'publicationDate','2026-09-12','payloadHash',repeat('7',64),'observedAt','2026-09-21T00:00:00Z'))
)::text, true);

select extensions.throws_ok($$select private.cpsc_historical_backfill(
  current_setting('t12.manifest')::jsonb,'observations',false,'pgTAP',500)$$,
  null, 'Backfill structure stage is incomplete', 'observations cannot precede the structure stage');
select extensions.throws_ok($$select private.cpsc_historical_backfill(
  '{"manifestVersion":"other","pages":[],"currentObservations":[]}','structure',false,'pgTAP',500)$$,
  null, 'Invalid CPSC backfill manifest', 'manifest version is enforced');

select set_config('t12.dry', private.cpsc_historical_backfill(
  current_setting('t12.manifest')::jsonb,'structure',false,'pgTAP dry run',500)::text, true);
select extensions.is(current_setting('t12.dry')::jsonb->'counts', jsonb_build_object(
  'identitiesCreated',3,'linksCreated',4,'aliasesCreated',8,'apiRevisionsCreated',4,
  'pageRevisionsCreated',2,'pageFetchesCreated',2,'noticesWithoutRecallNumber',0),
  'dry run reports identities, links, aliases, revisions, and fetches to create');
select extensions.is(current_setting('t12.dry')::jsonb->'duplicateGroups',
  '[{"recallNumber":"26901","notices":2}]'::jsonb, 'dry run reports the duplicate group');
select extensions.ok((current_setting('t12.dry')::jsonb->>'persisted')::boolean is false
  and (current_setting('t12.dry')::jsonb->>'unexpectedConflicts')::integer = 0,
  'dry run persisted nothing and found no unexpected conflict');
select extensions.is((select count(*) from private.cpsc_source_identities
  where official_recall_number in ('26901','26902','26903'))
  + (select count(*) from private.cpsc_backfill_runs), 0::bigint, 'dry run left no rows behind');

select set_config('t12.s1', private.cpsc_historical_backfill(
  current_setting('t12.manifest')::jsonb,'structure',true,'pgTAP structure',500)::text, true);
select extensions.is(current_setting('t12.s1')::jsonb->'counts', current_setting('t12.dry')::jsonb->'counts',
  'execution matches its dry run exactly');
select extensions.ok(exists (select 1 from private.cpsc_source_identities i
  join public.recall_notices n on n.id = i.canonical_notice_id
  where i.official_recall_number = '26901' and n.external_id = '30001'),
  'duplicate group keeps the earliest API ID notice as canonical');
select extensions.is((select count(*) from private.cpsc_notice_identity_links l
  join private.cpsc_source_identities i on i.id = l.identity_id
  where i.official_recall_number = '26901'), 2::bigint, 'duplicate notices are linked, not merged');
select set_config('t12.s2', private.cpsc_historical_backfill(
  current_setting('t12.manifest')::jsonb,'structure',true,'pgTAP structure replay',500)::text, true);
select extensions.is((current_setting('t12.s2')::jsonb->>'newRows')::integer, 0,
  'second structure run creates nothing');
select extensions.is(current_setting('t12.s2')::jsonb->'counts', jsonb_build_object(
  'identitiesReused',3,'linksReused',4,'aliasesReused',8,'apiRevisionsReused',4,
  'pageRevisionsReused',2,'pageFetchesReused',2,'noticesWithoutRecallNumber',0),
  'second structure run reuses every row');
select extensions.is(current_setting('t12.s2')::jsonb->>'canonicalIdentityDigest',
  current_setting('t12.s1')::jsonb->>'canonicalIdentityDigest', 'canonical fingerprint is stable');

select set_config('t12.od', private.cpsc_historical_backfill(
  current_setting('t12.manifest')::jsonb,'observations',false,'pgTAP obs dry run',500)::text, true);
select extensions.is(current_setting('t12.od')::jsonb->'decisionClasses',
  '{"A_known_alias":5,"B_new_alias":1,"D_api_id_reuse":1}'::jsonb,
  'observation dry run reports the real gate decisions');
select extensions.is((select count(*) from private.cpsc_identity_observations
  where provenance like 'Phase 16.12 historical backfill%'), 0::bigint,
  'observation dry run persisted nothing');
select set_config('t12.o1', private.cpsc_historical_backfill(
  current_setting('t12.manifest')::jsonb,'observations',true,'pgTAP observations',500)::text, true);
select extensions.is((current_setting('t12.o1')::jsonb->>'collisions')::integer, 1,
  'the reused numeric ID is quarantined');
select extensions.is(current_setting('t12.o1')::jsonb->'quarantines',
  '[{"kind":"current","apiId":"30003","recallNumber":"26902","decisionClass":"D_api_id_reuse"}]'::jsonb,
  'quarantine names the colliding observation');
select extensions.is((current_setting('t12.o1')::jsonb->>'driftRows')::integer, 3, 'drift rows are counted');
select set_config('t12.o2', private.cpsc_historical_backfill(
  current_setting('t12.manifest')::jsonb,'observations',true,'pgTAP observations replay',500)::text, true);
select extensions.is((current_setting('t12.o2')::jsonb->>'newRows')::integer, 0,
  'second observation run records nothing');
select extensions.is((current_setting('t12.o2')::jsonb#>>'{counts,observationsAlreadyRecorded}')::integer, 7,
  'second observation run recognizes all seven recorded observations');
select extensions.is((select count(*) from private.cpsc_identity_reconciliations), 0::bigint,
  'backfill never reconciles automatically');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger)
  + (select count(*) from private.recall_scope_rule_sets_v2), 0::bigint,
  'backfill never creates a review or a matcher rule set');
select extensions.ok(not exists (select 1 from t12_history h join public.recall_notices n on n.id = h.id
  where to_jsonb(h) - 'scopes' is distinct from to_jsonb(n)
    or h.scopes is distinct from (select jsonb_agg(to_jsonb(s) order by s.id) from public.recall_scopes s
      where s.recall_notice_id = n.id)), 'backfill rewrote no historical notice or scope');

-- After the backfill: the live gate resolves history and still quarantines reuse.
select pg_temp.act('service_role');
select extensions.is(public.record_cpsc_identity_observation('30002','26902',
  'https://www.cpsc.gov/Recalls/2026/BF-Two','https://www.cpsc.gov/Recalls/2026/BF-Two','BF Two',
  '2026-09-11',repeat('a',64),now(),'pgTAP post-backfill')->>'decisionClass', 'A_known_alias',
  'after backfill: historical API ID resolves to its own recall');
select extensions.is(public.record_cpsc_identity_observation('30003','26902',
  'https://www.cpsc.gov/Recalls/2026/BF-Two','https://www.cpsc.gov/Recalls/2026/BF-Two','BF Two',
  '2026-09-11',repeat('a',64),now(),'pgTAP post-backfill')->>'status', 'quarantined',
  'after backfill: reused numeric ID still quarantines (no silent bypass)');
select extensions.is(public.record_cpsc_identity_observation('30009','26909',
  'https://www.cpsc.gov/Recalls/2026/BF-New','https://www.cpsc.gov/Recalls/2026/BF-New','BF New',
  '2026-09-22',repeat('a',64),now(),'pgTAP post-backfill')->>'decisionClass', 'C_new_identity',
  'after backfill: a genuinely new recall still creates its identity');
select pg_temp.done();
select extensions.is((select count(*) from public.recall_notices
  where private.cpsc_payload_recall_number(raw_payload) in ('26901','26902','26903')), 4::bigint,
  'no historical notice duplicated');

-- Retraction removes only a structure run's own rows, and only while nothing depends on them.
select extensions.throws_ok(format($$select private.cpsc_backfill_retract(%L,'pgTAP')$$,
  current_setting('t12.s1')::jsonb->>'runId'), null, null,
  'a structure run is not retractable once observations depend on it');
insert into public.recall_notices (id,source_id,external_id,title,recall_date,official_url,
  retrieved_at,raw_payload)
values (pg_temp.id('5005'),current_setting('t12.source')::uuid,'30006','BF Four','2026-09-13',
  'https://www.cpsc.gov/Recalls/2026/BF-Four',now() - interval '3 days','{"RecallID":30006,"RecallNumber":"26904"}');
select set_config('t12.s3', private.cpsc_historical_backfill(
  current_setting('t12.manifest')::jsonb,'structure',true,'pgTAP late notice',500)::text, true);
select extensions.is((current_setting('t12.s3')::jsonb->>'newRows')::integer, 5,
  'late history creates one identity, one link, and its aliases and API revision');
select extensions.is((private.cpsc_backfill_retract((current_setting('t12.s3')::jsonb->>'runId')::uuid,
  'pgTAP rollback rehearsal')->>'rowsRemoved')::integer, 5, 'structure run retracts its own rows');
select extensions.ok(not exists (select 1 from private.cpsc_source_identities
  where official_recall_number = '26904')
  and exists (select 1 from public.recall_notices where id = pg_temp.id('5005') and external_id = '30006'),
  'retraction removed the identity but not the historical notice');
select extensions.is((private.cpsc_historical_backfill(current_setting('t12.manifest')::jsonb,
  'structure',true,'pgTAP after retraction',500)->>'newRows')::integer, 5,
  'a retracted run can be executed again');
select extensions.is((select count(*) from private.cpsc_backfill_runs where retracted_at is not null),
  1::bigint, 'retraction is recorded, not erased');
select extensions.is((private.cpsc_historical_backfill(current_setting('t12.manifest')::jsonb,
  'structure',true,'pgTAP bounded',1)->>'newRows')::integer, 0, 'bounded run on complete state is a no-op');

-- ===========================================================================
-- Char-Broil: nine authoritative associations become nine rule sets
-- ===========================================================================
select pg_temp.recall('CharBroil','26773',
  'd37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667');
update private.cpsc_source_identities
  set canonical_url = 'https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock'
  where id = pg_temp.id('3026773');
update public.recall_notices
  set official_url = 'https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock'
  where id = pg_temp.id('1026773');
delete from private.cpsc_page_revisions where id = pg_temp.id('4026773');
insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,canonical_url,
  title,section_hashes,normalized_evidence,parser_version,first_seen_at,last_seen_at,table_identities)
values (pg_temp.id('4026773'), pg_temp.id('3026773'),
  'd37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667','26773',
  'https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock',
  'Char-Broil Recalls Bistro Pro Electric Grills Due to Risk of Electric Shock','{}',
  jsonb_build_object('recallNumber','26773','canonicalUrl',
    'https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock',
    'title','Char-Broil Recalls Bistro Pro Electric Grills Due to Risk of Electric Shock'),
  'phase-16.11-structured-v1', now() - interval '2 hours', now() - interval '2 hours',
  '[{"identity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","rows":[{"identity":"94493055367286a25d054be93cdd078defff54c83466101565570297a261fabb","evidence":["Bistro Pro\u2122 Electric Grill & Griddle + Charcoal Mode Black","25302145"]},{"identity":"e61218ab39ecccb87269f595b042b9f653873afd76fa4a7141825366b7b28f0a","evidence":["Bistro Pro\u2122 Electric Grill & Griddle + Charcoal Mode Red","25302146"]},{"identity":"94245b2eefe002535a2ee8f393c12f3a2bc185323e81dc351d550f5b6c49d431","evidence":["Bistro Pro\u2122 Electric Grill + Charcoal Mode Blackout","25302147"]},{"identity":"ed70e1c846b4fd22dc267e36eacab58aeda21283981b38e9b8394e2beb12b7f9","evidence":["Bistro Pro\u2122 Electric Grill + Charcoal Mode Black","25302148"]},{"identity":"4a6cc5be45760f9774c1b4281a02e428a6a832c03eca6b2b6d38f24a0eb92e68","evidence":["Bistro Pro\u2122 Tabletop Electric Grill Black","25302149"]},{"identity":"5f832aaf587748a80e518f9979fd7634b377574b634605891d75f7a33c512b4b","evidence":["Bistro Pro\u2122 Tabletop Electric Grill Red","25302150"]},{"identity":"6eaad3c9ce9220f8852d7d4ae7581918a78ccc513f9726ae3094ca56a1f30940","evidence":["Bistro Pro\u2122 Electric Grill & Griddle + Charcoal Mode Black with Cover","25302151"]},{"identity":"6427cf1e40f7a51b53aa0b6ede9e7f48812d43442989067cc0923e4d10d1ad58","evidence":["Bistro Pro\u2122 Electric Grill & Griddle + Charcoal Mode Red with cover","25302159"]},{"identity":"ef15f29f28d9be689e938438a1a4292084ed5d96e96b57ef77b8ed69ecb4be42","evidence":["Bistro Pro\u2122 Electric Grill & Griddle + Charcoal Mode Emerald with cover","25302163"]}]}]'::jsonb);

-- Exactly the 18 proposals the production TS extractor derives from the frozen page.
create temporary table t12_cb (ord integer primary key, kind text, value jsonb, conjunction_key text,
  address jsonb, excerpt text, candidate_id uuid);
insert into t12_cb (ord, kind, value, conjunction_key, address, excerpt) values
  (1,'model_exact','"25302145"'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/94493055367286a25d054be93cdd078defff54c83466101565570297a261fabb','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"model no","rowIdentity":"94493055367286a25d054be93cdd078defff54c83466101565570297a261fabb","evidenceFingerprint":"66b72dc2f500e6040cc12866a8f143c1be57b3c63a7e25c3dd8474c6a1a8fb0b"}'::jsonb,'Bistro Pro™ Electric Grill & Griddle + Charcoal Mode Black | 25302145'),
  (2,'date_code_set','["2510","2511","2512"]'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/94493055367286a25d054be93cdd078defff54c83466101565570297a261fabb','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"date codes","rowIdentity":"94493055367286a25d054be93cdd078defff54c83466101565570297a261fabb","evidenceFingerprint":"66b72dc2f500e6040cc12866a8f143c1be57b3c63a7e25c3dd8474c6a1a8fb0b"}'::jsonb,'Only Bistro Pro Electric Grills with date codes of 2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025) are included in this recall.'),
  (3,'model_exact','"25302146"'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/e61218ab39ecccb87269f595b042b9f653873afd76fa4a7141825366b7b28f0a','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"model no","rowIdentity":"e61218ab39ecccb87269f595b042b9f653873afd76fa4a7141825366b7b28f0a","evidenceFingerprint":"751c305a7b7d3fcd7639f0a25ac450cd41d580e06498300dc6304bc546b37901"}'::jsonb,'Bistro Pro™ Electric Grill & Griddle + Charcoal Mode Red | 25302146'),
  (4,'date_code_set','["2510","2511","2512"]'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/e61218ab39ecccb87269f595b042b9f653873afd76fa4a7141825366b7b28f0a','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"date codes","rowIdentity":"e61218ab39ecccb87269f595b042b9f653873afd76fa4a7141825366b7b28f0a","evidenceFingerprint":"751c305a7b7d3fcd7639f0a25ac450cd41d580e06498300dc6304bc546b37901"}'::jsonb,'Only Bistro Pro Electric Grills with date codes of 2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025) are included in this recall.'),
  (5,'model_exact','"25302147"'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/94245b2eefe002535a2ee8f393c12f3a2bc185323e81dc351d550f5b6c49d431','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"model no","rowIdentity":"94245b2eefe002535a2ee8f393c12f3a2bc185323e81dc351d550f5b6c49d431","evidenceFingerprint":"00db048927d4a9ab170b336068cbcd7158dd39f6ce48d224a6e439f0db9c0350"}'::jsonb,'Bistro Pro™ Electric Grill + Charcoal Mode Blackout | 25302147'),
  (6,'date_code_set','["2510","2511","2512"]'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/94245b2eefe002535a2ee8f393c12f3a2bc185323e81dc351d550f5b6c49d431','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"date codes","rowIdentity":"94245b2eefe002535a2ee8f393c12f3a2bc185323e81dc351d550f5b6c49d431","evidenceFingerprint":"00db048927d4a9ab170b336068cbcd7158dd39f6ce48d224a6e439f0db9c0350"}'::jsonb,'Only Bistro Pro Electric Grills with date codes of 2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025) are included in this recall.'),
  (7,'model_exact','"25302148"'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/ed70e1c846b4fd22dc267e36eacab58aeda21283981b38e9b8394e2beb12b7f9','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"model no","rowIdentity":"ed70e1c846b4fd22dc267e36eacab58aeda21283981b38e9b8394e2beb12b7f9","evidenceFingerprint":"32bf5509e0264f47ddec3fa8d6d3ca9c27a5beb276aa7b9280be35ad458a2625"}'::jsonb,'Bistro Pro™ Electric Grill + Charcoal Mode Black | 25302148'),
  (8,'date_code_set','["2510","2511","2512"]'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/ed70e1c846b4fd22dc267e36eacab58aeda21283981b38e9b8394e2beb12b7f9','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"date codes","rowIdentity":"ed70e1c846b4fd22dc267e36eacab58aeda21283981b38e9b8394e2beb12b7f9","evidenceFingerprint":"32bf5509e0264f47ddec3fa8d6d3ca9c27a5beb276aa7b9280be35ad458a2625"}'::jsonb,'Only Bistro Pro Electric Grills with date codes of 2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025) are included in this recall.'),
  (9,'model_exact','"25302149"'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/4a6cc5be45760f9774c1b4281a02e428a6a832c03eca6b2b6d38f24a0eb92e68','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"model no","rowIdentity":"4a6cc5be45760f9774c1b4281a02e428a6a832c03eca6b2b6d38f24a0eb92e68","evidenceFingerprint":"58bf7e5738e0278ca59733a7a4b254ac6e15b49e0d229003af71e82f82ad0896"}'::jsonb,'Bistro Pro™ Tabletop Electric Grill Black | 25302149'),
  (10,'date_code_set','["2510","2511","2512"]'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/4a6cc5be45760f9774c1b4281a02e428a6a832c03eca6b2b6d38f24a0eb92e68','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"date codes","rowIdentity":"4a6cc5be45760f9774c1b4281a02e428a6a832c03eca6b2b6d38f24a0eb92e68","evidenceFingerprint":"58bf7e5738e0278ca59733a7a4b254ac6e15b49e0d229003af71e82f82ad0896"}'::jsonb,'Only Bistro Pro Electric Grills with date codes of 2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025) are included in this recall.'),
  (11,'model_exact','"25302150"'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/5f832aaf587748a80e518f9979fd7634b377574b634605891d75f7a33c512b4b','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"model no","rowIdentity":"5f832aaf587748a80e518f9979fd7634b377574b634605891d75f7a33c512b4b","evidenceFingerprint":"5c7fbbcd1900d110b2e69757de8a44a6023771666719cb7e1e7ef897331fb446"}'::jsonb,'Bistro Pro™ Tabletop Electric Grill Red | 25302150'),
  (12,'date_code_set','["2510","2511","2512"]'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/5f832aaf587748a80e518f9979fd7634b377574b634605891d75f7a33c512b4b','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"date codes","rowIdentity":"5f832aaf587748a80e518f9979fd7634b377574b634605891d75f7a33c512b4b","evidenceFingerprint":"5c7fbbcd1900d110b2e69757de8a44a6023771666719cb7e1e7ef897331fb446"}'::jsonb,'Only Bistro Pro Electric Grills with date codes of 2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025) are included in this recall.'),
  (13,'model_exact','"25302151"'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/6eaad3c9ce9220f8852d7d4ae7581918a78ccc513f9726ae3094ca56a1f30940','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"model no","rowIdentity":"6eaad3c9ce9220f8852d7d4ae7581918a78ccc513f9726ae3094ca56a1f30940","evidenceFingerprint":"cb3489b00be64ccdb3887c31e06c967fc7e7665f9d891472d6e33e8412cb7e14"}'::jsonb,'Bistro Pro™ Electric Grill & Griddle + Charcoal Mode Black with Cover | 25302151'),
  (14,'date_code_set','["2510","2511","2512"]'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/6eaad3c9ce9220f8852d7d4ae7581918a78ccc513f9726ae3094ca56a1f30940','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"date codes","rowIdentity":"6eaad3c9ce9220f8852d7d4ae7581918a78ccc513f9726ae3094ca56a1f30940","evidenceFingerprint":"cb3489b00be64ccdb3887c31e06c967fc7e7665f9d891472d6e33e8412cb7e14"}'::jsonb,'Only Bistro Pro Electric Grills with date codes of 2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025) are included in this recall.'),
  (15,'model_exact','"25302159"'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/6427cf1e40f7a51b53aa0b6ede9e7f48812d43442989067cc0923e4d10d1ad58','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"model no","rowIdentity":"6427cf1e40f7a51b53aa0b6ede9e7f48812d43442989067cc0923e4d10d1ad58","evidenceFingerprint":"a6e096ab985f8c89727bb1afbfb5760c7875391c194b434c742d8466ab2b800e"}'::jsonb,'Bistro Pro™ Electric Grill & Griddle + Charcoal Mode Red with cover | 25302159'),
  (16,'date_code_set','["2510","2511","2512"]'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/6427cf1e40f7a51b53aa0b6ede9e7f48812d43442989067cc0923e4d10d1ad58','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"date codes","rowIdentity":"6427cf1e40f7a51b53aa0b6ede9e7f48812d43442989067cc0923e4d10d1ad58","evidenceFingerprint":"a6e096ab985f8c89727bb1afbfb5760c7875391c194b434c742d8466ab2b800e"}'::jsonb,'Only Bistro Pro Electric Grills with date codes of 2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025) are included in this recall.'),
  (17,'model_exact','"25302163"'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/ef15f29f28d9be689e938438a1a4292084ed5d96e96b57ef77b8ed69ecb4be42','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"model no","rowIdentity":"ef15f29f28d9be689e938438a1a4292084ed5d96e96b57ef77b8ed69ecb4be42","evidenceFingerprint":"e8b9985d21a2c3ad4188179a16a0217f6b98b0b4d093661acc0a1ffc19554d6d"}'::jsonb,'Bistro Pro™ Electric Grill & Griddle + Charcoal Mode Emerald with cover | 25302163'),
  (18,'date_code_set','["2510","2511","2512"]'::jsonb,'description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/ef15f29f28d9be689e938438a1a4292084ed5d96e96b57ef77b8ed69ecb4be42','{"source":"cpsc","recallNumber":"26773","canonicalUrl":"https://www.cpsc.gov/Recalls/2026/Char-Broil-Recalls-Bistro-Pro-Electric-Grills-Due-to-Risk-of-Electric-Shock","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","sectionIdentity":"description","tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","fieldIdentity":"date codes","rowIdentity":"ef15f29f28d9be689e938438a1a4292084ed5d96e96b57ef77b8ed69ecb4be42","evidenceFingerprint":"e8b9985d21a2c3ad4188179a16a0217f6b98b0b4d093661acc0a1ffc19554d6d"}'::jsonb,'Only Bistro Pro Electric Grills with date codes of 2510 (Oct-2025), 2511 (Nov-2025) and 2512 (Dec-2025) are included in this recall.');
select pg_temp.act('service_role');
update t12_cb set candidate_id = (public.propose_cpsc_candidate_criterion(pg_temp.id('4026773'),
  pg_temp.id('2026773'), address, address->>'evidenceFingerprint', kind, value, conjunction_key,
  excerpt, 'phase-16.11-structured-v1')->>'candidateId')::uuid;
select pg_temp.done();
select extensions.is((select count(distinct candidate_id) from t12_cb), 18::bigint,
  'worker records 18 unreviewed Char-Broil members');
select extensions.is((select count(distinct conjunction_key) from t12_cb), 9::bigint,
  'the 18 members form 9 conjunctions');

select pg_temp.act('authenticated','01');
select set_config('t12.packet', public.get_cpsc_candidate_review_packet(
  (select candidate_id from t12_cb where ord = 3))::text, true);
select pg_temp.done();
select extensions.is((current_setting('t12.packet')::jsonb#>>'{ruleSetPresentation,ruleSetCount}')::integer, 9,
  'reviewer packet shows nine rule sets');
select extensions.is(current_setting('t12.packet')::jsonb#>>'{ruleSetPresentation,semantics}',
  'OR between rule sets; AND inside each rule set', 'packet states OR between, AND inside');
select extensions.ok((select bool_and(jsonb_array_length(rs->'members') = 2 and rs->>'insideRuleSet' = 'AND'
    and (rs->'members'->0->>'kind') = 'model_exact' and (rs->'members'->1->>'kind') = 'date_code_set')
  from jsonb_array_elements(current_setting('t12.packet')::jsonb#>'{ruleSetPresentation,ruleSets}') rs),
  'every rule set pairs exactly one model with its date-code set');
select extensions.is((select count(*) from jsonb_array_elements(
  current_setting('t12.packet')::jsonb#>'{ruleSetPresentation,ruleSets}') rs
  where (rs->>'containsThisCandidate')::boolean), 1::bigint,
  'packet marks the one rule set the candidate belongs to');
select extensions.is((select array_agg(rs->'members'->0->>'value' order by (rs->>'ruleSetNumber')::integer)
  from jsonb_array_elements(current_setting('t12.packet')::jsonb#>'{ruleSetPresentation,ruleSets}') rs),
  array['25302145','25302146','25302147','25302148','25302149','25302150','25302151',
    '25302159','25302163'], 'rule sets are numbered in authoritative table order');

select pg_temp.decide(candidate_id, '01') from t12_cb order by ord;
create temporary table t12_cb_materialized as
  select c.ord, pg_temp.materialize(c.candidate_id)->>'status' as status
  from t12_cb c where c.kind = 'model_exact';
select extensions.is((select count(*) from t12_cb_materialized where status = 'materialized'),
  9::bigint, 'nine independent rule sets materialize on one scope');
select extensions.is((select count(*) from t12_cb c
  where (pg_temp.materialize(c.candidate_id)->>'status') = 'unchanged'), 18::bigint,
  'materialization is idempotent from either member');

-- Phase 16.13: a complete coverage claim also requires the worker's source-coverage
-- ledger (the production TS ledger for the frozen page, recomputed by SQL).
select pg_temp.act('service_role');
select set_config('t12.cb_ledger', public.record_cpsc_page_coverage(pg_temp.id('4026773'),
  '{"schema":"cpsc_source_coverage_v1","ledgerVersion":"phase-16.13-coverage-v1","parserVersion":"phase-16.13-structured-v2","extractorVersion":"phase-16.11-html-v1","censusVersion":"phase-16.13-census-v1","sourceSemanticRevision":"d37c79b398c6a8a99cdd4197665e46d5deefd71a112689d6961538689667e667","structures":[{"structureId":"description/prose","kind":"prose","sectionIdentity":"description","tableIndex":null,"tableIdentity":null,"authoritativeRecordCount":5,"anomalies":[],"records":[{"ordinal":0,"recordIdentity":"db11dbad41226bc459374a72c5f9720865f804c31b35dd3600eb422dbffb7bfe","rowIdentity":null,"disposition":"ignored_non_safety","effect":"none","relation":null,"reason":"no eligibility content","cells":[],"extraction":"extracted"},{"ordinal":1,"recordIdentity":"7402a5af65261aae5499621e51562e92ceae85db127fe6b88d15d26a2a7d93c5","rowIdentity":null,"disposition":"ignored_non_safety","effect":"none","relation":null,"reason":"no eligibility content","cells":[],"extraction":"extracted"},{"ordinal":2,"recordIdentity":"3b3014db48405b4cb6b37bd6322af2e220ec14668bd8fa2ea0a7df9b08439097","rowIdentity":null,"disposition":"ignored_non_safety","effect":"none","relation":null,"reason":"no eligibility content","cells":[],"extraction":"extracted"},{"ordinal":3,"recordIdentity":"df06b56f3930a53f6b41dd1e17a6ea6b2b9b5c3d8c1996f56145e7ad34b70ee3","rowIdentity":null,"disposition":"ignored_non_safety","effect":"none","relation":null,"reason":"no eligibility content","cells":[],"extraction":"extracted"},{"ordinal":4,"recordIdentity":"0d7d3412f3ae53d68b79126a7520617fa50fe90e28bacb1a40ebc1bc9ab124bd","rowIdentity":null,"disposition":"parsed_reviewable","effect":"none","relation":"governs:description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","reason":"date-code restriction governing one model table","cells":[],"extraction":"extracted"}]},{"structureId":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","kind":"table","sectionIdentity":"description","tableIndex":0,"tableIdentity":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978","authoritativeRecordCount":9,"anomalies":[],"records":[{"ordinal":0,"recordIdentity":"94493055367286a25d054be93cdd078defff54c83466101565570297a261fabb","rowIdentity":"94493055367286a25d054be93cdd078defff54c83466101565570297a261fabb","disposition":"parsed_reviewable","effect":"none","relation":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/94493055367286a25d054be93cdd078defff54c83466101565570297a261fabb","reason":"model conjunction","cells":[{"column":"model description","criterionClass":"descriptive","status":"descriptive"},{"column":"model no","criterionClass":"model","status":"recognized"}],"extraction":"extracted"},{"ordinal":1,"recordIdentity":"e61218ab39ecccb87269f595b042b9f653873afd76fa4a7141825366b7b28f0a","rowIdentity":"e61218ab39ecccb87269f595b042b9f653873afd76fa4a7141825366b7b28f0a","disposition":"parsed_reviewable","effect":"none","relation":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/e61218ab39ecccb87269f595b042b9f653873afd76fa4a7141825366b7b28f0a","reason":"model conjunction","cells":[{"column":"model description","criterionClass":"descriptive","status":"descriptive"},{"column":"model no","criterionClass":"model","status":"recognized"}],"extraction":"extracted"},{"ordinal":2,"recordIdentity":"94245b2eefe002535a2ee8f393c12f3a2bc185323e81dc351d550f5b6c49d431","rowIdentity":"94245b2eefe002535a2ee8f393c12f3a2bc185323e81dc351d550f5b6c49d431","disposition":"parsed_reviewable","effect":"none","relation":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/94245b2eefe002535a2ee8f393c12f3a2bc185323e81dc351d550f5b6c49d431","reason":"model conjunction","cells":[{"column":"model description","criterionClass":"descriptive","status":"descriptive"},{"column":"model no","criterionClass":"model","status":"recognized"}],"extraction":"extracted"},{"ordinal":3,"recordIdentity":"ed70e1c846b4fd22dc267e36eacab58aeda21283981b38e9b8394e2beb12b7f9","rowIdentity":"ed70e1c846b4fd22dc267e36eacab58aeda21283981b38e9b8394e2beb12b7f9","disposition":"parsed_reviewable","effect":"none","relation":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/ed70e1c846b4fd22dc267e36eacab58aeda21283981b38e9b8394e2beb12b7f9","reason":"model conjunction","cells":[{"column":"model description","criterionClass":"descriptive","status":"descriptive"},{"column":"model no","criterionClass":"model","status":"recognized"}],"extraction":"extracted"},{"ordinal":4,"recordIdentity":"4a6cc5be45760f9774c1b4281a02e428a6a832c03eca6b2b6d38f24a0eb92e68","rowIdentity":"4a6cc5be45760f9774c1b4281a02e428a6a832c03eca6b2b6d38f24a0eb92e68","disposition":"parsed_reviewable","effect":"none","relation":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/4a6cc5be45760f9774c1b4281a02e428a6a832c03eca6b2b6d38f24a0eb92e68","reason":"model conjunction","cells":[{"column":"model description","criterionClass":"descriptive","status":"descriptive"},{"column":"model no","criterionClass":"model","status":"recognized"}],"extraction":"extracted"},{"ordinal":5,"recordIdentity":"5f832aaf587748a80e518f9979fd7634b377574b634605891d75f7a33c512b4b","rowIdentity":"5f832aaf587748a80e518f9979fd7634b377574b634605891d75f7a33c512b4b","disposition":"parsed_reviewable","effect":"none","relation":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/5f832aaf587748a80e518f9979fd7634b377574b634605891d75f7a33c512b4b","reason":"model conjunction","cells":[{"column":"model description","criterionClass":"descriptive","status":"descriptive"},{"column":"model no","criterionClass":"model","status":"recognized"}],"extraction":"extracted"},{"ordinal":6,"recordIdentity":"6eaad3c9ce9220f8852d7d4ae7581918a78ccc513f9726ae3094ca56a1f30940","rowIdentity":"6eaad3c9ce9220f8852d7d4ae7581918a78ccc513f9726ae3094ca56a1f30940","disposition":"parsed_reviewable","effect":"none","relation":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/6eaad3c9ce9220f8852d7d4ae7581918a78ccc513f9726ae3094ca56a1f30940","reason":"model conjunction","cells":[{"column":"model description","criterionClass":"descriptive","status":"descriptive"},{"column":"model no","criterionClass":"model","status":"recognized"}],"extraction":"extracted"},{"ordinal":7,"recordIdentity":"6427cf1e40f7a51b53aa0b6ede9e7f48812d43442989067cc0923e4d10d1ad58","rowIdentity":"6427cf1e40f7a51b53aa0b6ede9e7f48812d43442989067cc0923e4d10d1ad58","disposition":"parsed_reviewable","effect":"none","relation":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/6427cf1e40f7a51b53aa0b6ede9e7f48812d43442989067cc0923e4d10d1ad58","reason":"model conjunction","cells":[{"column":"model description","criterionClass":"descriptive","status":"descriptive"},{"column":"model no","criterionClass":"model","status":"recognized"}],"extraction":"extracted"},{"ordinal":8,"recordIdentity":"ef15f29f28d9be689e938438a1a4292084ed5d96e96b57ef77b8ed69ecb4be42","rowIdentity":"ef15f29f28d9be689e938438a1a4292084ed5d96e96b57ef77b8ed69ecb4be42","disposition":"parsed_reviewable","effect":"none","relation":"description/table/0/93cf70959c23e491b80451716c1ceed65ad2d8587357960df568ac76d76aa978/ef15f29f28d9be689e938438a1a4292084ed5d96e96b57ef77b8ed69ecb4be42","reason":"model conjunction","cells":[{"column":"model description","criterionClass":"descriptive","status":"descriptive"},{"column":"model no","criterionClass":"model","status":"recognized"}],"extraction":"extracted"}]}]}'::jsonb)::text, true);
select pg_temp.done();
select extensions.is(current_setting('t12.cb_ledger')::jsonb->>'coverageFingerprint',
  'faea74e5b6a1be8861b3a79b00d76750dcc20f552e476bcb58a1f17dd563a65a',
  'SQL recomputes the TS coverage fingerprint of the Char-Broil ledger');
-- Phase 16.33: negative evidence also needs a reviewer's attestation over the
-- recall-detail sections outside the description census.
select pg_temp.act('authenticated', '01');
select public.attest_cpsc_outside_census(pg_temp.id('4026773'),
  public.get_cpsc_outside_census_packet(pg_temp.id('4026773'))->>'sectionsSha256', '[]'::jsonb,
  'pgTAP: no restriction outside the description', 1);
select pg_temp.done();
select set_config('t12.cb', pg_temp.envelope('26773')::text, true);
select extensions.is(current_setting('t12.cb')::jsonb->>'semantics', 'any_of', 'scope serves an any_of envelope');
select extensions.is(jsonb_array_length(current_setting('t12.cb')::jsonb->'ruleSets'), 9,
  'Char-Broil: 9 / 9 authoritative rule sets are usable');
select extensions.is(current_setting('t12.cb')::jsonb->'coverage'->>'complete', 'true',
  'coverage is complete when every proposed conjunction is served');
select extensions.is((select count(distinct rs#>>'{review,ruleSetFingerprint}')
  from jsonb_array_elements(current_setting('t12.cb')::jsonb->'ruleSets') rs), 9::bigint,
  'every rule set has a distinct fingerprint');
select extensions.ok((select bool_and(rs->>'semantics' = 'all_of'
    and jsonb_array_length(rs->'criteria') = 2
    and rs->'criteria' @> '[{"kind":"model_number","operator":"equals","required":true}]'
    and rs->'criteria' @> '[{"kind":"date_code","operator":"one_of","required":true,"values":["2510","2511","2512"]}]')
  from jsonb_array_elements(current_setting('t12.cb')::jsonb->'ruleSets') rs),
  'each rule set is exactly model AND date-code set (no cross-product, no flattening)');
select extensions.is((select array_agg(c->>'value' order by c->>'value')
  from jsonb_array_elements(current_setting('t12.cb')::jsonb->'ruleSets') rs,
    jsonb_array_elements(rs->'criteria') c where c->>'kind' = 'model_number'),
  array['25302145','25302146','25302147','25302148','25302149','25302150','25302151','25302159','25302163'],
  'the nine served models are exactly the authoritative rows');
select extensions.ok((select bool_and(rs#>>'{review,ruleSetFingerprint}' ~ '^[0-9a-f]{64}$'
    and rs->'review' ? 'identityFingerprint' and rs->'review' ? 'scopeSemanticFingerprint'
    and jsonb_array_length(rs#>'{review,sourceAddressHashes}') = 2)
  from jsonb_array_elements(current_setting('t12.cb')::jsonb->'ruleSets') rs),
  'rule sets carry their semantic identity inputs');

-- ===========================================================================
-- Row-paired table: a date code of one row never qualifies another row's model
-- ===========================================================================
select pg_temp.recall('Paired','26951', repeat('b',64));
select set_config('t12.pa_m', pg_temp.propose('26951','model_exact','"MODEL-A"','ra','model no')::text, true);
select set_config('t12.pa_d', pg_temp.propose('26951','date_code_exact','"2510"','ra','date code')::text, true);
select set_config('t12.pb_m', pg_temp.propose('26951','model_exact','"MODEL-B"','rb','model no')::text, true);
select set_config('t12.pb_d', pg_temp.propose('26951','date_code_exact','"2511"','rb','date code')::text, true);
select pg_temp.decide(current_setting('t12.' || k)::uuid, '01') from unnest(array['pa_m','pa_d','pb_m','pb_d']) k;
select pg_temp.materialize(current_setting('t12.pa_m')::uuid);
select pg_temp.materialize(current_setting('t12.pb_m')::uuid);
select extensions.is((select jsonb_agg(jsonb_build_object('model', m.value, 'code', d.value) order by m.value)
  from jsonb_array_elements(pg_temp.envelope('26951')->'ruleSets') rs,
    lateral (select c->>'value' value from jsonb_array_elements(rs->'criteria') c where c->>'kind' = 'model_number') m,
    lateral (select c->>'value' value from jsonb_array_elements(rs->'criteria') c where c->>'kind' = 'date_code') d),
  '[{"code":"2510","model":"MODEL-A"},{"code":"2511","model":"MODEL-B"}]'::jsonb,
  'row pairing survives: (MODEL-A AND 2510) OR (MODEL-B AND 2511)');

-- ===========================================================================
-- Incomplete rule sets never serve and never block a complete one
-- ===========================================================================
select pg_temp.recall('Incomplete','26952', repeat('c',64));
select set_config('t12.i1m', pg_temp.propose('26952','model_exact','"INC-1"','r1','model no')::text, true);
select set_config('t12.i1d', pg_temp.propose('26952','date_code_exact','"2510"','r1','date code')::text, true);
select set_config('t12.i2m', pg_temp.propose('26952','model_exact','"INC-2"','r2','model no')::text, true);
select set_config('t12.i2d', pg_temp.propose('26952','date_code_exact','"2511"','r2','date code')::text, true);
select set_config('t12.i3m', pg_temp.propose('26952','model_exact','"INC-3"','r3','model no')::text, true);
select set_config('t12.i3d', pg_temp.propose('26952','date_code_exact','"2512"','r3','date code')::text, true);
select set_config('t12.i4d', pg_temp.propose('26952','date_code_exact','"2601"','r4','date code')::text, true);
select pg_temp.decide(current_setting('t12.' || k)::uuid, '01', d)
  from (values ('i1m','reviewed'),('i1d','reviewed'),('i2m','reviewed'),('i3m','reviewed'),
    ('i3d','rejected'),('i4d','reviewed')) v(k,d);
select extensions.is(pg_temp.materialize(current_setting('t12.i1m')::uuid)->>'status', 'materialized',
  'complete rule set materializes next to incomplete siblings');
select extensions.throws_ok(format($$select pg_temp.materialize(%L)$$, current_setting('t12.i2m')),
  null, 'Conjunction is not fully human-reviewed, current, and model-anchored',
  'model reviewed + date code unreviewed is not materializable');
select extensions.throws_ok(format($$select pg_temp.materialize(%L)$$, current_setting('t12.i3m')),
  null, 'Conjunction is not fully human-reviewed, current, and model-anchored',
  'model reviewed + date code rejected is not materializable');
select extensions.throws_ok(format($$select pg_temp.materialize(%L)$$, current_setting('t12.i4d')),
  null, 'Conjunction is not fully human-reviewed, current, and model-anchored',
  'date code alone is never a rule set');
select extensions.is(jsonb_array_length(pg_temp.envelope('26952')->'ruleSets'), 1,
  'only the complete rule set is served');
-- Phase 16.13 adds sourceCoverage to the coverage object; the 16.12 fields are unchanged.
select extensions.is((pg_temp.envelope('26952')->'coverage') - 'sourceCoverage',
  jsonb_build_object('currentRevisionId', pg_temp.id('4026952'), 'proposedRuleSets', 4,
    'unattributedRuleSets', 0, 'servedRuleSets', 1, 'complete', false),
  'coverage reports the incomplete scope so no false rejection follows');
select pg_temp.propose('26952','model_exact','"INC-9"','r9','model no', false);
select extensions.is(pg_temp.envelope('26952')->'coverage'->>'unattributedRuleSets', '1',
  'an unscoped proposal keeps coverage incomplete');

-- ===========================================================================
-- Simple recalls keep a single rule set (backward compatibility)
-- ===========================================================================
select pg_temp.recall('SingleModel','26953', repeat('d',64));
select set_config('t12.sd', pg_temp.propose('26953','model_exact','"SOLO-1"','r1','model no')::text, true);
select pg_temp.decide(current_setting('t12.sd')::uuid, '02');
select pg_temp.materialize(current_setting('t12.sd')::uuid, '02');
select extensions.ok(jsonb_array_length(pg_temp.envelope('26953')->'ruleSets') = 1
  and pg_temp.envelope('26953')->'ruleSets'->0->'criteria' @> '[{"kind":"model_number","value":"SOLO-1"}]'
  -- Phase 16.13: without a recorded source-coverage ledger the rule set still
  -- serves (positive), but coverage can no longer claim completeness (negative).
  and not (pg_temp.envelope('26953')->'coverage'->>'complete')::boolean
  and pg_temp.envelope('26953')->'coverage'->'sourceCoverage'->>'state' = 'missing',
  'single model rule: one served rule set; no ledger, so no negative evidence');
select pg_temp.recall('SingleConj','26954', repeat('e',64));
select set_config('t12.se_m', pg_temp.propose('26954','model_exact','"PAIR-1"','r1','model no')::text, true);
select set_config('t12.se_d', pg_temp.propose('26954','date_code_set','["2510","2511"]','r1','date code')::text, true);
select pg_temp.decide(current_setting('t12.se_m')::uuid, '01');
select pg_temp.decide(current_setting('t12.se_d')::uuid, '01');
select set_config('t12.se_fp', pg_temp.materialize(current_setting('t12.se_m')::uuid)->>'ruleSetFingerprint', true);
select extensions.ok(jsonb_array_length(pg_temp.envelope('26954')->'ruleSets') = 1
  and jsonb_array_length(pg_temp.envelope('26954')->'ruleSets'->0->'criteria') = 2,
  'single model + date code conjunction: one rule set of two members');

-- ===========================================================================
-- Role separation
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16120000-0000-4000-8000-000000000001","sub":"16120000-0000-4000-8000-000000000001"}';
select extensions.throws_ok($$select public.invalidate_cpsc_review_decision(gen_random_uuid(),'x')$$,
  '42501', null, 'reviewer cannot revoke for cause');
select extensions.throws_ok($$select public.get_cpsc_quarantine_packet(gen_random_uuid())$$,
  '42501', null, 'reviewer cannot read quarantine evidence without the reconciliation capability');
select extensions.throws_ok($$select public.reconcile_cpsc_quarantined_observation(gen_random_uuid(),'reject_observation','x')$$,
  '42501', null, 'reviewer cannot reconcile identity');
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16120000-0000-4000-8000-000000000004","sub":"16120000-0000-4000-8000-000000000004"}';
select extensions.throws_ok(format($$select public.decide_cpsc_candidate(%L,'reviewed',true)$$,
  current_setting('t12.i2d')), '42501', null, 'reconciler cannot review criteria');
select extensions.throws_ok($$select public.invalidate_cpsc_review_decision(gen_random_uuid(),'x')$$,
  '42501', null, 'reconciler cannot revoke for cause');
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16120000-0000-4000-8000-000000000005","sub":"16120000-0000-4000-8000-000000000005"}';
select extensions.throws_ok(format($$select public.decide_cpsc_candidate(%L,'reviewed',true)$$,
  current_setting('t12.i2d')), '42501', null, 'invalidator cannot review criteria');
select extensions.throws_ok(format($$select public.materialize_cpsc_reviewed_conjunction(%L)$$,
  current_setting('t12.i1m')), '42501', null, 'invalidator cannot materialize');
select extensions.throws_ok($$select public.reconcile_cpsc_quarantined_observation(gen_random_uuid(),'reject_observation','x')$$,
  '42501', null, 'invalidator cannot reconcile identity');
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16120000-0000-4000-8000-000000000006","sub":"16120000-0000-4000-8000-000000000006"}';
select extensions.throws_ok($$select public.invalidate_cpsc_review_decision(gen_random_uuid(),'x')$$,
  '42501', null, 'consumer cannot revoke for cause');
select extensions.throws_ok($$select public.record_cpsc_notice_revision(gen_random_uuid(),null,null,null,'{}')$$,
  '42501', null, 'consumer cannot record notice revisions');
reset request.jwt.claims;
reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select extensions.throws_ok($$select public.invalidate_cpsc_review_decision(gen_random_uuid(),'x')$$,
  '42501', null, 'service_role cannot revoke for cause');
select extensions.throws_ok($$select public.invalidate_cpsc_reviewer_decisions(gen_random_uuid(),now(),now(),'x')$$,
  '42501', null, 'service_role cannot bulk revoke for cause');
select extensions.throws_ok($$select private.cpsc_historical_backfill('{}','structure',false,'x',1)$$,
  '42501', null, 'service_role cannot run the backfill');
select extensions.throws_ok($$insert into private.recall_scope_rule_sets_v2 (scope_id,rule_set_fingerprint,
  criteria_sha256,revision_id,conjunction_group,criteria,source_url) values (gen_random_uuid(),repeat('a',64),
  repeat('a',64),gen_random_uuid(),'g','{"semantics":"all_of"}','x')$$, '42501', null,
  'service_role cannot write rule sets');
reset request.jwt.claims;
reset role;

-- ===========================================================================
-- Revoke-for-cause
-- ===========================================================================
-- Ordinary prospective revocation keeps a reviewer's past decisions valid.
update private.cpsc_reviewer_authorizations set revoked_at = now() + interval '1 second'
  where user_id = pg_temp.id('00000002');
select extensions.ok(pg_temp.envelope('26953') is not null,
  'reviewer access revoked prospectively: previous decision remains valid');

select set_config('t12.cb_row1_event', (select l.id::text from private.cpsc_candidate_review_ledger l
  join t12_cb c on c.candidate_id = l.candidate_id where c.ord = 2 order by l.event_seq desc limit 1), true);
select set_config('t12.cb_row1_fp', (select rs#>>'{review,ruleSetFingerprint}'
  from jsonb_array_elements(pg_temp.envelope('26773')->'ruleSets') rs
  where rs->'criteria' @> '[{"value":"25302145"}]'), true);
select pg_temp.act('authenticated','05');
select extensions.throws_ok(format($$select public.invalidate_cpsc_review_decision(%L,'  ')$$,
  current_setting('t12.cb_row1_event')), null, 'Invalidation reason is required',
  'revoke-for-cause requires a reason');
select extensions.is(public.invalidate_cpsc_review_decision(current_setting('t12.cb_row1_event')::uuid,
  'Reviewer attested the wrong date-code table')->>'decision', 'reviewed',
  'invalidator revokes one specific decision for cause');
select extensions.throws_ok(format($$select public.invalidate_cpsc_review_decision(%L,'again')$$,
  current_setting('t12.cb_row1_event')), null, 'Decision is already invalidated',
  'a decision is invalidated once');
select extensions.throws_ok($$select public.invalidate_cpsc_review_decision(
  (select id from private.cpsc_candidate_review_ledger where decision = 'stale' limit 1),'x')$$,
  null, 'Only a human review decision can be invalidated', 'only an existing human decision can be invalidated');
select pg_temp.done();
select extensions.is(jsonb_array_length(pg_temp.envelope('26773')->'ruleSets'), 8,
  'the dependent rule set becomes unusable; the other eight stay valid');
select extensions.ok(not exists (select 1 from jsonb_array_elements(pg_temp.envelope('26773')->'ruleSets') rs
  where rs->'criteria' @> '[{"value":"25302145"}]'), 'the invalidated rule set is not served');
select extensions.is(pg_temp.envelope('26773')->'coverage'->>'complete', 'false',
  'coverage becomes incomplete after revoke-for-cause');
select extensions.throws_ok($$update private.cpsc_review_decision_invalidations set reason = 'edited'$$,
  '42501', null, 'invalidation history is append-only');
select extensions.throws_ok($$delete from private.cpsc_review_decision_invalidations$$,
  '42501', null, 'invalidation history cannot be deleted');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger l
  where l.id = current_setting('t12.cb_row1_event')::uuid), 1::bigint, 'the invalidated decision stays in history');

-- The invalidated decision is replaced by a different reviewer; identity is stable.
select extensions.throws_ok($$select pg_temp.decide((select candidate_id from t12_cb where ord = 2), '01')$$,
  null, 'A decision invalidated for cause requires a different reviewer',
  'the invalidated reviewer cannot re-decide');
select pg_temp.decide((select candidate_id from t12_cb where ord = 2), '03');
select extensions.is(pg_temp.materialize((select candidate_id from t12_cb where ord = 1), '03')->>'ruleSetFingerprint',
  current_setting('t12.cb_row1_fp'), 're-review restores the rule set with the same semantic fingerprint');
select extensions.is(jsonb_array_length(pg_temp.envelope('26773')->'ruleSets'), 9, 'all nine are usable again');
select extensions.is((select count(*) from private.recall_scope_rule_sets_v2
  where scope_id = pg_temp.id('2026773')), 10::bigint, 'the replaced binding stays as history');

-- A compromised reviewer's window is invalidated; other reviewers are untouched.
select pg_temp.act('authenticated','05');
select extensions.is((public.invalidate_cpsc_reviewer_decisions(pg_temp.id('00000002'),
  now() - interval '1 day', now() + interval '1 day', 'Reviewer account compromised')->>'invalidated')::integer,
  1, 'bulk revoke-for-cause invalidates that reviewer''s decisions');
select pg_temp.done();
select extensions.ok(pg_temp.envelope('26953') is null, 'rule sets resting on those decisions become unusable');
select extensions.ok(jsonb_array_length(pg_temp.envelope('26773')->'ruleSets') = 9
  and jsonb_array_length(pg_temp.envelope('26954')->'ruleSets') = 1,
  'unrelated reviewers'' decisions remain valid');

-- ===========================================================================
-- Page revert A -> B -> A: nothing revives; a new review restores the same identity
-- ===========================================================================
insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,canonical_url,
  title,section_hashes,normalized_evidence,parser_version,first_seen_at,last_seen_at)
select pg_temp.id('4126954'), identity_id, repeat('9',64), recall_number, canonical_url, title,
  section_hashes, normalized_evidence, parser_version, now() - interval '1 hour', now() - interval '1 hour'
from private.cpsc_page_revisions where id = pg_temp.id('4026954');
select extensions.ok(pg_temp.envelope('26954') is null, 'a material revision B makes the rule set unusable');
select pg_temp.act('service_role');
select extensions.is(public.record_cpsc_page_revision(pg_temp.id('3026954'), repeat('e',64),
  (select normalized_evidence from private.cpsc_page_revisions where id = pg_temp.id('4026954')),
  '{}','[]','phase-16.11-structured-v1')->>'status', 'reverted', 'A -> B -> A is detected');
select pg_temp.done();
select extensions.ok(pg_temp.envelope('26954') is null, 'reverting to A does not revive the old review');
select pg_temp.decide(current_setting('t12.se_m')::uuid, '01');
select pg_temp.decide(current_setting('t12.se_d')::uuid, '01');
select extensions.is(pg_temp.materialize(current_setting('t12.se_m')::uuid)->>'ruleSetFingerprint',
  current_setting('t12.se_fp'), 'a new human review on A restores the same semantic rule set');

-- ===========================================================================
-- Existing-notice revisions
-- ===========================================================================
select pg_temp.recall('Revised','26955', repeat('f',64), '{"RecallID":"40055","RecallNumber":"26955",
  "Products":[{"Name":"NR product","Model":"NR-1"}],"Manufacturers":[{"Name":"Acme Corp"}],
  "Retailers":[{"Name":"Shop"}]}');
insert into private.cpsc_source_aliases (identity_id,notice_id,alias_kind,alias_value,provenance,
  first_seen_at,last_seen_at)
values (pg_temp.id('3026955'),pg_temp.id('1026955'),'api_id','40055','pgTAP history',now(),now());
select set_config('t12.nr_m', pg_temp.propose('26955','model_exact','"NR-1"','r1','model no')::text, true);
select pg_temp.decide(current_setting('t12.nr_m')::uuid, '01');
select pg_temp.materialize(current_setting('t12.nr_m')::uuid);
create temporary table t12_nr_before as select * from public.recall_notices where id = pg_temp.id('1026955');

create function pg_temp.revise(p_title text, p_description text, p_remedy text, p_payload jsonb)
returns jsonb language plpgsql as $$
declare v_obs jsonb; v jsonb;
begin
  perform pg_temp.act('service_role');
  v_obs := public.record_cpsc_identity_observation('40055','26955',
    'https://www.cpsc.gov/Recalls/2026/P1612-Revised','https://www.cpsc.gov/Recalls/2026/P1612-Revised',
    p_title,'2026-09-20',repeat('a',64),now(),'pgTAP revision');
  v := public.record_cpsc_notice_revision((v_obs->>'observationId')::uuid, p_description, 'Hazard',
    p_remedy, p_payload) || jsonb_build_object('observationId', v_obs->>'observationId',
    'identityId', v_obs->>'identityId', 'flags', v_obs->'revisionFlags');
  perform pg_temp.done();
  return v;
end $$;
select set_config('t12.nr_payload', '{"RecallID":"40055","RecallNumber":"26955","Products":[{"Name":"NR product","Model":"NR-1"}],"Manufacturers":[{"Name":"Acme Corp"}],"Retailers":[{"Name":"Shop"}]}', true);

select extensions.is(pg_temp.revise('Recall Revised','Desc','Refund',
  current_setting('t12.nr_payload')::jsonb)->>'status', 'unchanged',
  'identical content records only the historical baseline');
select extensions.is((select array_agg(origin) from private.cpsc_notice_revisions
  where identity_id = pg_temp.id('3026955')), array['historical_baseline'], 'baseline captured once');
select extensions.is(pg_temp.revise('  Recall   Revised ',E'Desc\n','Refund ',
  current_setting('t12.nr_payload')::jsonb)->>'status', 'unchanged',
  'formatting-only change creates no revision');
select extensions.is(pg_temp.revise('Recall Revised','Desc','Refund',
  jsonb_set(current_setting('t12.nr_payload')::jsonb,'{Retailers}','[{"Name":"Other shop"}]'))->>'status',
  'unchanged', 'payload metadata outside safety content creates no revision');
select set_config('t12.nr_title', pg_temp.revise('Recall Revised (Corrected)','Desc','Refund',
  current_setting('t12.nr_payload')::jsonb)::text, true);
select extensions.is(current_setting('t12.nr_title')::jsonb->>'status', 'created', 'title correction creates a revision');
select extensions.is(current_setting('t12.nr_title')::jsonb->'changedFields', '["title"]'::jsonb,
  'title correction is attributed to the title');
select extensions.is(current_setting('t12.nr_title')::jsonb->>'identityId', pg_temp.id('3026955')::text,
  'title correction keeps the same canonical identity');
select extensions.ok((current_setting('t12.nr_title')::jsonb->'flags') ? 'title_revised',
  'the identity observation flags the title revision');
select set_config('t12.nr_remedy', pg_temp.revise('Recall Revised (Corrected)','Desc','Refund or free repair',
  current_setting('t12.nr_payload')::jsonb)::text, true);
select extensions.is(current_setting('t12.nr_remedy')::jsonb->'changedFields', '["remedy"]'::jsonb,
  'remedy correction creates a new revision');
select extensions.is(current_setting('t12.nr_remedy')::jsonb->>'supersedesRevisionId',
  current_setting('t12.nr_title')::jsonb->>'revisionId', 'revisions chain; the previous one is preserved');
select extensions.ok(pg_temp.envelope('26955') is not null, 'title and remedy corrections do not stale criteria');
select pg_temp.act('service_role');
select extensions.is(public.record_cpsc_notice_revision(
  (current_setting('t12.nr_remedy')::jsonb->>'observationId')::uuid,'Desc','Hazard','Refund or free repair',
  current_setting('t12.nr_payload')::jsonb)->>'revisionId', current_setting('t12.nr_remedy')::jsonb->>'revisionId',
  'recording the same observation again is idempotent');
select set_config('t12.nr_current', public.get_cpsc_current_notice_revision(pg_temp.id('1026955'))::text, true);
select pg_temp.done();
select extensions.ok((current_setting('t12.nr_current')::jsonb->>'title') = 'Recall Revised (Corrected)'
  and (current_setting('t12.nr_current')::jsonb->>'remedy') = 'Refund or free repair'
  and (current_setting('t12.nr_current')::jsonb->>'revisionCount')::integer = 3,
  'current read identifies the latest authoritative revision');
select extensions.ok(not exists (select 1 from t12_nr_before b join public.recall_notices n on n.id = b.id
  where to_jsonb(n) is distinct from to_jsonb(b)), 'the historical notice row is never overwritten');
select extensions.is((select count(*) from public.recall_notices where external_id like 'cpsc:26955%'),
  1::bigint, 'no duplicate recall is created');
select set_config('t12.nr_ident', pg_temp.revise('Recall Revised (Corrected)','Desc','Refund or free repair',
  jsonb_set(current_setting('t12.nr_payload')::jsonb,'{Products}','[{"Name":"NR product","Model":"NR-2"}]'))::text, true);
select extensions.ok((current_setting('t12.nr_ident')::jsonb->>'identifierChanged')::boolean
  and (current_setting('t12.nr_ident')::jsonb->>'staledReviews')::integer = 1,
  'an identifier change is a revision that stales the identity''s reviews');
select extensions.ok(pg_temp.envelope('26955') is null, 'the staled criterion is no longer served');
select extensions.throws_ok($$update private.cpsc_notice_revisions set title = 'x'$$, '42501', null,
  'notice revisions are append-only');

-- Conjunction change on the official page stales the paired rule sets.
select pg_temp.act('service_role');
select extensions.is(public.record_cpsc_page_revision(pg_temp.id('3026951'), repeat('8',64),
  (select normalized_evidence from private.cpsc_page_revisions where id = pg_temp.id('4026951')),
  '{}','[]','phase-16.11-structured-v1')->>'status', 'created', 'a changed date-code pairing is a new revision');
select pg_temp.done();
select extensions.ok(pg_temp.envelope('26951') is null, 'conjunction change stales every paired rule set');

-- ===========================================================================
-- The superseded single-binding table accepts no writes, even from the owner
-- ===========================================================================
select extensions.throws_ok($$insert into private.recall_scope_criteria_v2 (scope_id,criteria,
  reviewed_at,source_url,origin,revision_id,conjunction_group) values (pg_temp.id('2026773'),
  '{"semantics":"all_of","criteria":[{}]}',now(),'x','human_review_ledger',pg_temp.id('4026773'),'g')$$,
  '42501', null, 'legacy single-binding writes are refused');
select extensions.throws_ok($$delete from private.recall_scope_rule_sets_v2$$, '42501', null,
  'rule sets cannot be deleted');
select extensions.throws_ok($$select public.approve_cpsc_product_model_criterion_v2(gen_random_uuid(),0,'x','y',repeat('a',64))$$,
  '42501', null, 'the retired approval stays retired');

-- ===========================================================================
-- Production-state isolation
-- ===========================================================================
select extensions.is((select count(*) from private.recall_match_evaluations_v2)
  + (select count(*) from private.recall_alert_eligibility_v2)
  + (select count(*) from private.recall_alert_snapshots_v2), 0::bigint,
  'no v2 evaluation, eligibility, or alert was created');

select extensions.finish();
rollback;
