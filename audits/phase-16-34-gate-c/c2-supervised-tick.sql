-- Phase 16.34 Gate C — step C2: ONE supervised ticket invocation (run once, right after C1).
-- Run: psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f audits/phase-16-34-gate-c/c2-supervised-tick.sql
-- Autocommit: pg_net sends the request only after this statement commits.
-- Expected output: {"decision": "dispatched", "requestId": <n>}. Never run it a second time.
select now() as tick_at, private.recall_automation_tick() as tick;
