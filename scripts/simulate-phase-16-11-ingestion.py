#!/usr/bin/env python3
"""Rollback-only Phase 16.11 ingestion simulation against the disposable local stack.

30 production-shaped notices, the 12 drift observations (6 numeric-ID collisions),
3 duplicate groups, one synthetic new recall, one contradictory identity, and one
legitimate title correction. Worker calls run as the service role; reconciliation
runs as an authenticated, authorized human. The transaction always rolls back.
"""

import json
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
NOTICES = json.loads((ROOT / "tests/fixtures/phase-16-10-notices.json").read_text())
DATA = json.loads((ROOT / "docs/phase-16-9-prototype-dataset.json").read_text())
AUDIT = json.loads((ROOT / "docs/phase-16-9-identity-audit.json").read_text())
BY_NUMBER = {page["recallNumber"]: page for page in DATA["pages"]}
DRIFT = {row["storedExternalId"]: row for row in AUDIT["driftCases"]}
DUPLICATE_CANONICAL = {
    row["officialRecallNumber"]: row["canonicalCandidateNoticeId"] for row in AUDIT["duplicateGroups"]
}
REVIEWER = "16119999-0000-4000-8000-000000000001"


def q(value):
    if value is None:
        return "null"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


def as_worker(statement):
    return ["set local request.jwt.claims = '{\"role\":\"service_role\"}';", statement, "reset request.jwt.claims;"]


lines = [
    "begin;",
    "set local search_path = public, extensions;",
    "select set_config('sim.source', public.ensure_cpsc_recall_source()::text, true);",
]
for row in NOTICES:
    payload = {"RecallID": row["external_id"], "RecallNumber": row["recall_number"]}
    lines.append(
        "insert into public.recall_notices "
        "(id,source_id,external_id,title,recall_date,official_url,retrieved_at,raw_payload) "
        f"values ({q(row['id'])},current_setting('sim.source')::uuid,{q(row['external_id'])},"
        f"{q(row['title'])},{q(row['recall_date'])},{q(row['official_url'])},now(),{q(payload)}::jsonb);"
    )
    for scope in row["scopes"]:
        lines.append(
            "insert into public.recall_scopes (id,recall_notice_id,product_name,gtin,model_number) "
            f"values ({q(scope['id'])},{q(row['id'])},{q(scope['product_name'] or 'Fixture product')},"
            f"{q(scope['gtin'])},{q(scope['model_number'])});"
        )

# Historical backfill is an administrative migration step (table owner), exactly
# as in Phase 16.10: identities, page revisions, transport snapshots, links, aliases.
for page in DATA["pages"]:
    number = page["recallNumber"]
    first = next(row for row in NOTICES if row["recall_number"] == number)
    ident = f"(select id from private.cpsc_source_identities where official_recall_number={q(number)})"
    lines.append(
        "insert into private.cpsc_source_identities "
        "(source_id,official_recall_number,canonical_url,canonical_notice_id,identity_status) "
        f"values (current_setting('sim.source')::uuid,{q(number)},{q(page['canonicalUrl'])},"
        f"{q(DUPLICATE_CANONICAL.get(number, first['id']))},'reconciled');"
    )
    evidence = {k: page[k] for k in ("recallNumber", "canonicalUrl", "title", "publicationDate", "description", "recallDetails", "tables")}
    lines.append(
        "insert into private.cpsc_page_revisions "
        "(identity_id,evidence_hash,recall_number,canonical_url,title,section_hashes,normalized_evidence,parser_version) "
        f"values ({ident},{q(page['normalizedEvidenceHash'])},{q(number)},{q(page['canonicalUrl'])},"
        f"{q(page['title'])},{q(page['sectionHashes'])}::jsonb,{q(evidence)}::jsonb,'phase-16.9-v1');"
    )
    lines.append(
        "insert into private.cpsc_page_fetches "
        "(identity_id,revision_id,fetched_at,http_status,raw_page_hash,final_url,content_type) "
        f"values ({ident},(select id from private.cpsc_page_revisions where identity_id={ident}),"
        f"{q(page['fetchTimestamp'])},200,{q(page['rawPageHash'])},{q(page['canonicalUrl'])},'text/html');"
    )
for row in NOTICES:
    ident = f"(select id from private.cpsc_source_identities where official_recall_number={q(row['recall_number'])})"
    lines.append(
        "insert into private.cpsc_notice_identity_links (notice_id,identity_id,provenance) "
        f"values ({q(row['id'])},{ident},'Phase 16.8 frozen historical row');"
    )
    for kind, value in (("api_id", row["external_id"]), ("official_url", row["official_url"])):
        lines.append(
            "insert into private.cpsc_source_aliases "
            "(identity_id,notice_id,alias_kind,alias_value,provenance,first_seen_at,last_seen_at) "
            f"values ({ident},{q(row['id'])},{q(kind)},{q(value)},'Phase 16.8 stored',now(),now());"
        )
    stored = next(item for item in DATA["noticeRows"] if item["storedExternalId"] == row["external_id"])
    lines.append(
        "insert into private.cpsc_api_revisions "
        "(identity_id,upstream_api_id,payload_hash,provenance,first_seen_at,last_seen_at) "
        f"values ({ident},{q(row['external_id'])},{q(stored['storedPayloadHash'])},'Phase 16.8 stored',now(),now());"
    )

lines += [
    "create temporary table sim_before as select id, external_id, title, official_url, recall_date, raw_payload "
    "from public.recall_notices;",
    "create temporary table sim_links_before as select notice_id, identity_id from private.cpsc_notice_identity_links;",
    "create temporary table sim_aliases_before as select identity_id, alias_kind, alias_value from private.cpsc_source_aliases;",
    "create temporary table sim_obs (pass int, stored text, result jsonb);",
]


def observe(pass_no, stored, api, number, observed, canonical, title, day, payload_hash):
    return as_worker(
        f"insert into sim_obs select {pass_no},{q(stored)},public.record_cpsc_identity_observation("
        f"{q(api)},{q(number)},{q(observed)},{q(canonical)},{q(title)},{q(day)},{q(payload_hash)},now(),"
        "'Phase 16.11 simulation');"
    )


current = []
for row in DATA["noticeRows"]:
    page = BY_NUMBER[row["recallNumber"]]
    observed = DRIFT.get(row["storedExternalId"], {}).get("currentOfficialUrl", page["canonicalUrl"])
    current.append((row["storedExternalId"], row["currentApiId"], row["recallNumber"], observed,
                    page["canonicalUrl"], page["title"], page["publicationDate"], row["currentPayloadHash"]))
for item in current:
    lines += observe(1, *item)

# Synthetic, structurally valid new recall (no historical evidence for its number/URL/API ID).
new_url = "https://www.cpsc.gov/Recalls/2026/Phase-16-11-Synthetic-New-Recall"
lines += observe(1, "synthetic-new", "99001", "26999", new_url, new_url, "Synthetic New Recall", "2026-09-24", "1" * 64)
lines += as_worker(
    "select public.ingest_cpsc_identity_notice((select (result->>'observationId')::uuid from sim_obs "
    "where stored = 'synthetic-new'),'Synthetic',null,null,now(),"
    "'{\"RecallID\":\"99001\",\"RecallNumber\":\"26-999\"}','[{\"productName\":\"Synthetic product\",\"modelNumber\":\"SYN-1\"}]');"
)
# Contradiction: recall number of one canonical recall with the URL of another.
first, second = DATA["pages"][0], DATA["pages"][1]
lines += observe(1, "conflict", "99002", first["recallNumber"], second["canonicalUrl"], second["canonicalUrl"],
                 first["title"], first["publicationDate"], "2" * 64)
# Legitimate title correction on a resolved recall with a known API alias.
plain = next(item for item in current if item[0] not in DRIFT)
lines += observe(1, "title-correction", plain[0], plain[2], plain[4], plain[4],
                 plain[5] + " (Corrected)", plain[6], "3" * 64)

# Human reconciliation of the six numeric-ID collisions (never a whitelist).
lines += [
    "insert into auth.users (id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,"
    f"raw_user_meta_data,created_at,updated_at) values ({q(REVIEWER)},'authenticated','authenticated',"
    "'phase1611-sim-reviewer@example.invalid','',now(),'{}','{}',now(),now());",
    f"insert into private.cpsc_reviewer_authorizations (user_id,authorized_at,reason) values ({q(REVIEWER)},"
    "now() - interval '1 hour','Phase 16.11 simulation reviewer');",
    "create temporary table sim_packets as select o.id, private.cpsc_quarantine_evidence(o.id) packet "
    "from private.cpsc_identity_observations o where o.resolution = 'quarantined' "
    "and o.decision_class = 'D_api_id_reuse';",
    "grant select on sim_packets to authenticated;",
    "set local role authenticated;",
    f"set local request.jwt.claims = '{{\"role\":\"authenticated\",\"sub\":\"{REVIEWER}\"}}';",
    "create temporary table sim_reconciled as select id, public.reconcile_cpsc_quarantined_observation(id,"
    "'confirm_alias','Official CPSC page for this recall number now serves this API ID; '"
    "|| 'historical alias retained') result from sim_packets;",
    "reset request.jwt.claims;",
    "reset role;",
]
for pass_no in (2, 3):
    for item in current:
        lines += observe(pass_no, *item)

checks = {
    "historical notices unchanged": "not exists (select 1 from sim_before b join public.recall_notices n on n.id=b.id "
    "where (n.external_id,n.title,n.official_url,n.recall_date,n.raw_payload) is distinct from "
    "(b.external_id,b.title,b.official_url,b.recall_date,b.raw_payload)) and (select count(*) from sim_before)=30",
    "historical links unchanged": "not exists (select * from sim_links_before except select notice_id, identity_id "
    "from private.cpsc_notice_identity_links)",
    "historical aliases preserved": "not exists (select * from sim_aliases_before except select identity_id, alias_kind, "
    "alias_value from private.cpsc_source_aliases)",
    "31 CPSC notices (30 + new)": "(select count(*) from public.recall_notices)=31",
    "44 scopes (43 + new)": "(select count(*) from public.recall_scopes)=44",
    "28 canonical identities (27 + new)": "(select count(*) from private.cpsc_source_identities)=28",
    "27 existing canonical pages preserved": "(select count(*) from private.cpsc_page_revisions)=27",
    "31 notice links": "(select count(*) from private.cpsc_notice_identity_links)=31",
    "3 duplicate groups linked, not merged": "(select count(*) from (select identity_id from "
    "private.cpsc_notice_identity_links group by identity_id having count(*)=2) d)=3",
    "first pass: 24 resolved, 6 collisions quarantined": "(select count(*) filter (where result->>'status'='resolved')=24 "
    "and count(*) filter (where result->>'decisionClass'='D_api_id_reuse')=6 from sim_obs where pass=1 and stored ~ '^[0-9]+$')",
    "new recall created and ingested": "(select result->>'status' from sim_obs where stored='synthetic-new')='created' "
    "and exists (select 1 from public.recall_notices n join private.cpsc_source_identities i on "
    "i.canonical_notice_id=n.id where n.external_id='cpsc:26999' and i.identity_status='reconciled')",
    "contradiction quarantined": "(select result->>'decisionClass' from sim_obs where stored='conflict')='E_number_url_conflict'",
    "title correction is a revision, not an identity": "(select result->>'status' from sim_obs where "
    "stored='title-correction')='resolved' and (select result->'revisionFlags' ? 'title_revised' from sim_obs "
    "where stored='title-correction')",
    "six human reconciliations audited": "(select count(*) from private.cpsc_identity_reconciliations "
    "where decision='confirm_alias' and reviewer_user_id=" + q(REVIEWER) + ")=6",
    "packets exposed conflicting historical aliases": "(select bool_and(jsonb_array_length(packet->'conflictingAliases')>0 "
    "or jsonb_array_length(packet->'historicalNotices')>0) from sim_packets)",
    "replay after reconciliation resolves all 30": "(select count(*) from sim_obs where pass=2 and result->>'status'='resolved')=30",
    "replay is deterministic": "not exists (select 1 from sim_obs a join sim_obs b on a.stored=b.stored and a.pass=2 "
    "and b.pass=3 where a.result->>'decisionClass' is distinct from b.result->>'decisionClass' "
    "or a.result->>'identityId' is distinct from b.result->>'identityId')",
    "zero resolved misassociation": "not exists (select 1 from private.cpsc_identity_observations o join "
    "private.cpsc_source_identities i on i.id=o.identity_id where o.resolution='resolved' "
    "and o.official_recall_number<>i.official_recall_number)",
    "no reviewed criterion or v2 output": "(select count(*) from private.recall_scope_criteria_v2)=0 and "
    "(select count(*) from private.recall_match_evaluations_v2)=0",
}
lines.append("do $$ begin")
for name, predicate in checks.items():
    lines.append(f"if not coalesce(({predicate}), false) then raise exception {q('simulation check failed: ' + name)}; end if;")
lines.append("end $$;")
lines.append(
    "select json_build_object("
    "'notices',(select count(*) from public.recall_notices),"
    "'scopes',(select count(*) from public.recall_scopes),"
    "'canonicalIdentities',(select count(*) from private.cpsc_source_identities),"
    "'canonicalPages',(select count(*) from private.cpsc_page_revisions),"
    "'noticeLinks',(select count(*) from private.cpsc_notice_identity_links),"
    "'firstPassClasses',(select json_object_agg(c,n) from (select result->>'decisionClass' c,count(*) n from sim_obs where pass=1 group by 1) x),"
    "'replayClasses',(select json_object_agg(c,n) from (select result->>'decisionClass' c,count(*) n from sim_obs where pass=2 group by 1) x),"
    "'reconciliations',(select count(*) from private.cpsc_identity_reconciliations),"
    "'quarantinedObservations',(select count(*) from private.cpsc_identity_observations where resolution='quarantined'),"
    "'checksPassed'," + str(len(checks)) + ");"
)
lines.append("rollback;")

status = json.loads(subprocess.run(["npx", "supabase", "status", "-o", "json"], capture_output=True,
                                   text=True, check=True, cwd=ROOT).stdout)
if urlsplit(status["DB_URL"]).hostname not in {"127.0.0.1", "localhost"}:
    raise SystemExit("Local stack only.")
result = subprocess.run(["psql", status["DB_URL"], "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
                        input="\n".join(lines) + "\n", capture_output=True, text=True)
if result.returncode != 0:
    raise SystemExit(result.stderr.strip().splitlines()[-1] if result.stderr else "simulation failed")
print(json.dumps(json.loads([line for line in result.stdout.splitlines() if line.startswith("{")][-1]), indent=2))
