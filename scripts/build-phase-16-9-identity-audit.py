#!/usr/bin/env python3
"""Materialize the read-only Phase 16.9 identity audit from captured source data."""

import json
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "docs/phase-16-8-source-manifest.json").read_text())["noticeRows"]
production = {r["external_id"]: r for r in json.loads(Path("/private/tmp/phase169-production-refs.json").read_text())}
stored = {r["external_id"]: r["raw_payload"] for r in map(json.loads, Path("/private/tmp/phase168-stored.jsonl").read_text().splitlines())}
current = {str(r["RecallNumber"]): r for filename in ["phase168-api-2026-09-10.json", "phase168-api-2026-09-17.json", "phase168-api-2020-08-12.json"] for r in json.loads((Path("/private/tmp") / filename).read_text())}


def canonical(url):
    p = urlsplit(url)
    if p.scheme != "https" or p.hostname not in {"cpsc.gov", "www.cpsc.gov"}:
        raise ValueError(url)
    return urlunsplit(("https", "www.cpsc.gov", p.path.rstrip("/"), "", ""))


drift = []
for item in manifest:
    old_id = item["storedExternalId"]
    new_id = str(item["liveApiRecallId"])
    if old_id == new_id:
        continue
    row = production[old_id]
    api = current[str(item["cpscRecallNumber"])]
    changed = sorted(k for k in set(stored[old_id]) | set(api) if stored[old_id].get(k) != api.get(k))
    same = (str(api["RecallNumber"]) == item["cpscRecallNumber"] and canonical(api["URL"]) == canonical(row["official_url"]) and api["RecallDate"][:10] == row["recall_date"] and api["Title"] == row["title"])
    drift.append({
        "internalNoticeId": row["id"], "storedExternalId": old_id,
        "currentApiId": new_id, "officialRecallNumber": item["cpscRecallNumber"],
        "currentOfficialUrl": api["URL"], "storedOfficialUrl": row["official_url"],
        "normalizedCanonicalUrl": canonical(api["URL"]),
        "storedPayloadHash": item["storedPayloadSha256"],
        "currentPayloadHash": item["liveApiPayloadSha256"],
        "publicationDate": row["recall_date"], "sameOfficialRecall": same,
        "primaryClassification": "duplicate ingestion" if old_id in {"10988", "10989", "10990"} else "API identifier drift",
        "secondaryClassifications": (["URL canonicalization difference"] if canonical(api["URL"]) == canonical(row["official_url"]) and api["URL"] != row["official_url"] else []) + (["source correction"] if any(k not in {"RecallID", "URL"} for k in changed) else []),
        "changedApiFields": changed,
    })

groups = []
for number in ["26776", "26773", "26777"]:
    rows = [production[x["storedExternalId"]] for x in manifest if x["cpscRecallNumber"] == number]
    assert len(rows) == 2
    rows.sort(key=lambda r: int(r["external_id"]))
    assert len({canonical(r["official_url"]) for r in rows}) == 1
    assert len({r["recall_date"] for r in rows}) == 1
    groups.append({"officialRecallNumber": number, "canonicalOfficialUrl": canonical(rows[0]["official_url"]),
                   "canonicalCandidateNoticeId": rows[0]["id"], "canonicalCandidateExternalId": rows[0]["external_id"],
                   "aliases": [{"noticeId": r["id"], "externalId": r["external_id"], "storedOfficialUrl": r["official_url"],
                                "title": r["title"], "publicationDate": r["recall_date"],
                                "scopes": r["scopes"], "matchReferences": r["match_count"], "alertReferences": r["alert_count"]} for r in rows],
                   "sameAuthoritativeRecall": len({r["title"] for r in rows}) == 1,
                   "logicalDeduplicationSafe": True, "physicalMergeSafeNow": False,
                   "historyMustRemainAddressable": True})

result = {"driftCases": drift, "duplicateGroups": groups,
          "apiIdCollisionWarning": "Current API IDs 10965-10970 are already stored as IDs for different CPSC recalls; alias values are not globally unique."}
path = ROOT / "docs/phase-16-9-identity-audit.json"
if not path.exists() or json.loads(path.read_text()) != result:
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
print(f"{len(drift)} drift cases; {len(groups)} duplicate groups")
