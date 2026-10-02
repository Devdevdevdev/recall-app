begin;
set local role postgres;
set local search_path = extensions, public, auth;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

-- ---------------------------------------------------------------------------
-- Privilege boundary for every Phase 16.13 object
-- ---------------------------------------------------------------------------
select extensions.ok(not has_table_privilege(r, 'private.cpsc_page_coverage_ledgers', p),
  format('%s has no %s on private.cpsc_page_coverage_ledgers', r, p))
  from unnest(array['anon','authenticated','service_role']) r,
    unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;
select extensions.ok((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private' and c.relname = 'cpsc_page_coverage_ledgers'), 'RLS enabled on coverage ledgers');
select extensions.ok(not exists (select 1 from pg_policies where schemaname = 'private'
  and tablename = 'cpsc_page_coverage_ledgers'), 'no policy exposes coverage ledgers');
select extensions.ok(not has_function_privilege('service_role', 'public.record_cpsc_page_coverage(uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.record_cpsc_page_coverage(uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.record_cpsc_page_coverage(uuid,jsonb)', 'EXECUTE'),
  'legacy coverage RPC is owner-only');
select extensions.ok(has_function_privilege('authenticated', 'public.list_cpsc_pending_review_candidates(integer,text)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.list_cpsc_pending_review_candidates(integer,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.list_cpsc_pending_review_candidates(integer,text)', 'EXECUTE'),
  'human-only RPC list_cpsc_pending_review_candidates');
select extensions.ok(not has_function_privilege(r, f, 'EXECUTE'), format('%s cannot execute %s', r, f))
  from unnest(array['anon','authenticated','service_role']) r,
    unnest(array[
      'private.cpsc_validate_coverage_ledger(jsonb)',
      'private.cpsc_coverage_summary(jsonb)',
      'private.cpsc_check_coverage_binding(uuid,jsonb)',
      'private.cpsc_scope_current_revision(uuid)',
      'private.cpsc_revision_coverage(uuid)',
      'private.cpsc_touch_identity_notices(uuid)',
      'private.cpsc_scope_rule_set_coverage(uuid,text[])',
      'private.cpsc_scope_rule_set_envelope(uuid)']) f;

-- ---------------------------------------------------------------------------
-- Fixtures: users, grants, CPSC source, helpers
-- ---------------------------------------------------------------------------
insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id::uuid,'authenticated','authenticated',email,'','2099-01-01','{}','{}',now(),now()
from (values
  ('16130000-0000-4000-8000-000000000001','p1613-reviewer-one@example.invalid'),
  ('16130000-0000-4000-8000-000000000002','p1613-reviewer-two@example.invalid'),
  ('16130000-0000-4000-8000-000000000003','p1613-revoked@example.invalid'),
  ('16130000-0000-4000-8000-000000000004','p1613-reconciler@example.invalid'),
  ('16130000-0000-4000-8000-000000000005','p1613-invalidator@example.invalid'),
  ('16130000-0000-4000-8000-000000000006','p1613-consumer@example.invalid')) u(id,email);
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
select id::uuid, now() - interval '1 hour', 'Phase 16.13 pgTAP reviewer'
from unnest(array['16130000-0000-4000-8000-000000000001','16130000-0000-4000-8000-000000000002',
  '16130000-0000-4000-8000-000000000003']) id;
insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason) values
  ('16130000-0000-4000-8000-000000000004','identity_reconciliation',now() - interval '1 hour','pgTAP reconciler'),
  ('16130000-0000-4000-8000-000000000005','decision_invalidation',now() - interval '1 hour','pgTAP invalidator');
select set_config('t13.source', public.ensure_cpsc_recall_source()::text, true);

create function pg_temp.act(p_role text, p_sub text default null) returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('role', p_role) ||
    case when p_sub is null then '{}'::jsonb
      else jsonb_build_object('sub', '16130000-0000-4000-8000-0000000000' || p_sub, 'aal', 'aal2',
        'session_id', '16130000-0000-4000-8000-0000000000' || p_sub) end)::text, true);
$$;
create function pg_temp.done() returns void language sql as $$
  select set_config('request.jwt.claims', '', true);
$$;
create function pg_temp.id(p_suffix text) returns uuid language sql immutable as $$
  select ('16130000-0000-4000-8000-' || lpad(p_suffix, 12, '0'))::uuid;
$$;
create function pg_temp.hex(p_seed text) returns text language sql immutable as $$
  select encode(sha256(convert_to(p_seed, 'UTF8')), 'hex');
$$;
create function pg_temp.table_id(p_number text) returns text language sql immutable as $$
  select 'description/table/0/' || pg_temp.hex('p1613-table:' || p_number);
$$;
create function pg_temp.row_id(p_number text, p_row integer) returns text language sql immutable as $$
  select pg_temp.hex('p1613-row:' || p_number || ':' || p_row);
$$;
create function pg_temp.revision_hash(p_number text, p_version integer default 1)
returns text language sql immutable as $$
  select pg_temp.hex('p1613-revision:' || p_number || ':' || p_version);
$$;

-- A reconciled recall with one scope and a current revision whose stored table
-- has p_rows extracted rows (no table at all when p_rows is null).
create function pg_temp.recall(p_key text, p_number text, p_rows integer)
returns void language plpgsql as $$
declare v_url text := 'https://www.cpsc.gov/Recalls/2026/P1613-' || p_key;
begin
  insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
    recall_date,official_url,retrieved_at,raw_payload)
  values (pg_temp.id('10' || p_number), current_setting('t13.source')::uuid, 'cpsc:' || p_number,
    'Recall ' || p_key, 'Desc', 'Hazard', 'Refund', '2026-09-20', v_url, now() - interval '1 day',
    jsonb_build_object('RecallNumber', p_number));
  insert into public.recall_scopes (id,recall_notice_id,product_name)
  values (pg_temp.id('20' || p_number), pg_temp.id('10' || p_number), 'Product ' || p_key);
  insert into private.cpsc_source_identities (id,source_id,official_recall_number,canonical_url,
    canonical_notice_id,identity_status)
  values (pg_temp.id('30' || p_number), current_setting('t13.source')::uuid, p_number, v_url,
    pg_temp.id('10' || p_number), 'reconciled');
  insert into private.cpsc_notice_identity_links (notice_id,identity_id,provenance)
  values (pg_temp.id('10' || p_number), pg_temp.id('30' || p_number), 'Phase 16.13 pgTAP');
  insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,
    canonical_url,title,section_hashes,normalized_evidence,parser_version,first_seen_at,last_seen_at,
    table_identities)
  values (pg_temp.id('40' || p_number), pg_temp.id('30' || p_number), pg_temp.revision_hash(p_number),
    p_number, v_url, 'Recall ' || p_key, '{}', jsonb_build_object('recallNumber', p_number,
      'canonicalUrl', v_url, 'title', 'Recall ' || p_key), 'phase-16.13-structured-v2',
    now() - interval '2 hours', now() - interval '2 hours',
    case when p_rows is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'identity', pg_temp.table_id(p_number),
      'rows', coalesce((select jsonb_agg(jsonb_build_object('identity', pg_temp.row_id(p_number, n),
          'evidence', jsonb_build_array('Product ' || n, 'MODEL-' || n)) order by n)
        from generate_series(1, p_rows) n), '[]'::jsonb))) end);
end $$;

-- Worker proposal of row p_row (1-based) as `model AND date code`.
create function pg_temp.propose_row(p_number text, p_row integer, p_revision uuid default null)
returns uuid[] language plpgsql as $$
declare
  v_revision private.cpsc_page_revisions%rowtype;
  v_key text := pg_temp.table_id(p_number) || '/' || pg_temp.row_id(p_number, p_row);
  v_model uuid;
  v_date uuid;
  v_address jsonb;
begin
  select * into v_revision from private.cpsc_page_revisions
    where id = coalesce(p_revision, pg_temp.id('40' || p_number));
  v_address := jsonb_build_object('source','cpsc','recallNumber',p_number,
    'canonicalUrl',v_revision.canonical_url,'sourceSemanticRevision',v_revision.evidence_hash,
    'sectionIdentity','description','tableIdentity',pg_temp.table_id(p_number),
    'rowIdentity',pg_temp.row_id(p_number, p_row));
  perform pg_temp.act('service_role');
  v_model := (public.propose_cpsc_candidate_criterion(v_revision.id, pg_temp.id('20' || p_number),
    v_address || '{"fieldIdentity":"model no"}', pg_temp.hex(v_key), 'model_exact',
    to_jsonb('MODEL-' || p_row), v_key, 'Product ' || p_row || ' | MODEL-' || p_row,
    'phase-16.13-structured-v2')->>'candidateId')::uuid;
  v_date := (public.propose_cpsc_candidate_criterion(v_revision.id, pg_temp.id('20' || p_number),
    v_address || '{"fieldIdentity":"date code"}', pg_temp.hex(v_key), 'date_code_exact',
    to_jsonb('25' || lpad(p_row::text, 2, '0')), v_key, 'Product ' || p_row || ' | 25' || lpad(p_row::text, 2, '0'),
    'phase-16.13-structured-v2')->>'candidateId')::uuid;
  perform pg_temp.done();
  return array[v_model, v_date];
end $$;

create function pg_temp.decide(p_candidate uuid, p_reviewer text default '01', p_decision text default 'reviewed')
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  perform pg_temp.act('authenticated', p_reviewer);
  v_id := public.decide_cpsc_candidate(p_candidate, p_decision, p_decision = 'reviewed', 'pgTAP');
  perform pg_temp.done();
  return v_id;
end $$;

create function pg_temp.approve_row(p_number text, p_row integer, p_reviewer text default '01')
returns jsonb language plpgsql as $$
declare v_ids uuid[]; v jsonb;
begin
  select array_agg(c.id order by c.criterion_kind) into v_ids from private.cpsc_candidate_criteria c
    where c.revision_id = pg_temp.id('40' || p_number)
      and c.conjunction_key = pg_temp.table_id(p_number) || '/' || pg_temp.row_id(p_number, p_row);
  perform pg_temp.decide(v_ids[1], p_reviewer);
  perform pg_temp.decide(v_ids[2], p_reviewer);
  perform pg_temp.act('authenticated', p_reviewer);
  v := public.materialize_cpsc_reviewed_conjunction(v_ids[1]);
  perform pg_temp.done();
  return v;
end $$;

-- Phase 16.33: negative evidence also needs a reviewer's attestation over the
-- recall-detail sections outside the description census.
create function pg_temp.attest(p_number text, p_reviewer text default '01')
returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.act('authenticated', p_reviewer);
  v := public.attest_cpsc_outside_census(pg_temp.id('40' || p_number),
    public.get_cpsc_outside_census_packet(pg_temp.id('40' || p_number))->>'sectionsSha256',
    '[]'::jsonb,
    'pgTAP: no restriction outside the description', 1);
  perform pg_temp.done();
  return v;
end $$;

create function pg_temp.envelope(p_number text) returns jsonb language sql as $$
  select reviewed_criteria from public.get_recall_v2_scopes(pg_temp.id('10' || p_number))
  where scope_id = pg_temp.id('20' || p_number);
$$;

-- A ledger exactly as the worker would send it. p_rows holds one
-- 'disposition:effect' per DOM row ('failed:<effect>' = not extracted);
-- p_prose holds one 'disposition:effect' per description sentence.
create function pg_temp.ledger(
  p_number text, p_rows text[], p_prose text[] default array['ignored_non_safety:none'],
  p_parser text default 'phase-16.13-structured-v2', p_anomalies text[] default '{}',
  p_stored_rows integer default null, p_revision_version integer default 1
) returns jsonb language sql as $$
  select jsonb_build_object(
    'schema', 'cpsc_source_coverage_v1',
    'ledgerVersion', 'phase-16.13-coverage-v1',
    'parserVersion', p_parser,
    'extractorVersion', 'phase-16.11-html-v1',
    'censusVersion', 'phase-16.13-census-v1',
    'sourceSemanticRevision', pg_temp.revision_hash(p_number, p_revision_version),
    'structures', jsonb_build_array(jsonb_build_object(
      'structureId', 'description/prose', 'kind', 'prose', 'sectionIdentity', 'description',
      'tableIndex', null, 'tableIdentity', null,
      'authoritativeRecordCount', cardinality(p_prose), 'anomalies', '[]'::jsonb,
      'records', coalesce((select jsonb_agg(jsonb_build_object(
          'ordinal', n - 1, 'recordIdentity', pg_temp.hex('sentence:' || p_number || ':' || n),
          'rowIdentity', null, 'extraction', 'extracted',
          'disposition', split_part(entry, ':', 1), 'effect', split_part(entry, ':', 2),
          'relation', case when split_part(entry, ':', 1) = 'parsed_reviewable'
            then 'governs:' || pg_temp.table_id(p_number) end,
          'reason', 'pgTAP sentence', 'cells', '[]'::jsonb) order by n)
        from unnest(p_prose) with ordinality x(entry, n)), '[]'::jsonb)))
      || case when p_rows is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
        'structureId', pg_temp.table_id(p_number), 'kind', 'table', 'sectionIdentity', 'description',
        'tableIndex', 0, 'tableIdentity', pg_temp.table_id(p_number),
        'authoritativeRecordCount', cardinality(p_rows),
        'anomalies', to_jsonb(p_anomalies),
        'records', coalesce((select jsonb_agg(jsonb_build_object(
            'ordinal', n - 1,
            'recordIdentity', case when n <= coalesce(p_stored_rows, cardinality(p_rows))
              then pg_temp.row_id(p_number, n::integer) else 'dom-row:' || (n - 1) end,
            'rowIdentity', case when n <= coalesce(p_stored_rows, cardinality(p_rows))
              then pg_temp.row_id(p_number, n::integer) end,
            'extraction', case when split_part(entry, ':', 1) = 'failed' then 'failed' else 'extracted' end,
            'disposition', case when split_part(entry, ':', 1) = 'failed' then 'unresolved'
              else split_part(entry, ':', 1) end,
            'effect', split_part(entry, ':', 2),
            'relation', case when split_part(entry, ':', 1) = 'parsed_reviewable'
              then pg_temp.table_id(p_number) || '/' || pg_temp.row_id(p_number, n::integer) end,
            'reason', 'pgTAP row',
            'cells', case when split_part(entry, ':', 1) = 'failed' then '[]'::jsonb
              else jsonb_build_array(
                jsonb_build_object('column','model no','criterionClass','model','status','recognized'),
                jsonb_build_object('column','date code','criterionClass','date_code','status','recognized')) end)
            order by n)
          from unnest(p_rows) with ordinality x(entry, n)), '[]'::jsonb))) end);
$$;

create function pg_temp.record(p_number text, p_ledger jsonb, p_revision uuid default null)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act('service_role');
  v := public.record_cpsc_page_coverage(coalesce(p_revision, pg_temp.id('40' || p_number)), p_ledger);
  perform pg_temp.done();
  return v;
end $$;

create function pg_temp.queue(p_reviewer text, p_size integer default 50, p_cursor text default null)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act('authenticated', p_reviewer);
  v := public.list_cpsc_pending_review_candidates(p_size, p_cursor);
  perform pg_temp.done();
  return v;
end $$;

-- ===========================================================================
-- Reviewer queue: empty state, authorization
-- ===========================================================================
select extensions.is(pg_temp.queue('01'), jsonb_build_object('schema','cpsc_pending_review_page_v1',
    'semantics','OR between rule sets; AND inside each rule set','pageSize',50,'items','[]'::jsonb,
    'hasMore',false,'nextCursor',null),
  'empty queue: no items, no cursor');
select pg_temp.act('anon');
select extensions.throws_ok($$select public.list_cpsc_pending_review_candidates(10, null)$$, '42501', null,
  'anon cannot list review candidates');
select pg_temp.act('authenticated', '06');
select extensions.throws_ok($$select public.list_cpsc_pending_review_candidates(10, null)$$, '42501', null,
  'a consumer cannot list review candidates');
select pg_temp.act('service_role');
select extensions.throws_ok($$select public.list_cpsc_pending_review_candidates(10, null)$$, '42501', null,
  'the service role is not a human reviewer');
select pg_temp.act('authenticated', '04');
select extensions.throws_ok($$select public.list_cpsc_pending_review_candidates(10, null)$$, '42501', null,
  'the reconciliation capability does not imply reviewer permission');
select pg_temp.act('authenticated', '05');
select extensions.throws_ok($$select public.list_cpsc_pending_review_candidates(10, null)$$, '42501', null,
  'the invalidation capability does not imply reviewer permission');
select pg_temp.done();
select extensions.throws_ok($$select pg_temp.queue('01', 0)$$, null,
  'Review page size must be between 1 and 50', 'page size 0 is refused');
select extensions.throws_ok($$select pg_temp.queue('01', 51)$$, null,
  'Review page size must be between 1 and 50', 'page size above 50 is refused');
select extensions.throws_ok($$select pg_temp.queue('01', 10, 'x'' or 1=1')$$, null,
  'Invalid review cursor', 'a malformed cursor is refused');

-- ===========================================================================
-- Ledger shape, binding, and guard
-- ===========================================================================
select pg_temp.recall('Complete', '96101', 3);
select pg_temp.propose_row('96101', n) from generate_series(1, 3) n;
select set_config('t13.full', pg_temp.ledger('96101',
  array['parsed_reviewable:none','parsed_reviewable:none','parsed_reviewable:none'])::text, true);
select pg_temp.act('authenticated', '01');
select extensions.throws_ok(format($$select public.record_cpsc_page_coverage(%L, %L::jsonb)$$,
  pg_temp.id('4096101'), current_setting('t13.full')), '42501', null, 'a human cannot record a ledger');
select pg_temp.done();
select extensions.throws_ok(format($$select pg_temp.record('96101', %L::jsonb)$$,
  current_setting('t13.full')::jsonb || '{"recordedAt":"2026-09-26"}'), null, 'Invalid CPSC coverage ledger',
  'an unknown ledger key (timestamp) is refused');
select extensions.throws_ok(format($$select pg_temp.record('96101', %L::jsonb)$$,
  jsonb_set(current_setting('t13.full')::jsonb, '{structures,1,records,0,reviewerId}', '"x"')), null,
  'Invalid CPSC coverage ledger record', 'an unknown record key (reviewer identity) is refused');
select extensions.throws_ok(format($$select pg_temp.record('96101', %L::jsonb)$$,
  jsonb_set(current_setting('t13.full')::jsonb, '{sourceSemanticRevision}', to_jsonb(repeat('0', 64)))), null,
  'CPSC coverage ledger names another source revision', 'a ledger for another source revision is refused');
select extensions.throws_ok(format($$select pg_temp.record('96101', %L::jsonb)$$,
  current_setting('t13.full')::jsonb #- '{structures,1}'), null,
  'CPSC coverage ledger does not account for every stored table', 'a ledger that omits a stored table is refused');
select extensions.throws_ok(format($$select pg_temp.record('96101', %L::jsonb)$$,
  pg_temp.ledger('96101', array['parsed_reviewable:none','parsed_reviewable:none'])), null,
  'CPSC coverage ledger rows do not match the stored revision',
  'an anomaly-free table that drops a stored row is refused');
select extensions.throws_ok(format($$select pg_temp.record('96101', %L::jsonb)$$,
  jsonb_set(current_setting('t13.full')::jsonb, '{structures,1,records,0,relation}',
    to_jsonb(pg_temp.table_id('96101') || '/' || pg_temp.row_id('96101', 2)))), null,
  'CPSC coverage ledger reviewable records are not bound to proposals',
  'a reviewable record bound to another row is refused');
select extensions.throws_ok(format($$select pg_temp.record('96101', %L::jsonb)$$,
  jsonb_set(current_setting('t13.full')::jsonb, '{structures,1,records,0,effect}', '"restrictive"')), null,
  'Invalid CPSC coverage ledger record', 'a reviewable record cannot carry an effect');
select extensions.throws_ok(format($$insert into private.cpsc_page_coverage_ledgers (revision_id,
    ledger_version, parser_version, extractor_version, census_version, coverage_fingerprint,
    interpretation_fingerprint, structural_status, criterion_status, coverage_status, positive_status,
    negative_evidence_eligible, authoritative_records, accounted_records, reviewable_relations, summary, ledger)
  values (%L, 'phase-16.13-coverage-v1', 'phase-16.13-structured-v2', 'phase-16.11-html-v1',
    'phase-16.13-census-v1', repeat('a',64), repeat('b',64), 'complete', 'complete', 'complete',
    'independent', true, 4, 4, '{}', '{}', %L::jsonb)$$, pg_temp.id('4096101'),
    current_setting('t13.full')), '42501', 'CPSC coverage ledger row does not follow from its content',
  'even the owner cannot insert fabricated statuses');

-- ===========================================================================
-- Complete coverage: every row reviewable and served
-- ===========================================================================
select set_config('t13.full_result', pg_temp.record('96101', current_setting('t13.full')::jsonb)::text, true);
select extensions.ok(current_setting('t13.full_result')::jsonb->>'status' = 'created'
    and current_setting('t13.full_result')::jsonb->>'structuralStatus' = 'complete'
    and current_setting('t13.full_result')::jsonb->>'criterionStatus' = 'complete'
    and current_setting('t13.full_result')::jsonb->>'coverageStatus' = 'complete'
    and current_setting('t13.full_result')::jsonb->>'positiveStatus' = 'independent'
    and (current_setting('t13.full_result')::jsonb->>'negativeEvidenceEligible')::boolean,
  'complete ledger: structural, criterion, and coverage complete');
select extensions.is(current_setting('t13.full_result')::jsonb->'dispositionCounts',
  '{"parsed_reviewable":3,"parsed_deferred":0,"unresolved":0,"unsupported":0,"ignored_non_safety":1}'::jsonb,
  'sum of dispositions equals the 4 authoritative records');
select extensions.is(pg_temp.record('96101', current_setting('t13.full')::jsonb)->>'status', 'unchanged',
  'replaying the same ledger is idempotent');
select extensions.throws_ok($$update private.cpsc_page_coverage_ledgers set coverage_status = 'partial'$$,
  '42501', 'cpsc_page_coverage_ledgers is append-only', 'ledgers cannot be edited');
select extensions.throws_ok($$delete from private.cpsc_page_coverage_ledgers$$,
  '42501', 'cpsc_page_coverage_ledgers is append-only', 'ledgers cannot be deleted');
select extensions.throws_ok($$truncate private.cpsc_page_coverage_ledgers$$,
  '42501', null, 'ledgers cannot be truncated');

-- Reviewer queue over three pending rule sets, in authoritative row order.
select set_config('t13.p1', pg_temp.queue('01', 2)::text, true);
select extensions.ok(jsonb_array_length(current_setting('t13.p1')::jsonb->'items') = 2
    and (current_setting('t13.p1')::jsonb->>'hasMore')::boolean
    and current_setting('t13.p1')::jsonb->>'nextCursor' = current_setting('t13.p1')::jsonb#>>'{items,1,sortKey}',
  'page 1: two items, more to come, cursor = last sort key');
select set_config('t13.p2', pg_temp.queue('01', 2, current_setting('t13.p1')::jsonb->>'nextCursor')::text, true);
select extensions.ok(jsonb_array_length(current_setting('t13.p2')::jsonb->'items') = 1
    and not (current_setting('t13.p2')::jsonb->>'hasMore')::boolean
    and current_setting('t13.p2')::jsonb->'nextCursor' = 'null'::jsonb,
  'page 2: the last item and no cursor');
select extensions.is((select array_agg((i->>'ruleSetNumber')::integer order by n) from (
    select i, n from jsonb_array_elements(current_setting('t13.p1')::jsonb->'items') with ordinality x(i, n)
    union all select i, n + 2 from jsonb_array_elements(current_setting('t13.p2')::jsonb->'items') with ordinality x(i, n)) q),
  array[1, 2, 3], 'pages are deterministic, disjoint, and in document order');
select extensions.is(pg_temp.queue('01', 2), current_setting('t13.p1')::jsonb, 'the same request returns the same page');
select extensions.ok((select bool_and(i->>'recallNumber' = '96101'
    and i->>'officialUrl' = 'https://www.cpsc.gov/Recalls/2026/P1613-Complete'
    and i->>'sourceRevision' = pg_temp.revision_hash('96101')
    and i->>'semantics' = 'OR between rule sets; AND inside each rule set'
    and i->>'insideRuleSet' = 'AND'
    and (i->>'ruleSetCount')::integer = 3
    and jsonb_array_length(i->'members') = 2
    and i->'members'->0->>'kind' = 'model_exact' and i->'members'->1->>'kind' = 'date_code_exact'
    and (i->>'pendingMembers')::integer = 2
    and i->'evidenceLocation'->>'tableIdentity' = pg_temp.table_id('96101')
    and i->'parserCoverage'->>'coverageStatus' = 'complete'
    and i->>'criterionPreview' like 'model_number equals "MODEL-_" AND date_code equals "25__"')
  from jsonb_array_elements(current_setting('t13.p1')::jsonb->'items') i),
  'each item is one rule set: its own model AND date code, with evidence and parser coverage');
select extensions.ok((select bool_and(not (k ~* '(user|owner|reviewer|email|secret|attestation|note)'))
  from jsonb_array_elements(current_setting('t13.p1')::jsonb->'items') i,
    lateral (select jsonb_object_keys(i) k union all
      select jsonb_object_keys(m) from jsonb_array_elements(i->'members') m) keys),
  'items expose no owned-product, reviewer, or administrative fields');

select pg_temp.approve_row('96101', n) from generate_series(1, 3) n;
select pg_temp.attest('96101');
select extensions.is(jsonb_array_length(pg_temp.queue('01')->'items'), 0,
  'decided rule sets leave the queue');
select extensions.ok(jsonb_array_length(pg_temp.envelope('96101')->'ruleSets') = 3
    and (pg_temp.envelope('96101')->'coverage'->>'complete')::boolean
    and pg_temp.envelope('96101')->'coverage'->'sourceCoverage'->>'coverageStatus' = 'complete',
  'three rule sets served; coverage complete with a complete source ledger');

-- ===========================================================================
-- Revoke-for-cause puts a rule set back into the queue
-- ===========================================================================
select set_config('t13.event', (select l.id::text from private.cpsc_candidate_review_ledger l
  join private.cpsc_candidate_criteria c on c.id = l.candidate_id
  where c.revision_id = pg_temp.id('4096101') and c.criterion_kind = 'date_code_exact'
    and c.conjunction_key like '%' || pg_temp.row_id('96101', 2)
  order by l.event_seq desc limit 1), true);
select pg_temp.act('authenticated', '05');
select public.invalidate_cpsc_review_decision(current_setting('t13.event')::uuid, 'pgTAP cause');
select pg_temp.done();
select set_config('t13.after_revoke', pg_temp.queue('02')::text, true);
select extensions.ok(jsonb_array_length(current_setting('t13.after_revoke')::jsonb->'items') = 1
    and (current_setting('t13.after_revoke')::jsonb#>>'{items,0,pendingMembers}')::integer = 1
    and (current_setting('t13.after_revoke')::jsonb#>>'{items,0,members,1,latestDecisionInvalidated}')::boolean,
  'an invalidated decision is pending again, with its sibling still decided');
select extensions.ok(jsonb_array_length(pg_temp.envelope('96101')->'ruleSets') = 2
    and not (pg_temp.envelope('96101')->'coverage'->>'complete')::boolean,
  'the revoked rule set stops serving and coverage becomes incomplete');
select extensions.throws_ok(format($$select pg_temp.decide(%L::uuid, '01')$$,
  (select candidate_id::text from private.cpsc_candidate_review_ledger where id = current_setting('t13.event')::uuid)),
  null, 'A decision invalidated for cause requires a different reviewer',
  'the invalidated reviewer cannot replace their own decision');
select pg_temp.act('authenticated', '01');
select extensions.throws_ok(format($$select public.invalidate_cpsc_review_decision(%L, 'x')$$,
  current_setting('t13.event')), '42501', null, 'a reviewer cannot revoke for cause');
select pg_temp.done();
update private.cpsc_reviewer_authorizations set revoked_at = now()
  where user_id = '16130000-0000-4000-8000-000000000003';
select extensions.throws_ok($$select pg_temp.queue('03')$$, '42501', null,
  'a revoked reviewer cannot list review candidates');

-- ===========================================================================
-- Omitted row: the census counts 3 DOM rows, the parser extracted 2
-- ===========================================================================
select pg_temp.recall('Omitted', '96102', 2);
select pg_temp.propose_row('96102', n) from generate_series(1, 2) n;
select pg_temp.approve_row('96102', n) from generate_series(1, 2) n;
select extensions.is(jsonb_array_length(pg_temp.envelope('96102')->'ruleSets'), 2,
  'before the ledger: the two extracted rows serve positively');
select set_config('t13.omitted', pg_temp.record('96102', pg_temp.ledger('96102',
  array['failed:restrictive','failed:restrictive','failed:restrictive'], p_anomalies => array['row_count_mismatch'],
  p_stored_rows => 2))::text, true);
select extensions.ok(current_setting('t13.omitted')::jsonb->>'structuralStatus' = 'unresolved'
    and current_setting('t13.omitted')::jsonb->>'coverageStatus' = 'unresolved'
    and current_setting('t13.omitted')::jsonb->>'positiveStatus' = 'blocked'
    and not (current_setting('t13.omitted')::jsonb->>'negativeEvidenceEligible')::boolean
    and (current_setting('t13.omitted')::jsonb->>'authoritativeRecords')::integer = 4,
  'a row missing from parser output makes coverage unresolved (3 DOM rows, 2 extracted)');
select extensions.is(pg_temp.envelope('96102'), null,
  'nothing serves: no rule set can be positive and no product can be rejected');

-- ===========================================================================
-- Partial: an additive unresolved record blocks negatives, not positives
-- ===========================================================================
select pg_temp.recall('Partial', '96103', 2);
select pg_temp.propose_row('96103', 1);
select pg_temp.approve_row('96103', 1);
select set_config('t13.partial', pg_temp.record('96103', pg_temp.ledger('96103',
  array['parsed_reviewable:none','unresolved:additive'],
  array['ignored_non_safety:none','unresolved:additive']))::text, true);
select extensions.ok(current_setting('t13.partial')::jsonb->>'structuralStatus' = 'complete'
    and current_setting('t13.partial')::jsonb->>'criterionStatus' = 'partial'
    and current_setting('t13.partial')::jsonb->>'coverageStatus' = 'partial'
    and current_setting('t13.partial')::jsonb->>'positiveStatus' = 'independent',
  'structural completeness is distinct from criterion completeness');
select extensions.ok(jsonb_array_length(pg_temp.envelope('96103')->'ruleSets') = 1
    and not (pg_temp.envelope('96103')->'coverage'->>'complete')::boolean,
  'the reviewed rule set still confirms; negative evidence is withheld');

-- ===========================================================================
-- AGA-shaped: six rows detected, model recognized, production date deferred
-- ===========================================================================
select pg_temp.recall('Deferred', '96104', 6);
select set_config('t13.aga', pg_temp.record('96104', pg_temp.ledger('96104',
  array_fill('parsed_deferred:additive'::text, array[6]),
  array['unsupported:restrictive','ignored_non_safety:none','ignored_non_safety:none']))::text, true);
select extensions.ok(current_setting('t13.aga')::jsonb->>'structuralStatus' = 'complete'
    and current_setting('t13.aga')::jsonb->>'criterionStatus' = 'unresolved'
    and current_setting('t13.aga')::jsonb->>'coverageStatus' = 'unresolved'
    and current_setting('t13.aga')::jsonb->>'positiveStatus' = 'blocked'
    and (current_setting('t13.aga')::jsonb#>>'{dispositionCounts,parsed_deferred}')::integer = 6
    and (current_setting('t13.aga')::jsonb->>'accountedRecords')::integer = 9,
  'deferred rows are all accounted for but never confirmation-ready');

-- ===========================================================================
-- Friedrich-shaped: no table; models in prose; unsupported serial subset
-- ===========================================================================
select pg_temp.recall('Serial', '96105', null);
select set_config('t13.fr', pg_temp.record('96105', pg_temp.ledger('96105', null,
  array['ignored_non_safety:none','unresolved:additive','unsupported:restrictive']))::text, true);
select extensions.ok(current_setting('t13.fr')::jsonb->>'coverageStatus' = 'unresolved'
    and current_setting('t13.fr')::jsonb->>'positiveStatus' = 'blocked'
    and current_setting('t13.fr')::jsonb->'blockers' = to_jsonb(array['description/prose#2']),
  'the unresolved serial subset blocks every positive and every negative conclusion');

-- ===========================================================================
-- Parser-version migration on the same semantic source revision
-- ===========================================================================
select pg_temp.recall('Parser', '96106', 2);
select pg_temp.propose_row('96106', n) from generate_series(1, 2) n;
select pg_temp.approve_row('96106', n) from generate_series(1, 2) n;
select pg_temp.attest('96106');
select set_config('t13.v1', pg_temp.record('96106', pg_temp.ledger('96106',
  array['parsed_reviewable:none','parsed_reviewable:none'], p_parser => 'phase-16.13-structured-v2'))::text, true);
select set_config('t13.touch_before', (select ctid::text from public.recall_notices where id = pg_temp.id('1096106')), true);
select set_config('t13.v2', pg_temp.record('96106', pg_temp.ledger('96106',
  array['parsed_reviewable:none','parsed_reviewable:none'], p_parser => 'phase-16.14-structured-v3'))::text, true);
select extensions.ok(current_setting('t13.v2')::jsonb->>'status' = 'created'
    and not (current_setting('t13.v2')::jsonb->>'interpretationChanged')::boolean
    and current_setting('t13.v2')::jsonb->>'coverageFingerprint' <> current_setting('t13.v1')::jsonb->>'coverageFingerprint'
    and current_setting('t13.v2')::jsonb->>'interpretationFingerprint' = current_setting('t13.v1')::jsonb->>'interpretationFingerprint',
  'new parser, same interpretation: new coverage fingerprint, same interpretation fingerprint');
select extensions.ok(jsonb_array_length(pg_temp.envelope('96106')->'ruleSets') = 2
    and (pg_temp.envelope('96106')->'coverage'->>'complete')::boolean
    and (select count(*) from private.cpsc_candidate_review_ledger l
      join private.cpsc_candidate_criteria c on c.id = l.candidate_id
      where c.revision_id = pg_temp.id('4096106') and l.decision = 'stale') = 0,
  'same interpretation: no reviewer invalidation, coverage stays complete');
select set_config('t13.v3', pg_temp.record('96106', pg_temp.ledger('96106',
  array['parsed_reviewable:none','unresolved:additive'], p_parser => 'phase-16.14-structured-v4'))::text, true);
select extensions.ok((current_setting('t13.v3')::jsonb->>'interpretationChanged')::boolean
    and jsonb_array_length(pg_temp.envelope('96106')->'ruleSets') = 1
    and not (pg_temp.envelope('96106')->'coverage'->>'complete')::boolean,
  'new parser, different criterion universe: the old proof is insufficient; fail closed');
-- now() is constant inside this transaction, so the new tuple version proves the touch.
select extensions.ok((select ctid::text from public.recall_notices where id = pg_temp.id('1096106'))
    <> current_setting('t13.touch_before'),
  'a recorded ledger advances the notice revision for in-flight claims');
select set_config('t13.v4', pg_temp.record('96106', pg_temp.ledger('96106',
  array['parsed_reviewable:none','parsed_reviewable:none'], array['unsupported:restrictive'],
  p_parser => 'phase-16.14-structured-v5'))::text, true);
select extensions.is(pg_temp.envelope('96106'), null,
  'a later ledger that finds a restriction blocks every served rule set');

-- ===========================================================================
-- No ledger and stale revisions
-- ===========================================================================
select pg_temp.recall('NoLedger', '96107', 1);
select pg_temp.propose_row('96107', 1);
select pg_temp.approve_row('96107', 1);
select extensions.ok(jsonb_array_length(pg_temp.envelope('96107')->'ruleSets') = 1
    and not (pg_temp.envelope('96107')->'coverage'->>'complete')::boolean
    and pg_temp.envelope('96107')->'coverage'->'sourceCoverage'->>'state' = 'missing',
  'without a ledger coverage is missing: positives only, never a negative');
insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,canonical_url,title,
  section_hashes,normalized_evidence,parser_version,first_seen_at,last_seen_at,table_identities)
select pg_temp.id('4196107'), identity_id, pg_temp.revision_hash('96107', 2), recall_number, canonical_url,
  title, '{}', normalized_evidence, parser_version, now(), now(), table_identities
from private.cpsc_page_revisions where id = pg_temp.id('4096107');
select extensions.throws_ok(format($$select pg_temp.record('96107', %L::jsonb, %L::uuid)$$,
  pg_temp.ledger('96107', array['parsed_reviewable:none']), pg_temp.id('4096107')), null,
  'CPSC coverage requires the current source revision', 'a ledger for a stale revision is refused');

select * from extensions.finish();
rollback;
