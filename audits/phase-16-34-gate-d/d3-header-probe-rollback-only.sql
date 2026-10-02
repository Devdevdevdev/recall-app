-- Phase 16.34 Gate D — D3: rollback-only header probe (plan §9). NOTHING IS COMMITTED, NOTHING IS SENT.
-- pg_net sends a queued request only after its transaction commits; this file never commits.
-- Exactly ONE call to private.recall_automation_tick(). Only header NAMES are read, never values
-- (the ticket value is a secret). If any statement fails, ON_ERROR_STOP ends psql before ROLLBACK,
-- the server aborts the open transaction, and nothing is committed either way.
-- Side effects that survive the rollback (non-transactional, harmless): the ticket_seq identity and the
-- pg_net request-id sequence each advance by one, so the next natural ticket shows a gap (seq 5, not 4).
-- Run between natural runs (not within 30 min of a :17), once:
--   psql "$SUPABASE_DB_URL" -X -f audits/phase-16-34-gate-d/d3-header-probe-rollback-only.sql
-- Expected: header_keys = {content-type,x-recall-automation-ticket}, probe_pass = t, then ROLLBACK.
\set ON_ERROR_STOP 1
begin;
select (private.recall_automation_tick()->>'requestId')::bigint as request_id \gset
select :request_id as request_id, array_agg(k order by k) as header_keys,
  array_agg(k order by k) = array['content-type', 'x-recall-automation-ticket'] as probe_pass
from net.http_request_queue q, jsonb_object_keys(q.headers) k
where q.id = :request_id;
rollback;
