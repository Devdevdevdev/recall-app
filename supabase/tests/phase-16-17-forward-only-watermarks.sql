begin;
set local role postgres;
set local search_path = extensions, public, auth;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();
select public.ensure_cpsc_recall_source();

-- A clean local rebuild has no Health Canada cursor. Delete the state row in
-- this rolled-back test as well, so the bootstrap path is tested explicitly.
delete from private.recall_source_sync_state
where source_id = (select id from public.recall_sources where source_key = 'health_canada');
select extensions.lives_ok($$select public.record_recall_source_sync_result(
  'health_canada','success','{"kind":"last_updated_date","value":"2099-09-27"}')$$,
  'valid Health Canada cursor bootstraps a missing state row');
select extensions.is((select watermark->>'value' from private.recall_source_sync_state st
  join public.recall_sources s on s.id=st.source_id where s.source_key='health_canada'),
  '2099-09-27', 'bootstrap stores the exact ISO date');
select extensions.throws_ok($$select public.record_recall_source_sync_result(
  'health_canada','success','{"kind":"last_updated_date","value":"2099-09-17"}')$$,
  '23514', null, 'Health Canada backward request fails closed');
select extensions.lives_ok($$select public.record_recall_source_sync_result(
  'health_canada','success','{"kind":"last_updated_date","value":"2099-09-27"}')$$,
  'Health Canada same-date request is idempotent');
select extensions.lives_ok($$select public.record_recall_source_sync_result(
  'health_canada','success','{"kind":"last_updated_date","value":"2099-09-28"}')$$,
  'Health Canada forward request succeeds');
select extensions.is((select watermark->>'value' from private.recall_source_sync_state st
  join public.recall_sources s on s.id=st.source_id where s.source_key='health_canada'),
  '2099-09-28', 'Health Canada cursor moved only forward');
select extensions.lives_ok($$select public.record_recall_source_sync_result(
  'health_canada','failed','{"kind":"last_updated_date","value":"2099-09-29"}',
  'record_rejected')$$, 'failed source run is recorded without advancing');
select extensions.is((select watermark->>'value' from private.recall_source_sync_state st
  join public.recall_sources s on s.id=st.source_id where s.source_key='health_canada'),
  '2099-09-28', 'failed source run left cursor unchanged');
select extensions.throws_ok($$select public.record_recall_source_sync_result(
  'health_canada','success',null)$$, '23514', null,
  'normal ingestion cannot clear an established cursor');
select extensions.throws_ok($$select public.record_recall_source_sync_result(
  'health_canada','success','{"kind":"last_publish_date","value":"2099-09-29"}')$$,
  '23514', null, 'Health Canada cannot switch to the CPSC kind');
select extensions.throws_ok($$select public.record_recall_source_sync_result(
  'health_canada','success','{"kind":"last_updated_date","value":"2099-02-30"}')$$,
  '23514', null, 'invalid calendar date is rejected');
select extensions.throws_ok($$select public.record_recall_source_sync_result(
  'health_canada','success','{"kind":"last_updated_date","value":"2099-09-29T00:00:00Z"}')$$,
  '23514', null, 'timestamp representation is rejected rather than compared as text');
select extensions.throws_ok($$select public.record_recall_source_sync_result(
  'health_canada','success','{"kind":"last_updated_date","value":"2099-09-29","extra":1}')$$,
  '23514', null, 'extra cursor fields fail closed');

select extensions.lives_ok($$select public.record_recall_source_sync_result(
  'cpsc','success','{"kind":"last_publish_date","value":"2099-09-27"}')$$,
  'CPSC valid cursor advances on a safe local database');
select extensions.throws_ok($$select public.record_recall_source_sync_result(
  'cpsc','success','{"kind":"last_publish_date","value":"2099-09-17"}')$$,
  '23514', null, 'CPSC backward request fails closed');
select extensions.lives_ok($$select public.record_recall_source_sync_result(
  'cpsc','success','{"kind":"last_publish_date","value":"2099-09-27"}')$$,
  'CPSC same-date request is idempotent');
select extensions.lives_ok($$select public.record_recall_source_sync_result(
  'cpsc','success','{"kind":"last_publish_date","value":"2099-09-28"}')$$,
  'CPSC forward request succeeds');
select extensions.is((select watermark->>'value' from private.recall_source_sync_state st
  join public.recall_sources s on s.id=st.source_id where s.source_key='cpsc'),
  '2099-09-28', 'CPSC cursor moved only forward');
select extensions.throws_ok($$update private.recall_source_sync_state
  set watermark='{"kind":"last_publish_date","value":"2099-09-20"}'
  where source_id=(select id from public.recall_sources where source_key='cpsc')$$,
  '23514', null, 'direct database update cannot bypass the guard');
select extensions.throws_ok($$select public.record_recall_source_sync_result(
  'cpsc','success','{"kind":"last_updated_date","value":"2099-09-29"}')$$,
  '23514', null, 'CPSC cannot switch to the Health Canada kind');

update private.recall_automation_state set last_successful_watermark='2099-09-27'
where singleton;
select extensions.throws_ok($$update private.recall_automation_state
  set last_successful_watermark='2099-09-17' where singleton$$,
  '23514', null, 'automation cursor cannot move backward');
select extensions.throws_ok($$update private.recall_automation_state
  set last_successful_watermark=null where singleton$$,
  '23514', null, 'automation cursor cannot be cleared');
select extensions.lives_ok($$update private.recall_automation_state
  set last_successful_watermark='2099-09-27' where singleton$$,
  'automation same date succeeds');
select extensions.lives_ok($$update private.recall_automation_state
  set last_successful_watermark='2099-09-28' where singleton$$,
  'automation forward date succeeds');

select * from extensions.finish();
rollback;
