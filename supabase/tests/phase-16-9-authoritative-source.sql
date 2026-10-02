begin;
set local role postgres;
set local search_path = extensions, public, auth;
create extension if not exists pgtap with schema extensions;
select extensions.plan(24);

select extensions.has_table('private', 'cpsc_source_identities', 'stable source identity exists');
select extensions.has_table('private', 'cpsc_source_aliases', 'source aliases exist');
select extensions.has_table('private', 'cpsc_api_revisions', 'API revisions exist');
select extensions.has_table('private', 'cpsc_page_revisions', 'semantic page revisions exist');
select extensions.has_table('private', 'cpsc_page_fetches', 'HTTP observations exist');
select extensions.has_table('private', 'cpsc_candidate_criteria', 'unreviewed proposals exist');
select extensions.has_table('private', 'cpsc_candidate_review_ledger', 'human review ledger exists');

select extensions.ok(relrowsecurity, 'identities have RLS') from pg_class where oid = 'private.cpsc_source_identities'::regclass;
select extensions.ok(relrowsecurity, 'aliases have RLS') from pg_class where oid = 'private.cpsc_source_aliases'::regclass;
select extensions.ok(relrowsecurity, 'API revisions have RLS') from pg_class where oid = 'private.cpsc_api_revisions'::regclass;
select extensions.ok(relrowsecurity, 'revisions have RLS') from pg_class where oid = 'private.cpsc_page_revisions'::regclass;
select extensions.ok(relrowsecurity, 'fetches have RLS') from pg_class where oid = 'private.cpsc_page_fetches'::regclass;
select extensions.ok(relrowsecurity, 'candidates have RLS') from pg_class where oid = 'private.cpsc_candidate_criteria'::regclass;
select extensions.ok(relrowsecurity, 'ledger has RLS') from pg_class where oid = 'private.cpsc_candidate_review_ledger'::regclass;

select extensions.ok(not has_table_privilege('anon', 'private.cpsc_candidate_criteria', 'INSERT'), 'anonymous users cannot propose criteria');
select extensions.ok(not has_table_privilege('authenticated', 'private.cpsc_candidate_review_ledger', 'INSERT'), 'consumer role cannot approve');
select extensions.ok(not has_table_privilege('service_role', 'private.cpsc_candidate_review_ledger', 'INSERT'), 'ingestion worker cannot approve');
-- Phase 16.11: page fetches are recorded only through the validated worker RPC.
select extensions.ok(not has_function_privilege('service_role', 'public.record_cpsc_page_fetch(uuid,uuid,timestamptz,integer,text,text,text,text,text,jsonb,text)', 'EXECUTE'), 'shared service role cannot record page fetches directly');

select extensions.is(
  (select column_default from information_schema.columns
   where table_schema = 'private' and table_name = 'cpsc_candidate_criteria' and column_name = 'status'),
  '''unreviewed''::text',
  'candidate defaults to unreviewed'
);
select extensions.ok(
  not exists (select 1 from pg_policies where schemaname = 'private' and tablename like 'cpsc_%'),
  'no consumer policies expose source or review rows'
);
select extensions.ok(
  not exists (
    select 1 from pg_depend d
    join pg_class c on c.oid = d.refobjid
    join pg_rewrite rewrite on rewrite.oid = d.objid
    join pg_class view_relation on view_relation.oid = rewrite.ev_class
    join pg_namespace view_schema on view_schema.oid = view_relation.relnamespace
    where c.relname in ('cpsc_candidate_criteria', 'cpsc_candidate_review_ledger')
      and d.classid = 'pg_rewrite'::regclass
      and (view_schema.nspname, view_relation.relname) <>
        ('private', 'cpsc_current_reviewed_criteria')
  ),
  'candidate and review tables only feed the restricted current-review view'
);
select extensions.is((select count(*) from private.recall_scope_criteria_v2), 0::bigint, 'no reviewed binding created');
select extensions.is((select count(*) from private.recall_match_evaluations_v2), 0::bigint, 'no v2 evaluation created');
select extensions.is((select count(*) from private.recall_alert_eligibility_v2), 0::bigint, 'no eligibility created');

select * from extensions.finish();
rollback;
