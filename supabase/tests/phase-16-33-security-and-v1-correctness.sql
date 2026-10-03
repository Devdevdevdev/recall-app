begin;
set local role postgres;
set local search_path = extensions, public, auth;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

-- Phase 17.7a F-4 test seam. This suite exercises alert mechanics on fixtures whose
-- official scope is not human-reviewed. F-4 (an automatic alert needs a proven
-- complete official scope) is covered by phase-17-7a-f4-automatic-alert-safety.sql;
-- here the proof is granted only inside this rolled-back transaction.
create or replace function private.automatic_alert_eligibility(
  p_owned_product_id uuid, p_recall_notice_id uuid)
returns text language sql stable security definer set search_path = ''
as $f4$ select 'eligible'::text $f4$;

grant usage on schema extensions to cpsc_page_worker;

create function pg_temp.id(p_suffix text) returns uuid language sql immutable as $$
  select ('16330000-0000-4000-8000-' || lpad(p_suffix, 12, '0'))::uuid;
$$;
create function pg_temp.hex(p_seed text) returns text language sql immutable as $$
  select encode(sha256(convert_to(p_seed, 'UTF8')), 'hex');
$$;
-- aal2 claims carry the fixture session (session id = user id).
create function pg_temp.act(p_role text, p_sub text default null, p_aal text default 'aal2')
returns void language sql as $$
  select set_config('request.jwt.claims', (jsonb_build_object('role', p_role) ||
    case when p_sub is null then '{}'::jsonb
      else jsonb_build_object('sub', pg_temp.id(p_sub), 'aal', p_aal,
        'session_id', pg_temp.id(p_sub)) end)::text, true);
$$;
create function pg_temp.done() returns void language sql as $$
  select set_config('request.jwt.claims', '', true);
$$;

-- ===========================================================================
-- Catalog and privilege boundary for every Phase 16.33 object.
-- ===========================================================================
select extensions.ok(c.relrowsecurity and not exists (select 1 from pg_policies p
    where p.schemaname = 'private' and p.tablename = c.relname),
  format('private.%s has RLS and no policy', c.relname))
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'private' and c.relname in ('recall_automation_matching_outcomes',
  'scheduler_invocation_tickets', 'cpsc_outside_census_attestations');
select extensions.ok(not has_table_privilege(r, format('private.%s', t), p),
  format('%s has no %s on private.%s', r, p, t))
from unnest(array['anon', 'authenticated', 'service_role', 'cpsc_page_worker']) r,
  unnest(array['recall_automation_matching_outcomes', 'scheduler_invocation_tickets',
    'cpsc_outside_census_attestations', 'recall_automation_pending_recalls']) t,
  unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p;
select extensions.ok(has_function_privilege('service_role', f, 'EXECUTE')
    and not has_function_privilege('anon', f, 'EXECUTE')
    and not has_function_privilege('authenticated', f, 'EXECUTE')
    and not has_function_privilege('cpsc_page_worker', f, 'EXECUTE'),
  format('only service_role executes %s', f))
from unnest(array[
  'public.record_recall_automation_matching_outcome(uuid,uuid,uuid[],jsonb,integer,integer,integer,integer,integer,integer,integer,integer)',
  'public.get_recall_automation_pending_recalls(uuid,uuid,integer)',
  'public.consume_recall_automation_ticket(text)']) f;
select extensions.ok(has_function_privilege('cpsc_page_worker',
    'public.consume_cpsc_page_stage_ticket(text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.consume_cpsc_page_stage_ticket(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.consume_cpsc_page_stage_ticket(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.consume_cpsc_page_stage_ticket(text)', 'EXECUTE'),
  'only the dedicated page worker consumes a page-stage ticket');
select extensions.ok(has_function_privilege('authenticated', f, 'EXECUTE')
    and not has_function_privilege('anon', f, 'EXECUTE')
    and not has_function_privilege('service_role', f, 'EXECUTE')
    and not has_function_privilege('cpsc_page_worker', f, 'EXECUTE'),
  format('only authenticated humans reach %s (gated inside)', f))
from unnest(array['public.get_cpsc_outside_census_packet(uuid)',
  'public.attest_cpsc_outside_census(uuid,text,jsonb,text,integer)']) f;
select extensions.ok(not has_function_privilege(r, f, 'EXECUTE'), format('%s cannot execute %s', r, f))
from unnest(array['anon', 'authenticated', 'service_role', 'cpsc_page_worker']) r,
  unnest(array['private.recall_automation_pending_status(timestamptz)',
    'private.consume_scheduler_ticket(text,text,text)', 'private.scheduler_ticket_hash(text)',
    'private.recall_automation_tick()', 'private.convert_recall_automation_cron_to_tickets()',
    'private.scheduler_invocation_status(timestamptz)', 'private.cpsc_session_mfa_verified()',
    'private.cpsc_has_capability(text)', 'private.cpsc_is_human_reviewer()',
    'private.cpsc_outside_census_sections(uuid)', 'private.cpsc_outside_census_sha256(uuid)',
    'private.cpsc_outside_census_attested(uuid,timestamptz)',
    'private.cpsc_page_stage_tick()', 'private.install_cpsc_page_stage_cron()']) f;

-- ===========================================================================
-- pg_net and Vault privilege evidence. The queue grants are platform-owned:
-- the project owner cannot revoke them, so the design must not rely on them.
-- ===========================================================================
select extensions.ok((select pg_get_userbyid(relowner) = 'supabase_admin'
    and relacl::text like '%=arwdDxtm/supabase_admin%'
  from pg_class where oid = 'net.http_request_queue'::regclass),
  'evidence: net.http_request_queue is owned by supabase_admin and granted to PUBLIC');
select extensions.ok(has_table_privilege(r, 'net.http_request_queue', 'SELECT')
    and has_table_privilege(r, 'net.http_request_queue', 'UPDATE')
    and has_table_privilege(r, 'net.http_request_queue', 'DELETE')
    and has_table_privilege(r, 'net._http_response', 'SELECT'),
  format('evidence: %s can read, alter and delete queued requests and read responses', r))
from unnest(array['anon', 'authenticated', 'cpsc_page_worker']) r;
-- net.http_post EXECUTE differs by image: explicit role grants locally, the
-- PUBLIC default (NULL ACL) in production. The production value is recorded
-- in the 16.33 report; here only the API roles are asserted.
select extensions.ok(has_function_privilege(r, 'net.http_post(text,jsonb,jsonb,jsonb,integer)', 'EXECUTE'),
  format('evidence: %s can send HTTP through pg_net', r))
from unnest(array['anon', 'authenticated']) r;
select extensions.lives_ok($$revoke all on net.http_request_queue from public$$,
  'the owner may issue a revoke on the queue');
select extensions.ok(has_table_privilege('cpsc_page_worker', 'net.http_request_queue', 'SELECT'),
  'but the revoke has no effect: only supabase_admin holds the grant option');
select extensions.ok(not has_table_privilege(r, 'vault.decrypted_secrets', 'SELECT'),
  format('%s cannot read decrypted Vault secrets', r))
from unnest(array['anon', 'authenticated', 'cpsc_page_worker']) r;
select extensions.ok(has_table_privilege('service_role', 'vault.decrypted_secrets', 'SELECT'),
  'evidence: service_role can read decrypted Vault secrets (platform grant)');

-- ===========================================================================
-- Fixtures: humans with live MFA sessions, CPSC source, owned products.
-- ===========================================================================
insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select pg_temp.id(s),'authenticated','authenticated',e,'','2099-01-01','{}','{}',now(),now()
from (values ('901','p1633-operator@example.test'), ('902','p1633-reconciler@example.test'),
  ('903','p1633-reviewer@example.test'), ('904','p1633-owner-a@example.test'),
  ('905','p1633-owner-b@example.test'), ('906','p1633-reviewer-two@example.test')) u(s, e);
insert into auth.sessions (id, user_id, aal, created_at, updated_at)
select id, id, 'aal2', now(), now() from auth.users where email like 'p1633-%@example.test';
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at,
  updated_at)
select id, id, 'pgTAP TOTP', 'totp', 'verified', now(), now()
from auth.users where email like 'p1633-%@example.test';
insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
select gen_random_uuid(), id, 'totp', now(), now()
from auth.users where email like 'p1633-%@example.test';
insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason) values
  (pg_temp.id('901'), 'operational_scheduler_control', now() - interval '1 hour', 'pgTAP operator'),
  (pg_temp.id('902'), 'identity_reconciliation', now() - interval '1 hour', 'pgTAP reconciler');
insert into private.cpsc_reviewer_authorizations (user_id, authorized_at, reason) values
  (pg_temp.id('903'), now() - interval '1 hour', 'pgTAP criterion reviewer'),
  (pg_temp.id('906'), now() - interval '1 hour', 'pgTAP second reviewer');
select set_config('t33.source', public.ensure_cpsc_recall_source()::text, true);

-- ===========================================================================
-- Server-verified MFA for every human capability.
-- ===========================================================================
create function pg_temp.cap(p_capability text) returns boolean language sql as $$
  select private.cpsc_has_capability(p_capability);
$$;
select pg_temp.act('authenticated', '901');
select extensions.ok(pg_temp.cap('operational_scheduler_control'),
  'an operator in a live aal2 session with a fresh MFA step holds the capability');
select pg_temp.act('authenticated', '901', 'aal1');
select extensions.ok(not pg_temp.cap('operational_scheduler_control'),
  'a password-only (aal1) token is refused');
select extensions.throws_ok($$select public.start_cpsc_page_stage('aal1', 1, 1, 1, 1)$$, '42501',
  null, 'an aal1 operator cannot start the page stage');
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated',
  'sub', pg_temp.id('901'), 'aal', 'aal2')::text, true);
select extensions.ok(not pg_temp.cap('operational_scheduler_control'),
  'an aal2 claim without a session is refused');
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated',
  'sub', pg_temp.id('901'), 'aal', 'aal2', 'session_id', pg_temp.id('903'))::text, true);
select extensions.ok(not pg_temp.cap('operational_scheduler_control'),
  'another user''s session is refused');
select pg_temp.act('authenticated', '901');
update auth.sessions set aal = 'aal1' where id = pg_temp.id('901');
select extensions.ok(not pg_temp.cap('operational_scheduler_control'),
  'a token claiming aal2 over an aal1 session row is refused');
update auth.sessions set aal = 'aal2', not_after = now() - interval '1 second'
where id = pg_temp.id('901');
select extensions.ok(not pg_temp.cap('operational_scheduler_control'), 'an expired session is refused');
update auth.sessions set not_after = null where id = pg_temp.id('901');
update auth.mfa_amr_claims set updated_at = now() - interval '13 hours'
where session_id = pg_temp.id('901');
select extensions.ok(not pg_temp.cap('operational_scheduler_control'),
  'an MFA step older than 12 hours is refused');
update auth.mfa_amr_claims set updated_at = now() where session_id = pg_temp.id('901');
update auth.mfa_factors set status = 'unverified' where user_id = pg_temp.id('901');
select extensions.ok(not pg_temp.cap('operational_scheduler_control'),
  'a user without a verified factor is refused');
update auth.mfa_factors set status = 'verified' where user_id = pg_temp.id('901');
select extensions.ok(pg_temp.cap('operational_scheduler_control'), 'restored session is accepted');
delete from auth.mfa_amr_claims where session_id = pg_temp.id('905');
delete from auth.sessions where id = pg_temp.id('905');
insert into private.cpsc_admin_capabilities (user_id, capability, authorized_at, reason)
values (pg_temp.id('905'), 'decision_invalidation', now() - interval '1 hour', 'pgTAP signed out');
select pg_temp.act('authenticated', '905');
select extensions.ok(not pg_temp.cap('decision_invalidation'),
  'signing out (session deleted) ends the authority at once');
select pg_temp.act('anon');
select extensions.ok(not pg_temp.cap('operational_scheduler_control'), 'anon holds nothing');
select pg_temp.act('service_role');
select extensions.ok(not pg_temp.cap('operational_scheduler_control')
    and not private.cpsc_is_human_reviewer(), 'service_role holds no human capability');
select pg_temp.act('authenticated', '903');
select extensions.ok(private.cpsc_is_human_reviewer(), 'the criterion reviewer with MFA reviews');
select pg_temp.act('authenticated', '903', 'aal1');
select extensions.ok(not private.cpsc_is_human_reviewer(), 'an aal1 reviewer is refused');
select extensions.throws_ok($$select public.list_cpsc_pending_review_candidates(10, null)$$,
  '42501', null, 'an aal1 reviewer cannot read the review queue');
-- Capabilities stay distinct under MFA.
select pg_temp.act('authenticated', '903');
select extensions.ok(not pg_temp.cap('operational_scheduler_control')
    and not pg_temp.cap('identity_reconciliation'), 'a reviewer holds no operator or reconciler capability');
select pg_temp.act('authenticated', '901');
select extensions.ok(not private.cpsc_is_human_reviewer() and not pg_temp.cap('identity_reconciliation'),
  'an operator is neither a reviewer nor a reconciler');
select extensions.throws_ok($$select public.get_cpsc_outside_census_packet(gen_random_uuid())$$,
  '42501', null, 'an operator cannot read an outside-census packet');
select pg_temp.act('authenticated', '902');
select extensions.throws_ok($$select public.start_cpsc_page_stage('reconciler', 1, 1, 1, 1)$$,
  '42501', null, 'a reconciler cannot start the page stage');
select pg_temp.done();

-- ===========================================================================
-- v1 durable matching work. Real Phase 10/12 RPCs, a non-empty inventory,
-- and the real page-evidence notice touch.
-- ===========================================================================
create function pg_temp.notice(p_number text) returns uuid language sql as $$
  insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
    recall_date,official_url,retrieved_at,raw_payload,created_at,updated_at)
  values (pg_temp.id('10' || p_number), current_setting('t33.source')::uuid, 'cpsc:' || p_number,
    'Recall ' || p_number, 'Desc', 'Hazard', 'Refund', '2026-09-20',
    'https://www.cpsc.gov/Recalls/2026/P1633-' || p_number, now() - interval '1 day',
    jsonb_build_object('RecallNumber', p_number), now() - interval '1 day',
    now() - interval '1 hour')
  returning id;
$$;
select pg_temp.notice(n) from unnest(array['33001', '33002', '33003', '33004']) n;
insert into public.recall_scopes (recall_notice_id, product_name, model_number)
select pg_temp.id('10' || n), 'Grill ' || n, 'M-' || n
from unnest(array['33001', '33002', '33003', '33004']) n;
insert into private.cpsc_source_identities (id,source_id,official_recall_number,canonical_url,
  canonical_notice_id,identity_status)
values (pg_temp.id('3033001'), current_setting('t33.source')::uuid, '33001',
  'https://www.cpsc.gov/Recalls/2026/P1633-33001', pg_temp.id('1033001'), 'reconciled');
insert into private.cpsc_notice_identity_links (notice_id,identity_id,provenance)
values (pg_temp.id('1033001'), pg_temp.id('3033001'), 'Phase 16.33 pgTAP');
insert into public.owned_products (id, user_id, product_name, model_number, updated_at) values
  (pg_temp.id('5001'), pg_temp.id('904'), 'Grill 33001', 'M-33001', now() - interval '2 hours'),
  (pg_temp.id('5002'), pg_temp.id('905'), 'Grill 33001', 'M-33001', now() - interval '2 hours'),
  (pg_temp.id('5003'), pg_temp.id('904'), 'Grill 33002', 'M-33002', now() - interval '2 hours'),
  (pg_temp.id('5004'), pg_temp.id('905'), 'Unrelated', 'X-1', now() - interval '2 hours');
select extensions.is((select count(*) from public.owned_products
  where user_id in (pg_temp.id('904'), pg_temp.id('905'))), 4::bigint,
  'the inventory is not empty');

update private.recall_automation_control set enabled = true, updated_at = now() where singleton;
create function pg_temp.run() returns jsonb language plpgsql as $$
declare v jsonb;
begin
  select to_jsonb(c) into v from public.claim_recall_automation_run('manual', false, 20, 200, 0, 10,
    now(), 1800) c;
  return v;
end $$;
create function pg_temp.fp(p_seed text) returns text language sql immutable as $$
  select pg_temp.hex('p1633-fingerprint:' || p_seed);
$$;
create function pg_temp.claim(p_product text, p_number text, p_seed text) returns jsonb
language sql as $$
  select to_jsonb(c) from public.claim_recall_match_evaluation(pg_temp.id(p_product),
    pg_temp.id('10' || p_number), pg_temp.fp(p_seed),
    (select updated_at from public.owned_products where id = pg_temp.id(p_product)),
    (select updated_at from public.recall_notices where id = pg_temp.id('10' || p_number)), 120) c;
$$;
create function pg_temp.finalize(p_product text, p_number text, p_seed text, p_lease uuid,
  p_recall_seen timestamptz) returns jsonb language sql as $$
  select to_jsonb(f) from public.finalize_recall_match_evaluation(pg_temp.id(p_product),
    pg_temp.id('10' || p_number), pg_temp.fp(p_seed),
    (select updated_at from public.owned_products where id = pg_temp.id(p_product)),
    p_recall_seen, p_lease, 'confirmed', 0.99, 'deterministic_v1', '{"model": true}',
    'pgTAP deterministic confirmation', null, null, 'recall-match-evaluation/v1') f;
$$;
create function pg_temp.outcome(p_run jsonb, p_resolved uuid[], p_unresolved jsonb) returns jsonb
language sql as $$
  select public.record_recall_automation_matching_outcome((p_run->>'run_id')::uuid,
    (p_run->>'lease_token')::uuid, p_resolved, p_unresolved, 1, 0, 0, 0, 0, 0, 0, 0);
$$;
create function pg_temp.pending() returns text[] language sql as $$
  select coalesce(array_agg(n.external_id order by n.external_id), '{}')
  from private.recall_automation_pending_recalls p
  join public.recall_notices n on n.id = p.recall_notice_id;
$$;

-- Run 1: ingestion affects 33001-33004 and advances the watermark in the same
-- transaction that records them as pending.
select set_config('t33.run1', pg_temp.run()::text, true);
select extensions.is(current_setting('t33.run1')::jsonb->>'claim_status', 'claimed', 'run 1 claims');
select public.record_recall_automation_ingestion((current_setting('t33.run1')::jsonb->>'run_id')::uuid,
  (current_setting('t33.run1')::jsonb->>'lease_token')::uuid, 4, 4, 0, 0,
  array[pg_temp.id('1033001'), pg_temp.id('1033002'), pg_temp.id('1033003'), pg_temp.id('1033004')]);
select extensions.is(pg_temp.pending(), array['cpsc:33001','cpsc:33002','cpsc:33003','cpsc:33004'],
  'ingestion records every affected recall as pending');
select set_config('t33.watermark', (select last_successful_watermark::text
  from private.recall_automation_state), true);

-- The defect, step by step: matching reads 33001, claims the pair, then the
-- page ledger touches the notice before finalization.
select set_config('t33.seen', (select updated_at::text from public.recall_notices
  where id = pg_temp.id('1033001')), true);
select set_config('t33.c1', pg_temp.claim('5001', '33001', 'a')::text, true);
select extensions.is(current_setting('t33.c1')::jsonb->>'status', 'claimed',
  'matching claims the owned-product / recall pair');
select extensions.is(private.cpsc_touch_identity_notices(pg_temp.id('3033001')), 1,
  'the page ledger touches the linked notice (16.13 cpsc_touch_identity_notices)');
select extensions.ok((select updated_at from public.recall_notices where id = pg_temp.id('1033001'))
    > current_setting('t33.seen')::timestamptz, 'recall_notices.updated_at advanced');
select extensions.is(pg_temp.finalize('5001', '33001', 'a',
    (current_setting('t33.c1')::jsonb->>'lease_token')::uuid,
    current_setting('t33.seen')::timestamptz)->>'status', 'stale',
  'finalization detects the stale recall version');
select extensions.is((select count(*) from public.recall_matches
  where owned_product_id = pg_temp.id('5001')), 0::bigint, 'the stale pair wrote no match');
select extensions.is((select status from public.claim_recall_match_evaluation(pg_temp.id('5002'),
    pg_temp.id('1033001'), pg_temp.fp('b'),
    (select updated_at from public.owned_products where id = pg_temp.id('5002')),
    current_setting('t33.seen')::timestamptz, 120)), 'stale',
  'a claim taken with the pre-touch version is stale too');

-- Root cause, reproduced with the Phase 12 RPC the deployed automation uses:
-- stale pairs do not make the run incomplete, so the batch is acknowledged.
savepoint phase12_defect;
select public.record_recall_automation_matching((current_setting('t33.run1')::jsonb->>'run_id')::uuid,
  (current_setting('t33.run1')::jsonb->>'lease_token')::uuid,
  array[pg_temp.id('1033001'), pg_temp.id('1033002'), pg_temp.id('1033003'), pg_temp.id('1033004')],
  true, 2, 0, 0, 0, 0, 0, 0, 0);
select extensions.ok(not ('cpsc:33001' = any(pg_temp.pending()))
    and (select count(*) from public.recall_matches where recall_notice_id = pg_temp.id('1033001')) = 0
    and (select last_successful_watermark::text from private.recall_automation_state)
      = current_setting('t33.watermark'),
  'DEFECT (Phase 12 path): 33001 leaves pending with no match while the watermark has passed it');
rollback to savepoint phase12_defect;

-- 33002: one product claims and finalizes normally. 33003 has a busy pair.
select set_config('t33.c3', pg_temp.claim('5003', '33002', 'c')::text, true);
select extensions.is(pg_temp.finalize('5003', '33002', 'c',
    (current_setting('t33.c3')::jsonb->>'lease_token')::uuid,
    (select updated_at from public.recall_notices where id = pg_temp.id('1033002')))->>'status',
  'finalized', 'an unrelated recall finalizes normally');
insert into private.recall_matching_leases (owned_product_id, recall_notice_id,
  evidence_fingerprint, lease_token, lease_expires_at)
values (pg_temp.id('5004'), pg_temp.id('1033003'), pg_temp.fp('d'), gen_random_uuid(),
  now() + interval '5 minutes');
select extensions.is(pg_temp.claim('5004', '33003', 'd')->>'status', 'busy',
  'a concurrent execution holding the pair makes it busy');

-- The correction: per-recall outcome. Only resolved recalls leave pending.
select set_config('t33.o1', pg_temp.outcome(current_setting('t33.run1')::jsonb,
  array[pg_temp.id('1033002'), pg_temp.id('1033004')],
  jsonb_build_array(jsonb_build_object('recallNoticeId', pg_temp.id('1033001'), 'reason', 'stale'),
    jsonb_build_object('recallNoticeId', pg_temp.id('1033003'), 'reason', 'busy')))::text, true);
select extensions.is(current_setting('t33.o1')::jsonb,
  '{"deleted": 2, "resolved": 2, "retained": 2, "exhausted": 0}'::jsonb,
  'two recalls resolve and two stay pending');
select extensions.is(pg_temp.pending(), array['cpsc:33001', 'cpsc:33003'],
  'stale and busy work stays pending; unchanged and unrelated work is acknowledged');
select extensions.ok((select unresolved_attempts = 1 and last_unresolved_reason = 'stale'
    and exhausted_at is null and attempt_count = 1
  from private.recall_automation_pending_recalls where recall_notice_id = pg_temp.id('1033001')),
  'the stale recall records one bounded, observable retry');
select extensions.is((select array_agg(outcome || ':' || coalesce(reason, '-') order by outcome_seq)
    from private.recall_automation_matching_outcomes
    where run_id = (current_setting('t33.run1')::jsonb->>'run_id')::uuid),
  array['resolved:-', 'resolved:-', 'retained:stale', 'retained:busy'],
  'every recall of the run has one durable outcome row');
select extensions.is((select last_successful_watermark::text from private.recall_automation_state),
  current_setting('t33.watermark'),
  'the watermark advanced, yet the unresolved work is not discarded');
select extensions.throws_ok(format($$select pg_temp.outcome(%L::jsonb, array[%L::uuid], '[]'::jsonb)$$,
    current_setting('t33.run1'), pg_temp.id('1033001')), null, null,
  'the same run cannot acknowledge a recall twice (duplicate delivery of the record)');

-- Validation fails closed.
select extensions.throws_ok(format($$select pg_temp.outcome(%L::jsonb, array[%L::uuid],
    jsonb_build_array(jsonb_build_object('recallNoticeId', %L, 'reason', 'stale')))$$,
    current_setting('t33.run1'), pg_temp.id('1033003'), pg_temp.id('1033003')),
  null, 'matching work must be resolved or unresolved exactly once',
  'a recall cannot be both resolved and unresolved');
select extensions.throws_ok(format($$select pg_temp.outcome(%L::jsonb, '{}'::uuid[],
    '[{"recallNoticeId": "%s", "reason": "done"}]'::jsonb)$$,
    current_setting('t33.run1'), pg_temp.id('1033003')),
  null, 'invalid unresolved matching work', 'an unknown reason is rejected');
select extensions.throws_ok(format($$select public.record_recall_automation_matching_outcome(
    %L::uuid, gen_random_uuid(), '{}'::uuid[], '[]'::jsonb, 0,0,0,0,0,0,0,0)$$,
    current_setting('t33.run1')::jsonb->>'run_id'),
  null, 'automation run lease is unavailable', 'a wrong lease token cannot record outcomes');
select extensions.throws_ok(format($$select public.record_recall_automation_matching_outcome(
    %L::uuid, %L::uuid, '{}'::uuid[], '[]'::jsonb, -1,0,0,0,0,0,0,0)$$,
    current_setting('t33.run1')::jsonb->>'run_id', current_setting('t33.run1')::jsonb->>'lease_token'),
  null, 'invalid matching metrics', 'negative metrics are rejected');

-- Process termination before retry: run 1 never completes; its lease expires.
update private.recall_automation_lease
set claimed_at = now() - interval '2 hours', expires_at = now() - interval '1 second';
select set_config('t33.run2', pg_temp.run()::text, true);
select extensions.ok(current_setting('t33.run2')::jsonb->>'claim_status' = 'claimed'
    and (select status from private.recall_automation_runs
      where id = (current_setting('t33.run1')::jsonb->>'run_id')::uuid) = 'failed',
  'a terminated run is closed as failed and the next run claims');
select extensions.is((select array_agg(n.external_id order by n.external_id)
  from public.get_recall_automation_pending_recalls((current_setting('t33.run2')::jsonb->>'run_id')::uuid,
    (current_setting('t33.run2')::jsonb->>'lease_token')::uuid, 10) p
  join public.recall_notices n on n.id = p.recall_notice_id),
  array['cpsc:33001', 'cpsc:33003'], 'the next cycle recovers the pending work');

-- Retry: the stale pair now claims against the current version and confirms.
delete from private.recall_matching_leases where owned_product_id = pg_temp.id('5004');
select set_config('t33.seen2', (select updated_at::text from public.recall_notices
  where id = pg_temp.id('1033001')), true);
select set_config('t33.r1', pg_temp.claim('5001', '33001', 'a')::text, true);
select set_config('t33.r2', pg_temp.claim('5002', '33001', 'b')::text, true);
select extensions.ok(current_setting('t33.r1')::jsonb->>'status' = 'claimed'
    and current_setting('t33.r2')::jsonb->>'status' = 'claimed',
  'both previously stale pairs claim on retry');
select extensions.ok(pg_temp.finalize('5001', '33001', 'a',
      (current_setting('t33.r1')::jsonb->>'lease_token')::uuid,
      current_setting('t33.seen2')::timestamptz)->>'alert_outcome' = 'created'
    and pg_temp.finalize('5002', '33001', 'b',
      (current_setting('t33.r2')::jsonb->>'lease_token')::uuid,
      current_setting('t33.seen2')::timestamptz)->>'alert_outcome' = 'created',
  'every legitimate match on the retried recall is confirmed with its alert');
select extensions.is(pg_temp.claim('5001', '33001', 'a')->>'status', 'unchanged',
  'a repeated delivery of the same work is unchanged (idempotent)');
select extensions.is(pg_temp.claim('5004', '33003', 'd')->>'status', 'claimed',
  'the busy pair claims once the other execution is gone');
select pg_temp.outcome(current_setting('t33.run2')::jsonb,
  array[pg_temp.id('1033001'), pg_temp.id('1033003')], '[]'::jsonb);
select extensions.is(pg_temp.pending(), '{}'::text[], 'resolved retries leave the pending set');
select extensions.ok((select count(*) = 3 and count(distinct (owned_product_id, recall_notice_id)) = 3
    from public.recall_matches)
  and (select count(*) from public.alerts) = 3,
  'no match or alert is duplicated (3 matches, 3 alerts)');
select public.complete_recall_automation_run((current_setting('t33.run2')::jsonb->>'run_id')::uuid,
  (current_setting('t33.run2')::jsonb->>'lease_token')::uuid, 'success');

-- Retry exhaustion is explicit, bounded and re-armed by new work.
select set_config('t33.run3', pg_temp.run()::text, true);
select public.record_recall_automation_ingestion((current_setting('t33.run3')::jsonb->>'run_id')::uuid,
  (current_setting('t33.run3')::jsonb->>'lease_token')::uuid, 1, 0, 1, 0, array[pg_temp.id('1033004')]);
update private.recall_automation_pending_recalls set unresolved_attempts = 7
where recall_notice_id = pg_temp.id('1033004');
select extensions.is(pg_temp.outcome(current_setting('t33.run3')::jsonb, '{}'::uuid[],
    jsonb_build_array(jsonb_build_object('recallNoticeId', pg_temp.id('1033004'), 'reason', 'stale')))
    ->>'exhausted', '1', 'the eighth unresolved cycle marks the recall exhausted');
select extensions.ok((select exhausted_at is not null and unresolved_attempts = 8
  from private.recall_automation_pending_recalls where recall_notice_id = pg_temp.id('1033004')),
  'exhaustion is an explicit, durable state, not a deletion');
select extensions.is((select count(*) from public.get_recall_automation_pending_recalls(
    (current_setting('t33.run3')::jsonb->>'run_id')::uuid,
    (current_setting('t33.run3')::jsonb->>'lease_token')::uuid, 10)), 0::bigint,
  'an exhausted recall is not retried again within 24 hours');
update private.recall_automation_pending_recalls
set last_attempted_at = now() - interval '25 hours'
where recall_notice_id = pg_temp.id('1033004');
select extensions.is((select count(*) from public.get_recall_automation_pending_recalls(
    (current_setting('t33.run3')::jsonb->>'run_id')::uuid,
    (current_setting('t33.run3')::jsonb->>'lease_token')::uuid, 10)), 1::bigint,
  'an exhausted recall is retried at most once per day');
select extensions.ok((private.recall_automation_pending_status(now())->>'exhausted')::integer = 1
    and private.recall_automation_pending_status(now())#>>'{reasons,stale}' = '1',
  'exhaustion is observable in the owner status read');
select public.complete_recall_automation_run((current_setting('t33.run3')::jsonb->>'run_id')::uuid,
  (current_setting('t33.run3')::jsonb->>'lease_token')::uuid, 'partial_success', 0, 0, 0,
  'matching', 'matching_retry_pending');
update private.recall_automation_pending_recalls set last_affected_at = now() - interval '1 day'
where recall_notice_id = pg_temp.id('1033004');
select set_config('t33.run4', pg_temp.run()::text, true);
select public.record_recall_automation_ingestion((current_setting('t33.run4')::jsonb->>'run_id')::uuid,
  (current_setting('t33.run4')::jsonb->>'lease_token')::uuid, 1, 0, 1, 0, array[pg_temp.id('1033004')]);
select extensions.ok((select exhausted_at is null and unresolved_attempts = 0
  from private.recall_automation_pending_recalls where recall_notice_id = pg_temp.id('1033004')),
  'a new authoritative change re-arms an exhausted recall');
select public.complete_recall_automation_run((current_setting('t33.run4')::jsonb->>'run_id')::uuid,
  (current_setting('t33.run4')::jsonb->>'lease_token')::uuid, 'success');
select extensions.throws_ok($$delete from private.recall_automation_matching_outcomes$$, '42501',
  null, 'outcome history is append-only');

-- ===========================================================================
-- Scheduler invocation tickets.
-- ===========================================================================
select vault.create_secret('http://kong:8000/functions/v1/run-recall-automation',
  'recall_automation_url', 'pgTAP');
select vault.create_secret('pgtap-static-automation-key', 'recall_automation_key', 'pgTAP');
select extensions.is(private.recall_automation_tick()->>'decision', 'dispatched',
  'the v1 ticket tick dispatches one request');
select set_config('t33.v1ticket', (select q.headers->>'x-recall-automation-ticket'
  from private.scheduler_invocation_tickets k join net.http_request_queue q on q.id = k.request_id
  where k.job = 'recall_automation' order by k.ticket_seq desc limit 1), true);
select extensions.ok((select current_setting('t33.v1ticket') ~ '^[0-9a-f]{64}$'
    and not q.headers ? 'x-recall-automation-key'
    and q.headers::text not like '%pgtap-static-automation-key%'
    and convert_from(q.body, 'UTF8') = '{"trigger": "cron"}'
  from private.scheduler_invocation_tickets k join net.http_request_queue q on q.id = k.request_id
  where k.job = 'recall_automation'),
  'the v1 request carries a single-use ticket and never the static automation key');
select extensions.ok((select ticket_sha256 = private.scheduler_ticket_hash(current_setting('t33.v1ticket'))
    and to_jsonb(k)::text not like '%' || current_setting('t33.v1ticket') || '%'
  from private.scheduler_invocation_tickets k where job = 'recall_automation'),
  'only the ticket hash is stored');
select vault.update_secret(id, 'https://attacker.example/functions/v1/run-recall-automation')
from vault.secrets where name = 'recall_automation_url';
select extensions.throws_ok($$select private.recall_automation_tick()$$, null,
  'Recall automation endpoint is unavailable or not pinned',
  'a tampered Vault URL never receives a ticket');
select vault.update_secret(id, 'http://kong:8000/functions/v1/run-recall-automation')
from vault.secrets where name = 'recall_automation_url';

set local role service_role;
select extensions.is(public.consume_recall_automation_ticket(current_setting('t33.v1ticket')),
  '{"accepted": true, "trigger": "cron"}'::jsonb, 'the automation function consumes the ticket once');
select extensions.is(public.consume_recall_automation_ticket(current_setting('t33.v1ticket'))->>'reason',
  'replayed', 'a replayed ticket is refused');
select extensions.is(public.consume_recall_automation_ticket(repeat('0', 64))->>'reason', 'unknown',
  'an unknown ticket is refused');
select extensions.is(public.consume_recall_automation_ticket('not-a-ticket')->>'reason', 'malformed',
  'a malformed ticket is refused');
reset role;
set local role postgres;
select extensions.is((select rejected_attempts from private.scheduler_invocation_tickets
  where job = 'recall_automation'), 1, 'the replay attempt is counted');

-- Page-stage tickets: expiry, wrong job, stop, and the worker-only boundary.
insert into private.scheduler_invocation_tickets (job, ticket_sha256, parameters, request_id,
  expires_at, issued_at) values
  ('cpsc_page_stage', private.scheduler_ticket_hash(repeat('a', 64)),
    '{"maxPages": 2, "timeBudgetMs": 20000}', 0, now() + interval '120 seconds', now()),
  ('cpsc_page_stage', private.scheduler_ticket_hash(repeat('b', 64)),
    '{"maxPages": 2, "timeBudgetMs": 20000}', 0, now() - interval '1 second',
    now() - interval '121 seconds'),
  ('cpsc_page_stage', private.scheduler_ticket_hash(repeat('c', 64)),
    '{"maxPages": 2, "timeBudgetMs": 20000}', 0, now() + interval '120 seconds', now());
select pg_temp.act('authenticated', '901');
select public.start_cpsc_page_stage('pgTAP ticket start', 1, 2, 4, 48);
select pg_temp.done();
set local role cpsc_page_worker;
select extensions.is(public.consume_cpsc_page_stage_ticket(repeat('a', 64)),
  '{"accepted": true, "maxPages": 2, "timeBudgetMs": 20000}'::jsonb,
  'the page worker consumes its ticket and receives DB-held bounds');
select extensions.is(public.consume_cpsc_page_stage_ticket(repeat('a', 64))->>'reason', 'replayed',
  'the page ticket is single-use');
select extensions.is(public.consume_cpsc_page_stage_ticket(repeat('b', 64))->>'reason', 'expired',
  'an expired page ticket is refused');
select extensions.throws_ok(format($$select public.consume_recall_automation_ticket(%L)$$,
  repeat('c', 64)), '42501', null, 'the page worker cannot consume a v1 ticket');
reset role;
set local role service_role;
select extensions.is(public.consume_recall_automation_ticket(repeat('c', 64))->>'reason', 'wrong_job',
  'a page ticket never authorizes a v1 run');
select extensions.throws_ok(format($$select public.consume_cpsc_page_stage_ticket(%L)$$,
  repeat('c', 64)), '42501', null, 'service_role cannot consume a page ticket');
reset role;
set local role postgres;
select private.stop_cpsc_page_stage_as_owner('pgTAP ticket stop');
insert into private.scheduler_invocation_tickets (job, ticket_sha256, parameters, request_id,
  expires_at) values ('cpsc_page_stage', private.scheduler_ticket_hash(repeat('d', 64)),
  '{"maxPages": 2, "timeBudgetMs": 20000}', 0, now() + interval '120 seconds');
set local role cpsc_page_worker;
select extensions.is(public.consume_cpsc_page_stage_ticket(repeat('d', 64))->>'reason',
  'stage_not_running', 'a ticket issued before a stop authorizes nothing (kill switch)');
reset role;
set local role postgres;
select extensions.throws_ok($$update private.scheduler_invocation_tickets set parameters =
  '{"maxPages": 10}' where ticket_sha256 = private.scheduler_ticket_hash(repeat('c', 64))$$,
  '42501', null, 'ticket bounds cannot be rewritten');
select extensions.throws_ok($$update private.scheduler_invocation_tickets set consumed_at = null,
  consumer = null where ticket_sha256 = private.scheduler_ticket_hash(repeat('a', 64))$$,
  '42501', null, 'a consumed ticket cannot be revived');
select extensions.throws_ok($$delete from private.scheduler_invocation_tickets$$, '42501', null,
  'tickets are retained for audit');
select extensions.ok((private.scheduler_invocation_status(now())#>>'{recall_automation,consumedLast24h}')::integer = 1
    and (private.scheduler_invocation_status(now())#>>'{cpsc_page_stage,rejectedAttemptsLast24h}')::integer >= 3,
  'ticket issuance, consumption and rejections are observable');

-- Converting v1 job 2 changes only its command.
select private.install_recall_automation_cron();
select set_config('t33.job2', (select to_jsonb(j) - 'command' - 'jobid' from cron.job j
  where jobname = 'recall-automation-every-6h')::text, true);
select private.convert_recall_automation_cron_to_tickets();
select extensions.ok((select command = 'select private.recall_automation_tick();'
    and (to_jsonb(j) - 'command' - 'jobid') = current_setting('t33.job2')::jsonb
  from cron.job j where jobname = 'recall-automation-every-6h'),
  'job 2 keeps its name, schedule and active flag; only the command changes');
select extensions.ok((select command !~* '(vault|key|http)' from cron.job
  where jobname = 'recall-automation-every-6h'), 'the converted command holds no key, URL or Vault read');

-- ===========================================================================
-- Negative evidence outside the census (description / remedy / sold at /
-- linked documents). A complete description ledger is not enough.
-- ===========================================================================
create function pg_temp.table_id(p_number text) returns text language sql immutable as $$
  select 'description/table/0/' || pg_temp.hex('p1633-table:' || p_number);
$$;
create function pg_temp.row_id(p_number text) returns text language sql immutable as $$
  select pg_temp.hex('p1633-row:' || p_number);
$$;
create function pg_temp.revision(p_number text, p_version integer, p_details jsonb)
returns uuid language plpgsql as $$
declare v_url text := 'https://www.cpsc.gov/Recalls/2026/P1633-' || p_number;
begin
  if p_version = 1 then
    insert into public.recall_notices (id,source_id,external_id,title,description,hazard,remedy,
      recall_date,official_url,retrieved_at,raw_payload)
    values (pg_temp.id('10' || p_number), current_setting('t33.source')::uuid, 'cpsc:' || p_number,
      'Recall ' || p_number, 'Desc', 'Hazard', 'Refund', '2026-09-20', v_url, now() - interval '1 day',
      jsonb_build_object('RecallNumber', p_number));
    insert into public.recall_scopes (id,recall_notice_id,product_name)
    values (pg_temp.id('20' || p_number), pg_temp.id('10' || p_number), 'Product ' || p_number);
    insert into private.cpsc_source_identities (id,source_id,official_recall_number,canonical_url,
      canonical_notice_id,identity_status)
    values (pg_temp.id('30' || p_number), current_setting('t33.source')::uuid, p_number, v_url,
      pg_temp.id('10' || p_number), 'reconciled');
    insert into private.cpsc_notice_identity_links (notice_id,identity_id,provenance)
    values (pg_temp.id('10' || p_number), pg_temp.id('30' || p_number), 'Phase 16.33 pgTAP');
  end if;
  insert into private.cpsc_page_revisions (id,identity_id,evidence_hash,recall_number,
    canonical_url,title,section_hashes,normalized_evidence,parser_version,first_seen_at,last_seen_at,
    current_since,table_identities)
  values (pg_temp.id(p_version || '40' || p_number), pg_temp.id('30' || p_number),
    pg_temp.hex('p1633-revision:' || p_number || ':' || p_version), p_number, v_url,
    'Recall ' || p_number, '{}', jsonb_build_object('recallNumber', p_number, 'canonicalUrl', v_url,
      'title', 'Recall ' || p_number, 'recallDetails', p_details),
    'phase-16.13-structured-v2', now() - interval '2 hours' + p_version * interval '1 minute',
    now() - interval '2 hours' + p_version * interval '1 minute',
    now() - interval '2 hours' + p_version * interval '1 minute',
    jsonb_build_array(jsonb_build_object('identity', pg_temp.table_id(p_number),
      'rows', jsonb_build_array(jsonb_build_object('identity', pg_temp.row_id(p_number),
        'evidence', jsonb_build_array('Grill', 'MODEL-1'))))));
  return pg_temp.id(p_version || '40' || p_number);
end $$;
create function pg_temp.ledger(p_number text, p_version integer) returns jsonb language sql as $$
  select jsonb_build_object('schema', 'cpsc_source_coverage_v1',
    'ledgerVersion', 'phase-16.13-coverage-v1', 'parserVersion', 'phase-16.13-structured-v2',
    'extractorVersion', 'phase-16.11-html-v1', 'censusVersion', 'phase-16.13-census-v1',
    'sourceSemanticRevision', pg_temp.hex('p1633-revision:' || p_number || ':' || p_version),
    'structures', jsonb_build_array(
      jsonb_build_object('structureId', 'description/prose', 'kind', 'prose',
        'sectionIdentity', 'description', 'tableIndex', null, 'tableIdentity', null,
        'authoritativeRecordCount', 1, 'anomalies', '[]'::jsonb,
        'records', jsonb_build_array(jsonb_build_object('ordinal', 0,
          'recordIdentity', pg_temp.hex('sentence:' || p_number), 'rowIdentity', null,
          'extraction', 'extracted', 'disposition', 'ignored_non_safety', 'effect', 'none',
          'relation', null, 'reason', 'pgTAP sentence', 'cells', '[]'::jsonb))),
      jsonb_build_object('structureId', pg_temp.table_id(p_number), 'kind', 'table',
        'sectionIdentity', 'description', 'tableIndex', 0, 'tableIdentity', pg_temp.table_id(p_number),
        'authoritativeRecordCount', 1, 'anomalies', '[]'::jsonb,
        'records', jsonb_build_array(jsonb_build_object('ordinal', 0,
          'recordIdentity', pg_temp.row_id(p_number), 'rowIdentity', pg_temp.row_id(p_number),
          'extraction', 'extracted', 'disposition', 'parsed_reviewable', 'effect', 'none',
          'relation', pg_temp.table_id(p_number) || '/' || pg_temp.row_id(p_number),
          'reason', 'pgTAP row', 'cells', jsonb_build_array(
            jsonb_build_object('column','model no','criterionClass','model','status','recognized'),
            jsonb_build_object('column','date code','criterionClass','date_code','status','recognized')))))));
$$;
-- Propose model AND date code, record the complete ledger, review and materialize.
create function pg_temp.reviewed_universe(p_number text, p_revision uuid, p_version integer)
returns jsonb language plpgsql as $$
declare
  v_key text := pg_temp.table_id(p_number) || '/' || pg_temp.row_id(p_number);
  v_address jsonb;
  v_ids uuid[];
  v_ledger jsonb;
begin
  select jsonb_build_object('source','cpsc','recallNumber',p_number,'canonicalUrl',canonical_url,
      'sourceSemanticRevision',evidence_hash,'sectionIdentity','description',
      'tableIdentity',pg_temp.table_id(p_number),'rowIdentity',pg_temp.row_id(p_number))
    into v_address from private.cpsc_page_revisions where id = p_revision;
  perform pg_temp.act('service_role');
  v_ids := array[
    (public.propose_cpsc_candidate_criterion(p_revision, pg_temp.id('20' || p_number),
      v_address || '{"fieldIdentity":"model no"}', pg_temp.hex(v_key || 'm'), 'model_exact',
      '"MODEL-1"', v_key, 'Grill | MODEL-1', 'phase-16.13-structured-v2')->>'candidateId')::uuid,
    (public.propose_cpsc_candidate_criterion(p_revision, pg_temp.id('20' || p_number),
      v_address || '{"fieldIdentity":"date code"}', pg_temp.hex(v_key || 'd'), 'date_code_exact',
      '"2510"', v_key, 'Grill | 2510', 'phase-16.13-structured-v2')->>'candidateId')::uuid];
  v_ledger := public.record_cpsc_page_coverage(p_revision, pg_temp.ledger(p_number, p_version));
  perform pg_temp.act('authenticated', '903');
  perform public.decide_cpsc_candidate(v_ids[1], 'reviewed', true, 'pgTAP');
  perform public.decide_cpsc_candidate(v_ids[2], 'reviewed', true, 'pgTAP');
  perform public.materialize_cpsc_reviewed_conjunction(v_ids[1]);
  perform pg_temp.done();
  return v_ledger;
end $$;
create function pg_temp.coverage(p_number text) returns jsonb language sql as $$
  select reviewed_criteria->'coverage' from public.get_recall_v2_scopes(pg_temp.id('10' || p_number))
  where scope_id = pg_temp.id('20' || p_number);
$$;
create function pg_temp.attest(p_revision uuid, p_refs jsonb default '[]',
  p_reviewer text default '903', p_sha text default null) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.act('authenticated', p_reviewer);
  v := public.attest_cpsc_outside_census(p_revision,
    coalesce(p_sha, public.get_cpsc_outside_census_packet(p_revision)->>'sectionsSha256'), p_refs,
    'pgTAP: read every section and linked document; nothing narrows or widens the scope', 7);
  perform pg_temp.done();
  return v;
end $$;

-- Restriction only in the remedy.
select set_config('t33.rev_remedy', pg_temp.revision('33101', 1, jsonb_build_object(
  'description', 'Grills with date code 2510.',
  'remedy', 'Only grills sold at Walmart are included in this recall.'))::text, true);
select set_config('t33.ledger_remedy', pg_temp.reviewed_universe('33101',
  current_setting('t33.rev_remedy')::uuid, 1)::text, true);
select extensions.ok((current_setting('t33.ledger_remedy')::jsonb->>'negativeEvidenceEligible')::boolean
    and current_setting('t33.ledger_remedy')::jsonb->>'coverageStatus' = 'complete',
  'the description census alone reports negative eligibility (the remedy is not censused)');
select extensions.ok(not (pg_temp.coverage('33101')->>'complete')::boolean
    and not (pg_temp.coverage('33101')#>>'{sourceCoverage,outsideCensus,attested}')::boolean,
  'a remedy-only restriction withholds negative evidence: coverage is incomplete');
select extensions.is(jsonb_array_length((select reviewed_criteria->'ruleSets'
  from public.get_recall_v2_scopes(pg_temp.id('1033101')) where scope_id = pg_temp.id('2033101'))), 1,
  'the reviewed rule set still serves positives');

-- Restriction only in "sold at".
select set_config('t33.rev_sold', pg_temp.revision('33102', 1, jsonb_build_object(
  'description', 'Grills with date code 2510.',
  'sold at', 'Home Depot stores in Texas only from October 2025 through June 2026.'))::text, true);
select pg_temp.reviewed_universe('33102', current_setting('t33.rev_sold')::uuid, 1);
select extensions.ok(not (pg_temp.coverage('33102')->>'complete')::boolean,
  'a sold-at restriction withholds negative evidence');

-- A linked authoritative document named in the remedy.
select set_config('t33.rev_link', pg_temp.revision('33103', 1, jsonb_build_object(
  'description', 'Grills with date code 2510.',
  'remedy', 'Affected serial numbers are listed at https://example.com/recall-serials.'))::text, true);
select pg_temp.reviewed_universe('33103', current_setting('t33.rev_link')::uuid, 1);
select extensions.ok(not (pg_temp.coverage('33103')->>'complete')::boolean,
  'a linked document withholds negative evidence until a human reads it');

-- The attestation boundary.
select pg_temp.act('authenticated', '903');
select extensions.throws_ok(format($$select public.attest_cpsc_outside_census(%L::uuid, %L, '[]'::jsonb,
    'pgTAP', 7)$$, current_setting('t33.rev_link'), repeat('0', 64)), null,
  'Recall-detail sections changed since they were read',
  'an attestation over text other than the current sections is refused');
select extensions.throws_ok(format($$select public.attest_cpsc_outside_census(%L::uuid, %L, '["ftp://x"]'::jsonb,
    'pgTAP', 7)$$, current_setting('t33.rev_link'),
    public.get_cpsc_outside_census_packet(current_setting('t33.rev_link')::uuid)->>'sectionsSha256'),
  null, 'External references must be https URLs', 'external references must be https URLs');
select extensions.throws_ok(format($$select public.attest_cpsc_outside_census(%L::uuid, %L, '[]'::jsonb,
    'pgTAP', 31)$$, current_setting('t33.rev_link'),
    public.get_cpsc_outside_census_packet(current_setting('t33.rev_link')::uuid)->>'sectionsSha256'),
  null, 'Attestation must expire within 1 to 30 days', 'attestations expire within 30 days');
select pg_temp.act('authenticated', '903', 'aal1');
select extensions.throws_ok(format($$select public.attest_cpsc_outside_census(%L::uuid, %L, '[]'::jsonb,
    'pgTAP', 7)$$, current_setting('t33.rev_link'), repeat('0', 64)), '42501', null,
  'an aal1 reviewer cannot attest');
select pg_temp.act('authenticated', '901');
select extensions.throws_ok(format($$select public.attest_cpsc_outside_census(%L::uuid, %L, '[]'::jsonb,
    'pgTAP', 7)$$, current_setting('t33.rev_link'), repeat('0', 64)), '42501', null,
  'an operator cannot attest');
select pg_temp.done();
select extensions.throws_ok(format($$insert into private.cpsc_outside_census_attestations
    (revision_id, source_revision_hash, outside_census_sha256, sections, external_references,
     statement, reviewer_user_id, valid_until)
    select id, evidence_hash, private.cpsc_outside_census_sha256(id), '{}', '[]', 'forged', %L,
      now() + interval '1 day' from private.cpsc_page_revisions where id = %L$$,
    pg_temp.id('903'), current_setting('t33.rev_link')), '42501', null,
  'an owner insert carrying a real reviewer id is rejected (no forgery)');
select pg_temp.attest(current_setting('t33.rev_link')::uuid,
  '["https://example.com/recall-serials"]'::jsonb);
select extensions.ok((pg_temp.coverage('33103')->>'complete')::boolean
    and (pg_temp.coverage('33103')#>>'{sourceCoverage,outsideCensus,attested}')::boolean,
  'with a current human attestation the complete universe may serve negatives');
select extensions.ok(not (private.cpsc_outside_census_attested(current_setting('t33.rev_link')::uuid,
    now() + interval '8 days')->>'attested')::boolean,
  'an expired attestation withdraws negative evidence');
select extensions.throws_ok($$delete from private.cpsc_outside_census_attestations$$, '42501', null,
  'attestations are append-only');

-- A changed remedy is a new revision: the old attestation does not carry over.
select pg_temp.revision('33103', 2, jsonb_build_object(
  'description', 'Grills with date code 2510.',
  'remedy', 'Affected serial numbers are listed at https://example.com/recall-serials-v2.'));
select extensions.ok(not coalesce((pg_temp.coverage('33103')->>'complete')::boolean, false)
    and not (private.cpsc_outside_census_attested(
      private.cpsc_scope_current_revision(pg_temp.id('2033103')), now())->>'attested')::boolean,
  'a revised recall-detail section withdraws the attestation and negative evidence');

-- A reviewer revoked before attesting never authorizes.
update private.cpsc_reviewer_authorizations set revoked_at = now() where user_id = pg_temp.id('906');
select pg_temp.act('authenticated', '906');
select extensions.throws_ok(format($$select public.attest_cpsc_outside_census(%L::uuid,
    %L, '[]'::jsonb, 'pgTAP', 7)$$, current_setting('t33.rev_sold'),
    private.cpsc_outside_census_sha256(current_setting('t33.rev_sold')::uuid)), '42501', null,
  'a revoked reviewer cannot attest');
select pg_temp.done();

-- Nothing in this phase changes v2 activation or human state by itself.
select extensions.ok(not exists (select 1 from cron.job where jobname = 'cpsc-page-evidence-shadow'),
  'no page Cron job exists');

select * from extensions.finish();
rollback;
