-- Phase 16.30 production-safe rollback-only suite for the Phase 16.29 contracts.
-- Kept outside supabase/tests (it needs the real production manifest state).
-- Run only through scripts/run-remote-pgtap.mjs from the repository root, after
-- the 16.29 migration and BEFORE the production manifest import. The final
-- ROLLBACK removes the transient pgTAP install, every fixture, and the in-suite
-- rehearsal of the manifest import. No page is fetched: SQL has no network path.
--
-- Production identities are never claimed. Every claim uses limit 1 and every
-- claimable fixture sorts strictly first (no work state => next_attempt_at
-- -infinity, and 1800/1900 first_seen_at against a real minimum of 2026-09-26).
-- The suite asserts that no non-fixture attempt or work state appeared, that the
-- historical Intertex attempt is unchanged, and that the real 26777 hold is never
-- resolved. Recall 26777 is only observed, never reconciled or cleared.
begin;
set local role postgres;
set local search_path = extensions, public, auth;
select extensions.no_plan();
-- Test-only access to pgTAP and digest helpers rolls back with the fixture.
grant usage on schema extensions to cpsc_page_worker;
\set manifest `cat docs/phase-16-15-backfill-manifest.json`
\set manifest_file_sha `shasum -a 256 docs/phase-16-15-backfill-manifest.json | cut -c1-64`
select set_config('p1630.manifest', :'manifest', true);
select set_config('p1630.manifest_file_sha', :'manifest_file_sha', true);
create function pg_temp.manifest() returns jsonb language sql stable as $$
  select current_setting('p1630.manifest')::jsonb;
$$;

-- This suite rehearses the one-shot import, so it refuses a post-import database.
do $$
begin
  if exists (select 1 from private.cpsc_backfill_page_hold_imports) then
    raise exception 'Phase 16.30 remote suite must run before the production manifest import';
  end if;
end $$;

-- Pre-fixture production baselines, compared as deltas rather than absolutes.
select set_config('p1630.base', jsonb_build_object(
  'attempts', (select count(*) from private.cpsc_page_attempts),
  'work', (select count(*) from private.cpsc_page_work_state),
  'revisions', (select count(*) from private.cpsc_page_revisions),
  'fetches', (select count(*) from private.cpsc_page_fetches),
  'raw', (select count(*) from private.cpsc_page_raw_payloads),
  'ledgers', (select count(*) from private.cpsc_page_coverage_ledgers),
  'snapshots', (select count(*) from private.cpsc_page_structural_snapshots),
  'candidates', (select count(*) from private.cpsc_candidate_criteria),
  'review_ledger', (select count(*) from private.cpsc_candidate_review_ledger),
  'reconciliations', (select count(*) from private.cpsc_identity_reconciliations),
  'holds', (select count(*) from private.cpsc_page_identity_holds),
  'resolutions', (select count(*) from private.cpsc_page_identity_hold_resolutions),
  'matches', (select count(*) from public.recall_matches),
  'alerts', (select count(*) from public.alerts),
  'push', (select count(*) from private.push_alert_queue),
  'criteria_v2', (select count(*) from private.recall_scope_criteria_v2),
  'rule_sets_v2', (select count(*) from private.recall_scope_rule_sets_v2),
  'evals_v2', (select count(*) from private.recall_match_evaluations_v2))::text, true);
select set_config('p1630.fp', jsonb_build_object(
  'identities', (select md5(string_agg(x::text, E'\n' order by x.id)) from private.cpsc_source_identities x),
  'aliases', (select md5(string_agg(x::text, E'\n' order by x.id)) from private.cpsc_source_aliases x),
  'observations', (select md5(string_agg(x::text, E'\n' order by x.id)) from private.cpsc_identity_observations x),
  'links', (select md5(string_agg(x::text, E'\n' order by x.notice_id, x.identity_id)) from private.cpsc_notice_identity_links x),
  'notices', (select md5(string_agg(x::text, E'\n' order by x.id)) from public.recall_notices x),
  'attempts', (select md5(string_agg(x::text, E'\n' order by x.id)) from private.cpsc_page_attempts x),
  'work', (select md5(string_agg(x::text, E'\n' order by x.identity_id)) from private.cpsc_page_work_state x),
  'sync', (select md5(string_agg(x::text, E'\n' order by x.source_id)) from private.recall_source_sync_state x),
  'automation', (select md5(string_agg(x::text, E'\n')) from private.recall_automation_state x),
  'old_attempt', (select md5(a::text) from private.cpsc_page_attempts a
    where a.id = '0bf98d4e-9c4b-42ce-a430-d20bfe97ac84'))::text, true);
create function pg_temp.base(k text) returns bigint language sql stable as $$
  select (current_setting('p1630.base')::jsonb->>k)::bigint;
$$;
create function pg_temp.fp(k text) returns text language sql stable as $$
  select current_setting('p1630.fp')::jsonb->>k;
$$;
create function pg_temp.is_fixture(p uuid) returns boolean language sql stable as $$
  select exists (select 1 from private.cpsc_source_identities i
    where i.id = p and i.official_recall_number between '29100' and '29199');
$$;

-- ===========================================================================
-- Catalog, RLS, and authorization matrix.
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
select extensions.ok(not has_function_privilege(r, f, 'EXECUTE'),
  format('%s cannot execute %s', r, f))
from unnest(array['anon','authenticated','service_role']) r,
  unnest(array['public.claim_cpsc_page_evidence(integer)',
    'public.commit_cpsc_page_evidence_verified(uuid,jsonb,jsonb,jsonb,jsonb,bytea)']) f;
select extensions.is((select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','private') and p.prosecdef
    and p.prorettype <> 'trigger'::regtype
    and has_function_privilege('cpsc_page_worker', p.oid, 'EXECUTE')),
  array['claim_cpsc_page_evidence(integer)',
    'commit_cpsc_page_evidence_verified(uuid,jsonb,jsonb,jsonb,jsonb,bytea)',
    'finish_cpsc_page_attempt(uuid,text,integer,text,text,text)',
    'retain_cpsc_page_transport(uuid,jsonb,bytea)'],
  'dedicated worker still executes exactly the four reviewed page RPCs');
select extensions.ok(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public','private') and c.relkind in ('r','p')
    and (has_table_privilege('cpsc_page_worker', c.oid, 'INSERT')
      or has_table_privilege('cpsc_page_worker', c.oid, 'UPDATE')
      or has_table_privilege('cpsc_page_worker', c.oid, 'DELETE')
      or has_table_privilege('cpsc_page_worker', c.oid, 'TRUNCATE'))),
  'dedicated worker has no direct table write privilege');
select extensions.ok(exists (select 1 from pg_trigger
  where tgname = 'cpsc_hold_page_identity_redirect'
    and tgrelid = 'private.cpsc_page_attempts'::regclass and tgenabled = 'O'),
  'identity redirect hold trigger is installed and enabled');

-- ===========================================================================
-- Installed state before import: every backfilled identity fails closed.
-- ===========================================================================
select extensions.ok((select count(*) > 0 from private.cpsc_source_identities),
  'production identities are present');
select extensions.is((select count(*) from private.cpsc_page_identity_eligibility
  where 'backfill_page_provenance_unverified' = any(blockers)),
  (select count(*) from private.cpsc_page_identity_eligibility),
  'every production identity is blocked by unverified backfill provenance before import');
select extensions.is((select count(*) from private.cpsc_page_identity_eligibility
  where page_eligibility = 'eligible'), 0::bigint, 'no production identity is page-eligible');
set local role cpsc_page_worker;
select set_config('p1630.pre_claim', (select count(*)::text
  from public.claim_cpsc_page_evidence(10)), true);
reset role;
select extensions.is(current_setting('p1630.pre_claim'), '0',
  'the real claim returns nothing before the import');

-- ===========================================================================
-- Rehearsal of the one-shot hash-verified manifest import (rolled back).
-- ===========================================================================
select extensions.is(current_setting('p1630.manifest_file_sha'),
  'e3ab192c397fa1a50ac5e34595358a7fe02a873e26c8891197d46c659487d9ed',
  'manifest file bytes are the reviewed 16.15 manifest');
select extensions.is(private.cpsc_canonical_json_sha256(pg_temp.manifest()),
  'a8bce170402bc3470d73b4a338ea9f6da5df01e16d76429f8142496b6c273c3c',
  'manifest canonical hash is the reviewed full hash');
select extensions.ok(exists (select 1 from private.cpsc_backfill_runs r
  where r.manifest_sha256 = private.cpsc_canonical_json_sha256(pg_temp.manifest())
    and r.finished_at is not null and r.retracted_at is null),
  'manifest hash equals an executed, unretracted production backfill run');
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
  'a manifest altered in any byte of meaning cannot be imported (hash check)');
select set_config('p1630.import', private.cpsc_import_backfill_page_holds(
  pg_temp.manifest())::text, true);
select extensions.diag('rehearsed import report: ' || current_setting('p1630.import'));
select extensions.is((current_setting('p1630.import')::jsonb->>'unresolvedCount')::integer,
  jsonb_array_length(pg_temp.manifest()->'unresolvedIdentities'),
  'import examines every manifest unresolved identity');
select extensions.is((current_setting('p1630.import')::jsonb->>'holdsCreated')::integer,
  jsonb_array_length(pg_temp.manifest()->'unresolvedIdentities'),
  'import records one hold per unresolved identity');
select extensions.is(current_setting('p1630.import')::jsonb->'backfillRunSeqs',
  (select jsonb_agg(run_seq order by run_seq) from private.cpsc_backfill_runs
    where manifest_sha256 = private.cpsc_canonical_json_sha256(pg_temp.manifest())
      and finished_at is not null and retracted_at is null),
  'import binds the executed backfill runs of this manifest');
select extensions.throws_ok($$select private.cpsc_import_backfill_page_holds(pg_temp.manifest())$$,
  null, 'Backfill manifest page holds were already imported', 'import is one-shot');
select extensions.ok((select bool_and(h.evidence_sha256 = private.cpsc_canonical_json_sha256(h.evidence)
    and h.hold_class = 'backfill_manifest_unresolved_identity')
  from private.cpsc_page_identity_holds h), 'imported hold evidence is DB-hashed');

-- General reason accounting, computed independently of the blocker function.
create function pg_temp.held_numbers() returns setof text language sql stable as $$
  select e->>'recallNumber' from jsonb_array_elements(pg_temp.manifest()->'unresolvedIdentities') e;
$$;
create function pg_temp.unresolved_quarantine(p uuid) returns boolean language sql stable as $$
  select exists (select 1 from private.cpsc_source_identities i
    join private.cpsc_identity_observations o on o.resolution = 'quarantined'
      and (o.identity_id = i.id or o.official_recall_number = i.official_recall_number
        or o.canonical_url = i.canonical_url)
    where i.id = p and not exists (select 1 from private.cpsc_identity_reconciliations r
      where r.observation_id = o.id));
$$;
select extensions.is((select count(*) from private.cpsc_page_identity_eligibility
  where 'backfill_page_provenance_unverified' = any(blockers)), 0::bigint,
  'no identity keeps unverified backfill provenance after the import');
select extensions.is((select coalesce(array_agg(distinct b order by b), '{}')
  from private.cpsc_page_identity_eligibility, unnest(blockers) b),
  (select coalesce(array_agg(distinct b order by b), '{}') from unnest(array[
    case when exists (select 1 from private.cpsc_source_identities i
      where i.official_recall_number in (select pg_temp.held_numbers()))
      then 'human_reconciliation_required' end,
    case when exists (select 1 from private.cpsc_source_identities i
      where pg_temp.unresolved_quarantine(i.id)) then 'unresolved_quarantine' end]) b
    where b is not null),
  'the only remaining reasons are manifest holds and unresolved quarantines');
select extensions.ok((select bool_and(('human_reconciliation_required' = any(e.blockers))
    = (e.official_recall_number in (select pg_temp.held_numbers())))
  from private.cpsc_page_identity_eligibility e),
  'exactly the manifest-held identities require human page reconciliation');
select extensions.ok((select bool_and(('unresolved_quarantine' = any(e.blockers))
    = pg_temp.unresolved_quarantine(e.identity_id))
  from private.cpsc_page_identity_eligibility e),
  'exactly the identities with unresolved quarantines are quarantine-blocked');
select extensions.diag('rehearsed post-import eligibility: ' || (select string_agg(
  format('%s=%s', page_eligibility, n), ', ' order by page_eligibility) from (
  select page_eligibility, count(*) n from private.cpsc_page_identity_eligibility
  group by 1) q));
-- Expected Phase 16.29 rehearsal state (validation only; nothing above uses it).
select extensions.is((select count(*) from private.cpsc_page_identity_eligibility
  where page_eligibility = 'eligible'), 31::bigint, 'rehearsal: 31 identities eligible');
select extensions.is((select array_agg(official_recall_number order by official_recall_number)
  from private.cpsc_page_identity_eligibility where blockers = array['human_reconciliation_required']),
  array['26777'], 'rehearsal: 26777 alone requires human page reconciliation');
select extensions.is((select array_agg(official_recall_number order by official_recall_number)
  from private.cpsc_page_identity_eligibility where blockers = array['unresolved_quarantine']),
  array['26749','26753','26754','26756','26763','26766'],
  'rehearsal: the six D_api_id_reuse identities stay quarantine-blocked');
select extensions.is((select blockers from private.cpsc_page_identity_eligibility
  where official_recall_number = '20163'), '{}'::text[], 'rehearsal: 20163 is eligible');
select extensions.is((select md5(string_agg(x::text, E'\n' order by x.id))
  from private.cpsc_source_identities x), pg_temp.fp('identities'),
  'import changes no identity (26777 included)');
select extensions.is((select md5(string_agg(x::text, E'\n' order by x.id))
  from private.cpsc_source_aliases x), pg_temp.fp('aliases'), 'import changes no alias');
select extensions.is((select md5(string_agg(x::text, E'\n' order by x.id))
  from private.cpsc_identity_observations x), pg_temp.fp('observations'),
  'import changes no observation');
select extensions.is((select count(*) from private.cpsc_identity_reconciliations),
  pg_temp.base('reconciliations'), 'import creates no reconciliation');
select extensions.is((select count(*) from private.cpsc_page_identity_hold_resolutions), 0::bigint,
  'import clears no hold');
select extensions.diag('rehearsed natural order: ' || (select string_agg(
  format('%s:%s', pos, official_recall_number), ' ' order by pos) from (
  select row_number() over (order by coalesce(w.next_attempt_at, '-infinity'::timestamptz),
      coalesce(w.last_success_at, w.last_attempt_at, i.first_seen_at),
      i.official_recall_number) pos, i.official_recall_number
  from private.cpsc_source_identities i
  left join private.cpsc_page_work_state w on w.identity_id = i.id
  where private.cpsc_page_identity_eligible(i.id)) q));

-- ===========================================================================
-- Fixtures (directly created, no backfill items), sorting before production.
-- ===========================================================================
select set_config('p1630.source', public.ensure_cpsc_recall_source()::text, true);
create function pg_temp.identity(p_number text, p_url text, p_first timestamptz,
  p_payload_number text default null)
returns uuid language plpgsql as $$
declare v_notice uuid := gen_random_uuid(); v_identity uuid := gen_random_uuid();
begin
  insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
    recall_date,official_url,retrieved_at,raw_payload)
  values (v_notice, current_setting('p1630.source')::uuid, 'cpsc:' || p_number,
    'P1630 ' || p_number, 'Description', 'Hazard', 'Refund', '2026-09-20', p_url, now(),
    jsonb_build_object('RecallNumber', coalesce(p_payload_number, p_number)));
  insert into private.cpsc_source_identities (id,source_id,official_recall_number,
    canonical_url,canonical_notice_id,identity_status,first_seen_at,last_seen_at)
  values (v_identity, current_setting('p1630.source')::uuid, p_number, p_url, v_notice,
    'reconciled', p_first, p_first);
  insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance)
  values (v_notice, v_identity, 'Phase 16.30 remote pgTAP');
  return v_identity;
end;
$$;
select set_config('p1630.a', pg_temp.identity('29101',
  'https://www.cpsc.gov/Recalls/2026/P1630-Ordinary', '1900-01-01 00:00:09+00')::text, true);
select set_config('p1630.q', pg_temp.identity('29102',
  'https://www.cpsc.gov/Recalls/2026/P1630-Quarantine', '1900-01-01 00:00:01+00')::text, true);
select set_config('p1630.u', pg_temp.identity('29103',
  'https://www.cpsc.gov/Recalls/2026/P1630-Lineage', '1900-01-01 00:00:02+00')::text, true);
select set_config('p1630.v', pg_temp.identity('29104',
  'https://www.cpsc.gov/Recalls/2026/P1630-Moved', '1900-01-01 00:00:03+00')::text, true);
select set_config('p1630.m', pg_temp.identity('29106',
  'https://www.cpsc.gov/Recalls/2026/P1630-Mismatch', '1900-01-01 00:00:04+00', '29160')::text, true);
select set_config('p1630.f', pg_temp.identity('29107',
  'https://www.cpsc.gov/Recalls/2026/P1630-Forged', '1900-01-01 00:00:05+00')::text, true);
select set_config('p1630.r', pg_temp.identity('29105',
  'https://www.cpsc.gov/Recalls/2026/P1630-Redirect', '1800-01-01 00:00:00+00')::text, true);

select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.a')::uuid),
  '{}'::text[], 'ordinary directly reconciled safe identity is eligible');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.m')::uuid),
  array['canonical_notice_inconsistent'],
  'canonical notice with a different official recall number is ineligible');
select extensions.is(private.cpsc_page_identity_blockers('16300000-0000-4000-8000-0000000009ff'),
  array['identity_missing'], 'unknown identity fails closed');

-- Unresolved quarantine: a reused API id held by 29101 is observed for 29102.
insert into private.cpsc_source_aliases (identity_id, notice_id, alias_kind, alias_value,
  provenance, first_seen_at, last_seen_at)
select current_setting('p1630.a')::uuid, canonical_notice_id, 'api_id', '99101',
  'Phase 16.30 remote pgTAP alias', now(), now()
from private.cpsc_source_identities where id = current_setting('p1630.a')::uuid;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('p1630.q_obs', public.record_cpsc_identity_observation('99101', '29102',
  'https://www.cpsc.gov/Recalls/2026/P1630-Quarantine',
  'https://www.cpsc.gov/Recalls/2026/P1630-Quarantine', 'P1630 29102', '2026-09-20',
  repeat('c', 64), now(), 'Phase 16.30 remote pgTAP')::text, true);
select set_config('p1630.v_obs', public.record_cpsc_identity_observation('99104', '29104',
  'https://www.cpsc.gov/Recalls/2026/P1630-Moved-Elsewhere',
  'https://www.cpsc.gov/Recalls/2026/P1630-Moved-Elsewhere', 'P1630 29104', '2026-09-20',
  repeat('d', 64), now(), 'Phase 16.30 remote pgTAP')::text, true);
select set_config('request.jwt.claims', '', true);
select extensions.is(current_setting('p1630.q_obs')::jsonb->>'decisionClass', 'D_api_id_reuse',
  'reused API id is quarantined by the real identity gate');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.q')::uuid),
  array['unresolved_quarantine'], 'unresolved quarantine is ineligible');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.a')::uuid),
  '{}'::text[], 'the alias owner of the reused API id is not over-blocked');
select extensions.is(current_setting('p1630.v_obs')::jsonb->>'decisionClass', 'E_url_changed',
  'canonical URL change is quarantined by the real identity gate');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.v')::uuid),
  array['unresolved_quarantine', 'url_lineage_conflict'],
  'unresolved observation URL conflict is ineligible');

-- URL lineage conflict: a second linked notice points elsewhere.
insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
  recall_date,official_url,retrieved_at,raw_payload)
values ('16300000-0000-4000-8000-000000000301', current_setting('p1630.source')::uuid,
  'cpsc:29103-b', 'P1630 29103', 'Description', 'Hazard', 'Refund', '2026-09-20',
  'https://www.cpsc.gov/Recalls/2026/P1630-Lineage-Hazard', now(), '{"RecallNumber":"29103"}');
insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance)
values ('16300000-0000-4000-8000-000000000301', current_setting('p1630.u')::uuid,
  'Phase 16.30 remote pgTAP');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.u')::uuid),
  array['url_lineage_conflict'], 'unreconciled URL lineage conflict is ineligible');

-- A free-text "human reconciliation" marker is not provenance.
insert into private.cpsc_source_aliases (identity_id, notice_id, alias_kind, alias_value,
  provenance, first_seen_at, last_seen_at)
select current_setting('p1630.f')::uuid, canonical_notice_id, 'official_url',
  'https://www.cpsc.gov/Recalls/2026/P1630-Forged-Elsewhere',
  'human reconciliation 00000000-0000-0000-0000-000000000000', now(), now()
from private.cpsc_source_identities where id = current_setting('p1630.f')::uuid;
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.f')::uuid),
  array['url_lineage_conflict'],
  'free-text "human reconciliation" alias provenance adds a conflict, never clearance');

-- ===========================================================================
-- Identity-changing redirect (the 16.29 worker maps canonical-link
-- contradictions to identity_redirect/canonical_link_mismatch) creates a hold.
-- ===========================================================================
set local role cpsc_page_worker;
select set_config('p1630.r_claim', (select claim_id::text
  from public.claim_cpsc_page_evidence(1)), true);
reset role;
select extensions.ok((select identity_id = current_setting('p1630.r')::uuid
  from private.cpsc_page_attempts where id = current_setting('p1630.r_claim')::uuid),
  'first claim takes the earliest eligible fixture, not production');
set local role cpsc_page_worker;
select public.finish_cpsc_page_attempt(current_setting('p1630.r_claim')::uuid,
  'identity_redirect', 200, 'https://www.cpsc.gov/Recalls/2026/P1630-Redirect',
  repeat('e', 64), 'canonical_link_mismatch');
reset role;
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.r')::uuid),
  array['human_reconciliation_required'],
  'canonical-link identity redirect without human reconciliation is ineligible');
select extensions.ok((select hold_class = 'worker_identity_redirect'
    and evidence->>'errorCode' = 'canonical_link_mismatch'
    and evidence->>'attemptId' = current_setting('p1630.r_claim')
    and evidence_sha256 = private.cpsc_canonical_json_sha256(evidence)
  from private.cpsc_page_identity_holds where origin_attempt_id = current_setting('p1630.r_claim')::uuid),
  'redirect hold binds the attempt evidence with a DB-computed hash');
select set_config('p1630.hold_r', (select id::text from private.cpsc_page_identity_holds
  where origin_attempt_id = current_setting('p1630.r_claim')::uuid), true);
-- Make the held identity due again; it must still not be claimed.
update private.cpsc_page_work_state set next_attempt_at = '-infinity'
  where identity_id = current_setting('p1630.r')::uuid;
select extensions.throws_ok(format($$insert into private.cpsc_page_identity_holds
  (identity_id, official_recall_number, hold_class, origin_attempt_id, evidence, evidence_sha256)
  values (%L, '29101', 'worker_identity_redirect', %L, '{}', repeat('0',64))$$,
  current_setting('p1630.a'), current_setting('p1630.r_claim')),
  null, 'CPSC page hold does not match its identity redirect attempt',
  'a worker-class hold must bind a real redirect attempt of its identity');

-- ===========================================================================
-- Claim fairness: ineligible identities that sort earlier are skipped, and the
-- next eligible fixture is taken (no starvation). Still never production.
-- ===========================================================================
set local role cpsc_page_worker;
select set_config('p1630.c1_claim', c.claim_id::text, true),
  set_config('p1630.c1', c.official_recall_number, true)
from public.claim_cpsc_page_evidence(1) c;
reset role;
select extensions.is(current_setting('p1630.c1'), '29101',
  'claim skips earlier-sorting ineligible fixtures and takes the next eligible one');
select extensions.is((select count(*) from private.cpsc_page_attempts a
  where a.identity_id in (current_setting('p1630.q')::uuid, current_setting('p1630.u')::uuid,
    current_setting('p1630.v')::uuid, current_setting('p1630.m')::uuid,
    current_setting('p1630.f')::uuid)), 0::bigint,
  'ineligible fixtures have no attempts');
select extensions.is((select count(*) from private.cpsc_page_attempts a
  where a.identity_id = current_setting('p1630.r')::uuid), 1::bigint,
  'the due redirect-held fixture was not claimed again');

-- Final semantic commit re-checks eligibility for a flag landing mid-claim.
create function pg_temp.raw_a() returns bytea language sql immutable as $$
  select convert_to('<html><body>Phase 16.30 transport</body></html>', 'UTF8');
$$;
create function pg_temp.snapshot_a() returns jsonb language sql stable as $$
  select jsonb_build_object('canonicalUrl', 'https://www.cpsc.gov/Recalls/2026/P1630-Ordinary',
    'finalUrl', 'https://www.cpsc.gov/Recalls/2026/P1630-Ordinary', 'httpStatus', 200,
    'fetchedAt', now(), 'rawPageHash', encode(extensions.digest(pg_temp.raw_a(), 'sha256'), 'hex'),
    'contentType', 'text/html; charset=utf-8', 'etag', null, 'lastModified', null,
    'redirectChain', '[]'::jsonb);
$$;
set local role cpsc_page_worker;
select public.retain_cpsc_page_transport(current_setting('p1630.c1_claim')::uuid,
  pg_temp.snapshot_a(), pg_temp.raw_a());
reset role;
update private.cpsc_page_work_state set manual_review_required = true
  where identity_id = current_setting('p1630.a')::uuid;
set local role cpsc_page_worker;
select extensions.throws_ok(format($$select public.commit_cpsc_page_evidence_verified(%L,
  %L::jsonb, jsonb_build_object('parserVersion', 'phase-16.13-structured-v2',
    'normalized', jsonb_build_object('tables', '[]'::jsonb)), '[]'::jsonb, '{}'::jsonb, %L::bytea)$$,
  current_setting('p1630.c1_claim'), pg_temp.snapshot_a(), pg_temp.raw_a()),
  null, 'CPSC page identity is not eligible for unattended evidence',
  'final semantic commit re-checks page eligibility');
reset role;
select extensions.is((select count(*) from private.cpsc_page_revisions), pg_temp.base('revisions'),
  'ineligible commit binds no semantic revision');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.a')::uuid),
  array['manual_review_required'], 'manual review flag is an eligibility blocker');

-- ===========================================================================
-- Authorization: nobody but an identity_reconciliation holder clears a hold.
-- ===========================================================================
insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id::uuid,'authenticated','authenticated',email,'','2099-01-01','{}','{}',now(),now()
from (values
  ('16300000-0000-4000-8000-000000000901','p1630-reconciler@example.test'),
  ('16300000-0000-4000-8000-000000000902','p1630-criterion-reviewer@example.test'),
  ('16300000-0000-4000-8000-000000000903','p1630-consumer@example.test')) u(id,email);
insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason)
values ('16300000-0000-4000-8000-000000000901','identity_reconciliation',
  now() - interval '1 hour','Phase 16.30 remote pgTAP reconciler');
insert into private.cpsc_reviewer_authorizations (user_id, reason)
values ('16300000-0000-4000-8000-000000000902','Phase 16.30 remote pgTAP criterion reviewer');

select extensions.throws_ok(format($$insert into private.cpsc_page_identity_hold_resolutions
  (hold_id, decision, reviewer_user_id, rationale, evidence_snapshot, evidence_sha256)
  values (%L, 'clear_page_hold', '16300000-0000-4000-8000-000000000901',
  'owner forgery with a real reviewer id', '{}', repeat('0',64))$$,
  current_setting('p1630.hold_r')), '42501', null,
  'owner cannot forge a resolution with a real reviewer id');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select extensions.throws_ok(format($$select public.resolve_cpsc_page_identity_hold(%L,
  'clear_page_hold', 'service bypass')$$, current_setting('p1630.hold_r')),
  '42501', null, 'service_role cannot clear a page hold');
select extensions.throws_ok($$select public.reconcile_cpsc_quarantined_observation(
  (current_setting('p1630.q_obs')::jsonb->>'observationId')::uuid,
  'reject_observation', 'service bypass')$$,
  '42501', null, 'service_role cannot fake a human reconciliation');
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select extensions.throws_ok(format($$select public.resolve_cpsc_page_identity_hold(%L,
  'clear_page_hold', 'anon attempt')$$, current_setting('p1630.hold_r')),
  '42501', null, 'anon cannot clear a page hold');
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"16300000-0000-4000-8000-000000000903"}', true);
select extensions.throws_ok(format($$select public.resolve_cpsc_page_identity_hold(%L,
  'clear_page_hold', 'consumer attempt')$$, current_setting('p1630.hold_r')),
  '42501', null, 'authenticated consumer cannot clear a page hold');
select extensions.throws_ok(format($$select public.get_cpsc_page_identity_hold_packet(%L)$$,
  current_setting('p1630.hold_r')), '42501', null, 'consumer cannot read the hold packet');
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"16300000-0000-4000-8000-000000000902"}', true);
select extensions.throws_ok(format($$select public.resolve_cpsc_page_identity_hold(%L,
  'clear_page_hold', 'criterion reviewer attempt')$$, current_setting('p1630.hold_r')),
  '42501', null, 'criterion reviewer without the identity capability cannot clear a hold');
select set_config('request.jwt.claims', '', true);
set local role cpsc_page_worker;
select extensions.throws_ok(format($$select public.resolve_cpsc_page_identity_hold(%L,
  'clear_page_hold', 'worker attempt')$$, current_setting('p1630.hold_r')),
  '42501', null, 'page worker cannot clear a page hold');
select extensions.throws_ok($$insert into private.cpsc_page_identity_hold_resolutions
  (hold_id, decision, reviewer_user_id, rationale, evidence_snapshot, evidence_sha256)
  values (gen_random_uuid(), 'clear_page_hold', gen_random_uuid(), 'x', '{}', repeat('0',64))$$,
  '42501', null, 'page worker cannot write resolutions');
reset role;
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.r')::uuid),
  array['human_reconciliation_required'],
  'every unauthorized attempt left the redirect fixture held');

-- Authorized human path, on fixture holds and fixture quarantines only.
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"16300000-0000-4000-8000-000000000901"}', true);
select extensions.is(public.get_cpsc_page_identity_hold_packet(
  current_setting('p1630.hold_r')::uuid) #>> '{holdEvidence,errorCode}',
  'canonical_link_mismatch', 'authorized human packet carries the redirect evidence');
select extensions.is(public.resolve_cpsc_page_identity_hold(
  current_setting('p1630.hold_r')::uuid, 'keep_page_hold',
  'Redirect target not yet reviewed')->>'decision', 'keep_page_hold',
  'authorized human can keep a hold');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.r')::uuid),
  array['human_reconciliation_required'], 'keep_page_hold leaves the identity ineligible');
select extensions.ok(public.resolve_cpsc_page_identity_hold(
  current_setting('p1630.hold_r')::uuid, 'clear_page_hold',
  'Reviewed fixture: page identity confirmed') ? 'resolutionId',
  'authorized human can clear a hold through the reviewed path');
select extensions.throws_ok(format($$select public.resolve_cpsc_page_identity_hold(%L,
  'clear_page_hold', 'again')$$, current_setting('p1630.hold_r')),
  null, 'CPSC page hold is already cleared', 'a hold is cleared at most once');
select public.reconcile_cpsc_quarantined_observation(
  (current_setting('p1630.q_obs')::jsonb->>'observationId')::uuid,
  'reject_observation', 'Reused API id belongs to 29101');
select public.reconcile_cpsc_quarantined_observation(
  (current_setting('p1630.v_obs')::jsonb->>'observationId')::uuid,
  'confirm_alias', 'Same recall; CPSC moved the page');
select set_config('request.jwt.claims', '', true);
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.r')::uuid),
  '{}'::text[], 'authorized human clearance restores eligibility');
select extensions.ok((select next_attempt_at = '-infinity' and claim_id is null
    and not manual_review_required
  from private.cpsc_page_work_state where identity_id = current_setting('p1630.r')::uuid),
  'human clearance changes no work state (no automatic worker approval)');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.q')::uuid),
  '{}'::text[], 'authorized quarantine rejection restores eligibility');
select extensions.is(private.cpsc_page_identity_blockers(current_setting('p1630.v')::uuid),
  '{}'::text[], 'authorized alias confirmation of a URL change restores eligibility');
select extensions.throws_ok($$update private.cpsc_page_identity_hold_resolutions set rationale = 'x'$$,
  '42501', null, 'resolutions are append-only');
select extensions.throws_ok($$delete from private.cpsc_page_identity_holds$$,
  '42501', null, 'holds cannot be deleted');
select extensions.throws_ok($$delete from private.cpsc_backfill_page_hold_imports$$,
  '42501', null, 'manifest imports cannot be deleted');

-- ===========================================================================
-- Production isolation inside the transaction.
-- ===========================================================================
select extensions.is((select blockers from private.cpsc_page_identity_eligibility
  where official_recall_number = '26777'), array['human_reconciliation_required'],
  'the real 26777 hold was never resolved');
select extensions.is((select count(*) from private.cpsc_page_identity_hold_resolutions x
  join private.cpsc_page_identity_holds h on h.id = x.hold_id
  where h.hold_class = 'backfill_manifest_unresolved_identity'), 0::bigint,
  'no manifest hold has any resolution');
select extensions.is((select count(*) from private.cpsc_page_attempts a
  where not pg_temp.is_fixture(a.identity_id)), pg_temp.base('attempts'),
  'no production identity received an attempt');
select extensions.is((select count(*) from private.cpsc_page_work_state w
  where not pg_temp.is_fixture(w.identity_id)), pg_temp.base('work'),
  'no production identity received work state');
select extensions.is((select md5(string_agg(x::text, E'\n' order by x.id)) from private.cpsc_page_attempts x
  where not pg_temp.is_fixture(x.identity_id)), pg_temp.fp('attempts'),
  'production attempts are byte-identical');
select extensions.is((select md5(string_agg(x::text, E'\n' order by x.identity_id))
  from private.cpsc_page_work_state x where not pg_temp.is_fixture(x.identity_id)),
  pg_temp.fp('work'), 'production work state is byte-identical');
select extensions.is((select md5(a::text) from private.cpsc_page_attempts a
  where a.id = '0bf98d4e-9c4b-42ce-a430-d20bfe97ac84'), pg_temp.fp('old_attempt'),
  'historical Intertex attempt is unchanged');
select extensions.is((select md5(string_agg(x::text, E'\n' order by x.id))
  from private.cpsc_source_identities x where not pg_temp.is_fixture(x.id)),
  pg_temp.fp('identities'), 'production identities are byte-identical');
select extensions.is((select md5(string_agg(x::text, E'\n' order by x.id))
  from private.cpsc_source_aliases x where not pg_temp.is_fixture(x.identity_id)),
  pg_temp.fp('aliases'), 'production aliases are byte-identical');
select extensions.is((select md5(string_agg(x::text, E'\n' order by x.id))
  from private.cpsc_identity_observations x
  where x.official_recall_number not between '29100' and '29199'),
  pg_temp.fp('observations'), 'production observations are byte-identical');
select extensions.is((select md5(string_agg(x::text, E'\n' order by x.notice_id, x.identity_id))
  from private.cpsc_notice_identity_links x where not pg_temp.is_fixture(x.identity_id)),
  pg_temp.fp('links'), 'production notice links are byte-identical');
select extensions.is((select count(*) from private.cpsc_identity_reconciliations r
  join private.cpsc_identity_observations o on o.id = r.observation_id
  where o.official_recall_number not between '29100' and '29199'), 0::bigint,
  'no production observation was reconciled');
select extensions.is((select count(*) from private.cpsc_page_fetches), pg_temp.base('fetches'),
  'no page fetch was recorded');
select extensions.is((select count(*) from private.cpsc_page_coverage_ledgers),
  pg_temp.base('ledgers'), 'no coverage ledger was recorded');
select extensions.is((select count(*) from private.cpsc_candidate_criteria),
  pg_temp.base('candidates'), 'no candidate criterion was proposed');
select extensions.is((select count(*) from private.cpsc_candidate_review_ledger),
  pg_temp.base('review_ledger'), 'no criterion review was recorded');
select extensions.is((select count(*) from public.recall_matches), pg_temp.base('matches'),
  'no match was created');
select extensions.is((select count(*) from public.alerts), pg_temp.base('alerts'),
  'no alert was created');
select extensions.is((select count(*) from private.push_alert_queue), pg_temp.base('push'),
  'no push work was created');
select extensions.ok((select count(*) from private.recall_scope_criteria_v2) = pg_temp.base('criteria_v2')
  and (select count(*) from private.recall_scope_rule_sets_v2) = pg_temp.base('rule_sets_v2')
  and (select count(*) from private.recall_match_evaluations_v2) = pg_temp.base('evals_v2'),
  'no v2 criteria, rule set, or evaluation was created');
select extensions.is((select md5(string_agg(x::text, E'\n' order by x.source_id))
  from private.recall_source_sync_state x), pg_temp.fp('sync'), 'source watermarks unchanged');
select extensions.is((select md5(string_agg(x::text, E'\n')) from private.recall_automation_state x),
  pg_temp.fp('automation'), 'automation watermark unchanged');

select * from extensions.finish();
rollback;
