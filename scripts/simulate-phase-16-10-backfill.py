#!/usr/bin/env python3
"""Run a rollback-only 30-row CPSC backfill against disposable local Supabase."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTICES = json.loads((ROOT / "tests/fixtures/phase-16-10-notices.json").read_text())
DATA = json.loads((ROOT / "docs/phase-16-9-prototype-dataset.json").read_text())
AUDIT = json.loads((ROOT / "docs/phase-16-9-identity-audit.json").read_text())
BY_NUMBER = {page["recallNumber"]: page for page in DATA["pages"]}
BY_EXTERNAL = {row["external_id"]: row for row in NOTICES}
DRIFT = {row["storedExternalId"]: row for row in AUDIT["driftCases"]}
DUPLICATE_CANONICAL = {
    row["officialRecallNumber"]: row["canonicalCandidateNoticeId"]
    for row in AUDIT["duplicateGroups"]
}


def q(value):
    if value is None:
        return "null"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return "'" + str(value).replace("'", "''") + "'"


lines = ["begin;", "select set_config('phase1610.source', public.ensure_cpsc_recall_source()::text, true);"]
for row in NOTICES:
    payload = {"RecallID": row["external_id"], "RecallNumber": row["recall_number"]}
    lines.append(
        "insert into public.recall_notices "
        "(id,source_id,external_id,title,recall_date,official_url,retrieved_at,raw_payload) "
        f"values ({q(row['id'])},current_setting('phase1610.source')::uuid,{q(row['external_id'])},"
        f"{q(row['title'])},{q(row['recall_date'])},{q(row['official_url'])},now(),"
        f"{q(payload)}::jsonb);"
    )
    for scope in row["scopes"]:
        lines.append(
            "insert into public.recall_scopes "
            "(id,recall_notice_id,product_name,gtin,model_number,additional_criteria) "
            f"values ({q(scope['id'])},{q(row['id'])},{q(scope['product_name'] or 'Fixture product')},"
            f"{q(scope['gtin'])},{q(scope['model_number'])},null);"
        )

for page in DATA["pages"]:
    number = page["recallNumber"]
    matches = [row for row in NOTICES if row["recall_number"] == number]
    canonical_notice = DUPLICATE_CANONICAL.get(number, matches[0]["id"])
    identity_id = f"(select id from private.cpsc_source_identities where official_recall_number={q(number)})"
    lines.append(
        "insert into private.cpsc_source_identities "
        "(source_id,official_recall_number,canonical_url,canonical_notice_id,identity_status) "
        f"values (current_setting('phase1610.source')::uuid,{q(number)},"
        f"{q(page['canonicalUrl'])},{q(canonical_notice)},'reconciled');"
    )
    evidence = {key: page[key] for key in ("recallNumber", "canonicalUrl", "title", "publicationDate", "description", "recallDetails", "tables")}
    lines.append(
        "insert into private.cpsc_page_revisions "
        "(identity_id,evidence_hash,recall_number,canonical_url,title,section_hashes,normalized_evidence,parser_version) "
        f"values ({identity_id},{q(page['normalizedEvidenceHash'])},{q(number)},"
        f"{q(page['canonicalUrl'])},{q(page['title'])},{q(page['sectionHashes'])}::jsonb,"
        f"{q(evidence)}::jsonb,'phase-16.9-v1');"
    )
    lines.append(
        "insert into private.cpsc_page_fetches "
        "(identity_id,revision_id,fetched_at,http_status,raw_page_hash,final_url,content_type) "
        f"values ({identity_id},"
        f"(select id from private.cpsc_page_revisions where identity_id={identity_id}),"
        f"{q(page['fetchTimestamp'])},200,{q(page['rawPageHash'])},"
        f"{q(page['canonicalUrl'])},'text/html');"
    )

for row in NOTICES:
    number = row["recall_number"]
    identity_id = f"(select id from private.cpsc_source_identities where official_recall_number={q(number)})"
    lines.append(
        "insert into private.cpsc_notice_identity_links (notice_id,identity_id,provenance) "
        f"values ({q(row['id'])},{identity_id},'Phase 16.8 frozen historical row');"
    )
    for kind, value in (("api_id", row["external_id"]), ("official_url", row["official_url"])):
        lines.append(
            "insert into private.cpsc_source_aliases "
            "(identity_id,notice_id,alias_kind,alias_value,provenance,first_seen_at,last_seen_at) "
            f"values ({identity_id},{q(row['id'])},{q(kind)},{q(value)},"
            "'Phase 16.8 stored',now(),now());"
        )
    old = next(item for item in DATA["noticeRows"] if item["storedExternalId"] == row["external_id"])
    lines.append(
        "insert into private.cpsc_api_revisions "
        "(identity_id,upstream_api_id,payload_hash,provenance,first_seen_at,last_seen_at) "
        f"values ({identity_id},{q(row['external_id'])},{q(old['storedPayloadHash'])},"
        "'Phase 16.8 stored',now(),now());"
    )

for row in DATA["noticeRows"]:
    page = BY_NUMBER[row["recallNumber"]]
    observed_url = DRIFT.get(row["storedExternalId"], {}).get("currentOfficialUrl", page["canonicalUrl"])
    lines.append(
        "select public.record_cpsc_identity_observation("
        f"{q(row['currentApiId'])},{q(row['recallNumber'])},{q(observed_url)},"
        f"{q(page['canonicalUrl'])},{q(page['title'])},{q(page['publicationDate'])},"
        f"{q(row['currentPayloadHash'])},now(),'Phase 16.8 captured API');"
    )

lines += [
    "do $$ begin",
    "if (select count(*) from public.recall_notices n join public.recall_sources s on s.id=n.source_id where s.source_key='cpsc') <> 30 then raise exception 'notice count changed'; end if;",
    "if (select count(*) from public.recall_scopes) <> 43 then raise exception 'historical scopes lost'; end if;",
    "if (select count(*) from private.cpsc_source_identities) <> 27 then raise exception 'canonical count wrong'; end if;",
    "if (select count(*) from private.cpsc_notice_identity_links) <> 30 then raise exception 'link count wrong'; end if;",
    "if (select count(*) from (select identity_id from private.cpsc_notice_identity_links group by identity_id having count(*)=2) pairs) <> 3 then raise exception 'duplicate links wrong'; end if;",
    "if (select count(*) from private.cpsc_identity_observations where resolution='quarantined') <> 6 then raise exception 'collision quarantine wrong'; end if;",
    "if (select count(*) from private.cpsc_identity_observations where resolution='resolved') <> 24 then raise exception 'resolved observations wrong'; end if;",
    "if (select count(*) from private.cpsc_page_revisions) <> 27 then raise exception 'semantic page count wrong'; end if;",
    "if (select count(*) from private.cpsc_page_fetches) <> 27 then raise exception 'transport page count wrong'; end if;",
    "if exists (select 1 from private.cpsc_identity_observations o join private.cpsc_source_identities i on i.id=o.identity_id where o.official_recall_number <> i.official_recall_number) then raise exception 'identity misassociation'; end if;",
    "end $$;",
    "select (select count(*) from public.recall_notices n join public.recall_sources s on s.id=n.source_id where s.source_key='cpsc') notices, (select count(*) from public.recall_scopes) scopes, (select count(*) from private.cpsc_source_identities) canonical_pages, (select count(*) from private.cpsc_notice_identity_links) historical_links, (select count(*) from private.cpsc_source_aliases) aliases, (select count(*) from private.cpsc_source_aliases where alias_kind='api_id') api_aliases, (select count(*) from private.cpsc_source_aliases where alias_kind='official_url') url_aliases, (select count(*) from private.cpsc_identity_observations where resolution='resolved') resolved_observations, (select count(*) from private.cpsc_identity_observations where resolution='quarantined') quarantined_collisions, (select count(*) from private.cpsc_page_revisions) semantic_revisions, (select count(*) from private.cpsc_page_fetches) transport_snapshots;",
    "rollback;",
]
sql_path = Path("/private/tmp/phase1610-backfill.sql")
sql_path.write_text("\n".join(lines) + "\n")
print(sql_path)
