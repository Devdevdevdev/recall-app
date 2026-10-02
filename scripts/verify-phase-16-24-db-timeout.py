"""Local only: prove the dedicated DB login cancels and rolls back slow work."""

from __future__ import annotations

import os
import secrets
import subprocess
import time
DB_CONTAINER = "supabase_db_RECALL"
running = subprocess.run(
    ["docker", "ps", "--filter", f"name=^/{DB_CONTAINER}$", "--format", "{{.Names}}"],
    text=True, capture_output=True, check=True,
)
if running.stdout.strip() != DB_CONTAINER:
    raise SystemExit("Local RECALL database container is unavailable.")
ADMIN = ["docker", "exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres",
         "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"]
WORKER = [
    "psql",
    "-X",
    "-A",
    "-t",
    "-h",
    "127.0.0.1",
    "-p",
    "54322",
    "-U",
    "cpsc_page_worker",
    "-d",
    "postgres",
]


def admin(sql: str) -> str:
    result = subprocess.run(
        ADMIN,
        input=sql,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()


def main() -> None:
    password = secrets.token_urlsafe(40)
    admin(f"alter role cpsc_page_worker password '{password}';")
    env = {**os.environ, "PGPASSWORD": password}
    try:
        source = admin("select public.ensure_cpsc_recall_source();").splitlines()[-1]
        admin(
            "insert into public.recall_notices(id,source_id,external_id,title,"
            "description,hazard,remedy,recall_date,official_url,retrieved_at,raw_payload) "
            "values ('16249900-0000-4000-8000-000000000001',"
            f"'{source}'::uuid,'cpsc:26999','Timeout fixture','Description',"
            "'Hazard','Refund','2026-09-20',"
            "'https://www.cpsc.gov/Recalls/2026/P1624-Timeout',now(),"
            "'{\"RecallNumber\":\"26999\"}');"
            "insert into private.cpsc_source_identities(id,source_id,"
            "official_recall_number,canonical_url,canonical_notice_id,identity_status) "
            "values ('16249900-0000-4000-8000-000000000002',"
            f"'{source}'::uuid,'26999',"
            "'https://www.cpsc.gov/Recalls/2026/P1624-Timeout',"
            "'16249900-0000-4000-8000-000000000001','reconciled');"
            "insert into private.cpsc_notice_identity_links(notice_id,identity_id,provenance) "
            "values ('16249900-0000-4000-8000-000000000001',"
            "'16249900-0000-4000-8000-000000000002','Phase 16.24 timeout');"
            # Phase 16.32: the page stage is stopped by default; a local
            # fixture operator starts it (removed by the following db reset).
            "insert into auth.users(id,aud,role,email,encrypted_password,"
            "email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) "
            "values ('16249900-0000-4000-8000-000000000003','authenticated',"
            "'authenticated','p1624-timeout-operator@example.test','','2099-01-01',"
            "'{}','{}',now(),now());"
            "insert into private.cpsc_admin_capabilities(user_id,capability,authorized_at,reason) "
            "values ('16249900-0000-4000-8000-000000000003','operational_scheduler_control',"
            "now() - interval '1 hour','Phase 16.24 timeout operator');"
            # Phase 16.33: the operator needs a live aal2 session with fresh MFA.
            "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values "
            "('16249900-0000-4000-8000-000000000003','16249900-0000-4000-8000-000000000003',"
            "'aal2',now(),now());"
            "insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,"
            "created_at,updated_at) values ('16249900-0000-4000-8000-000000000003',"
            "'16249900-0000-4000-8000-000000000003','timeout TOTP','totp','verified',now(),now());"
            "insert into auth.mfa_amr_claims(id,session_id,authentication_method,created_at,"
            "updated_at) values (gen_random_uuid(),'16249900-0000-4000-8000-000000000003',"
            "'totp',now(),now());"
            "select set_config('request.jwt.claims','{\"role\":\"authenticated\","
            "\"aal\":\"aal2\",\"session_id\":\"16249900-0000-4000-8000-000000000003\","
            "\"sub\":\"16249900-0000-4000-8000-000000000003\"}',false);"
            "select public.start_cpsc_page_stage('Phase 16.24 timeout harness',1,1,10,10);"
        )
        claimed = subprocess.run(
            [*WORKER, "-v", "ON_ERROR_STOP=1", "-c",
             "select claim_id from public.claim_cpsc_page_evidence(1)"],
            env=env, text=True, capture_output=True, check=True,
        ).stdout.strip()
        if len(claimed) != 36:
            raise AssertionError("dedicated role could not claim timeout fixture")
        timeout = subprocess.run(
            [*WORKER, "-c", "show statement_timeout"],
            env=env,
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        assert timeout == "4s", f"unexpected dedicated role timeout: {timeout}"
        admin(
            """
            create function public.phase_16_24_local_slow_probe(p_claim_id uuid)
            returns void language plpgsql security definer set search_path = '' as $$
            begin
              update private.cpsc_page_attempts
                set error_code='timeout_probe' where id=p_claim_id;
              insert into private.cpsc_page_raw_payloads(sha256,raw_bytes)
              values (encode(extensions.digest(convert_to('phase-16-24-local-timeout',
                'UTF8'),'sha256'),'hex'),
                convert_to('phase-16-24-local-timeout','UTF8'));
              perform pg_sleep(6);
            end;
            $$;
            revoke all on function public.phase_16_24_local_slow_probe(uuid)
              from public, anon, authenticated, service_role;
            grant execute on function public.phase_16_24_local_slow_probe(uuid)
              to cpsc_page_worker;
            """
        )
        started = time.monotonic()
        result = subprocess.run(
            [*WORKER, "-v", "ON_ERROR_STOP=1", "-c",
             f"select public.phase_16_24_local_slow_probe('{claimed}'::uuid)"],
            env=env,
            text=True,
            capture_output=True,
        )
        elapsed = time.monotonic() - started
        assert result.returncode != 0, "slow DB statement unexpectedly succeeded"
        assert "canceling statement due to statement timeout" in result.stderr, (
            "slow DB statement did not hit database statement timeout"
        )
        assert 3.5 <= elapsed < 5.5, f"timeout elapsed {elapsed:.2f}s"
        count = admin(
            "select count(*) from private.cpsc_page_raw_payloads "
            "where raw_bytes=convert_to('phase-16-24-local-timeout','UTF8');"
        )
        assert count == "0", "timed-out transaction persisted raw bytes"
        attempt = admin(
            "select outcome||'|'||coalesce(error_code,'') "
            "from private.cpsc_page_attempts "
            f"where id='{claimed}'::uuid;"
        )
        assert attempt == "claimed|", "timed-out attempt update did not roll back"
        admin(
            "update private.cpsc_page_work_state "
            "set claim_expires_at=now()-interval '1 second' "
            "where identity_id='16249900-0000-4000-8000-000000000002';"
        )
        reclaimed = subprocess.run(
            [*WORKER, "-v", "ON_ERROR_STOP=1", "-c",
             "select claim_id from public.claim_cpsc_page_evidence(1)"],
            env=env, text=True, capture_output=True, check=True,
        ).stdout.strip()
        assert len(reclaimed) == 36 and reclaimed != claimed, (
            "timed-out claim was not recoverable after lease expiry"
        )
        old_outcome = admin(
            "select outcome from private.cpsc_page_attempts "
            f"where id='{claimed}'::uuid;"
        )
        assert old_outcome == "claimed", "expired attempt history was rewritten"
        print(f"role timeout: {timeout}; cancellation: 57014; elapsed: {elapsed:.2f}s")
        print("timed-out security-definer insert rollback: 0 payload rows")
        print("timed-out claim: preserved and recovered after lease expiry")
    finally:
        admin(
            "drop function if exists public.phase_16_24_local_slow_probe(uuid); "
            "alter role cpsc_page_worker password null;"
        )
    revoked = subprocess.run(
        [*WORKER, "-v", "ON_ERROR_STOP=1", "-c", "select 1"],
        env=env, text=True, capture_output=True,
    )
    assert revoked.returncode != 0, "revoked local credential still connected"
    print("revoked dedicated login credential: denied")


if __name__ == "__main__":
    main()
