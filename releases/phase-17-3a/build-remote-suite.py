#!/usr/bin/env python3
"""Builds releases/phase-17-3a/phase-17-3a-scan-provenance.remote.sql from the committed local
suite supabase/tests/phase-17-3a-scan-provenance.sql (Phase 17.3a release review).

Transformations, and nothing else:
  * the pgTAP install line is removed (run-remote-pgtap.mjs injects a transaction-scoped one);
  * the transient REVOKE/GRANT probe on private.expand_upce_to_upca and its assertion are removed
    (a production privilege is never changed, even inside a rolled-back transaction; proved locally);
  * production guards and timeouts are added after BEGIN;
  * production fingerprints frozen by the release review are asserted (17.3-S bodies, F-4, flags,
    cron).
Usage: python3 releases/phase-17-3a/build-remote-suite.py [--check]
"""
import re
import sys

SOURCE = 'supabase/tests/phase-17-3a-scan-provenance.sql'
TARGET = 'releases/phase-17-3a/phase-17-3a-scan-provenance.remote.sql'

HEADER = """-- Phase 17.3a REMOTE verification suite (rollback-only). Derived deterministically from
-- supabase/tests/phase-17-3a-scan-provenance.sql (commit b440a2f) by
-- releases/phase-17-3a/build-remote-suite.py: the pgTAP install line is removed (the runner
-- injects a transaction-scoped pgTAP), the transient REVOKE/GRANT probe is removed (never change a
-- production privilege, even rolled back; it is proved locally), and production guards, timeouts
-- and frozen fingerprints are added. Run ONLY with: npm run test:remote-pgtap -- --file <this file>
"""

GUARDS = """set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local idle_in_transaction_session_timeout = '60s';
do $guard$
begin
  if pg_catalog.to_regprocedure('private.expand_upce_to_upca(text)') is null
    or (select count(*) from information_schema.columns where table_schema = 'public'
          and table_name = 'owned_products' and column_name in ('barcode_raw_value', 'barcode_symbology')) <> 2 then
    raise exception 'Phase 17.3a is not installed: the remote suite refuses to run';
  end if;
  if pg_catalog.to_regprocedure('private.automatic_alert_eligibility(uuid,uuid)') is null then
    raise exception 'Phase 17.7a F-4 is not installed: the remote suite refuses to run';
  end if;
end;
$guard$;
"""

FROZEN = """-- ===========================================================================
-- Production fingerprints frozen by the 17.3a release review (unchanged by 17.3a).
-- ===========================================================================
select extensions.is(md5(pg_get_functiondef('private.canonical_gtin14(text)'::regprocedure)),
  '1f360d45c59400d5a49ee82636ff680c', 'canonical_gtin14 unchanged (17.3-S body)');
select extensions.is(md5(pg_get_functiondef('public.get_recall_candidates(uuid,integer,uuid,integer)'::regprocedure)),
  '695243ea58ac9b8b7cd61cfe9830555e', 'get_recall_candidates unchanged (17.3-S body)');
select extensions.is(md5(pg_get_functiondef('public.get_owned_product_recall_candidates(uuid,integer,uuid,integer)'::regprocedure)),
  '985de76d0dee90834b720c55d46d7e2e', 'get_owned_product_recall_candidates unchanged (17.3-S body)');
select extensions.is(
  (select md5(string_agg(pg_get_functiondef(p.oid), ',' order by p.oid::regprocedure::text))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'automatic_alert_eligibility%'),
  'b6a31c8dd6b5e631b0ec2a1038483353', 'F-4 eligibility function unchanged');
select extensions.is((select count(*)::integer from pg_trigger where not tgisinternal and tgname in (
  'alerts_require_safe_scope', 'recall_alert_eligibility_v2_require_safe_scope',
  'recall_alert_snapshots_v2_require_safe_scope', 'recall_matches_require_safe_confirmation',
  'recall_match_evaluations_v2_require_safe_confirmation')), 5, 'F-4 guards all five automatic alert writes');
select extensions.is(
  (select to_jsonb(c) - 'updated_at' from private.recall_automation_control c),
  '{"enabled": true, "singleton": true, "ai_enabled": true, "push_enabled": true, "catch_up_days": 7, "overlap_hours": 48, "bootstrap_days": 7, "max_recalls_per_run": 100, "product_check_enabled": true, "max_ai_escalations_per_run": 5, "max_candidate_pairs_per_run": 500, "max_notification_batch_size": 25, "max_product_check_candidates": 25}'::jsonb,
  'automation flags unchanged');
select extensions.is(
  (select jsonb_agg(jsonb_build_object('jobname', jobname, 'schedule', schedule, 'active', active) order by jobid) from cron.job),
  '[{"active": true, "jobname": "recall-automation-every-6h", "schedule": "17 */6 * * *"}]'::jsonb,
  'cron unchanged');

"""


def build(source: str) -> str:
    lines = source.split('\n')
    out, skip = [], False
    for line in lines:
        if line.strip() == 'create extension if not exists pgtap with schema extensions;':
            continue
        if line.startswith('revoke execute on function private.expand_upce_to_upca(text) from authenticated;'):
            skip = True
        if skip:
            if line.startswith('grant execute on function private.expand_upce_to_upca(text) to authenticated;'):
                skip = False
            continue
        out.append(line)
    text = '\n'.join(out)
    text, removed = re.subn(
        r"select extensions\.is\(current_setting\('t173a\.without_grant'\), 'state:42501',\n  '[^\n]*'\);\n",
        '', text)
    assert removed == 1 and "t173a.without_grant'" not in text.replace(
        "select set_config('t173a.without_grant'", ''), 'unexpected source shape'
    begin = text.index('\nbegin;\n') + len('\nbegin;\n')
    text = HEADER + text[:begin] + GUARDS + text[begin:]
    anchor = '-- ===========================================================================\n-- Nothing else changed.'
    assert anchor in text, 'anchor missing'
    return text.replace(anchor, FROZEN + anchor, 1)


if __name__ == '__main__':
    built = build(open(SOURCE).read())
    if '--check' in sys.argv:
        current = open(TARGET).read()
        print('identical' if current == built else 'DIFFERENT')
        sys.exit(0 if current == built else 1)
    open(TARGET, 'w').write(built)
    print(f'wrote {TARGET}')
