-- Remote-safe Phase 16.16/16.17 regression suite. Run only after the 16.17
-- migration exists, or inside the rollback-only migration rehearsal.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local idle_in_transaction_session_timeout = '45s';
select extensions.no_plan();
select public.ensure_cpsc_recall_source();

select extensions.ok(exists(select 1 from pg_trigger where tgname =
  'guard_recall_source_watermark_forward' and not tgisinternal),
  'database source cursor guard is installed');
select extensions.ok(exists(select 1 from pg_trigger where tgname =
  'guard_recall_automation_watermark_forward' and not tgisinternal),
  'database automation cursor guard is installed');
select extensions.ok(has_function_privilege('service_role',
  'public.record_cpsc_retained_observation(text,text,text,text,text,date,text,timestamptz,text,jsonb)',
  'EXECUTE') and not has_function_privilege('anon',
  'public.record_cpsc_retained_observation(text,text,text,text,text,date,text,timestamptz,text,jsonb)',
  'EXECUTE'), 'retained observation writer is worker-only');
select extensions.ok(not has_function_privilege('service_role',
  'public.reconcile_cpsc_quarantined_observation(uuid,text,text)', 'EXECUTE')
  and not has_function_privilege('service_role',
  'public.get_cpsc_quarantine_packet(uuid)', 'EXECUTE'),
  'worker cannot reconcile or read the human packet');

-- Transaction-only API identity. Choose three unused official numbers and an
-- unused API ID so this test can run against a populated production database.
select set_config('p17.api', (select n::text from generate_series(900000000000::bigint,
  900000000050::bigint) n where not exists(select 1 from private.cpsc_source_aliases a
    where a.alias_kind='api_id' and a.alias_value=n::text)
    and not exists(select 1 from public.recall_notices r where r.external_id=n::text)
  order by n limit 1), true);
select set_config('p17.no', (select n::text from generate_series(90000,99997) n
  where not exists(select 1 from private.cpsc_source_identities i
    where i.official_recall_number in (n::text,(n+1)::text,(n+2)::text))
  order by n limit 1), true);
select set_config('p17.url', 'https://www.cpsc.gov/Recalls/2099/pgtap-' ||
  gen_random_uuid()::text, true);
select extensions.ok(current_setting('p17.api') ~ '^[0-9]+$'
  and current_setting('p17.no') ~ '^9[0-9]{4}$',
  'unused transaction-only CPSC identifiers were selected');
select set_config('p17.payload0', jsonb_build_object(
  'RecallID',current_setting('p17.api'), 'RecallNumber',current_setting('p17.no'),
  'RecallDate','2099-09-27', 'URL',current_setting('p17.url'),
  'Title','pgTAP forward-only baseline')::text, true);
select set_config('p17.payload_a', jsonb_build_object(
  'RecallID',current_setting('p17.api'),
  'RecallNumber',(current_setting('p17.no')::int+1)::text,
  'RecallDate','2099-09-27', 'URL',current_setting('p17.url') || '-collision',
  'Title','pgTAP retained collision', 'Description','revision A')::text, true);
select set_config('p17.payload_b', jsonb_set(current_setting('p17.payload_a')::jsonb,
  '{Description}','"revision B"')::text, true);
create function pg_temp.record_payload(p jsonb) returns jsonb language sql as $$
  select public.record_cpsc_retained_observation(p->>'RecallID',
    private.cpsc_payload_recall_number(p), p->>'URL',
    private.cpsc_canonical_url(p->>'URL'), p->>'Title',
    left(p->>'RecallDate',10)::date, private.cpsc_payload_sha256_v1(p),
    now(), 'remote pgTAP retained observation', p);
$$;
set local request.jwt.claims = '{"role":"service_role"}';
select set_config('p17.base',pg_temp.record_payload(current_setting('p17.payload0')::jsonb)::text,true);
select extensions.is(current_setting('p17.base')::jsonb->>'status','created',
  'baseline source identity is created transactionally');
select set_config('p17.a',pg_temp.record_payload(current_setting('p17.payload_a')::jsonb)::text,true);
select extensions.is(current_setting('p17.a')::jsonb->>'status','quarantined',
  'reused API ID is quarantined');
select extensions.is(current_setting('p17.a')::jsonb->>'payloadRetention','retained',
  'quarantine stores its complete source payload');
select extensions.is((select p.canonical_payload_sha256 from private.cpsc_observation_payloads p
  where p.canonical_payload_sha256=current_setting('p17.a')::jsonb->>'payloadSha256'),
  private.cpsc_payload_sha256_v1(current_setting('p17.payload_a')::jsonb),
  'database-computed hash verifies retained revision A');
select set_config('p17.a_replay',pg_temp.record_payload(current_setting('p17.payload_a')::jsonb)::text,true);
select extensions.ok(current_setting('p17.a_replay')::jsonb->>'observationId' =
  current_setting('p17.a')::jsonb->>'observationId'
  and (current_setting('p17.a_replay')::jsonb->>'replayed')::boolean,
  'duplicate sighting reuses the same review item');
select extensions.is((select seen_count from private.cpsc_observation_sightings s
  where s.observation_id=(current_setting('p17.a')::jsonb->>'observationId')::uuid),
  2::bigint, 'duplicate sighting increments only its counter');
select set_config('p17.b',pg_temp.record_payload(current_setting('p17.payload_b')::jsonb)::text,true);
select extensions.ok(current_setting('p17.b')::jsonb->>'observationId' <>
  current_setting('p17.a')::jsonb->>'observationId' and
  current_setting('p17.b')::jsonb->>'payloadSha256' <>
  current_setting('p17.a')::jsonb->>'payloadSha256',
  'changed payload preserves a second observation and hash');
select extensions.is((select count(*) from private.cpsc_observation_payloads p
  where p.canonical_payload_sha256 in (current_setting('p17.a')::jsonb->>'payloadSha256',
    current_setting('p17.b')::jsonb->>'payloadSha256')), 2::bigint,
  'both source payload revisions remain stored');
select extensions.ok((private.cpsc_watermark_safety()->>'safe')::boolean,
  'retained quarantine permits CPSC watermark safety');
reset request.jwt.claims;

select set_config('p17.reconciler',gen_random_uuid()::text,true);
insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values (current_setting('p17.reconciler')::uuid,'authenticated','authenticated',
  'pgtap-'||current_setting('p17.reconciler')||'@example.invalid','',now(),'{}','{}',now(),now());
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
insert into private.cpsc_admin_capabilities(user_id,capability,authorized_at,reason)
values (current_setting('p17.reconciler')::uuid,'identity_reconciliation',
  now()-interval '1 minute','transaction-only pgTAP proof');
select set_config('p17.reviewer',gen_random_uuid()::text,true);
insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values (current_setting('p17.reviewer')::uuid,'authenticated','authenticated',
  'pgtap-'||current_setting('p17.reviewer')||'@example.invalid','',now(),'{}','{}',now(),now());
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
insert into private.cpsc_reviewer_authorizations(user_id,authorized_at,reason)
values (current_setting('p17.reviewer')::uuid,now()-interval '1 minute',
  'transaction-only criterion reviewer');
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select extensions.throws_ok(format(
  'select public.reconcile_cpsc_quarantined_observation(%L::uuid,%L,%L)',
  current_setting('p17.a')::jsonb->>'observationId','reject_observation','worker'),
  '42501',null,'worker cannot reconcile a retained quarantine');
reset role;
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated',
  'sub',current_setting('p17.reviewer'),'aal','aal2',
  'session_id',current_setting('p17.reviewer'))::text,true);
select extensions.throws_ok(format('select public.get_cpsc_quarantine_packet(%L::uuid)',
  current_setting('p17.a')::jsonb->>'observationId'),
  '42501',null,'criterion reviewer without reconciliation capability is denied');
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated',
  'sub',current_setting('p17.reconciler'),'aal','aal2',
  'session_id',current_setting('p17.reconciler'))::text,true);
select set_config('p17.packet',public.get_cpsc_quarantine_packet(
  (current_setting('p17.a')::jsonb->>'observationId')::uuid)::text,true);
reset role;
reset request.jwt.claims;
select extensions.is(current_setting('p17.packet')::jsonb #> '{sourceRevision,payload}',
  current_setting('p17.payload_a')::jsonb,
  'authorized reconciler reads the exact retained payload');
select extensions.ok((current_setting('p17.packet')::jsonb #>> '{sourceRevision,hashVerified}')::boolean,
  'reconciler packet verifies its hash in the database');

select extensions.lives_ok($$select public.record_recall_source_sync_result('cpsc','success',
  '{"kind":"last_publish_date","value":"2099-09-27"}')$$,
  'retained quarantine permits a forward CPSC cursor');
select extensions.throws_ok($$select public.record_recall_source_sync_result('cpsc','success',
  '{"kind":"last_publish_date","value":"2099-09-17"}')$$,
  '23514',null,'CPSC backward cursor is rejected');
select extensions.lives_ok($$select public.record_recall_source_sync_result('cpsc','success',
  '{"kind":"last_publish_date","value":"2099-09-27"}')$$,
  'CPSC same-date cursor is idempotent');
select extensions.lives_ok($$select public.record_recall_source_sync_result('cpsc','success',
  '{"kind":"last_publish_date","value":"2099-09-28"}')$$,
  'CPSC forward cursor is accepted');
select extensions.throws_ok($$select public.record_recall_source_sync_result('cpsc','success',
  '{"kind":"last_updated_date","value":"2099-09-29"}')$$,
  '23514',null,'CPSC kind change fails closed');
select extensions.lives_ok($$select public.record_recall_source_sync_result('health_canada','success',
  '{"kind":"last_updated_date","value":"2099-09-27"}')$$,
  'Health Canada cursor advances using its own kind');
select extensions.throws_ok($$select public.record_recall_source_sync_result('health_canada','success',
  '{"kind":"last_updated_date","value":"2099-09-17"}')$$,
  '23514',null,'Health Canada backward cursor is rejected');
select extensions.lives_ok($$select public.record_recall_source_sync_result('health_canada','success',
  '{"kind":"last_updated_date","value":"2099-09-27"}')$$,
  'Health Canada same-date cursor is idempotent');
select extensions.lives_ok($$select public.record_recall_source_sync_result('health_canada','success',
  '{"kind":"last_updated_date","value":"2099-09-28"}')$$,
  'Health Canada forward cursor is accepted');
select extensions.lives_ok($$select public.record_recall_source_sync_result('health_canada','failed',
  '{"kind":"last_updated_date","value":"2099-09-29"}','record_rejected')$$,
  'failed source outcome can be recorded');
select extensions.is((select st.watermark->>'value' from private.recall_source_sync_state st
  join public.recall_sources s on s.id=st.source_id where s.source_key='health_canada'),
  '2099-09-28','failed source outcome cannot advance its cursor');
update private.recall_automation_state set last_successful_watermark=
  greatest(coalesce(last_successful_watermark,'2099-09-27'::date),'2099-09-27'::date)
where singleton;
select extensions.throws_ok($$update private.recall_automation_state
  set last_successful_watermark=last_successful_watermark - 1 where singleton$$,
  '23514',null,'automation cursor cannot move backward');

-- The legacy worker API can still make a hash-only quarantine; the 16.16
-- retention gate must continue to block advancement after this migration.
set local request.jwt.claims = '{"role":"service_role"}';
select set_config('p17.legacy',public.record_cpsc_identity_observation(
  current_setting('p17.api'),(current_setting('p17.no')::int+2)::text,
  current_setting('p17.url')||'-legacy',current_setting('p17.url')||'-legacy',
  'pgTAP legacy hash-only','2099-09-27',repeat('e',64),now(),
  'remote pgTAP legacy gate')::text,true);
reset request.jwt.claims;
select extensions.is(current_setting('p17.legacy')::jsonb->>'status','quarantined',
  'legacy worker path can produce a hash-only quarantine');
select extensions.ok(not (private.cpsc_watermark_safety()->>'safe')::boolean,
  'hash-only quarantine makes safety false');
select extensions.throws_ok($$select public.record_recall_source_sync_result('cpsc','success',
  '{"kind":"last_publish_date","value":"2099-09-29"}')$$,
  '23514',null,'hash-only quarantine blocks CPSC cursor advancement');
select extensions.is((select st.watermark->>'value' from private.recall_source_sync_state st
  join public.recall_sources s on s.id=st.source_id where s.source_key='cpsc'),
  '2099-09-28','blocked advance leaves CPSC cursor unchanged');

select * from extensions.finish();
rollback;
