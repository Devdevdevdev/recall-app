#!/usr/bin/env python3
"""Build the Phase 16.12 CPSC historical backfill manifest from frozen audit artifacts.

The manifest carries public CPSC evidence only: the 27 authoritative page captures
(Phase 16.8/16.9) and the current API observations captured by the Phase 16.8
audit. Stored notices are not in the manifest; the backfill reads them from the
database it runs in. No owned-product or user data is read or written.
"""

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = json.loads((ROOT / "docs/phase-16-9-prototype-dataset.json").read_text())
AUDIT = json.loads((ROOT / "docs/phase-16-9-identity-audit.json").read_text())
SOURCE = json.loads((ROOT / "docs/phase-16-8-source-manifest.json").read_text())
OUT = ROOT / "docs/phase-16-12-backfill-manifest.json"

pages_by_number = {page["recallNumber"]: page for page in DATA["pages"]}
drift = {row["storedExternalId"]: row for row in AUDIT["driftCases"]}
stored_url = {row["storedExternalId"]: row["storedUrl"] for row in DATA["noticeRows"]}
observed_at = f"{SOURCE['auditDateUtc']}T00:00:00Z"

pages = []
for page in sorted(DATA["pages"], key=lambda item: item["recallNumber"]):
    assert page["httpStatus"] == 200
    pages.append({
        "recallNumber": page["recallNumber"],
        "canonicalUrl": page["canonicalUrl"],
        "evidenceHash": page["normalizedEvidenceHash"],
        "rawPageHash": page["rawPageHash"],
        "parserVersion": "phase-16.9-v1",
        "fetchedAt": page["fetchTimestamp"],
        "fetchedAtProvenance": page["fetchTimestampProvenance"],
        "sectionHashes": page["sectionHashes"],
        "normalizedEvidence": {key: page[key] for key in (
            "recallNumber", "canonicalUrl", "title", "publicationDate", "description",
            "recallDetails", "tables")},
    })

# Both rows of a duplicate ingestion describe the same live API record, so the
# current observations are keyed by (current API ID, recall number).
current = {}
for row in DATA["noticeRows"]:
    key = (row["currentApiId"], row["recallNumber"])
    url = (drift.get(row["storedExternalId"], {}).get("currentOfficialUrl")
           or (stored_url.get(row["currentApiId"]) if row["currentApiId"] == row["storedExternalId"] else None)
           or pages_by_number[row["recallNumber"]]["canonicalUrl"])
    candidate = {
        "apiId": row["currentApiId"],
        "recallNumber": row["recallNumber"],
        "observedUrl": url,
        "title": pages_by_number[row["recallNumber"]]["title"],
        "publicationDate": pages_by_number[row["recallNumber"]]["publicationDate"],
        "payloadHash": row["currentPayloadHash"],
        "observedAt": observed_at,
    }
    previous = current.setdefault(key, candidate)
    assert previous["payloadHash"] == candidate["payloadHash"], key
    if row["storedExternalId"] in drift:
        previous["observedUrl"] = candidate["observedUrl"]

drift_rows = sum(1 for row in DATA["noticeRows"] if row["currentApiId"] != row["storedExternalId"])
collisions = sum(
    1 for (api_id, number) in current
    if any(other["storedExternalId"] == api_id and other["recallNumber"] != number
           for other in DATA["noticeRows"])
)
manifest = {
    "manifestVersion": "phase-16.12-cpsc-backfill-v1",
    "source": "Phase 16.8 captured CPSC pages and current API observations (public data only)",
    "expected": {
        "storedNotices": len(DATA["noticeRows"]),
        "canonicalIdentities": len(pages),
        "canonicalPages": len(pages),
        "duplicateGroups": len(AUDIT["duplicateGroups"]),
        "currentObservations": len(current),
        "driftRows": drift_rows,
        "collisions": collisions,
    },
    "pages": pages,
    "currentObservations": sorted(current.values(), key=lambda item: (item["recallNumber"], item["apiId"])),
}
assert manifest["expected"] == {
    "storedNotices": 30, "canonicalIdentities": 27, "canonicalPages": 27, "duplicateGroups": 3,
    "currentObservations": 27, "driftRows": 12, "collisions": 6,
}, manifest["expected"]
OUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
subprocess.run(["npx", "prettier", "--write", str(OUT)], cwd=ROOT, check=True, capture_output=True)
print(json.dumps({"written": str(OUT.relative_to(ROOT)), **manifest["expected"]}, indent=2))
