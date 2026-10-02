begin;
set local role postgres;
set local search_path = extensions, public, auth;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

-- ---------------------------------------------------------------------------
-- Privilege boundary
-- ---------------------------------------------------------------------------
select extensions.ok(not has_table_privilege(r, format('private.%s', t), p),
  format('%s has no %s on private.%s', r, p, t))
  from unnest(array['anon','authenticated','service_role']) r,
    unnest(array['cpsc_observation_payloads','cpsc_observation_sightings',
      'cpsc_observation_payload_retention']) t,
    unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;
select extensions.ok(c.relrowsecurity, format('RLS enabled on private.%s', c.relname))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private'
    and c.relname in ('cpsc_observation_payloads','cpsc_observation_sightings');
select extensions.ok(not exists (select 1 from pg_policies where schemaname = 'private'
    and tablename in ('cpsc_observation_payloads','cpsc_observation_sightings')),
  'no policy exposes retained payloads or sightings');
select extensions.ok(has_function_privilege('service_role',
    'public.record_cpsc_retained_observation(text,text,text,text,text,date,text,timestamptz,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.record_cpsc_retained_observation(text,text,text,text,text,date,text,timestamptz,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.record_cpsc_retained_observation(text,text,text,text,text,date,text,timestamptz,text,jsonb)', 'EXECUTE'),
  'payload-retaining observation RPC is worker-only');
-- Phase 16.20 retains this hash-only gate for owner backfill, not worker access.
select extensions.ok(not has_function_privilege('service_role',
    'public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)', 'EXECUTE'),
  'legacy 9-argument gate has no direct worker grant');
select extensions.ok(not has_function_privilege(r, f, 'EXECUTE'), format('%s cannot execute %s', r, f))
  from unnest(array['anon','authenticated','service_role']) r,
    unnest(array['private.cpsc_canonical_json_v1(jsonb)','private.cpsc_payload_sha256_v1(jsonb)',
      'private.cpsc_watermark_safety()','private.cpsc_guard_watermark_advance()',
      'private.cpsc_guard_sighting_update()','private.cpsc_attach_captured_payloads(jsonb,boolean)',
      'private.cpsc_quarantine_evidence(uuid)']) f;
select extensions.ok(not has_function_privilege('service_role', f, 'EXECUTE'),
  format('worker cannot execute human-only %s', f))
  from unnest(array['public.get_cpsc_quarantine_packet(uuid)',
    'public.reconcile_cpsc_quarantined_observation(uuid,text,text)',
    'public.decide_cpsc_candidate(uuid,text,boolean,text)',
    'public.materialize_cpsc_reviewed_conjunction(uuid)',
    'public.invalidate_cpsc_review_decision(uuid,text)']) f;

-- ---------------------------------------------------------------------------
-- Hash contract cpsc-canonical-json-sha256/v1
-- ---------------------------------------------------------------------------
select extensions.is(private.cpsc_payload_sha256_v1(
  '{"b":1,"a":[true,null,"x\"y\\\n\t",1.5,-3],"c":{"é":"ü","A":2,"Z":{}},"d":[]}'::jsonb),
  '37ea07ce2483c485d9377c4a4b5388ac12371174ba1038ec4c7deeda4dc02ce3',
  'SQL hash equals the worker sourcePayloadSha256 test vector');
select extensions.is(private.cpsc_payload_sha256_v1(v), private.cpsc_canonical_json_sha256(v),
  'v1 hash equals the 16.12 canonical hash')
  from (values ('{"z":1,"a":{"y":[3,2,{"k":"v"}],"b":"é"}}'::jsonb), ('{}'::jsonb),
    ('{"RecallID":1,"RecallNumber":"26-001"}'::jsonb)) t(v);
select extensions.is(private.cpsc_payload_sha256_v1('{"b":1,"a":2}'::jsonb),
  private.cpsc_payload_sha256_v1('{"a":2,"b":1}'::jsonb), 'key order does not change the hash');
select extensions.isnt(private.cpsc_payload_sha256_v1('{"a":[1,2]}'::jsonb),
  private.cpsc_payload_sha256_v1('{"a":[2,1]}'::jsonb), 'array order changes the hash');
select extensions.ok(p.provolatile = 'i', format('%s is immutable', p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname in ('cpsc_canonical_json_v1','cpsc_payload_sha256_v1');
select extensions.ok(a.attgenerated = 's', format('%s is database-generated', a.attname))
  from pg_attribute a
  where a.attrelid = 'private.cpsc_observation_payloads'::regclass
    and a.attname in ('canonical_payload_sha256','upstream_api_id','official_recall_number',
      'canonical_payload_bytes');
select extensions.throws_ok($$insert into private.cpsc_observation_payloads
    (canonical_payload_sha256, payload, recorded_via, provenance)
  values (repeat('a',64), '{"RecallID":1,"RecallNumber":"26001","URL":"https://www.cpsc.gov/Recalls/x","Title":"t","RecallDate":"2026-01-01"}',
    'worker_observation', 'forged')$$,
  '428C9', null, 'a caller cannot supply the stored payload hash');
select extensions.throws_ok($$insert into private.cpsc_observation_payloads (payload, recorded_via, provenance)
  values ('{"RecallID":1,"RecallNumber":"26001","URL":"https://evil.example/Recalls/x","Title":"t","RecallDate":"2026-01-01"}',
    'worker_observation', 'bad host')$$,
  '23514', null, 'non-CPSC URL payload violates the table contract');
select extensions.throws_ok($$insert into private.cpsc_observation_payloads (payload, recorded_via, provenance)
  values ('[1,2]', 'worker_observation', 'array')$$, '23514', null,
  'non-object payload violates the table contract');

-- ---------------------------------------------------------------------------
-- Fixtures: two canonical recalls; payload revisions A/B collide on B's API ID.
-- ---------------------------------------------------------------------------
insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id::uuid,'authenticated','authenticated',email,'','2099-01-01','{}','{}',now(),now()
from (values
  ('16160000-0000-4000-8000-000000000001','reconciler@example.invalid'),
  ('16160000-0000-4000-8000-000000000002','consumer@example.invalid'),
  ('16160000-0000-4000-8000-000000000003','criterion-reviewer@example.invalid')) u(id,email);
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
values ('16160000-0000-4000-8000-000000000001','identity_reconciliation',
  now() - interval '1 hour','pgTAP reconciler');
insert into private.cpsc_reviewer_authorizations (user_id, authorized_at, revoked_at, reason)
values ('16160000-0000-4000-8000-000000000003', now() - interval '1 hour', null, 'pgTAP criterion reviewer');
select set_config('t.source', public.ensure_cpsc_recall_source()::text, true);
insert into public.recall_notices (id,source_id,external_id,title,recall_date,official_url,
  retrieved_at,raw_payload)
values
  ('16160000-0000-4000-8000-000000000011',current_setting('t.source')::uuid,'21001',
   'Recall PA','2026-09-10','https://www.cpsc.gov/Recalls/2026/Recall-PA',now(),
   '{"RecallID":21001,"RecallNumber":"26811"}'),
  ('16160000-0000-4000-8000-000000000012',current_setting('t.source')::uuid,'21002',
   'Recall PB','2026-09-10','https://www.cpsc.gov/Recalls/2026/Recall-PB',now(),
   '{"RecallID":21002,"RecallNumber":"26812"}');
insert into private.cpsc_source_identities (id,source_id,official_recall_number,canonical_url,
  canonical_notice_id,identity_status)
values
  ('16160000-0000-4000-8000-000000000031',current_setting('t.source')::uuid,'26811',
   'https://www.cpsc.gov/Recalls/2026/Recall-PA','16160000-0000-4000-8000-000000000011','reconciled'),
  ('16160000-0000-4000-8000-000000000032',current_setting('t.source')::uuid,'26812',
   'https://www.cpsc.gov/Recalls/2026/Recall-PB','16160000-0000-4000-8000-000000000012','reconciled');
insert into private.cpsc_notice_identity_links (notice_id,identity_id,provenance)
values
  ('16160000-0000-4000-8000-000000000011','16160000-0000-4000-8000-000000000031','historical fixture'),
  ('16160000-0000-4000-8000-000000000012','16160000-0000-4000-8000-000000000032','historical fixture');
insert into private.cpsc_source_aliases (identity_id,notice_id,alias_kind,alias_value,
  provenance,first_seen_at,last_seen_at)
values
  ('16160000-0000-4000-8000-000000000031','16160000-0000-4000-8000-000000000011','api_id','21001',
   'historical fixture',now(),now()),
  ('16160000-0000-4000-8000-000000000032','16160000-0000-4000-8000-000000000012','api_id','21002',
   'historical fixture',now(),now());

-- Revision A: recall 26811 now served under 26812's API ID 21002 (D_api_id_reuse).
select set_config('t.payload_a', '{"RecallID":21002,"RecallNumber":"26-811","RecallDate":"2026-09-10T00:00:00",
  "URL":"https://www.cpsc.gov/Recalls/2026/Recall-PA","Title":"Recall PA","Description":"revision A",
  "Remedies":[{"Name":"Refund"}],"ConsumerContact":"call A"}', true);
select set_config('t.payload_b', jsonb_set(current_setting('t.payload_a')::jsonb,
  '{Description}', '"revision B: materially changed"')::text, true);
create temporary table t_before as select
  (select count(*) from private.cpsc_source_identities) identities,
  (select count(*) from private.cpsc_source_aliases) aliases,
  (select count(*) from private.cpsc_api_revisions) api_revisions,
  (select md5(string_agg(n::text, '|' order by n.id)) from public.recall_notices n) notices,
  (select count(*) from public.recall_scopes) scopes;

create function pg_temp.retain(p jsonb, p_hash text default null, p_api text default null)
returns jsonb language sql as $$
  select public.record_cpsc_retained_observation(coalesce(p_api, p->>'RecallID'),
    private.cpsc_payload_recall_number(p), p->>'URL', private.cpsc_canonical_url(p->>'URL'),
    p->>'Title', left(p->>'RecallDate',10)::date,
    coalesce(p_hash, private.cpsc_payload_sha256_v1(p)), now(), 'pgTAP retained observation', p);
$$;

-- ---------------------------------------------------------------------------
-- Durable quarantine, idempotent replay, changed revision (worker claims)
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"role":"service_role"}';
select set_config('t.a1', pg_temp.retain(current_setting('t.payload_a')::jsonb)::text, true);
select extensions.is(current_setting('t.a1')::jsonb->>'status', 'quarantined', 'A quarantines');
select extensions.is(current_setting('t.a1')::jsonb->>'decisionClass', 'D_api_id_reuse',
  'A is an API-ID reuse collision');
select extensions.is(current_setting('t.a1')::jsonb->>'payloadRetention', 'retained',
  'A reports a retained payload');
select extensions.ok((current_setting('t.a1')::jsonb->>'replayed')::boolean is false
  and (current_setting('t.a1')::jsonb->>'payloadRecorded')::boolean
  and (current_setting('t.a1')::jsonb->>'seenCount')::int = 1, 'A is a first sighting that stored its payload');
select set_config('t.obs_a', current_setting('t.a1')::jsonb->>'observationId', true);
select extensions.is((select payload from private.cpsc_observation_payloads
    where canonical_payload_sha256 = current_setting('t.a1')::jsonb->>'payloadSha256'),
  current_setting('t.payload_a')::jsonb, 'the complete payload is stored');
select extensions.is((select o.payload_hash from private.cpsc_identity_observations o
    where o.id = current_setting('t.obs_a')::uuid),
  private.cpsc_payload_sha256_v1(current_setting('t.payload_a')::jsonb),
  'the observation records the database-computed hash');
select extensions.is((select payload_retention from private.cpsc_observation_payload_retention
    where observation_id = current_setting('t.obs_a')::uuid), 'retained',
  'retention view proves A retained');

select set_config('t.a2', pg_temp.retain(current_setting('t.payload_a')::jsonb)::text, true);
select extensions.is(current_setting('t.a2')::jsonb->>'observationId', current_setting('t.obs_a'),
  'identical replay reuses the existing observation');
select extensions.ok((current_setting('t.a2')::jsonb->>'replayed')::boolean
  and not (current_setting('t.a2')::jsonb->>'payloadRecorded')::boolean
  and (current_setting('t.a2')::jsonb->>'seenCount')::int = 2, 'replay is counted, not re-stored');
select extensions.is(pg_temp.retain(current_setting('t.payload_a')::jsonb)->>'seenCount', '3',
  'third sighting only bumps the counter');
select extensions.is((select count(*) from private.cpsc_identity_observations
    where upstream_api_id = '21002' and official_recall_number = '26811'), 1::bigint,
  'three sightings leave exactly one review item');
select extensions.is((select count(*) from private.cpsc_observation_payloads
    where upstream_api_id = '21002' and official_recall_number = '26811'), 1::bigint,
  'three sightings leave exactly one stored payload');
select extensions.ok((select s.seen_count = 3 and s.last_seen_at >= s.first_seen_at
    from private.cpsc_observation_sightings s where s.observation_id = current_setting('t.obs_a')::uuid),
  'sighting metadata records three sightings');

select set_config('t.b1', pg_temp.retain(current_setting('t.payload_b')::jsonb)::text, true);
select set_config('t.obs_b', current_setting('t.b1')::jsonb->>'observationId', true);
select extensions.ok(current_setting('t.obs_b') <> current_setting('t.obs_a')
  and not (current_setting('t.b1')::jsonb->>'replayed')::boolean,
  'materially changed payload B is a new review item');
select extensions.isnt(current_setting('t.b1')::jsonb->>'payloadSha256',
  current_setting('t.a1')::jsonb->>'payloadSha256', 'B has a different verified hash');
select extensions.is(pg_temp.retain(current_setting('t.payload_b')::jsonb)->>'observationId',
  current_setting('t.obs_b'), 'replaying B reuses B');
select extensions.is(pg_temp.retain(current_setting('t.payload_a')::jsonb)->>'observationId',
  current_setting('t.obs_a'), 'replaying A after B still reuses A');
select extensions.is((select payload from private.cpsc_observation_payloads
    where canonical_payload_sha256 = current_setting('t.a1')::jsonb->>'payloadSha256'),
  current_setting('t.payload_a')::jsonb, 'A is not overwritten by B');
select extensions.is((select array_agg(canonical_payload_sha256 order by revision_seq)
    from private.cpsc_observation_payloads where upstream_api_id = '21002' and official_recall_number = '26811'),
  array[current_setting('t.a1')::jsonb->>'payloadSha256', current_setting('t.b1')::jsonb->>'payloadSha256'],
  'source-revision lineage is A then B');
select extensions.ok(not exists (select 1 from private.cpsc_observation_payloads
    where canonical_payload_sha256 <> private.cpsc_payload_sha256_v1(payload)),
  'every stored payload re-verifies against its stored hash');

-- Canonical identity is untouched by any of this.
select extensions.ok((select a.identity_id from private.cpsc_source_aliases a
    where a.alias_kind = 'api_id' and a.alias_value = '21002') = '16160000-0000-4000-8000-000000000032'
  and (select count(*) from private.cpsc_source_aliases a
    where a.alias_kind = 'api_id' and a.alias_value = '21002') = 1,
  'historical API alias 21002 is not reassigned or duplicated');
select extensions.ok((select identities from t_before) = (select count(*) from private.cpsc_source_identities)
  and (select aliases from t_before) = (select count(*) from private.cpsc_source_aliases)
  and (select api_revisions from t_before) = (select count(*) from private.cpsc_api_revisions)
  and (select notices from t_before) = (select md5(string_agg(n::text, '|' order by n.id)) from public.recall_notices n)
  and (select scopes from t_before) = (select count(*) from public.recall_scopes),
  'quarantine retention writes no identity, alias, API revision, notice, or scope');

-- Resolved path also retains payloads, keeps its append-only observations, and has no sightings.
select set_config('t.r1', pg_temp.retain('{"RecallID":21001,"RecallNumber":"26811","RecallDate":"2026-09-10",
  "URL":"https://www.cpsc.gov/Recalls/2026/Recall-PA","Title":"Recall PA"}'::jsonb)::text, true);
select extensions.ok(current_setting('t.r1')::jsonb->>'status' = 'resolved'
  and current_setting('t.r1')::jsonb->>'decisionClass' = 'A_known_alias'
  and current_setting('t.r1')::jsonb->>'payloadRetention' = 'retained', 'resolved observation retains its payload');
select extensions.ok(not exists (select 1 from private.cpsc_observation_sightings
    where observation_id = (current_setting('t.r1')::jsonb->>'observationId')::uuid),
  'resolved observations do not use quarantine sightings');

-- Fail closed: forged hash, mismatched identity fields, oversized or invalid payloads.
select extensions.throws_ok($$select pg_temp.retain(current_setting('t.payload_a')::jsonb, repeat('a',64))$$,
  '22023', 'CPSC payload hash does not match its payload', 'a forged caller hash is rejected');
select extensions.throws_ok($$select pg_temp.retain(current_setting('t.payload_a')::jsonb, null, '21001')$$,
  '22023', 'CPSC payload does not match its observation', 'API ID not carried by the payload is rejected');
select extensions.throws_ok($$select public.record_cpsc_retained_observation('21002','26811',
    'https://www.cpsc.gov/Recalls/2026/Recall-PB','https://www.cpsc.gov/Recalls/2026/Recall-PB',
    'Recall PA','2026-09-10',private.cpsc_payload_sha256_v1(current_setting('t.payload_a')::jsonb),
    now(),'pgTAP',current_setting('t.payload_a')::jsonb)$$,
  '22023', 'CPSC payload does not match its observation', 'URL not carried by the payload is rejected');
select extensions.throws_ok($$select public.record_cpsc_retained_observation('21002','26811',
    'https://www.cpsc.gov/Recalls/2026/Recall-PA','https://www.cpsc.gov/Recalls/2026/Recall-PA',
    'Recall PA','2026-09-11',private.cpsc_payload_sha256_v1(current_setting('t.payload_a')::jsonb),
    now(),'pgTAP',current_setting('t.payload_a')::jsonb)$$,
  '22023', 'CPSC payload does not match its observation', 'date not carried by the payload is rejected');
select extensions.throws_ok($$select pg_temp.retain(jsonb_set(current_setting('t.payload_a')::jsonb,
    '{Description}', to_jsonb(repeat('x', 262200))))$$,
  '22023', 'Invalid CPSC source payload', 'payload over 256 KiB of canonical bytes fails closed');
select extensions.throws_ok($$select public.record_cpsc_retained_observation('21002','26811',
    'https://www.cpsc.gov/Recalls/2026/Recall-PA','https://www.cpsc.gov/Recalls/2026/Recall-PA',
    'Recall PA','2026-09-10',repeat('a',64),now(),'pgTAP','[1]'::jsonb)$$,
  '22023', 'Invalid CPSC source payload', 'non-object payload fails closed');
select extensions.throws_ok($$select public.record_cpsc_retained_observation('21002','26811',
    'https://www.cpsc.gov/Recalls/2026/Recall-PA','https://www.cpsc.gov/Recalls/2026/Recall-PA',
    'Recall PA','2026-09-10',repeat('a',64),now(),'pgTAP',null)$$,
  '22023', 'Invalid CPSC source payload', 'missing payload fails closed');
select extensions.lives_ok($$select pg_temp.retain(jsonb_set(current_setting('t.payload_a')::jsonb,
    '{Description}', to_jsonb(repeat('y', 200000))))$$, 'a 200 KB CPSC payload is within the bound');
select extensions.is((select count(*) from private.cpsc_observation_payloads
    where upstream_api_id = '21002' and official_recall_number = '26811'), 3::bigint,
  'rejected calls stored nothing (A, B, and the 200 KB revision only)');

-- Immutability.
reset request.jwt.claims;
select extensions.throws_ok($$update private.cpsc_observation_payloads set provenance = 'x'$$,
  '42501', null, 'stored payloads cannot be updated');
select extensions.throws_ok($$delete from private.cpsc_observation_payloads$$,
  '42501', null, 'stored payloads cannot be deleted');
select extensions.throws_ok($$truncate private.cpsc_observation_payloads cascade$$,
  '42501', null, 'stored payloads cannot be truncated');
select extensions.throws_ok($$update private.cpsc_observation_sightings set seen_count = 1$$,
  '42501', null, 'sighting counters never move backwards');
select extensions.throws_ok($$update private.cpsc_observation_sightings set first_seen_at = now() - interval '1 year'$$,
  '42501', null, 'first sighting time is immutable');
select extensions.throws_ok($$delete from private.cpsc_observation_sightings$$,
  '42501', null, 'sightings cannot be deleted');
select extensions.throws_ok($$update private.cpsc_identity_observations set payload_hash = repeat('b',64)$$,
  '42501', null, 'observations stay append-only');

-- ---------------------------------------------------------------------------
-- Real roles: worker cannot review; consumers and anon are denied.
-- ---------------------------------------------------------------------------
select set_config('t.hash_a', private.cpsc_payload_sha256_v1(current_setting('t.payload_a')::jsonb), true);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select extensions.is(public.record_cpsc_retained_observation('21002','26811',
    'https://www.cpsc.gov/Recalls/2026/Recall-PA','https://www.cpsc.gov/Recalls/2026/Recall-PA',
    'Recall PA','2026-09-10',current_setting('t.hash_a'),now(),'pgTAP service role',
    current_setting('t.payload_a')::jsonb)->>'observationId', current_setting('t.obs_a'),
  'real service role replays A through the worker RPC');
select extensions.throws_ok($$select public.get_cpsc_quarantine_packet(gen_random_uuid())$$,
  '42501', null, 'worker cannot read the reconciliation packet');
select extensions.throws_ok(format($$select public.reconcile_cpsc_quarantined_observation(%L,'reject_observation','worker')$$,
  current_setting('t.obs_a')), '42501', null, 'worker cannot reconcile');
select extensions.throws_ok($$select public.decide_cpsc_candidate(gen_random_uuid(),'reviewed',true,'worker')$$,
  '42501', null, 'worker cannot record human review');
select extensions.throws_ok($$select public.invalidate_cpsc_review_decision(gen_random_uuid(),'worker')$$,
  '42501', null, 'worker cannot invalidate human decisions');
select extensions.throws_ok($$select private.cpsc_attach_captured_payloads('{}',false)$$,
  '42501', null, 'worker cannot run the owner-only payload attachment');
select extensions.throws_ok($$insert into private.cpsc_observation_payloads (payload, recorded_via, provenance)
  values ('{}','worker_observation','direct')$$, '42501', null, 'worker cannot write payloads directly');
select extensions.throws_ok($$select count(*) from private.cpsc_observation_payloads$$,
  '42501', null, 'worker cannot read payload rows directly');
reset role;
set local role postgres;

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select extensions.throws_ok($$select public.record_cpsc_retained_observation('21002','26811','a','b','t',
  '2026-09-10',repeat('a',64),now(),'x','{}')$$, '42501', null, 'anon cannot record observations');
select extensions.throws_ok($$select public.get_cpsc_quarantine_packet(gen_random_uuid())$$,
  '42501', null, 'anon cannot read the reconciliation packet');
reset role;
set local role postgres;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16160000-0000-4000-8000-000000000002","sub":"16160000-0000-4000-8000-000000000002"}';
select extensions.throws_ok($$select public.record_cpsc_retained_observation('21002','26811','a','b','t',
  '2026-09-10',repeat('a',64),now(),'x','{}')$$, '42501', null, 'consumer cannot record observations');
select extensions.throws_ok(format($$select public.get_cpsc_quarantine_packet(%L)$$, current_setting('t.obs_a')),
  '42501', null, 'consumer cannot read the reconciliation packet');
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16160000-0000-4000-8000-000000000003","sub":"16160000-0000-4000-8000-000000000003"}';
select extensions.throws_ok(format($$select public.get_cpsc_quarantine_packet(%L)$$, current_setting('t.obs_a')),
  '42501', null, 'criterion reviewer without the reconciliation capability is denied');

-- Authorized reconciler sees the exact stored payload without refetching CPSC.
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2","session_id":"16160000-0000-4000-8000-000000000001","sub":"16160000-0000-4000-8000-000000000001"}';
select set_config('t.packet', public.get_cpsc_quarantine_packet(current_setting('t.obs_a')::uuid)::text, true);
reset role;
set local role postgres;
reset request.jwt.claims;
select extensions.is(current_setting('t.packet')::jsonb #> '{sourceRevision,payload}',
  current_setting('t.payload_a')::jsonb, 'packet carries the exact stored payload A');
select extensions.ok((current_setting('t.packet')::jsonb #>> '{sourceRevision,hashVerified}')::boolean
  and current_setting('t.packet')::jsonb #>> '{sourceRevision,payloadSha256}'
    = current_setting('t.packet')::jsonb->>'payloadHash'
  and current_setting('t.packet')::jsonb->>'payloadRetention' = 'retained',
  'packet hash re-verifies in the database');
select extensions.ok(current_setting('t.packet')::jsonb->>'incomingApiId' = '21002'
  and current_setting('t.packet')::jsonb->>'officialRecallNumber' = '26811'
  and current_setting('t.packet')::jsonb->>'canonicalUrl' = 'https://www.cpsc.gov/Recalls/2026/Recall-PA'
  and current_setting('t.packet')::jsonb->>'reason' is not null
  and current_setting('t.packet')::jsonb #>> '{sourceRevision,hashContract}' = 'cpsc-canonical-json-sha256/v1',
  'packet carries identity, URL, reason, and hash contract');
select extensions.ok(current_setting('t.packet')::jsonb->'conflictingAliases' @> jsonb_build_array(
    jsonb_build_object('aliasKind','api_id','aliasValue','21002',
      'identityId','16160000-0000-4000-8000-000000000032','officialRecallNumber','26812')),
  'packet shows the conflicting historical identity');
select extensions.is((current_setting('t.packet')::jsonb #>> '{sightings,seenCount}')::int, 5,
  'packet shows the sighting count');
select extensions.is(jsonb_array_length(current_setting('t.packet')::jsonb->'sourceRevisionLineage'), 3,
  'packet lists every stored revision for this API ID and recall number');
select extensions.is((select count(*) from jsonb_array_elements(current_setting('t.packet')::jsonb->'sourceRevisionLineage') e
    where (e->>'thisObservation')::boolean), 1::bigint, 'packet marks which revision this observation saw');
select extensions.ok(current_setting('t.packet')::jsonb::text not like '%@example.invalid%'
  and current_setting('t.packet')::jsonb::text not like '%owned_product%',
  'packet exposes no user or owned-product data');

-- ---------------------------------------------------------------------------
-- Legacy hash-only rows, watermark safety, and bounded payload attachment.
-- ---------------------------------------------------------------------------
select set_config('t.payload_l', '{"RecallID":21002,"RecallNumber":"26813","RecallDate":"2026-09-17",
  "URL":"https://www.cpsc.gov/Recalls/2026/Recall-PL","Title":"Recall PL","Description":"captured"}', true);
set local request.jwt.claims = '{"role":"service_role"}';
select set_config('t.obs_l', (public.record_cpsc_identity_observation('21002','26813',
  'https://www.cpsc.gov/Recalls/2026/Recall-PL','https://www.cpsc.gov/Recalls/2026/Recall-PL','Recall PL',
  '2026-09-17',private.cpsc_payload_sha256_v1(current_setting('t.payload_l')::jsonb),now(),
  'pgTAP legacy backfill (captured current API)')->>'observationId'), true);
reset request.jwt.claims;
select extensions.is((select payload_retention from private.cpsc_observation_payload_retention
    where observation_id = current_setting('t.obs_l')::uuid), 'legacy_hash_only',
  'a 9-argument quarantine is legacy hash-only');
select extensions.is(private.cpsc_quarantine_evidence(current_setting('t.obs_l')::uuid)->>'payloadRetention',
  'legacy_hash_only', 'packet labels legacy hash-only evidence');
select extensions.ok(private.cpsc_quarantine_evidence(current_setting('t.obs_l')::uuid)->'sourceRevision'
  = 'null'::jsonb, 'no payload is fabricated for a legacy row');
select extensions.ok(not (private.cpsc_watermark_safety()->>'safe')::boolean
  and private.cpsc_watermark_safety()->'unaccounted' @> jsonb_build_array(jsonb_build_object(
    'observationId', current_setting('t.obs_l'))), 'watermark safety reports the legacy row as unaccounted');
select extensions.throws_ok($$select public.record_recall_source_sync_result('cpsc','success',
    '{"kind":"last_publish_date","value":"2026-10-01"}'::jsonb,null,'{}'::jsonb)$$,
  '23514', null, 'CPSC watermark cannot advance past a hash-only quarantine');
select extensions.lives_ok($$select public.record_recall_source_sync_result('cpsc','failed',null,
    'record_rejected','{}'::jsonb)$$, 'a failed CPSC run that keeps its watermark is still recorded');
select extensions.lives_ok($$select public.record_recall_source_sync_result('health_canada','success',
    '{"kind":"last_updated_date","value":"2026-10-01"}'::jsonb,null,'{}'::jsonb)$$,
  'other sources are unaffected');

-- Attachment input must be exact, authoritative, and hash-verified.
select set_config('t.attach', jsonb_build_object(
  'attachmentVersion','phase-16.16a-captured-payload-attachment-v1',
  'apiRoot','https://www.saferproducts.gov/RestWebServices/Recall',
  'captureSha256', repeat('c',64), 'capturedAtUtc','2026-09-26T09:06:13.773Z',
  'items', jsonb_build_array(jsonb_build_object('apiId','21002','recallNumber','26813',
    'payloadSha256', private.cpsc_payload_sha256_v1(current_setting('t.payload_l')::jsonb),
    'payload', current_setting('t.payload_l')::jsonb)))::text, true);
select extensions.throws_ok(format($$select private.cpsc_attach_captured_payloads(%L::jsonb, true)$$,
  jsonb_set(current_setting('t.attach')::jsonb, '{apiRoot}', '"https://example.com/api"')),
  '22023', null, 'non-authoritative API root is rejected');
select extensions.throws_ok(format($$select private.cpsc_attach_captured_payloads(%L::jsonb, true)$$,
  jsonb_set(current_setting('t.attach')::jsonb, '{items,0,payload,Description}', '"forged"')),
  '22023', null, 'payload whose hash differs from the declared hash is rejected');
select extensions.throws_ok(format($$select private.cpsc_attach_captured_payloads(%L::jsonb, true)$$,
  jsonb_set(jsonb_set(current_setting('t.attach')::jsonb, '{items,0,payload,Description}', '"forged"'),
    '{items,0,payloadSha256}', to_jsonb(private.cpsc_payload_sha256_v1(jsonb_set(
      current_setting('t.payload_l')::jsonb, '{Description}', '"forged"'))))),
  '22023', null, 'self-consistent payload that no quarantine recorded is rejected');
select extensions.throws_ok(format($$select private.cpsc_attach_captured_payloads(%L::jsonb, true)$$,
  jsonb_set(current_setting('t.attach')::jsonb, '{items}',
    (current_setting('t.attach')::jsonb->'items') || jsonb_build_array(jsonb_build_object(
      'apiId','21002','recallNumber','26813','payloadSha256',repeat('d',64),'payload','{}'::jsonb)))),
  '22023', null, 'one bad item rejects the whole batch');
select extensions.throws_ok(format($$select private.cpsc_attach_captured_payloads(%L::jsonb, true)$$,
  jsonb_set(current_setting('t.attach')::jsonb, '{items,0,extra}', '"x"')),
  '22023', null, 'items carry no free-form extra fields');
select extensions.is((select count(*) from private.cpsc_observation_payloads
    where official_recall_number = '26813'), 0::bigint, 'rejected attachments stored nothing');
select extensions.is(private.cpsc_attach_captured_payloads(current_setting('t.attach')::jsonb, false)->>'wouldAttach',
  '1', 'dry run previews one attachment');
select extensions.is((select count(*) from private.cpsc_observation_payloads
    where official_recall_number = '26813'), 0::bigint, 'dry run writes nothing');
select extensions.is(private.cpsc_attach_captured_payloads(current_setting('t.attach')::jsonb, true)->>'attached',
  '1', 'execution attaches the captured payload');
select extensions.is(private.cpsc_attach_captured_payloads(current_setting('t.attach')::jsonb, true)->>'alreadyRetained',
  '1', 'attachment is idempotent');
select extensions.ok((select recorded_via = 'captured_payload_attachment' and provenance like '%' || repeat('c',64) || '%'
    from private.cpsc_observation_payloads where official_recall_number = '26813'),
  'attachment provenance names the capture');
select extensions.is((select payload_retention from private.cpsc_observation_payload_retention
    where observation_id = current_setting('t.obs_l')::uuid), 'retained',
  'the legacy observation is now proven retained by content address');
select extensions.ok((select count(*) = 1 from private.cpsc_identity_observations
    where official_recall_number = '26813'), 'attachment wrote no observation');
select extensions.ok((private.cpsc_watermark_safety()->>'safe')::boolean, 'watermark safety now holds');
select extensions.lives_ok($$select public.record_recall_source_sync_result('cpsc','success',
    '{"kind":"last_publish_date","value":"2026-10-01"}'::jsonb,null,'{}'::jsonb)$$,
  'CPSC watermark can advance once every quarantine is retained');

-- The worker re-seeing a legacy quarantine dedupes onto it and supplies the payload.
select set_config('t.payload_m', '{"RecallID":21001,"RecallNumber":"26814","RecallDate":"2026-09-17",
  "URL":"https://www.cpsc.gov/Recalls/2026/Recall-PM","Title":"Recall PM"}', true);
set local request.jwt.claims = '{"role":"service_role"}';
select set_config('t.obs_m', (public.record_cpsc_identity_observation('21001','26814',
  'https://www.cpsc.gov/Recalls/2026/Recall-PM','https://www.cpsc.gov/Recalls/2026/Recall-PM','Recall PM',
  '2026-09-17',private.cpsc_payload_sha256_v1(current_setting('t.payload_m')::jsonb),now() - interval '1 day',
  'pgTAP legacy')->>'observationId'), true);
select set_config('t.m2', pg_temp.retain(current_setting('t.payload_m')::jsonb)::text, true);
reset request.jwt.claims;
select extensions.ok(current_setting('t.m2')::jsonb->>'observationId' = current_setting('t.obs_m')
  and (current_setting('t.m2')::jsonb->>'replayed')::boolean
  and (current_setting('t.m2')::jsonb->>'payloadRecorded')::boolean
  and (current_setting('t.m2')::jsonb->>'seenCount')::int = 2,
  'worker replay of a legacy quarantine reuses it and retains its payload');
select extensions.ok((private.cpsc_watermark_safety()->>'safe')::boolean, 'watermark safety still holds');

-- An unrecoverable hash-only quarantine blocks the watermark again.
set local request.jwt.claims = '{"role":"service_role"}';
select public.record_cpsc_identity_observation('21002','26815',
  'https://www.cpsc.gov/Recalls/2026/Recall-PN','https://www.cpsc.gov/Recalls/2026/Recall-PN','Recall PN',
  '2026-09-17',repeat('e',64),now(),'pgTAP legacy unrecoverable');
reset request.jwt.claims;
select extensions.throws_ok($$select public.record_recall_source_sync_result('cpsc','success',
    '{"kind":"last_publish_date","value":"2026-10-02"}'::jsonb,null,'{}'::jsonb)$$,
  '23514', null, 'any new hash-only quarantine blocks the CPSC watermark');
select extensions.is((select st.watermark->>'value' from private.recall_source_sync_state st
    join public.recall_sources s on s.id = st.source_id where s.source_key = 'cpsc'), '2026-10-01',
  'the blocked advance left the watermark unchanged');

-- Nothing here touched review, criteria, v2, alerts, or push.
select extensions.ok((select count(*) from private.cpsc_identity_reconciliations) = 0
  and (select count(*) from private.cpsc_candidate_criteria) = 0
  and (select count(*) from private.cpsc_candidate_review_ledger) = 0
  and (select count(*) from private.recall_scope_criteria_v2) = 0
  and (select count(*) from private.recall_scope_rule_sets_v2) = 0
  and (select count(*) from private.recall_match_evaluations_v2) = 0
  and (select count(*) from public.alerts) = 0
  and (select count(*) from private.push_alert_queue) = 0,
  'no reconciliation, criterion, review, v2, alert, or push row was created');

select * from extensions.finish();
rollback;
