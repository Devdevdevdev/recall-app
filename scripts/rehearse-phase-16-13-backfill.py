#!/usr/bin/env python3
"""Phase 16.13 historical backfill rehearsal with the FRESH manifest (disposable local stack).

Requires a fresh `npx supabase db reset --local --yes` (no CPSC notices yet). It
commits the 30 production-shaped historical notices, previews the whole backfill
(dry run), executes it, executes it again to prove idempotency, runs the
remote-safe pgTAP file against the populated database, and checks the live
identity gate after the backfill. Local stack only; reset afterwards.

Phase 16.13: the manifest is the fresh-capture manifest (every current observation
is a fresh, page-corroborated CPSC API value; 26777 is withheld as unresolved). A
UUID-free lineage fingerprint (aliases, API revisions, page revisions, fetches,
observations) must be identical across runs, and no backfilled revision may carry
a coverage proof (they stay fail-closed until the worker fetches live pages).
"""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTICES = json.loads((ROOT / "tests/fixtures/phase-16-10-notices.json").read_text())
# Phase 16.15: the manifest path is explicit (no phase path is defaulted).
if len(sys.argv) != 2:
    raise SystemExit("usage: rehearse-phase-16-13-backfill.py <manifest.json>")
MANIFEST = Path(sys.argv[1]).read_text()
MANIFEST_JSON = json.loads(MANIFEST)

DB_CONTAINER = "supabase_db_RECALL"
running = subprocess.run(
    ["docker", "ps", "--filter", f"name=^/{DB_CONTAINER}$", "--format", "{{.Names}}"],
    capture_output=True, text=True, check=True,
)
if running.stdout.strip() != DB_CONTAINER:
    raise SystemExit("Local RECALL database container is unavailable.")
PSQL = ["docker", "exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres",
        "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"]


def q(value):
    if value is None:
        return "null"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def psql(sql):
    result = subprocess.run([*PSQL, "-q"],
                            input=sql, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip())
    return result.stdout.strip()


def one(sql):
    return json.loads(psql(sql).splitlines()[-1])


checks = {}


def check(name, ok, detail=None):
    checks[name] = bool(ok)
    if not ok:
        print(f"FAIL {name}: {detail}", file=sys.stderr)


if psql("select count(*) from public.recall_notices n join public.recall_sources s on s.id = n.source_id "
        "where s.source_key = 'cpsc';") != "0":
    raise SystemExit("Rehearsal requires a fresh local reset (CPSC notices already present).")

# Production-shaped history: 30 stored notices and 43 scopes, keyed by numeric API IDs.
lines = ["begin;", "select set_config('r.source', public.ensure_cpsc_recall_source()::text, true);"]
for row in NOTICES:
    payload = {"RecallID": int(row["external_id"]), "RecallNumber": row["recall_number"]}
    lines.append(
        "insert into public.recall_notices (id,source_id,external_id,title,recall_date,official_url,"
        f"retrieved_at,raw_payload) values ({q(row['id'])},current_setting('r.source')::uuid,"
        f"{q(row['external_id'])},{q(row['title'])},{q(row['recall_date'])},{q(row['official_url'])},"
        f"'2026-09-20T00:00:00Z',{q(payload)}::jsonb);")
    for scope in row["scopes"]:
        lines.append(
            "insert into public.recall_scopes (id,recall_notice_id,product_name,gtin,model_number) values "
            f"({q(scope['id'])},{q(row['id'])},{q(scope['product_name'] or 'Fixture product')},"
            f"{q(scope['gtin'])},{q(scope['model_number'])});")
lines.append("commit;")
psql("\n".join(lines))

STATE = ("select json_build_object("
         "'identities',(select count(*) from private.cpsc_source_identities),"
         "'links',(select count(*) from private.cpsc_notice_identity_links),"
         "'aliases',(select count(*) from private.cpsc_source_aliases),"
         "'apiRevisions',(select count(*) from private.cpsc_api_revisions),"
         "'pageRevisions',(select count(*) from private.cpsc_page_revisions),"
         "'pageFetches',(select count(*) from private.cpsc_page_fetches),"
         "'observations',(select count(*) from private.cpsc_identity_observations),"
         "'quarantined',(select count(*) from private.cpsc_identity_observations where resolution='quarantined'),"
         "'reconciliations',(select count(*) from private.cpsc_identity_reconciliations),"
         "'reviewLedger',(select count(*) from private.cpsc_candidate_review_ledger),"
         "'ruleSets',(select count(*) from private.recall_scope_rule_sets_v2),"
         "'notices',(select count(*) from public.recall_notices),"
         "'scopes',(select count(*) from public.recall_scopes),"
         "'historicalDigest',private.cpsc_historical_rows_digest(current_setting('r.source')::uuid),"
         "'canonicalDigest',private.cpsc_canonical_identity_digest(current_setting('r.source')::uuid),"
         "'coverageLedgers',(select count(*) from private.cpsc_page_coverage_ledgers),"
         "'lineageDigest',encode(sha256(convert_to(concat_ws(chr(10),"
         "(select string_agg(concat_ws('|',i.official_recall_number,a.alias_kind,a.alias_value,n.external_id),chr(10) "
         "order by i.official_recall_number,a.alias_kind,a.alias_value,n.external_id) from private.cpsc_source_aliases a "
         "join private.cpsc_source_identities i on i.id=a.identity_id left join public.recall_notices n on n.id=a.notice_id),"
         "(select string_agg(concat_ws('|',i.official_recall_number,r.upstream_api_id,r.payload_hash),chr(10) "
         "order by i.official_recall_number,r.upstream_api_id,r.payload_hash) from private.cpsc_api_revisions r "
         "join private.cpsc_source_identities i on i.id=r.identity_id),"
         "(select string_agg(concat_ws('|',r.recall_number,r.evidence_hash,r.canonical_url,r.parser_version),chr(10) "
         "order by r.recall_number,r.evidence_hash) from private.cpsc_page_revisions r),"
         "(select string_agg(concat_ws('|',i.official_recall_number,f.fetched_at,f.http_status,f.raw_page_hash),chr(10) "
         "order by i.official_recall_number,f.fetched_at) from private.cpsc_page_fetches f "
         "join private.cpsc_source_identities i on i.id=f.identity_id),"
         "(select string_agg(concat_ws('|',o.official_recall_number,o.upstream_api_id,o.payload_hash,o.observed_at,"
         "o.decision_class,o.resolution),chr(10) order by o.official_recall_number,o.upstream_api_id,o.observed_at,"
         "o.decision_class) from private.cpsc_identity_observations o)),'UTF8')),'hex'));")
source = "select set_config('r.source',(select id::text from public.recall_sources where source_key='cpsc'),false);"


def state():
    return one(source + STATE)


def backfill(execute, label):
    return one(f"select private.cpsc_historical_backfill({q(MANIFEST)}::jsonb,'all',{str(execute).lower()},"
               f"{q(label)},5000);")


before = state()
dry = backfill(False, "Phase 16.13 fresh-manifest dry run")
after_dry = state()
first = backfill(True, "Phase 16.13 fresh-manifest first execution")
after_first = state()
second = backfill(True, "Phase 16.13 fresh-manifest idempotency run")
after_second = state()

structure_expected = {"identitiesCreated": 27, "linksCreated": 30, "aliasesCreated": 60,
                      "apiRevisionsCreated": 30, "pageRevisionsCreated": 27, "pageFetchesCreated": 27,
                      "noticesWithoutRecallNumber": 0}
check("dry run reports the full structure plan", dry["structure"]["counts"] == structure_expected,
      dry["structure"]["counts"])
check("dry run reports 3 duplicate groups", len(dry["structure"]["duplicateGroups"]) == 3)
check("dry run finds no unexpected conflict",
      dry["structure"]["unexpectedConflicts"] == 0 and dry["observations"]["unexpectedConflicts"] == 0)
check("dry run reports 6 collisions before any write", dry["observations"]["collisions"] == 6)
check("dry run reports the manifest's drift rows (12 API drift rows, 1 withheld as unresolved)",
      dry["observations"]["driftRows"] == MANIFEST_JSON["expected"]["driftRows"] == 11
      and MANIFEST_JSON["expected"]["apiDriftRows"] == 12, dry["observations"]["driftRows"])
check("fresh manifest carries only fresh, page-corroborated observations",
      len(MANIFEST_JSON["currentObservations"]) == 26
      and all(o["observedAt"] == MANIFEST_JSON["freshCapture"]["capturedAtUtc"] for o in MANIFEST_JSON["currentObservations"])
      and [u["recallNumber"] for u in MANIFEST_JSON["unresolvedIdentities"]] == ["26777"])
check("dry run persisted nothing", after_dry == before and dry["persisted"] is False, after_dry)
check("execution equals its dry run",
      first["structure"]["counts"] == dry["structure"]["counts"]
      and first["observations"]["decisionClasses"] == dry["observations"]["decisionClasses"]
      and first["observations"]["quarantines"] == dry["observations"]["quarantines"])
check("first run: 27 identities, 30 links, 27 page revisions and fetches",
      after_first["identities"] == 27 and after_first["links"] == 30
      and after_first["pageRevisions"] == 27 and after_first["pageFetches"] == 27, after_first)
check("first run: exactly the 6 known collisions quarantined", after_first["quarantined"] == 6, after_first)
check("second run: 0 new rows",
      second["structure"]["newRows"] == 0 and second["observations"]["newRows"] == 0, second)
check("second run: no duplicate identity, link, alias, revision, fetch, or observation",
      {k: v for k, v in after_second.items()} == after_first, (after_first, after_second))
check("same canonical fingerprints", after_second["canonicalDigest"] == after_first["canonicalDigest"])
check("same lineage fingerprints", after_second["lineageDigest"] == after_first["lineageDigest"])
check("no backfilled revision carries a coverage proof (fail-closed until live fetch)",
      after_second["coverageLedgers"] == 0)
check("0 historical rewrites", after_second["historicalDigest"] == before["historicalDigest"]
      and before["notices"] == after_second["notices"] == 30 and before["scopes"] == after_second["scopes"] == 43)
check("no automatic human reconciliation", after_second["reconciliations"] == 0)
check("no review or matcher rule set created",
      after_second["reviewLedger"] == 0 and after_second["ruleSets"] == 0)

structural = one(source + "select json_build_object("
  "'duplicateGroups',(select count(*) from (select identity_id from private.cpsc_notice_identity_links "
  "group by identity_id having count(*) = 2) d),"
  "'misassociations',(select count(*) from private.cpsc_identity_observations o join "
  "private.cpsc_source_identities i on i.id = o.identity_id where o.resolution = 'resolved' "
  "and o.official_recall_number <> i.official_recall_number),"
  "'quarantineClasses',(select json_object_agg(decision_class, n) from (select decision_class, count(*) n "
  "from private.cpsc_identity_observations where resolution = 'quarantined' group by 1) x),"
  "'collidingApiIds',(select json_agg(upstream_api_id order by upstream_api_id) from "
  "private.cpsc_identity_observations where decision_class = 'D_api_id_reuse'));")
check("3 duplicate groups linked, not merged", structural["duplicateGroups"] == 3, structural)
check("0 misassociations", structural["misassociations"] == 0, structural)
check("the six collisions are the known reused IDs 10965-10970",
      structural["collidingApiIds"] == [str(n) for n in range(10965, 10971)], structural)

report_text = json.dumps([dry, first, second])
owned_ids = psql("select coalesce(string_agg(id::text, ' '), '') from public.owned_products;").split()
check("reports contain no owned-product data",
      not any(identifier in report_text for identifier in owned_ids)
      and not re.search(r"owned|user_?id|email|serial|purchase", report_text, re.I))

# Remote-safe file, unchanged, against the populated database (pgTAP is transaction-local).
remote = (ROOT / "supabase/tests/remote/phase-16-production-compatibility.sql").read_text()
remote = re.sub(r"^begin;$", "begin;\ncreate extension if not exists pgtap with schema extensions;",
                remote, count=1, flags=re.M)
remote_run = subprocess.run(PSQL,
                            input=remote, capture_output=True, text=True)
remote_ok = len(re.findall(r"^ok ", remote_run.stdout, re.M))
remote_not_ok = len(re.findall(r"^not ok ", remote_run.stdout, re.M))
plan = re.search(r"^1\.\.(\d+)$", remote_run.stdout, re.M)
check("remote-safe pgTAP passes against populated fixtures",
      remote_run.returncode == 0 and plan and remote_ok == int(plan.group(1)) and remote_not_ok == 0,
      remote_run.stderr[-500:])
check("remote-safe pgTAP persisted nothing", state() == after_second)

# The live worker gate after the backfill (rolled back).
live = one("begin; set local request.jwt.claims = '{\"role\":\"service_role\"}';"
  "select json_build_object("
  "'storedId',public.record_cpsc_identity_observation('10965','26748',"
  "'https://www.cpsc.gov/Recalls/2026/Ricky-Joy-Recalls-More-Than-2-3-Million-Sour-Crush-Candy-Bottles-Due-to-Risk-of-Serious-Injury-or-Death-from-Choking-Hazard',"
  "'https://www.cpsc.gov/Recalls/2026/Ricky-Joy-Recalls-More-Than-2-3-Million-Sour-Crush-Candy-Bottles-Due-to-Risk-of-Serious-Injury-or-Death-from-Choking-Hazard',"
  "'Ricky Joy Recalls More Than 2.3 Million Sour Crush Candy Bottles Due to Risk of Serious Injury or Death from Choking Hazard',"
  "'2026-09-10',repeat('a',64),now(),'rehearsal')->>'decisionClass',"
  "'reusedId',(select public.record_cpsc_identity_observation(o.upstream_api_id,o.official_recall_number,"
  "o.observed_url,o.canonical_url,o.title,o.publication_date,o.payload_hash,now(),'rehearsal')->>'status' "
  "from private.cpsc_identity_observations o where o.decision_class='D_api_id_reuse' limit 1)); rollback;")
check("live gate: a stored API ID resolves to its own recall", live["storedId"] == "A_known_alias", live)
check("live gate: a reused API ID still quarantines", live["reusedId"] == "quarantined", live)

summary = {
    "dryRun": {"structure": dry["structure"]["counts"], "duplicateGroups": dry["structure"]["duplicateGroups"],
               "decisionClasses": dry["observations"]["decisionClasses"],
               "collisions": dry["observations"]["collisions"], "driftRows": dry["observations"]["driftRows"],
               "quarantines": dry["observations"]["quarantines"],
               "unexpectedConflicts": dry["structure"]["unexpectedConflicts"] + dry["observations"]["unexpectedConflicts"],
               "persisted": dry["persisted"],
               "unresolvedIdentities": MANIFEST_JSON["unresolvedIdentities"]},
    "firstRun": {"newRows": first["structure"]["newRows"] + first["observations"]["newRows"],
                 "state": {k: v for k, v in after_first.items() if not k.endswith("Digest")}},
    "secondRun": {"newRows": second["structure"]["newRows"] + second["observations"]["newRows"],
                  "reused": second["structure"]["counts"],
                  "observationsAlreadyRecorded": second["observations"]["counts"].get("observationsAlreadyRecorded")},
    "canonicalDigest": after_second["canonicalDigest"],
    "lineageDigest": after_second["lineageDigest"],
    "historicalDigestUnchanged": after_second["historicalDigest"] == before["historicalDigest"],
    "remoteSafe": {"planned": int(plan.group(1)) if plan else None, "ok": remote_ok, "notOk": remote_not_ok},
    "liveGate": live,
    "checksPassed": sum(checks.values()),
    "checksTotal": len(checks),
}
print(json.dumps(summary, indent=2))
sys.exit(0 if all(checks.values()) else 1)
